// 对话 SSE 路由测试（P4）：登录 → POST /api/chat → 流式读 SSE 断言 text/done 事件；
// 未登录 401；GET /api/chat/history 返回对话记录。
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

let llmPort = 0;
let llmServer: Server;
const modelInputs: any[]=[];
const textStream = (text: string) => [
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
  ...[...text].map((ch) => `data: {"choices":[{"delta":{"content":"${ch}"},"index":0}]}`),
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
  'data: [DONE]',
];

describe('/api/chat SSE 路由', () => {
  let dir: string; let server: Server; let port: number; let cookie: string;

  before(async () => {
    llmServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        modelInputs.push(JSON.parse(body));
        res.setHeader('Content-Type', 'text/event-stream');
        for (const l of textStream('你好，我在。')) res.write(l + '\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => { llmServer.listen(0, () => { llmPort = (llmServer.address() as any).port; r(); }); });
  });
  after(() => { llmServer.close(); });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-chat-route-'));
    process.env._SS_DATA_DIR = dir;
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'ollama', base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: '', model: 'mock-qwen' },
    }));
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('未登录 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"你好"}',
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/chat 流式返回 text + done 事件', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"message":"你好"}',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = ''; const events: Array<{ event: string; data: any }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      let ev = '';
      for (const line of lines) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          const d = line.slice(5).trim();
          if (d === '[DONE]') continue;
          try { events.push({ event: ev, data: JSON.parse(d) }); } catch { /* 忽略非 JSON */ }
        }
      }
    }
    const texts = events.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');
    assert.equal(texts, '你好，我在。');
    assert.ok(events.some((e) => e.event === 'done'), '应有 done 事件');
  });

  it('空 message → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"message":"  "}',
    });
    assert.equal(res.status, 400);
  });

  it('同一对话入口可选择 Pi，停用后明确拒绝、不静默回退', async () => {
    const endpoint=`http://127.0.0.1:${port}/api/chat`;
    const list=await fetch(endpoint+'/engines',{headers:{cookie}});
    assert.equal(list.status,200);
    const config=await list.json() as any;
    assert.ok(config.engines.some((e:any)=>e.id==='pi'));
    assert.equal(config.default_engine,'classic');assert.equal(config.model,'mock-qwen');
    assert.deepEqual(Object.keys(config).sort(),['default_engine','engines','model','ok'],'不得暴露模型地址或凭据');
    const reply=await fetch(endpoint,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'你好',engine:'pi'})});
    assert.match(await reply.text(),/Pi/);
    const previous=process.env.SS_PI_CHAT_ENABLED;
    try {
      process.env.SS_PI_CHAT_ENABLED='0';
      const blocked=await fetch(endpoint,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'你好',engine:'pi'})});
      assert.equal(blocked.status,400);assert.match(await blocked.text(),/未启用/);
    } finally { if(previous===undefined)delete process.env.SS_PI_CHAT_ENABLED;else process.env.SS_PI_CHAT_ENABLED=previous; }
  });

  it('GET /api/chat/history 返回该用户对话记录', async () => {
    // 先发一条消息（记录落表）；POST 是 SSE 流，必须消费完响应体后端才会执行完
    const post = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"message":"你好"}',
    });
    const reader = post.body!.getReader();
    while (!(await reader.read()).done) { /* 消费完整流 */ }
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/history`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.list));
    assert.equal(data.list.length, 2, 'user + assistant 各一条');
    assert.equal(data.list[0].role, 'user');
  });

  // —— R967-D01（BASE967-30）：卡片绑定随历史回传 ——
  // 测试通过 = 什么成立：assistant 消息的 cards（提案 id/工具身份）经 /api/chat/history 原样回传，恢复渲染有据可依。
  it('GET /api/chat/history 携带卡片绑定：测试通过 = cards 提案/工具身份随历史回传', async () => {
    const post = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"message":"你好"}',
    });
    const reader = post.body!.getReader();
    while (!(await reader.read()).done) { /* 消费完整流 */ }
    const { localStore } = await import('../../src/core/store.ts');
    await localStore.insert('execution', 'chat_messages', {
      conversation_id: 'admin', role: 'assistant', content: '本轮已生成候选', reasoning: '',
      created_at: new Date().toISOString(),
      cards: { proposals: [{ id: 'p-h1', capability: 'files.sheet_cells_write', entity_type: 'file', entity_id: 'f1' }], tools: [{ name: 'platform_files_sheet_cells_write', ok: true }] },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/history`, { headers: { cookie } });
    const data = await res.json();
    // 存进去→读回来一致（写方是 runAgentLoop 自己）：它落库的行也带卡片绑定并原样回传
    const writerRow = (data.list || []).find((m: any) => m.cards?.status?.kind === 'history_status');
    assert.ok(writerRow, 'runAgentLoop 自己写的 assistant 行应带 cards 并经历史回传');
    assert.equal(writerRow.cards.status.kind, 'history_status');
    const row = (data.list || []).find((m: any) => m.cards?.proposals?.length);
    assert.ok(row, '历史应带 cards 的消息');
    assert.equal(row.cards.proposals[0].id, 'p-h1');
    assert.equal(row.cards.tools[0].ok, true);
    assert.equal(row.cards.tools[0].name, undefined, '历史工具未绑定可授权目标时不重放旧名称/内容');
  });
  it('UI097 HTTP + SQLite: identical short cid isolates identities for history, resume and delete',async()=>{
    const req=async(auth:string,path:string,method='GET',body?:any)=>{
      const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{cookie:auth,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200);return r;
    };
    await req(cookie,'/api/users','POST',{username:'member',password:'synthetic-password',role:'staff'});
    const other=(await req('','/api/login','POST',{username:'member',password:'synthetic-password'})).headers.get('set-cookie')!;assert.ok(other);
    const chat=async(auth:string,cid:string,message:string)=>{const r=await req(auth,'/api/chat','POST',{conversation_id:cid,message});assert.match(await r.text(),/event: done/);return JSON.stringify(modelInputs.at(-1));};
    await chat(cookie,'shared','ADMIN_PRIVATE_097');
    assert.doesNotMatch(await chat(other,'shared','MEMBER_PRIVATE_097'),/ADMIN_PRIVATE_097/);
    const resumed=await chat(cookie,'admin:shared','ADMIN_RESUME_097');assert.match(resumed,/ADMIN_PRIVATE_097/);assert.doesNotMatch(resumed,/MEMBER_PRIVATE_097/);
    assert.doesNotMatch(await chat(other,'admin:shared','FOREIGN_CID_097'),/ADMIN_PRIVATE_097|ADMIN_RESUME_097/);
    const history=async(auth:string)=>(await(await req(auth,'/api/chat/history')).json()).list;
    const a=await history(cookie),b=await history(other);assert.ok(a.length&&b.length);
    assert.ok(a.every((r:any)=>r.conversation_id==='admin:shared'));assert.ok(b.every((r:any)=>r.conversation_id.startsWith('member:')));assert.doesNotMatch(JSON.stringify(b),/ADMIN_PRIVATE_097|ADMIN_RESUME_097/);
    const {SqliteStore}=await import('../../src/core/storage/sqlite.ts');const disk=new SqliteStore(join(dir,'state.sqlite'));
    try{
      const rows=await disk.query('execution','chat_messages');
      for(const [cid,content] of [['admin:shared','ADMIN_PRIVATE_097'],['member:shared','MEMBER_PRIVATE_097'],['member:admin:shared','FOREIGN_CID_097']])assert.ok(rows.some(r=>r.conversation_id===cid&&r.content===content));
      await req(other,'/api/chat/conversation/'+encodeURIComponent('admin:shared'),'DELETE');assert.deepEqual(await history(cookie),a);assert.ok((await history(other)).some((r:any)=>r.content==='MEMBER_PRIVATE_097'));
      await req(other,'/api/chat/conversation/shared','DELETE');assert.equal((await history(other)).length,0);assert.deepEqual(await history(cookie),a);
      assert.equal((await disk.query('execution','chat_messages')).filter(r=>String(r.conversation_id).startsWith('member:')).length,0);
    }finally{await disk.close();}
  });

});
