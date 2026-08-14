/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from "pyodide";

import type {
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@shared/types";

type StartMessage = {
  type: "start";
  request: PythonExecutionRequest;
  assetBaseUrl: string;
};
type ChunkMessage = {
  type: "chunk";
  jobId: string;
  alias: string;
  data: Uint8Array;
  eof: boolean;
};
type InboundMessage = StartMessage | ChunkMessage;

interface ActiveInput {
  path: string;
  stream: ReturnType<PyodideInterface["FS"]["open"]>;
  complete: boolean;
}

interface ActiveJob {
  request: PythonExecutionRequest;
  inputs: Map<string, ActiveInput>;
}

const runtimeGlobals = Object.freeze({});
let pyodidePromise: Promise<PyodideInterface> | null = null;
let active: ActiveJob | null = null;

function post(message: unknown): void {
  self.postMessage(message);
}

async function runtime(assetBaseUrl: string): Promise<PyodideInterface> {
  pyodidePromise ??= loadPyodide({
    indexURL: assetBaseUrl,
    packageBaseUrl: assetBaseUrl,
    lockFileURL: new URL("pyodide-lock.json", assetBaseUrl).href,
    packages: ["duckdb", "pandas"],
    jsglobals: runtimeGlobals,
    stdout: () => {},
    stderr: () => {},
  });
  return pyodidePromise;
}

function safeInputPath(jobId: string, alias: string, format: "parquet" | "jsonl"): string {
  const extension = format === "parquet" ? "parquet" : "jsonl";
  return `/stela-inputs/${jobId}/${alias}.${extension}`;
}

async function start(message: StartMessage): Promise<void> {
  if (active) throw new Error("Python runtime already has an active job");
  const py = await runtime(message.assetBaseUrl);
  const dir = `/stela-inputs/${message.request.jobId}`;
  try {
    py.FS.mkdirTree(dir);
  } catch {
    // A cancelled worker is terminated; this only covers a stale empty directory.
  }
  const inputs = new Map<string, ActiveInput>();
  for (const input of message.request.inputs) {
    const inputPath = safeInputPath(message.request.jobId, input.alias, input.format);
    inputs.set(input.alias, {
      path: inputPath,
      stream: py.FS.open(inputPath, "w"),
      complete: false,
    });
  }
  active = { request: message.request, inputs };
  post({ type: "ready", jobId: message.request.jobId });
  if (inputs.size === 0) await executeActive(py);
}

async function chunk(message: ChunkMessage): Promise<void> {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const py = await pyodidePromise!;
  const input = job.inputs.get(message.alias);
  if (!input || input.complete) return;
  if (message.data.byteLength > 0) {
    py.FS.write(input.stream, message.data, 0, message.data.byteLength);
  }
  if (message.eof) {
    py.FS.close(input.stream);
    input.complete = true;
  }
  if ([...job.inputs.values()].every((item) => item.complete)) {
    await executeActive(py);
  }
}

const EXECUTE_SCRIPT = String.raw`
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

async function executeActive(py: PyodideInterface): Promise<void> {
  const job = active;
  if (!job) return;
  const startedAt = Date.now();
  try {
    const config = job.request.inputs.map((input) => ({
      ...input,
      path: job.inputs.get(input.alias)?.path,
    }));
    py.globals.set("__stela_code", job.request.code);
    py.globals.set("__stela_inputs_json", JSON.stringify(config));
    await py.runPythonAsync(EXECUTE_SCRIPT);
    const raw = py.globals.get("__stela_result_json");
    const parsed = JSON.parse(String(raw)) as Omit<PythonExecutionResult, "elapsedMs">;
    post({
      type: "result",
      jobId: job.request.jobId,
      result: { ...parsed, elapsedMs: Date.now() - startedAt },
    });
  } catch (error) {
    post({
      type: "result",
      jobId: job.request.jobId,
      fatal: true,
      result: {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PythonExecutionResult,
    });
  } finally {
    py.globals.delete("__stela_code");
    py.globals.delete("__stela_inputs_json");
    py.globals.delete("__stela_result_json");
    for (const input of job.inputs.values()) {
      try {
        py.FS.unlink(input.path);
      } catch {
        // best effort
      }
    }
    try {
      py.FS.rmdir(`/stela-inputs/${job.request.jobId}`);
    } catch {
      // best effort
    }
    active = null;
  }
}

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (message.type === "start" ? start(message) : chunk(message)).catch((error) => {
    const jobId = message.type === "start" ? message.request.jobId : message.jobId;
    post({
      type: "result",
      jobId,
      fatal: true,
      result: {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PythonExecutionResult,
    });
    active = null;
  });
});
