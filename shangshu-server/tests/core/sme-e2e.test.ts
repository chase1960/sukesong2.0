import { testActor, testContext } from '../helpers/actor.ts';
// 小微主干 E2E（Goal Done 验收向）：收票 Flow → 入库确认 → 入账确认 → 事件留痕
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerInvoiceCapabilities } from '../../src/capabilities/invoice.ts';
import { registerDocExtractTools } from '../../src/capabilities/doc-extract.ts';
import { registerPresetDocTypes } from '../../src/core/doctypes.ts';
import { registerPresetWorkflows } from '../../src/flows/presets.ts';
import { registerWorkflowTools } from '../../src/capabilities/workflow-tools.ts';
import { registerObjectTools, proposeObjectWrite } from '../../src/capabilities/object-tools.ts';
import { registerAllActionHandlers } from '../../src/capabilities/actions.ts';
import { bootstrapMetadata } from '../../src/core/meta-store.ts';
import { runWorkflow } from '../../src/core/workflow-engine.ts';
import { resolveConfirmation, listPendingConfirmations } from '../../src/core/confirm.ts';
import type { Context } from '../../src/core/types.ts';

describe('小微主干 E2E', () => {
  before(() => {
    process.env._SS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ss-sme-e2e-'));
    registerInvoiceCapabilities();
    registerDocExtractTools();
    registerObjectTools();
    registerAllActionHandlers();
    registerPresetDocTypes();
    registerPresetWorkflows();
    registerWorkflowTools();
  });

  it('收票 → 提案入库/入账 → 确认 → 事件链', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    await bootstrapMetadata(localStore);

    const ctx: Context = {
      actor: testActor,
      store: localStore,
      config: {
        store: { provider: 'local' },
        ocr: { provider: 'mock', confidence_auto_book: 0 },
        file: { provider: 'local', dir: '' },
      } as any,
      log: () => {},
      file: {
        upload: async () => ({ token: 'tok_e2e' }),
        read: async () => ({ bytes: Buffer.from('pdf'), mime: 'application/pdf', name: 'x.pdf' }),
      },
      external: {
        ocr: {
          extract: async () => ({
            fields: {
              invoice_code: '', invoice_no: 'E2E-001', invoice_type: '电子普',
              seller_name: 'E2E销方', buyer_name: 'E2E购方',
              amount_ex_tax: 100, tax_amount: 6, total_amount: 106,
              issued_at: '2026-08-24', check_code: '',
            },
            confidence: 0.5, validation_warnings: {}, raw_text: 'mock', ocr_path: 'text-rule',
          }),
        },
        mail: {} as any,
      },
    };

    const run = await runWorkflow(localStore, 'flow.invoice-intake', {
      file_token: 'tok_e2e',
      doctype: 'invoice_cn_vat',
      item: {
        mail_id: 'upload:tok_e2e', file_token: 'tok_e2e', filename: 'x.pdf', mime: 'application/pdf',
        sender_email: '', email_subject: 'e2e', received_at: new Date().toISOString(), source: 'upload',
      },
    }, ctx, { initiator: 'test' });
    assert.equal(run.status, 'completed');
    const invId = String(run.result?.invoice_id || '');
    assert.ok(invId);

    const proposed = await proposeObjectWrite(localStore, {
      object: 'invoice', action: 'invoice.approve',
      data: { invoice_id: invId }, initiator: 'agent', actor: testActor,
    });
    assert.equal(proposed.ok, true);
    let pending = await listPendingConfirmations(localStore);
    assert.ok(pending.some((p) => p.id === proposed.id));
    await resolveConfirmation(localStore, proposed.id!, 'confirmed', { id: '财务E2E', role: 'admin', kind: 'human', channel: 'test' });

    const inv1 = (await localStore.query('business', 'invoices', { id: invId }))[0] as any;
    assert.equal(inv1.status, '已入库');

    const book = await proposeObjectWrite(localStore, {
      object: 'invoice', action: 'invoice.book',
      data: { invoice_id: invId }, initiator: 'agent', actor: testActor,
    });
    await resolveConfirmation(localStore, book.id!, 'confirmed', { id: '财务E2E', role: 'admin', kind: 'human', channel: 'test' });

    const inv2 = (await localStore.query('business', 'invoices', { id: invId }))[0] as any;
    assert.equal(inv2.status, '已入账');

    const events = await localStore.query('execution', 'events');
    assert.ok(events.some((e: any) => e.capability === 'invoice.approve' && e.status === 'confirmed'));
    assert.ok(events.some((e: any) => e.capability === 'invoice.book' && e.status === 'confirmed'));
    assert.ok(events.some((e: any) => e.capability === 'invoice.ingest'));
  });
});
