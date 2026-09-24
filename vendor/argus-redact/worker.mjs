import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import init, { redact } from './argus_redact_wasm.mjs';

const bytes = await readFile(new URL('./argus_redact_wasm_bg.wasm', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== 'da9e9b7f82495c9d83565c069668bbedd5e7e55f3f740f6eabd0415acc526114') throw new Error('Privacy engine integrity check failed');
await init({ module_or_path: bytes });
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
parentPort.on('message', ({ id, texts }) => {
  try {
    const results = texts.map(input => {
      const result = redact(input, { lang: ['zh', 'en'], mode: 'fast', salt: 42,
        config: { phone: { strategy: 'remove' }, email: { strategy: 'remove' }, bank_card: { strategy: 'remove' } } });
      const keys = Object.keys(result.key).filter(k => result.key[k] !== k).sort((a, b) => b.length - a.length);
      if (!keys.length) {
        if (result.text !== input) throw new Error('Unmapped replacement');
        return [];
      }
      const pattern = new RegExp(keys.map(escape).join('|'), 'g');
      const spans = []; let outputAt = 0; let inputAt = 0;
      for (const m of result.text.matchAll(pattern)) {
        const literal = result.text.slice(outputAt, m.index);
        if (input.slice(inputAt, inputAt + literal.length) !== literal) throw new Error('Invalid replacement alignment');
        inputAt += literal.length;
        const original = result.key[m[0]];
        if (input.slice(inputAt, inputAt + original.length) !== original) throw new Error('Invalid replacement origin');
        spans.push({ start: inputAt, end: inputAt + original.length, kind: m[0].split('-')[0] });
        inputAt += original.length; outputAt = m.index + m[0].length;
      }
      if (input.slice(inputAt) !== result.text.slice(outputAt)) throw new Error('Invalid replacement suffix');
      return spans;
    });
    parentPort.postMessage({ id, results });
  } catch {
    // Never include source text in diagnostics.
    parentPort.postMessage({ id, error: 'Privacy detection failed; nothing was sent. Reduce the input or retry.' });
  }
});
