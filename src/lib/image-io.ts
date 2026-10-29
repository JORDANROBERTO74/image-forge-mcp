import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImageForgeError } from "./errors.js";

export interface ImageInfo {
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export interface LoadedImage extends ImageInfo {
  buffer: Buffer;
  origin: string;
}

export interface SavedImage extends ImageInfo {
  path: string;
  bytes: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return resolve(input);
}

export function sniffImage(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 16) return null;

  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { mime: "image/png", ext: "png", ...pngSize(buffer) };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg", ...jpegSize(buffer) };
  }

  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp", ...webpSize(buffer) };
  }

  if (buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      mime: "image/gif",
      ext: "gif",
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  return null;
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  // 8 bytes firma + 4 longitud + "IHDR" + width(4) + height(4)
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return { width: 0, height: 0 };
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (length <= 0) break;
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

function webpSize(buffer: Buffer): { width: number; height: number } {
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (format === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return { width: 0, height: 0 };
}

async function fetchRemote(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" }).catch((error) => {
    throw new ImageForgeError("INPUT", `No se pudo descargar la imagen: ${(error as Error).message}`, {
      cause: error,
    });
  });

  if (!response.ok) {
    throw new ImageForgeError("INPUT", `La URL devolvió HTTP ${response.status}`, { hint: url });
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ImageForgeError(
      "INPUT",
      `La imagen remota pesa ${(declared / 1024 / 1024).toFixed(1)} MB y el límite es ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new ImageForgeError("INPUT", "La imagen remota excede el tamaño máximo permitido");
  }
  return buffer;
}

export async function loadImage(source: string, maxBytes: number): Promise<LoadedImage> {
  const trimmed = source.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    throw new ImageForgeError("INPUT", "La ruta de imagen está vacía");
  }

  let buffer: Buffer;
  let origin = trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    buffer = await fetchRemote(trimmed, maxBytes);
  } else {
    const filePath = trimmed.toLowerCase().startsWith("file://")
      ? fileURLToPath(trimmed)
      : expandPath(trimmed);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new ImageForgeError("INPUT", `No existe el archivo: ${filePath}`, {
        hint: "Acepta rutas absolutas, file:// o URLs http(s).",
      });
    }
    if (info.size > maxBytes) {
      throw new ImageForgeError(
        "INPUT",
        `La imagen pesa ${(info.size / 1024 / 1024).toFixed(1)} MB y el límite es ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
      );
    }
    buffer = await readFile(filePath);
    origin = filePath;
  }

  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    throw new ImageForgeError("INPUT", "El archivo no es una imagen PNG, JPEG, WEBP o GIF", {
      hint: "Convierte la imagen a PNG o JPEG antes de pasarla.",
    });
  }

  return { ...sniffed, buffer, origin };
}

export async function inspectImageFile(filePath: string): Promise<SavedImage> {
  const resolved = expandPath(filePath.trim().replace(/^["']|["']$/g, ""));
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    throw new ImageForgeError("INPUT", `No existe el archivo: ${resolved}`);
  }
  const buffer = await readFile(resolved);
  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    throw new ImageForgeError("INPUT", "El archivo no es una imagen PNG, JPEG, WEBP o GIF");
  }
  return { ...sniffed, path: resolved, bytes: buffer.length };
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function exists(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  return Boolean(info);
}

/**
 * Escribe la imagen de forma atómica: primero a un .tmp y luego renombra,
 * para no dejar archivos truncados si el proceso muere a mitad.
 */
export async function saveImage(
  buffer: Buffer,
  outDir: string,
  options: { seed?: number; prefix?: string } = {},
): Promise<SavedImage> {
  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    throw new ImageForgeError("UPSTREAM", "El modelo devolvió datos que no son una imagen válida", {
      hint: "Puede ser una respuesta de error con HTTP 200. Revisa el modelo o el prompt.",
    });
  }

  const directory = expandPath(outDir);
  await mkdir(directory, { recursive: true }).catch((error) => {
    throw new ImageForgeError("IO", `No se pudo crear la carpeta de salida: ${directory}`, {
      cause: error,
    });
  });

  const prefix = options.prefix ?? "image-forge";
  const suffix = options.seed !== undefined ? `-${options.seed}` : "";
  const base = `${prefix}-${timestamp(new Date())}${suffix}`;

  let candidate = join(directory, `${base}.${sniffed.ext}`);
  let counter = 2;
  while (await exists(candidate)) {
    candidate = join(directory, `${base}-${counter}.${sniffed.ext}`);
    counter += 1;
  }

  const temp = join(directory, `.${basename(candidate)}.tmp`);
  await writeFile(temp, buffer);
  await rename(temp, candidate);

  return { ...sniffed, path: candidate, bytes: buffer.length };
}
