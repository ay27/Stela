/**
 * IConnectorRegistry 实现（Electron 适配）。
 *
 * Renderer 只通过 preload 暴露的 `window.stela.connector` typed bridge
 * 调用 main 进程 connector registry。
 */

import type {
  ConnectorKindMeta,
  IConnectorRegistry,
  QueryResult,
  TestResult,
} from "@/contracts";

export const electronConnectorRegistry: IConnectorRegistry = {
  async listKinds(): Promise<ConnectorKindMeta[]> {
    return window.stela.connector.listKinds();
  },
  async test(kind: string, config: unknown): Promise<TestResult> {
    return window.stela.connector.test(kind, config);
  },
  async execute(
    kind: string,
    config: unknown,
    sql: string,
  ): Promise<QueryResult> {
    return window.stela.connector.execute(kind, config, sql);
  },
  async listDatabases(kind: string, config: unknown): Promise<string[]> {
    return window.stela.connector.listDatabases(kind, config);
  },
  async listTables(
    kind: string,
    config: unknown,
    db?: string,
  ): Promise<string[]> {
    return window.stela.connector.listTables(kind, config, db ?? null);
  },
};
