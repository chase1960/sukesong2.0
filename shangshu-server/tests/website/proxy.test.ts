import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('官网后台反代', () => {
  let dir: string; let upstream: Server; let server: Server;
  let uport: number; let port: number; let cookie: string;
  let upstreamUrl: string = ''; let upstreamQuery: string = '';
  let upstreamHeaders: Record<string, string | string[] | undefined> = {};

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-proxy-'));
    process.env._SS_DATA_DIR = dir;
    upstreamUrl = ''; upstreamQuery = '';
    upstreamHeaders = {};

    upstream = createServer((req, res) => {
      upstreamUrl = req.url || '';
      upstreamQuery = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      upstreamHeaders = req.headers;

      if (req.url?.startsWith('/panel-x')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Frame-Options': 'DENY',
          'ETag': 'W/"panel-x-v1"',
          'Last-Modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        }).end('<html><head><title>p</title></head><body>admin</body></html>');
        return;
      }
      if (req.url === '/api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/uploads/a.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      res.writeHead(404).end('not found');
    });
    await new Promise<void>(r => { upstream = upstream.listen(0, () => { uport = (upstream.address() as any).port; r(); }); });

    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      website: {
        base_url: `http://127.0.0.1:${uport}`,
        api_key: 'yk_api_test',
        panel_path: 'panel-x',
        panel_key: 'yk_gate_test',
      },
    }));

    const { registerRoute } = await import('../../src/core/registry.ts');
    const { websiteAdminProxy, websiteApiProxy, websiteUploadsProxy } =
      await import('../../src/custom/yinling-website/backend/proxy.ts');

    registerRoute('/website-admin', websiteAdminProxy());
    registerRoute('/website-api', websiteApiProxy());
    registerRoute('/website-uploads', websiteUploadsProxy());

    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });

  afterEach(() => {
    upstream.close();
    server.close();
    delete process.env._SS_DATA_DIR;
  });

  it('HTML 注入 theme 与钩子，剥 XFO，key 服务端注入', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/website-admin/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), null);
    const html = await res.text();
    assert.ok(html.includes('/website-admin/theme.css'));
    assert.ok(html.includes('/website-api/'));
    assert.ok(upstreamQuery.includes('key=yk_gate_test'));
    assert.ok(!html.includes('yk_gate_test'));
  });

  it('注入 HTML 禁缓存：剥 etag/last-modified 并设 no-store（防钩子更新后被浏览器 304 命中旧页面）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/website-admin/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const cc = res.headers.get('cache-control') || '';
    assert.ok(cc.includes('no-store'), `cache-control 应含 no-store，实际: ${cc}`);
    assert.notEqual(res.headers.get('etag'), 'W/"panel-x-v1"', '上游固定 etag 不得透传（否则浏览器命中旧页面）；express 按注入后内容另算的 etag 可接受');
    assert.equal(res.headers.get('last-modified'), null, 'last-modified 应被剥除');
  });

  it('/website-api 带 key 转发', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/website-api/info`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type')?.toLowerCase().includes('application/json'), true);
    const data = await res.json();
    assert.deepEqual(data, { ok: true });
    assert.equal(upstreamUrl, '/api/info');
    assert.equal(upstreamHeaders['x-api-key'], 'yk_api_test');
  });

  it('/website-uploads 透传字节与 content-type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/website-uploads/a.png`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('image/png'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.toString('hex'), '89504e47');
    assert.equal(upstreamUrl, '/uploads/a.png');
  });

  it('未登录 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/website-admin/`);
    assert.equal(res.status, 401);
  });
});

describe('rewriteUrl 嵌入路径改写', () => {
  // 官网后台 admin.html 用 `const API = window.location.origin`，嵌入 iframe 里 origin 是尚书，
  // 于是请求拼成「尚书origin + /api/...」同源绝对 URL；改写必须先剥 origin 前缀。
  const origin = 'http://127.0.0.1:3000';
  const importRewrite = () =>
    import('../../src/custom/yinling-website/backend/proxy.ts').then(m => m.rewriteUrl);

  it('改写同源绝对 URL：origin + /api/ → /website-api/', async () => {
    const rw = await importRewrite();
    assert.equal(rw(`${origin}/api/admin/login`, origin), '/website-api/admin/login');
    assert.equal(rw(`${origin}/uploads/a.png`, origin), '/website-uploads/a.png');
  });

  it('仍兼容相对路径 /api/ 与 /uploads/', async () => {
    const rw = await importRewrite();
    assert.equal(rw('/api/admin/login', origin), '/website-api/admin/login');
    assert.equal(rw('/uploads/a.png', origin), '/website-uploads/a.png');
  });

  it('不改写跨域绝对 URL，原样返回', async () => {
    const rw = await importRewrite();
    assert.equal(rw('https://www.lingeringtek.cn/api/x', origin), 'https://www.lingeringtek.cn/api/x');
  });

  it('非字符串原样返回（fetch(Request) 等）', async () => {
    const rw = await importRewrite();
    assert.equal(rw(undefined, origin), undefined);
    const req = { x: 1 };
    assert.equal(rw(req, origin), req);
  });
});
