import { testActor, testContext } from '../helpers/actor.ts';
// R3 高置信自动入账（2026-08-14）：invoice.file 入库时 confidence ≥ 阈值（默认 0.9）→ 直通入账生成应付；
// 低于阈值 → 待审人工。收票事件（invoice.ingest）留痕覆盖责任链全链。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerInvoiceCapabilities } from '../../src/capabilities/invoice.ts';
import { buildContext } from '../../src/core/context.ts';
import { getCapability } from '../../src/core/registry.ts';
import type { ExternalServices } from '../../src/core/types.ts';

describe('R3 高置信自动入账', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-autobook-'));
    process.env._SS_DATA_DIR = dir;
  });
  afterEach(() => {
    // 清理临时附件
    const filesDir = join(dir, 'files');
    if (existsSync(filesDir)) rmSync(filesDir, { recursive: true });
  });

  const runFile = async (confidence: number) => {
    registerInvoiceCapabilities();
    const mockExternal: ExternalServices = {
      mail: { listUnread: async () => [], fetchAttachment: async () => ({ filename: '', mime: '', bytes: Buffer.from('') }), markRead: async () => {} },
      ocr: {
        start: async () => {},
        extract: async () => ({
          fields: { invoice_no: 'IN-AUTO-1', invoice_code: 'CODE1', seller_name: '恒泰供应商', buyer_name: '尚书科技', total_amount: 888, tax_amount: 0, amount_ex_tax: 888, issued_at: '2026-08-01' },
          confidence,
          validation_warnings: {},
          raw_text: 'x',
        }),
        stop: () => {},
      },
    };
    const ctx = testContext(buildContext(() => {}, { external: mockExternal }));
    // 等价于 server.ts buildApp 里的 invoice.book handler（能力测试进程不建 app）
    const { registerActionHandler } = await import('../../src/core/confirm.ts');
    registerActionHandler('invoice.book', async (p: any) => {
      await ctx.store.insert('business', 'payables', { invoice_id: p.invoice_id, supplier: p.supplier || '', amount: p.amount || 0, paid: 0, status: '未付', created_at: new Date().toISOString() });
      await ctx.store.update('business', 'invoices', String(p.invoice_id), { status: '已入账' });
    });
    const cap = getCapability('invoice.file');
    // 直接构造 extract 输出（真实 extract 需要文件，此处测 file 能力本身）
    const extract = {
      fields: { invoice_no: 'IN-AUTO-1', invoice_code: 'CODE1', seller_name: '恒泰供应商', buyer_name: '尚书科技', total_amount: 888, tax_amount: 0, amount_ex_tax: 888, issued_at: '2026-08-01' },
      confidence,
      validation_warnings: {},
      raw_text: 'x',
    };
    return cap.run({
      item: { mail_id: 'm1', file_token: 'tok-' + confidence, filename: 'a.pdf', mime: 'application/pdf', sender_email: 's@x.com', email_subject: '发票', received_at: new Date().toISOString(), source: 'email' },
      extract,
    }, ctx);
  };

  it('即使旧阈值和高 confidence 存在，也只能待审入库', async () => {
    const r = await runFile(0.95);
    assert.equal(r.status, 'added');
    const { localStore } = await import('../../src/core/store.ts');
    assert.equal((await localStore.query('business','invoices'))[0].status, '待审');
    assert.equal((await localStore.query('business','ledger')).length, 0);
    assert.equal((await localStore.query('business','payables')).length, 0);
    const events = await localStore.query('execution','events');
    assert.ok(events.some(e => e.capability === 'invoice.ingest'));
    assert.ok(!events.some(e => e.capability === 'invoice.book'));
  });

  it('低置信（0.8 < 0.9）→ 保持待审，不生成应付', async () => {
    await runFile(0.8);
    const { localStore } = await import('../../src/core/store.ts');
    const invs = await localStore.query('business', 'invoices');
    assert.equal(invs[0].status, '待审');
    assert.equal((await localStore.query('business', 'payables')).length, 0);
  });
});
