---
type: ADR
id: "0117"
title: "Local AI privacy boundary and conversation pseudonyms"
status: superseded
superseded_by: "0118"
date: 2026-09-24
---

## Context

Users need optional local PII minimization without installing Python or sending
data to a detection service. Stela has multiple model call paths and a persistent
Python workspace; filtering only SQL previews would leave other paths exposed.

## Decision

**Bundle the pinned Apache-2.0 argus-redact fast WASM engine and apply a shared,
fail-closed privacy boundary to all Vault AI requests. Main owns random,
conversation-scoped reversible pseudonyms and persists their mapping with the
conversation. Python receives sanitized complete artifacts, never the mapping.**

The switch defaults off and is snapshotted per task. Display restoration is a
separate local projection with provenance annotations; it never changes model
history. Credentials retain existing irreversible redaction. Temporary Chat
maps stay local; saved Chat maps follow the document into Git. Possession of the
document permits restoration: this protects the model boundary, not Vault readers.

## Options considered

- **Bundled fast WASM (chosen):** small offline engine, no model download; regex
  detection is incomplete and may misclassify values.
- First-use download: adds availability and update complexity for a roughly 1 MB
  compressed artifact.
- Raw Python inputs with output-only detection: keeps more string operations but
  lets generated code transform originals beyond detector recognition.

## Consequences

Privacy-mode Python cannot analyze the spelling of redacted identities. Complete
artifacts require bounded, cancellable scanning. Missing mappings, ambiguous
query restoration, unsupported payloads and detector errors must not fall back
to plaintext. Native Pi retains compaction ownership; its requests use the same
transport boundary. No anonymity or adversarial detection guarantee is implied.
