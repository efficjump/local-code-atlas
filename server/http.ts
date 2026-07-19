import type { IncomingMessage, ServerResponse } from "node:http";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody<T>(
  request: IncomingMessage,
  byteLimit: number,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > byteLimit) {
      throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function originIsAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  const normalized = origin.replace(/\/+$/u, "");
  return allowedOrigins.includes(normalized);
}

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const origin = request.headers.origin;
  if (origin && originIsAllowed(origin, allowedOrigins)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Vary", "Origin");
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}
