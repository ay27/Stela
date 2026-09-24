import { useEffect, useRef, useState } from "react";
import { History, Plus, MoreHorizontal, X, Loader2 } from "lucide-react";
import { useChatWorkspace } from "@/state/chat-workspace";
import { useConversation } from "@/state/conversation";
import { useT } from "@/i18n/use-t";
import type { AgentHistorySummary } from "@shared/types";
import { chatHistoryItems, chatTabTitle } from "./chat-history";

export function ChatControls({ path, side = false }: { path?: string; side?: boolean }) {
  const t = useT();
  const workspace = useChatWorkspace();
  const snapshots = useConversation(s => s.snapshots);
  const snapshot = path ? snapshots[path] : undefined;
  const [legacy, setLegacy] = useState<AgentHistorySummary[]>([]);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [directory, setDirectory] = useState("Chats");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDetailsElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const busy = snapshot?.document.turns.some(turn => turn.status === "running");
  useEffect(() => {
    const menus = [history.current, more.current];
    const dismissOutside = (event: Event) => {
      for (const menu of menus) if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const menu of menus) if (menu?.open) { event.preventDefault(); menu.open = false; menu.querySelector("summary")?.focus(); }
    };
    const dismiss = () => { for (const menu of menus) if (menu) menu.open = false; };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", dismiss);
    };
  }, [!!path]);
  useEffect(() => {
    const strip = tabs.current;
    const active = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !active) return;
    if (active.offsetLeft < strip.scrollLeft) strip.scrollLeft = active.offsetLeft;
    else if (active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = active.offsetLeft + active.offsetWidth - strip.clientWidth;
  }, [path, workspace.sidePaths]);
  const perform = (action: () => Promise<unknown>) => { setError(""); useChatWorkspace.setState({ error: "" }); void action().catch(e => setError(String(e))); };
  const refresh = () => perform(async () => {
    setLoading(true);
    try { await workspace.refresh(); setLegacy(await window.stela.agent.listHistory()); }
    finally { setLoading(false); }
  });
  const select = (action: () => Promise<unknown>) => { if (history.current) history.current.open = false; perform(action); };
  const items = chatHistoryItems(workspace.recent, legacy, workspace.vault).filter(item => `${item.title} ${item.directory ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className={`stela-chat-controls ${side ? "stela-chat-controls-side" : ""} relative flex min-w-0 flex-none flex-wrap items-center border-b border-border/50 text-xs`}>
    {side && <div ref={tabs} role="tablist" aria-label={t("chat.tabs")} className="relative flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {workspace.sidePaths.map(tabPath => {
        const label = chatTabTitle(snapshots[tabPath], tabPath);
        return <div key={tabPath} className={`stela-chat-tab group flex h-8 min-w-0 max-w-40 shrink-0 items-center rounded-lg ${tabPath === path ? "is-active bg-background" : ""}`}>
          <button role="tab" aria-selected={tabPath === path} tabIndex={tabPath === path ? 0 : -1} title={label}
            onClick={() => workspace.move(tabPath, "side")}
            onKeyDown={event => {
              const index = workspace.sidePaths.indexOf(tabPath);
              const next = event.key === "ArrowRight" ? (index + 1) % workspace.sidePaths.length : event.key === "ArrowLeft" ? (index - 1 + workspace.sidePaths.length) % workspace.sidePaths.length : event.key === "Home" ? 0 : event.key === "End" ? workspace.sidePaths.length - 1 : -1;
              if (next >= 0) { event.preventDefault(); tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus(); }
            }} className="flex min-w-0 items-center gap-1 px-2 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary">
            {snapshots[tabPath]?.document.turns.some(turn => turn.status === "running") && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
            <span className="truncate">{label}</span>
          </button>
          <button aria-label={`${t("chat.close")} ${label}`} title={t("chat.close")} onClick={() => workspace.close(tabPath)} className="mr-1 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"><X size={12} /></button>
        </div>;
      })}
    </div>}
    {!side && <div className="flex-1" />}
    <div className="ml-auto flex h-9 shrink-0 items-center gap-0.5 px-1">
      <button title={t("conversation.new")} aria-label={t("conversation.new")} className="rounded p-1.5 hover:bg-muted" onClick={() => perform(() => workspace.create(side ? "side" : "main"))}><Plus size={14} /></button>
      <details ref={history} onToggle={event => { if (event.currentTarget.open) { setQuery(""); setLimit(50); refresh(); search.current?.focus(); } }}>
        <summary title={t("chat.history")} aria-label={t("chat.history")} className="cursor-pointer list-none rounded p-1.5 hover:bg-muted"><History size={14} /></summary>
        <div className="absolute right-1 top-full z-50 flex max-h-[70vh] w-[min(20rem,calc(100vw-2rem))] flex-col rounded border border-border bg-popover shadow-lg">
          <input ref={search} value={query} placeholder={t("chat.searchHistory")} aria-label={t("chat.searchHistory")} onChange={event => { setQuery(event.target.value); setLimit(50); }} className="m-2 rounded border border-border bg-background px-2 py-1.5 outline-none focus:border-primary" />
          <div className="min-h-0 overflow-y-auto p-1">
            {loading && <p className="p-2 text-muted-foreground">{t("chat.loadingHistory")}</p>}
            {!loading && !items.length && <p className="p-2 text-muted-foreground">{t("chat.noHistory")}</p>}
            {items.slice(0, limit).map(item => <button key={item.key} className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted" title={item.directory ? `${item.directory}/${item.title}` : item.title} onClick={() => select(() => item.path ? workspace.show(item.path, side ? "side" : "main") : workspace.importLegacy(item.legacy!, side ? "side" : "main"))}>
              <span className="block truncate">{item.title}</span>{item.directory && <span className="block truncate text-[10px] text-muted-foreground">{item.directory}</span>}
            </button>)}
            {items.length > limit && <button className="w-full p-2 text-muted-foreground hover:bg-muted" onClick={() => setLimit(limit + 50)}>{t("chat.showMore")}</button>}
          </div>
          <p className="border-t border-border px-3 py-2 text-[10px] leading-4 text-muted-foreground">{t("chat.historyHelp")}</p>
        </div>
      </details>
      {path && <details ref={more} className="relative">
        <summary title={t("chat.more")} aria-label={t("chat.more")} className="cursor-pointer list-none rounded p-1.5 hover:bg-muted"><MoreHorizontal size={14} /></summary>
        <div className="absolute right-0 top-8 z-50 w-48 rounded border border-border bg-popover p-1 shadow-lg">
          <button className="block w-full rounded px-2 py-2 text-left hover:bg-muted" onClick={() => { more.current!.open = false; workspace.move(path, side ? "main" : "side"); }}>{t(side ? "chat.expand" : "chat.dock")}</button>
          {snapshot?.temporary && <button disabled={busy} title={busy ? t("chat.waitToStore") : undefined} className="block w-full rounded px-2 py-2 text-left hover:bg-muted disabled:opacity-40" onClick={() => { more.current!.open = false; setTitle(chatTabTitle(snapshot, path)); dialog.current?.showModal(); }}>{t("chat.save")}</button>}
        </div>
      </details>}
    </div>
    {(error || workspace.error) && <p role="alert" className="w-full break-words px-2 pb-1 text-destructive">{error || workspace.error}</p>}
    <dialog ref={dialog} className="rounded-lg border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/30">
      <form className="flex min-w-72 flex-col gap-3" onSubmit={event => { event.preventDefault(); if (path) perform(async () => { await workspace.save(path, directory, title); dialog.current?.close(); }); }}>
        <h2 className="text-sm font-semibold">{t("chat.save")}</h2>
        <label className="flex flex-col gap-1">{t("chat.name")}<input autoFocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} className="rounded border border-border bg-background px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1">{t("chat.directory")}<input required value={directory} onChange={event => setDirectory(event.target.value)} className="rounded border border-border bg-background px-2 py-1.5" /></label>
        <p className="max-w-80 text-muted-foreground">{t("chat.saveHelp")}</p>
        {error && <p role="alert" className="max-w-80 break-words text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => dialog.current?.close()}>{t("chat.cancel")}</button><button disabled={busy} type="submit" className="rounded bg-primary px-3 py-1.5 text-primary-foreground">{t("chat.save")}</button></div>
      </form>
    </dialog>
  </div>;
}
