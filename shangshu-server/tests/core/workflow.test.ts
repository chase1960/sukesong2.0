import { testActor, testContext } from '../helpers/actor.ts';
// 办事流程引擎 + 收票 Flow（M3）
import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerInvoiceCapabilities } from '../../src/capabilities/invoice.ts';
import { registerDocExtractTools } from '../../src/capabilities/doc-extract.ts';
import { registerPresetWorkflows } from '../../src/flows/presets.ts';
import { registerPresetDocTypes } from '../../src/core/doctypes.ts';
import { registerWorkflowTools } from '../../src/capabilities/workflow-tools.ts';
import { listWorkflowTemplates, runWorkflow } from '../../src/core/workflow-engine.ts';
import { listDocTypes } from '../../src/core/doctypes.ts';
import { localStore } from '../../src/core/store.ts';
import type { Context } from '../../src/core/types.ts';

describe('办事流程 · 收票 intake', () => {
  before(() => {
    registerInvoiceCapabilities();
    registerDocExtractTools();
    registerPresetDocTypes();
    registerPresetWorkflows();
    registerWorkflowTools();
  });

  it('预置收票 Flow 与 invoice DocType', () => {
    const flows = listWorkflowTemplates();
    const intake = flows.find((f) => f.id === 'flow.invoice-intake');
    assert.ok(intake);
    assert.equal(intake!.step_count, 4);
    assert.ok(listDocTypes().some((d) => d.id === 'invoice_cn_vat'));
  });

  it('生产选择器通过模型函数调用选择候选工具，越界响应拒绝',async()=>{
    const {createToolSelector}=await import('../../src/core/infra/tool-selector.ts');
    let capability='extract.text_rule';
    const intercepted=mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'choice',function:{name:'choose_tool',arguments:JSON.stringify({capability,reason:'文字 PDF'})}}]}}]})+'\n\ndata: [DONE]\n\n'));
    try {
      const select=createToolSelector({base_url:'http://127.0.0.1:1/v1',model:'test',provider:'ollama',api_key:''});
      assert.deepEqual(await select({candidates:['extract.text_rule'],input:{filename:'a.pdf'}}),{capability:'extract.text_rule',reason:'文字 PDF'});
      capability='invoice.file';
      await assert.rejects(()=>select({candidates:['extract.text_rule'],input:{}}),/参数校验/);
    } finally {intercepted.mock.restore();}
  });

  it('flow.invoice-intake 逐步留痕并待审入库', async () => {
    const fileBytes = Buffer.from('%PDF-1.4 mock');
    const invNo = `FLOW-${Date.now().toString(36)}`;
    const ctx: Context = {
      actor: testActor,
      store: localStore,
      config: {
        store: { provider: 'local' },
        ocr: { provider: 'mock', endpoint_url: '', api_key: '', base_url: '', model: '', confidence_auto_book: 0 },
        file: { provider: 'local', dir: '' },
        mail: {} as any,
        poll: {} as any,
        server: {} as any,
        llm: {} as any,
        feishu: {} as any,
      } as any,
      log: () => {},
      file: {
        upload: async () => ({ token: 'tok_flow_test' }),
        read: async () => ({ bytes: fileBytes, mime: 'application/pdf', name: 't.pdf' }),
      },
      external: {
        ocr: {
          extract: async (form: FormData) => {
            const path = String(form.get('force_path') || 'text-rule');
            if (path !== 'text-rule') throw new Error(`${path} 无匹配（测试 mock）`);
            return {
              fields: {
                invoice_code: '', invoice_no: invNo, invoice_type: '电子普',
                seller_name: '测试销方', buyer_name: '测试购方',
                amount_ex_tax: 100, tax_amount: 6, total_amount: 106,
                issued_at: '2026-08-20', check_code: '',
              },
              confidence: 0.87,
              validation_warnings: {},
              raw_text: 'mock',
              ocr_path: 'text-rule',
            };
          },
        },
        mail: {} as any,
      },
    };

    const item = {
      mail_id: 'upload:tok_flow_test',
      file_token: 'tok_flow_test',
      filename: 't.pdf',
      mime: 'application/pdf',
      sender_email: '',
      email_subject: '测试',
      received_at: new Date().toISOString(),
      source: 'upload',
    };

    const run = await runWorkflow(localStore, 'flow.invoice-intake', {
      file_token: 'tok_flow_test',
      doctype: 'invoice_cn_vat',
      item,
    }, ctx, { initiator: 'test' });

    assert.equal(run.status, 'completed');
    assert.equal(run.steps.length, 4);
    assert.equal(run.steps[0].capability, 'extract.text_rule');
    assert.equal(run.steps[0].status, 'ok');
    assert.match(String(run.steps[0].attribution || ''), /text-rule|PDF/);
    assert.equal(run.steps[1].status, 'skipped');
    assert.equal(run.steps[2].status, 'skipped');
    assert.equal(run.steps[3].capability, 'invoice.file');
    assert.equal(run.result?.status, 'added');
    assert.ok(run.result?.invoice_id);

    const inv = await localStore.query('business', 'invoices', { invoice_no: invNo });
    assert.equal(inv.length, 1);
    assert.equal((inv[0] as any).status, '待审');
  });

  it('抽取全失败时不应崩溃 invoice.file', async () => {
    const ctx: Context = {
      actor: testActor,
      store: localStore,
      config: {
        store: { provider: 'local' },
        ocr: { provider: 'mock', endpoint_url: '', api_key: '', base_url: '', model: '', confidence_auto_book: 0 },
        file: { provider: 'local', dir: '' },
        mail: {} as any,
        poll: {} as any,
        server: {} as any,
        llm: {} as any,
        feishu: {} as any,
      } as any,
      log: () => {},
      file: {
        upload: async () => ({ token: 'tok_fail' }),
        read: async () => ({ bytes: Buffer.from('x'), mime: 'application/pdf', name: 'x.pdf' }),
      },
      external: {
        ocr: { extract: async () => { throw new Error('无匹配'); } },
        mail: {} as any,
      },
    };
    await assert.rejects(
      () => runWorkflow(localStore, 'flow.invoice-intake', {
        file_token: 'tok_fail',
        doctype: 'invoice_cn_vat',
        item: {
          mail_id: 'upload:tok_fail', file_token: 'tok_fail', filename: 'x.pdf', mime: 'application/pdf',
          sender_email: '', email_subject: 'x', received_at: new Date().toISOString(), source: 'upload',
        },
      }, ctx, { initiator: 'test' }),
      /抽取步骤均未产出有效字段/,
    );
  });
});
