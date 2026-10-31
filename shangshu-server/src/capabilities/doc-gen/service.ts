// doc-gen CRUD 服务：模板集 / 文档类型 / 生成记录
import { randomUUID } from 'node:crypto';
import type { Context } from '../../core/types.ts';
import type { TemplateSet, DocumentType, DocGenRun } from './types.ts';

const LAYER = 'process';
const TABLES = {
  template_sets: 'template_sets',
  doc_types: 'doc_types',
  doc_gen_runs: 'doc_gen_runs',
} as const;

export class DocGenService {
  constructor(private ctx: Context) {}

  // —— 模板集 ——

  async listTemplateSets(): Promise<TemplateSet[]> {
    return this.ctx.store.query(LAYER, TABLES.template_sets);
  }

  async createTemplateSet(input: {
    name: string;
    description: string;
    status: 'draft' | 'pending_review' | 'active' | 'archived';
    created_by: string;
  }): Promise<TemplateSet> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record = {
      id,
      ...input,
      created_at: now,
      updated_at: now,
    };
    await this.ctx.store.insert(LAYER, TABLES.template_sets, record);
    return record;
  }

  async getTemplateSet(id: string): Promise<TemplateSet | null> {
    const rows = await this.ctx.store.query(LAYER, TABLES.template_sets, { id });
    return rows[0] ?? null;
  }

  // —— 文档类型 ——

  async createDocumentType(input: {
    template_set_id: string;
    doc_key: string;
    name: string;
    description: string;
    template_file_token: string;
    field_schema: DocumentType['field_schema'];
    validation_rules?: Record<string, any>;
  }): Promise<DocumentType> {
    const id = randomUUID();
    const record = { id, ...input };
    await this.ctx.store.insert(LAYER, TABLES.doc_types, record);
    return record;
  }

  async listDocumentTypes(templateSetId?: string): Promise<DocumentType[]> {
    const filter = templateSetId ? { template_set_id: templateSetId } : undefined;
    return this.ctx.store.query(LAYER, TABLES.doc_types, filter);
  }

  async getDocumentType(id: string): Promise<DocumentType | null> {
    const rows = await this.ctx.store.query(LAYER, TABLES.doc_types, { id });
    return rows[0] ?? null;
  }

  async updateDocumentType(id: string, patch: Partial<DocumentType>): Promise<void> {
    await this.ctx.store.update(LAYER, TABLES.doc_types, id, patch);
  }

  // —— 生成记录 ——

  async createRun(input: {
    doc_type_id: string;
    fields_snapshot: Record<string, any>;
    output_file_token: string;
    status: 'generating' | 'success' | 'failed';
    generated_by: 'form' | 'ai';
  }): Promise<DocGenRun> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      ...input,
      error_message: undefined,
      created_at: now,
    };
    await this.ctx.store.insert(LAYER, TABLES.doc_gen_runs, record);
    return record;
  }

  async updateRun(id: string, patch: Partial<DocGenRun>): Promise<void> {
    await this.ctx.store.update(LAYER, TABLES.doc_gen_runs, id, patch);
  }

  async getRun(id: string): Promise<DocGenRun | null> {
    const rows = await this.ctx.store.query(LAYER, TABLES.doc_gen_runs, { id });
    return rows[0] ?? null;
  }
}
