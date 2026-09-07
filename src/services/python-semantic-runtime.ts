/** Shared by desktop and headless. No provider SDK or credentials in Python. */
export const PYTHON_SEMANTIC_SCRIPT = String.raw`
import unicodedata as _stela_unicode
import asyncio as _stela_asyncio
import hashlib as _stela_hashlib
import copy as _stela_copy

class _StelaSemanticResult:
    def __init__(self, rows, summary, mapping=None, signature=None, identity=None):
        self.rows = pd.DataFrame(rows, columns=['id', 'status', 'value', 'evidence', 'error'])
        self.summary = summary
        self.mapping = mapping
        self._signature = signature
        self._identity = identity
        self._resume_rows = _stela_copy.deepcopy(rows)

    def to_records(self):
        return _stela_copy.deepcopy(self.rows.to_dict('records'))

    def require_complete(self):
        if not self.summary['complete']:
            raise ValueError('Incomplete semantic evidence: inspect summary; failed, unresolved and unprocessed rows are not zero or negative labels')
        return self.rows

class _StelaSemantic:
    async def _run(self, records, operation, instructions, *, resume=None, allow_partial=False, **options):
        if not isinstance(instructions, str) or not instructions.strip():
            raise ValueError('Explicit semantic instructions are required')
        signature = _stela_hashlib.sha256(json.dumps([operation, instructions, options, records],
            sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        retained = []
        if resume is not None:
            # Helper classes are rebound each cell; retained instances belong to the old class.
            if type(resume).__name__ != '_StelaSemanticResult' or resume._signature != signature:
                raise ValueError('Resume requires identical full input, row IDs and semantic definition; do not change instructions or subset/reorder the input')
            retained = [r for r in _stela_copy.deepcopy(resume._resume_rows) if r['status'] in ('success', 'unresolved')]
        retained_ids = {r['id'] for r in retained}
        pending = [r for r in records if r['id'] not in retained_ids]
        oversized = [dict(id=r['id'], status='failed', value=None, evidence=[],
            error='input_too_large: explicitly split the record') for r in pending
            if len(json.dumps(r, ensure_ascii=False)) > 10000]
        oversized_ids = {r['id'] for r in oversized}
        pending = [r for r in pending if r['id'] not in oversized_ids]
        bridge = globals().get('__stela_semantic')
        if not callable(bridge):
            raise RuntimeError('Semantic execution is unavailable or not authorized')
        # One bounded probe: total size is checked before inference, never silently sampled.
        preflight = json.loads(await bridge(json.dumps(dict(operation=operation,
            instructions=instructions, records=pending[:8], phase='preflight', totalRecords=len(pending), **options), ensure_ascii=False)))
        control = preflight.get('control', {})
        if resume is not None and resume._identity != control.get('executionIdentity'):
            raise ValueError('Resume model identity changed; start a deliberate new operation instead of mixing model results')
        probed = preflight.get('rows', [])
        probed_ids = {r['id'] for r in probed}
        pending = [r for r in pending if r['id'] not in probed_ids]
        async def send(batch):
            rows = []
            accepted = []
            for record in batch:
                if len(json.dumps(record, ensure_ascii=False)) > 10000:
                    rows.append({'id': record['id'], 'status': 'failed', 'value': None,
                                 'evidence': [], 'error': 'input_too_large: explicitly split the record'})
                else:
                    accepted.append(record)
            if not accepted:
                return rows, {}, 0, {}
            response = json.loads(await bridge(json.dumps(dict(operation=operation,
                instructions=instructions, records=accepted, **options), ensure_ascii=False)))
            rows.extend(response['rows'])
            return rows, response['usage'], response['cached'], response.get('control', {})
        reused = len(retained)
        rows, usage, cached = list(retained) + oversized + probed, preflight.get('usage', {}), preflight.get('cached', 0)
        usage_revision = control.get('ledgerRevision', 0)
        stop_reason = None
        if not allow_partial and control.get('canStartFull') is False:
            stop_reason = control.get('reason', 'full_operation_exceeds_remaining_budget')
        # Only four batches are in flight, including serialization and RPC.
        for offset in range(0, len(pending), 32):
            if stop_reason:
                break
            tasks = [_stela_asyncio.create_task(send(pending[i:i+8]))
                     for i in range(offset, min(offset+32, len(pending)), 8)]
            try:
                for future in _stela_asyncio.as_completed(tasks):
                    batch_rows, batch_usage, hits, batch_control = await future
                    rows.extend(batch_rows)
                    if batch_usage and batch_control.get('ledgerRevision', 0) >= usage_revision:
                        usage = batch_usage
                        usage_revision = batch_control.get('ledgerRevision', 0)
                    cached += hits
                    if batch_control.get('stopScheduling'):
                        stop_reason = batch_control.get('reason', 'semantic_budget_exhausted')
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await _stela_asyncio.gather(*tasks, return_exceptions=True)
        by_id = {r['id']: r for r in rows}
        ordered = [by_id.get(r['id'], dict(id=r['id'], status='unprocessed', value=None, evidence=[],
            error=stop_reason or 'not_processed')) for r in records]
        counts = {s: sum(r['status'] == s for r in ordered)
                  for s in ('success', 'unresolved', 'failed', 'unprocessed')}
        return _StelaSemanticResult(ordered, dict(total=len(records), cached=cached, reused=reused, usage=usage,
            complete=counts['success'] == len(records), preflight=control, stopReason=stop_reason, **counts),
            signature=signature, identity=control.get('executionIdentity'))

    def _records(self, df, columns, required_fields=None, id_column=None):
        if not isinstance(df, pd.DataFrame) or not columns or len(set(columns)) != len(columns):
            raise ValueError('Provide a DataFrame and unique selected columns')
        if len(df) > 100000:
            raise ValueError('At most 100000 records per operation; filter explicitly first')
        missing = set(required_fields or []) - set(columns)
        if missing:
            raise ValueError('Required fields must be explicitly selected: ' + ', '.join(sorted(missing)))
        selected = df.loc[:, columns]
        if not selected.columns.is_unique:
            raise ValueError('Duplicate DataFrame column names are unsupported')
        data = json.loads(selected.to_json(orient='records', date_format='iso'))
        ids = [str(i) for i in range(len(data))]
        if id_column is not None:
            if df[id_column].isna().any():
                raise ValueError('id_column must not contain nulls')
            ids = df[id_column].astype(str).tolist()
        if len(set(ids)) != len(ids) or any(not i or len(i) > 128 for i in ids):
            raise ValueError('Semantic row IDs must be unique nonempty strings of at most 128 characters')
        return [{'id': ids[i], 'data': row} for i, row in enumerate(data)]

    async def classify(self, df, *, columns, labels, instructions, required_fields=None, id_column=None, resume=None, allow_partial=False):
        return await self._run(self._records(df, columns, required_fields, id_column), 'classify', instructions,
            labels=labels, requiredFields=required_fields or [], resume=resume, allow_partial=allow_partial)

    async def extract(self, df, *, columns, schema, instructions, required_fields=None, id_column=None, resume=None, allow_partial=False):
        return await self._run(self._records(df, columns, required_fields, id_column), 'extract', instructions,
            schema=schema, requiredFields=required_fields or [], resume=resume, allow_partial=allow_partial)

    async def resolve(self, left, right=None, *, columns, blocking=None, instructions, required_fields=None, resume=None, allow_partial=False):
        single = right is None
        right = left if single else right
        a, b = self._records(left, columns, required_fields), self._records(right, columns, required_fields)
        keys = (blocking or {}).get('keys', [])
        if any(k not in columns for k in keys):
            raise ValueError('Blocking keys must be selected columns')
        if len(a) * len(b) > 1000000:
            raise ValueError('Candidate search exceeds 1000000 comparisons; partition explicitly first')
        def norm(value):
            return ' '.join(_stela_unicode.normalize('NFKC', '' if value is None else str(value)).casefold().split())
        def tokens(row):
            return set(' '.join(norm(v) for v in row.values()).split())
        pairs, coverage, candidates = {}, {}, {}
        for l in a:
            eligible = [r for r in b if (not single or l['id'] != r['id']) and
                        all(norm(l['data'].get(k)) and norm(l['data'].get(k)) == norm(r['data'].get(k)) for k in keys)]
            t = tokens(l['data'])
            eligible.sort(key=lambda r: (-len(t & tokens(r['data'])) / max(1, len(t | tokens(r['data']))), int(r['id'])))
            coverage[l['id']] = len(eligible) <= 20
            candidates[l['id']] = [r['id'] for r in eligible[:20]]
            for r in eligible[:20]:
                i, j = l['id'], r['id']
                if single and int(i) > int(j):
                    i, j = j, i
                pair_id = i + ':' + j
                pairs[pair_id] = {'id': pair_id, 'data': {'left': a[int(i)]['data'], 'right': b[int(j)]['data']}}
        output = await self._run(list(pairs.values()), 'resolve', instructions,
            requiredFields=required_fields or [], resume=resume, allow_partial=allow_partial)
        decisions = {r['id']: r for r in output.rows.to_dict('records')}
        def verdict(i, j):
            if single and int(i) > int(j):
                i, j = j, i
            row = decisions.get(i + ':' + j, {})
            return row.get('value') if row.get('status') == 'success' else None
        mapping = []
        if not single:
            for l in a:
                ids = candidates[l['id']]
                same = [j for j in ids if verdict(l['id'], j) == 'same']
                complete = coverage[l['id']] and len(same) == 1 and all(verdict(l['id'], j) in ('same', 'different') for j in ids)
                mapping.append({'id': l['id'], 'canonical_id': same[0] if complete else None,
                                'status': 'matched' if complete else 'unresolved', 'candidate_complete': coverage[l['id']]})
        else:
            adjacency = {r['id']: set() for r in a}
            for pair_id in pairs:
                i, j = pair_id.split(':')
                if verdict(i, j) == 'same':
                    adjacency[i].add(j)
                    adjacency[j].add(i)
            visited = set()
            for l in a:
                if l['id'] in visited:
                    continue
                group, todo = set(), [l['id']]
                while todo:
                    i = todo.pop()
                    if i in group:
                        continue
                    group.add(i)
                    todo.extend(adjacency[i] - group)
                visited.update(group)
                complete = len(group) > 1 and all(coverage[i] for i in group) and all(
                    verdict(i, j) == 'same' for i in group for j in group if int(i) < int(j)) and all(
                    verdict(i, j) == 'different' for i in group for j in candidates[i] if j not in group)
                canonical = min(group, key=int) if complete else None
                mapping.extend({'id': i, 'canonical_id': canonical, 'status': 'matched' if complete else 'unresolved',
                                'candidate_complete': coverage[i]} for i in sorted(group, key=int))
        output.mapping = pd.DataFrame(mapping, columns=['id', 'canonical_id', 'status', 'candidate_complete'])
        output.summary.update(candidate_scope='Declared blocking keys only; not proof of global identity coverage',
                              candidate_truncated=sum(not v for v in coverage.values()))
        return output
`;
