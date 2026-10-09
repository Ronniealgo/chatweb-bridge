import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(upstreamToken);
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {registerHooks} from 'node:module';
import {ManagedChrome} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';
import {ChatClient} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import {withBrowserOperation,operationPhase} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';
const authKey=Symbol.for('browser-review-v2-auth'),authHandlers=new WeakMap();globalThis[authKey]=c=>{assert.ok(authHandlers.has(c),'real authentication forbidden');return authHandlers.get(c)();};
const authURL=new URL('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/auth/refresh.js',import.meta.url).href;
const hook=registerHooks({load(url,ctx,next){if(url!==authURL)return next(url,ctx);return {format:'module',shortCircuit:true,source:`export class SessionExpiredError extends Error {};export const ensureFreshToken=(c)=>globalThis[Symbol.for('browser-review-v2-auth')](c);`};}});
const {AdapterServer}=await import('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js');hook.deregister();after(()=>delete globalThis[authKey]);
function fixture(t){
 const names=['PI_CHATGPT_WEB_PROFILE_DIR','PI_CHATGPT_WEB_CHROME'],prev=names.map(k=>process.env[k]);process.env.PI_CHATGPT_WEB_PROFILE_DIR=mkdtempSync(join(tmpdir(),'browser-review-v2-'));process.env.PI_CHATGPT_WEB_CHROME=process.execPath;t.after(()=>names.forEach((k,i)=>prev[i]===undefined?delete process.env[k]:process.env[k]=prev[i]));
 const chrome=new ManagedChrome({closeTimeoutMs:20,captureTimeoutMs:5}),queue=[],events=[];let submit=async()=>{throw Error('fixture context disappeared after click');};
 chrome.puppeteer={launch:async()=>{events.push('launch');const x=queue.shift();if(x instanceof Error)throw x;assert.ok(x,'unexpected launch');return x;}};
 function browser(){const b=new EventEmitter();b.connected=true;b.tabClosed=false;b.page={isClosed:()=>b.tabClosed||!b.connected,evaluateOnNewDocument:async()=>{},goto:async()=>events.push('goto'),evaluate:async(fn,arg)=>{if(arg?.action==='submit'){events.push('ui-submit');return submit(arg.marker);}return {ownsText:false};}};b.pages=async()=>[b.page];b.close=async()=>{events.push('close');b.connected=false;b.emit('disconnected');};queue.push(b);return b;}
 chrome.prepareMintComposer=async marker=>({page:chrome.page,prepared:{marker,selector:'#fixture'}});chrome.ensureFetchInterception=async()=>{};
 return {chrome,queue,events,browser,setSubmit:f=>{submit=f;}};
}
const paused=marker=>({requestId:'fixture-paused',request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[marker]}}]})}});
async function unknown(t,order='owner-first'){
 const f=fixture(t),first=f.browser();f.browser();await f.chrome.ensureRunning();
 if(order==='disconnect-first')f.setSubmit(async()=>{first.connected=false;first.emit('disconnected');throw Error('fixture disconnected while sending');});
 await assert.rejects(withBrowserOperation(f.chrome,'chat','fixture-ui',()=>f.chrome.mintSentinelHeaders()),e=>e.generationSubmitted==='unknown');
 if(order==='owner-first'){first.connected=false;first.emit('disconnected');}else if(order==='tab-only'){first.tabClosed=true;}
 return {...f,first,marker:[...f.chrome.retiredMintMarkers][0]};
}
for(const order of ['owner-first','disconnect-first','tab-only'])test(`R1 actual UI unknown survives ${order} and blocks a fresh request`,async t=>{
 const f=await unknown(t,order);await assert.rejects(withBrowserOperation(f.chrome,'chat','fixture-next',()=>f.chrome.ensureRunning()),e=>e.code==='browser_generation_pending'&&e.generationSubmitted===false);await assert.rejects(f.chrome.doMint(),e=>e.code==='browser_generation_pending');assert.equal(f.events.filter(x=>x==='launch').length,1);assert.equal(f.events.filter(x=>x==='ui-submit').length,1);assert.equal(f.events.includes('close'),false);
});
test('R2 confirmed settled generation permits reconstruction after owner ends',async t=>{
 const f=fixture(t),first=f.browser(),next=f.browser();await f.chrome.ensureRunning();const client=new ChatClient(f.chrome);f.chrome.pendingGeneration={page:first.page,id:'settled-fixture'};client.observeSubmission=async()=>({state:'settled'});
 await withBrowserOperation(f.chrome,'chat','fixture-settled',async()=>{await client.assertNoPendingSubmission();operationPhase(f.chrome,'response',true);first.connected=false;first.emit('disconnected');});
 assert.equal(await f.chrome.ensureRunning(),next.page);assert.equal(f.events.filter(x=>x==='launch').length,2);
});
async function httpFixture(t,chrome){const app=new AdapterServer(adapterAuth);app.chrome=chrome;app.chat={run:()=>{throw Error('unexpected generation');}};app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.server.closeAllConnections();app.server.close();});return {app,url:`http://127.0.0.1:${app.server.address().port}`};}
for(const route of ['/health','/readiness'])test(`R3 ${route} reports the persisted UI transaction without touching the browser`,async t=>{
 const f=await unknown(t),{url}=await httpFixture(t,f.chrome);const counts=f.events.length;const r=await fetch(url+route),body=await r.json();assert.equal(r.status,200);assert.equal(body.busy,false);assert.equal(body.generationBlocked,true);assert.equal(f.events.length,counts);
});
test('persisted unknown UI stops a fresh POST before authentication',async t=>{
 const f=await unknown(t),{url}=await httpFixture(t,f.chrome);let auth=0;authHandlers.set(f.chrome,()=>{auth++;throw Error('must not authenticate');});const r=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'offline only'}]})});const body=await r.json();assert.equal(r.status,422);assert.equal(body.error.code,'browser_generation_pending');assert.equal(body.error.generation_submitted,false);assert.equal(auth,0);
});
test('only confirmation for the matching retired UI transaction clears its block',async t=>{
 const f=await unknown(t);await f.chrome.onRequestPaused({send:async()=>{}},paused('unrelated-marker'));await assert.rejects(f.chrome.ensureRunning(),e=>e.code==='browser_generation_pending');
 let confirmed=false;const commands=[],cdp={send:async method=>{commands.push(method);if(!confirmed)throw Error('abort unconfirmed');}};
 await assert.rejects(f.chrome.onRequestPaused(cdp,paused(f.marker)));await assert.rejects(f.chrome.ensureRunning(),e=>e.code==='browser_generation_pending');
 confirmed=true;await f.chrome.onRequestPaused(cdp,paused(f.marker));assert.deepEqual(commands,['Fetch.failRequest','Fetch.failRequest']);assert.equal(f.chrome.generationBlocked,false);await f.chrome.ensureRunning();assert.equal(f.events.filter(x=>x==='launch').length,2);
});
test('confirmed no-click does not leave an unresolved UI transaction',async t=>{
 const f=fixture(t),first=f.browser(),next=f.browser();await f.chrome.ensureRunning();f.setSubmit(async()=>false);await assert.rejects(f.chrome.mintSentinelHeaders(),e=>e.generationSubmitted===false);assert.equal(!!f.chrome.generationBlocked,false);first.connected=false;first.emit('disconnected');assert.equal(await f.chrome.ensureRunning(),next.page);
});
test('normal intercepted and confirmed cancellation permits a subsequent preparation',async t=>{
 const f=fixture(t);f.browser();await f.chrome.ensureRunning();f.setSubmit(async marker=>{await f.chrome.onRequestPaused({send:async()=>{}},paused(marker));return true;});await f.chrome.mintSentinelHeaders();await f.chrome.mintSentinelHeaders();assert.equal(!!f.chrome.generationBlocked,false);assert.equal(f.events.filter(x=>x==='ui-submit').length,2);
});
for(const mode of ['auth-refresh','cached-auth'])test(`launch classification survives ${mode} without raw exception text`,async t=>{
 const f=fixture(t);f.queue.push(Error('ProcessSingleton profile in use; private-fixture-secret'));const {app,url}=await httpFixture(t,f.chrome);authHandlers.set(f.chrome,mode==='auth-refresh'?()=>f.chrome.ensureRunning():async()=>'synthetic-only');app.chat.run=()=>f.chrome.ensureRunning();const r=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'offline only'}]})});const body=await r.json();assert.equal(r.status,502);assert.equal(body.error.code,'browser_profile_in_use');assert.equal(body.error.phase,'browser-launch');assert.equal(body.error.generation_submitted,false);assert.equal(JSON.stringify(body).includes('private-fixture-secret'),false);assert.equal(f.events.filter(x=>x==='launch').length,1);
});
test('wall-clock rollback cannot extend the bounded owned-child release',async t=>{
 const f=fixture(t),first=f.browser();const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.pid=12345;child.kill=()=>{setImmediate(()=>{child.exitCode=0;child.emit('exit');});return true;};first.process=()=>child;await f.chrome.ensureRunning();const original=Date.now;let reads=0;const wall=original();Date.now=()=>wall-(reads++?1000:0);const begin=performance.now();try{await f.chrome.close();}finally{Date.now=original;}assert.ok(performance.now()-begin<250,'wall clock extended the close budget');assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('error'),0);
});
