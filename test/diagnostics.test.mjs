import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRequest, parseModelReply } from '../protocol.mjs';
import { protocolFailureSample, saveFailureSample } from '../diagnostics.mjs';
const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}];
const make=()=>prepareRequest({model:'test-model',tools,messages:[{role:'user',content:'harmless test'}]});
test('protocol samples preserve structure but exclude private output, keys, and arguments',()=>{
 const {context}=make();const secret='PRIVATE_TOKEN_AND_DRAFT_632581';
 for(const text of [secret,'```json\n'+JSON.stringify({content:secret})+'\n```',JSON.stringify({[secret]:secret}),`<${context.nonce}>`+JSON.stringify({tool_calls:[{name:'read_file',arguments:{path:secret}}]})+`</${context.nonce}>`]){
  const sample=protocolFailureSample(text,context);assert.equal(JSON.stringify(sample).includes(secret),false);assert.equal(sample.characters,text.length);assert.equal(sample.sha256.length,64);
 }
});
test('wrong nonce diagnosis never makes a rejected reply executable',()=>{
 const {context}=make();const text='<dsh_reply_old>'+JSON.stringify({tool_calls:[{name:'read_file',arguments:{path:'fixture.txt'}}]})+'</dsh_reply_old>';
 const sample=protocolFailureSample(text,context);assert.equal(sample.tags.length,2);assert.ok(sample.tags.every(t=>!t.expectedNonce));
 assert.throws(()=>parseModelReply(text,context),e=>e.code==='invalid_tool_protocol');
});
test('failure sample storage has a hard bound and cannot escape its scoped directory',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-protocol-samples-'));const sample={format:'plain-text',characters:4};
 for(let i=0;i<20;i++)assert.equal(saveFailureSample(dir,randomUUID(),sample),true);
 assert.equal(saveFailureSample(dir,randomUUID(),sample),false);assert.equal(saveFailureSample(dir,'../escape',sample),false);
 assert.equal(readdirSync(dir).length,20);assert.deepEqual(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8')),sample);
});
test('ten preserved tool-result rounds use a fresh nonce and a final-answer envelope',()=>{
 const history=[{role:'user',content:'Use ten local tool results, then summarize.'}];let previous;
 for(let round=0;round<10;round++){
  const {context,upstreamBody}=prepareRequest({model:'test-model',tools,messages:history});
  assert.notEqual(context.nonce,previous);assert.match(upstreamBody.messages[0].content,/FINAL answer/);
  if(previous)assert.throws(()=>parseModelReply(`<${previous}>{"content":"stale"}</${previous}>`,context));
  const parsed=parseModelReply(`<${context.nonce}>{"tool_calls":[{"name":"read_file","arguments":{"path":"fixture.txt"}}]}</${context.nonce}>`,context);
  history.push(parsed.message,{role:'tool',tool_call_id:parsed.message.tool_calls[0].id,content:'actual result '+round});previous=context.nonce;
 }
 const {context,upstreamBody}=prepareRequest({model:'test-model',tools,messages:history});
 assert.equal(JSON.parse(upstreamBody.messages[1].content).conversation.filter(m=>m.role==='tool').length,10);
 assert.equal(parseModelReply(`<${context.nonce}>{"content":"completed using ten results"}</${context.nonce}>`,context).finish_reason,'stop');
});
