import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

describe('官网 dashboard widgets 接入', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-widgets-'));
    process.env._SS_DATA_DIR = dir;

    const { registerYinlingWebsite } = await import('../../src/custom/yinling-website/register.ts');
    registerYinlingWebsite();

    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        r();
      });
    });

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });

  afterEach(() => {
    server.close();
    delete process.env._SS_DATA_DIR;
  });

  it('GET /api/dashboard/widgets 返回 5 个 widget 且按 order 升序，包含 yinling.funnel', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/widgets`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const widgets = await res.json();
    assert.equal(widgets.length, 5, `期望 5 个 widget，实际 ${widgets.length}`);
    const orders = widgets.map((w: any) => w.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'widget 应按 order 升序');
    assert.ok(widgets.some((w: any) => w.id === 'yinling.funnel'), '应包含 yinling.funnel');
  });
});
