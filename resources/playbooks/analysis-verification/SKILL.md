---
name: analysis-verification
description: Targeted population, grain, identity and stage-relationship checks; sourced contracts and bounded coverage evidence in Python.
---

# When to use

For material scope, grain, denominator, time or business-rule risks, including SQL-only work. Reuse evidence; query unresolved distinctions. Skip trivial arithmetic. No extra reviewer or inference.

# Conditional decision checks

Apply only checks that can change the answer:

- Candidate exclusion: compare rejected items with supporting attributes/text and the requested definition. Apply one supported rule uniformly; uncertain membership stays unresolved, not negative.
- Grouping grain: inspect code/name mappings at the requested level. Many-to-one names can merge groups. A qualifier removing no rows warrants investigation, not an automatic column change. The finest grain is not always the right grain.
- Identity conflict: preserve raw IDs; inspect collisions before normalization/fuzzy matching. Prefixes can carry identity. Similarity cannot override an exact match without source evidence.
- Relationship direction: label endpoints; trace source ID to target ID to the requested attribute. The opposite endpoint answers a different question.
- Coverage: check the population before heuristic filters. One regex spelling cannot prove coverage of all mentions. Inspect consequential unmatched variants.
- Ratios: use the requested denominator, including unresolved labels where applicable. Hierarchy changes may require deduplication or aggregation and a corresponding title.
- Policies: check applicable terms and effective conditions; correlation does not prove eligibility. Resolve conflicts with a discriminating fact or clarification.

Recompute after changing decisions. Successful queries/checks do not prove meaning. Keep unresolved impacts visible.

# Sourced contract

`analysis.contract(required=[...])` supports population, metric, granularity, denominator, business_rule, time_range. Require only relevant fields. With automatic evidence enabled, `analysis.current` already exists; otherwise create a contract explicitly. There is no `analysis.claim()` or `.summary()` API.

```python
contract = analysis.contract(required=['population', 'denominator'])
contract.claim('population', population_definition,
    source='question', evidence=exact_question_excerpt)
contract.claim('denominator', denominator_definition,
    source=query_alias, evidence=observed_scope)
result = contract.report()
```

Sources are actual query aliases/run IDs or exact question excerpts, not invented Python result IDs. Missing claims remain unresolved; conflicting claims need an explicit revision. Retain the contract across cells; `result` contains current output only.

# Cross-stage populations

User confirmation defines the target; it does not prove a downstream project-prefix filter selects that target. For material stage ratios:

```python
contract.comparison('source-to-pbr', population='requested cohort', grain='asset',
    key='asset_id', upstream_source='source_assets', downstream_source='pbr_assets',
    definition_source='question', definition_evidence=exact_question_excerpt)
contract.check_relationship('source-to-pbr')
result = contract.report()
```

This inspects registered source IDs, bounded to 100,000 rows / 1,000,000 cells per source. Grouped counts, missing/null/duplicate keys, incomplete/empty sources or mismatched IDs cannot prove the relationship. `identity_checked` means containment only, not verified business scope. Without independent scope justification, report separate descriptive totals and filters, not a verified conversion/expansion ratio. Explicit contracts emit observations even with automatic contracts disabled; ordinary lookups need none.

# Binding execution evidence

With automatic evidence enabled, bind original source input before deriving labels:

```python
population = to_df('articles').rename(columns={'article_id': 'id'})
contract = analysis.current
contract.bind_population(population, id_column='id', source='articles',
                         source_id_column='article_id')
```

Omit `source_id_column` when unchanged. Derived labels or altered IDs are not source evidence. Fix unknown sources, missing columns, null/duplicate IDs and value mismatches; do not suppress errors or redefine the population as a subset.

After a semantic operation finishes, `contract.observe(batch)` uses retained execution evidence, not mutable `batch.rows`/`.summary`. Late binding needs the original input and then `.observe(batch)`; it does not re-run inference. Refreshes and failed cells invalidate evidence: rebuild binding after refresh and process again after failure (cache can avoid model calls). Use full-input resume; arbitrary batch unions cannot prove full coverage.

`operationCoverage` records last-operation counts; `coverage` verifies bound-population processing. Inspect `coverage.reason`. Unbound, stale, unmatched or over-limit evidence stays unknown. Fingerprinting supports 100,000 rows / 1,000,000 cells; semantic budgets also apply. SQL-only work needs no semantic operation.

# Check helpers

All helpers require `source=..., evidence=...`:

- `check_equal(name, observed, expected)`: supplied invariant.
- `check_granularity(name, values, pattern=...)`: full-match identifier shape.
- `check_coverage(name, total=..., covered=..., unresolved=0, unprocessed=0)`: supplied nonnegative counts, not automatic coverage evidence.
- `require_ready()` rejects missing claims, failed checks or no checks. `structurallyReady` validates supplied assertions, not business truth.

Show missing claims, unresolved rows and failed checks in the answer. No final gate: explain unsupported parts instead of querying repeatedly to turn a flag green.
