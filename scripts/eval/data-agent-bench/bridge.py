#!/usr/bin/env python3
"""DataAgentBench bridge for Stela's headless eval and subprocess connector.

The process speaks one JSON object per line on stdin/stdout. It imports DAB's
official database tools and validator from ``--dab-root``; Stela owns only the
transport adapter and QueryResult normalization.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any


ROUTE_RE = re.compile(
    r"^\s*--\s*stela-dab-database\s*:\s*([A-Za-z0-9_.-]+)\s*$",
    re.IGNORECASE,
)


class BridgeError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def parse_routed_query(sql: str, database_names: list[str]) -> tuple[str, str]:
    """Return ``(database, query)`` from Stela's first-line routing contract."""
    lines = sql.splitlines()
    first_index = next((index for index, line in enumerate(lines) if line.strip()), None)
    if first_index is None:
        raise BridgeError("invalid_query", "SQL must not be empty.")
    match = ROUTE_RE.match(lines[first_index])
    if not match:
        raise BridgeError(
            "missing_database_route",
            "The first non-empty SQL line must be '-- stela-dab-database: <logical_name>'.",
        )
    database = match.group(1)
    if database not in database_names:
        raise BridgeError(
            "unknown_database",
            f"Unknown logical database '{database}'. Available: {', '.join(database_names)}",
        )
    query_lines = lines[:first_index] + lines[first_index + 1 :]
    query = "\n".join(query_lines).strip()
    if not query:
        raise BridgeError("invalid_query", "SQL after the database route must not be empty.")
    other_prefixes = [
        name for name in database_names
        if name != database and re.search(rf"\b{re.escape(name)}\s*\.", query, re.IGNORECASE)
    ]
    if other_prefixes:
        raise BridgeError(
            "cross_database_query",
            "One run_sql call may target only one logical database; query databases separately. "
            f"Also referenced: {', '.join(other_prefixes)}",
        )
    query = re.sub(rf"\b{re.escape(database)}\s*\.", "", query, flags=re.IGNORECASE)
    return database, query


def infer_type_name(values: list[Any]) -> str:
    value = next((item for item in values if item is not None), None)
    if value is None:
        return "UNKNOWN"
    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, int):
        return "BIGINT"
    if isinstance(value, float):
        return "DOUBLE"
    if isinstance(value, (dict, list)):
        return "JSON"
    return "TEXT"


def normalize_query_result(value: Any, elapsed_ms: int) -> dict[str, Any]:
    """Convert DAB's JSON-serializable result into Stela's QueryResult DTO."""
    records: list[dict[str, Any]]
    if isinstance(value, list):
        if all(isinstance(item, dict) for item in value):
            records = value
        else:
            records = [{"value": item} for item in value]
    elif isinstance(value, dict):
        records = [value]
    else:
        records = [{"value": value}]

    names: list[str] = []
    for record in records:
        for key in record:
            name = str(key)
            if name not in names:
                names.append(name)
    columns = [
        {
            "name": name,
            "typeName": infer_type_name([record.get(name) for record in records]),
        }
        for name in names
    ]
    rows = [[record.get(name) for name in names] for record in records]
    return {
        "kind": "query",
        "columns": columns,
        "rows": rows,
        "elapsedMs": elapsed_ms,
    }


def table_description(description: str, table: str) -> tuple[list[dict[str, str]], str]:
    """Extract a best-effort table section from DAB's human-readable description."""
    lines = description.splitlines()
    table_pattern = re.compile(rf"\b{re.escape(table)}\b", re.IGNORECASE)
    heading_pattern = re.compile(rf"^\s*-?\s*{re.escape(table)}\s*:\s*$", re.IGNORECASE)
    start = next((index for index, line in enumerate(lines) if heading_pattern.match(line)), None)
    if start is None:
        start = next((index for index, line in enumerate(lines) if table_pattern.search(line)), None)
    if start is None:
        return [], description[:4000]
    base_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent:
            end = index
            break
    section = "\n".join(lines[start:end]).strip()[:4000]
    field_pattern = re.compile(
        r"^\s*-\s*([A-Za-z_][\w$]*)\s*(?:\(([^)]*)\))?\s*:\s*(.*)$"
    )
    columns: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in lines[start + 1 : end]:
        match = field_pattern.match(line)
        if not match:
            continue
        name = match.group(1)
        if name.lower() in {"field", "fields", "table", "tables", "collection", "collections"}:
            continue
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        item = {"name": name, "typeName": (match.group(2) or "UNKNOWN").strip()}
        comment = match.group(3).strip()
        if comment:
            item["comment"] = comment
        columns.append(item)
    return columns, section


class DabRuntime:
    def __init__(self, dab_root: Path):
        self.dab_root = dab_root.resolve()
        self.dataset: str | None = None
        self.query_id: int | None = None
        self.run_dir: Path | None = None
        self.description = ""
        self.query_tool: Any = None
        self.list_tool: Any = None
        sys.path.insert(0, str(self.dab_root))
        with contextlib.redirect_stdout(sys.stderr):
            self.query_tool_class = importlib.import_module(
                "common_scaffold.tools.QueryDBTool"
            ).QueryDBTool
            self.list_tool_class = importlib.import_module(
                "common_scaffold.tools.ListDBTool"
            ).ListDBTool
            self.validate_fn = importlib.import_module(
                "common_scaffold.validate.validate"
            ).validate

    def _dataset_dir(self, dataset: str) -> Path:
        directory = self.dab_root / f"query_{dataset}"
        if not directory.is_dir():
            raise BridgeError("dataset_not_found", f"DAB dataset not found: {directory}")
        return directory

    def ensure(self, config: dict[str, Any]) -> None:
        dataset = str(config.get("dataset") or "").strip()
        if not dataset:
            raise BridgeError("invalid_config", "config.dataset is required.")
        query_id_raw = config.get("queryId")
        query_id = int(query_id_raw) if query_id_raw is not None else None
        run_dir_raw = config.get("runDir")
        run_dir = Path(run_dir_raw).resolve() if run_dir_raw else self.dab_root / ".stela-dab-bridge"
        if self.dataset == dataset and self.query_id == query_id and self.query_tool is not None:
            return
        self.close()
        dataset_dir = self._dataset_dir(dataset)
        config_path = dataset_dir / "db_config.yaml"
        description_path = dataset_dir / "db_description.txt"
        run_dir.mkdir(parents=True, exist_ok=True)
        log_path = run_dir / "dab_tool_calls.jsonl"
        with contextlib.redirect_stdout(sys.stderr):
            self.query_tool = self.query_tool_class(
                log_path=log_path,
                name="query_db",
                db_config_path=config_path,
                check_load=True,
            )
            self.list_tool = self.list_tool_class(
                log_path=log_path,
                name="list_db",
                db_config_path=config_path,
                check_load=False,
            )
        self.dataset = dataset
        self.query_id = query_id
        self.run_dir = run_dir
        self.description = description_path.read_text(encoding="utf-8")

    def databases(self) -> list[str]:
        if self.query_tool is None:
            raise BridgeError("not_initialized", "Call test/init with a dataset first.")
        return list(self.query_tool.db_clients.keys())

    def invoke_tool(self, tool: Any, args: dict[str, Any]) -> Any:
        with contextlib.redirect_stdout(sys.stderr):
            result = tool.exec(args)
        if not isinstance(result, dict) or result.get("success") is not True:
            detail = result.get("result") if isinstance(result, dict) else result
            raise BridgeError("dab_tool_error", str(detail), True)
        return result.get("result")

    def handle(self, method: str, params: dict[str, Any]) -> Any:
        if method in {"init", "test"}:
            config = params if method == "init" else dict(params.get("config") or {})
            self.ensure(config)
            return {"ok": True, "message": f"DAB dataset {self.dataset} is ready."}

        config = dict(params.get("config") or {})
        if config:
            self.ensure(config)
        if method == "list_databases":
            return self.databases()
        if method == "list_tables":
            db_name = str(params.get("db") or "").strip()
            if not db_name:
                raise BridgeError("invalid_database", "db is required for DAB list_tables.")
            return self.invoke_tool(self.list_tool, {"db_name": db_name})
        if method == "describe_tables":
            output = []
            for raw in params.get("tables") or []:
                database = raw.get("database") if isinstance(raw, dict) else None
                table = raw.get("table") if isinstance(raw, dict) else None
                if not table:
                    continue
                columns, snippet = table_description(self.description, str(table))
                output.append({
                    "database": database,
                    "table": str(table),
                    "columns": columns,
                    "ddlSnippet": snippet,
                })
            return output
        if method == "execute":
            sql = str(params.get("sql") or "")
            database, query = parse_routed_query(sql, self.databases())
            db_type = self.query_tool.db_clients[database]["db_type"]
            if db_type == "mongo":
                raise BridgeError(
                    "unsupported_mongodb",
                    "Current Stela run_sql is SQL-only and cannot execute MongoDB queries.",
                )
            started = time.monotonic()
            value = self.invoke_tool(self.query_tool, {"db_name": database, "query": query})
            return normalize_query_result(value, round((time.monotonic() - started) * 1000))
        if method == "validate":
            if self.query_id is None or self.dataset is None:
                raise BridgeError("query_not_initialized", "queryId is required before validation.")
            query_dir = self._dataset_dir(self.dataset) / f"query{self.query_id}"
            return self.validate_fn(
                query_dir=query_dir,
                llm_answer=str(params.get("answer") or ""),
                reason=str(params.get("terminateReason") or ""),
            )
        if method in {"close", "shutdown"}:
            self.close()
            return {"ok": True}
        raise BridgeError("unknown_method", f"Unknown bridge method: {method}")

    def close(self) -> None:
        if self.query_tool is not None:
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    self.query_tool.clean_up()
            except Exception as error:  # cleanup must not corrupt the protocol
                print(f"DAB cleanup warning: {error}", file=sys.stderr)
        self.query_tool = None
        self.list_tool = None
        self.dataset = None
        self.query_id = None
        self.run_dir = None
        self.description = ""


def write_frame(frame: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(frame, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dab-root", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    runtime = DabRuntime(args.dab_root)
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request: dict[str, Any] = {}
            should_exit = False
            try:
                request = json.loads(line)
                method = str(request.get("method") or "")
                params = request.get("params") or {}
                result = runtime.handle(method, params)
                write_frame({"id": request.get("id"), "ok": True, "result": result})
                should_exit = method == "shutdown"
            except BridgeError as error:
                write_frame({
                    "id": request.get("id"),
                    "ok": False,
                    "error": {
                        "code": error.code,
                        "message": str(error),
                        "retryable": error.retryable,
                    },
                })
            except Exception as error:
                write_frame({
                    "id": request.get("id"),
                    "ok": False,
                    "error": {
                        "code": "bridge_error",
                        "message": f"{type(error).__name__}: {error}",
                        "retryable": False,
                    },
                })
            if should_exit:
                break
    finally:
        runtime.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
