# Security policy

Local Code Atlas analyzes source trees that can contain sensitive material. A
security report about the analyzer itself should therefore be handled privately.

## Supported versions

Security fixes are applied to the latest release on the `main` branch until a
stable release policy is published.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not
open a public issue with exploit details, source code, tokens, or private paths.
Include the affected version, reproduction steps, impact, and any suggested
mitigation. You should receive an initial acknowledgement within seven days.

## Analyzer safety boundaries

- Analysis is read-only. Local Code Atlas does not rewrite source files or run
  project build scripts.
- Findings redact possible secret values and return only locations and safe
  fingerprints.
- External AI synthesis is disabled unless the operator configures a provider
  and explicitly enables it for a request.
- Configure `ATLAS_ALLOWED_ROOTS` when the local engine is reachable by another
  process or user.

Security findings produced by Local Code Atlas are leads for human review, not
proof that a project is secure or vulnerable.
