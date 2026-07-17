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
const NOTE_MENTION_COLOR = "hsl(48 96% 89%)";
const PORTAL_GAP_PX = 4;
const PORTAL_MARGIN_PX = 8;

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

/** Clamp/flip mentions portal so the list stays inside the app window. */
function clampMentionsPortal(
  portal: HTMLElement,
  caretBottomAnchor: { current: number | null },
  resetAnchor: boolean,
): void {
  const rect = portal.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = Number.parseFloat(portal.style.top);
  let left = Number.parseFloat(portal.style.left);
  if (!Number.isFinite(top)) top = rect.top;
  if (!Number.isFinite(left)) left = rect.left;

  // Library places portal at caret.bottom + GAP. Remember that anchor so resize
  // after a flip does not treat the flipped top as a new caret position.
  if (resetAnchor || caretBottomAnchor.current == null) {
    caretBottomAnchor.current = top - PORTAL_GAP_PX;
  }
  const caretBottom = caretBottomAnchor.current;
  const spaceBelow = vh - caretBottom - PORTAL_MARGIN_PX;
  if (rect.height > spaceBelow && caretBottom - PORTAL_GAP_PX - rect.height >= PORTAL_MARGIN_PX) {
    top = caretBottom - PORTAL_GAP_PX - rect.height;
  } else {
    top = Math.min(caretBottom + PORTAL_GAP_PX, vh - rect.height - PORTAL_MARGIN_PX);
    top = Math.max(PORTAL_MARGIN_PX, top);
  }

  left = Math.min(left, vw - rect.width - PORTAL_MARGIN_PX);
  left = Math.max(PORTAL_MARGIN_PX, left);

  if (portal.style.top !== `${top}px`) portal.style.top = `${top}px`;
  if (portal.style.left !== `${left}px`) portal.style.left = `${left}px`;
}

function attachMentionsPortalClamp(): () => void {
  let cancelled = false;
  let portal: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let styleObserver: MutationObserver | null = null;
  let clampRaf = 0;
  let findRaf = 0;
  let attempts = 0;
  const caretBottomAnchor: { current: number | null } = { current: null };
  let pendingResetAnchor = true;

  const runClamp = () => {
    if (!portal || cancelled) return;
    const reset = pendingResetAnchor;
    pendingResetAnchor = false;
    // Avoid MutationObserver feedback while we rewrite top/left.
    styleObserver?.disconnect();
    try {
      clampMentionsPortal(portal, caretBottomAnchor, reset);
    } finally {
      if (portal && !cancelled) {
        styleObserver?.observe(portal, { attributes: true, attributeFilter: ["style"] });
      }
    }
  };

  const scheduleClamp = (resetAnchor = false) => {
    if (!portal || cancelled) return;
    if (resetAnchor) pendingResetAnchor = true;
    if (clampRaf) cancelAnimationFrame(clampRaf);
    clampRaf = requestAnimationFrame(() => {
      clampRaf = 0;
      runClamp();
    });
  };

  const bindPortal = (el: HTMLElement) => {
    portal = el;
    resizeObserver = new ResizeObserver(() => scheduleClamp(false));
    resizeObserver.observe(el);
    styleObserver = new MutationObserver(() => scheduleClamp(true));
    styleObserver.observe(el, { attributes: true, attributeFilter: ["style"] });
    scheduleClamp(true);
  };

  const findAndBind = () => {
    if (cancelled || portal) return;
    const el = document.querySelector<HTMLElement>("[data-mentions-portal]");
    if (el) {
      bindPortal(el);
      return;
    }
    if (++attempts < 30) {
      findRaf = requestAnimationFrame(findAndBind);
    }
  };

  findAndBind();

  return () => {
    cancelled = true;
    if (clampRaf) cancelAnimationFrame(clampRaf);
    if (findRaf) cancelAnimationFrame(findRaf);
    resizeObserver?.disconnect();
    styleObserver?.disconnect();
  };
}

function serializeMarkup(markup: string, triggers: TriggerConfig[]): TableMentionInputValue {
  const segments = parseMarkup(markup, triggers);
  // 表 → `@id`；笔记 → `[[id]]`（id 即 vault 路径）。必须上屏，否则用户以为没发出去。
  // 正文仍不嵌文件内容——路径走 referencedNotes，由模型 read_note（ADR-0016）。
  const text = segments
    .map((segment) => {
      if (segment.type !== "mention") return segment.text;
      if (segment.trigger === TABLE_TRIGGER) return `${segment.trigger}${segment.id}`;
      if (segment.trigger === NOTE_TRIGGER) return `[[${segment.id}]]`;
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
  return {
    text,
    mentionedTables,
    referencedNotes,
    isEmpty: text.length === 0 && referencedNotes.length === 0,
  };
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
    const clampCleanupRef = useRef<(() => void) | null>(null);
    const tableNamesRef = useRef<string[]>(getTableNamesCached?.() ?? []);
    const valueRef = useRef<TableMentionInputValue>({
      text: initialValue.trim(),
      mentionedTables: [],
      referencedNotes: [],
      isEmpty: initialValue.trim().length === 0,
    });
    const portalContainer = typeof document !== "undefined" ? document.body : undefined;

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

    useEffect(
      () => () => {
        clampCleanupRef.current?.();
        clampCleanupRef.current = null;
      },
      [],
    );

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
                color: NOTE_MENTION_COLOR,
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
            clampCleanupRef.current?.();
            clampCleanupRef.current = attachMentionsPortalClamp();
          }}
          onClose={() => {
            openRef.current = false;
            onOpenChange?.(false);
            clampCleanupRef.current?.();
            clampCleanupRef.current = null;
          }}
        >
          <Mentions.Editor
            className="stela-table-mention__editor"
            placeholder={placeholder}
            disabled={disabled}
          />
          <Mentions.Portal container={portalContainer}>
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
