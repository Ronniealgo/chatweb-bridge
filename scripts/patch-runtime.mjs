import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { matches, relativePath, sha256, sourceFile } from './source-files.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function patchRuntime(root = defaultRoot, { verifyOnly = false } = {}) {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(sourceFile(root, 'patches/adapter-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.upstream.package !== '@minzicat/pi-chatgpt-web-adapter' || manifest.upstream.version !== '0.1.1') {
    throw new Error('Unsupported adapter manifest');
  }
  const patch = sourceFile(root, relativePath(manifest.patch.file));
  if (sha256(patch) !== manifest.patch.sha256) throw new Error('Patch digest mismatch');
  const packageRoot = join(root, 'runtime/node_modules/@minzicat/pi-chatgpt-web-adapter');
  // Validate the path itself before any recursive read (including junctions).
  sourceFile(root, 'runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/package.json');
  if (matches(packageRoot, manifest.outputFiles)) return { status: 'verified', files: Object.keys(manifest.outputFiles).length };
  if (verifyOnly) throw new Error('Installed adapter does not match the pinned runtime');
  if (!matches(packageRoot, manifest.inputFiles)) throw new Error('Adapter is neither pristine pinned input nor accepted output; no files changed');
  if (Object.keys(manifest.inputFiles).some(name => !(name in manifest.outputFiles))) throw new Error('This installer does not support package file deletion');

  // Never reuse a checkout's .build path, which may be a junction or contain user data.
  const stagingParent = tmpdir();
  const stage = mkdtempSync(join(stagingParent, 'dsh-adapter-build-'));
  for (const name of Object.keys(manifest.inputFiles)) {
    const output = join(stage, relativePath(name));
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(sourceFile(packageRoot, name), output);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  env.GIT_CEILING_DIRECTORIES = resolve(stagingParent);
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const args of [['apply', '--check', patch], ['apply', patch]]) {
    const result = spawnSync('git', args, { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error('Adapter patch failed in staging; installed input untouched');
  }
  if (!matches(stage, manifest.outputFiles)) throw new Error('Patched output digest mismatch; installed input untouched');
  // Recheck immediately before copying; never patch an unknown or concurrently changed installation.
  if (!matches(packageRoot, manifest.inputFiles)) throw new Error('Adapter changed during staging; refusing to overwrite');
  for (const name of Object.keys(manifest.outputFiles)) {
    const output = join(packageRoot, relativePath(name));
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(sourceFile(stage, name), output);
  }
  if (!matches(packageRoot, manifest.outputFiles)) throw new Error('Installed output verification failed; do not start services');
  return { status: 'patched-and-verified', files: Object.keys(manifest.outputFiles).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--verify')) throw new Error('Usage: node scripts/patch-runtime.mjs [--verify]');
    console.log(JSON.stringify(patchRuntime(defaultRoot, { verifyOnly: process.argv.includes('--verify') })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
