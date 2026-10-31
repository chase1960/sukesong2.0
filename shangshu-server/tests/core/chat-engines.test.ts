import {it} from 'node:test';
import assert from 'node:assert/strict';
import {chatEngine,defaultChatEngine} from '../../src/core/chat-engines.ts';
it('默认编排保持classic；管理员显式配置Pi且可用才启用，停用可靠回退',()=>{
  const old=process.env.SS_CHAT_ENGINE,enabled=process.env.SS_PI_CHAT_ENABLED;
  try{
    delete process.env.SS_CHAT_ENGINE;process.env.SS_PI_CHAT_ENABLED='1';
    assert.equal(defaultChatEngine(),'classic');assert.equal(chatEngine(undefined),'classic');
    process.env.SS_CHAT_ENGINE='pi';assert.equal(defaultChatEngine(),'pi');
    process.env.SS_PI_CHAT_ENABLED='0';assert.equal(defaultChatEngine(),'classic');assert.throws(()=>chatEngine('pi'));
  }finally{if(old===undefined)delete process.env.SS_CHAT_ENGINE;else process.env.SS_CHAT_ENGINE=old;if(enabled===undefined)delete process.env.SS_PI_CHAT_ENABLED;else process.env.SS_PI_CHAT_ENABLED=enabled;}
});

// 2026-10-22（用户要求「harness 可选」）：选了哪个引擎**要能从记录里查出来**
// —— 否则「谁在什么时候用什么引擎问的」查不到。
//
// ⚠️ 判据要**跑真实对话**（自己插一条带 engine 的记录 = 没验到真东西）。
it('真跑一轮对话，落库的记录里带着这轮用的引擎',async()=>{
  const {mkdtempSync,writeFileSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createServer}=await import('node:http');
  const {runAgentLoop}=await import('../../src/core/chat.ts');
  const {buildContext}=await import('../../src/core/context.ts');
  const {localStore}=await import('../../src/core/store.ts');
  const old=process.env._SS_DATA_DIR;
  const server=createServer((req,res)=>{
    let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{
      res.setHeader('Content-Type','text/event-stream');
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'你好'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve=>{server.listen(0,'127.0.0.1',()=>resolve());});
  const port=(server.address() as any).port;
  process.env._SS_DATA_DIR=mkdtempSync(join(tmpdir(),'ss-engine-log-'));
  writeFileSync(join(process.env._SS_DATA_DIR,'runtime_config.json'),JSON.stringify({llm:{provider:'deepseek',base_url:`http://127.0.0.1:${port}/v1`,api_key:'',model:'test'}}));
  try{
    await runAgentLoop(localStore,buildContext(()=>{}),{conversationId:'alice',userText:'你好',engine:'classic'} as any);
    const rows=await localStore.query('execution','chat_messages');
    assert.ok(rows.length>=2,'对话消息没落库');
    for(const raw of rows){
      const body=typeof raw==='string'?JSON.parse(raw):raw;
      assert.equal(body.engine,'classic','消息里没记下用了哪个引擎：'+JSON.stringify(body).slice(0,200));
    }
  }finally{
    server.close();
    if(old===undefined)delete process.env._SS_DATA_DIR;else process.env._SS_DATA_DIR=old;
  }
});
