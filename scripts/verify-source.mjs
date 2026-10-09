import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFile, sha256 } from './source-files.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files=JSON.parse(readFileSync(sourceFile(root,'release-files.json'),'utf8')).files;
const hashes=JSON.parse(readFileSync(sourceFile(root,'SOURCE-SHA256.json'),'utf8'));
if(JSON.stringify([...files].sort())!==JSON.stringify(Object.keys(hashes).sort()))throw Error('Source manifest file set differs');
for(const name of files)if(sha256(sourceFile(root,name))!==hashes[name])throw Error('Source digest mismatch: '+name);
for(const name of ['package-lock.json','runtime/package-lock.json']){
 const lock=JSON.parse(readFileSync(sourceFile(root,name),'utf8'));
 for(const [key,pkg]of Object.entries(lock.packages))if(key){
  if(!pkg.integrity||!pkg.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('Dependency is not pinned to a public integrity-checked input');
 }
}
console.log(JSON.stringify({sourceFiles:files.length,hashes:'verified',dependencyInputs:'pinned',networkRequests:0}));
