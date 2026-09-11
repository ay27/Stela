/** Local evidence bookkeeping, not an LLM reviewer or authority over business meaning. */
export const PYTHON_ANSWER_CONTRACT_SCRIPT = String.raw`
import re as _stela_contract_re
import weakref as _stela_contract_weakref
import hashlib as _stela_contract_hash

class _StelaAnswerContract:
    def __init__(self, required):
        allowed = {'population', 'metric', 'granularity', 'denominator', 'business_rule', 'time_range'}
        if not required or not set(required) <= allowed:
            raise ValueError('Declare relevant contract fields: ' + ', '.join(sorted(allowed)))
        self.required = list(dict.fromkeys(required))
        self.claims, self.checks = {}, {}

    def claim(self, field, value, *, source, evidence):
        if field not in self.required or not isinstance(value, str) or not value.strip():
            raise ValueError('Claim must name a required field and a nonempty meaning')
        self._evidence(source, evidence)
        claim = dict(value=value, source=source, evidence=evidence)
        if field in self.claims and self.claims[field] != claim:
            raise ValueError('Conflicting claim: create a revised contract explicitly, do not silently overwrite ' + field)
        self.claims[field] = claim
        return self

    def _evidence(self, source, evidence):
        if not all(isinstance(v, str) and v.strip() and len(v) <= 4000 for v in (source, evidence)):
            raise ValueError('Provide a source reference and bounded evidence; do not invent missing definitions')

    def check_equal(self, name, observed, expected, *, source, evidence):
        self._evidence(source, evidence)
        self.checks[name] = dict(passed=bool(observed == expected), observed=observed, expected=expected, source=source, evidence=evidence)
        return self

    def check_coverage(self, name, *, total, covered, unresolved=0, unprocessed=0, source, evidence):
        values = (total, covered, unresolved, unprocessed)
        if any(type(v) is not int or v < 0 for v in values) or covered + unresolved + unprocessed > total:
            raise ValueError('Coverage requires consistent nonnegative integer counts for the declared population')
        self._evidence(source, evidence)
        self.checks[name] = dict(passed=covered == total and unresolved == 0 and unprocessed == 0,
            total=total, covered=covered, unresolved=unresolved, unprocessed=unprocessed, source=source, evidence=evidence)
        return self

    def check_granularity(self, name, values, *, pattern, source, evidence):
        self._evidence(source, evidence)
        mismatches = [str(v) for v in values if not _stela_contract_re.fullmatch(pattern, str(v))]
        self.checks[name] = dict(passed=not mismatches, mismatches=mismatches[:20], pattern=pattern, source=source, evidence=evidence)
        return self

    def report(self):
        missing = [f for f in self.required if f not in self.claims]
        failed = [name for name, check in self.checks.items() if not check['passed']]
        observations = {}
        if _stela_contract_context().get('automaticContracts'):
            observations['coverage'] = _stela_current_coverage(self)
            if hasattr(self, '_operation_coverage'):
                observations['operationCoverage'] = dict(self._operation_coverage)
        return dict(claims=self.claims, checks=self.checks, unresolved=missing, failedChecks=failed, **observations,
            structurallyReady=not missing and not failed and bool(self.checks),
            caveat='Checks validate supplied observations, not business truth or completeness of an already filtered source.')

    def require_ready(self):
        report = self.report()
        if not report['structurallyReady']:
            raise ValueError('Answer contract has missing claims, failed checks or no verification: ' + str(report))
        return report

    def bind_population(self, df, *, id_column, source, source_id_column=None):
        try:
            return self._bind_population(df, id_column=id_column, source=source, source_id_column=source_id_column)
        except ValueError:
            self._coverage = _stela_unknown_coverage(self, 'binding_failed')
            raise

    def _bind_population(self, df, *, id_column, source, source_id_column):
        if not _stela_contract_context().get('automaticContracts'):
            raise ValueError('Automatic analysis contracts experiment is disabled')
        if hasattr(self, '_binding'):
            raise ValueError('Population is frozen; create an explicit revised contract to change it')
        workspace = globals()['__stela_workspace']
        match = next((s for s in workspace['sources'].values() if source in (s['alias'], s['version'])), None)
        if match is None:
            aliases = ', '.join(str(a)[:80] for a in list(workspace['sources'])[:16])
            raise ValueError('population_source_unknown: use an existing source alias or run ID. Available aliases: ' + aliases)
        source_id = source_id_column if source_id_column is not None else id_column
        rows = _stela_fingerprints(df, id_column)
        # Bound before converting a large relation to pandas.
        if match['rowCount'] > 100000 or match['rowCount'] * len(workspace['tables'][match['alias']].columns) > 1000000:
            raise ValueError('verification_limit: source exceeds 100000 rows or 1000000 cells')
        original_df = workspace['tables'][match['alias']].df()
        original = _stela_fingerprints(original_df, source_id)
        # Only the explicitly mapped identity column may have a different name.
        if source_id != id_column:
            if id_column in original_df.columns:
                raise ValueError('population_id_mapping_conflict: target ID column already exists in source')
            original = {k: {(id_column if c == source_id else c): v for c, v in row.items()} for k, row in original.items()}
        if not _stela_related(rows, original):
            raise ValueError('population_values_mismatch: bind original input columns whose values match the source; derived labels and changed IDs are not source evidence')
        self._binding = dict(rows=rows, id_column=id_column, source=match['version'], alias=match['alias'],
            full=len(rows)==len(original) and not match.get('incomplete'))
        self._coverage = _stela_unknown_coverage(self, 'no_operation')
        self._coverage_epoch = _stela_analysis_state()['epoch']
        return self

    def observe(self, batch):
        if not _stela_contract_context().get('automaticContracts'):
            raise ValueError('Automatic analysis contracts experiment is disabled')
        try:
            record = _stela_analysis_state()['operations'].get(batch)
        except TypeError:
            record = None
        if record is None:
            self._coverage = _stela_unknown_coverage(self, 'operation_unavailable')
            raise ValueError('operation_unavailable: use a semantic result from this run and workspace, not a copied DataFrame or fabricated summary')
        _stela_apply_operation(self, record)
        return self

class _StelaAnalysis:
    @property
    def current(self):
        if not _stela_contract_context().get('automaticContracts'):
            raise ValueError('Automatic analysis contracts experiment is disabled')
        return _stela_current_contract()

    def contract(self, *, required):
        contract = _StelaAnswerContract(required)
        return _stela_register_contract(contract) if _stela_contract_context().get('automaticContracts') else contract

    def history(self):
        return _stela_copy.deepcopy(_stela_analysis_state()['previous'])

def _stela_contract_context():
    return json.loads(globals().get('__stela_analysis_context', '{}'))

def _stela_source(source, evidence=''):
    context = _stela_contract_context()
    if source == 'question':
        return bool(evidence and evidence in context.get('question', ''))
    return any(source in (s['alias'], s['version']) for s in globals().get('__stela_workspace', {}).get('sources', {}).values())

def _stela_json_equal(left, right):
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(right, sort_keys=True, ensure_ascii=False)

def _stela_fingerprints(df, id_column):
    if not isinstance(df, pd.DataFrame) or not df.columns.is_unique:
        raise ValueError('population_columns_invalid: bind a DataFrame with unique columns')
    if len(df) > 100000 or df.size > 1000000:
        raise ValueError('verification_limit: at most 100000 rows and 1000000 cells can be verified')
    if id_column is None or id_column not in df.columns:
        columns = ', '.join(str(c)[:80] for c in list(df.columns)[:16])
        raise ValueError('population_id_column_missing: supply id_column and, if renamed, source_id_column. Available columns: ' + columns)
    ids = df[id_column]
    if ids.isna().any():
        raise ValueError('population_id_null: identity must be non-null')
    if not ids.is_unique:
        raise ValueError('population_id_duplicate: identity must be unique')
    values = _stela_exact_json_frame(df)
    keys = [json.dumps(v, sort_keys=True, ensure_ascii=False) for v in ids.tolist()]
    # Hash each cell independently so verified projections remain possible without retaining text.
    return {key: {c: _stela_contract_hash.sha256(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                  for c, v in row.items()} for key, row in zip(keys, values)}

def _stela_related(rows, original):
    return all(k in original and all(c in original[k] and original[k][c] == v for c, v in row.items()) for k, row in rows.items())

def _stela_unknown_coverage(contract, reason):
    binding = getattr(contract, '_binding', None)
    total = len(binding['rows']) if binding else None
    return dict(state='unknown', total=total, processed=0, unresolved=0,
        unprocessed=total or 0, source=binding['source'] if binding else None, reason=reason)

def _stela_analysis_state():
    workspace = globals().get('__stela_workspace', {})
    config = _stela_contract_context()
    state = workspace.get('analysis_state')
    if state is None or state['runId'] != config.get('runId', ''):
        state = dict(runId=config.get('runId', ''), current=None, previous=[], version=0, epoch=0, operations=_stela_contract_weakref.WeakKeyDictionary())
        workspace['analysis_state'] = state
    return state

def _stela_register_contract(contract):
    state = _stela_analysis_state()
    if state['current'] is not None:
        # Historical observations are bounded and remain distinct from the new population.
        state['previous'].append(_stela_analysis_snapshot())
        state['previous'] = state['previous'][-16:]
    state['version'] += 1
    state['current'] = contract
    return contract

def _stela_current_contract():
    state = _stela_analysis_state()
    if state['current'] is None:
        _stela_register_contract(_StelaAnswerContract(['population', 'metric', 'granularity']))
    return state['current']

def _stela_apply_operation(contract, record):
    state = _stela_analysis_state()
    binding = getattr(contract, '_binding', None)
    contract._operation_coverage = dict(record['counts'])
    contract._coverage_epoch = record['epoch']
    reason = record['reason']
    if record['epoch'] != state['epoch']:
        reason = 'execution_failed'
    elif binding is None:
        reason = reason or 'population_unbound'
    else:
        source = globals()['__stela_workspace']['sources'].get(binding['alias'], {})
        if source.get('version') != binding['source'] or record['sources'].get(binding['alias']) != binding['source']:
            reason = 'source_changed'
        elif not reason and (record['id_column'] != binding['id_column'] or not _stela_related(record['rows'], binding['rows'])):
            reason = 'identity_mismatch'
    if reason:
        contract._coverage = _stela_unknown_coverage(contract, reason)
        return
    counts = record['counts']
    total = len(binding['rows'])
    full = len(record['rows']) == total and counts['success'] == total and binding['full']
    contract._coverage = dict(state='full' if full else 'subset', total=total,
        processed=counts['success'], unresolved=counts['unresolved'],
        unprocessed=total-counts['success']-counts['unresolved'], source=binding['source'],
        reason='verified' if full else 'partial_coverage')

def _stela_observe_semantic(df, id_column, output):
    if not _stela_contract_context().get('automaticContracts'):
        return
    state = _stela_analysis_state()
    # Called synchronously before returning a result to user code. Later edits to rows/summary
    # cannot change this independent execution observation.
    counts = {key: output.summary[key] for key in ('total', 'success', 'unresolved', 'failed', 'unprocessed')}
    rows, reason = None, None
    try:
        rows = _stela_fingerprints(df, id_column)
    except ValueError as error:
        reason = 'verification_limit' if str(error).startswith('verification_limit') else 'identity_mismatch'
    record = dict(rows=rows, reason=reason, counts=counts, epoch=state['epoch'], id_column=id_column,
        sources={a:s['version'] for a,s in globals()['__stela_workspace']['sources'].items()})
    state['operations'][output] = record
    _stela_apply_operation(_stela_current_contract(), record)

def _stela_current_coverage(contract):
    coverage = dict(getattr(contract, '_coverage', _stela_unknown_coverage(contract, 'no_operation')))
    binding = getattr(contract, '_binding', None)
    if getattr(contract, '_coverage_epoch', _stela_analysis_state()['epoch']) != _stela_analysis_state()['epoch']:
        coverage = _stela_unknown_coverage(contract, 'execution_failed')
    elif binding is not None and globals()['__stela_workspace']['sources'].get(binding['alias'], {}).get('version') != binding['source']:
        coverage = _stela_unknown_coverage(contract, 'source_changed')
    contract._coverage = coverage
    return coverage

def _stela_analysis_snapshot(status='observed'):
    if not _stela_contract_context().get('automaticContracts'):
        return None
    state = _stela_analysis_state()
    contract = _stela_current_contract()
    sources = list(globals()['__stela_workspace']['sources'].values())
    missing = [f for f in contract.required if f not in contract.claims]
    failed = [str(n)[:128] for n, c in contract.checks.items() if not c['passed']]
    coverage = _stela_current_coverage(contract)
    if status != 'observed':
        state['epoch'] += 1
        coverage = _stela_unknown_coverage(contract, 'workspace_lost' if status == 'lost' else 'execution_failed')
        contract._coverage = coverage
    return dict(runId=state['runId'][:256], version=state['version'], generation=globals()['__stela_workspace']['generation'][:128],
        status=status, missingClaims=missing, failedChecks=failed[:20],
        claims=[dict(field=f, value=str(c['value'])[:500], source=c['source'][:256], evidence=c['evidence'][:500],
            sourceResolved=_stela_source(c['source'], c['evidence'])) for f, c in contract.claims.items()][:6],
        checks=[dict(name=str(n)[:128], passed=bool(c['passed']), sourceResolved=_stela_source(c['source'], c['evidence'])) for n, c in list(contract.checks.items())[:20]],
        sources=[dict(ref=s['version'][:256], rowCount=s['rowCount'], incomplete=s.get('incomplete', False)) for s in sources[:16]],
        coverage=coverage,
        **({'operationCoverage': dict(contract._operation_coverage)} if hasattr(contract, '_operation_coverage') else {}),
        previousVersions=state['version']-1, truncated=len(sources)>16 or len(contract.checks)>20)


def _stela_safe_analysis_snapshot(status='observed'):
    try:
        return _stela_analysis_snapshot(status)
    except Exception:
        # Bookkeeping must never hide the cell's actual error or turn success into failure.
        config = _stela_contract_context()
        return dict(runId=config.get('runId', '')[:256], version=0,
            generation=globals().get('__stela_workspace', {}).get('generation', '')[:128], status=status,
            missingClaims=['population', 'metric', 'granularity'], failedChecks=['snapshot_unavailable'], claims=[], checks=[], sources=[],
            coverage=dict(state='unknown', total=None, processed=0, unresolved=0, unprocessed=0, source=None, reason='snapshot_unavailable'), previousVersions=0, truncated=True)
`;
