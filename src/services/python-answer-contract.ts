/** Local evidence bookkeeping, not an LLM reviewer or authority over business meaning. */
export const PYTHON_ANSWER_CONTRACT_SCRIPT = String.raw`
import re as _stela_contract_re

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
        return dict(claims=self.claims, checks=self.checks, unresolved=missing, failedChecks=failed,
            structurallyReady=not missing and not failed and bool(self.checks),
            caveat='Checks validate supplied observations, not business truth or completeness of an already filtered source.')

    def require_ready(self):
        report = self.report()
        if not report['structurallyReady']:
            raise ValueError('Answer contract has missing claims, failed checks or no verification: ' + str(report))
        return report

    def bind_population(self, df, *, id_column, source):
        if not _stela_contract_context().get('automaticContracts'):
            raise ValueError('Automatic analysis contracts experiment is disabled')
        if hasattr(self, '_binding'):
            raise ValueError('Population is frozen; create an explicit revised contract to change it')
        workspace = globals()['__stela_workspace']
        match = next((s for s in workspace['sources'].values() if source in (s['alias'], s['version'])), None)
        if match is None:
            raise ValueError('Population source must resolve to an existing alias or run ID')
        rows = _stela_fingerprints(df, id_column)
        original = _stela_fingerprints(workspace['tables'][match['alias']].df(), id_column)
        related = all(k in original and all(c in original[k] and _stela_json_equal(original[k][c], v) for c, v in row.items()) for k, row in rows.items())
        if not related:
            raise ValueError('Population values do not match the referenced source')
        self._binding = dict(rows=rows, id_column=id_column, source=match['version'], alias=match['alias'],
            full=len(rows)==len(original) and not match.get('incomplete'))
        self._coverage = dict(state='unknown', total=len(rows), processed=0, unresolved=0, unprocessed=len(rows), source=match['version'])
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
    if not isinstance(df, pd.DataFrame) or len(df) > 100000 or not df.columns.is_unique:
        raise ValueError('Bind a DataFrame of at most 100000 rows with unique columns')
    ids = df[id_column] if id_column is not None else pd.Series(df.index, index=df.index)
    if ids.isna().any() or not ids.is_unique:
        raise ValueError('Population identity must be non-null and unique')
    # Preserve the frozen full row: changes to selected context cannot claim old lineage.
    values = _stela_exact_json_frame(df)
    keys = [json.dumps(v, sort_keys=True, ensure_ascii=False) for v in ids.tolist()]
    return {key: row for key, row in zip(keys, values)}

def _stela_analysis_state():
    workspace = globals().get('__stela_workspace', {})
    config = _stela_contract_context()
    state = workspace.get('analysis_state')
    if state is None or state['runId'] != config.get('runId', ''):
        state = dict(runId=config.get('runId', ''), current=None, previous=[], version=0)
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

def _stela_observe_semantic(df, id_column, output):
    if not _stela_contract_context().get('automaticContracts'):
        return
    contract = _stela_current_contract()
    binding = getattr(contract, '_binding', None)
    if binding is None:
        contract._coverage = dict(state='unknown', total=None, processed=output.summary['success'],
            unresolved=output.summary['unresolved'], unprocessed=output.summary['unprocessed'] + output.summary['failed'], source=None)
        return
    coverage = dict(state='unknown', total=len(binding['rows']), processed=0, unresolved=0,
        unprocessed=len(binding['rows']), source=binding['source'])
    try:
        observed = _stela_fingerprints(df, binding['id_column'])
        # Verify values, not pandas attrs (which propagate to unrelated frames).
        related = all(k in binding['rows'] and all(c in binding['rows'][k] and _stela_json_equal(binding['rows'][k][c], v) for c, v in row.items()) for k, row in observed.items())
        current_source = globals()['__stela_workspace']['sources'].get(binding['alias'], {})
        if not related or current_source.get('version') != binding['source']:
            contract._coverage = coverage
            return
        coverage.update(processed=output.summary['success'], unresolved=output.summary['unresolved'],
            unprocessed=len(binding['rows'])-output.summary['success']-output.summary['unresolved'])
        coverage['state'] = 'full' if (len(observed) == len(binding['rows']) and output.summary['complete'] and binding['full']) else 'subset'
    except Exception:
        pass
    contract._coverage = coverage

def _stela_analysis_snapshot(status='observed'):
    if not _stela_contract_context().get('automaticContracts'):
        return None
    state = _stela_analysis_state()
    contract = _stela_current_contract()
    sources = list(globals()['__stela_workspace']['sources'].values())
    missing = [f for f in contract.required if f not in contract.claims]
    failed = [str(n)[:128] for n, c in contract.checks.items() if not c['passed']]
    coverage = dict(getattr(contract, '_coverage', dict(state='unknown', total=None, processed=0, unresolved=0, unprocessed=0, source=None)))
    binding = getattr(contract, '_binding', None)
    if status != 'observed' or (binding is not None and globals()['__stela_workspace']['sources'].get(binding['alias'], {}).get('version') != binding['source']):
        coverage['state'] = 'unknown'
    return dict(runId=state['runId'][:256], version=state['version'], generation=globals()['__stela_workspace']['generation'][:128],
        status=status, missingClaims=missing, failedChecks=failed[:20],
        claims=[dict(field=f, value=str(c['value'])[:500], source=c['source'][:256], evidence=c['evidence'][:500],
            sourceResolved=_stela_source(c['source'], c['evidence'])) for f, c in contract.claims.items()][:6],
        checks=[dict(name=str(n)[:128], passed=bool(c['passed']), sourceResolved=_stela_source(c['source'], c['evidence'])) for n, c in list(contract.checks.items())[:20]],
        sources=[dict(ref=s['version'][:256], rowCount=s['rowCount'], incomplete=s.get('incomplete', False)) for s in sources[:16]],
        coverage=coverage,
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
            coverage=dict(state='unknown', total=None, processed=0, unresolved=0, unprocessed=0, source=None), previousVersions=0, truncated=True)
`;
