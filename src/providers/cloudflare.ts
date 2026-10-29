import { requireCredentials, type AppConfig } from "../config.js";
import { ImageForgeError, mapHttpError, redact } from "../lib/errors.js";
import type { ImageGenRequest, ImageToImageRequest, ProviderResult } from "./types.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

export interface ModelCapabilities {
  image: boolean;
  strength: boolean;
  negativePrompt: boolean;
  seed: boolean;
  steps: boolean;
  defaultSize: number;
  maxSize: number;
}

export type ModelKind = "json-img2img" | "multipart-edit";

export interface ModelDef {
  readonly id: string;
  readonly label: string;
  readonly kind: ModelKind;
  readonly defaultSteps: number;
  readonly caps: ModelCapabilities;
  readonly note: string;
  estimate(width: number, height: number, hasImage: boolean, steps: number): number;
}

function tiles(width: number, height: number): number {
  return Math.ceil(width / 512) * Math.ceil(height / 512);
}

export const MODELS = {
  "flux-2-klein-4b": {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 [klein] 4B",
    kind: "multipart-edit",
    // El esquema de entrada de este modelo es multipart opaco en la documentación:
    // el spike confirma los nombres de campo reales.
    defaultSteps: 4,
    caps: {
      image: true,
      strength: false,
      negativePrompt: false,
      seed: true,
      steps: true,
      defaultSize: 1024,
      maxSize: 2048,
    },
    note: "~126 neurons por imagen 1024x1024 (~79 imágenes/día gratis). Edición por prompt.",
    estimate: (width: number, height: number, hasImage: boolean) => {
      const outTiles = tiles(width, height);
      const inTiles = hasImage ? outTiles : 0;
      return 5.37 * inTiles + 26.05 * outTiles;
    },
  },
  "sd15-img2img": {
    id: "@cf/runwayml/stable-diffusion-v1-5-img2img",
    label: "Stable Diffusion 1.5 img2img",
    kind: "json-img2img",
    defaultSteps: 20,
    caps: {
      image: true,
      strength: true,
      negativePrompt: true,
      seed: true,
      steps: true,
      defaultSize: 512,
      maxSize: 2048,
    },
    note: "$0.00 por step según Cloudflare. Fallback garantizado con control de 'strength'.",
    estimate: () => 0,
  },
} as const satisfies Record<string, ModelDef>;

export type ModelId = keyof typeof MODELS;

function resolveDefaultModel(): ModelId {
  const raw = process.env.IMAGE_FORGE_DEFAULT_MODEL?.trim();
  if (raw && raw in MODELS) return raw as ModelId;
  return "flux-2-klein-4b";
}

export const DEFAULT_MODEL: ModelId = resolveDefaultModel();

/** Acceso tipado: evita que TypeScript use la firma concreta de cada modelo del registro. */
export function modelDefinition(model: ModelId): ModelDef {
  return MODELS[model];
}

function extensionForMime(mime: string): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

function extractBase64(result: unknown): string | undefined {
  if (typeof result === "string" && result.length > 100) return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["image", "image_b64", "b64_json", "data"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 100) return value;
    }
  }
  return undefined;
}

export class CloudflareProvider {
  constructor(private readonly config: AppConfig) {}

  capabilities(model: ModelId): ModelCapabilities {
    return modelDefinition(model).caps;
  }

  estimateNeurons(model: ModelId, width: number, height: number, hasImage: boolean, steps: number): number {
    return Math.round(modelDefinition(model).estimate(width, height, hasImage, steps) * 10) / 10;
  }

  async edit(model: ModelId, request: ImageToImageRequest): Promise<ProviderResult> {
    const definition = modelDefinition(model);
    return definition.kind === "json-img2img"
      ? this.jsonImg2img(definition, request)
      : this.multipart(definition, request);
  }

  async generate(model: ModelId, request: ImageGenRequest): Promise<ProviderResult> {
    const definition = modelDefinition(model);
    if (definition.kind === "json-img2img") {
      throw new ImageForgeError("INPUT", `${model} necesita una imagen de entrada`, {
        hint: "Para texto→imagen usa model=flux-2-klein-4b.",
      });
    }
    return this.multipart(definition, request);
  }

  private async jsonImg2img(
    definition: ModelDef,
    request: ImageToImageRequest,
  ): Promise<ProviderResult> {
    const body = {
      prompt: request.prompt,
      image_b64: request.image.toString("base64"),
      negative_prompt: request.negativePrompt,
      strength: request.strength ?? 0.55,
      num_steps: request.steps,
      guidance: 7.5,
      width: request.width,
      height: request.height,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };

    const { buffer, mime } = await this.request(definition, JSON.stringify(body), true);
    return {
      buffer,
      mime,
      model: definition.id,
      seed: request.seed,
      estimatedNeurons: definition.estimate(request.width, request.height, true, request.steps),
      notes: [],
    };
  }

  private async multipart(
    definition: ModelDef,
    request: ImageGenRequest | ImageToImageRequest,
  ): Promise<ProviderResult> {
    const form = new FormData();
    form.append("prompt", request.prompt);

    let hasImage = false;
    if ("image" in request) {
      const field = process.env.IMAGE_FORGE_MULTIPART_IMAGE_FIELD?.trim() || "input_image";
      form.append(
        field,
        new Blob([new Uint8Array(request.image)], { type: request.imageMime }),
        `input.${extensionForMime(request.imageMime)}`,
      );
      hasImage = true;
    }

    form.append("width", String(request.width));
    form.append("height", String(request.height));
    form.append("steps", String(request.steps));
    if (request.seed !== undefined) form.append("seed", String(request.seed));

    const { buffer, mime } = await this.request(definition, form, false);
    return {
      buffer,
      mime,
      model: definition.id,
      seed: request.seed,
      estimatedNeurons: definition.estimate(request.width, request.height, hasImage, request.steps),
      notes: [],
    };
  }

  private async request(
    definition: ModelDef,
    body: BodyInit,
    isJson: boolean,
  ): Promise<{ buffer: Buffer; mime: string }> {
    const { accountId, apiToken } = requireCredentials(this.config);
    const url = `${API_BASE}/${accountId}/ai/run/${definition.id}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}` };
    if (isJson) headers["Content-Type"] = "application/json";

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        return await this.parseResponse(response, definition);
      } catch (error) {
        lastError = error;
        const mapped = this.asNetworkError(error, definition);
        if (!mapped.retryable || attempt === 2) throw mapped;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    throw this.asNetworkError(lastError, definition);
  }

  private async parseResponse(
    response: Response,
    definition: ModelDef,
  ): Promise<{ buffer: Buffer; mime: string }> {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw mapHttpError(response.status, body, definition.id);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    // Los modelos de difusión clásicos devuelven bytes de imagen directamente.
    if (contentType.startsWith("image/")) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mime: contentType.split(";")[0],
      };
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ImageForgeError("SCHEMA", `Respuesta no reconocida (${contentType || "sin content-type"})`, {
        hint: redact(text).slice(0, 200),
      });
    }

    const envelope = payload as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: unknown;
    };

    if (envelope.success === false) {
      const message =
        envelope.errors
          ?.map((entry) => entry.message)
          .filter(Boolean)
          .join("; ") || "Cloudflare devolvió success=false";
      throw new ImageForgeError("UPSTREAM", message, { hint: definition.id });
    }

    const base64 = extractBase64(envelope.result);
    if (!base64) {
      throw new ImageForgeError("SCHEMA", "La respuesta no contiene una imagen", {
        hint: redact(JSON.stringify(envelope)).slice(0, 300),
      });
    }

    return {
      buffer: Buffer.from(base64.replace(/^data:image\/[a-z0-9.+]+;base64,/i, ""), "base64"),
      mime: "image/png",
    };
  }

  private asNetworkError(error: unknown, definition: ModelDef): ImageForgeError {
    if (error instanceof ImageForgeError) return error;

    const candidate = error as Error & { name?: string };
    if (candidate?.name === "TimeoutError" || candidate?.name === "AbortError") {
      return new ImageForgeError(
        "UPSTREAM",
        `La generación excedió ${Math.round(this.config.timeoutMs / 1000)}s`,
        { retryable: true, hint: definition.label },
      );
    }

    return new ImageForgeError(
      "UPSTREAM",
      `Fallo de red al llamar a Cloudflare: ${candidate?.message ?? String(error)}`,
      { retryable: true },
    );
  }
}
