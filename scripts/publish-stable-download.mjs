import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const targets = {
  mac: { suffix: 'mac-arm64.dmg', name: 'Stela-mac-arm64.dmg' },
  windows: { suffix: 'win-x64.exe', name: 'Stela-windows-x64.exe' },
};

export function prepareStableDownload(root, platform, env = {}) {
  const target = targets[platform];
  if (!target) throw new Error(`Unsupported platform: ${platform}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tag = `v${pkg.version}`;
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME !== tag) {
    throw new Error(`Release tag ${env.GITHUB_REF_NAME} does not match ${tag}`);
  }
  const output = resolve(root, pkg.build.directories.output);
  const source = join(output, `${pkg.build.productName}-${pkg.version}-${target.suffix}`);
  const info = statSync(source);
  if (!info.isFile() || info.size === 0) throw new Error(`Installer is missing or empty: ${source}`);
  const directory = join(output, 'stable');
  mkdirSync(directory, { recursive: true });
  const artifact = join(directory, target.name);
  // Copy the finished installer after signing/notarization; preserve the original
  // versioned asset and updater manifests exactly as electron-builder produced them.
  copyFileSync(source, artifact);
  return { tag, artifact };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required');
  const { tag, artifact } = prepareStableDownload(process.cwd(), process.argv[2], process.env);
  execFileSync('gh', ['release', 'upload', tag, artifact, '--repo', process.env.GITHUB_REPOSITORY, '--clobber'], { stdio: 'inherit' });
}
