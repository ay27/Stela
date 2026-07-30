---
type: ADR
id: "0039"
title: "Concise agent final answers"
status: active
date: 2026-07-28
---

## Context

[ADR-0027](0027-agent-ask-user-clarification.md) fixed a mandatory final-answer
contract: conclusion, evidence, key numbers, assumptions made, and remaining
uncertainty — with the assumptions section required every time. In practice the
model treats every section as mandatory filler, so even a simple lookup ends
with a long five-section report. Users who already have their answer still wait
for (and scroll past) a padded summary. The `ask_user` decision itself is
unchanged; only the final-answer format bullet is revisited here.

## Decision

**Final answers are concise by default: lead with the direct answer and key numbers in 1–3 sentences plus one compact evidence line (table · column · SQL logic); assumptions and uncertainty sections appear only when an ambiguity was actually resolved or something genuinely remains open.**

## Options considered

- **Conditional sections** (chosen): keeps the audit value of stated assumptions exactly where assumptions exist, removes padding where they don't.
- **Keep the fixed five-section contract**: uniform, but the uniformity is what produces filler; every trivial answer pays the cost.
- **No format guidance at all**: shorter, but loses the evidence discipline that makes agent answers checkable.

## Consequences

- `docs/ABSTRACTIONS.md` and the agent system prompt describe the concise contract; ADR-0027 remains authoritative for `ask_user` but its final-answer bullet is narrowed by this record.
- Risk: a model may omit an assumptions note it should have written. Mitigation stays prompt-level ("only add … when you actually resolved an ambiguity") plus user pushback; re-evaluate if omitted assumptions start causing wrong numbers to be trusted silently.
