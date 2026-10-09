import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const { ChatClient } = await import(new URL('runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js', root));
const { operationState, withBrowserOperation } = await import(new URL('runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js', root));
const { safeTransportDetails } = await import(new URL('diagnostics.mjs', root));
const { startConversationTransaction, observeConversationTransaction } = await import(new URL('runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/submission.js', root));
const never = () => new Promise(() => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n=0; n<200 && !check(); n++) await pause(1); assert.ok(check()); }

// Execute the actual page transaction functions against fake fetch and stream.
// Hooks drop/delay only CDP replies; they cannot issue a model HTTP request.
function fixture({ ignoreAbort=false, observationTimeoutMs=40, cleanupMs=120, timeoutMs=1000, text='synthetic-complete-result' }={}) {
  let resolveFetch, rejectFetch, resolveText, rejectText;
  const headers = new Promise((resolve,reject) => { resolveFetch=resolve; rejectFetch=reject; });
  const stream = new Promise((resolve,reject) => { resolveText=resolve; rejectText=reject; });
  // Avoid fixture-only unhandled rejection when cancellation precedes headers.
  stream.catch(() => {});
  const counts={posts:0,starts:0,abortCommands:0,abortEvents:0,bodyReads:0,peeks:0,consumes:0};
  const context=vm.createContext({ AbortController,setTimeout,clearTimeout,
    fetch:(_route,init) => {
      counts.posts++;
      init.signal.addEventListener('abort',() => {
        counts.abortEvents++;
        if(!ignoreAbort){rejectFetch(Error('synthetic cancellation'));rejectText(Error('synthetic cancellation'));}
      },{once:true});
      return headers;
    }
  });
  const f={counts,hook:null};
  f.page={evaluate:async(fn,...args) => {
    const isObservation=fn.name==='observeConversationTransaction';
    const action=isObservation?(args[1]??'read'):'start';
    if(action==='start')counts.starts++;
    else if(action==='abort')counts.abortCommands++;
    else if(action==='peek')counts.peeks++;
    else if(action==='read')counts.bodyReads++;
    else if(action==='consume')counts.consumes++;
    const run=() => {
      context.args=args;
      const state=vm.runInContext(`(${fn.toString()})(...args)`,context);
      assert.equal(typeof state?.then,'undefined','Page control calls must not await fetch');
      return structuredClone(state);
    };
    return isObservation && f.hook ? f.hook({action,run}) : run();
  }};
  f.chrome={};
  f.client=new ChatClient(f.chrome,{observationTimeoutMs,cleanupMs,pollMs:2,timeoutMs});
  f.openHeaders=() => resolveFetch({status:200,ok:true,text:() => stream});
  f.finish=() => {f.openHeaders();resolveText(text);};
  f.run=signal => withBrowserOperation(f.chrome,'chat','resilience-fixture',() => f.client.postConversationInPage(f.page,{}, {},signal));
  return f;
}

test('one lost state reply recovers without cancelling or repeating POST', {timeout:2000},async() => {
  const f=fixture();let lost=false;
  f.hook=({action,run}) => {
    if(['peek','read'].includes(action) && !lost){lost=true;run();return never();}
    if(['peek','read'].includes(action)){f.finish();}
    return run();
  };
  const result=await f.run();
  assert.equal(result,'synthetic-complete-result');
  assert.equal(f.counts.posts,1);assert.equal(f.counts.starts,1);assert.equal(f.counts.abortEvents,0);
  assert.equal(f.chrome.pendingGeneration,null);assert.equal(operationState(f.chrome),null);
});

test('pending polls carry metadata only and copy the response body once', {timeout:2000},async() => {
  const f=fixture({text:'x'.repeat(2_000_000)});let polls=0;
  f.hook=({action,run}) => {
    if(['peek','read'].includes(action)){if(++polls===4)f.finish();}
    return run();
  };
  assert.equal((await f.run()).length,2_000_000);
  assert.ok(f.counts.peeks>=4);assert.equal(f.counts.bodyReads,1);assert.equal(f.counts.posts,1);
});

test('lost completed-body reply recovers by reading the same settled slot', {timeout:2000},async() => {
  const f=fixture();let lost=false;
  f.hook=({action,run}) => {
    f.finish();const state=run();
    if(action==='read' && state.state==='settled' && !lost){lost=true;return never();}
    return state;
  };
  assert.equal(await f.run(),'synthetic-complete-result');
  assert.equal(f.counts.posts,1);assert.equal(f.counts.abortEvents,0);assert.equal(f.counts.bodyReads,2);
});

test('lost abort acknowledgement still confirms actual settlement within the cleanup budget', {timeout:2000},async() => {
  const f=fixture(), ac=new AbortController();
  f.hook=({action,run}) => {const state=run();return action==='abort'?never():state;};
  const failure=assert.rejects(f.run(ac.signal),e => e.code==='adapter_request_cancelled' && e.details.terminationConfirmed===true);
  await until(() => f.counts.posts===1);ac.abort();await failure;
  assert.equal(f.counts.abortEvents,1);assert.equal(f.counts.posts,1);assert.equal(f.chrome.pendingGeneration,null);
});

test('lost cleanup read reply leaves time for a fresh metadata confirmation', {timeout:2000},async() => {
  const f=fixture(), ac=new AbortController();let lost=false;
  f.hook=({action,run}) => {
    const state=run();
    if(f.counts.abortCommands && ['peek','read'].includes(action) && !lost){lost=true;return never();}
    return state;
  };
  const failure=assert.rejects(f.run(ac.signal),e => e.code==='adapter_request_cancelled' && e.details.terminationConfirmed===true);
  await until(() => f.counts.posts===1);ac.abort();await failure;
  assert.equal(lost,true);assert.equal(f.chrome.pendingGeneration,null);assert.equal(f.counts.abortEvents,1);
});

test('caller cancellation interrupts a hung state observation', {timeout:2000},async() => {
  const f=fixture({observationTimeoutMs:350}),ac=new AbortController();let reading=false;
  f.hook=({action,run}) => {
    if(!f.counts.abortCommands && ['peek','read'].includes(action)){reading=true;run();return never();}
    return run();
  };
  const run=f.run(ac.signal);
  const failure=assert.rejects(run,e => e.code==='adapter_request_cancelled' && e.details.terminationConfirmed===true);
  await until(() => reading);const started=performance.now();ac.abort();await failure;
  assert.ok(performance.now()-started<180,'Cancellation must not wait for the 350ms read timeout');
  assert.equal(f.counts.posts,1);assert.equal(f.counts.abortEvents,1);
});

test('permanent observer loss exhausts one recovery and retains isolation and owner rules', {timeout:2000},async() => {
  const f=fixture({ignoreAbort:true});let foregroundReads=0;
  f.hook=({action,run}) => {
    if(action==='abort'){run();return never();}
    if(['peek','read'].includes(action)){if(!f.counts.abortCommands)foregroundReads++;return never();}
    return run();
  };
  await assert.rejects(f.run(),e => e.details.reason==='observation_timeout' && !e.details.terminationConfirmed && e.details.observationRecoveryCount===1 && e.details.observationElapsedMs>=0 && e.details.observationTimerLagMs>=0 && e.details.cleanupElapsedMs>=0);
  assert.equal(foregroundReads,2);assert.equal(f.counts.posts,1);assert.ok(f.chrome.pendingGeneration);assert.equal(operationState(f.chrome),null);
  let background=0;await withBrowserOperation(f.chrome,'keep-warm',null,()=>{background++;},{background:true});assert.equal(background,0);
  await assert.rejects(f.client.postConversationInPage(f.page,{},{}),e => e.code==='browser_generation_pending');
  assert.equal(f.counts.posts,1);f.hook=null;f.finish();await pause(1);await f.client.assertNoPendingSubmission();
});

test('a late reply does not clear isolation after the request already failed', {timeout:2000},async() => {
  const f=fixture({ignoreAbort:true});let lateReply;
  f.hook=({action,run}) => {
    if(action==='abort'){run();return never();}
    if(['peek','read'].includes(action)){return new Promise(resolve=>{lateReply??=resolve;});}
    return run();
  };
  await assert.rejects(f.run());assert.ok(f.chrome.pendingGeneration);
  f.finish();await pause(1);lateReply({state:'settled',status:200,ok:true,text:'synthetic-complete-result'});await pause(1);
  assert.ok(f.chrome.pendingGeneration,'Late unawaited reply must not mutate ownership/fence');
  f.hook=null;await f.client.assertNoPendingSubmission();assert.equal(f.chrome.pendingGeneration,null);assert.equal(f.counts.posts,1);
});

test('confirmed settled fetch plus missing body is response loss, with no abort or replay', {timeout:2000},async() => {
  const f=fixture();
  f.hook=({action,run}) => {f.finish();const state=run();return action==='read' && state.state==='settled'?{state:'missing'}:state;};
  await assert.rejects(f.run(),e => e.code==='browser_response_unavailable' && e.details.terminationConfirmed===true && e.generationSubmitted===true);
  assert.equal(f.counts.abortCommands,0);assert.equal(f.counts.posts,1);assert.equal(f.chrome.pendingGeneration,null);
});

test('generation deadline is not extended by the read-only recovery allowance', {timeout:2000},async() => {
  const f=fixture({timeoutMs:12,observationTimeoutMs:100,cleanupMs:24});let foregroundReads=0;
  f.hook=({action,run}) => {
    if(['peek','read'].includes(action) && !f.counts.abortCommands){foregroundReads++;return never();}
    return run();
  };
  await assert.rejects(f.run(),e => e.details.reason==='generation_deadline' && e.details.terminationConfirmed===true);
  assert.equal(foregroundReads,1);assert.equal(f.counts.posts,1);assert.equal(f.counts.abortEvents,1);
});

test('start reply uncertainty is never covered by read-only recovery or replay', {timeout:2000},async() => {
  const f=fixture();const evaluate=f.page.evaluate;
  f.page.evaluate=async(fn,...args) => {const result=await evaluate(fn,...args);return fn.name==='startConversationTransaction'?never():result;};
  await assert.rejects(f.run(),e => e.details.observationAction==='start' && e.details.observationRecoveryCount===0 && e.details.terminationConfirmed===true);
  assert.equal(f.counts.posts,1);assert.equal(f.counts.starts,1);assert.equal(f.counts.abortEvents,1);
});

test('new recovery diagnostics remain bounded and redact arbitrary input',() => {
  const safe=safeTransportDetails({observationRecoveryCount:1,observationStage:'metadata',cleanupReadAttempts:3,observationElapsedMs:5001,observationTimerLagMs:1,cleanupElapsedMs:1000,secret:'SYNTHETIC_PRIVATE_VALUE'});
  assert.deepEqual(safe,{observationRecoveryCount:1,observationStage:'metadata',cleanupReadAttempts:3,observationElapsedMs:5001,observationTimerLagMs:1,cleanupElapsedMs:1000});
  assert.equal(JSON.stringify(safeTransportDetails({observationRecoveryCount:Infinity,observationStage:'SYNTHETIC_PRIVATE_VALUE',cleanupReadAttempts:-1})).includes('SYNTHETIC_PRIVATE_VALUE'),false);
});

test('metadata and response share a single read-only recovery allowance', {timeout:2000},async() => {
  const f=fixture();let metadataLost=false;
  f.hook=({action,run}) => {
    if(action==='peek' && !metadataLost){metadataLost=true;return never();}
    if(action==='peek')f.finish();
    if(action==='read')return never();
    return run();
  };
  await assert.rejects(f.run(),e => e.code==='browser_response_unavailable' && e.details.terminationConfirmed && e.details.observationRecoveryCount===1);
  assert.equal(f.counts.bodyReads,1);assert.equal(f.counts.abortCommands,0);assert.equal(f.counts.posts,1);
});

test('missing transaction metadata cannot prove termination or admit a new POST', {timeout:2000},async() => {
  const f=fixture();f.hook=({action,run}) => action==='consume'?run():{state:'missing'};
  await assert.rejects(f.run(),e => !e.details.terminationConfirmed && e.details.reason==='transaction_missing');
  assert.ok(f.chrome.pendingGeneration);
  await assert.rejects(f.client.postConversationInPage(f.page,{},{}),e => e.code==='browser_generation_pending');
  assert.equal(f.counts.posts,1);f.hook=null;f.finish();await pause(1);await f.client.assertNoPendingSubmission();
});

test('a delayed abort for the settled old ID cannot cancel a new transaction', {timeout:2000},async() => {
  const requests=[];
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:(_route,init) => {
    const request={aborted:0};requests.push(request);
    init.signal.addEventListener('abort',()=>{request.aborted++;},{once:true});
    return new Promise(resolve=>{request.finish=()=>resolve({status:200,ok:true,text:async()=>'synthetic-result'});});
  }});
  const evaluate=(fn,...args) => {context.args=args;return structuredClone(vm.runInContext(`(${fn.toString()})(...args)`,context));};
  const oldID='11111111-1111-4111-8111-111111111111',newID='22222222-2222-4222-8222-222222222222';
  assert.equal(evaluate(startConversationTransaction,'/synthetic',{}, {},oldID,1000).accepted,true);
  const lateAbort=()=>evaluate(observeConversationTransaction,oldID,'abort','caller_cancelled');
  requests[0].finish();await pause(1);assert.equal(evaluate(observeConversationTransaction,oldID,'peek').state,'settled');
  assert.equal(evaluate(startConversationTransaction,'/synthetic',{}, {},newID,1000).accepted,true);
  assert.equal(lateAbort().state,'missing');
  assert.equal(evaluate(observeConversationTransaction,newID,'peek').state,'pending');assert.equal(requests[1].aborted,0);
  requests[1].finish();await pause(1);assert.equal(requests.length,2);assert.equal(requests[0].aborted,0);
});
