#!/usr/bin/env node
/**
 * Spike de Fase 0: valida contra la API real qué modelos responden en el plan Free
 * y con qué formato. No requiere que el servidor MCP compile.
 *
 * Uso:
 *   node --env-file=.env scripts/spike.mjs
 *   node --env-file=.env scripts/spike.mjs --image C:\ruta\foto.jpg --prompt "cambia el fondo a una playa"
 *   node --env-file=.env scripts/spike.mjs --multipart-field image
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { solidPng } from "./png.mjs";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const OUT_DIR = process.env.IMAGE_OUT_DIR?.trim() || join(homedir(), "Downloads");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const PROMPT = arg("prompt", "same subject, warm sunset lighting, slight color variation, photorealistic");
const IMAGE_PATH = arg("image", null);
const MULTIPART_FIELD = arg("multipart-field", process.env.IMAGE_FORGE_MULTIPART_IMAGE_FIELD || "input_image");
const FIELD_VARIANTS = [...new Set([MULTIPART_FIELD, "input_image", "image", "input_image_0"])];

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("⛔ Faltan CLOUDFLARE_ACCOUNT_ID y/o CLOUDFLARE_API_TOKEN.");
  console.error("   1. dash.cloudflare.com -> My Profile -> API Tokens -> Create Token");
  console.error("   2. Permiso: Account -> Workers AI -> Read");
  console.error("   3. Account ID: barra lateral de Workers & Pages");
  console.error("   4. Copia .env.example a .env y rellena ambos valores");
  process.exit(1);
}

async function loadInput() {
  if (IMAGE_PATH) {
    const buffer = await readFile(resolve(IMAGE_PATH));
    console.log(`🖼  entrada: ${IMAGE_PATH} (${Math.round(buffer.length / 1024)} KB)`);
    return { buffer, mime: "image/png" };
  }
  console.log("🖼  entrada: PNG sintético 512x512 (sin --image)");
  return { buffer: solidPng(512, 512), mime: "image/png" };
}

async function post(model, { json, form }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}`;
  const headers = { Authorization: `Bearer ${API_TOKEN}` };
  if (json) headers["Content-Type"] = "application/json";

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(120000),
  });
  const elapsed = Math.round(performance.now() - started);
  const contentType = response.headers.get("content-type") || "";
  const payload = Buffer.from(await response.arrayBuffer());

  return { response, elapsed, contentType, payload };
}

function report(label, result) {
  const { response, elapsed, contentType, payload } = result;
  console.log(`\n── ${label}`);
  console.log(`   HTTP ${response.status} · ${contentType || "sin content-type"} · ${Math.round(payload.length / 1024)} KB · ${elapsed} ms`);

  if (!response.ok) {
    console.log(`   ⛔ ${payload.toString("utf8").slice(0, 400)}`);
    return null;
  }
  if (contentType.startsWith("image/")) {
    console.log("   ✅ binario de imagen");
    return payload;
  }

  const text = payload.toString("utf8");
  try {
    const json = JSON.parse(text);
    const base64 = json?.result?.image ?? json?.result ?? json?.image;
    if (typeof base64 === "string" && base64.length > 100) {
      console.log(`   ✅ base64 (${Math.round(base64.length / 1024)} KB aprox.)`);
      return Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    }
    console.log(`   ⚠️  JSON sin imagen: ${text.slice(0, 300)}`);
    return null;
  } catch {
    console.log(`   ⚠️  respuesta no JSON: ${text.slice(0, 300)}`);
    return null;
  }
}

async function save(name, buffer) {
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `spike-${name}-${Date.now()}.png`);
  await writeFile(path, buffer);
  console.log(`   💾 ${path}`);
}

async function testSd15(input) {
  const result = await post("@cf/runwayml/stable-diffusion-v1-5-img2img", {
    json: {
      prompt: PROMPT,
      image_b64: input.buffer.toString("base64"),
      strength: 0.45,
      num_steps: 20,
      guidance: 7.5,
      width: 512,
      height: 512,
    },
  });
  const image = report("sd15-img2img (JSON, strength 0.45)", result);
  if (image) await save("sd15", image);
  return Boolean(image);
}

async function testKlein(input) {
  for (const field of FIELD_VARIANTS) {
    const form = new FormData();
    form.append("prompt", PROMPT);
    form.append(field, new Blob([new Uint8Array(input.buffer)], { type: input.mime }), "input.png");
    form.append("width", "1024");
    form.append("height", "1024");
    form.append("steps", "4");

    let result;
    try {
      result = await post("@cf/black-forest-labs/flux-2-klein-4b", { form });
    } catch (error) {
      console.log(`\n── flux-2-klein-4b con campo "${field}" → error de red: ${error.message}`);
      continue;
    }

    const image = report(`flux-2-klein-4b (multipart, campo "${field}")`, result);
    if (image) {
      console.log(`   ➜ nombre de campo confirmado: ${field}`);
      await save("klein", image);
      return true;
    }
    if (result.response.status !== 400) return false;
  }
  return false;
}

async function testKleinTextOnly() {
  const form = new FormData();
  form.append("prompt", PROMPT);
  form.append("width", "1024");
  form.append("height", "1024");
  form.append("steps", "4");
  const result = await post("@cf/black-forest-labs/flux-2-klein-4b", { form });
  const image = report("flux-2-klein-4b (solo texto, sin imagen)", result);
  if (image) await save("klein-t2i", image);
  return Boolean(image);
}

const input = await loadInput();
console.log(`\nPrompt: ${PROMPT}`);
console.log(`Salida: ${OUT_DIR}`);

const results = {
  sd15: await testSd15(input).catch((error) => (console.log(`   ⛔ ${error.message}`), false)),
  klein: await testKlein(input).catch((error) => (console.log(`   ⛔ ${error.message}`), false)),
  kleinText: await testKleinTextOnly().catch((error) => (console.log(`   ⛔ ${error.message}`), false)),
};

console.log("\n═══ Resumen");
console.log(`   sd15-img2img        ${results.sd15 ? "✅ disponible" : "❌ no disponible"}`);
console.log(`   flux-2-klein-4b     ${results.klein ? "✅ disponible (con imagen)" : "❌ no disponible"}`);
console.log(`   flux-2-klein-4b t2i ${results.kleinText ? "✅ disponible (texto→imagen)" : "❌ no disponible"}`);
console.log("\nSi sd15 funciona y klein no, usa IMAGE_FORGE_DEFAULT_MODEL=sd15-img2img en .env");
