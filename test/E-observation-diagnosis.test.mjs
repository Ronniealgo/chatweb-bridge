import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import { withBrowserOperation, operationState, operationQueueState } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';
import { submissionFailureReason, safeSubmissionDetails } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/submission.js';
import { safeTransportDetails } from '../diagnostics.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{for(let n=0;n<100&&!fn();n++)await wait(2);assert.ok(fn());};

function fixture({hangRead=false,hangAbort=false}={}){
  let finish,posts=0,reads=0,abortCalls=0,fetchAborts=0;
  const body=new Promise(r=>{finish=r;});
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:async(_route,init)=>{
    posts++;init.signal.addEventListener('abort',()=>{fetchAborts++;finish('aborted fixture');},{once:true});
    return {ok:true,status:200,text:()=>body};
  }});
  const page={evaluate:(fn,...args)=>{
    if(fn.name==='observeConversationTransaction'){
      if(args[1]==='abort'){abortCalls++;if(hangAbort)return new Promise(()=>{});}
      if(args[1]==='read'||args[1]==='peek'){reads++;if(hangRead&&reads>=2&&abortCalls===0)return new Promise(()=>{});}
    }
    context.args=args;return Promise.resolve(structuredClone(vm.runInContext(`(${fn.toString()})(...args)`,context)));
  }};
  const chrome={};
  const client=new ChatClient(chrome,{observationTimeoutMs:25,cleanupMs:120,pollMs:2});
  return {client,chrome,page,finish,counts:()=>({posts,reads,abortCalls,fetchAborts})};
}

test('exact symptom: positive HTTP status, persistent observer loss, hanging abort, released owner and retained fence',{timeout:2000},async(t)=>{
  const f=fixture({hangRead:true,hangAbort:true}),signal=new AbortController();
  t.after(()=>f.finish('fixture shutdown'));
  const task=withBrowserOperation(f.chrome,'chat','offline-main-E',()=>f.client.postConversationInPage(f.page,{model:'offline'}, {},signal.signal));
  await assert.rejects(task,e=>{
    assert.equal(e.code,'browser_submission_uncertain');assert.equal(e.generationSubmitted,true);
    assert.equal(e.details.reason,'observation_timeout');assert.equal(e.details.terminationConfirmed,false);
    assert.equal(signal.signal.aborted,false,'main client never canceled');
    {assert.equal(e.details.observationAction,'peek');assert.equal(e.details.observationBudgetMs,25);assert.ok(['pending','observation_timeout'].includes(e.details.cleanupOutcome));assert.ok(['peek','abort'].includes(e.details.cleanupAction));assert.ok(e.details.cleanupObservationBudgetMs<=60);assert.equal(e.details.observationRecoveryCount,1);}
    return true;
  });
  assert.equal(f.counts().posts,1);assert.ok(f.counts().abortCalls>=1&&f.counts().abortCalls<=2);assert.equal(f.counts().fetchAborts,0,'abort could not execute in the simulated CDP stall');
  assert.equal(operationState(f.chrome),null);assert.ok(f.chrome.pendingGeneration);
  let warm=0,navigation=0;f.chrome.pageContext=async()=>{navigation++;return f.page;};
  await withBrowserOperation(f.chrome,'keep-warm','offline-warm',()=>{warm++;},{background:true});
  await assert.rejects(f.client.runExclusive({prompt:'must not submit'},'offline-placeholder'),e=>e.code==='browser_generation_pending');
  assert.equal(warm,0);assert.equal(navigation,0);assert.equal(f.counts().posts,1);
  f.finish('discarded late mock result');await wait(2);
});

test('a queued request cancellation removes its entry and never aborts the generating owner',{timeout:2000},async(t)=>{
  const f=fixture(),mainSignal=new AbortController(),probeSignal=new AbortController();
  t.after(()=>f.finish('fixture shutdown'));
  const main=withBrowserOperation(f.chrome,'chat','offline-generating-owner',()=>f.client.postConversationInPage(f.page,{}, {},mainSignal.signal),{signal:mainSignal.signal});
  await until(()=>f.counts().posts===1&&f.counts().reads>0);
  let queuedAction=0;
  const probe=withBrowserOperation(f.chrome,'chat','offline-queue-probe',()=>{queuedAction++;},{queue:true,signal:probeSignal.signal});
  const rejected=assert.rejects(probe,e=>e.code==='adapter_queue_cancelled'&&e.generationSubmitted===false);
  assert.equal(operationQueueState(f.chrome).queued,1);probeSignal.abort();await rejected;
  assert.equal(operationState(f.chrome).requestId,'offline-generating-owner');assert.equal(operationQueueState(f.chrome).queued,0);
  assert.equal(mainSignal.signal.aborted,false);assert.equal(f.counts().abortCalls,0);assert.equal(f.counts().fetchAborts,0);assert.equal(queuedAction,0);assert.equal(f.counts().posts,1);
  f.finish('main remains intact');assert.equal(await main,'main remains intact');assert.equal(f.chrome.pendingGeneration,null);
});

test('an observation error with positively confirmed abort is a failure but clears the fence safely',{timeout:2000},async(t)=>{
  const f=fixture({hangRead:true});
  t.after(()=>f.finish('fixture shutdown'));
  await assert.rejects(f.client.postConversationInPage(f.page,{},{}),e=>{
    assert.equal(e.details.reason,'observation_timeout');assert.equal(e.details.terminationConfirmed,true);
    {assert.equal(e.details.cleanupOutcome,'settled');assert.equal(e.details.observationAction,'peek');}
    return true;
  });
  assert.equal(f.counts().posts,1);assert.equal(f.counts().fetchAborts,1);assert.equal(f.chrome.pendingGeneration,null);
});

test('180s CDP classification is distinct from the 5s observation budget',()=>{
  assert.equal(submissionFailureReason({message:'Runtime.callFunctionOn timed out; protocolTimeout'}),'cdp_timeout');
  assert.equal(submissionFailureReason({code:'observation_timeout',message:'local bound'}),'observation_timeout');
  const c=new ChatClient({});assert.deepEqual([c.submission.timeoutMs,c.submission.observationTimeoutMs,c.submission.cleanupMs],[240000,5000,2000]);
});

test('additional diagnostics stay on fixed enums and bounded numbers without exception text',()=>{
  const input={reason:'observation_timeout',elapsedMs:42425,terminationConfirmed:false,observationAction:'read',observationBudgetMs:5000,cleanupOutcome:'observation_timeout',cleanupAction:'abort',cleanupObservationBudgetMs:2000,rawError:'PRIVATE_FIXTURE_ONLY',headers:{authorization:'PRIVATE_FIXTURE_ONLY'}};
  for(const filter of [safeSubmissionDetails,safeTransportDetails]){
    const safe=filter(input);assert.equal(JSON.stringify(safe).includes('PRIVATE_FIXTURE_ONLY'),false);
    {assert.equal(safe.observationAction,'read');assert.equal(safe.cleanupAction,'abort');assert.equal(safe.cleanupObservationBudgetMs,2000);
      const bad=filter({...input,observationAction:'PRIVATE_FIXTURE_ONLY',observationBudgetMs:Infinity,cleanupOutcome:'PRIVATE_FIXTURE_ONLY',cleanupAction:'PRIVATE_FIXTURE_ONLY',cleanupObservationBudgetMs:-1});
      assert.equal(JSON.stringify(bad).includes('PRIVATE_FIXTURE_ONLY'),false);assert.equal(bad.observationBudgetMs,undefined);assert.equal(bad.cleanupObservationBudgetMs,undefined);
    }
  }
});
