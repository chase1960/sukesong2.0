import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../../src/adapters/web/server.ts';

describe('Frappe 同域代理', () => {
  let upstream: Server;
  let server: Server;
  let base = '';
  let oldUpstream: string | undefined;
  let oldMode: string | undefined;
  let oldSocketUpstream: string | undefined;

  before(async () => {
    oldUpstream = process.env.FRAPPE_UPSTREAM;
    oldMode = process.env.SHANGSHU_PLATFORM_MODE;
    oldSocketUpstream = process.env.FRAPPE_SOCKETIO_UPSTREAM;
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          path: req.url,
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
          forwardedHost: req.headers['x-forwarded-host'],
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    process.env.FRAPPE_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    process.env.SHANGSHU_PLATFORM_MODE = 'frappe';
    process.env.FRAPPE_SOCKETIO_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    server = buildApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    if (oldUpstream === undefined) delete process.env.FRAPPE_UPSTREAM;
    else process.env.FRAPPE_UPSTREAM = oldUpstream;
    if (oldMode === undefined) delete process.env.SHANGSHU_PLATFORM_MODE;
    else process.env.SHANGSHU_PLATFORM_MODE = oldMode;
    if (oldSocketUpstream === undefined) delete process.env.FRAPPE_SOCKETIO_UPSTREAM;
    else process.env.FRAPPE_SOCKETIO_UPSTREAM = oldSocketUpstream;
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });

  it('不向浏览器直通 Frappe 方法与资源 API', async () => {
    const response = await fetch(`${base}/api/method/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usr: 'staff1@shangshu.local' }),
    });
    assert.equal(response.status, 410);
    assert.equal(((await response.json()) as any).code, 'LEGACY_SURFACE_DISABLED');

    const resource = await fetch(`${base}/api/resource/User`);
    assert.equal(resource.status, 410);
  });

  it('Frappe Desk 不再作为产品前端，产品路由回到原尚书界面', async () => {
    const appResponse = await fetch(`${base}/app/shangshu-process-center`, { redirect: 'manual' });
    assert.equal(appResponse.status, 302);
    assert.equal(appResponse.headers.get('location'), '/#/flowdesign');

		const studioResponse = await fetch(`${base}/app/shangshu-workflow-studio`, { redirect: 'manual' });
		assert.equal(studioResponse.status, 302);
		assert.equal(studioResponse.headers.get('location'), '/#/flowdesign');

		const loginResponse = await fetch(`${base}/login`, { redirect: 'manual' });
		assert.equal(loginResponse.status, 302);
		assert.equal(loginResponse.headers.get('location'), '/login.html');

    const nodeResponse = await fetch(`${base}/api/session`);
    assert.deepEqual(await nodeResponse.json(), { authed: false });
  });

  it('将 Socket.IO 的 HTTP polling 握手转发给实时服务', async () => {
    const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    const data = await response.json() as Record<string, string>;
    assert.equal(data.path, '/socket.io/?EIO=4&transport=polling');
    assert.equal(data.method, 'GET');
  });
});
