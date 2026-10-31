import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('/api/website 转发', () => {
  let dir: string; let upstream: Server; let server: Server; let uport: number; let port: number; let cookie: string;
  let lastUrl: string = ''; let lastMethod: string = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-routes-'));
    process.env._SS_DATA_DIR = dir;
    upstream = createServer((req, res) => {
      lastUrl = req.url || ''; lastMethod = req.method || '';
      if (lastUrl === '/api/stats/daily') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ visits: {}, uniqueVisitors: {}, submissions: {} }));
        return;
      }
      if (lastUrl === '/api/contact/messages') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
        return;
      }
      if (lastUrl === '/api/ai/submissions') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ status: 'pending' }, { status: 'approved' }]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"echo":true}');
    });
    await new Promise<void>(r => { upstream = upstream.listen(0, () => { uport = (upstream.address() as any).port; r(); }); });
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      website: { base_url: `http://127.0.0.1:${uport}`, api_key: 'yk_test', panel_path: 'p', panel_key: '' },
    }));
    const { registerRoute } = await import('../../src/core/registry.ts');
    const { websiteRouter } = await import('../../src/custom/yinling-website/backend/routes.ts');
    registerRoute('/api/website', websiteRouter());
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { upstream.close(); server.close(); });

  it('GET /api/website/stats/daily → /api/stats/daily', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/website/stats/daily`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(lastUrl, '/api/stats/daily');
  });

  it('funnel 透传 period', async () => {
    await fetch(`http://127.0.0.1:${port}/api/website/funnel?period=week`, { headers: { cookie } });
    assert.equal(lastUrl, '/api/stats/funnel?period=week');
  });

  it('approve 转发为 PUT /api/ai/submissions/:id/approve', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/website/submissions/42/approve`, {
      method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(lastMethod, 'PUT');
    assert.equal(lastUrl, '/api/ai/submissions/42/approve');
  });

  it('未登录 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/website/stats/daily`);
    assert.equal(res.status, 401);
  });

  it('overview 聚合今日数字与待审批数', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/website/overview`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const data = await res.json();
    for (const k of ['todayVisits', 'todayUnique', 'todaySubmissions', 'yesterdayVisits', 'todayMessages', 'pendingCount']) {
      assert.equal(typeof data[k], 'number', k);
    }
    assert.equal(data.pendingCount, 1);
  });
});
