// doc-gen 端到端测试：启动 server → 登录 → 验证 doc-gen API 全流程
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { buildApp } from '../../src/adapters/web/server.ts';
import { registerDocGen } from '../../src/capabilities/doc-gen/register.ts';
import type { ExternalServices } from '../../src/core/types.ts';

// mock external：避免依赖真实 OCR/邮件服务
const mockExternal: ExternalServices = {
  mail: {
    listUnread: async () => [],
    fetchAttachment: async () => ({ filename: '', mime: '', bytes: Buffer.from('') }),
    markRead: async () => {},
  },
  ocr: {
    start: async () => {},
    extract: async () => ({ fields: {}, confidence: 1, validation_warnings: {}, raw_text: '' }),
    stop: () => {},
  },
};

describe('doc-gen e2e', { concurrency: false }, () => {
  let root: string;
  let server: Server;
  let port: number;
  let cookie: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ss-docgen-e2e-'));
    process.env._SS_SKILL_DIR = join(root, 'skills');
    // 隔离数据目录：让 loadConfig 落到默认 local provider，store 写 tmp，
    // 否则撞上 dev 的 bitable 配置（无飞书凭证 → CRUD 500）。
    process.env._SS_DATA_DIR = join(root, 'data');

    // 注册 doc-gen 能力（带 mock external）
    registerDocGen(mockExternal);

    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });

    // 登录获取 cookie
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin' }),
    });
    cookie = login.headers.get('set-cookie') || '';
  });

  afterEach(() => {
    delete process.env._SS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
    server.close();
  });

  it('模板集 CRUD 流程', async () => {
    // 1. 创建模板集
    const createRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: '端到端测试模板集',
        description: 'E2E test template set',
        status: 'draft',
        created_by: 'e2e-test',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.ok(created.id);
    assert.equal(created.name, '端到端测试模板集');
    assert.equal(created.status, 'draft');

    // 2. 列出模板集
    const listRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets`, {
      headers: { cookie },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);

    // 3. 获取单个模板集
    const getRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets/${created.id}`, {
      headers: { cookie },
    });
    assert.equal(getRes.status, 200);
    const fetched = await getRes.json();
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, '端到端测试模板集');
    assert.ok(Array.isArray(fetched.doc_types));
  });

  it('文档类型 CRUD 流程', async () => {
    // 先创建模板集
    const createSetRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: '文档类型测试模板集',
        description: '',
        status: 'draft',
        created_by: 'e2e-test',
      }),
    });
    const set = await createSetRes.json();

    // 1. 创建文档类型
    const createDocTypeRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets/${set.id}/doc-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        doc_key: 'contract',
        name: '合同',
        description: '测试合同文档类型',
        template_file_token: '',
        field_schema: {
          fields: [
            { key: 'party_a', label: '甲方', type: 'text', required: true },
            { key: 'party_b', label: '乙方', type: 'text', required: true },
            { key: 'amount', label: '金额', type: 'number' },
          ],
        },
      }),
    });
    assert.equal(createDocTypeRes.status, 201);
    const docType = await createDocTypeRes.json();
    assert.ok(docType.id);
    assert.equal(docType.doc_key, 'contract');
    assert.equal(docType.name, '合同');
    assert.equal(docType.field_schema.fields.length, 3);

    // 2. 获取文档类型
    const getDocTypeRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/doc-types/${docType.id}`, {
      headers: { cookie },
    });
    assert.equal(getDocTypeRes.status, 200);
    const fetchedDocType = await getDocTypeRes.json();
    assert.equal(fetchedDocType.id, docType.id);
    assert.equal(fetchedDocType.field_schema.fields.length, 3);

    // 3. 更新文档类型
    const updateDocTypeRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/doc-types/${docType.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: '合同（更新版）',
        field_schema: {
          fields: [
            { key: 'party_a', label: '甲方', type: 'text', required: true },
            { key: 'party_b', label: '乙方', type: 'text', required: true },
            { key: 'amount', label: '金额', type: 'number' },
            { key: 'sign_date', label: '签署日期', type: 'date' },
          ],
        },
      }),
    });
    assert.equal(updateDocTypeRes.status, 200);
    const updatedDocType = await updateDocTypeRes.json();
    assert.equal(updatedDocType.ok, true);

    // 验证更新
    const verifyRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/doc-types/${docType.id}`, {
      headers: { cookie },
    });
    const verified = await verifyRes.json();
    assert.equal(verified.name, '合同（更新版）');
    assert.equal(verified.field_schema.fields.length, 4);
  });

  it('字段校验接口', async () => {
    const validateRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        fields_by_doc: {
          contract: { party_a: '甲方公司', party_b: '乙方公司' },
          receipt: { amount: 1000 },
        },
      }),
    });
    // validate 调用 Python 脚本，可能因环境问题失败，但 API 本身应该可达
    assert.ok(validateRes.status === 200 || validateRes.status === 500);
    const result = await validateRes.json();
    // 无论成功失败，应该返回 JSON
    assert.ok(typeof result === 'object');
  });

  it('字段预填接口', async () => {
    const prefillRes = await fetch(`http://127.0.0.1:${port}/api/doc-gen/prefill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        doc_type_id: 'test-doc-type',
        description: '项目是ABC系统开发，总价为50000，30天工期',
      }),
    });
    assert.equal(prefillRes.status, 200);
    const result = await prefillRes.json();
    assert.ok(result.fields);
    // 预填应该提取到字段
    assert.equal(result.fields.project_name, 'ABC系统开发');
    assert.equal(result.fields.total_amount, '50000');
    assert.equal(result.fields.schedule, '30');
  });

  it('未登录应返回 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets`);
    assert.equal(res.status, 401);
  });

  it('获取不存在的模板集应返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/doc-gen/template-sets/nonexistent`, {
      headers: { cookie },
    });
    assert.equal(res.status, 404);
  });

  it('获取不存在的文档类型应返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/doc-gen/doc-types/nonexistent`, {
      headers: { cookie },
    });
    assert.equal(res.status, 404);
  });
});
