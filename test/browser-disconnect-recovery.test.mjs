import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedChrome} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';
import {withBrowserOperation,operationPhase} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';
function fixture(t){
 const names=['PI_CHATGPT_WEB_PROFILE_DIR','PI_CHATGPT_WEB_CHROME'];const prev=names.map(k=>process.env[k]);
 process.env.PI_CHATGPT_WEB_PROFILE_DIR=mkdtempSync(join(tmpdir(),'browser-disconnect-fixture-'));process.env.PI_CHATGPT_WEB_CHROME=process.execPath;
 t.after(()=>names.forEach((k,i)=>prev[i]===undefined?delete process.env[k]:process.env[k]=prev[i]));
 const chrome=new ManagedChrome({closeTimeoutMs:30}),queue=[],events=[];
 chrome.puppeteer={launch:async()=>{events.push('launch');const x=queue.shift();if(x instanceof Error)throw x;assert.ok(x,'unexpected launch');return x;}};
 function browser(close){const b=new EventEmitter();b.connected=true;b.page={isClosed:()=>!b.connected,evaluateOnNewDocument:async()=>{},goto:async()=>{events.push('navigate');}};b.pages=async()=>[b.page];b.close=async()=>{events.push('close');await close?.();b.connected=false;b.emit('disconnected');};queue.push(b);return b;}
 function child(){const c=new EventEmitter();c.pid=12345;c.exitCode=null;c.signalCode=null;c.kill=()=>{throw Error('unexpected kill');};c.exit=()=>{c.exitCode=0;events.push('exit');c.emit('exit',0,null);};return c;}
 return {chrome,queue,events,browser,child};
}
test('resolved close still waits for child exit before profile reuse',async t=>{
 const f=fixture(t),c=f.child();const first=f.browser(()=>{setTimeout(()=>c.exit(),10);});first.process=()=>c;const next=f.browser();
 await f.chrome.ensureRunning();first.connected=false;first.emit('disconnected');
 const original=f.chrome.puppeteer.launch;f.chrome.puppeteer.launch=async()=>{assert.notEqual(c.exitCode,null,'old Chrome still owns profile');return original();};
 assert.equal(await f.chrome.ensureRunning(),next.page);assert.ok(f.events.indexOf('exit')<f.events.lastIndexOf('launch'));
});
test('resolved close with a live child uses bounded owned-child termination',async t=>{
 const f=fixture(t),c=f.child();let kills=0;c.kill=s=>{assert.equal(s,'SIGKILL');kills++;setImmediate(()=>c.exit());return true;};
 const first=f.browser();first.process=()=>c;const next=f.browser();await f.chrome.ensureRunning();first.connected=false;first.emit('disconnected');
 assert.equal(await f.chrome.ensureRunning(),next.page);assert.equal(kills,1);assert.equal(c.listenerCount('exit'),0);assert.equal(c.listenerCount('error'),0);
});
test('unconfirmed process exit retains owner and blocks replacement',async t=>{
 const f=fixture(t),c=f.child();c.kill=()=>false;const first=f.browser();first.process=()=>c;f.browser();await f.chrome.ensureRunning();first.connected=false;first.emit('disconnected');
 await assert.rejects(f.chrome.ensureRunning(),/Could not terminate/);assert.equal(f.chrome.browser,first);assert.equal(f.events.filter(x=>x==='launch').length,1);
});
test('pending generation survives disconnect without closing or relaunching',async t=>{
 const f=fixture(t),first=f.browser();f.browser();await f.chrome.ensureRunning();const pending={page:first.page,id:'fixture-unknown'};f.chrome.pendingGeneration=pending;first.connected=false;first.emit('disconnected');
 await assert.rejects(f.chrome.ensureRunning(),e=>e.code==='browser_generation_pending');assert.equal(f.chrome.pendingGeneration,pending);assert.equal(f.chrome.browser,first);assert.equal(f.events.filter(x=>x==='launch').length,1);assert.equal(f.events.includes('close'),false);
});
for(const submitted of [true,'unknown'])test(`active ${submitted} submission never reconstructs its browser`,async t=>{
 const f=fixture(t),first=f.browser();f.browser();await f.chrome.ensureRunning();first.connected=false;first.emit('disconnected');
 await withBrowserOperation(f.chrome,'chat','fixture-submission',async()=>{operationPhase(f.chrome,'response',submitted);await assert.rejects(f.chrome.ensureRunning(),e=>e.code==='browser_generation_pending'&&e.generationSubmitted===submitted);});assert.equal(f.events.includes('close'),false);
});
test('known unsubmitted request can recover exactly once before any generation',async t=>{
 const f=fixture(t),first=f.browser();const next=f.browser();await f.chrome.ensureRunning();first.connected=false;first.emit('disconnected');
 await withBrowserOperation(f.chrome,'chat','fixture-not-submitted',async()=>{operationPhase(f.chrome,'prepare',false);assert.equal(await f.chrome.ensureRunning(),next.page);});assert.equal(f.events.filter(x=>x==='launch').length,2);
});
for(const [message,code] of [['Failed to launch the browser process! private-fixture-value','browser_launch_failed'],['Timed out while waiting for the WS endpoint URL','browser_launch_timeout'],['ProcessSingleton profile is in use','browser_profile_in_use']])test(`launch error class ${code} is safe and does not retry`,async t=>{
 const f=fixture(t);f.queue.push(Error(message));await assert.rejects(f.chrome.ensureRunning(),e=>e.code===code&&e.phase==='browser-launch'&&e.generationSubmitted===false&&!e.message.includes('private-fixture-value'));assert.equal(f.events.filter(x=>x==='launch').length,1);assert.equal(f.chrome.booting,null);
});

