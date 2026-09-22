---
type: ADR
id: "0106"
title: "Bounded incremental knowledge maintenance"
status: active
date: 2026-09-14
---

## Context

Recent automatic maintenance attempts spend the full 60-second budget reasoning over entire notes without saving. Source-grounded knowledge must remain verifiable without re-reading unrelated documents after every answer.

## Decision

Automatic maintenance uses a bounded 12,000-character evidence packet with source hashes and line ranges, explicit provider-compatible thinking controls, and a bounded output. A successful save ends the job without another generation. Keep the existing 60-second / five-turn safety limits.

Persist versioned, bounded candidate receipts in `.stela/skill-maintenance.local.json`, confined to the Vault and written through the existing atomic writer. Candidate identity includes operation, task intent, source hashes and evidence anchors. Successful or no-change decisions are reused while relevant Skill contents remain unchanged; unsuccessful attempts cool down for one hour. Manual knowledge maintenance bypasses these automatic receipts. Receipts are optimization hints, never knowledge authority; missing/corrupt receipts permit recomputation. Retain at most 256 receipts. Metrics retain individual attempts and stage timings; repeated candidates produce neutral skips rather than repeated warnings.

## Options considered

- Bounded evidence and receipts (chosen): limits cost while preserving source provenance.
- Longer timeout alone: permits more unbounded reasoning and repeated work.
- Whole-conversation summarization by another model: adds cost and another source of unsupported claims.

## Consequences

Evidence outside the selected complete blocks is unavailable and must not support saved rules. Insufficient evidence yields no change. A receipt may postpone useful work until cooldown expires; explicit maintenance remains available. Provider controls express intent but gateway compliance must be verified from actual responses. No foreground model policy changes.
