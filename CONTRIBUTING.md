# Contributing

Thanks for helping improve Local Code Atlas. Small fixes and focused analyzer
adapters are welcome, as are reproducible reports for false positives and false
negatives.

## Development setup

1. Install Node.js 22 or newer and pnpm.
2. Run `pnpm install`.
3. Start the workbench with `pnpm dev`.
4. Run `pnpm check` before opening a pull request.

Do not add real credentials, proprietary source fixtures, or personally
identifying paths. Fixtures should be minimal, synthetic, and clearly label any
deliberately insecure code.

## Pull requests

- Keep an analyzer deterministic and explain how its confidence is calculated.
- Add fixtures for both findings and non-findings.
- Preserve exact source provenance without returning sensitive values.
- Document new configuration and its privacy implications.
- Explain user-visible behavior and trade-offs in the pull request description.

For security reports, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
