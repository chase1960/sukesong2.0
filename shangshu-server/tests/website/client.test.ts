import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('官网 API client', () => {
  let dir: string; let upstream: Server; let port: number; let seenKey: string | undefined;

  beforeEach(async () => {
    seenKey = undefined;
    dir = mkdtempSync(join(tmpdir(), 'ss-client-'));
    process.env._SS_DATA_DIR = dir;
    upstream = createServer((req, res) => {
      seenKey = req.headers['x-api-key'] as string | undefined;
      if (req.url === '/api/protected' && seenKey !== 'yk_test_key') {
        res.writeHead(401).end('{"error":"缺少 API Key"}'); return;
      }
      if (req.url === '/api/forbidden') {
        res.writeHead(403).end('{"error":"禁止访问"}'); return;
      }
      if (req.url === '/api/error') {
        res.writeHead(500).end('{"error":"内部错误"}'); return;
      }
      if (req.url === '/api/not-json') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('not json'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>(r => { upstream = upstream.listen(0, () => { port = (upstream.address() as any).port; r(); }); });
  });
  afterEach(() => {
    upstream.close();
    delete process.env._SS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeCfg(apiKey: string) {
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      website: { base_url: `http://127.0.0.1:${port}`, api_key: apiKey, panel_path: 'p', panel_key: '' },
    }));
  }

  it('未配置 key → NOT_CONFIGURED', async () => {
    await writeCfg('');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/x'), (e: any) => e.kind === 'NOT_CONFIGURED');
  });

  it('正常请求带 x-api-key', async () => {
    await writeCfg('yk_test_key');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    const data = await websiteApi('GET', '/api/protected');
    assert.deepEqual(data, { ok: true });
    assert.equal(seenKey, 'yk_test_key');
  });

  it('上游 401 → UNAUTHORIZED', async () => {
    await writeCfg('wrong');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/protected'), (e: any) => e.kind === 'UNAUTHORIZED' && e.status === 401);
  });

  it('上游 403 → UNAUTHORIZED', async () => {
    await writeCfg('yk_test_key');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/forbidden'), (e: any) => e.kind === 'UNAUTHORIZED' && e.status === 403);
  });

  it('上游 500 → UPSTREAM', async () => {
    await writeCfg('yk_test_key');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/error'), (e: any) => e.kind === 'UPSTREAM' && e.status === 500);
  });

  it('上游 200 但非 JSON → UPSTREAM', async () => {
    await writeCfg('yk_test_key');
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/not-json'), (e: any) => e.kind === 'UPSTREAM' && e.status === 200);
  });

  it('上游不可达 → OFFLINE', async () => {
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      website: { base_url: 'http://127.0.0.1:1', api_key: 'k', panel_path: 'p', panel_key: '' },
    }));
    const { websiteApi } = await import('../../src/custom/yinling-website/backend/client.ts');
    await assert.rejects(websiteApi('GET', '/api/x'), (e: any) => e.kind === 'OFFLINE');
  });
});
