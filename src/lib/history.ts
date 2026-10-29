import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HistoryEntry {
  ts: string;
  tool: "edit_image" | "generate_image";
  model: string;
  prompt: string;
  seed?: number;
  images: string[];
  neurons: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export function defaultHistoryPath(): string {
  return join(homedir(), ".image-forge", "history.jsonl");
}

export async function appendHistory(entry: HistoryEntry, historyPath = defaultHistoryPath()): Promise<void> {
  try {
    await mkdir(dirname(historyPath), { recursive: true });
    await appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    // El historial es telemetría: si falla, no debe tumbar la generación.
    console.error("image-forge: no se pudo escribir el historial:", (error as Error).message);
  }
}

/** Neurons consumidos en el día UTC actual (la cuota de Cloudflare resetea a las 00:00 UTC). */
export async function neuronsUsedToday(historyPath = defaultHistoryPath()): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    return 0;
  }

  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (typeof entry.ts === "string" && entry.ts.startsWith(today) && typeof entry.neurons === "number") {
        total += entry.neurons;
      }
    } catch {
      // Línea corrupta: se ignora.
    }
  }
  return total;
}
