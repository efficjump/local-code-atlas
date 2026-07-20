# Roadmap

Local Code Atlas is organized around one review workflow:

`select a project → choose a Git comparison → connect code, risk, tests, and data → act on evidence → export the review`

## 0.3 measurable daily review — current

- production/all source scopes and deterministic sample data;
- working-tree, staged, and base-revision comparisons;
- lockfile-aware npm advisory coverage;
- review relevance across impact, security, and data evidence;
- declared/inferred ERD graph;
- analyzer completeness and external-transfer status;
- local launcher and JSON, Markdown, or SARIF CLI output;
- exact Git before/after SQL migration review with fail-closed coverage;
- local Benchmark Lab with checked-in ground truth and visible FP/FN labels.

## 0.4 review memory and policy

- open a source location in a configured editor;
- persist false-positive suppressions with reasons;
- compare findings with a local baseline;
- show new, resolved, and unchanged findings;
- retain recent projects and reports on the device;
- add dialect profiles and broader ORM migration-state support;
- add benchmark thresholds and ranked impact metrics for CI policy.

## 1.0 extensible local analysis

- deeper language-specific AST and data-flow adapters;
- incremental indexing for large repositories;
- monorepo package and service boundaries;
- broader lockfile ecosystem coverage;
- stable SARIF/CI policy options such as severity thresholds;
- documented analyzer extension packages.

The roadmap describes intent, not a compatibility or delivery guarantee.
