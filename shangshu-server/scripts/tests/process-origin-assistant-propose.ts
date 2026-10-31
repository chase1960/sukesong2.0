/** Controlled tool request through actual bridge/journal; no model invocation. */
import assert from 'node:assert/strict';
import {createPlatformChatBridge} from '../../src/adapters/web/platform.ts';
import {getRuntimeStore} from '../../src/core/store.ts';
import {appendChatAuditEvent,snapshotChatContext} from '../../src/core/chat-audit-context.ts';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const cfg=JSON.parse(raw),base='http://127.0.0.1:3000';
const response=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:cfg.user,password:cfg.password})});assert.equal(response.status,200);
const cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const session=await (await fetch(base+'/api/platform/session',{headers:{cookie}})).json();
assert.ok(session.collaboration_key,'session collaboration key');
const bridge=await createPlatformChatBridge({headers:{cookie}} as any);
try{
 const args=JSON.stringify({action_id:'finance.expense.create_draft',payload:{invoice:cfg.invoice,subject:'UI038 controlled origin',purpose:'UI038 synthetic source linkage acceptance',department:'UI038 synthetic',cost_center:'UI038 synthetic'}});
 await appendChatAuditEvent(getRuntimeStore(),session.collaboration_key,session.collaboration_key+':ui038',cfg.request,{kind:'tool_request',request_id:cfg.request,tool:'platform_action_call',arguments:args,context:snapshotChatContext([],'UI038 controlled synthetic tool call, no model')});
 const def=bridge.toolDefs.find(d=>d.name==='platform_action_call');assert.ok(def);
 const result=await bridge.toolExecutor(def,{id:cfg.request,type:'function',function:{name:def.name,arguments:args}},{},{requestId:cfg.request} as any);
 const value=JSON.parse(String(result.content));assert.ok(value.confirmation_id,JSON.stringify(value));
 console.log(JSON.stringify({proposal:value.confirmation_id}));
}finally{await bridge.close();}
