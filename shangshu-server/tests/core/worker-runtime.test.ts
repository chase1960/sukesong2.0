import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/core/storage/sqlite.ts';
import type { Context, StateStore } from '../../src/core/types.ts';
import type { ActorContext } from '../../src/core/actor.ts';
import { registerCapability } from '../../src/core/registry.ts';
import { registerObjectTools } from '../../src/capabilities/object-tools.ts';
import {
  clearWorkflowTemplates,
  registerWorkflowTemplate,
  type WorkflowTemplate,
  listMyApprovals,
  decideFlowApproval,
} from '../../src/core/workflow-engine.ts';
import {
  createWorkerProfile,
  dispatchWorker,
  getWorkerRun,
  handoffWorkerRun,
  pauseWorkerRun,
  resumeWorkerRun,
} from '../../src/core/worker-runtime.ts';

const admin: ActorContext = { id: 'worker-admin', role: 'admin', kind: 'human', channel: 'test' };
const staff: ActorContext = { id: 'worker-staff', role: 'staff', kind: 'human', channel: 'test' };
const manager: ActorContext = { id: 'worker-manager', role: 'manager', kind: 'human', channel: 'test' };

let store: SqliteStore;
let toolsRegistered = false;

function ctx(actor: ActorContext): Context {
  return {
    actor,
    store,
    file: {} as Context['file'],
    external: {} as Context['external'],
    config: {} as Context['config'],
    log: () => {},
  };
}

function flow(id: string, nodes: WorkflowTemplate['graph']['nodes'], edges: WorkflowTemplate['graph']['edges'], start = nodes[0].id): WorkflowTemplate {
  return {
    id,
    name: id,
    description: '数字员工运行时测试流程',
    revision: 1,
    inputSchema: { type: 'object' },
    steps: [],
    graph: { start, nodes, edges },
  } as WorkflowTemplate;
}

beforeEach(async () => {
  clearWorkflowTemplates();
  if (!toolsRegistered) { registerObjectTools(); toolsRegistered = true; }
  const dir = mkdtempSync(join(tmpdir(), 'ss-worker-runtime-'));
  store = new SqliteStore(join(dir, 'state.sqlite'));
});

afterEach(async () => {
  await store.close();
});

describe('数字员工运行时', () => {
  it('只允许管理员配置，并验证 worker id、流程和能力白名单', async () => {
    const id = 'flow.worker-config';
    registerWorkflowTemplate(flow(id,
      [
        { id: 'note', kind: 'capability', name: '路标', capability: 'flow.note' },
        { id: 'list', kind: 'capability', name: '对象清单', capability: 'object.list' },
      ],
      [{ from: 'note', to: 'list' }],
    ));

    await assert.rejects(
      () => createWorkerProfile(store, { id: 'worker.config', name: '配置助手', responsibility: '整理事项', flow_id: id }, staff),
      /无权限/,
    );
    await assert.rejects(
      () => createWorkerProfile(store, { id: 'worker.Bad', name: '配置助手', responsibility: '整理事项', flow_id: id }, admin),
      /worker\. 开头的小写标识/,
    );
    await assert.rejects(
      () => createWorkerProfile(store, { id: 'worker.missing', name: '配置助手', responsibility: '整理事项', flow_id: 'flow.unknown' }, admin),
      /流程不存在或尚未发布/,
    );
    await assert.rejects(
      () => createWorkerProfile(store, { id: 'worker.missing-capability', name: '配置助手', responsibility: '整理事项', flow_id: id, allowed_tools: ['flow.note'] }, admin),
      /流程包含未授权能力：object\.list/,
    );

    const profile = await createWorkerProfile(store, {
      id: 'worker.config', name: '配置助手', responsibility: '整理事项', flow_id: id,
    }, admin);
    assert.deepEqual(profile.allowed_tools.sort(), ['flow.note', 'object.list'].sort());
  });

  it('拒绝没有前置人工审批的写入流程', async () => {
    const id = 'flow.worker-propose';
    registerWorkflowTemplate(flow(id,
      [{ id: 'write', kind: 'capability', name: '提案', capability: 'object.propose' }],
      [],
    ));
    await assert.rejects(
      () => createWorkerProfile(store, { id: 'worker.proposer', name: '提案助手', responsibility: '提交提案', flow_id: id }, admin),
      /写入\/提案能力 object\.propose 前必须有人工审批节点/,
    );
  });

  it('派发已发布流程，并把 flow_runs 投影为已完成 worker run', async () => {
    const id = 'flow.worker-complete';
    registerWorkflowTemplate(flow(id,
      [{ id: 'note', kind: 'capability', name: '路标', capability: 'flow.note', inputMap: { note: '$input.note' } }],
      [],
    ));
    const profile = await createWorkerProfile(store, {
      id: 'worker.complete', name: '完成助手', responsibility: '记录事项', flow_id: id,
    }, admin);
    const run = await dispatchWorker(store, profile.id, { note: 'hello' }, ctx(staff));

    assert.equal(run.status, 'completed');
    assert.ok(run.flow_run_id.startsWith('fr_'));
    assert.equal((await store.query('execution', 'flow_runs', { id: run.flow_run_id })).length, 1);
    const projected = await getWorkerRun(store, run.id);
    assert.equal(projected?.status, 'completed');
    const events = await store.query('execution', 'events');
    assert.deepEqual(events.map((event: any) => event.capability).sort(), ['worker.dispatch', 'worker.profile.create'].sort());
  });

  it('支持暂停、人工交接和接手人恢复，原负责人不能越权恢复', async () => {
    const id = 'flow.worker-approval';
    registerWorkflowTemplate(flow(id,
      [
        { id: 'review', kind: 'approval', name: '经理审批', approval: { roles: ['manager'], mode: 'serial' } },
        { id: 'note', kind: 'capability', name: '完成', capability: 'flow.note', inputMap: { note: 'done' } },
      ],
      [{ from: 'review', to: 'note', kind: 'success' }],
    ));
    const profile = await createWorkerProfile(store, {
      id: 'worker.approval', name: '审批助手', responsibility: '等待经理确认后记录', flow_id: id,
    }, admin);
    const run = await dispatchWorker(store, profile.id, {}, ctx(staff));
    assert.equal(run.status, 'waiting');

    const paused = await pauseWorkerRun(store, run.id, '需要补充背景', staff);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pause_reason, '需要补充背景');

    const handedOff = await handoffWorkerRun(store, run.id, manager, staff);
    assert.equal(handedOff.status, 'handed_off');
    assert.equal(handedOff.handoff_to, manager.id);
    assert.equal((await store.query('execution', 'flow_runs', { id: run.flow_run_id }))[0].actor.id, manager.id);
    await assert.rejects(() => resumeWorkerRun(store, run.id, ctx(staff)), /无权恢复其他人的流程/);

    const resumed = await resumeWorkerRun(store, run.id, ctx(manager));
    assert.equal(resumed.status, 'waiting');
    const approvals = await listMyApprovals(store, manager);
    assert.equal(approvals.length, 1);
    const completedFlow = await decideFlowApproval(store, approvals[0].id, 'approved', ctx(manager));
    assert.equal(completedFlow.status, 'completed');
    assert.equal((await getWorkerRun(store, run.id))?.status, 'completed');

    const events = await store.query('execution', 'events');
    assert.deepEqual(events.map((event: any) => event.capability).sort(), ['worker.dispatch', 'worker.handoff', 'worker.profile.create'].sort());
  });

  it('拒绝把非人工身份作为交接对象', async () => {
    const id = 'flow.worker-handoff-target';
    registerWorkflowTemplate(flow(id,
      [{ id: 'review', kind: 'approval', name: '审批', approval: { roles: ['manager'] } },
        { id: 'note', kind: 'capability', name: '路标', capability: 'flow.note' }],
      [{ from: 'review', to: 'note', kind: 'success' }],
    ));
    const profile = await createWorkerProfile(store, {
      id: 'worker.handoff-target', name: '交接助手', responsibility: '等待审批', flow_id: id,
    }, admin);
    const run = await dispatchWorker(store, profile.id, {}, ctx(staff));
    await assert.rejects(
      () => handoffWorkerRun(store, run.id, { ...manager, kind: 'service' }, staff),
      /只能交接给人工账号/,
    );
  });
});
