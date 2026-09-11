---
name: analysis-verification
description: Sourced answer contracts and targeted coverage, granularity, denominator and business-rule verification in Python.
---

# When to use

Use when a material population, granularity, denominator, period or business-rule
ambiguity can change the answer. Skip trivial arithmetic and routine bookkeeping.
This is local Python in the existing workspace: no extra planner, reviewer or inference.

# Sourced contract

analysis.contract(required=[...]) supports population, metric, granularity,
denominator, business_rule, time_range. Only require relevant fields.

```python
contract = analysis.contract(required=['population','denominator'])
contract.claim('population', population_definition,
    source=actual_source_reference, evidence=actual_scope_quote)
contract.claim('denominator', denominator_definition,
    source=actual_source_reference, evidence=actual_ratio_quote)
contract.check_coverage('classification', total=len(full_input),
    covered=batch.summary['success'], unresolved=batch.summary['unresolved'],
    unprocessed=batch.summary['unprocessed'],
    source=source_query_reference, evidence=source_scope_description)
result = contract.report()
```

Replace variables with actual observations/references, not invented definitions.
Missing claims remain unresolved; conflicting claims cannot silently overwrite.
Keep the contract variable for following cells; result is only the current cell output.

# Automatic evidence (when enabled)

`analysis.current` already exists. Define relevant meanings with `.claim(...)`;
there is no `analysis.claim()` or `.summary()` API. Use `.report()` for local output.
Source references are registered query aliases/run IDs, or `source='question'`
with an exact excerpt. An arbitrary Python result run ID is not a query source.

Bind the original input before deriving labels. When input ID names differ from
source column names, state the mapping explicitly; ID values must still match:

```python
population = to_df('articles').rename(columns={'article_id': 'id'})
contract = analysis.current
contract.bind_population(population, id_column='id', source='articles',
                         source_id_column='article_id')
batch = await semantic.classify(population, columns=['text'], id_column='id',
    labels={'sports': 'sports reporting', 'other': 'other reporting'},
    instructions='Classify the subject; keep ambiguous items unresolved.')
result = contract.report()
```

Omit `source_id_column` when unchanged. Binding checks the original input values;
derived label/output columns are not source evidence. Errors identify unknown
sources, missing columns, null/duplicate IDs or mismatched values. Fix these causes
rather than suppressing errors or changing the declared population to a subset.

If the operation was completed before binding, bind the original input and call
`contract.observe(batch)`. This uses the saved execution record without inference;
it does not trust edits to `batch.rows` or `batch.summary`. Source refresh or a failed
cell invalidates old evidence. Rebuild/revise the binding after refresh, and perform
new processing after a failed cell (existing semantic cache can still avoid calls).
Do not combine arbitrary batches into a claimed full population; use the existing
full-input resume contract instead.

Automatic snapshots and `.report()` distinguish `operationCoverage` (last recorded
operation counts) from `coverage` (verified processing of the bound population).
Inspect `coverage.reason`: unbound, stale, unmatched and verification-limit cases
remain unknown. No semantic operation is required for SQL-only work. A supplied
`check_coverage()` is a model-authored check, not automatic execution coverage.
At most 100,000 rows / 1,000,000 cells are fingerprinted per result; larger inputs
cannot prove population coverage. Existing semantic input limits still apply.
Keep missing claims, unresolved rows and failed checks visible in the final delivery;
there is no additional model review or final-answer gate.

# Checks

check_equal(name, observed, expected, source=..., evidence=...) checks a supplied invariant.
check_granularity(name, values, pattern=..., source=..., evidence=...) full-matches
identifier shape against the requested level, not the most detailed available level.
check_coverage(name, total=..., covered=..., unresolved=0, unprocessed=0,
source=..., evidence=...) requires consistent nonnegative integer counts.
require_ready() rejects missing claims, failed checks or no checks. structurallyReady
does NOT certify business truth. Checks validate supplied observations, not the
truth of model-authored assertions. It is not a final-answer gate: explain unsupported
parts instead of repeatedly querying merely to make the flag true.

# Select the relevant risk

- Coverage must address the requested population BEFORE heuristic filtering. A city
  regex matching one spelling does not establish coverage of all location mentions.
  Inspect plausible unmatched variants only when they can change the answer.
- A ratio needs the requested denominator, including unresolved labels when applicable;
  incomplete classifications cannot silently become negatives.
- A hierarchy task needs the requested level; projecting to a subclass may require
  aggregation/deduplication and the corresponding title, not a subgroup title.
- Business policy selection needs applicable terms and their effective conditions;
  installation volume or timing correlations do not establish policy eligibility.
- Conflicting sources need explicit clarification or a discriminating fact. A query
  showing data distribution cannot decide what the user means by revenue.
- A successful parser, query, schema check or quotation cannot prove semantic correctness.

Do not add a second model review to every task. Test uncertain semantic boundaries
against held-out labeled samples separately from the agent's runtime context.
