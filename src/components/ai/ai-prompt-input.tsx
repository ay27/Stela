import { forwardRef, useImperativeHandle, useRef } from "react";

import type { AgentMessageContent, AgentMessageResource } from "@shared/types";
import {
  TableMentionInput,
  type TableMentionInputHandle,
  type TableMentionInputValue,
} from "./table-mention-input";

export interface AiPromptSubmitPayload {
  message: AgentMessageContent;
}

export interface AiPromptInputHandle {
  focus: () => void;
  openResourcePicker: () => void;
}

export interface AiPromptInputProps {
  placeholder?: string;
  value: AgentMessageContent;
  cursorOffset: number;
  disabled?: boolean;
  submitEnabled?: boolean;
  className?: string;
  minHeightPx?: number;
  resetToken?: number;
  getResourceCandidates: (query: string) => Promise<AgentMessageResource[]>;
  onChange?: (payload: TableMentionInputValue) => void;
  onSubmit?: (payload: AiPromptSubmitPayload) => void;
  onOpenResource?: (resource: AgentMessageResource) => void;
}

export const AiPromptInput = forwardRef<AiPromptInputHandle, AiPromptInputProps>(
  function AiPromptInput(props, ref) {
    const inputRef = useRef<TableMentionInputHandle>(null);
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      openResourcePicker: () => inputRef.current?.openResourcePicker(),
    }));
    return (
      <TableMentionInput
        key={props.resetToken}
        ref={inputRef}
        {...props}
        onSubmit={(message) => props.onSubmit?.({ message })}
      />
    );
  },
);
