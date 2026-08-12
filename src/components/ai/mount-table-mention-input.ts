import { createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { agentMessagePlainText, withAgentResourceId } from "@shared/agent-message";
import type { AgentMessageContent } from "@shared/types";
import {
  TableMentionInput,
  type TableMentionInputHandle as ReactTableMentionInputHandle,
  type TableMentionInputValue,
} from "./table-mention-input";

export interface MountedTableMentionInputHandle {
  el: HTMLElement;
  getValue: () => string;
  getMentionedTables: () => string[];
  isEmpty: () => boolean;
  isOpen: () => boolean;
  focus: () => void;
  setDisabled: (disabled: boolean) => void;
  destroy: () => void;
}

export interface MountTableMentionInputOptions {
  placeholder?: string;
  initialValue?: string;
  minHeightPx?: number;
  getTableNamesCached?: () => string[];
  getTableNames: () => Promise<string[]>;
  onChange?: () => void;
  onSubmit?: (message: AgentMessageContent) => void;
  onCancel?: () => void;
}

export function mountTableMentionInput(
  host: HTMLElement,
  options: MountTableMentionInputOptions,
): MountedTableMentionInputHandle {
  const root: Root = createRoot(host);
  const ref = createRef<ReactTableMentionInputHandle>();
  let destroyed = false;
  let disabled = false;
  let open = false;
  let cursorOffset = options.initialValue?.length ?? 0;
  let message: AgentMessageContent = {
    version: 1,
    segments: options.initialValue ? [{ kind: "text", text: options.initialValue }] : [],
    resources: [],
  };

  const render = () => {
    if (destroyed) return;
    root.render(createElement(TableMentionInput, {
      ref,
      placeholder: options.placeholder,
      value: message,
      cursorOffset,
      disabled,
      minHeightPx: options.minHeightPx,
      getResourceCandidates: async (query: string) => {
        const cached = options.getTableNamesCached?.() ?? [];
        const names = cached.length > 0 ? cached : await options.getTableNames();
        const needle = query.trim().toLowerCase();
        return names
          .filter((name) => !needle || name.toLowerCase().includes(needle))
          .slice(0, 24)
          .map((table) => withAgentResourceId({ kind: "table", label: table, table }));
      },
      onChange: (next: TableMentionInputValue) => {
        message = next.message;
        cursorOffset = next.cursorOffset;
        options.onChange?.();
      },
      onSubmit: options.onSubmit,
      onCancel: options.onCancel,
      onOpenChange: (nextOpen: boolean) => { open = nextOpen; },
    }));
  };

  render();
  return {
    el: host,
    getValue: () => agentMessagePlainText(message),
    getMentionedTables: () => message.resources.flatMap((resource) =>
      resource.kind === "table" ? [resource.table] : []),
    isEmpty: () => !message.segments.some((segment) =>
      segment.kind === "resource" || segment.text.trim().length > 0),
    isOpen: () => open,
    focus: () => ref.current?.focus(),
    setDisabled: (nextDisabled: boolean) => { disabled = nextDisabled; render(); },
    destroy: () => { destroyed = true; root.unmount(); },
  };
}
