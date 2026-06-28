#!/usr/bin/env python3
"""Stela connector dogfood: echo connector.

把传入 SQL 原样回成单列单行结果。用于验证 subprocess 协议（v1）端到端：
hello → execute → 落 SQLite → 抽屉展示。

注册方式（在 Stela 配置目录的 connector_plugins.json）：

  [
    { "kind": "echo", "exe_path": "/path/to/stela-echo-connector.py" }
  ]

详见 docs/connector-plugin-protocol.md。
"""

import json
import sys
import time


def write(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    write({
        "method": "hello",
        "result": {
            "kind": "echo",
            "display_name": "Echo (debug)",
            "config_schema": {
                "type": "object",
                "properties": {},
            },
            "default_config": {},
            "protocol_version": 1,
        },
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            sys.stderr.write(f"[echo] bad request: {exc}\n")
            sys.stderr.flush()
            continue

        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        if method == "shutdown":
            break

        if method == "test":
            write({
                "id": rid,
                "ok": True,
                "result": {
                    "ok": True,
                    "message": "echo ready",
                    "latency_ms": 0,
                },
            })
        elif method == "execute":
            sql = params.get("sql", "")
            t0 = time.perf_counter()
            result = {
                "kind": "query",
                "columns": [{"name": "echoed_sql", "type_name": "VARCHAR"}],
                "rows": [[sql]],
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            }
            write({"id": rid, "ok": True, "result": result})
        elif method == "list_databases":
            write({"id": rid, "ok": True, "result": ["echo_db"]})
        elif method == "list_tables":
            write({"id": rid, "ok": True, "result": ["echo_table"]})
        else:
            write({
                "id": rid,
                "ok": False,
                "error": {
                    "code": "UNKNOWN_METHOD",
                    "message": f"unknown method: {method}",
                    "retryable": False,
                },
            })


if __name__ == "__main__":
    main()
