import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mixedAuthoringFixture } from "../../electron/shared/canvas-authoring.fixture";
import { canvasAuthoringSchema } from "../../electron/shared/canvas-authoring";
import { newAnalysisCanvas, createAnalysisCanvas, readAnalysisCanvas } from "../../electron/services/analysis-canvas";
async function main() {
const root = await mkdtemp(join(tmpdir(), "stela-canvas-renderer-"));
app.setPath("userData", join(root, "user-data"));
app.on("window-all-closed", () => {});
await app.whenReady();
const authored = canvasAuthoringSchema.parse(mixedAuthoringFixture);
const canvas = { ...newAnalysisCanvas(authored.title), ...authored, sources: [{ id: "data", title: "数据", connectionName: "fixture", sql: "SELECT category, total FROM fixture", lastRunId: "fixture-run", lastRunAt: 1, lastError: null }] };
const file = await createAnalysisCanvas(root, root, canvas.title, null, canvas);
ipcMain.handle("fixture:read", () => readAnalysisCanvas(root, file.path));
const win = new BrowserWindow({ show: false, width: 1280, height: 1800, webPreferences: { preload: resolve("out/tests/canvas/preload.cjs"), contextIsolation: true, nodeIntegration: false } });
ipcMain.handle("fixture:screenshot", async () => {
  await writeFile("out/tests/canvas/rendered.png", (await win.webContents.capturePage()).toPNG());
});
const timer = setTimeout(() => { console.error("Canvas renderer timed out"); app.exit(1); }, 40000);
ipcMain.once("fixture:finish", async (_event, error?: string) => {
  clearTimeout(timer);
  console.log(error ?? "Canvas renderer passed: disk read, Flow 20 nodes/20 edges, chart, table, KPI, Markdown, error isolation and recovery.");
  win.destroy(); await rm(root, { recursive: true, force: true }); app.exit(error ? 1 : 0);
});
await win.loadFile(resolve("out/tests/canvas/index.html"));

}
void main().catch(error => { console.error(error); app.exit(1); });
