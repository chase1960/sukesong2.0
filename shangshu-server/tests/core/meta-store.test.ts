import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertValidMetadata, bootstrapMetadata, listMetadataOverview } from '../../src/core/meta-store.ts';
import { listObjectTypes } from '../../src/core/objects.ts';
import { listDocTypes } from '../../src/core/doctypes.ts';
import { listWorkflowTemplates } from '../../src/core/workflow-engine.ts';

describe('元数据持久化 meta_registry', () => {
  let dataDir: string;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ss-meta-'));
    process.env._SS_DATA_DIR = dataDir;
  });

  it('空库 bootstrap 写入种子并加载七对象+DocType+Flow', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const r = await bootstrapMetadata(localStore);
    assert.equal(r.seeded, true);
    assert.equal(r.counts.object, 7);
    assert.equal(r.counts.doctype, 1);
    assert.equal(r.counts.flow, 3);   // 收票 + 费用报销 + 任务验收
    assert.equal(listObjectTypes().length, 7);
    assert.equal(listDocTypes().length, 1);
    assert.equal(listWorkflowTemplates().length, 3);

    const rows = await localStore.query('cognition', 'meta_registry');
    assert.ok(rows.length >= 6);
  });

  it('重启后从 meta_registry 加载，不重复种子', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const r = await bootstrapMetadata(localStore);
    assert.equal(r.seeded, false);
    assert.equal(r.counts.object, 7);
    const overview = listMetadataOverview();
    assert.equal(overview.source, 'cognition.meta_registry');
    const intake = overview.flows.find((f) => f.id === 'flow.invoice-intake');
    assert.ok(intake);
    assert.equal(intake!.step_count, 4);
  });

  it('active 内容与不可变发布版本不一致时拒绝启动',async()=>{
    const {localStore}=await import('../../src/core/store.ts');
    const [row]=await localStore.query('cognition','meta_registry',{kind:'object',key:'invoice'});
    const changed={...JSON.parse(row.payload),name:'被外部修改'};
    await localStore.update('cognition','meta_registry',row.id,{payload:JSON.stringify(changed)});
    await assert.rejects(()=>bootstrapMetadata(localStore),/active 与发布版本不一致/);
  });

  it('对象行级归属字段必须引用已声明字段',()=>{
    assert.throws(()=>assertValidMetadata('object','bad',{id:'bad',name:'测试',description:'',layer:'custom',table:'bad',sampleFields:[],fields:[{id:'owner_id',label:'归属人',type:'text'}],actions:[],rowOwnerField:'missing'}),/rowOwnerField/);
  });
});
