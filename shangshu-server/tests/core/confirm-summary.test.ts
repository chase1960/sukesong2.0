import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerPresetObjects } from '../../src/core/objects.ts';
import { summarizeConfirmationEvent } from '../../src/core/confirm-summary.ts';

describe('确认卡通用摘要', () => {
  registerPresetObjects();

  it('invoice.approve 走 ActionDef 摘要', () => {
    const s = summarizeConfirmationEvent({
      id: 'e1',
      capability: 'invoice.approve',
      entity_type: 'invoice',
      entity_id: 'inv1',
      payload: JSON.stringify({
        invoice_id: 'inv1', invoice_no: 'N-100', seller_name: '甲公司', amount: 500,
      }),
      status: 'proposed',
      initiator: 'agent',
      created_at: new Date().toISOString(),
    } as any);
    assert.match(s.title, /审核入库/);
    assert.match(s.title, /N-100/);
    assert.ok(s.lines.some((l) => /发票/.test(l)));
    assert.equal(s.object_id, 'invoice');
  });
});
