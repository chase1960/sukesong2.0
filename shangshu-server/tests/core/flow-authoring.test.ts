// 流程能发能跑最小闭环：空骨架发布 → 运行完成；任务验收审批；AI 元数据提案确认后进运行态。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withActor } from '../../src/core/actor.ts';
import { testActor } from '../helpers/actor.ts';
import { resolveConfirmation } from '../../src/core/confirm.ts';

const manager = { id: 'mgr1', role: 'manager' as const, kind: 'human' as const, channel: 'test' as const };

async function boot() {
  process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-flow-auth-'));
  const { registerObjectTools } = await import('../../src/capabilities/object-tools.ts');
  const { registerWorkflowTools } = await import('../../src/capabilities/workflow-tools.ts');
  const { registerMetadataTools } = await import('../../src/capabilities/metadata-tools.ts');
  registerObjectTools();
  registerWorkflowTools();
  registerMetadataTools();
  const { localStore } = await import('../../src/core/store.ts');
  const { bootstrapMetadata } = await import('../../src/core/meta-store.ts');
  await bootstrapMetadata(localStore);
  return localStore;
}

describe('流程编排闭环', () => {
  let store: any;
  beforeEach(async () => { store = await boot(); });

  it('空骨架发布后可跑完（无审批）', async () => {
    const { emptyFlowTemplate } = await import('../../src/core/meta-authoring.ts');
    const { upsertMetaEntry, getMetaRecord } = await import('../../src/core/meta-store.ts');
    const { runWorkflow } = await import('../../src/core/workflow-engine.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const tpl = emptyFlowTemplate({ id: 'flow.demo-loop', name: '编排自测', description: '开始到结束' });
    await withActor(testActor, () => upsertMetaEntry(store, 'flow', tpl.id, tpl, 0));
    const rec = await getMetaRecord(store, 'flow', 'flow.demo-loop');
    assert.equal(rec?.version, 1);
    const ctx = { ...buildContext(() => {}), store, actor: testActor };
    const run = await withActor(testActor, () => runWorkflow(store, 'flow.demo-loop', { summary: 'hello' }, ctx));
    assert.equal(run.status, 'completed');
    assert.equal(run.steps.length, 2);
  });

  it('改已有模板必须带真实 version，错版本拒绝；对上则可再发布再跑', async () => {
    const { getMetaRecord, upsertMetaEntry } = await import('../../src/core/meta-store.ts');
    const rec = await getMetaRecord(store, 'flow', 'flow.task-acceptance');
    assert.ok(rec && rec.version >= 1);
    const next = { ...rec.payload, name: '任务验收（改）', graph: rec.payload.graph };
    await assert.rejects(
      () => withActor(testActor, () => upsertMetaEntry(store, 'flow', rec.key, next, 0)),
      /版本冲突/,
    );
    await withActor(testActor, () => upsertMetaEntry(store, 'flow', rec.key, next, rec.version));
    const rec2 = await getMetaRecord(store, 'flow', 'flow.task-acceptance');
    assert.equal(rec2?.version, rec.version + 1);
    assert.equal(rec2?.payload.name, '任务验收（改）');
  });

  it('任务验收：发起 → 等待经理 → 通过 → 完成', async () => {
    const { runWorkflow, listMyApprovals, decideFlowApproval } = await import('../../src/core/workflow-engine.ts');
    const { buildContext } = await import('../../src/core/context.ts');
    const ctx = { ...buildContext(() => {}), store, actor: testActor };
    const run = await withActor(testActor, () => runWorkflow(store, 'flow.task-acceptance', { title: '整理客户资料', result: '已上传' }, ctx));
    assert.equal(run.status, 'waiting');
    const tasks = await withActor(manager, () => listMyApprovals(store, manager));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].role, 'manager');
    const done = await withActor(manager, () => decideFlowApproval(store, tasks[0].id, 'approved', { ...ctx, actor: manager }));
    assert.equal(done.status, 'completed');
    assert.ok(done.steps.some((s: any) => s.step_id === 'finish_ok'));
  });

  it('metadata.propose 挂确认卡，确认后流程进入运行态', async () => {
    const { emptyFlowTemplate, proposeMetadataWrite } = await import('../../src/core/meta-authoring.ts');
    const { getMetaRecord } = await import('../../src/core/meta-store.ts');
    const { getWorkflowTemplate } = await import('../../src/core/workflow-engine.ts');
    const tpl = emptyFlowTemplate({ id: 'flow.ai-draft', name: 'AI 起草' });
    const proposed = await withActor(testActor, () => proposeMetadataWrite(store, {
      kind: 'flow', key: tpl.id, payload: tpl as any, expected_revision: 0,
    }));
    assert.equal(proposed.ok, true);
    assert.equal(await getMetaRecord(store, 'flow', 'flow.ai-draft'), null);
    await withActor(testActor, () => resolveConfirmation(store, proposed.id, 'confirmed', testActor));
    const rec = await getMetaRecord(store, 'flow', 'flow.ai-draft');
    assert.equal(rec?.version, 1);
    assert.ok(getWorkflowTemplate('flow.ai-draft'));
  });
});
