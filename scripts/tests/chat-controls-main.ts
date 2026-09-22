import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
async function main() {
const temporary = await mkdtemp(path.join(tmpdir(), "stela-chat-controls-"));
app.setPath("userData", temporary);
app.on("window-all-closed", () => {});
await app.whenReady();
const win = new BrowserWindow({ width: 340, height: 650, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const evaluate = (code: string) => win.webContents.executeJavaScript(code);
try {
  win.show(); win.focus();
  await win.loadFile(path.resolve("out/tests/chat-controls/index.html"));
  await evaluate(`new Promise(resolve => setTimeout(resolve, 300))`);
  await mkdir("out/tests/chat-controls/screenshots", { recursive: true });
  for (const width of [280, 340, 600, 900]) {
    win.setContentSize(width, 650);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert(await evaluate(`document.querySelectorAll('[role="tab"]').length === 3`), "Three tabs visible");
    assert(await evaluate(`document.querySelector('.stela-chat-controls').getBoundingClientRect().width <= innerWidth`), "Toolbar fits viewport");
    await writeFile(`out/tests/chat-controls/screenshots/${width}.png`, (await win.webContents.capturePage()).toPNG());
  }
  win.setContentSize(280, 650);
  await evaluate(`document.querySelector('summary[aria-label="会话历史"]').click()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert(await evaluate(`!!document.querySelector('input[placeholder="搜索会话或文件路径"]') && document.querySelector('details').open`), "History opens");
  assert(await evaluate(`document.querySelector('details').innerText.includes('orders.stela.chat') && document.querySelector('details').innerText.includes('Chats')`), "Filename and path displayed");
  assert(await evaluate(`!['临时','已保存','旧版历史'].some(label => document.querySelector('details').innerText.includes(label))`), "No storage labels");
  assert(await evaluate(`(() => { const box = document.querySelector('details > div').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`), "History fits narrow viewport");
  await evaluate(`Array.from(document.querySelectorAll('details button')).find(button => button.textContent === '显示更多').click()`);
  assert(await evaluate(`!Array.from(document.querySelectorAll('details button')).some(button => button.textContent === '显示更多')`), "All history can be revealed");
  await writeFile("out/tests/chat-controls/screenshots/history.png", (await win.webContents.capturePage()).toPNG());
  win.focus(); win.webContents.focus();
  await evaluate(`new Promise(resolve => setTimeout(resolve, 100))`);
  await evaluate(`document.querySelector('#outside').focus()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert(await evaluate(`!document.querySelector('details').open`), "Focus outside dismisses history");
  await evaluate(`document.querySelectorAll('summary')[1].click()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert(await evaluate(`document.querySelectorAll('details')[1].innerText.includes('存为本地文件')`), "File action in more menu");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert(await evaluate(`!document.querySelectorAll('details')[1].open`), "Escape dismisses more menu");
  win.setContentSize(900, 650);
  await win.loadFile(path.resolve("out/tests/chat-controls/index.html"), { query: { main: "1" } });
  await evaluate(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert(await evaluate(`document.querySelectorAll('[role="tablist"]').length === 0`), "Main area does not duplicate workspace tabs");
  await writeFile("out/tests/chat-controls/screenshots/main.png", (await win.webContents.capturePage()).toPNG());
  console.log("Chat controls renderer: widths, tabs, file labels, hidden internal labels, focus dismissal and more menu passed.");
} finally { win.destroy(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
app.exit(0);

}
void main().catch(error => { console.error(error); app.exit(1); });
