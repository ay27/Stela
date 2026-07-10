import { createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  TableMentionInput,
  type TableMentionInputHandle as ReactTableMentionInputHandle,
  type TableMentionInputSubmitPayload,
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
  onSubmit?: (payload: TableMentionInputSubmitPayload) => void;
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
  let value: TableMentionInputValue = {
    text: options.initialValue?.trim() ?? "",
    mentionedTables: [],
    referencedNotes: [],
    isEmpty: (options.initialValue?.trim() ?? "").length === 0,
  };

  const render = () => {
    if (destroyed) return;
    root.render(
      createElement(TableMentionInput, {
        ref,
        placeholder: options.placeholder,
        initialValue: options.initialValue,
        disabled,
        minHeightPx: options.minHeightPx,
        getTableNamesCached: options.getTableNamesCached,
        getTableNames: options.getTableNames,
        onChange: (next: TableMentionInputValue) => {
          value = next;
          options.onChange?.();
        },
        onSubmit: options.onSubmit,
        onCancel: options.onCancel,
        onOpenChange: (nextOpen: boolean) => {
          open = nextOpen;
        },
      }),
    );
  };

  render();

  return {
    el: host,
    getValue: () => value.text,
    getMentionedTables: () => value.mentionedTables,
    isEmpty: () => value.isEmpty,
    isOpen: () => open,
    focus: () => ref.current?.focus(),
    setDisabled: (nextDisabled: boolean) => {
      disabled = nextDisabled;
      render();
    },
    destroy: () => {
      destroyed = true;
      root.unmount();
    },
  };
}
