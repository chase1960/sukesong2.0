/** Controlled model SSE only; actual loop, runtime store, bridge and authenticated Frappe. */
import assert from 'node:assert/strict';
import {createPlatformChatBridge} from '../../src/adapters/web/platform.ts';
import {runAgentLoop} from '../../src/core/chat.ts';
import {getRuntimeStore} from '../../src/core/store.ts';
import {loadConfig} from '../../src/core/config.ts';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const cfg=JSON.parse(raw),base='http://127.0.0.1:3000',realFetch=globalThis.fetch;
const login=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:cfg.user,password:cfg.password})});assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const identity=await(await fetch(base+'/api/platform/session',{headers:{cookie}})).json();assert.ok(identity.collaboration_key);
const bridge=await createPlatformChatBridge({headers:{cookie}} as any);
const allowed=new Set(['files.create','files.sheet_column_append','files.sheet_row_append','files.sheet_range_read','files.sheet_cells_write']);
assert.ok(cfg.steps.every((s:any)=>allowed.has(s.action_id)));
const defs=bridge.toolDefs.filter(d=>['platform_action_schema','platform_action_call'].includes(d.name));assert.equal(defs.length,2);
const deltas:any[]=[];
for(const step of cfg.steps){
 deltas.push({tool_calls:[{index:0,id:'schema-'+deltas.length,function:{name:'platform_action_schema',arguments:JSON.stringify({action_id:step.action_id})}}]});
 deltas.push({tool_calls:[{index:0,id:'call-'+deltas.length,function:{name:'platform_action_call',arguments:JSON.stringify(step)}}]});
}
deltas.push({content:'请核对工具回执中的建议；尚未确认的内容仍待审核。'});
let cursor=0;const events:any[]=[];
globalThis.fetch=(async(url:any,init:any)=>{
 if(String(url).startsWith('http://controlled-model.invalid/')){
  const delta=deltas[cursor++];assert.ok(delta,'controlled model sequence exhausted');
  return new Response(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 }
 return realFetch(url,init);
}) as typeof fetch;
try{
 const store=getRuntimeStore(),config=loadConfig();config.llm={provider:'ollama',model:'controlled-range-structure',base_url:'http://controlled-model.invalid/v1',api_key:''};
 const result=await runAgentLoop(store,{store,config,actor:{id:identity.collaboration_key,role:'staff',kind:'human',channel:'test'},log:()=>{}} as any,{
  conversationId:identity.collaboration_key+':'+cfg.conversation,auditActorKey:identity.collaboration_key,userText:cfg.prompt,
  toolDefs:defs,toolExecutor:async(def,call,hooks,audit)=>{
   const p=JSON.parse(call.function.arguments);assert.ok(allowed.has(p.action_id));
   const receipt=await bridge.toolExecutor(def,call,hooks,audit);events.push({event:'actual-dispatch',name:def.name,args:p,receipt:JSON.parse(String(receipt.content))});return receipt;
  },signal:AbortSignal.timeout(90000),hooks:{onConfirm:e=>events.push({event:'confirm',data:e}),onStatus:e=>events.push({event:'status',data:e})},
 });console.log(JSON.stringify({reply:result.reply,events,conversation:identity.collaboration_key+':'+cfg.conversation,model:'controlled SSE, not real model'}));
}finally{globalThis.fetch=realFetch;await bridge.close()}
