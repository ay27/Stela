---
name: create-adr
description: >-
  Create or supersede a Stela Architecture Decision Record under docs/adr/,
  update the ADR index, and keep ARCHITECTURE.md / ABSTRACTIONS.md in sync.
  Use when making a structural decision (dependency, storage/sync, IPC/security,
  connector protocol, core abstraction, cross-cutting pattern), or when the user
  asks to create an ADR / document an architecture decision.
---

# Create Architecture Decision Record (Stela)

## When to use

Create an ADR when work involves any of:

- Choosing a storage / sync strategy
- Adding or removing a major dependency
- Changing IPC, security, or process boundaries
- Changing connector plugin protocol or trust model
- Introducing or removing a core abstraction
- Making a cross-cutting decision that future code must follow

Do **not** create ADRs for: bug fixes, UI styling, behavior-preserving refactors, or test-only changes.

## Create a new ADR

### 1. Find the next ID

```bash
python3 - <<'PY'
from pathlib import Path
ids = []
for p in Path("docs/adr").glob("*.md"):
    name = p.name
    if len(name) >= 4 and name[:4].isdigit():
        ids.append(int(name[:4]))
print(f"{(max(ids) + 1) if ids else 1:04d}")
PY
```

### 2. Create the file

Filename: `docs/adr/NNNN-short-kebab-title.md`

```markdown
---
type: ADR
id: "NNNN"
title: "Short decision title"
status: active
date: YYYY-MM-DD
---

## Context

The issue motivating this decision, and any constraints.

## Decision

**The change we agreed to implement.** One or two clear sentences.

## Options considered

- **Option A** (chosen): brief — pros / cons
- **Option B**: brief — pros / cons

## Consequences

What becomes easier or harder?
What risks need mitigation?
What would trigger re-evaluation?
```

### 3. Update the index

Add a row to `docs/adr/README.md`:

```markdown
| [NNNN](NNNN-short-kebab-title.md) | Title | active |
```

### 4. Update living docs if needed

- Process / storage / IPC / connector / Git / AI architecture → `docs/ARCHITECTURE.md`
- Domain types / contracts / conventions → `docs/ABSTRACTIONS.md`

### 5. Same change as the feature

Fold ADR + doc updates into the feature commit when possible. Do not leave structural decisions undocumented.

## Supersede an existing ADR

1. Edit **only** the old ADR frontmatter:

```yaml
status: superseded
superseded_by: "NNNN"
```

Never edit the body of an active ADR.

2. Create the new ADR. In **Context**, start with:

```markdown
Supersedes [ADR-000N](000N-old-title.md).
```

3. Update both rows in `docs/adr/README.md`.

## Best practices

- One decision per ADR
- Write **Decision** first — if it needs a paragraph, split the decision
- Consequences must include downsides
- Date = today (`YYYY-MM-DD`)
- If in doubt, create one — cheaper than losing context
