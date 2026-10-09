import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnosticRecord, safeLogger } from '../diagnostic-policy.mjs';
import { readFileSync } from 'node:fs';
test('untrusted error, model and tool strings never enter default logs',()=>{
 const marker='PRIVATE_TASK_COOKIE_BEARER_123456';
 const value={event:'error',status:503,requestId:'12345678-1234-1234-1234-123456789abc',message:marker,model:marker,tools:[marker],code:marker,token:marker,details:{secret:marker}};
 const record=safeDiagnosticRecord(value);assert.equal(record.status,503);assert.equal(record.toolCount,1);assert(!JSON.stringify(record).includes(marker));assert.equal(record.messageSHA256.length,64);
 const logs=[];safeLogger({error:x=>logs.push(x)}).error(JSON.stringify(value));assert(!logs.join('').includes(marker));
});
test('invalid free-form diagnostic fields are omitted',()=>{assert.deepEqual(safeDiagnosticRecord({event:'secret',requestId:'secret',timestamp:'secret',phase:'secret',status:'secret',saved:'secret'}),{})});
test('experimental raw capture path cannot write user streams',()=>{
 const source=readFileSync(new URL('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js',import.meta.url),'utf8');
 assert(!source.includes('writeFileSync'));assert(source.includes('raw-capture-disabled'));
});
