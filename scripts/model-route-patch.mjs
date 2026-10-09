import { writeFileSync } from 'node:fs';
import { loadModelRegistry } from '../model-routes.mjs';

const [metadata, destination] = process.argv.slice(2);
if (!metadata || !destination) throw new Error('Usage: node scripts/model-route-patch.mjs <reviewed-metadata.json> <new-output.patch.yml>');
const registry = loadModelRegistry(metadata);
writeFileSync(destination, JSON.stringify(registry.dshPatch(), null, 2) + '\n', { flag: 'wx' });
console.log('Provider model overlay written. No default selection, service or account was changed.');
