# Local engine API

The local engine binds to `127.0.0.1:4317` by default and returns JSON. It is a
read-only process boundary for the browser workbench and local integrations.

## Health

```http
GET /api/health
```

```json
{
  "service": "local-code-atlas-engine",
  "status": "ok",
  "version": "0.2.0",
  "localOnly": true,
  "platform": "darwin",
  "allowedRootsConfigured": true,
  "external": {
    "localByDefault": true,
    "osv": {
      "available": true,
      "wouldTransmit": ["package ecosystem", "package name", "exact version"]
    },
    "ai": {
      "configured": false,
      "wouldTransmit": ["project name", "detected languages and frameworks", "question", "project-relative evidence paths", "bounded redacted impact and security evidence", "table and column names"]
    }
  }
}
```

Clients must validate `service`, `status`, version, trust-boundary booleans, and
the `external` disclosure shape before sending a project path. A `2xx` response
by itself is not an analyzer identity signal.

The launcher additionally checks whether an existing engine is restricted to
the selected project without returning the configured path itself:

```http
GET /api/health?project=%2Fabsolute%2Fpath%2Fto%2Fproject
```

```json
{
  "service": "local-code-atlas-engine",
  "status": "ok",
  "allowedRootsConfigured": true,
  "projectPolicy": {
    "checked": true,
    "allowed": true,
    "exclusiveAllowedRoot": true
  }
}
```

`projectPolicy` is omitted when no project query is supplied. `allowed` means
the current engine policy permits the canonical directory;
`exclusiveAllowedRoot` is true only when that exact directory is the sole
configured root.

## Analyze a project

```http
POST /api/analyze
Content-Type: application/json
Origin: http://localhost:3000
```

```json
{
  "projectPath": "/absolute/path/to/project",
  "question": "If session expiry changes, what is affected?",
  "scope": "production",
  "comparison": {
    "mode": "base",
    "base": "main"
  },
  "checkDependencies": false,
  "enableAi": false
}
```

Use `"sample": true` instead of `projectPath` to analyze the bundled synthetic
project. `checkDependencies` and `enableAi` are explicit network opt-ins and
default to `false`.

`scope` accepts `production` (the default) or `all`. Production scope keeps
application and test files available to change-impact analysis while excluding
examples, fixtures, documentation, generated, and vendored sources; security
and schema analysis use the stricter production subset.

`comparison.mode` accepts:

- `working-tree` (default): staged, unstaged, and untracked changes;
- `staged`: Git index changes only;
- `base`: merge-base comparison from the validated `base` revision to `HEAD`.

The response groups evidence into:

- `project`: detected structure, languages, frameworks, Git branch, and changes;
- `impact`: ranked files, file/line evidence, and suggested tests;
- `security`: normalized findings, severities, and dependency inventory;
- `erd`: tables, columns, and declared or inferred relationships;
- `ai`: configured/enabled state and optional synthesis;
- `run`: analysis scope, partial state, and per-stage coverage;
- `external`: OSV/model request status, fields that would be sent, and fields
  included in an actual network request;
- `diagnostics`: parser limits, uncertainty, and non-fatal failures.

`project.git.changes` retains status, staged/unstaged flags, rename provenance,
and available addition/deletion counts. Security findings and ERD entities use
review `relevance` to distinguish direct, indirect, and project-wide context
from the impact ranking; it is not a claim that the entity itself changed. ERD
relationships include a separate `origin` field (`declared` or `inferred`);
confidence never determines declaration origin.

When `scope` is `all`, each security finding keeps its repository role as
`production`, `test`, `example`, `fixture`, `documentation`, `generated`, or
`vendor`; production configuration and manifest findings use `configuration`.
ERD table names and every relationship or column foreign-key target use the
same namespace-qualified identity (for example, `billing.users`) whenever a
schema or database namespace is declared.

The health response uses `wouldTransmit` because no external request has
occurred yet. Each analysis receipt exposes `requestAttempted`, keeps the same
`wouldTransmit` disclosure, and populates `transmitted` only when a network
request was actually attempted. A selected option that is not configured or
has no eligible packages therefore remains an empty `transmitted` list.
When model synthesis is configured, `endpointOrigin` contains only the
validated scheme, host, and port; credentials, paths, queries, and fragments
are never returned.

Absolute internal scan paths are never returned for bundled samples. Findings
use project-relative paths. A user-selected project path is echoed as the
project label so the local operator can confirm which directory was analyzed.

## Errors

Errors use a stable shape and include an opaque request identifier:

```json
{
  "error": {
    "code": "PATH_OUTSIDE_ALLOWED_ROOTS",
    "message": "The project is outside the roots allowed by this engine.",
    "requestId": "..."
  }
}
```

Expected client errors use HTTP `400`, an unapproved browser origin uses `403`,
an oversized request uses `413`, and unexpected analyzer failures use `500`.
The public error never contains a stack trace.

Comparison validation uses codes such as `INVALID_COMPARISON_BASE` and
`COMPARISON_BASE_NOT_FOUND`; a base comparison on a non-Git directory returns
`COMPARISON_REQUIRES_GIT`. Path validation distinguishes missing, relative,
overly broad, unreadable, and outside-allowed-root paths.

## Browser origin policy

Requests without an `Origin` header are permitted for local CLI clients. Browser
requests are limited to the values in `ATLAS_ALLOWED_ORIGINS`, which defaults to
the local web workbench on `localhost:3000` and `127.0.0.1:3000`.
