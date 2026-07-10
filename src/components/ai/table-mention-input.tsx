import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  Mentions,
  extractMentions,
  parseMarkup,
  type MentionItem,
  type MentionsHandle,
  type TriggerConfig,
} from "@skyastrall/mentions-react";

import { cn } from "@/lib/utils";
import { fuzzyFilter } from "@/lib/fuzzy";

import { shouldSubmitPrompt } from "./prompt-input-keyboard";
import "./table-mention-input.css";

const TABLE_TRIGGER = "@";
const TABLE_MARKUP = "@[__display__](__id__)";
const NOTE_TRIGGER = "[[";
const NOTE_MARKUP = "[[__display__]](__id__)";

export interface TableMentionInputValue {
  text: string;
  mentionedTables: string[];
  referencedNotes: string[];
  isEmpty: boolean;
}

export interface TableMentionInputSubmitPayload {
  text: string;
  mentionedTables: string[];
  referencedNotes: string[];
}

export interface TableMentionInputHandle {
  focus: () => void;
  clear: () => void;
  getValue: () => TableMentionInputValue;
  setDisabled?: (disabled: boolean) => void;
}

export interface TableMentionInputProps {
  placeholder?: string;
  initialValue?: string;
  disabled?: boolean;
  className?: string;
  minHeightPx?: number;
  getTableNamesCached?: () => string[];
  getTableNames: () => Promise<string[]>;
  getNoteCandidates?: (query: string) => Promise<MentionItem[]>;
  onChange?: (value: TableMentionInputValue) => void;
  onSubmit?: (payload: TableMentionInputSubmitPayload) => void;
  onCancel?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function tableItems(names: string[]): MentionItem[] {
  return unique(names).map((name) => ({ id: name, label: name }));
}

function hasVisibleMentionList(): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-mentions-portal] .stela-table-mention__list"),
  ).some((el) => el.getClientRects().length > 0);
}

function serializeMarkup(markup: string, triggers: TriggerConfig[]): TableMentionInputValue {
  const segments = parseMarkup(markup, triggers);
  const text = segments
    .map((segment) => {
      if (segment.type !== "mention") return segment.text;
      if (segment.trigger === TABLE_TRIGGER) return `${segment.trigger}${segment.id}`;
      return "";
    })
    .join("")
    .trim();
  const mentions = extractMentions(markup, triggers);
  const mentionedTables = unique(
    mentions
      .filter((item) => item.trigger === TABLE_TRIGGER)
      .map((item) => item.id),
  );
  const referencedNotes = unique(
    mentions
      .filter((item) => item.trigger === NOTE_TRIGGER)
      .map((item) => item.id),
  );
  return { text, mentionedTables, referencedNotes, isEmpty: text.length === 0 };
}

export const TableMentionInput = forwardRef<TableMentionInputHandle, TableMentionInputProps>(
  function TableMentionInput(
    {
      placeholder,
      initialValue = "",
      disabled = false,
      className,
      minHeightPx = 28,
      getTableNamesCached,
      getTableNames,
      getNoteCandidates,
      onChange,
      onSubmit,
      onCancel,
      onOpenChange,
    },
    ref,
  ) {
    const mentionsRef = useRef<MentionsHandle>(null);
    const composingRef = useRef(false);
    const openRef = useRef(false);
    const tableNamesRef = useRef<string[]>(getTableNamesCached?.() ?? []);
    const valueRef = useRef<TableMentionInputValue>({
      text: initialValue.trim(),
      mentionedTables: [],
      referencedNotes: [],
      isEmpty: initialValue.trim().length === 0,
    });

    useEffect(() => {
      let cancelled = false;
      tableNamesRef.current = getTableNamesCached?.() ?? [];
      void getTableNames()
        .then((names) => {
          if (!cancelled) tableNamesRef.current = names;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [getTableNamesCached, getTableNames]);

    const triggers = useMemo<TriggerConfig[]>(
      () => [
        {
          char: TABLE_TRIGGER,
          markup: TABLE_MARKUP,
          minChars: 0,
          debounce: 0,
          maxSuggestions: 12,
          color: "hsl(var(--primary) / 0.14)",
          data: (query) => {
            const cached = getTableNamesCached?.() ?? [];
            if (cached.length > 0) tableNamesRef.current = cached;
            const names = tableNamesRef.current;
            const needle = query.trim();
            const matched = needle ? fuzzyFilter(needle, names, (name) => name, 12) : names.slice(0, 12);
            return Promise.resolve(tableItems(matched));
          },
        },
        ...(getNoteCandidates
          ? [
              {
                char: NOTE_TRIGGER,
                markup: NOTE_MARKUP,
                minChars: 0,
                debounce: 80,
                maxSuggestions: 12,
                color: "hsl(var(--accent) / 0.55)",
                data: (query: string) => getNoteCandidates(query),
              },
            ]
          : []),
      ],
      [getTableNamesCached, getNoteCandidates],
    );

    const syncValue = (markup: string): TableMentionInputValue => {
      const next = serializeMarkup(markup, triggers);
      valueRef.current = next;
      onChange?.(next);
      return next;
    };

    useImperativeHandle(ref, () => ({
      focus: () => mentionsRef.current?.focus(),
      clear: () => {
        mentionsRef.current?.clear();
        syncValue("");
      },
      getValue: () => valueRef.current,
    }));

    useEffect(() => {
      const next = serializeMarkup(initialValue, triggers);
      valueRef.current = next;
    }, [initialValue, triggers]);

    const submit = () => {
      if (disabled) return;
      const current = valueRef.current;
      if (current.isEmpty) return;
      onSubmit?.({
        text: current.text,
        mentionedTables: current.mentionedTables,
        referencedNotes: current.referencedNotes,
      });
    };

    return (
      <div
        className={cn("stela-table-mention", disabled && "is-disabled", className)}
        style={{ minHeight: minHeightPx }}
        onCompositionStartCapture={() => {
          composingRef.current = true;
        }}
        onCompositionEndCapture={() => {
          composingRef.current = false;
        }}
        onMouseDown={(ev) => {
          if (disabled) return;
          const target = ev.target as HTMLElement | null;
          if (target?.closest(".stela-table-mention__editor")) return;
          ev.preventDefault();
          mentionsRef.current?.focus();
        }}
        onKeyDownCapture={(ev) => {
          if (shouldSubmitPrompt(ev, composingRef.current)) {
            if (openRef.current && hasVisibleMentionList()) return;
            openRef.current = false;
            ev.preventDefault();
            ev.stopPropagation();
            submit();
            return;
          }
          if (ev.key === "Escape") {
            if (openRef.current && hasVisibleMentionList()) {
              openRef.current = false;
              return;
            }
            openRef.current = false;
          }
          if (ev.key === "Escape" && onCancel) {
            ev.preventDefault();
            ev.stopPropagation();
            onCancel();
          }
        }}
        onKeyDown={(ev) => {
          ev.stopPropagation();
        }}
      >
        <Mentions
          ref={mentionsRef}
          triggers={triggers}
          defaultValue={initialValue}
          disabled={disabled}
          onChange={(markup) => {
            syncValue(markup);
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
          <Mentions.Editor
            className="stela-table-mention__editor"
            placeholder={placeholder}
            disabled={disabled}
          />
          <Mentions.Portal>
            <Mentions.List className="stela-table-mention__list">
              <Mentions.Empty className="stela-table-mention__empty">—</Mentions.Empty>
              <Mentions.Item
                className="stela-table-mention__item"
                render={({ item }) => <span>{item.label}</span>}
              />
            </Mentions.List>
          </Mentions.Portal>
        </Mentions>
      </div>
    );
  },
);
