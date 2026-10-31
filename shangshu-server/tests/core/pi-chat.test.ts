import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop, type ChatToolDef } from '../../src/core/chat.ts';
import { buildContext } from '../../src/core/context.ts';
import { localStore } from '../../src/core/store.ts';

describe('Pi 原对话适配（真实 SDK / 受控 LLM）', () => {
  let server: Server, port: number, requests: any[];
  let respond: (body: any) => any;
  const read: ChatToolDef = { name:'read_record', kind:'query', description:'读当前授权记录', parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false} };
  const call = (name:string, args:unknown) => ({tool_calls:[{index:0,id:'call_1',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  before(async () => {
    server=createServer((req,res)=>{
      let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{
        const parsed=JSON.parse(body);requests.push(parsed);
        res.setHeader('Content-Type','text/event-stream');
        const delta=respond(parsed);
        res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve=>{server.listen(0,'127.0.0.1',()=>{port=(server.address() as any).port;resolve();});});
  });
  after(()=>server.close());
  beforeEach(()=>{
    process.env._SS_DATA_DIR=mkdtempSync(join(tmpdir(),'ss-pi-chat-'));
    writeFileSync(join(process.env._SS_DATA_DIR,'runtime_config.json'),JSON.stringify({llm:{provider:'deepseek',base_url:`http://127.0.0.1:${port}/v1`,api_key:'',model:'test'}}));
    requests=[];respond=()=>({content:'你好'});
  });
  const run=(extra:any={})=>runAgentLoop(localStore,buildContext(()=>{}),{conversationId:'alice',userText:'看一下当前记录',engine:'pi',toolDefs:[read],...extra} as any);
  it('Pi 生命周期、流式、历史都走原接口，原会话只记一次',async()=>{
    const phases:string[]=[],text:string[]=[];
    const result=await run({hooks:{onText:(t:string)=>text.push(t),onPhase:(p:any)=>phases.push(p.label)}});
    assert.equal(result.reply,'你好');assert.equal(text.join(''),'你好');
    assert.ok(phases.some(p=>p.includes('Pi')), '必须运行 Pi，不是静默沿用原循环');
    assert.equal((await localStore.query('execution','chat_messages')).length,2);
    assert.equal(requests[0].model,'test');
    assert.equal(requests[0].messages[0].role,'system');
    assert.match(requests[0].messages[0].content,/尚书/);
  });
  it('工具交由原执行器；确认回执不执行写入；推理内容回传',async()=>{
    respond=body=>body.messages.at(-1).role==='tool'?{content:'已提交待确认'}:{...call('propose_change',{id:'row-1'}),reasoning_content:'检查当前记录'};
    let count=0,confirms=0;
    const result=await run({toolDefs:[{...read,name:'propose_change',kind:'confirm'}],toolExecutor:async(def:any,tool:any,hooks:any)=>{
      count++;assert.equal(def.kind,'confirm');assert.equal(JSON.parse(tool.function.arguments).id,'row-1');
      hooks.onConfirm({id:'proposal-1',capability:'example.update',entity_type:'example.row',entity_id:'row-1',payload:{}});
      return {role:'tool',tool_call_id:tool.id,content:'{"ok":true,"confirmation_id":"proposal-1"}'};
    },hooks:{onConfirm:()=>confirms++}});
    assert.equal(count,1);assert.equal(confirms,1);assert.equal(result.reply,'已提交待确认');
    assert.equal(requests[1].messages.find((m:any)=>m.tool_calls)?.reasoning_content,'检查当前记录');
  });
  it('参数不符合目录 schema 时不触发执行器',async()=>{
    respond=body=>body.messages.at(-1).role==='tool'?{content:'参数无效'}:call('read_record',{id:22});
    let executed=false;
    await run({toolExecutor:async()=>{executed=true;throw Error('不应执行');}});
    assert.equal(executed,false);
  });
  it('未知工具不执行；重复调用有限终止',async()=>{
    respond=()=>call('shell_exec',{command:'never'});let executed=false;
    const result=await run({toolExecutor:async()=>{executed=true;throw Error('不应执行');}});
    assert.equal(executed,false);assert.ok(requests.length<=10);assert.match(result.reply,/上限|重复|未得到/);
  });
  it('无确认回执不认可模型假成功，不增加模型纠错提示',async()=>{
    respond=()=>({content:'已提交待确认'});
    const result=await run();
    assert.match(result.reply,/尚未生成有效确认提案/);assert.ok(requests.length<=2);
  });
  it('文字排版不能冒充可点击确认卡',async()=>{
    respond=()=>({content:'以下是修改确认卡，请确认后提交：原值150，新值180。'});
    assert.match((await run()).reply,/尚未生成有效确认提案/);
    assert.equal(requests.length,1);
  });
  it('修改提案也必须对应真实确认回执',async()=>{
    respond=()=>({content:'已生成修改提案，待确认：B2改为230。'});
    assert.match((await run()).reply,/尚未生成有效确认提案/);assert.equal(requests.length,1);
  });
  it('模型失败不可落成功记录',async()=>{
    respond=()=>({content:''});
    // 使用非法目的地址验证沿用原传输边界。
    const ctx=buildContext(()=>{});ctx.config.llm.base_url='http://169.254.169.254';
    await assert.rejects(runAgentLoop(localStore,ctx,{conversationId:'alice',userText:'你好',engine:'pi',toolDefs:[]} as any),/云元数据/);
    assert.equal((await localStore.query('execution','chat_messages')).length,0);
  });
  it('工具轮中止后不继续模型或后续工具',async()=>{
    const ac=new AbortController();respond=()=>call('read_record',{id:'row-1'});
    await run({signal:ac.signal,toolExecutor:async(_d:any,t:any)=>{ac.abort();return {role:'tool',tool_call_id:t.id,content:'{}'};}});
    assert.equal(requests.length,1);
    assert.equal((await localStore.query('execution','chat_messages')).filter((m:any)=>m.role==='assistant').length,0);
  });
});
