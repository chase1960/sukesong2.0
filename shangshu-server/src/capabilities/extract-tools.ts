// 抽取工具化（M3）：text-rule / text-llm / vision 独立 registry 能力，办事流程可逐步留痕。
import { registerCapability } from '../core/registry.ts';
import { getDocType, mapDocumentFields } from '../core/doctypes.ts';
import type { Capability, Context } from '../core/types.ts';

export const EXTRACT_PATHS = ['text-rule', 'text-llm', 'vision'] as const;
export type ExtractPath = typeof EXTRACT_PATHS[number];

const TOOL_LABELS: Record<string, string> = {
  'text-rule': 'PDF 文字层解析',
  'text-llm': '文字层 + 模型结构化',
  vision: '多模态看图',
  mock: '演示 mock',
};

function mapExtractPath(ocrPath: string): { extraction_path: string; tool_used: string } {
  const p = ocrPath || 'unknown';
  return { extraction_path: p, tool_used: TOOL_LABELS[p] || p };
}

function hasExtractFields(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  return Object.keys(fields).length > 0;
}

async function runOcrPath(
  ctx: Context,
  fileToken: string,
  forcePath: ExtractPath,
): Promise<{
  fields: Record<string, unknown>;
  confidence: number;
  validation_warnings: Record<string, string>;
  raw_text: string;
  ocr_path: string;
}> {
  const f = await ctx.file.read(fileToken);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name);
  const o = ctx.config.ocr;
  form.append('provider', o.provider);
  form.append('expected_buyer',ctx.config.enterprise?.name || '');
  form.append('force_path', forcePath);
  if (o.api_key) form.append('api_key', o.api_key);
  if (o.base_url) form.append('base_url', o.base_url);
  if (o.model) form.append('model', o.model);
  const data = await ctx.external.ocr.extract(form) as {
    fields: Record<string, unknown>;
    confidence: number;
    validation_warnings: Record<string, string>;
    raw_text: string;
    ocr_path?: string;
  };
  if (!hasExtractFields(data.fields)) {
    throw new Error(`${forcePath} 未识别出有效字段`);
  }
  return {
    ...data,
    ocr_path: String(data.ocr_path || forcePath),
  };
}

function formatDocExtractOutput(
  doctypeId: string,
  raw: Awaited<ReturnType<typeof runOcrPath>>,
): Record<string, unknown> {
  const dt = getDocType(doctypeId);
  const data = mapDocumentFields(doctypeId, raw.fields);
  const { extraction_path, tool_used } = mapExtractPath(raw.ocr_path);
  const warnings = raw.validation_warnings || {};
  return {
    doctype: doctypeId,
    object_id: dt?.objectId || 'invoice',
    fields: raw.fields,
    data,
    validation_warnings: warnings,
    raw_text: raw.raw_text,
    extraction_path,
    tool_used,
    ocr_path: extraction_path,
    confidence: raw.confidence,
    attribution: `${tool_used}（${extraction_path}）`,
  };
}

type ExtractIn = { file_token: string; doctype?: string };

function makeExtractCapability(path: ExtractPath, id: string, name: string): Capability<ExtractIn, Record<string, unknown>> {
  return {
    id,
    revision:2,
    name,
    impl: 'external', effect: 'extract', roles: ['admin','finance','manager','staff','service'],
    async run(input, ctx) {
      const fileToken = String(input.file_token || '').trim();
      if (!fileToken) throw new Error('file_token 必填');
      const doctypeId = String(input.doctype || 'invoice_cn_vat').trim();
      if (!getDocType(doctypeId)) throw new Error(`未知单据模板: ${doctypeId}`);
      const raw = await runOcrPath(ctx, fileToken, path);
      const { tool_used } = mapExtractPath(raw.ocr_path);
      ctx.log(`⌕ ${id} [${doctypeId}] ${tool_used}`);
      return formatDocExtractOutput(doctypeId, raw);
    },
  };
}

/** doc.extract / 流程外：按路径级联，返回首个成功结果 */
export async function cascadeDocExtract(
  ctx: Context,
  input: ExtractIn,
): Promise<Record<string, unknown>> {
  const fileToken = String(input.file_token || '').trim();
  if (!fileToken) throw new Error('file_token 必填');
  const doctypeId = String(input.doctype || 'invoice_cn_vat').trim();
  if (!getDocType(doctypeId)) throw new Error(`未知单据模板: ${doctypeId}`);

  const errors: string[] = [];
  for (const path of EXTRACT_PATHS) {
    try {
      const raw = await runOcrPath(ctx, fileToken, path);
      const out = formatDocExtractOutput(doctypeId, raw);
      const { tool_used } = mapExtractPath(raw.ocr_path);
      ctx.log(`⌕ doc.extract [${doctypeId}] ${tool_used} · ${(out.fields as any)?.seller_name || '未知'} ¥${(out.fields as any)?.total_amount || 0}`);
      const warnList = Object.entries(raw.validation_warnings || {}).map(([k, v]) => `${k}: ${v}`);
      if (warnList.length) ctx.log(`⚠ 字段警告：${warnList.join('；')}`);
      return out;
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  throw new Error(`抽取失败：${errors.join('；')}`);
}

const extractCapabilities = [
  makeExtractCapability('text-rule','extract.text_rule','PDF 文字层解析'),
  makeExtractCapability('text-llm','extract.text_llm','文字层模型结构化'),
  makeExtractCapability('vision','extract.vision','多模态看图抽取'),
];
export function registerExtractTools(): void { for (const cap of extractCapabilities) registerCapability(cap); }

export function extractOutputValid(extract: unknown): boolean {
  const f = (extract as any)?.fields;
  return hasExtractFields(f);
}
