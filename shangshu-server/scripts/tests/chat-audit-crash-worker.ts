/** Isolated process only: actual SQLite journal + actual core HTTP proposal/trace. */
import {SqliteStore} from '../../src/core/storage/sqlite.ts';
import {appendChatAuditEvent,snapshotChatContext,readChatAuditTrace} from '../../src/core/chat-audit-context.ts';
import assert from 'node:assert/strict';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const cfg=JSON.parse(raw);assert.equal(cfg.base,'http://127.0.0.1:3851');
const login=await fetch(cfg.base+'/api/method/login',{method:'POST',headers:{host:'shangshu.localhost','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({usr:cfg.user,pwd:cfg.password})});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
let csrf='';
async function api(method:string,args:Record<string,unknown>,post=false){
 const params=new URLSearchParams(Object.entries(args).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]));
 const response=await fetch(cfg.base+'/api/method/shangshu_core.public_api.http.'+method+(post?'':'?'+params),{method:post?'POST':'GET',headers:{host:'shangshu.localhost',cookie,...(post?{'content-type':'application/x-www-form-urlencoded','x-frappe-csrf-token':csrf}:{})},body:post?params:undefined});
 assert.equal(response.status,200,method+' HTTP '+response.status);
 return (await response.json()).message;
}
csrf=(await api('csrf',{})).csrf_token;
const store=new SqliteStore(cfg.store);
const identity=await api('audit_actor',{user:cfg.user});assert.ok(identity.collaboration_key);
if(cfg.mode==='propose'){
 await appendChatAuditEvent(store,identity.collaboration_key,identity.collaboration_key+':crash',cfg.request,{kind:'tool_request',request_id:cfg.request,action_id:'mail.save_draft',tool:'platform_action_call',arguments:JSON.stringify({action_id:'mail.save_draft',payload:{subject:'crash synthetic',body:'not yet written',to:[],cc:[]}}),context:snapshotChatContext([],'合成崩溃恢复请求')});
 const proposal=await api('action_propose',{action_id:'mail.save_draft',payload:{subject:'crash synthetic',body:'not yet written',to:[],cc:[]},idempotency_key:cfg.request,source:'ai-chat'},true);
 assert.equal((await store.query('execution','chat_audit_sources')).length,0);
 console.log(JSON.stringify({ready:true,proposal:proposal.id,request:cfg.request}));
 // Parent kills exactly this PID after both stores commit; never kill the live BFF.
 await new Promise(()=>{setInterval(()=>{},1000);});
}else{
 assert.equal((await store.query('execution','chat_audit_sources')).length,0);
 const deps={store,authorize:async(user:string)=>api('audit_actor',{user}),trace:async(user:string,lookup:any)=>api('audit_trace',{user,...lookup}),proposal:async(user:string,proposal_id:string)=>api('audit_proposal',{user,proposal_id})};
 const one:any=await readChatAuditTrace(cfg.user,{request_id:cfg.request},deps);
 assert.equal(one.status,'linked');assert.equal(one.context.trigger,'合成崩溃恢复请求');assert.equal(one.proposal_id,cfg.proposal);
 const two:any=await readChatAuditTrace(cfg.user,{request_id:cfg.request},deps);assert.equal(two.status,'linked');
 assert.equal((await store.query('execution','chat_audit_sources')).length,1);
 assert.equal((await store.query('execution','chat_audit_events')).length,1);
 await store.close();console.log(JSON.stringify({recovered:true,sources:1,requests:1,proposal:cfg.proposal}));
}
