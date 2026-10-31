// 主动提醒（A4 2026-08-10）：定时扫描经营数据 → 生成 execution.alerts（应收逾期 / 库存预警）。
// 规则可配置（runtime_config.alerts）：overdue_days 应收逾期天数（默认 30）、min_stock 库存预警线（0=不预警）。
// 去重：同一类型 + 同一引用 + 待处理已存在则跳过（不重复刷屏）。
import type { StateStore, RuntimeConfig } from './types.ts';

export interface AlertInput {
  overdue_days: number;
  min_stock: number;
}

export async function scanAlerts(store: StateStore, cfg: RuntimeConfig): Promise<{ added: number }> {
  const opts: AlertInput = {
    overdue_days: Number(cfg.alerts?.overdue_days) || 30,
    min_stock: Number(cfg.alerts?.min_stock) || 0,
  };
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let added = 0;

  const pending = await store.query('execution', 'alerts', { status: '待处理' });
  const exists = (type: string, refId: string) => pending.some((a: any) => a.type === type && a.ref_id === refId);

  // 1. 应收逾期：未收完（未收/部分已收）且超期
  const recvs = await store.query('business', 'receivables');
  for (const r of recvs as any[]) {
    if ((Number(r.amount) - Number(r.received)) <= 0) continue;
    const due = r.due_date ? new Date(String(r.due_date).slice(0, 10) + 'T00:00:00').getTime() : new Date(String(r.created_at || '')).getTime();
    if (!Number.isFinite(due) || now - due < opts.overdue_days * dayMs) continue;
    const balance = Math.round((Number(r.amount) - Number(r.received)) * 100) / 100;
    const refId = String(r.id);
    if (exists('receivable_overdue', refId)) continue;
    await store.insert('execution', 'alerts', {
      type: 'receivable_overdue',
      title: `应收逾期：${r.customer_name || '未知客户'} 欠 ¥${balance.toLocaleString('zh-CN')}`,
      detail: `应收 ${r.amount} · 已收 ${r.received} · 超期 ${Math.floor((now - due) / dayMs)} 天`,
      ref_type: 'receivable', ref_id: refId, status: '待处理', created_at: new Date().toISOString(),
    });
    added++;
  }

  // 2. 库存预警：低于预警线（min_stock>0 启用）
  if (opts.min_stock > 0) {
    const inv = await store.query('business', 'inventory');
    for (const i of inv as any[]) {
      const qty = Number(i.qty) || 0;
      if (qty >= opts.min_stock) continue;
      const refId = String(i.product_id);
      if (exists('stock_low', refId)) continue;
      await store.insert('execution', 'alerts', {
        type: 'stock_low',
        title: `库存预警：${i.product_name || i.sku || '产品'} 仅剩 ${qty}`,
        detail: `预警线 ${opts.min_stock} · 请及时补货（可对话吩咐创建采购单）`,
        ref_type: 'inventory', ref_id: refId, status: '待处理', created_at: new Date().toISOString(),
      });
      added++;
    }
  }

  return { added };
}
