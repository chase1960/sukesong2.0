// R3 简报口径（2026-08-14）：含发票当日入账/待审、应收逾期笔数（此前 A6 计划缺失的 brief 测试）
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessDate } from '../../src/capabilities/finance-domain.ts';

describe('每日经营简报 R3', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-brief-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('简报含发票收付与应收逾期（数字对得上）', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const { generateDailyBrief, listBriefs } = await import('../../src/core/brief.ts');
    const store: any = localStore;
    const today = `${businessDate()}T00:00:00.000Z`;
    // 1 张今日已入账 + 1 张待审
    await store.insert('business', 'invoices', { invoice_no: 'B1', status: '已入账', total_amount: 500, invoice_direction: '进项', reviewed_at: today, received_at: today, created_at: today });
    await store.insert('business', 'invoices', { invoice_no: 'B2', status: '待审', total_amount: 300, invoice_direction: '进项', received_at: today, created_at: today });
    // 1 笔逾期应收（40 天前创建，未收）
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    await store.insert('business', 'receivables', { customer_id: 'c1', customer_name: '蓝海制造', amount: 1000, received: 0, status: '未收', due_date: '', created_at: old });
    // 1 笔未逾期应收（今天创建）
    await store.insert('business', 'receivables', { customer_id: 'c2', customer_name: '恒泰', amount: 2000, received: 0, status: '未收', due_date: '', created_at: today });

    const content = await generateDailyBrief(store);
    assert.match(content, /今日入账 \*\*1\*\* 张 \*\*¥500\*\*/, '当日入账数/金额');
    assert.match(content, /待审 \*\*1\*\* 张/, '待审数');
    assert.match(content, /逾期 \*\*1\*\* 笔/, '逾期笔数（40 天超默认 30 天）');
    assert.match(content, /未收 \*\*¥3,000\*\*/, '应收未收总额（1000+2000）');
    const briefs = await listBriefs(store);
    assert.equal(briefs.length, 1);
    const m = JSON.parse(briefs[0].metrics);
    assert.equal(m.bookedToday, 1);
    assert.equal(m.overdueCount, 1);
  });
});
