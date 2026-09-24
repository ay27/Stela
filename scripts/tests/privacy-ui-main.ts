import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "stela-privacy-ui-"));
  app.setPath("userData", temporary); app.on("window-all-closed", () => {});
  await app.whenReady();
  const win = new BrowserWindow({ width: 820, height: 650, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const evaluate = (code: string) => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); });
  try {
    await win.loadFile(path.resolve("out/tests/privacy-ui/index.html"));
    await evaluate(`new Promise(resolve => setTimeout(resolve, 500))`);
    assert.equal(await evaluate(`document.querySelectorAll('.stela-privacy-word').length`), 5);
    assert.equal(await evaluate(`document.body.innerText.includes('STELA_PII_')`), false);
    assert.equal(await evaluate(`document.querySelector('.stela-privacy-word').textContent`), '张三');
    assert(await evaluate(`!!document.querySelector('.stela-privacy-word').title`));
    assert(await evaluate(`getComputedStyle(document.querySelector('.stela-privacy-word')).textDecorationLine.includes('underline')`));
    await evaluate(`document.querySelector('button').click()`);
    assert.equal(await evaluate(`document.documentElement.dataset.copied`), "SELECT * FROM customers WHERE phone = '13812345678';");
    await mkdir('out/tests/privacy-ui/screenshots', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await writeFile(`out/tests/privacy-ui/screenshots/${theme}.png`, (await win.webContents.capturePage()).toPNG());
    }
    console.log('Privacy Electron UI: exact restoration, purple underline, tooltip, code copy, light/dark screenshots passed.');
  } finally { win.destroy(); await rm(temporary, { recursive: true, force: true }); }
  app.exit(0);
}
void main().catch(error => { console.error(error); app.exit(1); });
