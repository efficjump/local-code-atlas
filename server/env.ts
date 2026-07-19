import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export function loadLocalEnvironment(projectRoot: string): void {
  const inheritedKeys = new Set(Object.keys(process.env));
  const loaded: Record<string, string> = {};
  for (const fileName of [".env", ".env.local"]) {
    const path = join(projectRoot, fileName);
    if (!existsSync(path)) continue;
    try {
      Object.assign(loaded, parseEnv(readFileSync(path, "utf8")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid environment file";
      throw new Error(`${fileName} could not be loaded: ${message}`);
    }
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (!inheritedKeys.has(key)) process.env[key] = value;
  }
}
