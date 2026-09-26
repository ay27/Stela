import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultTable } from "../../src/components/result-table";
import { BlockResult, DEFAULT_VIEW_STATE } from '../../src/components/block-result';
import type { RunRecord } from '../../electron/shared/types';
import '../../src/components/ai/assistant-output.css';
import { i18n } from "../../src/i18n";
import "@milkdown/crepe/theme/common/style.css";
import "../../src/editor/milkdown-editor.css";
const columns = [{ name: "channel" }, { name: "revenue" }, { name: "details" }];
const rows = [["paid_social", 20685.8, "A long value ".repeat(30)], ["email", null, { checked: true }], ["search", 8242, ""]];
Object.assign(window, { copied: "", failCopy: false, stela: { shell: { writeClipboardText: (text: string) => {
  if (Reflect.get(window, "failCopy")) throw new Error("Clipboard unavailable");
  Reflect.set(window, "copied", text);
} }, storage: {
  getSchema: async (id: string) => id === 'one' ? [{ name: '123', typeName: 'INTEGER' }] : [{ name: 'customer' }, { name: 'count' }, { name: 'detail' }],
  queryPage: async (id: string, offset: number, limit: number) => {
    const data = id === 'one' ? [[123]] : Array.from({ length: id === 'paged' ? 23 : 2 }, (_, i) => ['张三', i + 1, { product: '椅子', phone: '13812345678' }]);
    return { rows: data.slice(offset, offset + limit), total: data.length };
  },
  listRunsByBlockId: async () => [],
}, export: { saveFile: async (name: string, content: string) => { Reflect.set(window, 'exported', { name, content }); return { canceled: true }; } } } });
// Keep failure tests isolated from the operating system clipboard.
Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
function Fixture() {
  const [offset, setOffset] = useState(0);
  return <main className="milkdown p-4"><div className="ProseMirror" style={{ padding: 0 }}><div className="stela-cb" contentEditable={false}><div className="stela-cb__header"><span>Run SQL</span><button className="stela-cb__run">Run</button></div><div className="stela-cb__result-body"><ResultTable columns={columns} rows={rows} rowOffset={offset} /></div><div className="stela-cb__run-tabs"><button className="stela-cb__run-tab stela-cb__run-tab--active">09/24 16:24</button><button className="stela-cb__run-tab">09/24 15:30</button></div></div><button id="page" onClick={() => setOffset(offset + 3)}>Next page</button></div></main>;
}
const record = (runId: string): RunRecord => ({ runId, blockId: runId, sql: 'select 123', status: 'ok', message: null, startedAt: 1, elapsedMs: 12, rowCount: 1, connectionName: 'SR', notePath: null });
function CompactResult({ id, chat = false, result = 'one' }: { id: string; chat?: boolean; result?: string }) {
  const [expanded, setExpanded] = useState(true);
  const [history, setHistory] = useState(false);
  return <section id={id} className={chat ? 'stela-assistant-output' : 'stela-cb'}>
    <BlockResult run={record(result)} runId={result} blockId={null} detail={null} runState="idle" expanded={expanded} onToggle={() => setExpanded(v => !v)} showSqlAction={chat}
      onReuseSql={sql => Reflect.set(window, 'reused', sql)} viewState={{ ...DEFAULT_VIEW_STATE, activeRunId: history ? 'old' : null }}
      privacy={result === 'one' ? undefined : { runId: result, columns: [{ column: 0, state: 'masked' }, { column: 1, state: 'released' }, { column: 2, state: 'partial' }] }} />
    {result === 'private' && <button id="history" onClick={() => setHistory(v => !v)}>History</button>}
  </section>;
}
function CompactFixture() {
  return <main className="p-4 space-y-4"><h2>Chat</h2><CompactResult id="chat-result" chat /><h2>RunSQL</h2><CompactResult id="runsql-result" /><h2>Privacy</h2><CompactResult id="private-result" result="private" chat /><CompactResult id="paged-result" result="paged" /></main>;
}
void i18n.changeLanguage("zh").then(() => {
  const root = createRoot(document.getElementById('root')!);
  Reflect.set(window, 'mountCompact', () => root.render(<CompactFixture />));
  root.render(<Fixture />);
});
