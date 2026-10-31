import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MailSource, OcrService, ExternalServices, RuntimeConfig, OcrExtractResult } from '../../src/core/types.ts';
import { ExternalServiceManager } from '../../src/core/infra/external.ts';

// —— 测试用 mock ——
const mockMail: MailSource = {
  async listUnread() { return []; },
  async fetchAttachment() { return { filename: 'mock.pdf', mime: 'application/pdf', bytes: Buffer.from('') }; },
  async markRead() {},
};

const mockOcr: OcrService = {
  async start() {},
  async extract(): Promise<OcrExtractResult> {
    return { fields: {}, confidence: 0, validation_warnings: {}, raw_text: '' };
  },
  stop() {},
};

const stubConfig: RuntimeConfig = {
  server: { port: 3000, admin_password: 'admin' },
  poll: { cron: '*/10 * * * *', mailbox: '' },
  store: { provider: 'local' },
  mail: { provider: 'folder', folder: '/tmp/test-inbox', agently_mailbox: '' },
  file: { provider: 'local', local_dir: '/tmp/test-files', drive_folder_token: '' },
  feishu: { app_id: '', app_secret: '', bitable_app_token: '', invoices_table_id: 'business__invoices' },
  ocr: { endpoint_url: 'http://127.0.0.1:8001', provider: 'mock', api_key: '', base_url: '', model: '' },
  website: { base_url: '', api_key: '', panel_path: '', panel_key: '' },
};

describe('ExternalServiceManager', () => {
  it('creates default mail and ocr when no deps provided', () => {
    const mgr = new ExternalServiceManager(stubConfig);
    assert.ok(mgr.mail, 'mail should be created');
    assert.ok(mgr.ocr, 'ocr should be created');
    assert.equal(typeof mgr.mail.listUnread, 'function');
    assert.equal(typeof mgr.ocr.extract, 'function');
  });

  it('uses injected deps instead of defaults', () => {
    const customMail: MailSource = {
      async listUnread() { return [{ id: 'custom', from: 'test', subject: 'custom', received_at: '', attachment_id: '' }]; },
      async fetchAttachment() { throw new Error('should not be called'); },
      async markRead() {},
    };
    const customOcr: OcrService = {
      async start() {},
      async extract() {
        return { fields: { seller: 'ACME' }, confidence: 1, validation_warnings: {}, raw_text: 'ACME' };
      },
      stop() {},
    };

    const mgr = new ExternalServiceManager(stubConfig, { mail: customMail, ocr: customOcr });
    assert.equal(mgr.mail, customMail, 'should use injected mail');
    assert.equal(mgr.ocr, customOcr, 'should use injected ocr');
  });

  it('stop delegates to ocr.stop()', () => {
    let stopped = false;
    const ocr: OcrService = {
      async start() {},
      async extract() { return { fields: {}, confidence: 0, validation_warnings: {}, raw_text: '' }; },
      stop() { stopped = true; },
    };
    const mgr = new ExternalServiceManager(stubConfig, { ocr });
    mgr.stop();
    assert.ok(stopped, 'ocr.stop() should be called');
  });

  it('start delegates to ocr.start()', async () => {
    let started = false;
    const ocr: OcrService = {
      async start() { started = true; },
      async extract() { return { fields: {}, confidence: 0, validation_warnings: {}, raw_text: '' }; },
      stop() {},
    };
    const mgr = new ExternalServiceManager(stubConfig, { ocr });
    await mgr.start();
    assert.ok(started, 'ocr.start() should be called');
  });

  it('ExternalServices shape matches Context expectation', () => {
    const mgr = new ExternalServiceManager(stubConfig);
    const ext: ExternalServices = mgr;
    // Verify the shape is compatible with what Context expects
    assert.equal(typeof ext.mail.listUnread, 'function');
    assert.equal(typeof ext.mail.fetchAttachment, 'function');
    assert.equal(typeof ext.mail.markRead, 'function');
    assert.equal(typeof ext.ocr.start, 'function');
    assert.equal(typeof ext.ocr.extract, 'function');
    assert.equal(typeof ext.ocr.stop, 'function');
  });
});
