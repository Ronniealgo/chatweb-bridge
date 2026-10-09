import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(upstreamToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AdapterServer } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js';

import { withBrowserOperation, operationQueueState } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';

async function fixture(t, chrome) {
  const app=new AdapterServer(adapterAuth); app.chrome=chrome;
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>{app.server.closeAllConnections();app.server.close();});
  return {app,url:`http://127.0.0.1:${app.server.address().port}`};
}
for(const route of ['/readiness','/doctor']) test(`${route} stays passive with a cold browser and never obtains authentication`,async t=>{
  const forbidden=()=>{throw Error('Must not launch, navigate, fetch session or send');};
  const {url}=await fixture(t,{page:null,ensureRunning:forbidden,fetchSession:forbidden,mintSentinelHeaders:forbidden,pageContext:forbidden});
  const r=await fetch(url+route);assert.equal(r.status,200);const body=await r.json();
  assert.equal(body.browserRunning,false);assert.equal(body.authenticated,null);assert.equal(body.authenticationCheck,'not_performed');assert.equal(body.diagnosticMode,'passive');
});
test('diagnostics during generation return busy without reading or changing the page',async t=>{
  let release;const gate=new Promise(r=>{release=r;});let reads=0;
  const chrome={page:{isClosed:()=>false,evaluate:async()=>{reads++;throw Error('Must not touch page during generation');}}};
  const {url}=await fixture(t,chrome);const run=withBrowserOperation(chrome,'chat','test-request',()=>gate);
  for(const path of ['/doctor','/readiness']){const body=await(await fetch(url+path)).json();assert.equal(body.busy,true);assert.equal(body.operation.requestId,'test-request');}
  assert.equal(reads,0);release();await run;
});
test('passive DOM inspection and generation share the same mutex',async t=>{
  let release,entered;const start=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const chrome={page:{isClosed:()=>false,evaluate:async()=>{entered();await gate;return {ready:true,textLength:0,sendReady:false};}}};
  const {url}=await fixture(t,chrome);const read=fetch(url+'/readiness');await start;
  const queued=fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  for(let i=0;i<50 && !operationQueueState(chrome).queued;i++) await new Promise(r=>setTimeout(r,2));
  assert.equal(operationQueueState(chrome).queued,1);
  release();assert.equal((await read).status,200);assert.equal((await queued).status,400);
});
