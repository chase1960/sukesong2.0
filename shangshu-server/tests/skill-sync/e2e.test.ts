import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { buildApp } from '../../src/adapters/web/server.ts';
import simpleGit from 'simple-git';

// 在临时 git repo 写入 skill.md 并提交，打成完整 git bundle 返回（首次 push，无 prerequisite）。
async function makeBundle(content: string): Promise<Buffer> {
  const work = mkdtempSync(join(tmpdir(), 'ss-work-'));
  const g = simpleGit(work);
  await g.init();
  await g.addConfig('user.email', 'e2e@shangshu.local');
  await g.addConfig('user.name', 'e2e');
  await g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']); // 钉 main，脱离 git 默认分支差异
  writeFileSync(join(work, 'skill.md'), content);
  await g.add('.');
  await g.commit('init');
  const bundlePath = join(work, 'push.bundle');
  await g.raw(['bundle', 'create', bundlePath, 'main']);
  const buf = readFileSync(bundlePath);
  rmSync(work, { recursive: true, force: true });
  return buf;
}

describe('skill sync e2e', { concurrency: false }, () => {
  let root: string;
  let server: Server;
  let port: number;
  let cookie: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ss-e2e-'));
    process.env._SS_SKILL_DIR = root;
    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin' }),
    });
    cookie = login.headers.get('set-cookie') || '';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    server.close();
  });

  it('full push and pull flow', async () => {
    const keyRes = await fetch(`http://127.0.0.1:${port}/api/skill-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'e2e', role: 'upload' }),
    });
    const { key } = await keyRes.json();

    // push：body 是 git bundle（octet-stream），parent 走 query（首次 parent=''）
    const push = await fetch(`http://127.0.0.1:${port}/api/skills/hello/push?parent=`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Shangshu-Key': key },
      body: (await makeBundle('# Hello')) as unknown as BodyInit,
    });
    assert.equal(push.status, 200);

    const list = await fetch(`http://127.0.0.1:${port}/api/skills`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const skills = await list.json();
    assert.equal(skills.length, 1);

    // pull：返回 git bundle 字节，fetch 进新 repo 解出 skill.md 验证内容
    const pull = await fetch(`http://127.0.0.1:${port}/api/skills/hello/pull`, { headers: { cookie } });
    assert.equal(pull.status, 200);
    const verify = mkdtempSync(join(tmpdir(), 'ss-verify-'));
    const bundlePath = join(verify, 'pull.bundle');
    writeFileSync(bundlePath, Buffer.from(await pull.arrayBuffer()));
    const g = simpleGit(verify);
    await g.init();
    await g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await g.raw(['fetch', bundlePath, 'main']);
    await g.raw(['checkout', 'FETCH_HEAD']);
    assert.equal(readFileSync(join(verify, 'skill.md'), 'utf-8'), '# Hello');
    rmSync(verify, { recursive: true, force: true });
  });
});
