#!/usr/bin/env node
/** Prueba el servidor MCP por stdio (sin credenciales): tools/list, get_image_info y error de config. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { solidPng } from "./png.mjs";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function firstText(result) {
  const item = result?.content?.find((entry) => entry.type === "text");
  return item?.text ?? "";
}

const workspace = await mkdtemp(join(tmpdir(), "image-forge-mcp-"));
const imagePath = join(workspace, "image.png");
await writeFile(imagePath, solidPng(32, 16));

// Entorno sin credenciales: asegura que el fallo sea de configuración, no de red.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => typeof value === "string" && !key.startsWith("CLOUDFLARE_") && key !== "IMAGE_OUT_DIR",
  ),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  cwd: process.cwd(),
  env,
  stderr: "pipe",
});

const client = new Client({ name: "image-forge-test", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check(
    "tools/list expone las 3 herramientas",
    JSON.stringify(names) === JSON.stringify(["edit_image", "generate_image", "get_image_info"]),
    names.join(","),
  );
  check(
    "las tools tienen descripción",
    tools.every((tool) => Boolean(tool.description)),
  );

  const info = await client.callTool({ name: "get_image_info", arguments: { path: imagePath } });
  const infoText = firstText(info);
  const parsed = JSON.parse(infoText);
  check("get_image_info funciona sin credenciales", parsed.width === 32 && parsed.height === 16, infoText);

  const generate = await client.callTool({ name: "generate_image", arguments: { prompt: "una isla" } });
  const errorText = firstText(generate);
  check("generate_image falla con error de configuración claro", generate.isError === true && errorText.includes("CONFIG"), errorText);

  const edit = await client.callTool({ name: "edit_image", arguments: { prompt: "algo" } });
  check("edit_image exige parámetro image", edit.isError === true, firstText(edit));
} finally {
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ MCP en verde" : `\n❌ ${failures} prueba(s) fallaron`);
process.exit(failures === 0 ? 0 : 1);
