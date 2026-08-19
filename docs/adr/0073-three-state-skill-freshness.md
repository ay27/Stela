---
type: ADR
id: "0073"
title: "Three-state Skill freshness and maintenance inspection"
status: active
date: 2026-08-19
---

## Context

Supersedes [ADR-0050](0050-source-tracked-template-driven-skills.md).

Source-aware loading currently treats a Skill with no tracked source as stale,
lists stale metadata as if it were usable, and rejects the body only when
`load_skill` cannot refresh it. Explicit maintenance can therefore save a
source-less Skill that immediately becomes unavailable, while automatic prompt
matching can bias a library-wide maintenance run toward stale current-document
candidates.

## Decision

**Classify Skills as `fresh`, `stale`, or `untracked`; keep stale Skills out of
routine discovery, but expose stale and untracked metadata and inspection-only
bodies during explicit knowledge maintenance. Knowledge-maintenance turns start
without automatic Skill injection, and explicit saves bind source notes and
tables actually read during that turn.**

## Options considered

- **Three-state, intent-aware discovery** (chosen): keeps routine guidance safe
  while preserving enough old content and provenance to repair the library.
- **Hide every non-fresh Skill**: simple for routine use, but makes stale and
  legacy knowledge impossible to inspect or repair through the Agent.
- **List everything and refresh on load**: preserves the old implementation but
  advertises unusable candidates and creates noisy, side-effectful failures.

## Consequences

- Source-less legacy or manually authored Skills remain inspectable as
  `untracked` instead of being mislabeled as stale.
- Routine prompt matching uses only fresh Skills; routine search omits stale
  candidates and warns when an untracked Skill is loaded.
- Explicit maintenance may read stale content only as an untrusted draft and
  must verify facts from live schema, SQL usage, or Vault notes before saving.
- Freshness checks add bounded local file/index work to returned Skill pages;
  per-run caching prevents repeated checks.
- Re-evaluate if Vaults grow large enough to require a persistent freshness
  index rather than bounded on-demand checks.
