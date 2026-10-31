import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DocGenService } from '../../../src/capabilities/doc-gen/service.ts';
import { buildContext } from '../../../src/core/context.ts';
import type { ExternalServices } from '../../../src/core/types.ts';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockExternal: ExternalServices = {
  mail: { listUnread: async () => [], fetchAttachment: async () => ({ filename: '', mime: '', bytes: Buffer.from('') }), markRead: async () => {} },
  ocr: { start: async () => {}, extract: async () => ({ fields: {}, confidence: 1, validation_warnings: {}, raw_text: '' }), stop: () => {} },
};

describe('DocGenService', () => {
  let root: string;

  // 隔离数据目录：让 loadConfig 落到默认 local provider（无 runtime_config.json），
  // store 也写到 tmp。否则会撞上 dev 环境的 bitable 配置（无飞书凭证 → CRUD 500）。
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ss-docgen-svc-'));
    process.env._SS_DATA_DIR = join(root, 'data');
  });
  afterEach(() => {
    delete process.env._SS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('应该创建模板集', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const set = await svc.createTemplateSet({
      name: '测试模板集',
      description: '',
      status: 'draft',
      created_by: 'test',
    });
    assert.strictEqual(set.name, '测试模板集');
    assert.ok(set.id);
  });

  it('应该列出模板集', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    await svc.createTemplateSet({
      name: '列表测试模板集',
      description: '',
      status: 'draft',
      created_by: 'test',
    });
    const sets = await svc.listTemplateSets();
    assert.ok(Array.isArray(sets));
    assert.ok(sets.length > 0);
  });

  it('应该获取模板集', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const created = await svc.createTemplateSet({
      name: '获取测试模板集',
      description: 'desc',
      status: 'active',
      created_by: 'test',
    });
    const fetched = await svc.getTemplateSet(created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.name, '获取测试模板集');
    assert.strictEqual(fetched.status, 'active');
  });

  it('应该创建文档类型', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const set = await svc.createTemplateSet({
      name: '文档类型测试',
      description: '',
      status: 'draft',
      created_by: 'test',
    });
    const docType = await svc.createDocumentType({
      template_set_id: set.id,
      doc_key: 'contract',
      name: '合同',
      description: '',
      template_file_token: 'token-123',
      field_schema: { fields: [] },
    });
    assert.strictEqual(docType.doc_key, 'contract');
    assert.ok(docType.id);
  });

  it('应该列出文档类型', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const set = await svc.createTemplateSet({
      name: '列表文档类型测试',
      description: '',
      status: 'draft',
      created_by: 'test',
    });
    await svc.createDocumentType({
      template_set_id: set.id,
      doc_key: 'test',
      name: '测试文档',
      description: '',
      template_file_token: '',
      field_schema: { fields: [] },
    });
    const docTypes = await svc.listDocumentTypes(set.id);
    assert.ok(Array.isArray(docTypes));
    assert.ok(docTypes.length > 0);
  });

  it('应该更新文档类型', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const set = await svc.createTemplateSet({
      name: '更新文档类型测试',
      description: '',
      status: 'draft',
      created_by: 'test',
    });
    const docType = await svc.createDocumentType({
      template_set_id: set.id,
      doc_key: 'test',
      name: '测试文档',
      description: '',
      template_file_token: '',
      field_schema: { fields: [] },
    });
    await svc.updateDocumentType(docType.id, {
      name: '更新后的文档',
      field_schema: { fields: [{ key: 'name', label: '名称', type: 'text' }] },
    });
    const updated = await svc.getDocumentType(docType.id);
    assert.ok(updated);
    assert.strictEqual(updated.name, '更新后的文档');
    assert.strictEqual(updated.field_schema.fields.length, 1);
  });

  it('应该创建生成记录', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const run = await svc.createRun({
      doc_type_id: 'test-doc-type',
      fields_snapshot: { name: 'test' },
      output_file_token: '',
      status: 'generating',
      generated_by: 'form',
    });
    assert.ok(run.id);
    assert.strictEqual(run.status, 'generating');
    assert.strictEqual(run.doc_type_id, 'test-doc-type');
  });

  it('应该更新生成记录', async () => {
    const ctx = buildContext(() => {}, { external: mockExternal });
    const svc = new DocGenService(ctx);
    const run = await svc.createRun({
      doc_type_id: 'test-doc-type',
      fields_snapshot: {},
      output_file_token: '',
      status: 'generating',
      generated_by: 'form',
    });
    await svc.updateRun(run.id, {
      status: 'success',
      output_file_token: 'output-token',
    });
    const updated = await svc.getRun(run.id);
    assert.ok(updated);
    assert.strictEqual(updated.status, 'success');
    assert.strictEqual(updated.output_file_token, 'output-token');
  });
});
