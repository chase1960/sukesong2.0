// 链路图谱 API：registry 展开 + 运行态 stats 字段
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/api/flows 链路图谱', () => {
  let server: any; let port: number; let cookie: string;

  beforeEach(async () => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-flows-'));
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp({ocr:{} as any,mail:{} as any});
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin","password":"admin"}',
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  });
  afterEach(() => { server?.close(); });

  it('返回 flows/nodes/edges/stats 且含进项发票闭环', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/flows`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j.flows) && j.flows.length >= 3);
    assert.ok(j.flows.some((f: any) => f.id === 'invoice_inbound'));
    assert.ok(Array.isArray(j.nodes) && j.nodes.length > 5);
    assert.ok(Array.isArray(j.edges) && j.edges.length > 5);
    assert.ok(j.stats && typeof j.stats === 'object');
    assert.ok(j.pageLabels?.review === '发票审核');
    assert.ok(j.domains?.finance?.name === '财务');
  });

  it('通过发布 API 配置非发票对象、单据与流程，通用上传后确认写入',async()=>{
    const {registerObjectTools}=await import('../../src/capabilities/object-tools.ts');registerObjectTools();
    const {registerCapability}=await import('../../src/core/registry.ts');
    const {mapDocumentFields}=await import('../../src/core/doctypes.ts');
    registerCapability({id:'test.upload_extract',name:'测试文件解析',impl:'script',effect:'extract',roles:['admin'],run:async(input:any,ctx)=>{
      const file=await ctx.file.read(input.file_token);
      return {data:mapDocumentFields('delivery_cn',JSON.parse(file.bytes.toString()))};
    }});
    const post=async(path:string,body:unknown)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const publish=async(kind:string,key:string,payload:unknown)=>{
      const draft=await post('/api/metadata/drafts',{kind,key,payload});assert.equal(draft.status,200,await draft.clone().text());
      const result=await post(`/api/metadata/drafts/${(await draft.json()).id}/publish`,{expected_revision:0});assert.equal(result.status,200,await result.clone().text());
    };
    await publish('object','delivery',{id:'delivery',name:'送货单',description:'配置验收',layer:'custom',table:'deliveries',sampleFields:['id','number'],fields:[{id:'number',label:'单号',type:'text',required:true}],actions:[{id:'delivery.create',name:'建单',operation:'create',confirm:true,roles:['admin']}]});
    await publish('doctype','delivery_cn',{id:'delivery_cn',name:'送货单',description:'',objectId:'delivery',intakeFlowId:'flow.delivery',fieldMappings:[{source:'no',target:'number',required:true}]});
    await publish('flow','flow.delivery',{id:'flow.delivery',name:'收送货单',description:'',steps:[{id:'parse',name:'解析',capability:'test.upload_extract',inputMap:{file_token:'$input.file_token'}},{id:'propose',name:'提案',capability:'object.propose',inputMap:{object:'delivery',action:'delivery.create',data:'$steps.parse.data'}}],resultMap:{proposal_id:'$steps.propose.id'}});
    const uploaded=await fetch(`http://127.0.0.1:${port}/api/documents/upload?doctype=delivery_cn&name=delivery.json`,{method:'POST',headers:{cookie,'Content-Type':'application/octet-stream'},body:'{"no":"D-1"}'});
    assert.equal(uploaded.status,200,await uploaded.clone().text());
    const run=await uploaded.json();
    let query=await (await post('/api/objects/query',{object:'delivery'})).json();assert.equal(query.count,0);
    const confirm=await post(`/api/confirmations/${run.result.proposal_id}`,{decision:'confirmed'});assert.equal(confirm.status,200,await confirm.clone().text());
    query=await (await post('/api/objects/query',{object:'delivery'})).json();assert.equal(query.sample[0].number,'D-1');
  });
});
