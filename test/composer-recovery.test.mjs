import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(upstreamToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {prepareComposer,submitComposerOnce,clearOwnedComposer,BrowserPreparationError} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/composer.js';
import {ManagedChrome} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';
import {AdapterServer} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js';
import {operationQueueState} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';

function ui({pending=false,draft='',gate=false,button=true}={}){
 let clock=0,focused=false,text=draft,placeholder=pending;
 const actions=[];
 const page={url:()=> 'https://chatgpt.com/',
  focus:async selector=>{actions.push(['focus',selector]);if(selector.includes('pending'))placeholder=false;else focused=true;},
  keyboard:{type:async value=>{assert.equal(placeholder,false,'never type into hydration placeholder');actions.push(['type',value]);text+=value;},down:async()=>{},up:async()=>{},press:async key=>{actions.push(['key',key]);if(key==='Backspace')text='';}},
  evaluate:async(_fn,arg)=>{
   if(arg.editors)return {gate,ready:!placeholder,pending:placeholder,selector:'#prompt-textarea',focused,textLength:text.length,ownsText:text===arg.marker,sendReady:button};
   actions.push(['send']);return true;
  }};
 return {page,actions,options:{now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:1000},setText:value=>{text=value;},getText:()=>text};
}
test('cold placeholder hydrates before typing; one button send and no Enter',async()=>{
 const f=ui({pending:true});const p=await prepareComposer(f.page,f.options);await submitComposerOnce(f.page,p);
 assert.equal(f.actions.filter(x=>x[0]==='type').length,1);assert.equal(f.actions.filter(x=>x[0]==='send').length,1);
 assert.equal(f.actions.some(x=>x[1]==='Enter'),false);
});
test('existing draft and access challenge stop without typing, clearing, or sending',async()=>{
 for(const opts of [{draft:'user draft'},{gate:true}]){const f=ui(opts);await assert.rejects(prepareComposer(f.page,f.options),BrowserPreparationError);assert.equal(f.actions.length,0);}
});

test('an explicit login prompt stops immediately without recovery navigation or typing',async()=>{
 const f=ui();f.page.evaluate=async()=>({loginRequired:true,gate:true,ready:false});
 await assert.rejects(prepareComposer(f.page,f.options),e=>e.code==='browser_login_required'&&e.generationSubmitted===false);
 assert.equal(f.actions.length,0);
 const c=new ManagedChrome();c.ensureRunning=async()=>f.page;
 let navigations=0;f.page.url=()=> 'https://chatgpt.com/c/fixture';f.page.goto=async()=>{navigations++;};
 await assert.rejects(c.prepareMintComposer('fixture'),e=>e.code==='browser_login_required');
 assert.equal(navigations,0);
});
test('input lost during hydration is retyped before any send',async()=>{
 const f=ui();const evaluate=f.page.evaluate;let lost=false;
 f.page.evaluate=async(fn,arg)=>{if(arg.editors&&f.getText()&&!lost){lost=true;f.setText('');}return evaluate(fn,arg);};
 const p=await prepareComposer(f.page,f.options);await submitComposerOnce(f.page,p);
 assert.equal(f.actions.filter(x=>x[0]==='type').length,2);assert.equal(f.actions.filter(x=>x[0]==='send').length,1);
});
test('disabled send times out before submission and owned text can be cleared safely',async()=>{
 const f=ui({button:false});await assert.rejects(prepareComposer(f.page,f.options),e=>e.phase==='prepare'&&e.generationSubmitted===false);
 assert.equal(f.actions.some(x=>x[0]==='send'),false);await clearOwnedComposer(f.page);assert.equal(f.getText(),'');
 f.setText('a user draft');await clearOwnedComposer(f.page);assert.equal(f.getText(),'a user draft');
});
test('replacement before focus is retried without typing under stale focus',async()=>{
 const f=ui();const focus=f.page.focus;let replaced=false;
 f.page.focus=async selector=>{if(!replaced){replaced=true;throw Error('Node is detached');}return focus(selector);};
 await prepareComposer(f.page,f.options);assert.equal(f.actions.filter(x=>x[0]==='type').length,1);
});
test('connection failure at submit is uncertain and never replays',async()=>{
 const f=ui();const p=await prepareComposer(f.page,f.options);let sends=0;
 f.page.evaluate=async()=>{sends++;throw Error('Execution context destroyed');};
 await assert.rejects(submitComposerOnce(f.page,p),e=>e.generationSubmitted==='unknown');assert.equal(sends,1);
});
test('unexpected focus failure stops before typing or submission',async()=>{
 const f=ui();f.page.focus=async()=>{throw Error('Browser connection lost');};
 await assert.rejects(prepareComposer(f.page,f.options),/connection lost/);assert.equal(f.actions.length,0);
});

test('a transient execution-context loss during preparation recovers before one send',async()=>{
 const f=ui();const evaluate=f.page.evaluate;let lost=false;
 f.page.evaluate=async(fn,arg)=>{if(!lost){lost=true;throw Error('Execution context was destroyed');}return evaluate(fn,arg);};
 const p=await prepareComposer(f.page,f.options);await submitComposerOnce(f.page,p);
 assert.equal(f.actions.filter(x=>x[0]==='send').length,1);
});
test('draft arriving during focus is never overwritten or appended to',async()=>{
 const f=ui();const focus=f.page.focus;f.page.focus=async selector=>{await focus(selector);f.setText('foreign draft');};
 await assert.rejects(prepareComposer(f.page,f.options),e=>e.code==='browser_draft_changed');assert.equal(f.getText(),'foreign draft');assert.equal(f.actions.some(x=>x[0]==='type'),false);
});
test('cleanup rechecks the draft after changing focus',async()=>{
 const f=ui({draft:'own'});const focus=f.page.focus;f.page.focus=async selector=>{await focus(selector);f.setText('new user draft');};
 await clearOwnedComposer(f.page,'own');assert.equal(f.getText(),'new user draft');assert.equal(f.actions.some(x=>x[1]==='Backspace'),false);
});
test('pre-send recovery reloads at most once and never discards a foreign draft',async()=>{
 const f=ui();const c=new ManagedChrome({preparationTimeoutMs:300});let ready=false,reloads=0;
 c.ensureRunning=async()=>f.page;c.ensureComposer=async()=>{};
 const evaluate=f.page.evaluate;f.page.evaluate=async(fn,arg)=>{const state=await evaluate(fn,arg);if(arg.editors)state.sendReady=ready;return state;};
 f.page.goto=async()=>{reloads++;ready=true;};
 await c.prepareMintComposer('probe');assert.equal(reloads,1);assert.equal(f.actions.some(x=>x[0]==='send'),false);
 f.setText('foreign draft');await assert.rejects(c.prepareMintComposer('other'),e=>e.code==='browser_draft_present');assert.equal(reloads,1);assert.equal(f.getText(),'foreign draft');
});
test('capture cancellation releases promptly without a second send and retires the probe',async()=>{
 const f=ui();const c=new ManagedChrome({captureTimeoutMs:30000});const controller=new AbortController();
 c.ensureRunning=async()=>f.page;c.ensureFetchInterception=async()=>{};c.ensureComposer=async()=>{};
 const evaluate=f.page.evaluate;f.page.evaluate=async(fn,arg)=>{const result=await evaluate(fn,arg);if(arg.action==='submit')controller.abort();return result;};
 await assert.rejects(c.doMint({signal:controller.signal}),e=>e.code==='browser_cancelled'&&e.generationSubmitted==='unknown');
 assert.equal(f.actions.filter(x=>x[0]==='send').length,1);assert.equal(c.retiredMintMarkers.size,1);assert.equal(f.getText(),'');
});

test('navigation settling only retries read-only checks before any generation',async()=>{
 const c=new ManagedChrome();let clock=0,reads=0;
 const page={evaluate:async()=>{reads++;if(reads===1)throw Error('Execution context was destroyed');if(reads===3)c.navigationVersion++;return true;}};
 await c.waitForStableContext(page,null,{now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:5000});assert.ok(reads>=5);
 clock=0;await assert.rejects(c.waitForStableContext({evaluate:async()=>false},null,{now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:700}),e=>e.code==='browser_context_unavailable'&&e.generationSubmitted===false);
});
test('confirmed capture supports consecutive tool rounds without retaining input',async()=>{
 const f=ui();const c=new ManagedChrome({captureTimeoutMs:1000});c.ensureRunning=async()=>f.page;c.ensureFetchInterception=async()=>{};c.ensureComposer=async()=>{};
 const evaluate=f.page.evaluate;
 f.page.evaluate=async(fn,arg)=>{
  if(!arg.editors){await c.onRequestPaused({send:async()=>{}},{requestId:'test-only',request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[arg.marker]}}]}),headers:{'test-only-fixture':'not-a-security-proof'}}});}
  return evaluate(fn,arg);
 };
 for(let i=0;i<3;i++){await c.doMint();assert.equal(f.getText(),'');assert.equal(c.mintResolve,null);}
 assert.equal(f.actions.filter(x=>x[0]==='send').length,3);
});
test('changed editor before clicking is a confirmed no-send failure',async()=>{
 const f=ui();const p=await prepareComposer(f.page,f.options);f.page.evaluate=async()=>false;
 await assert.rejects(submitComposerOnce(f.page,p),e=>e.generationSubmitted===false);
});
test('six sequential preparations and cleanup do not leave stale drafts',async()=>{
 const f=ui();for(let i=0;i<6;i++){const marker='probe-'+i;const p=await prepareComposer(f.page,{...f.options,marker});await submitComposerOnce(f.page,p);await clearOwnedComposer(f.page,marker);}
 assert.equal(f.actions.filter(x=>x[0]==='send').length,6);assert.equal(f.getText(),'');
});
test('capture timeout cleans owned input, never resubmits and guards delayed probe',async()=>{
 const f=ui();const c=new ManagedChrome({captureTimeoutMs:5});c.ensureRunning=async()=>f.page;c.ensureFetchInterception=async()=>{};c.ensureComposer=async()=>{};
 await assert.rejects(c.doMint(),e=>e.code==='browser_submission_uncertain');
 assert.equal(f.actions.filter(x=>x[0]==='send').length,1);assert.equal(f.getText(),'');assert.equal(c.mintResolve,null);
 const marker=[...c.retiredMintMarkers][0];const commands=[];
 await c.onRequestPaused({send:async method=>commands.push(method)},{requestId:'late',request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[marker]}}]})}});
 assert.deepEqual(commands,['Fetch.failRequest']);
});
test('interception only captures its own probe and refuses unconfirmed abort',async()=>{
 const c=new ManagedChrome();c.mintMarker='own-probe';const commands=[];let captured=false,rejected;
 c.mintResolve=()=>{captured=true;};c.mintReject=e=>{rejected=e;};
 const ev=text=>({requestId:'r',request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[text]}}]})}});
 await c.onRequestPaused({send:async method=>commands.push(method)},ev('unrelated'));assert.deepEqual(commands,['Fetch.continueRequest']);assert.equal(captured,false);
 await c.onRequestPaused({send:async()=>{throw Error('disconnected');}},ev('own-probe'));assert.equal(captured,false);assert.equal(rejected.generationSubmitted,'unknown');
});
test('adapter serializes direct callers and recovers after failure',async t=>{
 const app=new AdapterServer(adapterAuth);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.server.close());
 let release;const gate=new Promise(r=>{release=r;});let calls=0;
 app.handleChatExclusive=async(_req,res)=>{calls++;await gate;return app.chatError(res,new BrowserPreparationError('not ready'));};
 const url=`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`;
 const first=fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});while(!app.busy)await new Promise(r=>setTimeout(r,1));
 const second=fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});while(!operationQueueState(app.chrome).queued)await new Promise(r=>setTimeout(r,1));assert.equal(calls,1);release();
 for(const pending of [first,second]){const failed=await pending;assert.equal(failed.status,422);assert.equal((await failed.json()).error.generation_submitted,false);}
 assert.equal(calls,2);assert.equal(app.busy,false);
 app.handleChatExclusive=async(_req,res)=>app.json(res,200,{ok:true});assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
});
