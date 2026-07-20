import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmarkCatalog } from "../src/benchmark/index.js";

interface Options {
  output?: string;
  compact: boolean;
  help: boolean;
}

function parseArguments(arguments_: readonly string[]): Options {
  const options: Options = { compact: false, help: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--output" || argument === "-o") {
      const output = arguments_[index + 1];
      if (!output) throw new Error(`${argument} requires a file path.`);
      options.output = output;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function usage(): string {
  return `Local Code Atlas Benchmark Lab

Usage:
  pnpm benchmark [options]

Options:
  -o, --output <file>  Write the JSON result to a file
      --compact        Emit compact JSON instead of formatted JSON
  -h, --help           Show this help
`;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = await runBenchmarkCatalog(join(projectRoot, "benchmarks"));
  const serialized = `${JSON.stringify(result, null, options.compact ? 0 : 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    await writeFile(outputPath, serialized, "utf8");
    process.stderr.write(`Local Code Atlas: wrote benchmark report to ${outputPath}\n`);
    return;
  }
  process.stdout.write(serialized);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Benchmark failed.";
  process.stderr.write(`Local Code Atlas: ${message}\n`);
  process.exitCode = 1;
});
