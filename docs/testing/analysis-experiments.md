# Semantic cost and automatic evidence experiments

Status: implemented, opt-in. Decisions: [ADR-0097](../adr/0097-semantic-input-reduction-and-cost-probe.md),
[ADR-0098](../adr/0098-automatic-observational-analysis-contracts.md).

## Enablement

Settings → AI → Batch semantic analysis has two independent switches, both off by
default. Neither changes the selected model, grant, budget, strategy-review setting,
scorer or final-answer policy. Existing workspace caches remain local and ephemeral.

The DAB equivalents are `--semantic-optimization` and `--analysis-contracts`.
Semantic execution still requires the existing `--allow-semantic-transmission`.
Both flags are included in `manifest.runtimeConditions` and checked on resume.
A build/source change also changes the source fingerprint: use separate output
folders, never resume old runs across a code or feature change.

For a paired comparison, reuse the exact existing command, model, hints setting,
case set, budgets, timeouts and concurrency. Set `--runs 1` explicitly if one full
round is intended (the runner defaults to three). Run:

| Arm | Additional experiment flags |
| --- | --- |
| Baseline | none |
| Semantic cost only | `--semantic-optimization` |
| Both features | `--semantic-optimization --analysis-contracts` |

Do not infer improvement from contract creation or invocation counts. Compare valid
answers, per-case gains/losses, original-row coverage, child inference usage,
unknown usage, budget stops, wall time, and final result shape. The same-model
implementation alone is not evidence that benchmark accuracy improved.

## Semantic operation

Classify/extract first reduce exact selected JSON content, retaining case, digits,
prefixes, JSON types, full floating-point values and every selected context field.
Unsupported values must be converted explicitly; missing values become JSON null
and dates use ISO strings. Include distinguishing context in
`columns`; selecting an ID as semantic content prevents otherwise identical rows
from merging. Returned rows preserve each original row ID. Resolve is unchanged.

Every unique cache key is checked locally before inference. `summary.preflight`
records original/unique/deduplicated/reused/pending row counts, unique input bytes,
planned requests and a conservative token reservation. Requests are packed at eight
rows / 24,000 bytes; counts and estimates exclude possible execution repair retries.
Python schedules optimized batches sequentially so a stop prevents later dispatch.
This may trade throughput for predictable stopping; evaluate elapsed time too.

Known record/request deficits stop before inference. If full token reservations do
not fit, one real-work pilot may run: at most eight rows, one attempt, and reservation
at most 10% of remaining run tokens. Successful and unresolved pilot rows are reused.
`summary.pilot` and `forecastTokens` describe measured usage and the remaining
reservation-weighted estimate (1.5 factor, capped at the reservation bound).
Missing usage (including provider SDK zero defaults), a failed pilot, or an unaffordable forecast stops scheduling. Repeating
the same operation does not buy another pilot. Host checks remain authoritative on
every request, including repairs and cancellations. These are token estimates,
not prices or completion promises. `allow_partial=True` does not bypass a known
whole-operation deficit in the optimized path and never grants sampling permission.

Use deterministic SQL, parsing and declared rules first. Unmatched/failed/unprocessed
text is unknown, never an automatic negative label. Partial output cannot be
extrapolated to the population without a separate authorized statistical design.

## Automatic contract

The first data tool creates a host observation even if no Python helper is called.
SQL-only queries return source facts with unknown population coverage; a truncated
chat preview is recorded separately from a known incomplete source. Python retains
`analysis.current` within a run and automatically emits bounded observations on
success and ordinary exceptions. No reviewer or final gate is added.

```python
population = to_df('articles')
contract = analysis.current
contract.claim('population', 'all articles in the declared source',
               source='question', evidence='every article')  # exact request excerpt
contract.bind_population(population, id_column='id', source='articles')
output = await semantic.classify(
    population, columns=['title', 'body'], id_column='id',
    labels={'sports': 'sports reporting', 'other': 'other topics'},
    instructions='Classify the article subject using the selected title and body')
result = output.summary
```

A source reference resolves only to an existing source alias/run ID or an exact
excerpt of the original question. Resolution does not establish that a meaning or
check is correct. Snapshots separate model-authored claims/checks from source facts
and observed execution coverage; `structurallyReady` is never displayed as accuracy.

Binding freezes typed IDs and per-cell value fingerprints against the referenced
source, up to 100,000 rows and 1,000,000 cells. A later subset cannot shrink that population. Binding an already filtered
subset also cannot establish full coverage of its source. Arbitrary DataFrames have
unknown lineage; there is no implicit business-scope inference. Source refresh,
failed cells and workspace loss cannot certify current coverage. This records the
latest semantic operation against the binding, not a union of independently chosen
subsets. Explicit `analysis.contract(required=[...])` creates a revision;
`analysis.history()` retains up to 16 previous bounded snapshots. Worker reset
starts a new generation; prior tool history remains historical evidence.

Snapshots cap claims at six, checks at 20 and sources at 16; IDs/data used to verify
population bindings stay in Python and are not placed in chat. Truncation is explicit.
The existing tool-result timeline summary preserves the structured snapshot alongside
a short preview, so live/history tool cards and the final-answer area can display
missing definitions, failed checks, unresolved references and coverage. This is an
observation, never an answer certificate.

## Validation

- `npm run test:analysis-experiments`: settings IPC/persistence, evidence-card rendering,
  real Pyodide + fake completion, 10,000 original
  rows / 100 unique inputs / 10,000 returned IDs, whole-cache reuse, model identity,
  literal content, pilot bounds/stops, 14,860→989 subset coverage, refresh, errors,
  revisions/reset, DTO validation and lossless evidence summaries.
- `npm run test:semantic-workflow`: actual tool → main broker → Pyodide → semantic
  service → simulated provider; verifies context/snapshots across the desktop boundary.
- `npm run test:semantic`: legacy behavior and host pilot retry/cancellation limits.
- Agent tool tests cover automatic SQL-only observations and error delivery.
- DAB runner integration uses a local mock provider to check both manifest flags;
  no paid benchmark is launched by these tests.

Desktop acceptance: enable either switch independently, reopen Settings to verify
persistence, run a query/Python task, inspect collapsed and expanded tool cards, then
reopen history and inspect the final evidence card. A failing cell must retain its
original error. Reset/refresh must not present old coverage as current. This UI
interaction checklist is separate from the automated checks above.

## Contract repair and late observation (ADR-0099)

`bind_population(df, id_column=..., source=..., source_id_column=None)` explicitly
maps a renamed identity column. Source ID values are not normalized. Unknown aliases,
missing ID columns, null/duplicate IDs and differing values produce actionable errors.
Bind source input columns; adding derived labels does not make them source evidence.

`contract.observe(batch)` connects an existing classify/extract result to the binding.
A weak registry holds independent execution counts, typed IDs, per-cell fingerprints,
source versions and a failure epoch. Public rows/summary edits do not rewrite those
observations. No inference is added. This is correctness bookkeeping within the
sandbox, not a security boundary against malicious Python introspection.

Late observation requires matching current run/workspace/source/failure epoch. Failed
cells invalidate old operations persistently; a subsequent unrelated successful cell
cannot restore full coverage. Failures before entering the worker propagate through
trusted `invalidateEvidence` context on the next request. Source refresh requires a
revised binding and a fresh operation. Separate operations are never automatically
unioned. The normal semantic cache/resume behavior is unchanged.

Snapshots add optional `operationCoverage` counts and a `coverage.reason` enum,
retained in timeline summaries, final cards and history. Missing fields in legacy
snapshots remain valid. Counts describe the last recorded operation even when its
population coverage has since become invalid. SQL-only tasks can have `no_operation`;
this is not an analytical failure. Verification-limited inputs retain counts only;
the existing maximum semantic input size is unchanged. Do not use the number of
`full` snapshots or API calls as an accuracy metric.

The analysis-experiment regression test exercises renamed AGNews IDs, late binding,
mutated previews, failed cells, host-side failure invalidation, cross-run attempts,
source refresh, partial inputs and verification limits using real Pyodide and mocked
inference. No evaluation answers are used as runtime inputs.
