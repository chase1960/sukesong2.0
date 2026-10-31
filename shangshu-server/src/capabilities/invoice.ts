// 发票收集的三个能力（spec §6）：collect/file 为 script，extract 为 external（经 ctx.external.ocr 抽取）。
import { registerCapability } from '../core/registry.ts';
import { appendEvent } from '../core/events.ts';
import { attachLocal } from '../core/attachments.ts';
import type { Capability, Context } from '../core/types.ts';

// —— invoice.collect：取信 → 下附件 → 存文件 ——
interface CollectIn { mailbox?: string }
interface CollectedItem {
  mail_id: string; file_token: string; filename: string; mime: string;
  sender_email: string; email_subject: string; received_at: string;
  source?: string;  // 'email'（默认）/ 'upload'（手动上传）
}
const collect: Capability<CollectIn, { collected: CollectedItem[] }> = {
  effect: 'internal', roles: ['admin','service'], id: 'invoice.collect', name: '收取发票邮件', impl: 'script',
  async run(_input, ctx) {
    const mails = await ctx.external.mail.listUnread();
    const collected: CollectedItem[] = [];
    for (const m of mails) {
      const att = await ctx.external.mail.fetchAttachment(m.id);
      const { token } = await ctx.file.upload(att.filename, att.bytes, att.mime);
      collected.push({
        mail_id: m.id, file_token: token, filename: att.filename, mime: att.mime,
        sender_email: m.from, email_subject: m.subject, received_at: m.received_at,
      });
      ctx.log(`↓ 收取：${att.filename}（来自 ${m.from}）`);
    }
    return { collected };
  },
};

// —— invoice.extract：把文件丢给 ctx.external.ocr 抽取发票字段 ——
interface ExtractIn { file_token: string }
interface InvoiceFields {
  invoice_code: string; invoice_no: string; invoice_type: string;
  seller_name: string; buyer_name: string;
  amount_ex_tax: number; tax_amount: number; total_amount: number;
  issued_at: string; check_code: string;
}
interface ExtractOut { fields: InvoiceFields; confidence: number; validation_warnings: Record<string, string>; raw_text: string; ocr_path?: string }
const extract: Capability<ExtractIn, ExtractOut> = {
  id: 'invoice.extract', revision:2, name: 'OCR 抽取发票字段', impl: 'external',
  async run(input, ctx) {
    const f = await ctx.file.read(input.file_token);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name);
    // 透传 OCR 配置（provider/api_key/base_url/model）给 ocr_server.py：
    // 不传则服务端默认 provider=mock，导致系统配置页填的 dashscope key 不生效。
    const o = ctx.config.ocr;
    form.append('provider', o.provider);
    form.append('expected_buyer',ctx.config.enterprise?.name || '');
    if (o.api_key) form.append('api_key', o.api_key);
    if (o.base_url) form.append('base_url', o.base_url);
    if (o.model) form.append('model', o.model);
    const data = await ctx.external.ocr.extract(form) as ExtractOut;
    ctx.log(`⌕ 抽取：${data.fields.seller_name || '未知'} ¥${data.fields.total_amount || 0}（置信度 ${(data.confidence * 100).toFixed(0)}%）`);
    return data;
  },
};

// —— invoice.file：去重 → 写 business__invoices（status=待审）——
interface FileIn { item: CollectedItem; extract: ExtractOut; skip_auto_book?: boolean }
const file: Capability<FileIn, { status: 'added' | 'duplicate'; invoice_id?: string }> = {
  id: 'invoice.file', revision:2, name: '发票入库（待审）', impl: 'script', effect: 'ingest', roles: ['admin','finance','manager','staff','service'],
  async run(input, ctx) {
    const { item, extract } = input;
    if (!item || !extract?.fields) throw new Error('抽取步骤均未产出有效字段，或缺少文件来源信息');
    const { invoice_code, invoice_no } = extract.fields;
    // 去重：数电发票无代码（代码为空），按发票号码查重；纸质发票代码+号码都有则用组合键。
    // （原逻辑要求 code&&no 同时存在才查，数电直接跳过 → 网络抖动重投会进第二张）
    const dupKey = invoice_code && invoice_no ? { invoice_code, invoice_no } : (invoice_no ? { invoice_no } : null);
    if (dupKey) {
      const dup = await ctx.store.query('business', 'invoices', dupKey);
      if (dup.length) {
        ctx.log(`↻ 重复发票，跳过：${invoice_no}`);
        return { status: 'duplicate' };
      }
    }
    const now = new Date().toISOString();
    const id = await ctx.store.insert('business', 'invoices', {
      ...extract.fields,
      ...(invoice_no ? {id: `invoice:${invoice_code || ''}:${invoice_no}`} : {}),
      invoice_direction: '进项',   // 进项=收到的采购/费用发票（OCR 无法判定方向，默认进项，审核时可改出项）
      status: '待审',
      source: item.source ?? 'email',
      submitted_by:ctx.actor?.id || '',
      sender_email: item.sender_email,
      email_subject: item.email_subject,
      received_at: item.received_at,
      file_token: item.file_token,
      confidence: extract.confidence,
      validation_warnings: extract.validation_warnings,
      // 原始识别留档：OCR 当场的完整输出（字段+置信度+原文+provider/model+时间）。
      // 人工审核改字段不改这份，事后可追溯「识别错 vs 人工改」——此前无留档导致错账无法归因。
      raw_extract: {
        fields: extract.fields,
        confidence: extract.confidence,
        validation_warnings: extract.validation_warnings,
        raw_text: extract.raw_text,
        ocr_path: extract.ocr_path || '',
        provider: ctx.config.ocr.provider,
        model: ctx.config.ocr.model,
        at: now,
      },
      reviewer: null, reviewed_at: null, review_note: '',
      created_at: now, updated_at: now,
    });
    // 关联本地附件 → 飞书记录 id（待审期本地预览；审核「上传」时再传飞书）
    await attachLocal(id, { token: item.file_token, filename: item.filename, mime: item.mime }, ctx.store);
    // R3-4：收票即留痕——责任链覆盖「收票→审核→入账」全链（此前收票无事件）
    await appendEvent(ctx.store, {
      capability: 'invoice.ingest',
      entity_type: 'invoice', entity_id: id,
      payload: { invoice_no, invoice_code, amount: extract.fields.total_amount || 0, confidence: extract.confidence, source: item.source ?? 'email' },
      initiator: item.source === 'upload' ? 'user' : 'trigger',
      status: 'confirmed',
    });
    // 自动入账已退役：抽取结果不能成为财务授权。审核/入账必须经动作契约与人工确认。

    return { status: 'added', invoice_id: id };
  },
};

export function registerInvoiceCapabilities() {
  registerCapability(collect);
  registerCapability(extract);
  registerCapability(file);
}
