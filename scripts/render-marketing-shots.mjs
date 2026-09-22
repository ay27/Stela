// Compose real captures in an HTML/CSS frame; screenshot pixels are never rewritten.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/render-marketing-shots.mjs /path/to/captures
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = process.argv[2];
if (!source) throw new Error('Supply the capture directory');
const output = path.resolve('docs/assets/screenshots');
await fs.mkdir(output, { recursive: true });
const titles = {
 workspace: ['分析工作，无需切换工具。', 'Analysis, all in one workspace.'],
 markdown: ['思考、查询、结果，写在一起。', 'Your reasoning. Your SQL. Your results.'],
 chat: ['写 SQL，问问题，就在同一段对话。', 'Write SQL. Ask questions. Keep the context.'],
 agent: ['顺着线索，找到答案。', 'Follow the evidence. Find the answer.'],
 canvas: ['让分析，成为一份完整报表。', 'Bring your findings into a report.'],
 lineage: ['每一个数字，都有来处。', 'See where every number comes from.'],
 knowledge: ['把业务口径，留给下一次分析。', 'Keep the context for your next analysis.'],
 plugins: ['接入数据库，开始分析。', 'Connect your database. Start exploring.'],
};
const subtitles = {
 workspace: ['SQL · Chat · Canvas，在同一工作台中展开', 'SQL, Chat and Canvas, side by side'],
 markdown: ['在 Markdown 中执行 SQL，并保留查询结果', 'Execute SQL in Markdown and keep the results'],
 chat: ['代码补全、查询执行与结果解读，连贯展开', 'SQL completion, execution and analysis in one conversation'],
 agent: ['查阅业务背景，执行查询，给出有据可查的结论', 'Use business context and query results to guide the analysis'],
 canvas: ['图表与结论并列，从发现走向决策', 'Charts and conclusions, ready to review together'],
 lineage: ['从原始数据到贡献利润，展示计算过程与实际金额', 'Trace contribution profit through its inputs and actual amounts'],
 knowledge: ['查看知识正文与指标定义 · 图中为预置 Skill', 'Review maintained knowledge and its source notes'],
 plugins: ['MySQL、PostgreSQL、MongoDB，通过连接器插件扩展', 'Extend Stela with MySQL, PostgreSQL and MongoDB connectors'],
};
// Always preserve the entire capture; fit proportionally inside the frame.
const only = new Set(process.argv.slice(3));
const manifest = only.size ? JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')) : [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1800, height: 1320 }, deviceScaleFactor: 1 });
 for (const [index, lang] of ['zh','en'].entries()) for (const key of Object.keys(titles)) {
  if (only.size && !only.has(`${lang}-${key}`)) continue;
  const filename = `${lang}-${key === 'workspace' ? 'agent' : key === 'canvas' ? 'canvas-report' : key === 'lineage' ? 'canvas-lineage2' : key === 'chat' ? 'sql-in-chat' : key === 'agent' && lang === 'en' ? 'workspace' : key}.png`;
  const bytes = await fs.readFile(path.join(source, filename));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const crop = [0, 0, 1, 1];
  const scale = Math.min(1656 / width, 996 / height);
  await page.setContent(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:1800px;height:1320px;background:linear-gradient(135deg,#f5f8ff,#eef4fa 65%,#f8fafc);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#182d49;padding:54px 72px}
header{height:180px;position:relative}.eyebrow{font-size:20px;letter-spacing:3px;color:#4872a6;font-weight:600;text-transform:uppercase}h1{font-size:48px;letter-spacing:-1.5px;margin:14px 0 10px;line-height:1.2}p{font-size:24px;color:#66768a;margin:0}.brand{position:absolute;right:0;top:0;font-size:24px;font-weight:650;letter-spacing:-.6px}
.stage{height:996px;display:flex;align-items:center;justify-content:center}.capture{position:relative;box-shadow:0 22px 60px #2848711c,0 0 0 1px #ced9e4;background:white;flex-shrink:0}img{display:block;max-width:none}footer{position:absolute;bottom:24px;left:72px;color:#728298;font-size:16px;letter-spacing:1px}</style>
<header><div class="eyebrow">${key === 'markdown' ? 'SQL in Markdown' : key === 'chat' ? 'SQL in Chat' : key === 'agent' ? 'Stela Agent' : key === 'lineage' ? 'Canvas · Data lineage' : key}</div><div class="brand">Stela</div><h1>${titles[key][index]}</h1><p>${subtitles[key][index]}</p></header><div class="stage"><div class="capture" style="width:${width*scale}px;height:${height*scale}px"><img src="data:image/png;base64,${bytes.toString('base64')}" style="width:${width*scale}px;height:${height*scale}px"></div></div><footer>STELA · DATA ANALYSIS WORKBENCH</footer></html>`);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); });
  const stem = path.join(output, `${lang}-${key}`);
  await page.screenshot({ path: `${stem}.png` });
  execFileSync('cwebp', ['-quiet','-q','88',`${stem}.png`,'-o',`${stem}.webp`]);
  execFileSync('cwebp', ['-quiet','-q','85','-resize','900','0',`${stem}.png`,'-o',`${stem}-900.webp`]);
  const previous = manifest.findIndex(item => item.asset === `${lang}-${key}`);
  if (previous >= 0) manifest.splice(previous, 1);
  manifest.push({asset:`${lang}-${key}`,source:filename,sha256:createHash('sha256').update(bytes).digest('hex'),crop,width:1800,height:1320,title:titles[key][index],subtitle:subtitles[key][index]});
 }
} finally { await browser.close(); }
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
