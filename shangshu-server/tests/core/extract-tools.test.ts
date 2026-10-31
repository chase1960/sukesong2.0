import { testActor, testContext } from '../helpers/actor.ts';
// 抽取工具（M3）：单路径 + doc.extract 级联
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { registerDocExtractTools } from '../../src/capabilities/doc-extract.ts';
import { cascadeDocExtract, EXTRACT_PATHS } from '../../src/capabilities/extract-tools.ts';
import { registerPresetDocTypes } from '../../src/core/doctypes.ts';
import { getCapability } from '../../src/core/registry.ts';
import type { Context } from '../../src/core/types.ts';

describe('抽取工具 extract.*', () => {
  before(() => {
    registerDocExtractTools();
    registerPresetDocTypes();
  });

  function mockCtx(forcePathBehavior: Record<string, 'ok' | 'fail'>): Context {
    return {
      actor: testActor,
      store: {} as any,
      config: {
        ocr: { provider: 'mock', api_key: '', base_url: '', model: '' },
      } as any,
      log: () => {},
      file: {
        read: async () => ({ bytes: Buffer.from('%PDF'), mime: 'application/pdf', name: 't.pdf' }),
      } as any,
      external: {
        ocr: {
          extract: async (form: FormData) => {
            const path = String(form.get('force_path') || '');
            if (forcePathBehavior[path] === 'fail') {
              throw new Error(`${path} 无结果`);
            }
            return {
              fields: {
                invoice_no: 'EXT-001', seller_name: '测', total_amount: 88,
                invoice_code: '', invoice_type: '电子普', buyer_name: '购',
                amount_ex_tax: 80, tax_amount: 8, issued_at: '2026-08-24', check_code: '',
              },
              confidence: 0.5,
              validation_warnings: {},
              raw_text: `[mock:${path}]`,
              ocr_path: path || 'text-rule',
            };
          },
        },
        mail: {} as any,
      },
    };
  }

  it('extract.text_rule 单路径可观测', async () => {
    const out = await getCapability('extract.text_rule').run(
      { file_token: 'tok1' },
      mockCtx({ 'text-rule': 'ok' }),
    );
    assert.equal(out.extraction_path, 'text-rule');
    assert.equal((out.fields as any).invoice_no, 'EXT-001');
  });

  it('cascadeDocExtract 级联到 vision', async () => {
    const out = await cascadeDocExtract(mockCtx({
      'text-rule': 'fail',
      'text-llm': 'fail',
      vision: 'ok',
    }), { file_token: 'tok1' });
    assert.equal(out.extraction_path, 'vision');
  });

  it('doc.extract 注册三条路径工具', () => {
    for (const p of EXTRACT_PATHS) {
      const id = p === 'text-rule' ? 'extract.text_rule' : p === 'text-llm' ? 'extract.text_llm' : 'extract.vision';
      assert.ok(getCapability(id), id);
    }
  });
});
