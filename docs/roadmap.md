# Roadmap

Local Code Atlas is organized around one review workflow:

`select a project → choose a Git comparison → connect code, risk, tests, and data → act on evidence → export the review`

## 0.2 public alpha — current

- production/all source scopes and deterministic sample data;
- working-tree, staged, and base-revision comparisons;
- lockfile-aware npm advisory coverage;
- review relevance across impact, security, and data evidence;
- declared/inferred ERD graph;
- analyzer completeness and external-transfer status;
- local launcher and JSON, Markdown, or SARIF CLI output.

## 0.3 daily review workflow

- open a source location in a configured editor;
- persist false-positive suppressions with reasons;
- compare findings with a local baseline;
- show new, resolved, and unchanged findings;
- retain recent projects and reports on the device;
- add schema-diff emphasis and migration-state improvements.

## 1.0 extensible local analysis

- deeper language-specific AST and data-flow adapters;
- incremental indexing for large repositories;
- monorepo package and service boundaries;
- broader lockfile ecosystem coverage;
- stable SARIF/CI policy options such as severity thresholds;
- documented analyzer extension packages.

The roadmap describes intent, not a compatibility or delivery guarantee.
