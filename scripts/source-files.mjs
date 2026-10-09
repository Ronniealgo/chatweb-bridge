import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') ||
      value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe relative file path');
  }
  return value;
}

export function sourceFile(root, name) {
  const parts = relativePath(name).split('/');
  let path = realpathSync(root);
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Not an ordinary source file: ${name}`);
    }
  }
  return path;
}

export function inventory(root) {
  const names = [];
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected link: ${name}`);
      if (entry.isDirectory()) walk(join(directory, entry.name), name + '/');
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Unexpected special file: ${name}`);
    }
  }
  walk(resolve(root));
  return names.sort();
}

export function matches(root, expected) {
  const names = Object.keys(expected).sort();
  names.forEach(relativePath);
  // Check names before reading any content; reject unknown local/private files.
  if (JSON.stringify(inventory(root)) !== JSON.stringify(names)) return false;
  return names.every(name => /^[a-f0-9]{64}$/.test(expected[name]) && sha256(sourceFile(root, name)) === expected[name]);
}
