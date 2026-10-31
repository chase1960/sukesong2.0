/** Production loop + SQLite; controlled model/tool boundaries, no external model. */
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../../src/core/storage/sqlite.ts';
import {runAgentLoop,type ChatToolDef} from '../../src/core/chat.ts';
it('UI089 three turns preserve both pending targets and context after SQLite reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ss-pending-turns-')),path=join(dir,'state.sqlite'),original=globalThis.fetch;
 let store=new SqliteStore(path);const pending=new Map<string,any>(),inputs:any[]=[],events:any[]=[];
 const defs:ChatToolDef[]=[{name:'propose_sheet',kind:'confirm',parameters:{},description:'表格候选'},{name:'propose_mail',kind:'confirm',parameters:{},description:'邮件候选'},{name:'read_pending',kind:'query',parameters:{},description:'读取待审'}];
 const prompts=['表 TABLE-A 固定行 ROW-A 金额由100改200，先待审。','先处理邮件 MAIL-B 正文客户核对稿，表提案继续待审。','回到 TABLE-A，不确认不拒绝，核对两域未完任务。'];
 const replies=['表提案 P-S 待审，TABLE-A/ROW-A/金额=200。','邮件提案 P-M 待审，MAIL-B/正文=客户核对稿；表 P-S 仍待审。','表 P-S 和邮件 P-M 均仍待审，目标保持 TABLE-A/ROW-A 和 MAIL-B。'];
 const invoke=async(turn:number)=>{
  let n=0;globalThis.fetch=(async(_u:any,o:any)=>{inputs.push({turn,messages:JSON.parse(o.body).messages});const delta=n++===0?{tool_calls:[{index:0,id:'tool-'+turn,function:{name:defs[turn].name,arguments:'{}'}}]}:{content:replies[turn]};return new Response(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})}) as typeof fetch;
  await runAgentLoop(store,{store,config:{llm:{provider:'ollama',model:'controlled',base_url:'http://127.0.0.1:19999/v1',api_key:''}},actor:{id:'actor-a',role:'staff',kind:'human',channel:'test'},log:()=>{}} as any,{
   conversationId:'actor-a:shared-task',auditActorKey:'actor-a',userText:prompts[turn],uiContext:{module:turn===1?'mail':'excel',entity_id:turn===1?'MAIL-B':'TABLE-A'},toolDefs:defs,
   toolExecutor:async(def,call,hooks)=>{
    if(def.name==='read_pending')return {role:'tool',tool_call_id:call.id,content:JSON.stringify([...pending.values()])};
    const p=def.name==='propose_sheet'?{id:'P-S',capability:'files.sheet_cells_write',entity_type:'files',entity_id:'TABLE-A',payload:{table:'TABLE-A',cells:[{row_id:'ROW-A',header:'金额',value:200}]} }:{id:'P-M',capability:'mail.save_draft',entity_type:'mail',entity_id:'MAIL-B',payload:{mail:'MAIL-B',body:'客户核对稿'}};
    assert.ok(!pending.has(p.id));pending.set(p.id,{...p,status:'Proposed'});await hooks.onConfirm?.(p);
    return {role:'tool',tool_call_id:call.id,content:JSON.stringify({confirmation_id:p.id})};
   },hooks:{onConfirm:p=>{events.push(p)}}});
 };
 try{
  await invoke(0);const sheet=JSON.stringify(pending.get('P-S'));assert.equal(pending.size,1);
  await invoke(1);assert.equal(pending.size,2);assert.equal(JSON.stringify(pending.get('P-S')),sheet);
  const before=JSON.stringify([...pending.values()]);await store.close();store=new SqliteStore(path);
  await invoke(2);assert.equal(JSON.stringify([...pending.values()]),before);assert.equal(events.length,2);
  const second=JSON.stringify(inputs.find(v=>v.turn===1).messages),third=JSON.stringify(inputs.find(v=>v.turn===2).messages);
  assert.ok(second.includes(prompts[0])&&second.includes(replies[0]));
  for(const text of [prompts[0],prompts[1],replies[0],replies[1]])assert.ok(third.includes(text),text);
  const messages=await store.query('execution','chat_messages',{conversation_id:'actor-a:shared-task'});assert.equal(messages.length,6);
  const bound=messages.filter(r=>r.role==='assistant').flatMap(r=>r.cards?.proposals||[]);assert.deepEqual(bound.map(p=>p.id).sort(),['P-M','P-S']);
  assert.equal((await store.query('execution','chat_audit_sources')).length,2);
 }finally{globalThis.fetch=original;await store.close();rmSync(dir,{recursive:true,force:true});}
});
