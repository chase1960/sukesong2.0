// 架构验收：真实事务存储 + 真实财务动作 + 可配置的非发票对象/流程。
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/core/storage/sqlite.ts';
import { registerAllActionHandlers } from '../../src/capabilities/actions.ts';
import { requestConfirmation, resolveConfirmation } from '../../src/core/confirm.ts';
import { registerActionContract } from '../../src/core/action-contracts.ts';
import { registerObjectType, registerPresetObjects } from '../../src/core/objects.ts';
import { registerObjectTools, proposeObjectWrite, runObjectQuery } from '../../src/capabilities/object-tools.ts';
import { withActor, type ActorContext } from '../../src/core/actor.ts';
import { verifyChain } from '../../src/core/events.ts';
import { registerWorkflowTemplate, runWorkflow, resumeWorkflow, getWorkflowRun } from '../../src/core/workflow-engine.ts';
import { registerCapability, getCapability } from '../../src/core/registry.ts';
import { registerDocType, mapDocumentFields } from '../../src/core/doctypes.ts';
import { bootstrapMetadata, upsertMetaEntry, rollbackMetadata } from '../../src/core/meta-store.ts';
import type { Context, StateStore } from '../../src/core/types.ts';
const finance: ActorContext={id:'finance-test',role:'finance',kind:'human',channel:'test'};
const admin: ActorContext={...finance,id:'admin-test',role:'admin'};
const staff: ActorContext={...finance,id:'staff-test',role:'staff'};
let store:SqliteStore;
beforeEach(()=>{ store=new SqliteStore(join(mkdtempSync(join(tmpdir(),'ss-invariants-')),'state.sqlite')); registerAllActionHandlers();registerPresetObjects();registerObjectTools(); });
afterEach(async()=>{await store.close();});
function propose(capability:string,entity_type:string,entity_id:string,payload:Record<string,unknown>) {
  return withActor(admin,()=>requestConfirmation(store,{capability,entity_type,entity_id,payload,initiator:admin.id}));
}
const ctx=():Context=>({store,actor:admin,config:{} as any,file:{} as any,external:{} as any,log:()=>{}});

it('缺客户连续失败不得留下账本，应收或成功记录',async()=>{
  const id=await store.insert('business','invoices',{status:'已入库',invoice_direction:'出项',invoice_no:'BAD',total_amount:100});
  const p=await propose('invoice.book','invoice',id,{invoice_id:id});
  for(let i=0;i<2;i++) await assert.rejects(()=>resolveConfirmation(store,p,'confirmed',finance),/挂客户/);
  assert.equal((await store.query('business','ledger')).length,0);
  assert.equal((await store.query('business','receivables')).length,0);
  assert.equal((await store.query('execution','action_executions'))[0].attempt,2);
  assert.deepEqual(await verifyChain(store),[]);
});

it('最后的确认事件落库失败，整个入账回滚；重试只记一次',async()=>{
  const id=await store.insert('business','invoices',{status:'已入库',invoice_direction:'进项',invoice_no:'FAIL',seller_name:'供应商',total_amount:100});
  const p=await propose('invoice.book','invoice',id,{invoice_id:id});
  const inject=(tx:StateStore):StateStore=>new Proxy(tx,{get(target,key){
    if(key==='insert') return async(layer:string,table:string,row:any)=>{
      if(layer==='execution' && table==='events' && row.status==='confirmed') throw new Error('注入提交失败');
      return target.insert(layer,table,row);
    };
    const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
  }});
  const broken:StateStore=new Proxy(store,{get(target,key){
    if(key==='transaction')return (fn:any)=>target.transaction(tx=>fn(inject(tx)));
    const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
  }});
  await assert.rejects(()=>resolveConfirmation(broken,p,'confirmed',finance),/注入/);
  assert.equal((await store.query('business','ledger')).length,0);
  assert.equal((await store.query('business','payables')).length,0);
  assert.equal((await store.query('business','invoices'))[0].status,'已入库');
  await resolveConfirmation(store,p,'confirmed',finance);
  assert.equal((await store.query('business','ledger')).length,1);
  assert.equal((await store.query('business','payables')).length,1);
  assert.deepEqual(await verifyChain(store),[]);
});

it('并发回款30和50不丢金额，保留两条不可变流水',async()=>{
  const id=await store.insert('business','receivables',{amount:100,received:0,status:'未收'});
  const a=await propose('receivable.pay','receivable',id,{receivable_id:id,amount:30});
  const b=await propose('receivable.pay','receivable',id,{receivable_id:id,amount:50});
  await Promise.all([resolveConfirmation(store,a,'confirmed',finance),resolveConfirmation(store,b,'confirmed',finance)]);
  assert.equal((await store.query('business','receivables'))[0].received,80);
  const movements=await store.query('business','cash_movements');
  assert.equal(movements.reduce((s,r)=>s+r.amount_minor,0),8000);
  await assert.rejects(()=>store.update('business','cash_movements',movements[0].id,{amount_minor:1}),/append-only/);
});

it('并发超额回款只接受一笔；重复确认没有第二次副作用',async()=>{
  const id=await store.insert('business','receivables',{amount:100,received:0,status:'未收'});
  const ids=await Promise.all([60,60].map(amount=>propose('receivable.pay','receivable',id,{receivable_id:id,amount})));
  const outcomes=await Promise.allSettled(ids.map(p=>resolveConfirmation(store,p,'confirmed',finance)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await store.query('business','receivables'))[0].received,60);
  const succeeded=ids[outcomes.findIndex(r=>r.status==='fulfilled')];
  await assert.rejects(()=>resolveConfirmation(store,succeeded,'confirmed',finance),/已处理/);
  assert.equal((await store.query('business','cash_movements')).length,1);
});

it('存储强制 append-only，CAS 拒绝旧版本，事务回滚不泄露状态',async()=>{
  const id=await store.insert('custom','counter',{count:0});
  await assert.rejects(()=>store.transaction(async tx=>{await tx.update('custom','counter',id,{count:99});throw new Error('rollback');}),/rollback/);
  const [before]=await store.query('custom','counter');
  assert.equal(before.count,0);
  assert.equal(await store.compareAndSet('custom','counter',id,before._version,{count:1}),true);
  assert.equal(await store.compareAndSet('custom','counter',id,before._version,{count:2}),false);
  const ledger=await store.insert('business','ledger',{total_amount:1});
  await assert.rejects(()=>store.update('business','ledger',ledger,{total_amount:999}),/append-only/);
});

it('不支持事务的适配器必须拒绝业务提案，而非降级裸写',async()=>{
  const weak:StateStore={query:async()=>[],insert:async()=>{throw new Error('不应写入');},update:async()=>{}};
  await assert.rejects(()=>withActor(admin,()=>requestConfirmation(weak,{capability:'ledger.post',entity_type:'ledger',entity_id:'manual:x',payload:{total_amount:1},initiator:'test'})),/不支持原子业务提交/);
});

it('staff 不能经对象查询读账本；输入伪造 actor_role 不能提案',async()=>{
  await assert.rejects(()=>runObjectQuery(store,{object:'ledger'},staff),/无权限/);
  await assert.rejects(()=>getCapability('object.propose').run({object:'ledger',action:'ledger.post',total_amount:1,actor_role:'admin'}, {...ctx(),actor:staff}),/无权限/);
  const p=await propose('ledger.post','ledger','manual:x',{total_amount:1});
  await assert.rejects(()=>resolveConfirmation(store,p,'confirmed',staff),/无权限/);
  assert.equal((await store.query('business','ledger')).length,0);
});

it('确认时重新校验动作权限和 revision',async()=>{
  registerActionContract({id:'custom.secure',revision:1,roles:['admin','finance'],confirmation:'human',inputSchema:{type:'object'},execute:async()=>{}},{replace:true});
  const p=await propose('custom.secure','custom','x',{});
  registerActionContract({id:'custom.secure',revision:2,roles:['admin'],confirmation:'human',inputSchema:{type:'object'},execute:async()=>{throw new Error('不应执行');}},{replace:true});
  await assert.rejects(()=>resolveConfirmation(store,p,'confirmed',finance),/无权限/);
  await assert.rejects(()=>resolveConfirmation(store,p,'confirmed',admin),/版本已变更/);
});

it('新增对账单：对象+DocType+Flow 配置即可抽取、提案、确认入库',async()=>{
  registerObjectType({id:'statement',name:'对账单',description:'扩展验收',layer:'custom',table:'statements',readRoles:['admin','finance'],sampleFields:['id','number','total'],fields:[{id:'number',label:'单号',type:'text',required:true},{id:'total',label:'金额',type:'number',required:true}],actions:[{id:'statement.create',name:'创建',confirm:true,roles:['admin','finance'],operation:'create'}]});
  registerDocType({id:'statement_cn',name:'对账单',description:'',objectId:'statement',intakeFlowId:'flow.statement-intake',fieldMappings:[{source:'no',target:'number',required:true},{source:'amount',target:'total',required:true}]});
  registerCapability({id:'test.statement_extract',name:'测试抽取',impl:'script',effect:'extract',roles:['admin','finance'],run:async()=>({data:mapDocumentFields('statement_cn',{no:'S-1',amount:100})})});
  registerWorkflowTemplate({id:'flow.statement-intake',name:'对账单流程',description:'',revision:3,steps:[{id:'extract',name:'抽取',capability:'test.statement_extract'},{id:'propose',name:'提交提案',capability:'object.propose',inputMap:{object:'statement',action:'statement.create',data:'$steps.extract.data'}}],resultMap:{proposal_id:'$steps.propose.id'}});
  const run=await runWorkflow(store,'flow.statement-intake',{},ctx());
  assert.equal((await store.query('custom','statements')).length,0,'必须等待确认');
  assert.equal((await store.query('execution','flow_runs')).length,1,'一个逻辑 run 只有一条记录');
  assert.equal((await getWorkflowRun(store,run.id))?.revision,3);
  await resolveConfirmation(store,String(run.result?.proposal_id),'confirmed',finance);
  const [record]=await store.query('custom','statements');
  assert.equal(record.number,'S-1');assert.equal(record.total,100);
  assert.throws(()=>mapDocumentFields('statement_cn',{no:'bad'}),/必填/);
});

it('agent 选择必须落在白名单内，禁止执行白名单外能力',async()=>{
  let executed=0;
  registerCapability({id:'test.allowed',name:'允许',impl:'script',effect:'read',roles:['admin'],run:async()=>{executed++;return {};}});
  registerWorkflowTemplate({id:'flow.agent-test',name:'选择器测试',description:'',steps:[{id:'choose',name:'选择',capability:'test.allowed',strategy:'agent',candidateTools:['test.allowed']}]});
  await assert.rejects(()=>runWorkflow(store,'flow.agent-test',{}, {...ctx(),selectTool:async()=>({capability:'invoice.file',reason:'越界'})}),/白名单/);
  assert.equal(executed,0);
});

it('流程恢复使用原快照和已提交检查点，不重复已完成步骤',async()=>{
  let calls=0;let fail=true;
  registerCapability({id:'test.first',name:'第一步',impl:'script',effect:'read',roles:['admin'],run:async()=>({count:++calls})});
  registerCapability({id:'test.flaky',name:'失败一步',impl:'script',effect:'read',roles:['admin'],run:async()=>{if(fail)throw new Error('暂不可用');return {done:true};}});
  registerWorkflowTemplate({id:'flow.resume',name:'恢复',description:'',revision:1,steps:[{id:'first',name:'一',capability:'test.first'},{id:'second',name:'二',capability:'test.flaky'}]});
  await assert.rejects(()=>runWorkflow(store,'flow.resume',{},ctx()),/暂不可用/);
  const [run]=await store.query('execution','flow_runs');
  registerWorkflowTemplate({id:'flow.resume',name:'新版本',description:'',revision:2,steps:[{id:'third',name:'三',capability:'test.first'}]});
  fail=false;
  const recovered=await resumeWorkflow(store,run.id,ctx());
  assert.equal(recovered.revision,1);assert.equal(recovered.status,'completed');assert.equal(calls,1);
});

it('元数据发布拒绝旧版本；回滚产生新 revision，历史不能修改',async()=>{
  await bootstrapMetadata(store);
  const object={id:'note',name:'便笺',description:'v1',layer:'custom',table:'notes',sampleFields:['id','text'],fields:[{id:'text',label:'内容',type:'text'}],actions:[]};
  await upsertMetaEntry(store,'object','note',object,0);
  await upsertMetaEntry(store,'object','note',{...object,description:'v2'},1);
  await assert.rejects(()=>upsertMetaEntry(store,'object','note',{...object,description:'lost'},1),/版本冲突/);
  await rollbackMetadata(store,'object','note',1,2);
  const [active]=await store.query('cognition','meta_registry',{kind:'object',key:'note'});
  assert.equal(active.version,3);assert.equal(JSON.parse(active.payload).description,'v1');
  await assert.rejects(()=>store.update('cognition','meta_revisions','object:note:1',{payload:{}}),/append-only/);
});

it('发票确认卡绑定提案时版本，不能确认后来被改过的金额',async()=>{
  const id=await store.insert('business','invoices',{status:'已入库',invoice_direction:'进项',total_amount:10,seller_name:'甲'});
  const p=await propose('invoice.book','invoice',id,{invoice_id:id});
  await store.update('business','invoices',id,{total_amount:100});
  await assert.rejects(()=>resolveConfirmation(store,p,'confirmed',finance),/确认对象已变化/);
  assert.equal((await store.query('business','ledger')).length,0);
});

it('显式应收 ID 优先于客户名，不会回款到同客户的另一笔',async()=>{
  await store.insert('business','receivables',{id:'other',customer_name:'甲',amount:1000,received:0,status:'未收'});
  await store.insert('business','receivables',{id:'selected',customer_name:'甲',amount:100,received:0,status:'未收'});
  const p=await proposeObjectWrite(store,{object:'receivable',action:'pay',actor:finance,data:{receivable_id:'selected',customer_name:'甲',amount:30}});
  await resolveConfirmation(store,p.id,'confirmed',finance);
  assert.equal((await store.query('business','receivables',{id:'selected'}))[0].received,30);
  assert.equal((await store.query('business','receivables',{id:'other'}))[0].received,0);
});

it('配置更新动作自动获得 CAS 参数，移除动作后旧确认卡不能执行',async()=>{
  const object:any={id:'editable',name:'可编辑对象',description:'',layer:'custom',table:'editable',sampleFields:['id','text'],fields:[{id:'text',label:'内容',type:'text',required:true}],actions:[{id:'editable.update',name:'修改',operation:'update',confirm:true,roles:['admin']}]};
  await upsertMetaEntry(store,'object',object.id,object,0);
  const id=await store.insert('custom','editable',{text:'原文'});
  const p=await proposeObjectWrite(store,{object:object.id,action:'update',actor:admin,data:{id,expected_version:1,text:'新文'}});
  await resolveConfirmation(store,p.id,'confirmed',admin);
  const query=await runObjectQuery(store,{object:object.id},admin);
  assert.equal(query.sample[0]._version,2);
  const old=await proposeObjectWrite(store,{object:object.id,action:'update',actor:admin,data:{id,expected_version:2,text:'不能写入'}});
  await upsertMetaEntry(store,'object',object.id,{...object,actions:[]},1);
  await assert.rejects(()=>resolveConfirmation(store,old.id,'confirmed',admin),/未注册/);
});

const cli=fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs',import.meta.url));
it('离线迁移 dry-run 不写库，apply 保留 ID/嵌套值，拒绝覆盖及损坏快照',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ss-migrate-test-'));
  const source=join(dir,'snapshot.json');
  const rows={'custom.notes':[{id:'rec_source',text:'原始',nested:{list:[1,2]},empty:null}]};
  writeFileSync(source,JSON.stringify(rows));
  const script=fileURLToPath(new URL('../../scripts/migrate-store.ts',import.meta.url));
  const run=(...extra:string[])=>spawnSync(process.execPath,[cli,script,'--source',source,'--target-dir',join(dir,'target'),...extra],{encoding:'utf8'});
  assert.equal(run().status,0);
  assert.equal(existsSync(join(dir,'target','state.sqlite')),false);
  const applied=run('--apply');assert.equal(applied.status,0,applied.stderr);
  const migrated=new SqliteStore(join(dir,'target','state.sqlite'));
  const [{_version,...row}]=await migrated.query('custom','notes');
  assert.deepEqual(row,rows['custom.notes'][0]);await migrated.close();
  assert.notEqual(run('--apply').status,0);
  assert.equal(readFileSync(source,'utf8'),JSON.stringify(rows));
  writeFileSync(source,JSON.stringify({tables:rows,checksum:'wrong'}));
  assert.notEqual(run().status,0);
});

it('进程在事务中被终止，重开数据库无半笔记录；在线备份保留已提交数据',async()=>{
  await store.insert('custom','crash',{id:'committed',value:1});
  const dir=mkdtempSync(join(tmpdir(),'ss-crash-test-'));
  const script=join(dir,'crash.mts');
  const moduleUrl=new URL('../../src/core/storage/sqlite.ts',import.meta.url).href;
  const marker=join(dir,'entered');
  writeFileSync(script,`import {writeFileSync} from 'node:fs';import {SqliteStore} from ${JSON.stringify(moduleUrl)};\nconst s=new SqliteStore(${JSON.stringify(store.path)});\nawait s.transaction(async tx=>{await tx.insert('custom','crash',{id:'uncommitted',value:2});writeFileSync(${JSON.stringify(marker)},'yes');process.kill(process.pid,'SIGKILL');});`);
  const child=spawnSync(process.execPath,[cli,script],{encoding:'utf8'});
  assert.notEqual(child.status,0);
  assert.equal(existsSync(marker),true,child.stderr);
  assert.equal((await store.query('custom','crash')).length,1);
  const backup=join(dir,'backup.sqlite');await store.backup(backup);
  const restored=new SqliteStore(backup);
  assert.equal((await restored.query('custom','crash'))[0].id,'committed');await restored.close();
});

it('只读能力即使实现误写也不能修改业务状态',async()=>{
  registerCapability({id:'test.false_read',name:'误标只读',impl:'script',effect:'read',roles:['admin'],run:async(_input,ctx)=>ctx.store.insert('business','ledger',{total_amount:100})});
  await assert.rejects(()=>getCapability('test.false_read').run({},ctx()),/只读能力禁止/);
  assert.equal((await store.query('business','ledger')).length,0);
});

it('恢复时依赖对象定义改变则停止，不能悄悄换用新元数据',async()=>{
  registerObjectType({id:'dep',name:'依赖',description:'v1',layer:'custom',table:'deps',fields:[],sampleFields:['id'],actions:[]});
  let failed=true;
  registerCapability({id:'test.dependency',name:'依赖测试',impl:'script',effect:'read',roles:['admin'],run:async()=>{if(failed)throw new Error('中断');return {};}});
  registerWorkflowTemplate({id:'flow.dependency',name:'依赖',description:'',dependencies:{objects:['dep']},steps:[{id:'read',name:'查询',capability:'test.dependency'}]});
  await assert.rejects(()=>runWorkflow(store,'flow.dependency',{},ctx()),/中断/);
  const [run]=await store.query('execution','flow_runs');
  registerObjectType({id:'dep',name:'依赖',description:'v2',layer:'custom',table:'deps',fields:[],sampleFields:['id'],actions:[]});
  failed=false;
  await assert.rejects(()=>resumeWorkflow(store,run.id,ctx()),/元数据已变化/);
});

it('显式预置升级保留旧版本，旧映射不会被启动静默覆盖',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ss-upgrade-test-'));
  const db=new SqliteStore(join(dir,'state.sqlite'));
  const legacy={id:'flow.invoice-intake',name:'旧流程',description:'',steps:[{id:'file',name:'入库',capability:'invoice.file'}]};
  await db.insert('cognition','meta_registry',{id:'old-flow',kind:'flow',key:legacy.id,version:1,payload:JSON.stringify(legacy)});
  await assert.rejects(()=>bootstrapMetadata(db),/旧收票流程缺少显式映射/);
  const script=fileURLToPath(new URL('../../scripts/upgrade-metadata.ts',import.meta.url));
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,script,...args],{encoding:'utf8',env:{...process.env,_SS_DATA_DIR:dir}});
  assert.equal(run().status,0);assert.equal((await db.query('cognition','meta_registry')).length,1);
  const applied=run('--apply');assert.equal(applied.status,0,applied.stderr);
  const [active]=await db.query('cognition','meta_registry',{id:'old-flow'});assert.equal(active.version,2);
  assert.ok(JSON.parse(active.payload).steps.every((step:any)=>step.inputMap));
  const [old]=await db.query('cognition','meta_revisions',{id:'flow:flow.invoice-intake:1'});assert.deepEqual(old.payload,legacy);
  await db.close();
});

it('飞书导出只读且跨过旧 20 页上限，保留来源 ID 与原始字段',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ss-export-test-'));
  writeFileSync(join(dir,'runtime_config.json'),JSON.stringify({feishu:{app_id:'fixture',app_secret:'fixture',bitable_app_token:'fixture'}}));
  const hook=join(dir,'fetch.mjs');
  writeFileSync(hook,`globalThis.fetch=async (url,options)=>{
    let data;
    if(String(url).includes('/auth/')) return Response.json({code:0,tenant_access_token:'fixture',expire:7200});
    if(options.method!=='GET') throw new Error('导出不允许修改远端');
    const u=new URL(url);
    if(u.pathname.endsWith('/tables')) data={items:[{table_id:'tbl_fixture',name:'custom__exported'}],has_more:false};
    else if(u.pathname.endsWith('/records')) {
      const page=Number(u.searchParams.get('page_token')||0);
      data={items:[{record_id:'rec_'+page,fields:{id:'legacy_'+page,text:'第'+page+'页'}}],has_more:page<20,page_token:page<20?String(page+1):undefined};
    } else throw new Error('未知接口');
    return Response.json({code:0,data});
  };`);
  const script=fileURLToPath(new URL('../../scripts/export-bitable.ts',import.meta.url));
  const loader=fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url));
  const output=join(dir,'snapshot.json');
  const child=spawnSync(process.execPath,['--import',loader,'--import',hook,script,'--output',output],{encoding:'utf8',env:{...process.env,_SS_DATA_DIR:dir}});
  assert.equal(child.status,0,child.stderr);
  const snapshot=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(snapshot.tables['custom.exported'].length,21);
  assert.equal(snapshot.tables['custom.exported'][20].id,'rec_20');
  assert.equal(snapshot.tables['custom.exported'][20]._legacy_id,'legacy_20');
  assert.equal(snapshot.raw_tables.tbl_fixture.records.length,21);
});
