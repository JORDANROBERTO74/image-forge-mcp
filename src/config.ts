import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ImageForgeError } from "./lib/errors.js";

export interface AppConfig {
  accountId?: string;
  apiToken?: string;
  outDir: string;
  historyPath: string;
  maxImagesPerCall: number;
  maxInputBytes: number;
  warnNeurons: number;
  hardNeurons: number;
  timeoutMs: number;
}

export interface Credentials {
  accountId: string;
  apiToken: string;
}

const DEFAULT_OUT_DIR = join(homedir(), "Downloads");
const DEFAULT_HISTORY = join(homedir(), ".image-forge", "history.jsonl");

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ImageForgeError("CONFIG", `${name} debe ser un número entre ${min} y ${max} (recibido: "${raw}")`);
  }
  return value;
}

function expandPath(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function loadConfig(): AppConfig {
  const outDirRaw = process.env.IMAGE_OUT_DIR;
  const historyRaw = process.env.IMAGE_FORGE_HISTORY;

  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
    apiToken: process.env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
    outDir: outDirRaw ? expandPath(outDirRaw) : DEFAULT_OUT_DIR,
    historyPath: historyRaw ? expandPath(historyRaw) : DEFAULT_HISTORY,
    maxImagesPerCall: readNumber("IMAGE_FORGE_MAX_IMAGES_PER_CALL", 4, 1, 8),
    maxInputBytes: readNumber("IMAGE_FORGE_MAX_INPUT_MB", 10, 1, 50) * 1024 * 1024,
    warnNeurons: readNumber("IMAGE_FORGE_WARN_NEURONS", 8000, 0, 10000),
    hardNeurons: readNumber("IMAGE_FORGE_HARD_NEURONS", 9500, 0, 10000),
    timeoutMs: readNumber("IMAGE_FORGE_TIMEOUT_MS", 90000, 5000, 300000),
  };
}

export function requireCredentials(config: AppConfig): Credentials {
  if (!config.accountId || !config.apiToken) {
    const missing = [
      !config.accountId ? "CLOUDFLARE_ACCOUNT_ID" : null,
      !config.apiToken ? "CLOUDFLARE_API_TOKEN" : null,
    ].filter(Boolean);
    throw new ImageForgeError("CONFIG", `Faltan credenciales: ${missing.join(", ")}`, {
      hint: "Crea image-forge/.env a partir de .env.example. Token con permiso Account -> Workers AI -> Read.",
    });
  }
  return { accountId: config.accountId, apiToken: config.apiToken };
}
