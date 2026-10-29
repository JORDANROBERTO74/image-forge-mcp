export type ErrorCode = "CONFIG" | "AUTH" | "QUOTA" | "INPUT" | "UPSTREAM" | "SCHEMA" | "IO";

export interface ImageForgeErrorOptions {
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class ImageForgeError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: ImageForgeErrorOptions = {}) {
    super(message);
    this.name = "ImageForgeError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Elimina cualquier rastro de credenciales antes de exponer texto al cliente. */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]");
}

function truncate(text: string, max: number): string {
  const clean = redact(text.replace(/\s+/g, " ").trim());
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function mapHttpError(status: number, body: string, model: string): ImageForgeError {
  const detail = truncate(body, 300);

  if (status === 400 || status === 422) {
    return new ImageForgeError("SCHEMA", `Cloudflare rechazó la petición para ${model} (HTTP ${status}): ${detail}`, {
      hint: "Revisa width/height/steps/strength: cada modelo acepta rangos distintos.",
    });
  }
  if (status === 401) {
    return new ImageForgeError("AUTH", "El token de Cloudflare no es válido (HTTP 401)", {
      hint: "Regenera el API token y actualiza CLOUDFLARE_API_TOKEN en image-forge/.env.",
    });
  }
  if (status === 403 && /not allowed to access|"code"\s*:\s*5018/i.test(body)) {
    return new ImageForgeError("SCHEMA", `Tu cuenta no tiene acceso a ${model} (HTTP 403 · error 5018)`, {
      hint: "Ese modelo no está habilitado para tu plan. Usa model=flux-2-klein-4b, que sí está disponible.",
    });
  }
  if (status === 403) {
    return new ImageForgeError("AUTH", "El token no tiene permiso para Workers AI (HTTP 403)", {
      hint: "El token necesita el permiso Account -> Workers AI -> Read.",
    });
  }
  if (status === 404) {
    return new ImageForgeError("SCHEMA", `El modelo ${model} no existe o no está disponible en tu cuenta (HTTP 404)`, {
      hint: "Prueba con model=sd15-img2img, o revisa el catálogo de Workers AI.",
    });
  }
  if (status === 413) {
    return new ImageForgeError("INPUT", "La imagen de entrada es demasiado grande (HTTP 413)", {
      hint: "Reduce la resolución o sube IMAGE_FORGE_MAX_INPUT_MB.",
    });
  }
  if (status === 429) {
    return new ImageForgeError("QUOTA", "Límite alcanzado: cuota diaria de neurons agotada o demasiadas peticiones por minuto (HTTP 429)", {
      hint: "La asignación gratuita (10.000 neurons) se reinicia a las 00:00 UTC. Mientras tanto usa model=sd15-img2img, que cuesta 0.",
    });
  }
  if (status >= 500) {
    return new ImageForgeError("UPSTREAM", `Cloudflare falló al procesar la imagen (HTTP ${status})`, {
      retryable: true,
      hint: detail,
    });
  }
  return new ImageForgeError("UPSTREAM", `Respuesta inesperada de Cloudflare (HTTP ${status}): ${detail}`);
}

export function formatToolError(error: unknown): string {
  if (error instanceof ImageForgeError) {
    const lines = [`⛔ ${error.code}: ${error.message}`];
    if (error.hint) lines.push(`→ ${error.hint}`);
    return lines.join("\n");
  }
  const message = error instanceof Error ? error.message : String(error);
  return `⛔ ERROR: ${truncate(message, 500)}`;
}
