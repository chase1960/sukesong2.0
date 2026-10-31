// 确认卡摘要：按 ActionDef + FieldSpec 通用渲染（Goal A）
import { parsePayload } from './events.ts';
import { listObjectTypes, summarizeProposal, resolveObjectAction, getObjectType } from './objects.ts';
import type { ExecutionEvent } from './types.ts';

export function summarizeConfirmationEvent(evt: ExecutionEvent): {
  title: string;
  lines: string[];
  object_id?: string;
  action_id?: string;
} {
  const cap = String(evt.capability || '');
  const payload = parsePayload(evt.payload) as Record<string, unknown>;

  for (const ot of listObjectTypes()) {
    const action = ot.actions.find((a) => a.id === cap);
    if (action) {
      const s = summarizeProposal(ot, action, payload);
      return { ...s, object_id: ot.id, action_id: action.id };
    }
  }

  // 按 capability 反查对象（invoice.approve → invoice 对象）
  const prefix = cap.split('.')[0];
  const ot = getObjectType(prefix);
  if (ot) {
    try {
      const action = resolveObjectAction(ot, cap);
      const s = summarizeProposal(ot, action, payload);
      return { ...s, object_id: ot.id, action_id: action.id };
    } catch { /* fall through */ }
  }

  const party = String(payload.invoice_no || payload.summary || payload.customer_name || payload.supplier || evt.entity_id || '');
  if (cap === 'metadata.publish') {
    const body = (payload.payload && typeof payload.payload === 'object' ? payload.payload : {}) as Record<string, unknown>;
    return {
      title: `发布 ${payload.kind || evt.entity_type} · ${payload.key || evt.entity_id}`,
      lines: [
        body.name ? `名称 ${body.name}` : '',
        `将发布为 v${Number(payload.expected_revision || 0) + 1}`,
        '仅影响此后新发起的实例',
      ].filter(Boolean),
    };
  }
  return {
    title: `${cap}${party ? ` · ${party}` : ''}`,
    lines: [`动作 ${cap}`, evt.entity_type ? `实体 ${evt.entity_type}/${evt.entity_id}` : ''].filter(Boolean),
  };
}

export function enrichConfirmations(list: ExecutionEvent[]) {
  return list.map((evt) => {
    const summary = summarizeConfirmationEvent(evt);
    return {
      ...evt,
      payload: parsePayload(evt.payload),
      summary,
    };
  });
}
