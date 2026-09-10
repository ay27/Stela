/** Runtime-neutral Python program shared by browser and headless Pyodide workers. */
import { PYTHON_SEMANTIC_SCRIPT } from "./python-semantic-runtime";
import { PYTHON_ANSWER_CONTRACT_SCRIPT } from "./python-answer-contract";

export const STELA_PYODIDE_PACKAGES = ["duckdb", "pandas"] as const;

/**
 * The sandbox fetches its own data through `await query(connection, sql)`, which
 * round-trips to the main process: only a connection *name* leaves the sandbox,
 * and the host runs the statement read-only and journals it. `__stela_query` is
 * the single JS callable injected by the worker; it resolves to a JSON
 * descriptor whose `path` already exists in the virtual filesystem.
 *
 * The Worker owns a persistent namespace, connection and inputs. Each cell
 * rebinds capability helpers; their host RPCs authorize the current active job.
 * The payload is the coroutine's return value, not the previous result binding.
 *
 * ponytail: query() requires `await`, because a JS Promise can only be consumed
 * asynchronously from Pyodide. Ceiling: the model has to remember to write it.
 * Upgrade path is JSPI plus pyodide.ffi.run_sync for a synchronous query(),
 * once JSPI is reliably available under Electron.
 */
export const PYTHON_EXECUTE_SCRIPT = String.raw`
import contextlib
import io
import json
import traceback
import datetime
import duckdb
import pandas as pd
from pyodide.code import eval_code_async

${PYTHON_SEMANTIC_SCRIPT}
${PYTHON_ANSWER_CONTRACT_SCRIPT}

async def _stela_main(_code, _staged_json, _query_bridge):
    def _quote_ident(value):
        return '"' + str(value).replace('"', '""') + '"'

    def _quote_literal(value):
        return "'" + str(value).replace("'", "''") + "'"

    workspace = globals().get('__stela_workspace')
    if workspace is None:
        workspace = {'con': duckdb.connect(database=':memory:'), 'tables': {},
                     'namespace': {}, 'sources': {}, 'generation': str(datetime.datetime.now(datetime.timezone.utc))}
        globals()['__stela_workspace'] = workspace
    con, tables = workspace['con'], workspace['tables']
    refreshed = []

    class _EmptyCountRelation:
        columns = ['count_star()']
        types = ['BIGINT']

        def fetchone(self):
            return (0,)

        def df(self):
            return pd.DataFrame({'count_star()': [0]})

    class _EmptyRelation:
        """Pandas-compatible zero-column result for connectors without empty-result metadata."""
        columns = []
        types = []

        def __len__(self):
            return 0

        def df(self):
            return pd.DataFrame()

        def count(self, _expression='*'):
            return _EmptyCountRelation()

        def limit(self, _count):
            return self

    _EmptyRelation = workspace.setdefault('empty_relation_type', _EmptyRelation)

    def _register(item):
        """Expose one materialized result as a DuckDB view and return its relation."""
        alias = item['alias']
        if alias in workspace['sources']:
            refreshed.append(alias)
        quoted = _quote_ident(alias)
        if item['rowCount'] == 0 and not item['columns']:
            tables[alias] = _EmptyRelation()
            workspace['sources'][alias] = {'alias': alias, 'version': item['runId'], 'rowCount': 0,
                                           'readAt': str(datetime.datetime.now(datetime.timezone.utc)), 'incomplete': bool(item.get('incomplete'))}
            return tables[alias]
        if item['rowCount'] == 0:
            frame = '__stela_empty_' + alias
            con.register(frame, pd.DataFrame(columns=[c['name'] for c in item['columns']]))
            con.execute(f'CREATE OR REPLACE VIEW {quoted} AS SELECT * FROM {_quote_ident(frame)}')
        elif item['format'] == 'parquet':
            con.execute(
                f'CREATE OR REPLACE VIEW {quoted} AS SELECT * FROM read_parquet({_quote_literal(item["path"])})'
            )
        else:
            select = ', '.join(
                f'{_quote_ident("c" + str(i))} AS {_quote_ident(col["name"])}'
                for i, col in enumerate(item['columns'])
            )
            con.execute(
                f'CREATE OR REPLACE VIEW {quoted} AS SELECT {select} '
                f'FROM read_json_auto({_quote_literal(item["path"])}, format=\'newline_delimited\')'
            )
        tables[alias] = con.table(alias)
        workspace['sources'][alias] = {'alias': alias, 'version': item['runId'], 'rowCount': item['rowCount'],
                                       'readAt': str(datetime.datetime.now(datetime.timezone.utc)), 'incomplete': bool(item.get('incomplete'))}
        return tables[alias]

    def _describe(alias, row_count):
        # Report shape and resolved column types. Without it the model burns
        # whole tool calls on hasattr/type probes just to learn what it fetched.
        # row_count comes from the descriptor, so this costs no scan.
        relation = tables[alias]
        return (
            f'{alias}: {row_count} rows x {len(relation.columns)} cols | '
            + ', '.join(
                f'{column}:{typename}'
                for column, typename in zip(relation.columns, relation.types)
            )
        )

    async def query(connection, request):
        """Run one read-only query on a named Stela connection.

        request is a SQL string, or a dict for MongoDB such as
        {'collection': 'orders', 'filter': {}, 'limit': None}.
        Returns a DuckDB relation over the full result; call .df() for pandas.
        """
        # Absent bridge arrives as None, undefined, or JsNull depending on the
        # host; callable() is the one check that covers all three.
        if not callable(_query_bridge):
            raise RuntimeError(
                'query() is unavailable in this execution; no data connection was granted'
            )
        if isinstance(request, str):
            spec = {'language': 'sql', 'query': request}
        else:
            spec = dict(request)
            spec.setdefault('language', 'mongodb')
        item = json.loads(await _query_bridge(str(connection), json.dumps(spec)))
        relation = _register(item)
        print('[query] ' + _describe(item['alias'], item['rowCount']))
        return relation

    def to_df(alias):
        if alias not in tables:
            raise KeyError(
                f"Unknown table alias {alias!r}; available aliases: {sorted(tables.keys())}"
            )
        return tables[alias].df()

    schema_lines = []
    for staged in json.loads(_staged_json):
        _register(staged)
        schema_lines.append('  ' + _describe(staged['alias'], staged['rowCount']))
    schema = (
        '[INPUTS] tables[alias] is a DuckDB relation; to_df(alias) gives a pandas DataFrame.\n'
        + '\n'.join(schema_lines) + '\n\n'
    ) if schema_lines else ''

    stdout = io.StringIO()
    namespace = workspace['namespace']
    # Reserved output slot, not persistent user state or dependency invalidation.
    namespace.pop('result', None)
    namespace.update({
        '__builtins__': __builtins__,
        'duckdb': duckdb,
        'pd': pd,
        'con': con,
        'tables': tables,
        'to_df': to_df,
        'query': query,
        'semantic': _StelaSemantic(),
        'analysis': _StelaAnalysis(),
    })

    def snapshot(status):
        variables = []
        for name, value in list(namespace.items()):
            if name.startswith('_') or name in ('duckdb', 'pd', 'con', 'tables', 'to_df', 'query', 'semantic', 'analysis'):
                continue
            item = {'name': name[:128], 'type': type(value).__name__[:128]}
            if isinstance(value, pd.DataFrame):
                item.update(rows=len(value), columns=len(value.columns))
            variables.append(item)
        return {'generation': workspace['generation'], 'status': status,
                'sources': list(workspace['sources'].values())[:128],
                'variables': variables[:100], 'refreshedAliases': refreshed[:128]}

    def _table_payload(frame, total):
        if len(frame.columns) > 500:
            raise ValueError('Python result exceeds 500 columns; select fewer columns. Data remains in workspace.')
        return {
            'kind': 'table',
            'columns': [
                {'name': str(c), 'typeName': str(t)}
                for c, t in zip(frame.columns, frame.dtypes)
            ],
            'rows': json.loads(frame.to_json(orient='values', date_format='iso')),
            'rowCount': total,
            'truncated': total > len(frame),
        }

    try:
        existing_tasks = _stela_asyncio.all_tasks()
        try:
            with contextlib.redirect_stdout(stdout):
                await eval_code_async(_code, globals=namespace)
        finally:
            # Persistent variables do not grant background tasks a later job's authority.
            spawned_tasks = _stela_asyncio.all_tasks() - existing_tasks
            for task in spawned_tasks:
                task.cancel()
            if spawned_tasks:
                await _stela_asyncio.gather(*spawned_tasks, return_exceptions=True)
        value = namespace.get('result', None)
        if isinstance(value, duckdb.DuckDBPyRelation):
            payload = _table_payload(value.limit(200).df(), int(value.count('*').fetchone()[0]))
        elif isinstance(value, _EmptyRelation):
            payload = _table_payload(value.df(), 0)
        elif isinstance(value, pd.DataFrame):
            payload = _table_payload(value.head(200), len(value))
        elif value is None:
            payload = {'kind': 'none'}
        else:
            try:
                json.dumps(value, allow_nan=False)
                payload = {'kind': 'scalar', 'value': value}
            except Exception:
                payload = {'kind': 'scalar', 'value': repr(value)}
        result_json = json.dumps({
            'ok': True,
            'stdout': (schema + stdout.getvalue())[-8000:],
            'stdoutTruncated': len(schema + stdout.getvalue()) > 8000,
            'workspace': snapshot('ready'),
            **({'analysis': _stela_safe_analysis_snapshot()} if _stela_contract_context().get('automaticContracts') else {}),
            'value': payload,
        }, default=str)
        if len(result_json) > 2_000_000:
            result_json = json.dumps({
                'ok': False,
                'stdout': (schema + stdout.getvalue())[-8000:],
                'workspace': snapshot('ready'),
                **({'analysis': _stela_safe_analysis_snapshot()} if _stela_contract_context().get('automaticContracts') else {}),
                'value': {'kind': 'none'},
                'error': 'Python result exceeds the 2 MB response limit; aggregate or select fewer columns.',
            })
        return result_json
    except BaseException as error:
        return json.dumps({
            'ok': False,
            'stdout': (schema + stdout.getvalue())[-8000:],
            'workspace': snapshot('partial_mutation_possible'),
            **({'analysis': _stela_safe_analysis_snapshot('partial_mutation_possible')} if _stela_contract_context().get('automaticContracts') else {}),
            'value': {'kind': 'none'},
            'error': ''.join(traceback.format_exception_only(type(error), error)).strip()[:16000],
        })

await _stela_main(__stela_code, __stela_inputs_json, __stela_query)
`;
