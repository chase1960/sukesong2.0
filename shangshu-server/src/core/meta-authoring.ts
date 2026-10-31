// 元数据编排入口：空模板、提案写、与对象/单据/流程共用同一发布契约。
// UI 画布、HTTP、对话工具都走这里，不另造一套「流程专用写库」。
import { requireActor } from './actor.ts';
import { getActionContract, checkAction } from './action-contracts.ts';
import { requestConfirmation } from './confirm.ts';
import { assertValidMetadata, getMetaRecord, type MetaKind } from './meta-store.ts';
import type { StateStore } from './types.ts';
import type { WorkflowTemplate } from './workflow-engine.ts';

const FLOW_ID = /^flow\.[a-z][a-z0-9_.-]+$/;

/** 新建流程的可运行骨架：开始 → 结束（flow.note）。后续在画布/AI 上加节点，不改引擎。 */
export function emptyFlowTemplate(opts: { id: string; name: string; description?: string }): WorkflowTemplate {
  const id = String(opts.id || '').trim();
  const name = String(opts.name || '').trim();
  if (!FLOW_ID.test(id)) throw new Error('流程 id 须为 flow. 开头的小写标识（字母数字._-）');
  if (!name) throw new Error('流程名称必填');
  return {
    id, name, description: String(opts.description || ''),
    steps: [],
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', title: '摘要', minLength: 1 } },
      required: ['summary'],
    },
    graph: {
      start: 'start',
      nodes: [
        { id: 'start', kind: 'capability', name: '开始', capability: 'flow.note', inputMap: { note: '$input.summary' }, ui: { x: 80, y: 140 } },
        { id: 'end', kind: 'capability', name: '结束', capability: 'flow.note', inputMap: { note: '完成' }, ui: { x: 360, y: 140 } },
      ],
      edges: [{ from: 'start', to: 'end' }],
    },
  };
}

export async function proposeMetadataWrite(store: StateStore, input: {
  kind: MetaKind; key: string; payload: Record<string, unknown>; expected_revision?: number;
}) {
  const actor = requireActor();
  const contract = getActionContract('metadata.publish');
  checkAction(contract, actor);
  if (!contract.resolve) throw new Error('元数据发布缺少提案解析契约');
  const resolved = await contract.resolve(store, input as Record<string, unknown>);
  checkAction(contract, actor, resolved.payload);
  const id = await requestConfirmation(store, {
    capability: 'metadata.publish',
    entity_type: resolved.entity_type,
    entity_id: resolved.entity_id,
    payload: resolved.payload,
    initiator: actor.id,
  });
  return {
    ok: true,
    id,
    capability: 'metadata.publish',
    entity_type: resolved.entity_type,
    entity_id: resolved.entity_id,
    payload: resolved.payload,
    summary: { title: `发布 ${resolved.entity_type} · ${resolved.entity_id}`, lines: [`确认后写入 meta_registry，仅影响新实例`] },
    note: '已提交确认卡，同意后才会发布到运行态',
  };
}

export async function resolveMetadataPublish(store: StateStore, input: Record<string, unknown>) {
  const kind = String(input.kind || '') as MetaKind;
  const key = String(input.key || '').trim();
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? { ...(input.payload as Record<string, unknown>) } : null;
  if (!['object', 'doctype', 'flow'].includes(kind)) throw new Error('kind 须为 object / doctype / flow');
  if (!key || !payload) throw new Error('key 与 payload 必填');
  if (payload.id && String(payload.id) !== key) throw new Error('payload.id 必须与 key 一致');
  payload.id = key;
  assertValidMetadata(kind, key, payload);
  const rec = await getMetaRecord(store, kind, key);
  const current = rec?.version ?? 0;
  const expected = input.expected_revision == null ? current : Number(input.expected_revision);
  if (!Number.isInteger(expected) || expected < 0) throw new Error('expected_revision 须为非负整数');
  if (expected !== current) throw new Error(`元数据版本冲突：当前 v${current}，提案基于 v${expected}。请 metadata_get 后重提`);
  return {
    entity_type: kind,
    entity_id: key,
    payload: { kind, key, payload, expected_revision: expected },
  };
}
