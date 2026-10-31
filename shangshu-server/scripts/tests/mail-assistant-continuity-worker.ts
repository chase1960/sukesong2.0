/** Actual production loop/bridge/store/model, narrowed test capability boundary. */
import assert from 'node:assert/strict';
import {createPlatformChatBridge} from '../../src/adapters/web/platform.ts';
import {runAgentLoop} from '../../src/core/chat.ts';
import {getRuntimeStore} from '../../src/core/store.ts';
import {loadConfig} from '../../src/core/config.ts';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const cfg=JSON.parse(raw),base='http://127.0.0.1:3000';
const response=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:cfg.user,password:cfg.password})});assert.equal(response.status,200);
const cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const identity=await (await fetch(base+'/api/platform/session',{headers:{cookie}})).json();assert.ok(identity.collaboration_key);
const bridge=await createPlatformChatBridge({headers:{cookie}} as any),allowed=new Set(['mail.save_draft','files.sheet_cells_write','platform.object.query']);
const defs=bridge.toolDefs.filter(d=>['platform_action_schema','platform_action_call','platform_resource_read'].includes(d.name)).map(d=>({...d,description:d.name==='platform_action_schema'?d.description.split('当前目录：')[0]+'本次合成验收许可目录：'+JSON.stringify([...allowed]):d.description}));
assert.equal(defs.length,3,'expected compact production catalog');
const events:any[]=[];let blocked=0;
const executor:typeof bridge.toolExecutor=async(def,call,hooks,audit)=>{
 const args=JSON.parse(call.function.arguments||'{}');
 if(['platform_action_call','platform_action_schema'].includes(def.name)&&args.action_id&&!allowed.has(args.action_id)){
  blocked++;const error='受控验收工具白名单拒绝；无发送或同步能力';await hooks.onTool?.({name:def.name,arg:call.function.arguments,result:error,error});return {role:'tool',tool_call_id:call.id,content:JSON.stringify({error})};
 }
 const result=await bridge.toolExecutor(def,call,hooks,audit);
 if(def.name==='platform_action_schema'&&!args.action_id){const data=JSON.parse(String(result.content));if(data.actions)data.actions=data.actions.filter((a:any)=>allowed.has(a.id));return {...result,content:JSON.stringify(data)}}
 return result;
};
try{
 const store=getRuntimeStore();const result=await runAgentLoop(store,{store,config:loadConfig(),actor:{id:identity.collaboration_key,role:'staff',kind:'human',channel:'test'},log:()=>{}} as any,{
  conversationId:identity.collaboration_key+':'+cfg.conversation,auditActorKey:identity.collaboration_key,userText:cfg.prompt,toolDefs:defs,toolExecutor:executor,
  signal:AbortSignal.timeout(180000),hooks:{onText:delta=>{events.push({event:'text',data:{delta}})},onTool:e=>{events.push({event:'tool',data:e})},onConfirm:e=>{events.push({event:'confirm',data:e})},onStatus:e=>{events.push({event:'status',data:e})}},
 });console.log(JSON.stringify({reply:result.reply,events,blocked,conversation:identity.collaboration_key+':'+cfg.conversation}));
}finally{await bridge.close()}
