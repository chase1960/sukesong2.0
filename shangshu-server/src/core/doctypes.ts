// 单据模板（DocType）：非结构化文件 → 对象字段的抽取说明书。
// 收票/对账单同一机制；旧 Node 设计背景见 docs/research/legacy-data-and-metadata.md §6

export interface DocFieldMapping {
  source?: string;
  /** DocType 槽位 → ObjectType 字段 id */
  target: string;
  required?: boolean;
}

export interface DocType {
  revision?: number;
  id: string;
  name: string;
  description: string;
  /** 抽取结果写入的目标对象 */
  objectId: string;
  /** 默认办事流程 id（收票/upload 入口） */
  intakeFlowId: string;
  fieldMappings: DocFieldMapping[];
  /** 支持的 MIME / 扩展名提示 */
  accept?: string[];
}

export function mapDocumentFields(doctypeId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const dt = getDocType(doctypeId);
  if (!dt) throw new Error(`未知单据模板: ${doctypeId}`);
  const output: Record<string, unknown> = {};
  for (const mapping of dt.fieldMappings) {
    const value = fields[mapping.source || mapping.target];
    if (mapping.required && (value === undefined || value === null || value === '')) throw new Error(`单据缺少必填字段: ${mapping.target}`);
    if (value !== undefined) output[mapping.target] = value;
  }
  return output;
}

const DOCTYPES = new Map<string, DocType>();

export function clearDocTypes(): void {
  DOCTYPES.clear();
}

export function registerDocType(dt: DocType): void {
  if (!dt.id || !dt.objectId) throw new Error('DocType 需 id / objectId');
  DOCTYPES.set(dt.id, structuredClone(dt));
}

export function getDocType(id: string): DocType | undefined {
  const doc = DOCTYPES.get(id);
  return doc && structuredClone(doc);
}

export function listDocTypes() {
  return [...DOCTYPES.values()].map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    object_id: d.objectId,
    intake_flow_id: d.intakeFlowId,
    field_mappings: d.fieldMappings,
    accept: d.accept || [],
  }));
}

/** 小微预置单据模板 */
export function getPresetDocTypes(): DocType[] {
  return [{
    id: 'invoice_cn_vat',
    name: '增值税发票',
    description: '进项/出项发票 PDF 或图片；抽取后进待审',
    objectId: 'invoice',
    intakeFlowId: 'flow.invoice-intake',
    accept: ['application/pdf', 'image/png', 'image/jpeg'],
    fieldMappings: [
      { target: 'invoice_code', required: false },
      { target: 'invoice_no', required: true },
      { target: 'invoice_type' },
      { target: 'seller_name', required: true },
      { target: 'buyer_name' },
      { target: 'amount_ex_tax' },
      { target: 'tax_amount' },
      { target: 'total_amount', required: true },
      { target: 'issued_at' },
      { target: 'check_code' },
    ],
  }];
}

export function registerPresetDocTypes(): void {
  for (const dt of getPresetDocTypes()) registerDocType(dt);
}
