---
name: semantic-analysis
description: Stateful Python snapshots, resumable batch classification, extraction and conservative entity resolution.
---

# Workspace

Python variables and source snapshots persist while this chat's Worker is alive.
Exception: a tool explicitly described as stateless retains nothing between calls.
Omit sources to reuse; redeclare an alias to refresh, then recompute derived DataFrames.
Aliases are NOT variables: tables['t'] is a DuckDB relation; t_df = to_df('t') gives pandas.
reset=true clears state. result is removed BEFORE EVERY cell: retain reusable values
under other names, then assign result for output. A trailing expression is not output.
workspace_lost requires explicit rebuild. Ordinary exceptions may retain partial mutation.

# Batch semantics

Use semantics for meaning, not arithmetic, known date formats or exact joins.
These helpers live inside execute_python, not separate tools; synthetic pd.DataFrame
input needs no database. The host owns model, authorization, budgets and cache.
Only selected columns are sent. Required instructions define distinctions and ambiguity.

```python
batch = await semantic.classify(df, columns=['text'], required_fields=['text'],
    labels={'sports':'sports reporting', 'business':'business reporting'},
    instructions='Classify subject matter; leave ambiguous articles unresolved.')
result = batch.summary
```

semantic.extract(df, columns=[...], schema={...}, instructions='...') supports JSON
schema type, properties, required, items, enum, description, additionalProperties=false.
Types: object/array/string/number/integer/boolean/null. Other keywords fail before inference.
Do not invent dates or amounts. Distinguish proposals, approvals and payments; account
for units/periods and duplicate snapshots before aggregation.

Both accept required_fields=[...] and id_column='record_id'. Required fields must be
selected: instructions mentioning header cannot make it available when only text is sent.
This validates declared fields, not their semantic sufficiency. Never send extra private
columns just in case. id_column must be unique/non-null; it is not sent as data unless
selected. Default IDs are zero-based positional strings, NOT the DataFrame index.

.rows is a pandas DataFrame: use .rows.iloc[0], not .rows[0]. Iterate .to_records()
for dictionaries, not for row in batch.rows. Columns: id/status/value/evidence/error.
.summary: total/success/unresolved/failed/unprocessed/cached/reused/usage/complete,
preflight/stopReason. .require_complete() returns rows only if every row succeeded;
otherwise it raises. Unresolved/failed/unprocessed are NOT negatives or zero amounts.
Schema-valid success and quoted evidence do not certify meaning. Preserve ID mapping.
Oversized records fail, never truncate. Explicitly split and deduplicate extracted facts.

# Full intent and resume

Full coverage is default. Preflight checks total size against remaining record/request
budgets and a bounded cache probe before inference. Token cost is not guaranteed;
concurrent operations can consume capacity. A blocked preflight returns unprocessed rows.
For large cached jobs, retain/reuse the batch instead of reconstructing the full call.
allow_partial=True explicitly permits partial processing, NOT random sampling. Do not
enable it merely to bypass an insufficient budget on an exact-answer task, or extrapolate
from the processed head. Report the limitation or request an authorized budget increase.
All cells and retries share run budgets; exhaustion stops scheduling new batch RPCs.

To retry missing rows after recovery or an authorized new run budget, repeat the same
operation with resume=previous_batch and identical FULL input/order/IDs/instructions/
labels/schema/required fields. Successful and unresolved rows remain; only failed and
unprocessed rows are retried. Revisit unresolved meanings through a deliberate new
definition, not transport retry. Do not pass only a remainder or rewrite instructions
to 'raw JSON': that changes identity. Keep named batch objects, no artifact handoff.

# Entity resolution

links = await semantic.resolve(left, right=reference, columns=['name','country'],
blocking={'keys':['country']}, instructions='Match the same entity, not similar names.')
Omit right for deduplication. required_fields, resume and allow_partial also apply.
Blocking keys must be selected. Candidate normalization preserves digits; candidates
are deterministically ranked by token overlap and capped at 20 per record. Blocking is
declared scope, not proof of global coverage. Missing/truncated/contradictory candidates
remain unresolved. .rows pair IDs i:j refer to original positional IDs; .mapping holds
id/canonical_id/status/candidate_complete. Many-to-one reference matches are allowed,
ambiguous ones are not. Dedup groups require every within-group pair to agree and
outside candidates to differ: never infer A=C solely from A=B and B=C.

# Validation

Define neighboring label inclusion/exclusion rules; leave genuine ambiguity unresolved.
Test actual boundaries, units, namesakes and missing discriminators on development and
separate held-out samples. Higher reasoning or another model is an experiment, not
automatic escalation. Never inject benchmark truth into the running agent.
For population/grain/denominator/business-rule risks, load_skill name=analysis-verification.
