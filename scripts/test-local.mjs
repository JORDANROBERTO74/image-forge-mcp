#!/usr/bin/env node
/** Verificación local sin credenciales: image-io + historial. Requiere `pnpm build` antes. */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { solidPng } from "./png.mjs";
import { inspectImageFile, loadImage, saveImage, sniffImage } from "../build/lib/image-io.js";
import { appendHistory, neuronsUsedToday } from "../build/lib/history.js";

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const workspace = await mkdtemp(join(tmpdir(), "image-forge-test-"));

try {
  const png = solidPng(64, 48);
  const inputPath = join(workspace, "entrada con espacios.png");
  await writeFile(inputPath, png);

  const sniffed = sniffImage(png);
  check("sniffImage detecta PNG y dimensiones", sniffed?.width === 64 && sniffed?.height === 48, JSON.stringify(sniffed));

  const loaded = await loadImage(inputPath, 10 * 1024 * 1024);
  check("loadImage lee ruta con espacios y acentos", loaded.width === 64 && loaded.mime === "image/png");

  const loadedUrl = await loadImage(pathToFileURL(inputPath).href, 10 * 1024 * 1024);
  check("loadImage acepta file://", loadedUrl.width === 64);

  const saved = await saveImage(png, join(workspace, "salida"), { seed: 12345 });
  const savedStat = await stat(saved.path).catch(() => null);
  check("saveImage escribe en disco", Boolean(savedStat?.isFile()));
  check("saveImage nombra con seed y extensión", /image-forge-\d{8}-\d{6}-12345\.png$/.test(saved.path), saved.path);

  const duplicate = await saveImage(png, join(workspace, "salida"), { seed: 12345 });
  check("saveImage no sobrescribe (sufijo -2)", duplicate.path !== saved.path, duplicate.path);

  const info = await inspectImageFile(saved.path);
  check("inspectImageFile devuelve metadatos", info.width === 64 && info.bytes > 0);

  const textPath = join(workspace, "no-es-imagen.txt");
  await writeFile(textPath, "hola");
  let rejected = false;
  try {
    await loadImage(textPath, 10 * 1024 * 1024);
  } catch (error) {
    rejected = error.code === "INPUT";
  }
  check("loadImage rechaza archivos que no son imagen", rejected);

  let missingRejected = false;
  try {
    await loadImage(join(workspace, "no-existe.png"), 10 * 1024 * 1024);
  } catch (error) {
    missingRejected = error.code === "INPUT";
  }
  check("loadImage da error claro si no existe", missingRejected);

  const historyPath = join(workspace, "history.jsonl");
  const today = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  await appendHistory(
    { ts: today, tool: "generate_image", model: "test", prompt: "a", images: [], neurons: 126, ms: 1, ok: true },
    historyPath,
  );
  await appendHistory(
    { ts: yesterday, tool: "generate_image", model: "test", prompt: "b", images: [], neurons: 900, ms: 1, ok: true },
    historyPath,
  );
  const used = await neuronsUsedToday(historyPath);
  check("neuronsUsedToday solo cuenta el día UTC actual", used === 126, `usado=${used}`);

  check("neuronsUsedToday tolera historial inexistente", (await neuronsUsedToday(join(workspace, "nada.jsonl"))) === 0);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ Todo en verde" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
