import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

export interface EngineConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  allowedOrigins: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  requestBodyBytes: number;
  homeDirectory: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function portNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : fallback;
}

function configuredRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(new RegExp(`[${delimiter === ":" ? ":," : ";,"}]`))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function configuredOrigins(value: string | undefined): string[] {
  const defaults = ["http://localhost:3000", "http://127.0.0.1:3000"];
  if (!value) return defaults;
  return value
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function loadEngineConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EngineConfig {
  const config = {
    host: environment.ATLAS_HOST?.trim() || "127.0.0.1",
    port: portNumber(environment.ATLAS_PORT, 4317),
    allowedRoots: configuredRoots(environment.ATLAS_ALLOWED_ROOTS),
    allowedOrigins: configuredOrigins(environment.ATLAS_ALLOWED_ORIGINS),
    maxFiles: positiveInteger(environment.ATLAS_MAX_FILES, 5_000),
    maxFileBytes: positiveInteger(environment.ATLAS_MAX_FILE_BYTES, 1_000_000),
    maxTotalBytes: positiveInteger(
      environment.ATLAS_MAX_TOTAL_BYTES,
      50_000_000,
    ),
    requestBodyBytes: positiveInteger(
      environment.ATLAS_REQUEST_BODY_BYTES,
      65_536,
    ),
    homeDirectory: homedir(),
  };
  return config;
}

export function assertSafeServerBinding(config: EngineConfig): void {
  if (!isLoopbackHost(config.host) && config.allowedRoots.length === 0) {
    throw new Error(
      "ATLAS_ALLOWED_ROOTS is required when ATLAS_HOST is not loopback-only. The engine has no authentication boundary.",
    );
  }
}
