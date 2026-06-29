import { filterTableNames } from "./sql-language";

const CHIP_CLASS = "stela-cb__ai-mention-chip";
const TEXT_INPUT_CLASS = "stela-cb__ai-mention-text";
const MENTION_RE = /(?:^|\s)@([\w.]+)/g;
const ACTIVE_MENTION_RE = /(?:^|\s)@([\w.]*)$/;

export interface ActiveTableMention {
  at: number;
  prefix: string;
}

export interface TableMentionInputOptions {
  placeholder?: string;
  initialValue?: string;
  /** 同步读本地缓存，用于立刻展示补全列表。 */
  getTableNamesCached?: () => string[];
  /** 后台刷新表名列表（可走 autocomplete cache）。 */
  getTableNames: () => Promise<string[]>;
  onChange?: () => void;
}

export interface TableMentionInputHandle {
  el: HTMLElement;
  getValue: () => string;
  getMentionedTables: () => string[];
  isEmpty: () => boolean;
  focus: () => void;
  setDisabled: (disabled: boolean) => void;
  isOpen: () => boolean;
  handleKeyDown: (ev: KeyboardEvent) => boolean;
  destroy: () => void;
}

/** 从纯文本里解析 `@db.table` / `@table` 引用。 */
export function parseMentionedTables(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const name = match[1]?.trim();
    if (name) out.add(name);
  }
  return Array.from(out);
}

export function getActiveMentionFromText(
  text: string,
  caret: number,
): ActiveTableMention | null {
  const before = text.slice(0, caret);
  const match = ACTIVE_MENTION_RE.exec(before);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { at: caret - prefix.length - 1, prefix };
}

function createChip(tableName: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = CHIP_CLASS;
  chip.dataset.table = tableName;
  chip.textContent = `@${tableName}`;
  return chip;
}

function createTextInput(placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = TEXT_INPUT_CLASS;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function serializeEditor(root: HTMLElement): string {
  let out = "";
  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLInputElement && child.classList.contains(TEXT_INPUT_CLASS)) {
      out += child.value;
    } else if (child instanceof HTMLElement && child.classList.contains(CHIP_CLASS)) {
      out += `@${child.dataset.table ?? ""}`;
    }
  }
  return out;
}

function getMentionedTablesFromEditor(root: HTMLElement): string[] {
  const tables: string[] = [];
  root.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}`).forEach((chip) => {
    const table = chip.dataset.table?.trim();
    if (table) tables.push(table);
  });
  return Array.from(new Set(tables));
}

function getTrailingInput(root: HTMLElement): HTMLInputElement | null {
  const last = root.lastElementChild;
  if (last instanceof HTMLInputElement && last.classList.contains(TEXT_INPUT_CLASS)) {
    return last;
  }
  return null;
}

export function createTableMentionInput(
  options: TableMentionInputOptions,
): TableMentionInputHandle {
  const root = document.createElement("div");
  root.className = "stela-cb__ai-mention-input";
  root.dataset.placeholder = options.placeholder ?? "";

  const menu = document.createElement("div");
  menu.className = "stela-cb__ai-mention-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");

  let tableNames = options.getTableNamesCached?.() ?? [];
  let refreshGeneration = 0;
  let activeIndex = 0;
  let open = false;
  let disposed = false;
  let activeInput: HTMLInputElement | null = null;
  const inputCleanups = new Map<HTMLInputElement, () => void>();

  const syncPlaceholder = () => {
    const empty = Boolean(
      root.children.length === 1 &&
        activeInput &&
        activeInput.value.length === 0 &&
        getMentionedTablesFromEditor(root).length === 0,
    );
    root.classList.toggle("stela-cb__ai-mention-input--empty", empty);
  };

  const closeMenu = () => {
    open = false;
    menu.hidden = true;
    menu.replaceChildren();
  };

  const positionMenu = () => {
    const anchor = activeInput ?? root;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.minWidth = `${Math.max(rect.width, 180)}px`;
  };

  const renderMenu = (items: string[], pending = false) => {
    menu.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "stela-cb__ai-mention-empty";
      empty.textContent = pending ? "…" : "—";
      menu.append(empty);
      return;
    }
    items.forEach((name, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "stela-cb__ai-mention-item";
      item.setAttribute("role", "option");
      item.dataset.name = name;
      item.textContent = name;
      if (idx === activeIndex) {
        item.classList.add("stela-cb__ai-mention-item--active");
        item.setAttribute("aria-selected", "true");
      }
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMention(name);
      });
      menu.append(item);
    });
  };

  const itemsForPrefix = (prefix: string): string[] => {
    if (prefix.length === 0) return tableNames.slice(0, 12);
    return filterTableNames(prefix, tableNames, 12);
  };

  const rerenderMenuIfActive = (pending = false) => {
    if (!open || menu.hidden || !activeInput) return;
    const caret = activeInput.selectionStart ?? activeInput.value.length;
    const mention = getActiveMentionFromText(activeInput.value, caret);
    if (!mention) {
      closeMenu();
      return;
    }
    const items = itemsForPrefix(mention.prefix);
    if (activeIndex >= items.length) activeIndex = 0;
    renderMenu(items, pending);
  };

  const refreshTableNamesInBackground = () => {
    const generation = ++refreshGeneration;
    void options.getTableNames().then((names) => {
      if (disposed || generation !== refreshGeneration) return;
      tableNames = names;
      rerenderMenuIfActive(false);
    });
  };

  const applyMention = (name: string) => {
    const input = activeInput ?? ensureTrailingInput();
    const caret = input.selectionStart ?? input.value.length;
    const mention = getActiveMentionFromText(input.value, caret);
    if (!mention) return;

    const before = input.value.slice(0, mention.at);
    const after = input.value.slice(caret);
    const frag = document.createDocumentFragment();

    if (before) {
      const beforeInput = createTextInput("");
      beforeInput.value = before;
      wireInput(beforeInput);
      frag.append(beforeInput);
    }

    frag.append(createChip(name));

    const afterInput = createTextInput("");
    afterInput.value = after.startsWith(" ") ? after.slice(1) : after;
    wireInput(afterInput);
    frag.append(afterInput);

    detachInput(input);
    input.replaceWith(frag);
    activeInput = afterInput;
    afterInput.focus();
    const caretPos = afterInput.value.length;
    afterInput.setSelectionRange(caretPos, caretPos);
    closeMenu();
    syncPlaceholder();
    options.onChange?.();
  };

  const refreshMenu = () => {
    const input = activeInput ?? ensureTrailingInput();
    const caret = input.selectionStart ?? input.value.length;
    const mention = getActiveMentionFromText(input.value, caret);
    if (!mention) {
      closeMenu();
      return;
    }
    open = true;
    menu.hidden = false;
    positionMenu();

    const cached = options.getTableNamesCached?.() ?? [];
    if (cached.length > 0) {
      tableNames = cached;
    }

    const items = itemsForPrefix(mention.prefix);
    if (activeIndex >= items.length) activeIndex = 0;
    renderMenu(items, tableNames.length === 0);
    refreshTableNamesInBackground();
  };

  const removePreviousChip = (input: HTMLInputElement): boolean => {
    if ((input.selectionStart ?? 0) !== 0 || input.value.length > 0) return false;
    const prev = input.previousElementSibling;
    if (!(prev instanceof HTMLElement) || !prev.classList.contains(CHIP_CLASS)) {
      return false;
    }
    prev.remove();
    const beforeInput = input.previousElementSibling;
    if (beforeInput instanceof HTMLInputElement && beforeInput.classList.contains(TEXT_INPUT_CLASS)) {
      const merged = beforeInput.value + input.value;
      detachInput(input);
      input.remove();
      beforeInput.value = merged;
      beforeInput.focus();
      const pos = beforeInput.value.length;
      beforeInput.setSelectionRange(pos, pos);
      activeInput = beforeInput;
    }
    syncPlaceholder();
    options.onChange?.();
    return true;
  };

  const onInput = () => {
    activeIndex = 0;
    syncPlaceholder();
    refreshMenu();
    options.onChange?.();
  };

  const onKeyDown = (ev: KeyboardEvent): boolean => {
    const input = activeInput;
    if (!input) return false;

    ev.stopPropagation();

    if (ev.key === "Backspace" && removePreviousChip(input)) {
      ev.preventDefault();
      return true;
    }

    if (!open || menu.hidden) return false;
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(".stela-cb__ai-mention-item"),
    );
    if (items.length === 0) return false;

    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      renderMenu(items.map((item) => item.dataset.name ?? ""));
      return true;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      renderMenu(items.map((item) => item.dataset.name ?? ""));
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      const selected = items[activeIndex]?.dataset.name;
      if (selected) {
        ev.preventDefault();
        applyMention(selected);
        return true;
      }
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenu();
      return true;
    }
    return false;
  };

  const detachInput = (input: HTMLInputElement) => {
    const cleanup = inputCleanups.get(input);
    cleanup?.();
    inputCleanups.delete(input);
  };

  const wireInput = (input: HTMLInputElement) => {
    detachInput(input);
    const handleInput = () => onInput();
    const handleKeyDown = (ev: KeyboardEvent) => {
      activeInput = input;
      onKeyDown(ev);
    };
    const handleFocus = () => {
      activeInput = input;
      activeIndex = 0;
      refreshMenu();
    };
    const stopBubble = (ev: Event) => {
      ev.stopPropagation();
    };
    input.addEventListener("input", handleInput);
    input.addEventListener("keydown", handleKeyDown);
    input.addEventListener("focus", handleFocus);
    input.addEventListener("keyup", stopBubble);
    input.addEventListener("keypress", stopBubble);
    inputCleanups.set(input, () => {
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleKeyDown);
      input.removeEventListener("focus", handleFocus);
      input.removeEventListener("keyup", stopBubble);
      input.removeEventListener("keypress", stopBubble);
    });
  };

  const ensureTrailingInput = (): HTMLInputElement => {
    const existing = getTrailingInput(root);
    if (existing) {
      activeInput = existing;
      return existing;
    }
    const input = createTextInput(options.placeholder ?? "");
    wireInput(input);
    root.append(input);
    activeInput = input;
    syncPlaceholder();
    return input;
  };

  const onRootClick = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (target?.classList.contains(CHIP_CLASS)) return;
    if (target instanceof HTMLInputElement) return;
    ensureTrailingInput().focus();
  };

  const onBlur = () => {
    window.setTimeout(() => {
      if (disposed) return;
      if (!menu.matches(":hover")) closeMenu();
    }, 120);
  };

  root.addEventListener("click", onRootClick);
  root.addEventListener("blur", onBlur, true);
  window.addEventListener("scroll", positionMenu, true);
  window.addEventListener("resize", positionMenu);
  document.body.append(menu);

  const initial = ensureTrailingInput();
  if (options.initialValue) {
    initial.value = options.initialValue;
  }
  syncPlaceholder();

  if (tableNames.length === 0) {
    refreshTableNamesInBackground();
  }

  return {
    el: root,
    getValue: () => serializeEditor(root).trim(),
    getMentionedTables: () => getMentionedTablesFromEditor(root),
    isEmpty: () => serializeEditor(root).trim().length === 0,
    focus: () => {
      const input = ensureTrailingInput();
      input.focus({ preventScroll: true });
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    },
    setDisabled: (disabled: boolean) => {
      root.classList.toggle("stela-cb__ai-mention-input--disabled", disabled);
      for (const child of Array.from(root.children)) {
        if (child instanceof HTMLInputElement) {
          child.disabled = disabled;
        }
      }
    },
    isOpen: () => open && !menu.hidden,
    handleKeyDown: (ev: KeyboardEvent) => {
      if (!activeInput) return false;
      return onKeyDown(ev);
    },
    destroy: () => {
      disposed = true;
      for (const input of Array.from(inputCleanups.keys())) {
        detachInput(input);
      }
      root.removeEventListener("click", onRootClick);
      root.removeEventListener("blur", onBlur, true);
      window.removeEventListener("scroll", positionMenu, true);
      window.removeEventListener("resize", positionMenu);
      menu.remove();
    },
  };
}
