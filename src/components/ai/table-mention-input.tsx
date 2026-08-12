import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCursorOffset, restoreCursor, type MentionItem, type TriggerConfig } from "@skyastrall/mentions-core";
import { Mentions, type MentionsHandle } from "@skyastrall/mentions-react";

import type { AgentMessageContent, AgentMessageResource } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  AGENT_RESOURCE_MARKUP,
  AGENT_RESOURCE_TRIGGER,
  agentResourceMentionItem,
  emptyAgentMessage,
  isAgentMessageEmpty,
  markupToMessage,
  messageToMarkup,
} from "@/lib/agent-message";

import { shouldSubmitPrompt } from "./prompt-input-keyboard";
import "./table-mention-input.css";

export interface TableMentionInputValue {
  message: AgentMessageContent;
  cursorOffset: number;
  isEmpty: boolean;
}

export interface TableMentionInputHandle {
  focus: () => void;
  clear: () => void;
  openResourcePicker: () => void;
}

export interface TableMentionInputProps {
  placeholder?: string;
  value: AgentMessageContent;
  cursorOffset: number;
  disabled?: boolean;
  submitEnabled?: boolean;
  className?: string;
  minHeightPx?: number;
  getResourceCandidates: (query: string) => Promise<AgentMessageResource[]>;
  onChange?: (value: TableMentionInputValue) => void;
  onSubmit?: (message: AgentMessageContent) => void;
  onCancel?: () => void;
  onOpenChange?: (open: boolean) => void;
  onOpenResource?: (resource: AgentMessageResource) => void;
}

function editorIn(container: HTMLElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".stela-table-mention__editor") ?? null;
}

function selectionBelongsTo(editor: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection?.anchorNode) return false;
  return selection.anchorNode === editor || editor.contains(selection.anchorNode);
}

/** Core offsets count pill labels; snap any restored range out of non-editable pill DOM. */
function restoreEditableCursor(editor: HTMLElement, offset: number): void {
  editor.focus();
  restoreCursor(editor, offset);
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!selection || !anchor) return;
  const anchorElement = anchor.nodeType === Node.ELEMENT_NODE
    ? anchor as Element
    : anchor.parentElement;
  const pill = anchorElement?.closest<HTMLElement>("mark[data-mention][contenteditable=false]");
  if (!pill || !editor.contains(pill)) return;
  const range = document.createRange();
  range.setStartAfter(pill);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const TableMentionInput = forwardRef<TableMentionInputHandle, TableMentionInputProps>(
  function TableMentionInput(
    {
      placeholder,
      value,
      cursorOffset,
      disabled = false,
      submitEnabled = true,
      className,
      minHeightPx = 28,
      getResourceCandidates,
      onChange,
      onSubmit,
      onCancel,
      onOpenChange,
      onOpenResource,
    },
    ref,
  ) {
    const mentionsRef = useRef<MentionsHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const openRef = useRef(false);
    const resourcesRef = useRef(new Map(value.resources.map((resource) => [resource.id, resource])));
    const emittedMarkupRef = useRef(messageToMarkup(value));
    const currentMessageRef = useRef(value);
    const savedCursorOffsetRef = useRef(cursorOffset);
    const restoreOffsetRef = useRef<number | null>(null);
    const [markup, setMarkup] = useState(emittedMarkupRef.current);
    const portalContainer = typeof document !== "undefined" ? document.body : undefined;

    const focusAtSavedCursor = useCallback(() => {
      const editor = editorIn(containerRef.current);
      if (!editor) return;
      if (!selectionBelongsTo(editor)) restoreEditableCursor(editor, savedCursorOffsetRef.current);
      else editor.focus();
    }, []);

    const syncCursor = useCallback(() => {
      const editor = editorIn(containerRef.current);
      const nextOffset = editor && selectionBelongsTo(editor)
        ? getCursorOffset(editor)
        : savedCursorOffsetRef.current;
      savedCursorOffsetRef.current = nextOffset;
      const message = currentMessageRef.current;
      onChange?.({ message, cursorOffset: nextOffset, isEmpty: isAgentMessageEmpty(message) });
    }, [onChange]);

    const trigger = useMemo<TriggerConfig>(() => ({
      char: AGENT_RESOURCE_TRIGGER,
      markup: AGENT_RESOURCE_MARKUP,
      minChars: 0,
      debounce: 40,
      maxSuggestions: 24,
      allowSpaceInQuery: true,
      color: "hsl(var(--primary) / 0.14)",
      data: async (query: string) => {
        const resources = await getResourceCandidates(query);
        for (const resource of resources) resourcesRef.current.set(resource.id, resource);
        return resources.map(agentResourceMentionItem);
      },
    }), [getResourceCandidates]);
    const triggers = useMemo(() => [trigger], [trigger]);

    useEffect(() => {
      for (const resource of value.resources) resourcesRef.current.set(resource.id, resource);
      const nextMarkup = messageToMarkup(value);
      currentMessageRef.current = value;
      savedCursorOffsetRef.current = cursorOffset;
      if (nextMarkup === emittedMarkupRef.current || nextMarkup === markup) return;
      emittedMarkupRef.current = nextMarkup;
      restoreOffsetRef.current = cursorOffset;
      setMarkup(nextMarkup);
    }, [cursorOffset, markup, value]);

    useEffect(() => {
      if (restoreOffsetRef.current === null) return;
      const offset = restoreOffsetRef.current;
      restoreOffsetRef.current = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const editor = editorIn(containerRef.current);
          if (editor) restoreEditableCursor(editor, offset);
        });
      });
    }, [markup]);

    const clear = useCallback(() => {
      resourcesRef.current.clear();
      emittedMarkupRef.current = "";
      currentMessageRef.current = emptyAgentMessage();
      savedCursorOffsetRef.current = 0;
      setMarkup("");
      onChange?.({ message: currentMessageRef.current, cursorOffset: 0, isEmpty: true });
    }, [onChange]);

    useImperativeHandle(ref, () => ({
      focus: focusAtSavedCursor,
      clear,
      openResourcePicker: () => {
        focusAtSavedCursor();
        mentionsRef.current?.insertTrigger(AGENT_RESOURCE_TRIGGER);
      },
    }), [clear, focusAtSavedCursor]);

    const submit = () => {
      if (disabled || !submitEnabled) return;
      const message = markupToMessage(markup, resourcesRef.current.values());
      if (!isAgentMessageEmpty(message)) onSubmit?.(message);
    };

    return (
      <div
        ref={containerRef}
        className={cn("stela-table-mention", disabled && "is-disabled", className)}
        style={{ minHeight: minHeightPx }}
        onCompositionStartCapture={() => { composingRef.current = true; }}
        onCompositionEndCapture={() => { composingRef.current = false; }}
        onMouseUpCapture={() => requestAnimationFrame(() => syncCursor())}
        onClickCapture={(event) => {
          const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>("mark[data-id]");
          const resource = mark ? resourcesRef.current.get(mark.dataset.id ?? "") : undefined;
          if (!resource || !onOpenResource) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenResource(resource);
        }}
        onKeyUpCapture={() => requestAnimationFrame(() => syncCursor())}
        onMouseDown={(event) => {
          if (disabled || (event.target as HTMLElement | null)?.closest(".stela-table-mention__editor")) return;
          event.preventDefault();
          focusAtSavedCursor();
        }}
        onKeyDownCapture={(event) => {
          if (shouldSubmitPrompt(event, composingRef.current)) {
            if (openRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            submit();
          } else if (event.key === "Escape" && !openRef.current && onCancel) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Mentions
          ref={mentionsRef}
          triggers={triggers}
          value={markup}
          disabled={disabled}
          onChange={(nextMarkup) => {
            emittedMarkupRef.current = nextMarkup;
            setMarkup(nextMarkup);
            const message = markupToMessage(nextMarkup, resourcesRef.current.values());
            currentMessageRef.current = message;
            const editor = editorIn(containerRef.current);
            const nextOffset = editor && selectionBelongsTo(editor)
              ? getCursorOffset(editor)
              : savedCursorOffsetRef.current;
            savedCursorOffsetRef.current = nextOffset;
            onChange?.({ message, cursorOffset: nextOffset, isEmpty: isAgentMessageEmpty(message) });
          }}
          onOpen={() => {
            openRef.current = true;
            onOpenChange?.(true);
          }}
          onClose={() => {
            openRef.current = false;
            onOpenChange?.(false);
          }}
        >
          <Mentions.Editor className="stela-table-mention__editor" placeholder={placeholder} disabled={disabled} />
          <Mentions.Portal container={portalContainer}>
            <Mentions.List className="stela-table-mention__list">
              <Mentions.Empty className="stela-table-mention__empty">—</Mentions.Empty>
              <Mentions.Item
                className="stela-table-mention__item"
                render={({ item }: { item: MentionItem }) => {
                  const resource = resourcesRef.current.get(item.id);
                  return resource ? (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`stela-resource-kind stela-resource-kind--${resource.kind}`}>{resource.kind}</span>
                      <span className="truncate">{resource.label}</span>
                    </span>
                  ) : <span>{item.label}</span>;
                }}
              />
            </Mentions.List>
          </Mentions.Portal>
        </Mentions>
      </div>
    );
  },
);
