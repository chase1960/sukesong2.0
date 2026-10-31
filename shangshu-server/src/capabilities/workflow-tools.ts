// 办事流程能力：flow.run / flow.list / flow.get
import { registerCapability } from '../core/registry.ts';
import {
  getWorkflowRun, listWorkflowRuns, listWorkflowTemplates, runWorkflow,
} from '../core/workflow-engine.ts';
import type { Capability } from '../core/types.ts';

const flowList: Capability<Record<string, never>, unknown> = {
  id: 'flow.list', name: '列出办事流程', impl: 'script', effect: 'read', roles: ['admin','finance','manager','staff','service'],
  async run() {
    return { flows: listWorkflowTemplates() };
  },
};

const flowRun: Capability<
  { flow_id: string; input?: Record<string, unknown>; file_token?: string; item?: Record<string, unknown>; doctype?: string; initiator?: string; [k: string]: unknown },
  unknown
> = {
  id: 'flow.run', name: '运行办事流程', impl: 'script', effect: 'orchestrate', roles: ['admin','finance','manager','staff','service'],
  async run(input, ctx) {
    const flowId = String(input.flow_id || '').trim();
    if (!flowId) throw new Error('flow_id 必填');
    const nested = input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input : undefined;
    const payload: Record<string, unknown> = { ...(nested || input) };
    delete payload.flow_id;
    delete payload.initiator;
    delete payload.input;
    const record = await runWorkflow(ctx.store, flowId, payload, ctx, {
      initiator: String(input.initiator || 'manual'),
    });
    return {
      ok: true,
      run_id: record.id,
      flow_id: record.flow_id,
      status: record.status,
      steps: record.steps,
      result: record.result,
    };
  },
};

const flowGet: Capability<{ run_id: string }, unknown> = {
  id: 'flow.get', name: '查询流程运行轨迹', impl: 'script', effect: 'read', roles: ['admin','finance','manager','staff','service'],
  async run(input, ctx) {
    const id = String(input.run_id || '').trim();
    if (!id) throw new Error('run_id 必填');
    const run = await getWorkflowRun(ctx.store, id);
    if (!run) throw new Error(`未找到流程运行: ${id}`);
    if (ctx.actor?.role !== 'admin' && ctx.actor?.id !== run.actor?.id) throw new Error('无权查看其他人的流程运行数据');
    return { run };
  },
};

export function registerWorkflowTools(): void {
  registerCapability(flowList);
  registerCapability(flowRun);
  registerCapability(flowGet);
}

export { listWorkflowRuns, getWorkflowRun };
