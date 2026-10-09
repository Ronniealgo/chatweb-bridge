import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceFile, sha256 } from './source-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function exportSource(sourceRoot, destination) {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error('Export destination must not exist');
  const manifest = JSON.parse(readFileSync(sourceFile(sourceRoot, 'release-files.json'), 'utf8'));
  const files = manifest.files;
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new Error('Invalid release file list');
  // Resolve every allowlisted input before creating output; never recurse over a working checkout.
  const inputs = files.map(name => ({ name, path: sourceFile(sourceRoot, name) }));
  mkdirSync(target);
  for (const { name, path } of inputs) {
    const output = join(target, name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(path, output);
  }
  const hashes = Object.fromEntries(inputs.map(({ name }) => [name, sha256(join(target, name))]));
  writeFileSync(join(target, 'SOURCE-SHA256.json'), JSON.stringify(hashes, null, 2) + '\n');
  return { files: files.length, destination: target };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-source.mjs <new-empty-destination>');
    console.log(JSON.stringify(exportSource(root, process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
