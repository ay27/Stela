import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { i18n } from "../../src/i18n";

declare global { interface Window { canvasFixture: { read(): Promise<{ path: string; content: string; etag: string }>; finish(error?: string): void; screenshot(): Promise<void> } } }
const errors: string[] = [];
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
Object.assign(window, { stela: {
  platform: "linux",
  agent: { onEvent: () => () => {} },
  canvas: { read: () => window.canvasFixture.read() },
  storage: { getSchema: async () => [{ name: "category", typeName: "VARCHAR" }, { name: "total", typeName: "BIGINT" }],
    queryPage: async () => ({ rows: [["A", 42]], total: 1 }) },
} });
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Renderer timeout: ${document.body.innerText}`);
};
async function test() {
  await i18n.changeLanguage("zh");
  const { AnalysisCanvasView } = await import("../../src/views/AnalysisCanvasView");
  const root = createRoot(document.getElementById("root")!);
  root.render(<AnalysisCanvasView tabId="fixture" path="fixture.stela.canvas" />);
  await waitFor(() => document.querySelectorAll('[aria-label="流程图"] > div > div').length === 20 && !!document.querySelector(".h-80[role=img] svg"));
  assert(document.querySelectorAll('[aria-label="流程图"] > div > svg > g').length === 20, "All pipeline edges should render");
  assert(document.querySelectorAll("table tbody tr").length === 1, "Saved table result should load");
  assert(document.body.innerText.includes("42"), "KPI should load its saved result");
  assert(document.body.innerText.includes("流程说明"), "Markdown should render");
  assert(!document.querySelector("[role=alert]"), "Valid Canvas must not show a rendering error");
  assert(errors.length === 0, errors.join("\n"));
  await window.canvasFixture.screenshot();
  function Broken(): never { throw new Error("fixture card failure"); }
  root.render(<><ErrorBoundary compact resetKey="broken"><Broken /></ErrorBoundary><p>healthy sibling</p></>);
  await waitFor(() => !!document.querySelector("[role=alert]"));
  assert(document.body.innerText.includes("fixture card failure") && document.body.innerText.includes("healthy sibling"), "A failed card must be visible without losing its sibling");
  root.render(<ErrorBoundary compact resetKey="fixed"><p>recovered card</p></ErrorBoundary>);
  await waitFor(() => document.body.innerText.includes("recovered card"));
  root.unmount();
}
void test().then(() => window.canvasFixture.finish(), error => window.canvasFixture.finish(String(error?.stack ?? error)));
