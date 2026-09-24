import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultTable } from "../../src/components/result-table";
import { i18n } from "../../src/i18n";
import "@milkdown/crepe/theme/common/style.css";
import "../../src/editor/milkdown-editor.css";
const columns = [{ name: "channel" }, { name: "revenue" }, { name: "details" }];
const rows = [["paid_social", 20685.8, "A long value ".repeat(30)], ["email", null, { checked: true }], ["search", 8242, ""]];
Object.assign(window, { copied: "", failCopy: false, stela: { shell: { writeClipboardText: (text: string) => {
  if (Reflect.get(window, "failCopy")) throw new Error("Clipboard unavailable");
  Reflect.set(window, "copied", text);
} } } });
// Keep failure tests isolated from the operating system clipboard.
Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
function Fixture() {
  const [offset, setOffset] = useState(0);
  return <main className="milkdown p-4"><div className="ProseMirror" style={{ padding: 0 }}><div className="stela-cb" contentEditable={false}><div className="stela-cb__header"><span>Run SQL</span><button className="stela-cb__run">Run</button></div><div className="stela-cb__result-body"><ResultTable columns={columns} rows={rows} rowOffset={offset} /></div><div className="stela-cb__run-tabs"><button className="stela-cb__run-tab stela-cb__run-tab--active">09/24 16:24</button><button className="stela-cb__run-tab">09/24 15:30</button></div></div><button id="page" onClick={() => setOffset(offset + 3)}>Next page</button></div></main>;
}
void i18n.changeLanguage("zh").then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
