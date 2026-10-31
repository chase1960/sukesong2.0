// 图流程引擎（2026-08-28）：审批节点 serial 双审 / 拒绝出边 / 超时出边 / any 模式 / 图校验。
// 用 graph.note 能力做路标；审批人用 withActor 按角色代入。
import { proposeForTest } from '../helpers/actor.ts';
import { testActor } from '../helpers/actor.ts';
import { withActor, type ActorContext } from '../../src/core/actor.ts';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, StateStore } from '../../src/core/types.ts';
import type { WorkflowTemplate } from '../../src/core/workflow-engine.ts';

const ROLES_ACTOR: Record<string, ActorContext> = {
  finance: { id: 'fin1', role: 'finance', kind: 'human', channel: 'chat' },
  admin: { id: 'boss1', role: 'admin', kind: 'human', channel: 'chat' },
  manager: { id: 'mgr1', role: 'manager', kind: 'human', channel: 'chat' },
};

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ss-graphflow-'));
  process.env._SS_DATA_DIR = dir;
  const { localStore } = await import('../../src/core/store.ts');
  const { registerObjectTools } = await import('../../src/capabilities/object-tools.ts');
  const { registerWorkflowTemplate } = await import('../../src/core/workflow-engine.ts');
  registerObjectTools();
  const mk = (over: Partial<WorkflowTemplate>): WorkflowTemplate => ({
    id: 'g', name: '图流程', description: '', revision: 1,
    inputSchema: { type: 'object' }, steps: [],
    graph: {
      start: 'a',
      nodes: [
        { id: 'a', kind: 'capability', name: '开始', capability: 'flow.note', inputMap: { note: 'start' } },
        { id: 'end_ok', kind: 'capability', name: '通过', capability: 'flow.note', inputMap: { note: 'ok' } },
        { id: 'end_rej', kind: 'capability', name: '拒绝', capability: 'flow.note', inputMap: { note: 'rej' } },
      ],
      edges: [{ from: 'a', to: 'end_ok' }],
    },
    ...over,
  } as WorkflowTemplate);
  return { localStore, registerWorkflowTemplate, mk };
}

const ctxFor = (role: string): Context => ({ actor: ROLES_ACTOR[role] }) as Context;

describe('图流程：审批节点', () => {
  let store: StateStore;
  let registerWorkflowTemplate: any, mk: any;
  beforeEach(async () => {
    const f = await fresh();
    store = f.localStore; registerWorkflowTemplate = f.registerWorkflowTemplate; mk = f.mk;
  });

  it('serial 双审：财务审完等老板；老板通过走 success 边', async () => {
    const { runWorkflow, listMyApprovals, decideFlowApproval, getWorkflowRun } = await import('../../src/core/workflow-engine.ts');
    registerWorkflowTemplate(mk({
      graph: {
        start: 'a',
        nodes: [
          { id: 'a', kind: 'capability', name: '开始', capability: 'flow.note' },
          { id: 'r1', kind: 'approval', name: '财务审', approval: { roles: ['finance'], mode: 'serial' } },
          { id: 'r2', kind: 'approval', name: '老板审', approval: { roles: ['admin'], mode: 'serial' } },
          { id: 'end_ok', kind: 'capability', name: '通过', capability: 'flow.note' },
          { id: 'end_rej', kind: 'capability', name: '拒绝', capability: 'flow.note' },
        ],
        edges: [
          { from: 'a', to: 'r1' },
          { from: 'r1', to: 'r2', kind: 'success' },
          { from: 'r1', to: 'end_rej', kind: 'rejected' },
          { from: 'r2', to: 'end_ok', kind: 'success' },
        ],
      },
    }));
    const { buildContext } = await import('../../src/core/context.ts');
    const run = await runWorkflow(store, 'g', {}, { ...({} as Context), store, actor: testActor, log: console.log } as Context);
    assert.equal(run.status, 'waiting');

    // 老板（admin）可见全部待审卡（管理员全局可见是设计）；无关角色（manager）代审财务 slot 被拒
    const bossTasks = await withActor(ROLES_ACTOR.admin, () => listMyApprovals(store, ROLES_ACTOR.admin));
    assert.equal(bossTasks.length, 1);
    const finTasks = await withActor(ROLES_ACTOR.finance, () => listMyApprovals(store, ROLES_ACTOR.finance));
    assert.equal(finTasks.length, 1);
    await assert.rejects(() => decideFlowApproval(store, finTasks[0].id, 'approved', ctxFor('manager')), /需要 finance/);
    const r1 = await withActor(ROLES_ACTOR.finance, () => decideFlowApproval(store, finTasks[0].id, 'approved', ctxFor('finance')));
    assert.equal(r1.status, 'waiting');
    const bossTasks2 = await withActor(ROLES_ACTOR.admin, () => listMyApprovals(store, ROLES_ACTOR.admin));
    assert.equal(bossTasks2.length, 1);

    // 重复决定同一张卡被拒
    await assert.rejects(() => withActor(ROLES_ACTOR.finance, () => decideFlowApproval(store, finTasks[0].id, 'approved', ctxFor('finance'))), /已处理/);

    const done = await withActor(ROLES_ACTOR.admin, () => decideFlowApproval(store, bossTasks2[0].id, 'approved', ctxFor('admin')));
    assert.equal(done.status, 'completed');
    const trace = done.steps.find(s => s.step_id === 'r1');
    assert.equal(trace?.approval?.decision, 'approved');
  });

  it('拒绝边：财务拒绝走 end_rej，不再等老板', async () => {
    const { runWorkflow, listMyApprovals, decideFlowApproval } = await import('../../src/core/workflow-engine.ts');
    registerWorkflowTemplate(mk({
      graph: {
        start: 'a',
        nodes: [
          { id: 'a', kind: 'capability', name: '开始', capability: 'flow.note' },
          { id: 'r1', kind: 'approval', name: '财务审', approval: { roles: ['finance', 'admin'], mode: 'serial' } },
          { id: 'end_ok', kind: 'capability', name: '通过', capability: 'flow.note' },
          { id: 'end_rej', kind: 'capability', name: '拒绝', capability: 'flow.note' },
        ],
        edges: [
          { from: 'a', to: 'r1' },
          { from: 'r1', to: 'end_ok', kind: 'success' },
          { from: 'r1', to: 'end_rej', kind: 'rejected' },
        ],
      },
    }));
    const run = await runWorkflow(store, 'g', {}, { ...({} as Context), store, actor: testActor, log: console.log } as Context);
    const tasks = await withActor(ROLES_ACTOR.finance, () => listMyApprovals(store, ROLES_ACTOR.finance));
    const done = await withActor(ROLES_ACTOR.finance, () => decideFlowApproval(store, tasks[0].id, 'rejected', ctxFor('finance')));
    assert.equal(done.status, 'completed');
    const last = done.steps[done.steps.length - 1];
    assert.equal(last.step_id, 'end_rej');   // 拒绝终点被执行
  });

  it('any 模式：任一角色通过即过，其余卡自动取消', async () => {
    const { runWorkflow, listMyApprovals, decideFlowApproval } = await import('../../src/core/workflow-engine.ts');
    registerWorkflowTemplate(mk({
      graph: {
        start: 'a',
        nodes: [
          { id: 'a', kind: 'capability', name: '开始', capability: 'flow.note' },
          { id: 'r1', kind: 'approval', name: '任一审', approval: { roles: ['finance', 'manager'], mode: 'any' } },
          { id: 'end_ok', kind: 'capability', name: '通过', capability: 'flow.note' },
          { id: 'end_rej', kind: 'capability', name: '拒绝', capability: 'flow.note' },
        ],
        edges: [
          { from: 'a', to: 'r1' },
          { from: 'r1', to: 'end_ok', kind: 'success' },
          { from: 'r1', to: 'end_rej', kind: 'rejected' },
        ],
      },
    }));
    await runWorkflow(store, 'g', {}, { ...({} as Context), store, actor: testActor, log: console.log } as Context);
    const fin = await withActor(ROLES_ACTOR.finance, () => listMyApprovals(store, ROLES_ACTOR.finance));
    const mgr = await withActor(ROLES_ACTOR.manager, () => listMyApprovals(store, ROLES_ACTOR.manager));
    assert.equal(fin.length, 1); assert.equal(mgr.length, 1);
    const done = await withActor(ROLES_ACTOR.manager, () => decideFlowApproval(store, mgr[0].id, 'approved', ctxFor('manager')));
    assert.equal(done.status, 'completed');
    const left = await withActor(ROLES_ACTOR.finance, () => listMyApprovals(store, ROLES_ACTOR.finance));
    assert.equal(left.length, 0);   // 兄弟卡被取消
  });

  it('图校验：审批边语义、歧义无条件边、非法角色', async () => {
    const { validateWorkflow } = await import('../../src/core/workflow-engine.ts');
    const base = { id: 'x', name: 'x', description: '', inputSchema: { type: 'object' }, steps: [] };
    assert.throws(() => validateWorkflow(mk({
      graph: { start: 'a', nodes: [
        { id: 'a', kind: 'capability', name: 'A', capability: 'flow.note' },
        { id: 'r', kind: 'approval', name: 'R', approval: { roles: ['boss'] } },
        { id: 'b', kind: 'capability', name: 'B', capability: 'flow.note' },
      ], edges: [{ from: 'a', to: 'r' }, { from: 'r', to: 'b' }] },
    })), /角色非法/);
    assert.throws(() => validateWorkflow(mk({
      graph: { start: 'a', nodes: [
        { id: 'a', kind: 'capability', name: 'A', capability: 'flow.note' },
        { id: 'b', kind: 'capability', name: 'B', capability: 'flow.note' },
        { id: 'c', kind: 'capability', name: 'C', capability: 'flow.note' },
      ], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] },
    })), /路由歧义/);
    // 审批出边不支持条件 when
    assert.throws(() => validateWorkflow(mk({
      graph: { start: 'a', nodes: [
        { id: 'a', kind: 'approval', name: 'R', approval: { roles: ['finance'] } },
        { id: 'b', kind: 'capability', name: 'B', capability: 'flow.note' },
      ], edges: [{ from: 'a', to: 'b', kind: 'success', when: { path: 'x', equals: 1 } }] },
    })), /不支持条件/);
    // 合法网关：条件边 + 无条件默认边，不抛
    assert.doesNotThrow(() => validateWorkflow(mk({
      graph: { start: 'a', nodes: [
        { id: 'a', kind: 'gateway', name: 'G', switch: { path: 'steps.a.value' } },
        { id: 'b', kind: 'capability', name: 'B', capability: 'flow.note' },
        { id: 'c', kind: 'capability', name: 'C', capability: 'flow.note' },
      ], edges: [{ from: 'a', to: 'b', when: { equals: 'big' } }, { from: 'a', to: 'c' }] },
    })));
  });
});

// 让 proposeForTest 引用不悬空（本文件主路径用 decideFlowApproval）
void proposeForTest;
