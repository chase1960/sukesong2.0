// 每日经营简报（A3 2026-08-10）：定时聚合经营数据 → 生成 markdown 简报 → 落 execution.briefs。
// 数字与看板共用 aggregateBusiness（保证一致）；推送一期只落库 + 看板展示，webhook 留配置位。
// R3（2026-08-14）：补发票口径——当日入账收付（发票入账数/金额）+ 待审数 + 应收逾期笔数（与 alerts 同规则）。
import type { StateStore, RuntimeConfig } from './types.ts';
import { aggregateBusiness } from './aggregate.ts';
import {cashSummary,businessDate} from '../capabilities/finance-domain.ts';

export interface BriefRecord {
  id: string;
  brief_date: string;
  content: string;
  metrics: string;   // JSON 快照
  created_at: string;
}

const num = (v: any): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };

// 生成并落库当天简报，返回简报文本。
export async function generateDailyBrief(store: StateStore, cfg?: RuntimeConfig): Promise<string> {
  const s = await aggregateBusiness(store);
  const today = businessDate();
  const cash=await cashSummary(store,{date_from:today,date_to:today});
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];

  // —— R3：发票口径（当日入账收付 / 待审 / 应收逾期笔数）——
  const invoices = await store.query('business', 'invoices');
  const bookedToday = (invoices as any[]).filter((i) =>
    i.status === '已入账' && String(i.reviewed_at || i.updated_at || '').slice(0, 10) === today);
  const bookedTodayAmt = bookedToday.reduce((sum, i) => sum + num(i.total_amount), 0);
  const pendingCount = (invoices as any[]).filter((i) => i.status === '待审').length;
  // 应收逾期（与 alerts.scanAlerts 同规则）：未收完且超期（due_date 或创建时间 + overdue_days）
  const overdueDays = Number(cfg?.alerts?.overdue_days) || 30;
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const recvs = await store.query('business', 'receivables');
  const overdueCount = (recvs as any[]).filter((r) => {
    if ((num(r.amount) - num(r.received)) <= 0) return false;
    const due = r.due_date ? new Date(String(r.due_date).slice(0, 10) + 'T00:00:00').getTime() : new Date(String(r.created_at || '')).getTime();
    return Number.isFinite(due) && now - due >= overdueDays * dayMs;
  }).length;

  const content = [
    `📊 经营简报 · ${today}（周${week}）`,
    '',
    `- 实际收付款：今日收 **¥${cash.received.toLocaleString('zh-CN')}** · 付 **¥${cash.paid.toLocaleString('zh-CN')}** · 净额 **¥${cash.net.toLocaleString('zh-CN')}**（收付款流水口径，非开票金额）`,
    ...cash.warnings.map(warning=>`- 待核对：${warning}`),
    `- 发票：今日入账 **${bookedToday.length}** 张 **¥${Math.round(bookedTodayAmt).toLocaleString('zh-CN')}**，待审 **${pendingCount}** 张`,
    `- 订单：共 **${s.order_count}** 单（草稿 ${s.order_pending} / 已确认 ${s.order_confirmed} / 已完成 ${s.order_completed}）`,
    `- 应收：未收 **¥${s.receivable_balance.toLocaleString('zh-CN')}**（含已收与未收的差额）· 逾期 **${overdueCount}** 笔`,
    `- 应付：未付 **¥${s.payable_balance.toLocaleString('zh-CN')}**`,
    `- 库存：**${s.inventory_sku}** 个 SKU 有货`,
    `- 毛利：**¥${s.gross_profit.toLocaleString('zh-CN')}**（已完成订单口径）`,
    `- 事件：**${s.events_total}** 条写操作统一留痕`,
    '',
    '数据来自真实业务表 · 写操作全部走事件写总线',
  ].join('\n');
  await store.insert('execution', 'briefs', {
    brief_date: today, content, metrics: JSON.stringify({ ...s,cash, bookedToday: bookedToday.length, bookedTodayAmt, pendingCount, overdueCount }), created_at: new Date().toISOString(),
  });
  return content;
}

// 最近 N 条简报（时间倒序）
export async function listBriefs(store: StateStore, limit = 5): Promise<BriefRecord[]> {
  const rows = await store.query('execution', 'briefs');
  return rows
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}
