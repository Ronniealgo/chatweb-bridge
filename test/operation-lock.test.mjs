import test from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserOperation, operationState, operationPhase } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';
test('one browser transaction permits its own nested steps but rejects independent navigation',async()=>{
 const chrome={};let release,entered;const gate=new Promise(r=>{release=r;}),start=new Promise(r=>{entered=r;});
 const run=withBrowserOperation(chrome,'chat','request-one',async()=>{await withBrowserOperation(chrome,'composer','ignored',async()=>{operationPhase(chrome,'prepare',false);entered();await gate;});});
 await start;assert.equal(operationState(chrome).requestId,'request-one');
 await assert.rejects(withBrowserOperation(chrome,'navigation','request-two',async()=>{throw Error('must not run');}),e=>e.status===429);
 release();await run;assert.equal(operationState(chrome),null);
});
test('failed submitted operations retain phase metadata and release the mutex',async()=>{
 const chrome={};await assert.rejects(withBrowserOperation(chrome,'chat','test-failure',async()=>{operationPhase(chrome,'generation-submit','unknown');throw Error('fixture disconnect');}),e=>e.requestId==='test-failure'&&e.phase==='generation-submit'&&e.generationSubmitted==='unknown');
 assert.equal(operationState(chrome),null);assert.equal(await withBrowserOperation(chrome,'readiness','next',async()=>42),42);
});
