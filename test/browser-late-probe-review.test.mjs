import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedChrome} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';
const paused=(marker,requestId)=>({requestId,request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[marker]}}]})}});
async function heldClick(mode){
 const chrome=new ManagedChrome({captureTimeoutMs:mode==='timeout'?5:1000});
 let begin,release,marker;
 const entered=new Promise(r=>begin=r),click=new Promise(r=>release=r);
 const page={evaluate:async(fn,arg)=>{if(arg?.action==='submit'){marker=arg.marker;begin();return click;}return {ownsText:false};}};
 chrome.page=page;
 chrome.prepareMintComposer=async m=>({page,prepared:{marker:m,selector:'#fixture'}});
 chrome.ensureFetchInterception=async()=>{};
 const ctl=new AbortController();
 const outcome=chrome.mintSentinelHeaders({signal:ctl.signal}).then(()=>({ok:true}),e=>({ok:false,code:e.code}));
 await entered;
 if(mode==='cancel')ctl.abort();else await new Promise(r=>setTimeout(r,20));
 return {chrome,marker,release,outcome};
}
for(const mode of ['cancel','timeout'])test(`R4 ${mode} while click pending never continues the late owned probe`,async()=>{
 const f=await heldClick(mode),commands=[];
 try {await f.chrome.onRequestPaused({send:async(method,args)=>commands.push({method,requestId:args.requestId})},paused(f.marker,'A'));}
 finally {f.release(true);await f.outcome;}
 console.log(JSON.stringify({case:mode,commands,blocked:f.chrome.generationBlocked}));
 assert.deepEqual(commands,[{method:'Fetch.failRequest',requestId:'A'}]);
});
test('R4 cancelling a different requestId cannot prove the previously continued probe ended',async()=>{
 const f=await heldClick('cancel'),commands=[];
 const cdp={send:async(method,args)=>commands.push({method,requestId:args.requestId})};
 await f.chrome.onRequestPaused(cdp,paused(f.marker,'A'));
 f.release(true);await f.outcome;
 await f.chrome.onRequestPaused(cdp,paused(f.marker,'B'));
 const unsafe=commands.some(x=>x.method==='Fetch.continueRequest'&&x.requestId==='A')&&!f.chrome.generationBlocked;
 console.log(JSON.stringify({case:'different-requestId',commands,blocked:f.chrome.generationBlocked,unsafeRelease:unsafe}));
 assert.equal(unsafe,false,'request A has no termination evidence but request B cancelled cleared its block');
});
test('R4 a confirmed cancellation does not release a still-pending click',async()=>{
 const f=await heldClick('cancel');
 await f.chrome.onRequestPaused({send:async()=>{}},paused(f.marker,'A'));
 assert.equal(f.chrome.generationBlocked,true);
 f.release(true);await f.outcome;
 assert.equal(f.chrome.generationBlocked,false);
});
test('R4 cancelling B cannot clear A with an unconfirmed cancellation',async()=>{
 const f=await heldClick('cancel');let allowA=false;
 const cdp={send:async(method,{requestId})=>{assert.equal(method,'Fetch.failRequest');if(requestId==='A'&&!allowA)throw Error('A termination unconfirmed');}};
 await assert.rejects(f.chrome.onRequestPaused(cdp,paused(f.marker,'A')));
 f.release(true);await f.outcome;
 await f.chrome.onRequestPaused(cdp,paused(f.marker,'B'));
 assert.equal(f.chrome.generationBlocked,true);
 await assert.rejects(f.chrome.ensureRunning(),e=>e.code==='browser_generation_pending');
 allowA=true;await f.chrome.onRequestPaused(cdp,paused(f.marker,'A'));
 assert.equal(f.chrome.generationBlocked,false);
});
test('R4 the same requestId on another CDP session cannot clear an uncertain request',async()=>{
 const f=await heldClick('cancel');let allow=false;
 const first={send:async()=>{if(!allow)throw Error('first session uncertain');}},second={send:async()=>{}};
 await assert.rejects(f.chrome.onRequestPaused(first,paused(f.marker,'same-id')));
 f.release(true);await f.outcome;
 await f.chrome.onRequestPaused(second,paused(f.marker,'same-id'));
 assert.equal(f.chrome.generationBlocked,true);
 allow=true;await f.chrome.onRequestPaused(first,paused(f.marker,'same-id'));
 assert.equal(f.chrome.generationBlocked,false);
});
test('R4 all concurrent cancellation acknowledgements are required',async()=>{
 const f=await heldClick('cancel');let releaseB;
 const waitingB=new Promise(r=>releaseB=r);
 const cdp={send:async(method,{requestId})=>{if(requestId==='B')await waitingB;}};
 const a=f.chrome.onRequestPaused(cdp,paused(f.marker,'A'));
 const b=f.chrome.onRequestPaused(cdp,paused(f.marker,'B'));
 await a;f.release(true);await f.outcome;
 assert.equal(f.chrome.generationBlocked,true);
 releaseB();await b;assert.equal(f.chrome.generationBlocked,false);
});
test('R4 a failed late duplicate restores the fence and a different successful duplicate cannot clear it',async()=>{
 const f=await heldClick('cancel');let allowB=false;
 const cdp={send:async(method,{requestId})=>{if(requestId==='B'&&!allowB)throw Error('late B uncertain');}};
 await f.chrome.onRequestPaused(cdp,paused(f.marker,'A'));
 f.release(true);await f.outcome;assert.equal(f.chrome.generationBlocked,false);
 await assert.rejects(f.chrome.onRequestPaused(cdp,paused(f.marker,'B')));
 await f.chrome.onRequestPaused(cdp,paused(f.marker,'C'));
 assert.equal(f.chrome.generationBlocked,true);
 allowB=true;await f.chrome.onRequestPaused(cdp,paused(f.marker,'B'));
 assert.equal(f.chrome.generationBlocked,false);
});
test('R4 cancellation evidence for a different marker cannot clear unresolved transactions',async()=>{
 const chrome=new ManagedChrome();chrome.retiredMintMarkers.add('owned-one');chrome.retiredMintMarkers.add('owned-two');
 const confirmed=new Set(),cdp={send:async(method,{requestId})=>{if(!confirmed.has(requestId))throw Error('not yet confirmed');}};
 await assert.rejects(chrome.onRequestPaused(cdp,paused('owned-one','A')));
 await assert.rejects(chrome.onRequestPaused(cdp,paused('owned-two','B')));
 confirmed.add('A');await chrome.onRequestPaused(cdp,paused('owned-one','A'));
 assert.equal(chrome.generationBlocked,true);
 confirmed.add('B');await chrome.onRequestPaused(cdp,paused('owned-two','B'));
 assert.equal(chrome.generationBlocked,false);
});
test('R4 a synchronous cancellation failure can only clear after exact later confirmation',async()=>{
 const f=await heldClick('cancel');let allow=false;
 const cdp={send:()=>{if(!allow)throw Error('synchronous CDP failure');return Promise.resolve();}};
 await assert.rejects(f.chrome.onRequestPaused(cdp,paused(f.marker,'A')));
 f.release(true);await f.outcome;assert.equal(f.chrome.generationBlocked,true);
 allow=true;await f.chrome.onRequestPaused(cdp,paused(f.marker,'A'));
 assert.equal(f.chrome.generationBlocked,false);
});
test('R4 old owned markers remain intercepted after more than sixteen preparations',async()=>{
 const chrome=new ManagedChrome();let first;
 chrome.prepareMintComposer=async marker=>{first??=marker;throw Error('fixture no click');};
 for(let i=0;i<18;i++)await assert.rejects(chrome.doMint());
 const commands=[];await chrome.onRequestPaused({send:async method=>commands.push(method)},paused(first,'late-old'));
 assert.deepEqual(commands,['Fetch.failRequest']);assert.equal(chrome.generationBlocked,false);
});
