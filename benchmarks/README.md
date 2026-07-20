# Benchmark catalog

This catalog measures deterministic analyzer output against labels stored in
data-only JSON manifests. The runner discovers every `*.benchmark.json` file
recursively, so adding a case does not require a registry change.

Benchmark fixtures can intentionally contain insecure or destructive examples.
They are test inputs, not production patterns to copy. External dependency and
model checks are always disabled by the benchmark runner.

## Case layout

Each manifest points to a fixture directory relative to this catalog:

```json
{
  "schemaVersion": 1,
  "id": "case-id",
  "name": "Readable case name",
  "fixture": "fixtures/case-id",
  "question": "What changes are affected?",
  "scope": "production",
  "changedFiles": [
    {
      "path": "src/service.ts",
      "status": "modified",
      "unstaged": true
    }
  ],
  "expected": {
    "impact": ["src/service.ts"],
    "security": ["injection:src/service.ts:12"],
    "schema": [
      "table:records",
      "column:records.id",
      "relationship:records.owner_id->owners.id:declared"
    ],
    "migration": ["drop-column:records.legacy_value"]
  }
}
```

Fixture and changed-file paths must be contained relative paths. Absolute
paths, parent traversal, and fixture symlinks that leave the catalog are
rejected before analysis.

## Metric semantics

Every dimension retains its exact true-positive, false-positive, and
false-negative labels. Precision, recall, and F1 are micro-aggregated for each
case, dimension, and complete run. A zero denominator is serialized as `null`
(`N/A`) rather than being counted as a perfect score.

Case results also preserve `partial` coverage from the analyzer report. A
consumer must not interpret a partial case with zero findings as a clean pass.
