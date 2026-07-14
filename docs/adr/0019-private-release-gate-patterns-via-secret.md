---
type: ADR
id: "0019"
title: "Private release-gate patterns via env secret, not source"
status: active
date: 2026-07-14
---

## Context

`scripts/check-public-release.mjs` scans the public tree for forbidden strings. Putting
internal identifiers (personal handles, infra fingerprints) in the script itself
re-introduces those strings into the open-source repository and into CI failure
logs when the regex is echoed.

Local maintainers already had an escape hatch via gitignored
`scripts/internal/release-gate.local.json`. CI needs the same without committing
the patterns.

## Decision

**Keep only generic public leak shapes in-repo; load private regex sources from
`STELA_RELEASE_FORBIDDEN_PATTERNS` (CI Secret) and/or the local JSON gate. Never
echo matched pattern text in failure output.**

## Options considered

- **Env / Secret + local JSON** (chosen): private patterns stay out of git; CI injects
  via GitHub Actions `secrets.*`; local uses gitignored JSON — no new dependency.
- **Hardcode in script**: simple, but patterns become public forever.
- **Encrypted file in repo**: more moving parts; Secret + local JSON already covers
  CI vs laptop.

## Consequences

- Maintainers must set repository secret `STELA_RELEASE_FORBIDDEN_PATTERNS`
  (JSON array of regex sources, or newline-separated). Fork PRs without secrets
  only run the public generic patterns.
- Failure lines become `path: matches a forbidden pattern` — less precise for
  debugging, but secrets do not leak into logs.
- Re-evaluate if we need signed allowlists or org-level shared pattern packs.
