// 统一审批卡片（2026-11-19）：把所有"需要人介入才继续"的中断，收敛成一张可推送的卡。
//
// 为什么需要单独一层：
//   系统里原本有三种中断，各走各的页面：
//     1) AI 提案确认卡（execution.events.proposed）
//     2) 图流程审批节点（execution.flow_approvals.pending）
//     3) HR 分级引擎判定的 L3/L4 动作（最终也落成 1）
//   人不在工作台里时，这三种都不会主动找人；等回到页面才发现"卡住了半天"。
//   这里把它们统一登记到 execution.approval_cards，并通过飞书群机器人把卡片推到人面前。
//
// 设计边界：
//   - 只做"登记 + 推送 + 从卡片发起决策"，不复制业务状态；真相仍在事件流 / flow_approvals。
//   - 推送失败不影响业务事务：卡片先落库，推送是事务外的异步动作，失败可重试。
//   - 未配置 webhook 时卡片仍可用（状态 unconfigured），在页面里照样能批，不假装推送成功。
import type { StateStore } from './types.ts';
import { parsePayload } from './events.ts';
import { summarizeConfirmationEvent } from './confirm-summary.ts';
import { getActionContract } from './action-contracts.ts';

export interface ApprovalCard {
  id: string;
  kind: 'confirm' | 'flow';
  ref_id: string;
  capability: string;
  title: string;
  summary: string;
  role: string;
  level: string;
  sla: string;
  link: string;
  status: 'pending' | 'approved' | 'rejected' | 'closed';
  push_status: 'pending' | 'sent' | 'failed' | 'unconfigured';
  push_error?: string;
  created_at: string;
  pushed_at?: string;
  decided_at?: string;
  decided_by?: string;
  dedupe_key: string;
}

const TABLE = 'approval_cards';

function webhookUrl(): string {
  return String(process.env.APPROVAL_WEBHOOK_URL || '').trim();
}

function publicBase(): string {
  return String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
}

export function approvalLink(): string {
  const base = publicBase();
  return `${base}/index.html#/hr`;
}

function slaFor(level: string): string {
  if (level === 'L4') return '3 个工作日内给出结论';
  if (level === 'L3') return '1 个工作日内确认';
  return '4 小时内确认';
}

/** HR 动作按分级引擎算级；非 HR 的确认卡本质就是"单步确认"，固定 L2。 */
async function ruleFor(capability: string): Promise<{ level: string; name: string }> {
  if (!capability.startsWith('hr.')) return { level: 'L2', name: '' };
  try {
    // 动态引入：approval-cards 会被 confirm/router 引用，避免启动期循环依赖。
    const { decide } = await import('../capabilities/hr/autonomy.ts');
    const d = decide({ action_key: capability });
    return { level: d.level, name: d.action_name };
  } catch {
    return { level: 'L2', name: '' };
  }
}

async function insertCard(store: StateStore, input: Omit<ApprovalCard, 'id' | 'status' | 'push_status' | 'created_at'>): Promise<ApprovalCard | null> {
  const existing = (await store.query('execution', TABLE, { dedupe_key: input.dedupe_key }))[0] as ApprovalCard | undefined;
  if (existing) {
    // 同一中断重复同步时刷新展示字段（标题/摘要可能因契约升级而更可读），但不重置推送与决策状态。
    if (existing.status === 'pending' && (existing.title !== input.title || existing.summary !== input.summary || existing.role !== input.role)) {
      await store.update('execution', TABLE, existing.id, { title: input.title, summary: input.summary, role: input.role, level: input.level });
    }
    // 后配 webhook 时，历史卡从"未配置"转成"待推送"，不必重建。
    if (existing.status === 'pending' && existing.push_status === 'unconfigured' && webhookUrl()) {
      await store.update('execution', TABLE, existing.id, { push_status: 'pending' });
    }
    return null;
  }
  const row: Omit<ApprovalCard, 'id'> = {
    ...input,
    status: 'pending',
    push_status: webhookUrl() ? 'pending' : 'unconfigured',
    created_at: new Date().toISOString(),
  };
  await store.insert('execution', TABLE, row);
  return (await store.query('execution', TABLE, { dedupe_key: input.dedupe_key }))[0] as ApprovalCard;
}

/** 同步三类中断 → 审批卡；顺带关闭已经处理掉但卡还挂着的记录。 */
export async function syncApprovalCards(store: StateStore): Promise<{ created: number; closed: number }> {
  let created = 0;
  let closed = 0;

  // 1) 确认卡提案
  const { listPendingConfirmations } = await import('./confirm.ts');
  const pending = await listPendingConfirmations(store);
  const liveConfirmIds = new Set<string>();
  for (const evt of pending) {
    liveConfirmIds.add(String(evt.id));
    const s = summarizeConfirmationEvent(evt);
    let roles = 'admin';
    try { roles = getActionContract(evt.capability).roles.join('/') || 'admin'; } catch { /* 未注册契约的提案不推送 */ }
    const rule = await ruleFor(String(evt.capability));
    const level = rule.level;
    // 尽量用"人话"当主语：员工姓名 > 通用名称 > 实体 id。
    const payload = parsePayload(evt.payload) as Record<string, unknown>;
    const subject = String(payload.employee_name || payload.name || payload.customer_name || payload.title || evt.entity_id || '');
    const card = await insertCard(store, {
      kind: 'confirm', ref_id: String(evt.id), capability: String(evt.capability),
      title: rule.name ? `${rule.name}${subject ? ` · ${subject}` : ''}` : s.title,
      summary: s.lines.join(' · ') || subject,
      role: roles, level, sla: slaFor(level), link: approvalLink(),
      dedupe_key: `confirm:${evt.id}`,
    });
    if (card) created++;
  }

  // 2) 图流程审批任务
  const flowPending = await store.query('execution', 'flow_approvals', { status: 'pending' });
  for (const task of flowPending as any[]) {
    const card = await insertCard(store, {
      kind: 'flow', ref_id: String(task.id), capability: 'flow.approval',
      title: `流程审批 · ${task.node_name || task.flow_id}`,
      summary: String(task.note || task.input_summary || ''),
      role: String(task.role || 'admin'), level: 'L3', sla: slaFor('L3'), link: approvalLink(),
      dedupe_key: `flow:${task.id}`,
    });
    if (card) created++;
  }

  // 3) 清理已经不再 pending 的卡（提案被撤/流程已决定）
  const cards = await store.query('execution', TABLE, { status: 'pending' });
  const flowPendingIds = new Set((flowPending as any[]).map(t => String(t.id)));
  for (const card of cards as ApprovalCard[]) {
    const alive = card.kind === 'confirm' ? liveConfirmIds.has(card.ref_id) : flowPendingIds.has(card.ref_id);
    if (!alive && card.status === 'pending') {
      await store.update('execution', TABLE, card.id, { status: 'closed', decided_at: new Date().toISOString(), decided_by: 'system:sync' });
      closed++;
    }
  }

  return { created, closed };
}

function cardPayload(card: ApprovalCard): Record<string, unknown> {
  const base = publicBase();
  const url = card.link.startsWith('http') ? card.link : `${base}${card.link}`;
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: card.level === 'L4' ? 'red' : card.level === 'L3' ? 'orange' : 'blue',
        title: { tag: 'plain_text', content: `待审批 · ${card.title}`.slice(0, 80) },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: [
              `**动作**：${card.capability}`,
              `**级别**：${card.level}（${card.sla}）`,
              `**审批人**：${card.role}`,
              card.summary ? `**摘要**：${card.summary}` : '',
            ].filter(Boolean).join('\n'),
          },
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `卡片 ${card.id} · 生成于 ${card.created_at}` }],
        },
        {
          tag: 'action',
          actions: [{
            tag: 'button', type: 'primary',
            text: { tag: 'plain_text', content: '打开审批中心' },
            url: url || 'https://example.com',
          }],
        },
      ],
    },
  };
}

/** 推送待发送卡片；失败只记录，不抛出（业务事务已完成）。 */
export async function flushApprovalPushes(store: StateStore, limit = 20): Promise<{ sent: number; failed: number; skipped: number }> {
  const url = webhookUrl();
  if (!url) {
    const rows = await store.query('execution', TABLE, { push_status: 'pending' });
    for (const row of rows as ApprovalCard[]) await store.update('execution', TABLE, row.id, { push_status: 'unconfigured' });
    return { sent: 0, failed: 0, skipped: rows.length };
  }
  let sent = 0;
  let failed = 0;
  const rows = (await store.query('execution', TABLE, { push_status: 'pending' })).slice(0, limit) as ApprovalCard[];
  for (const card of rows) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cardPayload(card)),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      // 飞书群机器人成功：{"code":0,"msg":"success"} 或旧版 {"StatusCode":0}
      const ok = res.ok && /"code"\s*:\s*0|"StatusCode"\s*:\s*0/.test(text);
      if (ok) {
        await store.update('execution', TABLE, card.id, { push_status: 'sent', pushed_at: new Date().toISOString() });
        sent++;
      } else {
        await store.update('execution', TABLE, card.id, { push_status: 'failed', push_error: `HTTP ${res.status} ${text.slice(0, 120)}` });
        failed++;
      }
    } catch (error) {
      await store.update('execution', TABLE, card.id, { push_status: 'failed', push_error: (error as Error).message.slice(0, 160) });
      failed++;
    }
  }
  return { sent, failed, skipped: 0 };
}

// 合并短时间内的多次触发：一次事务里可能连开好几张卡，推送只跑一轮。
const timers = new WeakMap<StateStore, ReturnType<typeof setTimeout>>();

export function scheduleApprovalSync(store: StateStore): void {
  const old = timers.get(store);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    timers.delete(store);
    syncApprovalCards(store)
      .then(() => flushApprovalPushes(store))
      .catch((error) => console.error('[approval] 同步/推送失败:', (error as Error).message));
  }, 80);
  timer.unref?.();
  timers.set(store, timer);
}

export async function listApprovalCards(store: StateStore, status = 'pending'): Promise<ApprovalCard[]> {
  const rows = await store.query('execution', TABLE, { status });
  return (rows as ApprovalCard[]).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** 从卡片直接决策：确认卡走 resolveConfirmation；流程审批交给审核中心（这里只做状态回写提示）。 */
export async function decideApprovalCard(
  store: StateStore, cardId: string, decision: 'confirmed' | 'rejected', reviewer: string,
): Promise<{ ok: true; kind: string }> {
  const [card] = await store.query('execution', TABLE, { id: cardId }) as ApprovalCard[];
  if (!card) throw new Error('审批卡不存在');
  if (card.status !== 'pending') throw new Error(`审批卡已处理：${card.status}`);
  if (card.kind === 'flow') throw new Error('流程审批请在审核中心处理（含串行/并行与超时规则）');
  const { resolveConfirmation } = await import('./confirm.ts');
  await resolveConfirmation(store, card.ref_id, decision, reviewer);
  await store.update('execution', TABLE, cardId, {
    status: decision === 'confirmed' ? 'approved' : 'rejected',
    decided_at: new Date().toISOString(), decided_by: reviewer,
  });
  return { ok: true, kind: card.kind };
}

export function approvalPushConfigured(): boolean {
  return !!webhookUrl();
}
