import { testActor, testContext } from '../helpers/actor.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCapability } from '../../src/core/registry.ts';
import { buildContext } from '../../src/core/context.ts';
import { registerInvoiceCapabilities } from '../../src/capabilities/invoice.ts';
import type { ExternalServices } from '../../src/core/types.ts';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 确保能力已注册
registerInvoiceCapabilities();

// 创建临时文件供 ctx.file.read 使用
const TEST_DATA_DIR = process.env._SS_DATA_DIR || join(import.meta.dirname!, '..', '..', 'data');
const TEST_FILE_TOKEN = 'fake-token';
const TEST_FILE_PATH = join(TEST_DATA_DIR, 'files', TEST_FILE_TOKEN);

describe('invoice.extract', () => {
  it('应该作为 external 能力注册', () => {
    const cap = getCapability('invoice.extract');
    assert.strictEqual(cap.impl, 'external');
  });

  it('应该通过 ctx.external.ocr 抽取发票', async () => {
    // 准备临时文件
    if (!existsSync(join(TEST_DATA_DIR, 'files'))) mkdirSync(join(TEST_DATA_DIR, 'files'), { recursive: true });
    writeFileSync(TEST_FILE_PATH, Buffer.from('fake pdf content'));

    try {
      const mockExternal: ExternalServices = {
        mail: { listUnread: async () => [], fetchAttachment: async () => ({ filename: '', mime: '', bytes: Buffer.from('') }), markRead: async () => {} },
        ocr: {
          start: async () => {},
          extract: async () => ({
            fields: { seller_name: '测试公司', total_amount: 100 },
            confidence: 0.95,
            validation_warnings: {},
            raw_text: 'test',
          }),
          stop: () => {},
        },
      };
      const ctx = testContext(buildContext(() => {}, { external: mockExternal }));
      const cap = getCapability('invoice.extract');
      const result = await cap.run({ file_token: TEST_FILE_TOKEN }, ctx);
      assert.strictEqual(result.fields.seller_name, '测试公司');
    } finally {
      // 清理临时文件
      if (existsSync(TEST_FILE_PATH)) rmSync(TEST_FILE_PATH);
    }
  });
});
