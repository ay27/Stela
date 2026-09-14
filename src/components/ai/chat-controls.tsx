import { useRef, useState } from "react";
import { History, Plus, Save, PanelRight, Expand, X, Trash2 } from "lucide-react";
import { useChatWorkspace } from "@/state/chat-workspace";
import { useConversation } from "@/state/conversation";
import { useT } from "@/i18n/use-t";
import type { AgentHistorySummary } from "@shared/types";

export function ChatControls({ path, side = false }: { path?: string; side?: boolean }) {
  const t = useT();
  const workspaceError = useChatWorkspace(s => s.error);
  const recent = useChatWorkspace(s => s.recent);
  const snapshot = useConversation(s => path ? s.snapshots[path] : undefined);
  const [legacy, setLegacy] = useState<AgentHistorySummary[]>([]);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [directory, setDirectory] = useState("Chats");
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDetailsElement>(null);
  const busy = snapshot?.document.turns.some(turn => turn.status === "running");
  const perform = (action: () => Promise<unknown>) => { setError(""); void action().catch(e => setError(String(e))); };
  const refresh = () => perform(async () => {
    await useChatWorkspace.getState().refresh();
    const items = await window.stela.agent.listHistory();
    const ids = new Set(useChatWorkspace.getState().recent.map(item => item.sessionId));
    setLegacy(items.filter(item => !ids.has(item.sessionId)));
  });
  const select = (action: () => Promise<unknown>) => { if (history.current) history.current.open = false; perform(action); };
  return <div className="stela-chat-controls relative flex flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs">
    <button title={t("conversation.new")} aria-label={t("conversation.new")} className="rounded p-1 hover:bg-muted" onClick={() => perform(() => useChatWorkspace.getState().create(side ? "side" : "main"))}><Plus size={14} /></button>
    <details ref={history} className="relative" onToggle={event => { if (event.currentTarget.open) refresh(); }}>
      <summary title={t("chat.history")} aria-label={t("chat.history")} className="cursor-pointer list-none rounded p-1 hover:bg-muted"><History size={14} /></summary>
      <div className="absolute left-0 top-7 z-50 max-h-80 w-64 overflow-auto rounded border border-border bg-popover p-1 shadow-lg">
        {!recent.length && !legacy.length && <p className="p-2 text-muted-foreground">{t("chat.noHistory")}</p>}
        {recent.map(item => <button key={item.path} className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => select(() => useChatWorkspace.getState().show(item.path, side ? "side" : "main"))}>{item.title} <span className="text-muted-foreground">· {t(item.temporary ? "chat.temporary" : "chat.saved")}</span></button>)}
        {legacy.map(item => <button key={`${item.deviceSlug}/${item.sessionId}`} className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => select(() => useChatWorkspace.getState().importLegacy(item, side ? "side" : "main"))}>{item.title} <span className="text-muted-foreground">· {t("chat.legacy")}</span></button>)}
      </div>
    </details>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{snapshot ? t(snapshot.temporary ? "chat.temporary" : "chat.autosaved") : "Chat"}</span>
    {path && <>
      {snapshot?.temporary && <button disabled={busy} title={t("chat.save")} className="rounded px-1.5 py-1 hover:bg-muted disabled:opacity-40" onClick={() => { setTitle(snapshot.document.title); dialog.current?.showModal(); }}><span className="flex items-center gap-1"><Save size={13} />{t("chat.save")}</span></button>}
      <button title={t(side ? "chat.expand" : "chat.dock")} aria-label={t(side ? "chat.expand" : "chat.dock")} className="rounded p-1 hover:bg-muted" onClick={() => useChatWorkspace.getState().move(path, side ? "main" : "side")}>{side ? <Expand size={14} /> : <PanelRight size={14} />}</button>
      {snapshot?.temporary && <button disabled={busy} title={t("chat.discard")} aria-label={t("chat.discard")} className="rounded p-1 hover:bg-muted disabled:opacity-40" onClick={() => perform(() => useChatWorkspace.getState().discard(path))}><Trash2 size={13} /></button>}
      <button title={t("chat.close")} aria-label={t("chat.close")} className="rounded p-1 hover:bg-muted" onClick={() => useChatWorkspace.getState().close(path)}><X size={14} /></button>
    </>}
    {(error || workspaceError) && <p role="alert" className="w-full break-words text-destructive">{error || workspaceError}</p>}
    <dialog ref={dialog} className="rounded-lg border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/30">
      <form className="flex min-w-72 flex-col gap-3" onSubmit={event => { event.preventDefault(); if (path) perform(async () => { await useChatWorkspace.getState().save(path, directory, title); dialog.current?.close(); }); }}>
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
