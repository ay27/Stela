import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { prepareStableDownload } from './publish-stable-download.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stela-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3', build: { productName: 'Stela', directories: { output: 'release' } } }));
  return root;
}

for (const [platform, source, name] of [
  ['mac', 'Stela-1.2.3-mac-arm64.dmg', 'Stela-mac-arm64.dmg'],
  ['windows', 'Stela-1.2.3-win-x64.exe', 'Stela-windows-x64.exe'],
]) {
  test(`${platform}: copies the finished installer and preserves updater metadata`, t => {
    const root = fixture(t);
    const bytes = Buffer.from([0, 255, 13, 10, 7, 128]);
    writeFileSync(join(root, 'release', source), bytes);
    writeFileSync(join(root, 'release', 'latest.yml'), 'version: 1.2.3\n');
    const result = prepareStableDownload(root, platform, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' });
    assert.equal(result.tag, 'v1.2.3');
    assert.equal(basename(result.artifact), name);
    assert.deepEqual(readFileSync(result.artifact), bytes);
    assert.deepEqual(readFileSync(join(root, 'release', source)), bytes);
    assert.equal(readFileSync(join(root, 'release', 'latest.yml'), 'utf8'), 'version: 1.2.3\n');
    writeFileSync(result.artifact, 'old copy');
    prepareStableDownload(root, platform); // workflow reruns replace the alias
    assert.deepEqual(readFileSync(result.artifact), bytes);
  });
}

test('rejects an incorrect tag, unsupported platform, or absent/empty installer', t => {
  const root = fixture(t);
  assert.throws(() => prepareStableDownload(root, 'mac', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' }), /does not match/);
  assert.throws(() => prepareStableDownload(root, 'linux'), /Unsupported/);
  assert.throws(() => prepareStableDownload(root, 'mac'), /ENOENT/);
  writeFileSync(join(root, 'release', 'Stela-1.2.3-mac-arm64.dmg'), '');
  assert.throws(() => prepareStableDownload(root, 'mac'), /empty/);
});
