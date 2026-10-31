import { testActor, testContext } from '../helpers/actor.ts';
// 小微阶段：通用对象 + object.query / object.propose + 对话表面收窄
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getObjectType, listObjectTypes, resolveObjectAction, registerPresetObjects } from '../../src/core/objects.ts';
import { registerObjectTools, runObjectQuery, proposeObjectWrite } from '../../src/capabilities/object-tools.ts';
import { getCapability } from '../../src/core/registry.ts';
import { buildContext } from '../../src/core/context.ts';
import { registerAllActionHandlers } from '../../src/capabilities/actions.ts';
import { listPendingConfirmations } from '../../src/core/confirm.ts';
import { activeChatTools, listChatTools, CHAT_TOOLS } from '../../src/core/chat.ts';
import { LEGACY_CHAT_TOOLS } from '../../src/core/chat-tools-legacy.ts';

registerObjectTools();
registerAllActionHandlers();
registerPresetObjects();

it('对象查询分页保留总数，后续记录可访问且非法偏移被拒绝',async()=>{
  const store:any=memStore(Array.from({length:55},(_,i)=>({id:'inv-'+i,total_amount:1,status:'待审'})));
  const page=await runObjectQuery(store,{object:'invoice',offset:50,limit:50},testActor);
  assert.equal(page.count,55);assert.equal(page.sample.length,5);assert.equal(page.sample[0].id,'inv-50');assert.equal(page.has_more,false);assert.equal(page.total_amount,55);
  await assert.rejects(runObjectQuery(store,{object:'invoice',offset:-1},testActor),/offset/);
});

function memStore(seedInvoices: any[]) {
  const events: any[] = [];
  return {
    async query(layer: string, table: string, filter?: any) {
      if (layer === 'business' && table === 'invoices') {
        if (filter?.id) return seedInvoices.filter((r) => r.id === filter.id);
        if (filter?.invoice_no) return seedInvoices.filter((r) => r.invoice_no === filter.invoice_no);
        return [...seedInvoices];
      }
      if (layer === 'execution' && table === 'events') {
        let rows = [...events];
        if (filter?.capability) rows = rows.filter((e) => e.capability === filter.capability);
        if (filter?.status) rows = rows.filter((e) => e.status === filter.status);
        if (filter?.id) rows = rows.filter((e) => e.id === filter.id);
        return rows;
      }
      return [];
    },
    async insert(layer: string, table: string, row: any) {
      if (layer === 'execution' && table === 'events') {
        const id = row.id || `e${events.length + 1}`;
        const rec = { ...row, id };
        events.push(rec);
        return id;
      }
      throw new Error(`unexpected insert ${layer}.${table}`);
    },
    async update() { throw new Error('no update'); },
  };
}

describe('小微对象元数据收口', () => {
  it('预置七对象（任务与帖子均纳入元数据）', () => {
    const ids = listObjectTypes().map((o) => o.id).sort();
    assert.deepEqual(ids, ['cash', 'invoice', 'ledger', 'payable', 'post', 'receivable', 'task']);
    assert.equal(resolveObjectAction(getObjectType('invoice')!, 'approve').id, 'invoice.approve');
    assert.equal(resolveObjectAction(getObjectType('ledger')!, 'ledger.post').id, 'ledger.post');
    // 任务帖子：全角色可读，发帖走 post.create（契约由 actions.ts 侧注册）
    const post = getObjectType('post')!;
    assert.equal(post.table, 'posts');
    assert.deepEqual(post.readRoles, ['admin', 'finance', 'manager', 'staff']);
    assert.equal(resolveObjectAction(post, 'post.create').id, 'post.create');
  });

  it('object.query 查发票', async () => {
    const store = memStore([
      { id: '1', invoice_no: 'A1', seller_name: '甲', status: '待审', total_amount: 100, received_at: '2026-08-01' },
      { id: '2', invoice_no: 'A2', seller_name: '乙', status: '已入库', total_amount: 200, received_at: '2026-08-10' },
    ]);
    const r = await runObjectQuery(store as any, { object: 'invoice', status: '待审' }, testActor);
    assert.equal(r.count, 1);
    assert.equal(r.total_amount, 100);
  });

  it('object.query 支持 filters 数组', async () => {
    const store = memStore([
      { id: '1', invoice_no: 'A1', seller_name: '甲', status: '待审', total_amount: 100, received_at: '2026-08-01' },
      { id: '2', invoice_no: 'A2', seller_name: '乙', status: '已入库', total_amount: 200, received_at: '2026-08-10' },
    ]);
    const r = await runObjectQuery(store as any, {
      object: 'invoice',
      filters: [{ field: 'invoice_no', op: 'eq', value: 'A2' }],
    }, testActor);
    assert.equal(r.count, 1);
    assert.equal(r.sample[0].invoice_no, 'A2');
  });

  it('task 的元数据行级范围限制员工只读本人任务', async () => {
    const taskRows = [
      {id:'t1',title:'我的任务',assignee_id:'alice',assignee:'Alice',status:'待办'},
      {id:'t2',title:'他人任务',assignee_id:'bob',assignee:'Bob',status:'进行中'},
    ];
    const store = { query: async (layer:string,table:string) => layer === 'process' && table === 'tasks' ? taskRows : [] } as any;
    const r = await runObjectQuery(store,{object:'task'},{id:'alice',role:'staff',kind:'human',channel:'test'});
    assert.equal(r.count,1);
    assert.equal(r.sample[0].id,'t1');
  });

  it('object.propose 挂确认卡', async () => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-sme-'));
    const { localStore: store } = await import('../../src/core/store.ts');
    await store.insert('business','invoices',{id:'inv1',invoice_no:'N1',seller_name:'测',status:'待审',total_amount:88,invoice_direction:'进项'});
    const proposed = await proposeObjectWrite(store as any, {
      object: 'invoice', action: 'invoice.approve', data: { invoice_id: 'inv1' },
      initiator: 'manual', actor: testActor,
    });
    assert.equal(proposed.ok, true);
    const pending = await listPendingConfirmations(store as any);
    assert.ok(pending.some((p: any) => p.id === proposed.id));
  });

  it('对话工具面不含进销存 legacy', () => {
    const active = new Set(activeChatTools().map((t) => t.name));
    assert.ok(active.has('object_query'));
    assert.ok(active.has('object_propose'));
    assert.ok(active.has('doc_extract'));
    assert.ok(active.has('flow_run'));
    assert.ok(!active.has('ledger_post'));
    assert.ok(!active.has('order_create'));
    assert.ok(!active.has('invoice_query'));
    assert.ok(!active.has('customer_create'));
    assert.ok(!active.has('project_query'));
    assert.ok(!active.has('profit_query'));
    assert.ok(active.has('cashflow_query'));
    assert.ok(active.has('post_create'));
    const listed = listChatTools();
    assert.ok(listed.some((t) => t.name === 'order_create' && t.surface === 'legacy'));
    assert.ok(active.has('metadata_list'));
    assert.ok(active.has('metadata_get'));
    assert.ok(active.has('metadata_propose'));
    assert.equal(activeChatTools().length, 14);
    assert.equal(CHAT_TOOLS.length, activeChatTools().length + LEGACY_CHAT_TOOLS.length);
  });

  it('object.list', async () => {
    const r = await getCapability('object.list').run({}, testContext(buildContext(() => {})));
    assert.equal(r.count, 7);
  });
});
