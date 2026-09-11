import { forwardRef } from "react";
import type { AgentMessageContent } from "@shared/types";
import { AgentComposerInput, type AgentComposerInputHandle, type AgentComposerInputProps } from "./agent-composer-input";
export interface AiPromptSubmitPayload { message: AgentMessageContent }
export type AiPromptInputHandle = AgentComposerInputHandle;
export interface AiPromptInputProps extends Omit<AgentComposerInputProps, "onSubmit"> { onSubmit?: (payload: AiPromptSubmitPayload) => void }
export const AiPromptInput = forwardRef<AiPromptInputHandle, AiPromptInputProps>(function AiPromptInput(props, ref) {
  return <AgentComposerInput {...props} ref={ref} onSubmit={message => props.onSubmit?.({ message })} />;
});
