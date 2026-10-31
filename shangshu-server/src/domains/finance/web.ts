// 财务域 BFF 适配。公共平台只负责传输、鉴权与挂载，不承载票据字段和业务动作。
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Router, Request, Response, RequestHandler } from 'express';
import { loadConfig } from '../../core/config.ts';
import { createToolSelector } from '../../core/infra/tool-selector.ts';
import type { ExternalServices } from '../../core/types.ts';
type JsonObject = Record<string, any>;
type Transport = {
 frappeGet: (method:string, req:Request, params?:Record<string,unknown>)=>Promise<JsonObject>;
 frappePost: (method:string, req:Request, data:Record<string,unknown>)=>Promise<JsonObject>;
 wrap: (fn:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
 PlatformError: new(status:number,code:string,message:string,detail?:unknown)=>Error;
};
const METHOD = {
  financeProcessCenter: 'shangshu_finance.api.process_center',
  financeInstance: 'shangshu_finance.api.claim_instance',
  upload: 'shangshu_finance.api.upload_document',
  prepareExtraction: 'shangshu_finance.api.extraction_prepare',
  extracted: 'shangshu_finance.api.extraction_succeeded',
  extractFailed: 'shangshu_finance.api.extraction_failed',
  invoiceConfirm: 'shangshu_finance.api.invoice_confirm',
  claimCreate: 'shangshu_finance.api.claim_create',
  claimAction: 'shangshu_finance.api.claim_action',
  posting: 'shangshu_finance.api.posting_confirm',
  payment: 'shangshu_finance.api.payable_pay',
  reconcile: 'shangshu_finance.api.reconciliation',
};
export function mountFinanceRoutes(router:Router, transport:Transport, external?:ExternalServices) {
const {frappeGet,frappePost,wrap,PlatformError}=transport;
function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function chooseScanTool(fileName: string, mime: string): Promise<{ capability: string; reason: string; source: 'ai' | 'rule' }> {
  try {
    const selector = createToolSelector(loadConfig().llm, { timeoutMs: 12_000 });
    const choice = await selector({ candidates: ['document.ocr_extract', 'document.vision_extract'], input: { file_name: fileName, mime, instruction: '选择最适合读取扫描票据的工具' } });
    if (!['document.ocr_extract', 'document.vision_extract'].includes(choice.capability)) throw new Error('模型返回候选集合外工具');
    return { ...choice, source: 'ai' };
  } catch {
    return { capability: 'document.ocr_extract', reason: 'AI 选择不可用，按已声明的安全降级规则使用 OCR；未扩大工具候选范围', source: 'rule' };
  }
}

async function extractDocument(req: Request, res: Response, external?: ExternalServices): Promise<void> {
  if (!external?.ocr) throw new PlatformError(503, 'EXTRACTION_UNAVAILABLE', '票据识别服务尚未启动');
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const fileName = decodeURIComponent(String(req.headers['x-file-name'] || '')).trim();
  if (!bytes.length || !fileName) throw new PlatformError(400, 'VALIDATION_FAILED', '请选择票据文件');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const created = await frappePost(METHOD.upload, req, {
    file_name: fileName,
    content_base64: bytes.toString('base64'),
    has_text_layer: 0,
    file_sha256: digest,
  });
  const mime = mimeFor(fileName);
  const ocr = loadConfig().ocr;
  const runPath = async (forcePath: string) => {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: mime }), fileName);
    form.append('provider', ocr.provider);
    form.append('expected_buyer', loadConfig().enterprise?.name || '');
    form.append('force_path', forcePath);
    if (ocr.api_key) form.append('api_key', ocr.api_key);
    if (ocr.base_url) form.append('base_url', ocr.base_url);
    if (ocr.model) form.append('model', ocr.model);
    return withTimeout(external.ocr.extract(form), 180_000, '票据识别超时');
  };
  const started = Date.now();
  try {
    let output: Awaited<ReturnType<typeof external.ocr.extract>> | null = null;
    let selection: { capability: string; reason: string; source: 'ai' | 'rule' };
    // PDF 先走固定文字层解析；只有该路径未得到有效字段时才进入扫描件 AI 选择节点。
    if (mime === 'application/pdf') {
      try {
        const probed = await runPath('text-rule');
        if (probed.fields && Object.keys(probed.fields).length) {
          output = probed;
          selection = { capability: 'document.pdf_text_extract', reason: 'PDF 文字层解析得到有效字段，使用流程定义中的固定工具', source: 'rule' };
          await frappePost(METHOD.prepareExtraction, req, { extraction: created.extraction, has_text_layer: 1 });
        } else throw new Error('PDF 无可用文字层字段');
      } catch {
        selection = await chooseScanTool(fileName, mime);
        await frappePost(METHOD.prepareExtraction, req, { extraction: created.extraction, has_text_layer: 0 });
      }
    } else {
      selection = await chooseScanTool(fileName, mime);
      await frappePost(METHOD.prepareExtraction, req, { extraction: created.extraction, has_text_layer: 0 });
    }
    if (!output) {
      const forcePath = selection.capability === 'document.vision_extract' ? 'vision' : 'text-llm';
      output = await runPath(forcePath);
    }
    // 旧 OCR 服务使用 invoice_no / issued_at；平台业务契约使用可读且稳定的
    // invoice_number / invoice_date。只在 BFF 做协议归一，不让 Frappe 或前端认识旧字段名。
    const rawFields = output.fields && typeof output.fields === 'object' ? output.fields : {};
    output = {
      ...output,
      fields: {
        ...rawFields,
        invoice_number: rawFields.invoice_number || rawFields.invoice_no,
        invoice_date: rawFields.invoice_date || rawFields.issued_at,
        direction: rawFields.direction || 'Input',
      },
    };
    const result = await frappePost(METHOD.extracted, req, {
      extraction: created.extraction,
      selected_tool: selection.capability,
      output,
      warnings: output.validation_warnings || {},
      raw_text: output.raw_text || '',
      reason: selection.reason,
      duration_ms: Date.now() - started,
      callback_id: randomUUID(),
    });
    res.status(201).json({ ok: true, ...result, tool: { id: selection.capability, reason: selection.reason, selection: selection.source }, warnings: output.validation_warnings || {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : '票据识别失败';
    await frappePost(METHOD.extractFailed, req, { extraction: created.extraction, error_code: message.includes('超时') ? 'EXTRACTION_TIMEOUT' : 'EXTRACTION_FAILED', error_message: message }).catch(() => {});
    throw new PlatformError(422, 'EXTRACTION_FAILED', message, { extraction: created.extraction });
  }
}

  router.get('/api/platform/finance/claims', wrap(async (req, res) => { res.json({ ok: true, list: await frappeGet(METHOD.financeProcessCenter, req, { view: String(req.query.view || 'started') }) }); }));
  router.get('/api/platform/finance/claims/:id', wrap(async (req, res) => { res.json({ ok: true, ...(await frappeGet(METHOD.financeInstance, req, { claim: req.params.id })) }); }));
  router.post('/api/platform/finance/claims/:id/actions', wrap(async (req, res) => {
    const action = String(req.body?.action || '');
    const key = String(req.body?.idempotency_key || randomUUID());
    let result: JsonObject;
    if (action === 'post') result = await frappePost(METHOD.posting, req, { claim: req.params.id, confirmed: req.body?.confirmed, idempotency_key: key });
    else if (action === 'pay') result = await frappePost(METHOD.payment, req, { payable: req.body?.payable, account: req.body?.account, expected_version: req.body?.expected_version, confirmed: req.body?.confirmed, idempotency_key: key });
    else result = await frappePost(METHOD.claimAction, req, { claim: req.params.id, action, note: req.body?.note, confirmed: req.body?.confirmed, idempotency_key: key });
    res.json({ ok: true, ...result });
  }));
  router.get('/api/platform/finance/claims/:id/reconciliation', wrap(async (req, res) => { res.json({ ok: true, ...(await frappeGet(METHOD.reconcile, req, { claim: req.params.id })) }); }));
  router.post('/api/platform/finance/documents', wrap((req, res) => extractDocument(req, res, external)));
  router.post('/api/platform/finance/invoices/:id/confirm', wrap(async (req, res) => {
    res.json({ ok: true, ...(await frappePost(METHOD.invoiceConfirm, req, { invoice: req.params.id, expected_version: req.body?.expected_version, fields: req.body?.fields || {}, confirmed: req.body?.confirmed, idempotency_key: req.body?.idempotency_key || randomUUID() })) });
  }));
  router.post('/api/platform/finance/claims', wrap(async (req, res) => {
    res.status(201).json({ ok: true, ...(await frappePost(METHOD.claimCreate, req, { invoice: req.body?.invoice, subject: req.body?.subject, department: req.body?.department, cost_center: req.body?.cost_center, purpose: req.body?.purpose, confirmed: req.body?.confirmed, idempotency_key: req.body?.idempotency_key || randomUUID() })) });
  }));
}
