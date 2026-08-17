/** Runtime-neutral Python program shared by browser and headless Pyodide workers. */

export const STELA_PYODIDE_PACKAGES = ["duckdb", "pandas"] as const;

export const PYTHON_EXECUTE_SCRIPT = String.raw`
import contextlib
import io
import json
import traceback
import duckdb
import pandas as pd

def _quote_ident(value):
    return '"' + str(value).replace('"', '""') + '"'

def _quote_literal(value):
    return "'" + str(value).replace("'", "''") + "'"

_cfg = json.loads(__stela_inputs_json)
con = duckdb.connect(database=':memory:')
tables = {}
for _item in _cfg:
    _alias = _item['alias']
    _quoted_alias = _quote_ident(_alias)
    if _item['rowCount'] == 0:
        _frame_name = '__stela_empty_' + _alias
        con.register(_frame_name, pd.DataFrame(columns=[c['name'] for c in _item['columns']]))
        con.execute(f'CREATE VIEW {_quoted_alias} AS SELECT * FROM {_quote_ident(_frame_name)}')
    elif _item['format'] == 'parquet':
        con.execute(
            f'CREATE VIEW {_quoted_alias} AS SELECT * FROM read_parquet({_quote_literal(_item["path"])})'
        )
    else:
        _select = ', '.join(
            f'{_quote_ident("c" + str(i))} AS {_quote_ident(col["name"])}'
            for i, col in enumerate(_item['columns'])
        )
        con.execute(
            f'CREATE VIEW {_quoted_alias} AS SELECT {_select} '
            f'FROM read_json_auto({_quote_literal(_item["path"])}, format=\'newline_delimited\')'
        )
    tables[_alias] = con.table(_alias)

_stdout = io.StringIO()
_namespace = {
    '__builtins__': __builtins__,
    'duckdb': duckdb,
    'pd': pd,
    'con': con,
    'tables': tables,
}
try:
    with contextlib.redirect_stdout(_stdout):
        exec(compile(__stela_code, '<stela-agent>', 'exec'), _namespace, _namespace)
    _value = _namespace.get('result', None)
    if isinstance(_value, duckdb.DuckDBPyRelation):
        _count = int(_value.count('*').fetchone()[0])
        _df = _value.limit(200).df()
        _payload = {
            'kind': 'table',
            'columns': [{'name': str(c), 'typeName': str(t)} for c, t in zip(_df.columns, _df.dtypes)],
            'rows': json.loads(_df.to_json(orient='values', date_format='iso')),
            'rowCount': _count,
            'truncated': _count > len(_df),
        }
    elif isinstance(_value, pd.DataFrame):
        _count = len(_value)
        _df = _value.head(200)
        _payload = {
            'kind': 'table',
            'columns': [{'name': str(c), 'typeName': str(t)} for c, t in zip(_df.columns, _df.dtypes)],
            'rows': json.loads(_df.to_json(orient='values', date_format='iso')),
            'rowCount': _count,
            'truncated': _count > len(_df),
        }
    elif _value is None:
        _payload = {'kind': 'none'}
    else:
        try:
            json.dumps(_value)
            _scalar = _value
        except Exception:
            _scalar = repr(_value)
        _payload = {'kind': 'scalar', 'value': _scalar}
    __stela_result_json = json.dumps({
        'ok': True,
        'stdout': _stdout.getvalue()[-65536:],
        'value': _payload,
    }, default=str)
    if len(__stela_result_json) > 2_000_000:
        __stela_result_json = json.dumps({
            'ok': False,
            'stdout': _stdout.getvalue()[-65536:],
            'value': {'kind': 'none'},
            'error': 'Python result exceeds the 2 MB response limit; aggregate or select fewer columns.',
        })
except BaseException as _error:
    __stela_result_json = json.dumps({
        'ok': False,
        'stdout': _stdout.getvalue()[-65536:],
        'value': {'kind': 'none'},
        'error': ''.join(traceback.format_exception_only(type(_error), _error)).strip()[:16000],
    })
finally:
    con.close()
`;
