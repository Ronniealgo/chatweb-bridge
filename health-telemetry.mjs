// Opt-in passive health diagnostics. No timer, auth/browser access, log or file I/O.
import {performance} from 'node:perf_hooks';
const attached=new WeakSet();
export function attachHealthTelemetry(server,{mono=()=>performance.now(),wall=()=>new Date().toISOString(),cpu=()=>process.cpuUsage(),memory=()=>({rss:process.memoryUsage.rss()}),elu=()=>performance.eventLoopUtilization(),pid=process.pid}={}){
 if(attached.has(server))throw Error('health_telemetry_already_attached');attached.add(server);
 const connections=new WeakMap();let lastFinish=null,lastELU=null,failures=0;
 const accepted=socket=>{try{connections.set(socket,{mono:mono(),utc:wall()})}catch{failures++}};
 const request=(req,res)=>{
  if(req.method!=='GET'||req.url!=='/health')return;
  try{
   const start=mono(),dispatch=wall(),entryCPU=cpu(),mem=memory(),util=elu(),conn=connections.get(req.socket);
   const values={'x-dsh-health-pid':pid,'x-dsh-health-dispatch-at':dispatch,'x-dsh-health-rss-bytes':mem.rss,'x-dsh-health-diagnostic-failures':failures};
   if(conn){values['x-dsh-health-accept-at']=conn.utc;values['x-dsh-health-parse-wait-ms']=Math.max(0,start-conn.mono).toFixed(3)}
   if(lastFinish){values['x-dsh-health-previous-handler-ms']=lastFinish.elapsedMs.toFixed(3);values['x-dsh-health-previous-cpu-us']=lastFinish.cpuUs;values['x-dsh-health-previous-finish-at']=lastFinish.utc}
   if(lastELU){values['x-dsh-health-interval-loop-active-ms']=Math.max(0,util.active-lastELU.active).toFixed(3);values['x-dsh-health-interval-loop-idle-ms']=Math.max(0,util.idle-lastELU.idle).toFixed(3)}
   lastELU=util;
   const publish=()=>{if(req[Symbol.for('dsh.http.authenticated')]===true)for(const [name,value] of Object.entries(values))res.setHeader(name,String(value));};
   if(typeof res.writeHead==='function'){const original=res.writeHead;res.writeHead=function(...args){publish();res.writeHead=original;return original.apply(this,args)}}else publish();
   res.once('finish',()=>{try{const endCPU=cpu();lastFinish={elapsedMs:Math.max(0,mono()-start),cpuUs:Math.max(0,endCPU.user+endCPU.system-entryCPU.user-entryCPU.system),utc:wall()}}catch{failures++}});
  }catch{failures++} // Telemetry failure must never prevent the original health response.
 };
 server.on('connection',accepted);server.prependListener('request',request);
 return {detach(){server.off('connection',accepted);server.off('request',request);attached.delete(server)},get diagnosticFailures(){return failures},scope:'metadata only; health GET only; no periodic work'};
}
