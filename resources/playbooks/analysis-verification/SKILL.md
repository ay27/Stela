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
