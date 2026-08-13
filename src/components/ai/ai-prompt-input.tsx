import { forwardRef, useImperativeHandle, useRef } from "react";
import type { EditorState } from "@milkdown/prose/state";

import type { AgentMessageContent, AgentMessageResource } from "@shared/types";
import {
  AgentComposerInput,
  type AgentComposerInputHandle,
} from "./agent-composer-input";

export interface AiPromptSubmitPayload {
  message: AgentMessageContent;
}

export interface AiPromptInputHandle {
  focus: () => void;
}

export interface AiPromptInputProps {
  placeholder?: string;
  state: EditorState;
  disabled?: boolean;
  submitEnabled?: boolean;
  className?: string;
  minHeightPx?: number;
  getResourceCandidates: (query: string) => Promise<AgentMessageResource[]>;
  onChange?: (state: EditorState, isEmpty: boolean) => void;
  onSubmit?: (payload: AiPromptSubmitPayload) => void;
  onOpenResource?: (resource: AgentMessageResource) => void;
}

export const AiPromptInput = forwardRef<AiPromptInputHandle, AiPromptInputProps>(
  function AiPromptInput(props, ref) {
    const inputRef = useRef<AgentComposerInputHandle>(null);
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));
    return (
      <AgentComposerInput
        ref={inputRef}
        {...props}
        onSubmit={(message) => props.onSubmit?.({ message })}
      />
    );
  },
);
