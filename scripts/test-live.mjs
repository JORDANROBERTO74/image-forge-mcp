#!/usr/bin/env node
/**
 * Prueba end-to-end contra la API real. Consume ~126 neurons (~1 imagen del plan gratuito).
 * Requiere credenciales válidas en .env.
 *
 *   pnpm test:live
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { solidPng } from "./png.mjs";

if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  console.error("⛔ Faltan CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN. Ejecuta con: pnpm test:live (usa --env-file).");
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function parsePayload(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

const workspace = await mkdtemp(join(tmpdir(), "image-forge-live-"));
const inputPath = join(workspace, "entrada.png");
const outDir = join(workspace, "salida");
await writeFile(inputPath, solidPng(512, 512, [90, 120, 200]));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file=.env", "build/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, IMAGE_OUT_DIR: outDir },
  stderr: "pipe",
});

const client = new Client({ name: "image-forge-live", version: "1.0.0" });

try {
  await client.connect(transport);

  console.log("→ edit_image (flux-2-klein-4b, 1024x1024)…");
  const edit = await client.callTool({
    name: "edit_image",
    arguments: {
      image: inputPath,
      prompt: "a red apple on a wooden table, soft studio lighting, photorealistic",
      width: 1024,
      height: 1024,
    },
  });

  const editText = edit.content?.find((entry) => entry.type === "text")?.text ?? "";
  const payload = parsePayload(editText);

  check("edit_image no devolvió error", edit.isError !== true, editText.slice(0, 300));
  check("la respuesta trae JSON parseable", Boolean(payload), editText.slice(0, 300));

  const image = payload?.images?.[0];
  check("devolvió una ruta de archivo", typeof image?.path === "string", JSON.stringify(image ?? null));

  if (image?.path) {
    const info = await stat(image.path).catch(() => null);
    check("el archivo existe en disco", Boolean(info?.isFile()));
    check("el PNG no está vacío", (info?.size ?? 0) > 10_000, `${info?.size ?? 0} bytes`);
    check("reporta dimensiones reales", image.width === 1024 && image.height === 1024, `${image.width}x${image.height}`);
    console.log(`     ${image.path} (${Math.round((info?.size ?? 0) / 1024)} KB)`);

    const infoResult = await client.callTool({ name: "get_image_info", arguments: { path: image.path } });
    const infoText = infoResult.content?.find((entry) => entry.type === "text")?.text ?? "";
    const parsed = parsePayload(infoText);
    check("get_image_info lee el resultado", parsed?.width === 1024, infoText.slice(0, 200));
  }

  check("reporta consumo de neurons", typeof payload?.meta?.estimatedNeurons === "number" && payload.meta.estimatedNeurons > 0, JSON.stringify(payload?.meta ?? null));
  console.log(`     neurons estimados: ${payload?.meta?.estimatedNeurons ?? "?"} · ${payload?.meta?.elapsedMs ?? "?"} ms`);
} finally {
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ End-to-end en verde" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
