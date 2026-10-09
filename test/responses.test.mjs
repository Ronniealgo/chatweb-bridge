import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(externalToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridge } from '../server.mjs';
import { responsesRequest } from '../responses.mjs';

const tool={type:'function',name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
const request=(extra={})=>({model:'chatgpt-web-gpt-5.6-sol',input:[{role:'user',content:[{type:'input_text',text:'Read the file.'}]}],tools:[tool],...extra});
const reply=(body,payload)=>{
  const nonce=body.messages[0].content.match(/<(dsh_reply_[a-f0-9]+)>JSON<\//)?.[1];
  return Response.json({model:'gpt-5-6-thinking',choices:[{finish_reason:'stop',message:{content:nonce?`<${nonce}>${JSON.stringify(payload)}</${nonce}>`:payload.content}}]});
};
async function fixture(t,fn){
  const server=createBridge({ ...bridgeAuth,upstream:'http://127.0.0.1:9',fetchImpl:async(url,init)=>{
    assert.equal(url,'http://127.0.0.1:9/v1/chat/completions');
    return fn(JSON.parse(init.body),init.signal);
  },logger:{info(){},error(){}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  return (body,signal)=>fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
}

test('Responses roundtrip carries real harness tool output and preserves call IDs',async t=>{
  let calls=0;
  const post=await fixture(t,body=>{
    assert.equal(body.model,'gpt-5-6-thinking');
    if(++calls===1)return reply(body,{tool_calls:[{name:'read_file',arguments:{path:'proof.txt'}}]});
    const history=JSON.parse(body.messages[1].content).conversation;
    assert.equal(history[1].tool_calls[0].id,history[2].tool_call_id);
    assert.equal(history[2].content,'nonce-only-known-after-tool-runs');
    return reply(body,{content:history[2].content});
  });
  const first=await post(request());assert.equal(first.status,200);
  const a=await first.json();assert.equal(a.object,'response');assert.equal(a.status,'completed');
  assert.equal(a.output[0].type,'function_call');assert.equal(a.output[0].name,'read_file');
  const b=await(await post(request({input:[...request().input,...a.output,{type:'function_call_output',call_id:a.output[0].call_id,output:'nonce-only-known-after-tool-runs'}]}))).json();
  assert.equal(b.output[0].content[0].text,'nonce-only-known-after-tool-runs');assert.equal(calls,2);
  assert.equal(b.metadata.usage_source,'local_character_estimate');
});

test('custom tool input and output survive roundtrip without being interpreted as JSON code',async t=>{
  let calls=0;const input='*** Begin Patch\n*** Add File: proof.txt\n+中文\n*** End Patch';
  const post=await fixture(t,body=>{
    if(++calls===1)return reply(body,{tool_calls:[{name:'apply_patch',arguments:{input}}]});
    const history=JSON.parse(body.messages[1].content).conversation;
    assert.equal(history[1].tool_calls[0].arguments.input,input);
    assert.equal(history[2].content,'created');return reply(body,{content:'done'});
  });
  const req=request({tools:[{type:'custom',name:'apply_patch',description:'Apply a patch',format:{type:'text'}}]});
  const a=await(await post(req)).json();assert.equal(a.output[0].type,'custom_tool_call');assert.equal(a.output[0].input,input);
  const b=await(await post({...req,input:[...req.input,...a.output,{type:'custom_tool_call_output',call_id:a.output[0].call_id,output:'created'}]})).json();
  assert.equal(b.output[0].content[0].text,'done');
});

test('namespace tools maintain original name and namespace across Responses output',async t=>{
  const post=await fixture(t,body=>{
    const tools=JSON.parse(body.messages[0].content.split('Available tools (JSON Schema): ')[1]);
    assert.equal(tools.length,2);assert.notEqual(tools[0].name,tools[1].name);
    return reply(body,{tool_calls:[{name:tools[1].name,arguments:{path:'b.txt'}}]});
  });
  const res=await(await post(request({tools:[{type:'namespace',name:'first',tools:[tool]},{type:'namespace',name:'second',tools:[tool]}]}))).json();
  assert.equal(res.output[0].name,'read_file');assert.equal(res.output[0].namespace,'second');
});

for(const mode of ['text','function','custom'])test(`Responses SSE ${mode} has coherent sequence, item IDs and completion`,async t=>{
  const post=await fixture(t,body=>reply(body,mode==='text'?{content:'Hello 中文'}:{tool_calls:[{name:mode==='custom'?'patch':'read_file',arguments:mode==='custom'?{input:'literal patch'}:{path:'a'}}]}));
  const response=await post(request({stream:true,tools:mode==='custom'?[{type:'custom',name:'patch'}]:[tool]}));
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n\n').map(x=>JSON.parse(x.split('\ndata: ')[1]));
  assert.equal(events[0].type,'response.created');assert.equal(events.at(-1).type,'response.completed');
  assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));
  const added=events.find(e=>e.type==='response.output_item.added');
  const done=events.find(e=>e.type==='response.output_item.done');
  assert.equal(added.item.id,done.item.id);assert.deepEqual(done.item,events.at(-1).response.output[0]);
  const delta=events.find(e=>e.type.endsWith('.delta'));assert.equal(delta.item_id,done.item.id);
  if(mode==='function')assert.equal(delta.delta,done.item.arguments);
  if(mode==='custom')assert.equal(delta.delta,done.item.input);
});

for(const [name,override] of [
  ['image',{input:[{role:'user',content:[{type:'input_image',image_url:'private'}]}]}],
  ['remote history',{previous_response_id:'resp_private'}],
  ['hosted tools',{tools:[{type:'computer_use_preview'}]}],
  ['opaque history',{input:[{type:'compaction',encrypted_content:'opaque'}]}],
  ['structured text',{text:{format:{type:'json_schema'}}}],
])test(`Responses rejects ${name} without an upstream call`,async t=>{
  let calls=0;const post=await fixture(t,()=>{calls++;throw Error('unreachable')});
  const r=await post(request(override));assert.equal(r.status,400);assert.equal(calls,0);
});

test('invalid tool schema arguments are rejected atomically before streaming output',async t=>{
  const post=await fixture(t,body=>reply(body,{tool_calls:[{name:'read_file',arguments:{path:3}}]}));
  const r=await post(request({stream:true}));assert.equal(r.status,422);assert.equal((await r.json()).error.code,'invalid_tool_protocol');
});

test('no-tools Responses preserves plain text and reasoning effort',async t=>{
  const post=await fixture(t,body=>{assert.equal(body.reasoning_effort,'high');return reply(body,{content:'plain'});});
  const r=await post(request({tools:[],input:'Hi',reasoning:{effort:'max'}}));
  assert.equal((await r.json()).output[0].content[0].text,'plain');
});

test('forced custom tool and historical reasoning summaries translate correctly',()=>{
  const t=responsesRequest(request({tools:[{type:'custom',name:'patch'}],tool_choice:{type:'custom',name:'patch'},input:[{type:'reasoning',summary:[{type:'summary_text',text:'Visible context'}],encrypted_content:'never-forward'},{role:'user',content:'Go'}]}));
  assert.equal(t.body.tool_choice.function.name,'patch');assert.equal(t.body.messages[0].content,'Visible context');
  assert.ok(!JSON.stringify(t.body).includes('never-forward'));
});

test('Codex hosted search declaration is explicitly excluded while local browser tools remain',()=>{
  const t=responsesRequest(request({tools:[{type:'web_search'},tool]}));
  assert.equal(t.body.tools.length,1);assert.equal(t.body.tools[0].function.name,'read_file');
  assert.match(t.body.messages[0].content,/Hosted web_search is unavailable/);
});

test('Responses cancellation aborts upstream and releases the shared lock',async t=>{
  let abortedResolve,enteredResolve;const aborted=new Promise(r=>abortedResolve=r),entered=new Promise(r=>enteredResolve=r);
  const post=await fixture(t,(_body,signal)=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>{abortedResolve();reject(signal.reason)});enteredResolve();
  }));
  const ac=new AbortController();const pending=post(request(),ac.signal).catch(()=>{});
  await entered;ac.abort();await pending;
  await Promise.race([aborted,new Promise((_,reject)=>{const id=setTimeout(()=>reject(Error('upstream was not cancelled')),1500);id.unref()})]);
});
