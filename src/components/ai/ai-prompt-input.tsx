import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";

import {
  TableMentionInput,
  type TableMentionInputHandle as TableMentionInputRef,
} from "./table-mention-input";

export interface AiPromptSubmitPayload {
  text: string;
  mentionedTables: string[];
}

export interface AiPromptInputHandle {
  focus: () => void;
}

export interface AiPromptInputProps {
  placeholder?: string;
  initialValue?: string;
  disabled?: boolean;
  className?: string;
  /** 输入框最小高度（px）。contenteditable 仍会随内容自增，这里只定基础高度。 */
  minHeightPx?: number;
  /** Bump after send to clear and remount the mention editor. */
  resetToken?: number;
  getTableNamesCached?: () => string[];
  getTableNames: () => Promise<string[]>;
  onChange?: (payload: {
    text: string;
    mentionedTables: string[];
    isEmpty: boolean;
  }) => void;
  onSubmit?: (payload: AiPromptSubmitPayload) => void;
}

export const AiPromptInput = forwardRef<AiPromptInputHandle, AiPromptInputProps>(
  function AiPromptInput(
    {
      placeholder,
      initialValue,
      disabled = false,
      className,
      minHeightPx = 96,
      resetToken = 0,
      getTableNamesCached,
      getTableNames,
      onChange,
      onSubmit,
    },
    ref,
  ) {
    const inputRef = useRef<TableMentionInputRef>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    return (
      <TableMentionInput
        key={resetToken}
        ref={inputRef}
        placeholder={placeholder}
        initialValue={initialValue}
        disabled={disabled}
        className={className}
        minHeightPx={minHeightPx}
        getTableNamesCached={getTableNamesCached}
        getTableNames={getTableNames}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    );
  },
);
