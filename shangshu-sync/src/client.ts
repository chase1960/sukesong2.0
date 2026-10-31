import type { LocalConfig } from './config.ts';

export class SyncClient {
  constructor(private cfg: LocalConfig) {}

  private async fetch(path: string, init: RequestInit = {}) {
    // 调用方传入的 headers 可覆盖默认 Content-Type(push 用 octet-stream)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    };
    // 写操作(push)用 upload key,读操作(list/status/pull)用 download key
    const isWrite = (init.method ?? 'GET') !== 'GET';
    const key = isWrite ? this.cfg.uploadKey : this.cfg.downloadKey;
    if (key) headers['X-Shangshu-Key'] = key;
    const r = await fetch(`${this.cfg.serverUrl}${path}`, { ...init, headers });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r;
  }

  async list() { return (await this.fetch('/api/skills')).json(); }
  async status(skill: string) { return (await this.fetch(`/api/skills/${skill}/status`)).json(); }
  async push(skill: string, parent: string, bundle: Buffer) {
    return (await this.fetch(`/api/skills/${skill}/push?parent=${encodeURIComponent(parent)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Node fetch 运行时接受 Buffer/Uint8Array,TS dom lib 类型不认,转义一次
      body: bundle as unknown as BodyInit,
    })).json();
  }
  async pull(skill: string): Promise<Buffer> {
    const r = await this.fetch(`/api/skills/${skill}/pull`);
    return Buffer.from(await r.arrayBuffer());
  }
}
