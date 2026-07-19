import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const requestedRoots = process.argv.slice(2);
const roots = requestedRoots.length > 0 ? requestedRoots : ["tests"];
const testFiles = [];

for (const root of roots) {
  let entries;
  try {
    entries = await readdir(resolve(root), {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.test\.(?:ts|mts|mjs)$/u.test(entry.name)) continue;
    testFiles.push(resolve(entry.parentPath, entry.name));
  }
}

testFiles.sort((left, right) => left.localeCompare(right, "en"));
if (testFiles.length === 0) {
  console.error("No test files were found.");
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...testFiles],
    { stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
