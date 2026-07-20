import { dirname, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { analyzeLocalProject } from "../src/report/analyze.js";
import { serializeReport, type ReportFormat } from "../src/report/export.js";
import type {
  GitComparisonMode,
  ProjectScope,
} from "../src/report/types.js";
import { loadEngineConfig } from "./config.js";
import { loadLocalEnvironment } from "./env.js";
import { resolveProjectPath } from "./path-policy.js";
import {
  bundledSampleRoot,
  loadBundledSampleGitMetadata,
  loadBundledSampleGitSnapshots,
} from "./sample.js";

interface CliOptions {
  path?: string;
  question?: string;
  sample: boolean;
  enableAi: boolean;
  checkDependencies: boolean;
  scope: ProjectScope;
  comparison: { mode: GitComparisonMode; base?: string };
  format: ReportFormat;
  output?: string;
  help: boolean;
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = {
    sample: false,
    enableAi: false,
    checkDependencies: false,
    scope: "production",
    comparison: { mode: "working-tree" },
    format: "json",
    help: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--sample") options.sample = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--ai") options.enableAi = true;
    else if (argument === "--osv") options.checkDependencies = true;
    else if (argument === "--staged") {
      if (options.comparison.mode === "base") {
        throw new Error("--staged cannot be combined with --base.");
      }
      options.comparison = { mode: "staged" };
    } else if (argument === "--base") {
      const base = arguments_[index + 1];
      if (!base) throw new Error("--base requires a branch or commit.");
      if (options.comparison.mode === "staged") {
        throw new Error("--base cannot be combined with --staged.");
      }
      options.comparison = { mode: "base", base };
      index += 1;
    } else if (argument === "--scope") {
      const scope = arguments_[index + 1];
      if (scope !== "production" && scope !== "all") {
        throw new Error("--scope must be production or all.");
      }
      options.scope = scope;
      index += 1;
    } else if (argument === "--format") {
      const format = arguments_[index + 1];
      if (format !== "json" && format !== "markdown" && format !== "sarif") {
        throw new Error("--format must be json, markdown, or sarif.");
      }
      options.format = format;
      index += 1;
    } else if (argument === "--output" || argument === "-o") {
      const output = arguments_[index + 1];
      if (!output) throw new Error(`${argument} requires a file path.`);
      options.output = output;
      index += 1;
    } else if (argument === "--question" || argument === "-q") {
      const question = arguments_[index + 1];
      if (!question) throw new Error(`${argument} requires a value.`);
      options.question = question;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!options.path) options.path = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
}

function usage(): string {
  return `Local Code Atlas

Usage:
  pnpm atlas <project-path> [options]
  pnpm atlas --sample [options]

Options:
  -q, --question <text>     Natural-language impact question
      --staged             Analyze staged changes only
      --base <revision>    Compare revision...HEAD
      --scope <scope>      production (default) or all
      --osv                Query OSV for exact resolved dependencies
      --ai                 Use the configured model endpoint
      --format <format>    json (default), markdown, or sarif
  -o, --output <file>      Write the report to a file
  -h, --help               Show this help
`;
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnvironment(projectRoot);
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const config = loadEngineConfig();
  const root = options.sample
    ? bundledSampleRoot(projectRoot)
    : await resolveProjectPath(options.path ? resolve(options.path) : "", config);
  const report = await analyzeLocalProject({
    root,
    question:
      options.question ?? "What is affected by the current local changes?",
    enableAi: options.enableAi,
    checkDependencies: options.checkDependencies,
    scope: options.scope,
    comparison: options.sample ? { mode: "working-tree" } : options.comparison,
    gitMetadataOverride: options.sample
      ? await loadBundledSampleGitMetadata(projectRoot)
      : undefined,
    gitFileSnapshotsOverride: options.sample
      ? await loadBundledSampleGitSnapshots(projectRoot)
      : undefined,
    publicPath: options.sample ? "Bundled sample" : root,
    limits: {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
    },
  });
  const serialized = serializeReport(report, options.format);
  if (options.output) {
    const outputPath = resolve(options.output);
    await writeFile(outputPath, serialized, "utf8");
    process.stderr.write(`Local Code Atlas: wrote ${options.format} report to ${outputPath}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Analysis failed.";
  process.stderr.write(`Local Code Atlas: ${message}\n`);
  process.exitCode = 1;
});
