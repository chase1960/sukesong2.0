import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

// 模型来源：每条自带地址与密钥，切换即整条套用；密钥只存服务器，接口只回脱敏值。
describe('模型来源配置', () => {
  let dir: string; let upstream: Server; let server: Server; let uport: number; let port: number; let cookie: string;
  let seenAuth = ''; let seenModel = '';

  const api = async (path: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', cookie, ...(init?.headers || {}) },
    });
    // **先读 status + 原文，再尝试解析**（E/F 2026-10-17 压测翻转诊断）：
    // 直接 `res.json()` 在空体时只留一句 `Unexpected end of JSON input`，
    // 连「是 200 空体还是 500」都看不到。这里把状态与正文带进错误里。
    const text = await res.text();
    let body: any = null;
    let parseError: string | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      parseError = String(error);
    }
    if (parseError || (text === '' && method !== 'GET')) {
      const detail = `API ${method} ${path} → HTTP ${res.status} bytes=${Buffer.byteLength(text)}`
        + ` text=${JSON.stringify(text.slice(0, 800))}`
        + (parseError ? ` parseError=${parseError}` : '');
      const failure: any = new Error(detail);
      failure.status = res.status;
      failure.text = text;
      throw failure;
    }
    return { status: res.status, body, text };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-llmsrc-'));
    process.env._SS_DATA_DIR = dir;
    upstream = createServer((req, res) => {
      seenAuth = req.headers.authorization || '';
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try { seenModel = JSON.parse(raw).model || ''; } catch { seenModel = ''; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '好' } }] }));
      });
    });
    await new Promise<void>(r => { upstream = upstream.listen(0, () => { uport = (upstream.address() as any).port; r(); }); });
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({ llm: { model: 'qwen3:8b' } }));
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    // **登录失败不许静默成空 cookie**（E/F 2026-10-17 压测翻转诊断）：
    // 原来 `cookie = ... || ''`，登录失败时后面所有请求都无会话、只看到 JSON 解析错。
    if (!login.ok) {
      throw new Error(`登录失败：HTTP ${login.status} ${(await login.text().catch(() => '')).slice(0, 500)}`);
    }
    cookie = login.headers.get('set-cookie') || '';
    if (!cookie) throw new Error('登录成功但没有 set-cookie —— 会话链路断了');
  });
  afterEach(() => {
    upstream.close();
    server.close();
    // **临时目录要清**（E 2026-10-17 测试卫生）：本文件每个用例建一个 mkdtemp，
    // 全量长跑时不清会一直堆 /tmp，也可能与「负载下偶发」有关。
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  });

  it('保存来源后可整体切换，密钥随来源走且接口只回脱敏值', async () => {
    const saved = await api('/api/config/llm/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources: [
        { id: 'gpu-fast', name: '租用 GPU · 快车道', provider: 'ollama', base_url: `http://127.0.0.1:${uport}/v1`, model: 'qwen3-30b-a3b', api_key: 'secret-key-fast' },
        { id: 'gpu-thinking', name: '租用 GPU · 思考版', provider: 'ollama', base_url: `http://127.0.0.1:${uport}/v1`, model: 'qwen3-30b-a3b-thinking', api_key: 'secret-key-thinking' },
      ] }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.llm_sources.length, 2);
    assert.ok(saved.body.config.llm_sources[0].api_key.includes('••••'), '接口不得回明文密钥');
    assert.ok(!JSON.stringify(saved.body).includes('secret-key-fast'), '响应体不得含明文密钥');
    assert.ok(JSON.parse(readFileSync(join(dir, 'runtime_config.json'), 'utf8')).llm_sources[0].api_key === 'secret-key-fast', '密钥明文只落服务器配置');

    const applied = await api('/api/config/llm/apply', { method: 'POST', body: JSON.stringify({ id: 'gpu-thinking' }) });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.config.llm.model, 'qwen3-30b-a3b-thinking');
    assert.ok(!JSON.stringify(applied.body).includes('secret-key-thinking'));
    const onDisk = JSON.parse(readFileSync(join(dir, 'runtime_config.json'), 'utf8'));
    assert.equal(onDisk.llm.api_key, 'secret-key-thinking', '切换必须连密钥一起套用');
    assert.equal(onDisk.llm.base_url, `http://127.0.0.1:${uport}/v1`);

    const probed = await api('/api/config/test/llm', { method: 'POST', body: JSON.stringify({ id: 'gpu-fast' }) });
    assert.equal(probed.body.ok, true, probed.body.detail);
    assert.equal(seenAuth, 'Bearer secret-key-fast', '按来源测连通要带该来源的密钥');
    assert.equal(seenModel, 'qwen3-30b-a3b');
  });

  it('脱敏占位更新保留原密钥；未知来源与非法地址被拒', async () => {
    await api('/api/config/llm/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources: [{ id: 's1', name: '来源一', provider: 'ollama', base_url: `http://127.0.0.1:${uport}/v1`, model: 'm1', api_key: 'keep-me' }] }),
    });
    const updated = await api('/api/config/llm/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources: [{ id: 's1', name: '来源一改名', provider: 'ollama', base_url: `http://127.0.0.1:${uport}/v1`, model: 'm1', api_key: 'ab••••ef' }] }),
    });
    assert.equal(updated.status, 200);
    assert.equal(JSON.parse(readFileSync(join(dir, 'runtime_config.json'), 'utf8')).llm_sources[0].api_key, 'keep-me');

    const missing = await api('/api/config/llm/apply', { method: 'POST', body: JSON.stringify({ id: 'no-such' }) });
    assert.equal(missing.status, 404);
    const badUrl = await api('/api/config/llm/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources: [{ id: 's2', name: '坏地址', provider: 'ollama', base_url: 'http://169.254.169.254/v1', model: 'm2', api_key: '' }] }),
    });
    assert.equal(badUrl.status, 400);
    const badBody = await api('/api/config/llm/sources', { method: 'PUT', body: JSON.stringify({ sources: 'nope' }) });
    assert.equal(badBody.status, 400);
  });
});
