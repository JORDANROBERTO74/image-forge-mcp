#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { CloudflareProvider, DEFAULT_MODEL, MODELS, type ModelId } from "./providers/cloudflare.js";
import { inspectImageFile, loadImage, saveImage } from "./lib/image-io.js";
import { appendHistory, neuronsUsedToday } from "./lib/history.js";
import { formatToolError, ImageForgeError } from "./lib/errors.js";

const server = new McpServer({
  name: "image-forge",
  version: "1.0.0",
});

const modelSchema = z
  .enum(["flux-2-klein-4b", "sd15-img2img"])
  .optional()
  .describe(
    "flux-2-klein-4b (por defecto): edición por prompt, ~126 neurons/imagen 1024px. sd15-img2img: alternativa con 'strength', pero requiere que tu cuenta tenga acceso habilitado.",
  );

const promptSchema = z
  .string()
  .min(1)
  .max(4000)
  .describe("Qué debe mostrar la imagen o qué debe cambiar respecto a la de entrada");

const negativeSchema = z
  .string()
  .max(2000)
  .optional()
  .describe("Elementos que NO deben aparecer (solo sd15-img2img)");

const strengthSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("0 = casi idéntica al original, 1 = ignora el original. Solo sd15-img2img; se ignora en flux-2-klein-4b");

const sizeField = (label: string) =>
  z.number().int().min(256).max(2048).optional().describe(label);

const stepsSchema = z.number().int().min(1).max(20).optional().describe("Pasos de difusión (1-20)");

const seedSchema = z
  .number()
  .int()
  .min(0)
  .max(4294967295)
  .optional()
  .describe("Semilla para reproducir el resultado");

const countSchema = z.number().int().min(1).max(4).optional().describe("Cuántas variantes generar (1-4)");

const outDirSchema = z
  .string()
  .optional()
  .describe("Carpeta destino. Por defecto IMAGE_OUT_DIR o %USERPROFILE%\\Downloads");

interface RunArguments {
  prompt: string;
  image?: string;
  model?: "flux-2-klein-4b" | "sd15-img2img";
  strength?: number;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  count?: number;
  out_dir?: string;
}

const serverStart = Date.now();

async function run(tool: "edit_image" | "generate_image", args: RunArguments) {
  const startedAt = Date.now();
  const config = loadConfig();
  const provider = new CloudflareProvider(config);

  const model = (args.model ?? DEFAULT_MODEL) as ModelId;
  if (!(model in MODELS)) {
    throw new ImageForgeError("INPUT", `Modelo desconocido: ${model}`, {
      hint: `Disponibles: ${Object.keys(MODELS).join(", ")}`,
    });
  }

  const definition = MODELS[model];
  const caps = definition.caps;
  const count = args.count ?? 1;

  if (count > config.maxImagesPerCall) {
    throw new ImageForgeError(
      "INPUT",
      `count=${count} excede el máximo configurado (${config.maxImagesPerCall})`,
      { hint: "Ajusta IMAGE_FORGE_MAX_IMAGES_PER_CALL si necesitas más." },
    );
  }

  const width = args.width ?? args.height ?? caps.defaultSize;
  const height = args.height ?? args.width ?? caps.defaultSize;
  if (width > caps.maxSize || height > caps.maxSize) {
    throw new ImageForgeError("INPUT", `${width}x${height} excede el máximo de ${model} (${caps.maxSize}px)`);
  }

  const steps = Math.min(args.steps ?? definition.defaultSteps, 20);
  const notes: string[] = [];

  if (args.strength !== undefined && !caps.strength) {
    notes.push(`strength=${args.strength} ignorado: ${model} edita por prompt, no por difusión`);
  }
  if (args.negative_prompt && !caps.negativePrompt) {
    notes.push("negative_prompt ignorado por este modelo");
  }
  if (args.seed !== undefined && !caps.seed) {
    notes.push("seed ignorado por este modelo");
  }

  const loaded = args.image ? await loadImage(args.image, config.maxInputBytes) : undefined;
  if (tool === "edit_image" && !loaded) {
    throw new ImageForgeError("INPUT", "edit_image necesita el parámetro 'image'", {
      hint: "Para texto→imagen usa generate_image.",
    });
  }

  const perImage = provider.estimateNeurons(model, width, height, Boolean(loaded), steps);
  const estimate = perImage * count;
  const usedToday = await neuronsUsedToday(config.historyPath);

  if (usedToday + estimate > config.hardNeurons) {
    throw new ImageForgeError(
      "QUOTA",
      `La generación consumiría ~${Math.round(estimate)} neurons y hoy ya usaste ${Math.round(usedToday)} de 10.000`,
      {
        hint: "Baja count, usa model=sd15-img2img (0 neurons) o espera el reset de las 00:00 UTC.",
      },
    );
  }
  if (usedToday + estimate > config.warnNeurons) {
    notes.push(`cuota diaria en ${Math.round(usedToday + estimate)}/10.000 neurons`);
  }

  const saved: Array<{ path: string; width: number; height: number; bytes: number; seed?: number }> = [];

  for (let index = 0; index < count; index += 1) {
    const seed = args.seed !== undefined ? args.seed + index : undefined;
    const shared = {
      prompt: args.prompt,
      negativePrompt: args.negative_prompt,
      strength: args.strength,
      width,
      height,
      steps,
      seed,
    };

    const result = loaded
      ? await provider.edit(model, { ...shared, image: loaded.buffer, imageMime: loaded.mime })
      : await provider.generate(model, shared);

    const file = await saveImage(result.buffer, args.out_dir ?? config.outDir, {
      seed: result.seed ?? seed,
      prefix: "image-forge",
    });
    const finalSeed = result.seed ?? seed;

    saved.push({ path: file.path, width: file.width, height: file.height, bytes: file.bytes, seed: finalSeed });

    await appendHistory(
      {
        ts: new Date().toISOString(),
        tool,
        model,
        prompt: args.prompt,
        seed: finalSeed,
        images: [file.path],
        neurons: perImage,
        ms: Date.now() - startedAt,
        ok: true,
      },
      config.historyPath,
    );
  }

  const totalNeurons = perImage * saved.length;
  const lines = [
    `✅ ${saved.length} imagen(es) · ${model} · ${width}x${height}`,
    ...saved.map(
      (image, index) =>
        `${index + 1}. ${image.path} (${image.width}x${image.height}, ${Math.round(image.bytes / 1024)} KB, seed ${image.seed ?? "n/a"})`,
    ),
    `costo: ~${Math.round(totalNeurons)} neurons (hoy: ${Math.round(usedToday + totalNeurons)} de ~10.000)`,
  ];
  if (notes.length > 0) lines.push(`notas: ${notes.join(" · ")}`);

  return {
    content: [
      {
        type: "text" as const,
        text: `${lines.join("\n")}\n\n${JSON.stringify(
          {
            images: saved,
            meta: {
              provider: "cloudflare",
              model,
              width,
              height,
              steps,
              estimatedNeurons: totalNeurons,
              elapsedMs: Date.now() - startedAt,
              notes,
            },
          },
          null,
          2,
        )}`,
      },
    ],
  };
}

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: formatToolError(error) }],
    isError: true,
  };
}

server.tool(
  "edit_image",
  "Genera una nueva imagen a partir de otra imagen + un prompt. Guarda el resultado en disco y devuelve la ruta.",
  {
    image: z
      .string()
      .min(1)
      .describe("Ruta local, file:// o URL http(s) de la imagen de entrada"),
    prompt: promptSchema,
    model: modelSchema,
    strength: strengthSchema,
    negative_prompt: negativeSchema,
    width: sizeField("Ancho de salida en px (256-2048)"),
    height: sizeField("Alto de salida en px (256-2048)"),
    steps: stepsSchema,
    seed: seedSchema,
    count: countSchema,
    out_dir: outDirSchema,
  },
  async (args) => {
    try {
      return await run("edit_image", args);
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "generate_image",
  "Genera una imagen desde texto. Guarda el resultado en disco y devuelve la ruta.",
  {
    prompt: promptSchema,
    model: modelSchema,
    negative_prompt: negativeSchema,
    width: sizeField("Ancho de salida en px (256-2048)"),
    height: sizeField("Alto de salida en px (256-2048)"),
    steps: stepsSchema,
    seed: seedSchema,
    count: countSchema,
    out_dir: outDirSchema,
  },
  async (args) => {
    try {
      return await run("generate_image", args);
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  "get_image_info",
  "Lee dimensiones, formato y tamaño de un archivo de imagen local. No consume API ni cuota.",
  {
    path: z.string().min(1).describe("Ruta local o file:// de la imagen"),
  },
  async ({ path }) => {
    try {
      const info = await inspectImageFile(path);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                path: info.path,
                format: info.ext,
                mime: info.mime,
                width: info.width,
                height: info.height,
                bytes: info.bytes,
                kb: Math.round(info.bytes / 1024),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `image-forge MCP listo (stdio). Modelo por defecto: ${DEFAULT_MODEL}. Arranque: ${Date.now() - serverStart}ms`,
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
