# Changelog

All notable changes to Local Code Atlas are documented here.

## 0.2.0 — 2026-07-20

### Added

- Production/all source scopes with configurable test, fixture, example,
  documentation, generated, and vendor classification.
- Working-tree, staged-only, and validated base-revision comparison modes.
- Lockfile-aware npm inventory for pnpm, package-lock, and Yarn with direct and
  transitive resolved versions.
- Explicit analyzer coverage states, OSV query coverage, and external-transfer
  disclosure.
- Review relevance on security and data evidence, structured Git change stats,
  and declared/inferred ERD provenance.
- Searchable relationship graph, result filters, source copy actions, and
  initial engine health guidance.
- JSON, Markdown, and SARIF CLI reports plus a one-command local launcher.
- Deterministic bundled-sample Git scenario independent of repository state.

### Fixed

- Nested manifests no longer replace the analyzed root project's name or
  contaminate framework detection.
- Tests, examples, fixtures, and analyzer rule literals no longer appear as
  production security findings by default.
- Declared database relationships are no longer mislabeled as inferred based
  on confidence alone.
- Relative project paths are rejected while `~/project` is expanded safely.
- Validation, path, comparison, and connection failures retain distinct error
  codes and recovery guidance.
- Incomplete graph, oversized, unreadable, schema, and dependency inputs now
  mark reports partial instead of producing clean-looking zeroes.
- Health identity, launcher root/origin checks, non-loopback binding guards,
  and disconnect cancellation now fail closed before exposing a project path.
- Git inspection disables optional locks, fsmonitor, external diff drivers, and
  text conversion so read-only analysis cannot run repository helpers.
- Optional OSV and model requests now have bounded cancellation, accurate
  transfer receipts, safe advisory intervals/CVSS severity, validated endpoint
  origins, and redirect refusal.
- Secret findings no longer expose value-derived hashes, and SARIF artifact
  paths are encoded for standards-compliant CI consumers.

## 0.1.0 — 2026-07-20

### Added

- Local project discovery, configurable scanning budgets, ignore handling, and
  language/framework detection.
- Git-aware change impact graph with source evidence and test suggestions.
- Redacted secret candidates, deterministic security patterns, and direct
  dependency inventory.
- Explicitly opt-in OSV known-advisory lookup for exact dependency versions.
- SQL, Prisma, TypeORM, and JPA schema extraction with declared and inferred
  relationship confidence.
- Optional chat-completions evidence synthesis without a fixed provider or
  model.
- Loopback-only local API, path policy, origin policy, cancellation, and CLI.
- Accessible responsive workbench with Overview, Impact, Security, and Data Map
  views.
- Bundled synthetic sample, automated tests, render verification, CI, security
  policy, and contributor documentation.
