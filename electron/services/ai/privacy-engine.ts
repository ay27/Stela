import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IPrivacySpan { start: number; end: number; kind: string }
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (spans: IPrivacySpan[][]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function stop(error: Error) {
  const previous = worker; worker = undefined;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear(); void previous?.terminate();
}
function engine() {
  if (worker) return worker;
  const roots = [process.resourcesPath, process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')].filter(Boolean);
  const file = roots.map(root => path.join(root, 'vendor/argus-redact/worker.mjs')).find(existsSync);
  if (!file) throw new Error('Bundled privacy engine is unavailable; nothing was sent.');
  worker = new Worker(file, { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
  worker.on('message', (reply: { id: number; error?: string; results: IPrivacySpan[][] }) => {
    const p = pending.get(reply.id); if (!p) return;
    pending.delete(reply.id); clearTimeout(p.timer);
    if (reply.error) p.reject(new Error(reply.error)); else p.resolve(reply.results);
    if (!pending.size) worker?.unref();
  });
  const created = worker;
  worker.on('error', () => { if (worker === created) stop(new Error('Privacy engine failed; nothing was sent.')); });
  worker.on('exit', code => { if (code !== 0 && worker === created) stop(new Error('Privacy engine stopped; nothing was sent.')); });
  worker.unref(); return worker;
}
export function detectPrivacy(texts: string[], signal?: AbortSignal): Promise<IPrivacySpan[][]> {
  signal?.throwIfAborted();
  if (texts.some(t => Buffer.byteLength(t) > 128 * 1024)) return Promise.reject(new Error('A privacy input exceeds 128 KiB; reduce the input.'));
  const current = engine(); current.ref(); const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stop(new Error('Privacy detection timed out; nothing was sent.')), 30_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => {
      pending.delete(id); cleanup(); reject(new Error('Privacy detection cancelled'));
      if (!pending.size && worker === current) stop(new Error('Privacy detection cancelled'));
    };
    pending.set(id, {
      resolve: spans => { cleanup(); if (signal?.aborted) reject(new Error('Privacy detection cancelled')); else resolve(spans); },
      reject: error => { cleanup(); reject(error); }, timer,
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    current.postMessage({ id, texts });
  });
}
