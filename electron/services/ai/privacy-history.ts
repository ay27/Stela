import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureWithinVault } from '../vault-fs';
import { atomicWriteFile } from '../atomic-write';
import { privacyStateSchema } from '../../shared/ai-privacy';
import type { IPrivacyPersistence } from './privacy-session';

export async function privacyHistory(vault: string, device: string, session: string): Promise<IPrivacyPersistence> {
  if (![device, session].every(v => /^[A-Za-z0-9_-]{1,128}$/.test(v))) throw new Error('Invalid privacy history identity');
  const file = await ensureWithinVault(vault, path.join(vault, '.stela/agent-history', device, `${session}.privacy.json`));
  let state;
  try { state = privacyStateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return { state, save: async next => { await fs.mkdir(path.dirname(file), { recursive: true }); await atomicWriteFile(file, JSON.stringify(next)); } };
}
