// 通用对象工具（M1–M2）：object.list / object.query / object.propose
// propose 内部仍走 resolveConfirmPayload + requestConfirmation（确认闸门不交给模型）
import { registerCapability } from '../core/registry.ts';
import {
  getObjectType, listObjectSummaries, resolveObjectAction, summarizeProposal,
} from '../core/objects.ts';
import { currentActor, authorize, requireActor, withActor, type ActorContext } from '../core/actor.ts';
import { getActionContract, checkAction } from '../core/action-contracts.ts';
import { requestConfirmation } from '../core/confirm.ts';
import { parsePayload } from '../core/events.ts';
import type { Capability, StateStore } from '../core/types.ts';

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

export async function runObjectQuery(store: StateStore, input: Record<string, unknown>, actor = currentActor()) {
  const objectId = String(input.object || input.object_id || '').trim();
  if (!objectId) throw new Error('object 必填（如 invoice）');
  const ot = getObjectType(objectId);
  if (!ot) throw new Error(`未知对象: ${objectId}（可用 object_list 查看）`);

  authorize(ot.readRoles || ['admin','finance','manager'], actor);

  // 兼容 filters: [{ field, op, value }] 与扁平字段两种写法
  const queryInput = { ...input };
  if (Array.isArray(input.filters)) {
    for (const f of input.filters) {
      if (!f || typeof f !== 'object') continue;
      const field = String((f as any).field || '').trim();
      const op = String((f as any).op || 'eq').trim();
      if (!field || op !== 'eq') continue;
      queryInput[field] = (f as any).value;
    }
  }

  const filterable = new Set(ot.fields.filter((f) => f.filterable).map((f) => f.id));
  const allRows = await store.query(ot.layer, ot.table);
  const rows = actor?.role === 'staff' && ot.rowOwnerField
    ? allRows.filter((row: any) => String(row[ot.rowOwnerField!] || '') === actor.id)
    : allRows;
  const dateField = ot.dateFilterField;
  const dateFrom = input.date_from ? String(input.date_from).slice(0, 10) : '';
  const dateTo = input.date_to ? String(input.date_to).slice(0, 10) : '';

  const list = rows.filter((r: any) => {
    for (const key of filterable) {
      const raw = queryInput[key];
      if (raw == null || raw === '') continue;
      const want = String(raw).trim();
      const got = String(r[key] ?? '');
      if (key.endsWith('_no') || key === 'status' || ot.fields.find((f) => f.id === key)?.type === 'select') {
        if (got !== want) return false;
      } else if (!got.includes(want)) {
        return false;
      }
    }
    if (dateField && dateFrom && String(r[dateField] || '').slice(0, 10) < dateFrom) return false;
    if (dateField && dateTo && String(r[dateField] || '').slice(0, 10) > dateTo) return false;
    return true;
  });

  const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 20), 1), 100);
  const offset = Number(input.offset || 0);
  if(!Number.isSafeInteger(offset) || offset<0) throw new Error('offset 必须为非负整数');
  const amountField = ot.fields.find((f) => f.id === 'total_amount');
  const total = amountField
    ? list.reduce((s: number, r: any) => s + num(r.total_amount), 0)
    : undefined;

  const byStatus: Record<string, number> = {};
  if (filterable.has('status')) {
    for (const r of list) {
      const st = String((r as any).status || '未知');
      byStatus[st] = (byStatus[st] || 0) + 1;
    }
  }

  const sample = list.slice(offset, offset+limit).map((r: any) => {
    const row: Record<string, unknown> = {id:r.id,_version:r._version};
    for (const f of ot.sampleFields) {
      if (f in r) row[f] = r[f];
      else if (f === 'id') row.id = r.id;
    }
    if (amountField && 'total_amount' in row) row.total_amount = num(row.total_amount);
    return row;
  });

  return {
    object: ot.id,
    count: list.length,
    offset,limit,has_more:offset+limit<list.length,
    ...(total != null ? { total_amount: Math.round(total * 100) / 100 } : {}),
    ...(Object.keys(byStatus).length ? { by_status: byStatus } : {}),
    sample,
  };
}

export async function proposeObjectWrite(
  store: StateStore,
  opts: {
    object: string;
    action: string;
    data?: Record<string, unknown>;
    initiator?: string;
    actorRole?: string;
    actor?: ActorContext;
  },
) {
  const objectId = String(opts.object || '').trim();
  const ot = getObjectType(objectId);
  if (!ot) throw new Error(`未知对象: ${objectId}`);
  const action = resolveObjectAction(ot, opts.action);
  const actor = requireActor(opts.actor || currentActor());
  const contract = getActionContract(action.id);
  checkAction(contract, actor);

  const data = { ...(opts.data || {}) };
  if (!contract.resolve) throw new Error(`动作缺少提案解析契约: ${action.id}`);
  const resolved = await contract.resolve(store, data);
  checkAction(contract, actor, resolved.payload);

  const allEvents = await store.query('execution', 'events');
  const resolvedIds = new Set(allEvents.map(e => parsePayload(e.payload)._resolves));
  const dupRow = allEvents.filter(e => e.capability === action.id && e.status === 'proposed' && !resolvedIds.has(e.id))
    .find((e: any) => JSON.stringify(parsePayload(e.payload)) === JSON.stringify(resolved.payload));
  if (dupRow) {
    const payload = parsePayload(dupRow.payload) as Record<string, unknown>;
    return {
      ok: true,
      duplicate: true,
      id: dupRow.id,
      capability: action.id,
      entity_type: dupRow.entity_type,
      entity_id: dupRow.entity_id,
      payload,
      summary: summarizeProposal(ot, action, payload),
      note: '已有同内容待确认卡，未重复提交',
    };
  }

  const id = await withActor(actor, () => requestConfirmation(store, {
    capability: action.id,
    entity_type: resolved.entity_type,
    entity_id: resolved.entity_id,
    payload: resolved.payload,
    initiator: actor.id,
  }));
  return {
    ok: true,
    duplicate: false,
    id,
    capability: action.id,
    entity_type: resolved.entity_type,
    entity_id: resolved.entity_id,
    payload: resolved.payload,
    summary: summarizeProposal(ot, action, resolved.payload),
    note: `已提交确认卡（${action.id}），同意后才会执行`,
  };
}

const objectList: Capability<Record<string, never>, any> = {
  id: 'object.list', name: '列出数据对象', impl: 'script', effect: 'read', roles: ['admin','finance','manager','staff'],
  async run(_input, ctx) {
    const objects = withActor(requireActor(ctx.actor || currentActor()), () => listObjectSummaries());
    return { count: objects.length, objects };
  },
};

const objectQuery: Capability<any, any> = {
  id: 'object.query', revision:2, name: '按对象查询', impl: 'script', effect: 'read', roles: ['admin','finance','manager','staff'],
  async run(input, ctx) {
    return runObjectQuery(ctx.store, input || {}, ctx.actor || currentActor());
  },
};

const objectPropose: Capability<any, any> = {
  id: 'object.propose', name: '提案对象写操作', impl: 'script', effect: 'propose', roles: ['admin','finance','manager','staff'],
  async run(input, ctx) {
    const data = { ...(input || {}) };
    const object = String(data.object || data.object_id || '');
    const action = String(data.action || '');
    delete data.object;
    delete data.object_id;
    delete data.action;
    delete data.initiator;
    delete data.actor_role;
    return proposeObjectWrite(ctx.store, {
      object,
      action,
      data: input?.data || data,
      initiator: String(input?.initiator || 'agent'),
      actor: ctx.actor || currentActor(),
    });
  },
};

// 图流程通用节点能力（2026-08-28）：flow.note —— 无副作用的路标/终点节点（read），
// 审批拒绝终点、提交记录等；输出原样进轨迹供回放与映射。模块级常量：重复注册同引用不冲突。
const flowNote: Capability<any, any> = {
  id: 'flow.note', revision: 1, name: '流程路标', impl: 'script', effect: 'read', roles: ['admin', 'finance', 'manager', 'staff'],
  async run(input) { return { note: String((input as any)?.note ?? ''), attribution: 'flow.note' }; },
};

export function registerObjectTools(): void {
  registerCapability(flowNote);
  registerCapability(objectList);
  registerCapability(objectQuery);
  registerCapability(objectPropose);
}
