---
name: analysis-verification
description: Targeted candidate, grain, identity and relationship-direction checks; sourced answer contracts and coverage verification in Python.
---

# When to use

For material scope, grain, denominator, time or business-rule risks, including SQL-only work. Reuse evidence; query unresolved distinctions. Skip trivial arithmetic. No extra reviewer or inference.

# Conditional decision checks

Apply only relevant checks that can change the answer.

- Candidate exclusion: when a name/keyword filter rejects an item with supporting attribute/text evidence, compare the exclusion with the requested business definition. Apply one supported rule across candidates; uncertain membership stays unresolved, not negative.
- Grouping grain: when code/name choices change groups, inspect their mapping against the requested level. Many-to-one names can merge groups. A qualifier removing no rows warrants investigation, not an automatic column change. Aggregate at the supported level, not always the finest code.
- Identity conflict: preserve raw IDs and inspect collisions when normalization/fuzzy matches compete with exact IDs. Prefixes may carry identity. Prefer exact matches within the same namespace unless source evidence supports another mapping; similarity alone cannot override them.
- Relationship direction: label both endpoints and bind the requested attribute to the appropriate endpoint. Trace an available joined row from source ID to target ID to attribute; the opposite endpoint answers a different question.
- Coverage: check the requested population before heuristic filtering. A regex for one spelling cannot prove coverage of all mentions. Inspect unmatched variants when they can affect the answer.
- Ratios need the requested denominator, including unresolved labels when applicable. Hierarchy changes may require aggregation/deduplication and the corresponding title.
- Policies need applicable terms and effective conditions; correlations cannot prove eligibility. Resolve conflicting sources with a discriminating fact or clarification.

Recompute after changing decisions; explain unresolved impacts. Successful queries/checks cannot prove meaning. Test semantic boundaries against held-out labels outside runtime context.

# Sourced contract

`analysis.contract(required=[...])` supports population, metric, granularity, denominator, business_rule, time_range. Require only relevant fields. With automatic evidence enabled, `analysis.current` already exists. There is no `analysis.claim()` or `.summary()` API.

```python
contract = analysis.current
contract.claim('population', population_definition,
    source='question', evidence=exact_question_excerpt)
contract.claim('denominator', denominator_definition,
    source=query_alias, evidence=observed_scope)
contract.check_coverage('classification', total=len(full_input),
    covered=batch.summary['success'], unresolved=batch.summary['unresolved'],
    unprocessed=batch.summary['unprocessed'],
    source=query_alias, evidence=observed_scope)
result = contract.report()
```

Without automatic evidence, create `analysis.contract(required=['population','denominator'])`. Use actual observations. Sources: query aliases/run IDs or `source='question'` with exact excerpts, not arbitrary Python result IDs. Missing claims stay unresolved; conflicts cannot silently overwrite. Retain the contract across cells; `result` is current output only.

# Binding execution evidence

Bind source input before deriving labels. Renamed ID columns need an explicit mapping; values must still match:

```python
population = to_df('articles').rename(columns={'article_id': 'id'})
contract = analysis.current
contract.bind_population(population, id_column='id', source='articles',
                         source_id_column='article_id')
batch = await semantic.classify(population, columns=['text'], id_column='id',
    labels={'sports': 'sports reporting', 'other': 'other reporting'},
    instructions='Classify subject; keep ambiguous items unresolved.')
result = contract.report()
```

Omit `source_id_column` when unchanged. Derived outputs are not source evidence. Fix unknown sources, missing columns, null/duplicate IDs and value mismatches; do not suppress errors or redefine the population as a subset.

For an operation completed before binding, bind its original input then call `contract.observe(batch)`. This uses saved execution evidence without inference, not mutable `batch.rows`/`.summary`. Source refresh or failed cells invalidate evidence: rebuild binding after refresh and process again after failure (semantic cache can avoid new calls). Use full-input resume; arbitrary batch unions cannot prove full coverage.

Snapshots/`.report()`: `operationCoverage` records last operation counts; `coverage` verifies bound-population processing. Inspect `coverage.reason`: unbound, stale, unmatched or over-limit evidence stays unknown. Fingerprinting supports 100,000 rows / 1,000,000 cells per result. Larger inputs cannot prove coverage; semantic limits also apply. SQL-only work needs no semantic operation. `check_coverage()` is model-authored, not automatic evidence.

# Check helpers

- `check_equal(name, observed, expected, source=..., evidence=...)`: supplied invariant.
- `check_granularity(name, values, pattern=..., source=..., evidence=...)`: full-match identifier shape at the requested level.
- `check_coverage(name, total=..., covered=..., unresolved=0, unprocessed=0, source=..., evidence=...)`: consistent nonnegative counts.
- `require_ready()` rejects missing claims, failed checks or no checks. `structurallyReady` validates supplied assertions, not business truth.

Keep missing claims, unresolved rows and failed checks visible in the final answer. No final-answer gate: explain unsupported parts instead of repeatedly querying to turn a flag green.
