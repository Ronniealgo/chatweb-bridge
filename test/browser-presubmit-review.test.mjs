import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {ManagedChrome} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';
import {ChatClient} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
const paused=(marker,id)=>({requestId:id,request:{url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({messages:[{content:{parts:[marker]}}]})}});
function fixture(){
 let posts=0,starts=0,marker;const commands=[];
 const context=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:async()=>{posts++;return {status:200,ok:true,text:async()=>'offline-fixture'};}});
 const chrome=new ManagedChrome({captureTimeoutMs:1000});
 const cdp={send:async(method,{requestId})=>{commands.push({method,requestId});if(requestId==='late-B')throw Error('late cancellation unconfirmed');}};
 const page={evaluate:async(fn,...args)=>{
  if(args[0]?.action==='submit'){marker=args[0].marker;await chrome.onRequestPaused(cdp,paused(marker,'probe-A'));return true;}
  if(fn.name==='startConversationTransaction'||fn.name==='observeConversationTransaction'){
   if(fn.name==='startConversationTransaction')starts++;
   context.args=args;return structuredClone(vm.runInContext(`(${fn.toString()})(...args)`,context));
  }
  return {ownsText:false};
 }};
 chrome.page=page;chrome.prepareMintComposer=async m=>({page,prepared:{marker:m,selector:'#fixture'}});chrome.ensureFetchInterception=async()=>{};
 const client=new ChatClient(chrome,{pollMs:1,observationTimeoutMs:30,cleanupMs:20});
 return {chrome,client,page,cdp,commands,counts:()=>({posts,starts}),inject:async()=>assert.rejects(chrome.onRequestPaused(cdp,paused(marker,'late-B')))};
}
test('R5 late unconfirmed probe during stable-context wait prevents the real ChatClient POST',async()=>{
 const f=fixture();f.chrome.waitForStableContext=f.inject;
 let error;try{await f.client.sendWithSentinel(f.page,{model:'fixture'},'synthetic-fixture');}catch(e){error=e;}
 console.log(JSON.stringify({case:'R5-stable-context',...f.counts(),blocked:f.chrome.generationBlocked,code:error?.code}));
 assert.equal(f.counts().posts,0);assert.equal(f.counts().starts,0);assert.equal(error?.code,'browser_generation_pending');assert.equal(error.generationSubmitted,false);
});
test('R5 the final await before transaction start must not bypass a newly raised UI fence',async()=>{
 const f=fixture();await f.chrome.mintSentinelHeaders();
 f.client.assertNoPendingSubmission=async()=>{await f.inject();};
 let error;try{await f.client.postConversationInPage(f.page,{model:'fixture'},{});}catch(e){error=e;}
 assert.equal(f.counts().posts,0);assert.equal(error?.code,'browser_generation_pending');
});
test('R5 request-stage interception does not continue a real request after UI cancellation became unknown',async()=>{
 const f=fixture();await f.chrome.mintSentinelHeaders();await f.inject();
 await f.chrome.onRequestPaused(f.cdp,paused('real-user-task','real-request'));
 assert.deepEqual(f.commands.filter(x=>x.requestId==='real-request'),[{method:'Fetch.failRequest',requestId:'real-request'}]);
 assert.equal(f.chrome.generationBlocked,true);
});