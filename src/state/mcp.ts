/**
 * MCP server 状态（Zustand）—— Settings UI 用。
 */

import { create } from "zustand";

import type { McpConfigSnippet, McpStatus } from "@shared/types";

const DEFAULT_STATUS: McpStatus = {
  state: "stopped",
  enabled: false,
  pid: null,
  uptimeMs: null,
  lastError: null,
  toolCount: 0,
};

interface McpState {
  status: McpStatus;
  logs: string[];
  snippet: McpConfigSnippet | null;
  loading: boolean;
  error: string | null;

  refreshStatus: () => Promise<void>;
  refreshLogs: () => Promise<void>;
  refreshSnippet: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  clearLogs: () => Promise<void>;
}

export const useMcp = create<McpState>((set, get) => ({
  status: DEFAULT_STATUS,
  logs: [],
  snippet: null,
  loading: false,
  error: null,

  async refreshStatus() {
    try {
      const status = await window.stela.mcp.getStatus();
      set({ status });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshLogs() {
    try {
      const logs = await window.stela.mcp.getLogs(200);
      set({ logs });
    } catch (err) {
      console.error("[stela] mcp.getLogs failed", err);
    }
  },

  async refreshSnippet() {
    try {
      const snippet = await window.stela.mcp.getConfigSnippet();
      set({ snippet });
    } catch (err) {
      set({
        snippet: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async start() {
    set({ loading: true, error: null });
    try {
      await window.stela.mcp.start();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
      void get().refreshStatus();
      void get().refreshLogs();
    }
  },

  async stop() {
    set({ loading: true, error: null });
    try {
      await window.stela.mcp.stop();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
      void get().refreshStatus();
      void get().refreshLogs();
    }
  },

  async clearLogs() {
    try {
      await window.stela.mcp.clearLogs();
    } finally {
      void get().refreshLogs();
    }
  },
}));
