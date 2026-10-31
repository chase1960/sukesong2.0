// OCR 服务管理器 —— 管理 ocr_server.py 子进程的生命周期。
// spawn python scripts/ocr_server.py（优先 scripts/venv），等待 /health 就绪，提供 extract() 接口。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { OcrService, OcrExtractResult } from '../types.ts';

const HEALTH_RETRIES = 30;
const HEALTH_INTERVAL_MS = 200;
const AUTO_RESTART_DELAY_MS = 3000;

// 优先用 scripts/venv 里的 python（requirements-ocr.txt 装在这里），fallback 系统 python3。
function resolvePython(): string {
  const venvPy = process.platform === 'win32' ? 'scripts/venv/Scripts/python.exe' : 'scripts/venv/bin/python3';
  return existsSync(venvPy) ? venvPy : 'python3';
}

export class OcrServiceManager implements OcrService {
  private proc: ChildProcess | null = null;
  private port: number;
  private scriptPath: string;
  private log: (msg: string) => void;
  private stderrTail: string[] = [];
  // 依赖缺失等「起不来的错」不无限重启：crash 太频繁（上次存活 < 10s）即停手
  private lastStartAt = 0;
  private gaveUp = false;

  constructor(opts: { port?: number; scriptPath?: string; log?: (msg: string) => void }) {
    this.port = opts.port ?? 8001;
    // 默认脚本路径：从 server 根目录的 scripts/ocr_server.py
    this.scriptPath = opts.scriptPath ?? 'scripts/ocr_server.py';
    this.log = opts.log ?? console.log;
  }

  async start(): Promise<void> {
    if (this.proc || this.gaveUp) return;

    const python = resolvePython();
    this.log(`[ocr] 启动 ocr_server.py 端口 ${this.port}（${python}）`);
    try {
      this.lastStartAt = Date.now();
      this.proc = spawn(python, [this.scriptPath], {
        env: { ...process.env, PORT: String(this.port) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      // 同步 spawn 失败（如资源不足）：不崩进程，OCR 暂不可用（不影响发票已有数据 / 入账）
      this.log(`[ocr] spawn 失败，OCR 暂不可用: ${(e as Error).message}`);
      this.proc = null;
      return;
    }

    // stderr 透传：python 报错（如 ModuleNotFoundError）不再被吞，方便排查
    this.stderrTail = [];
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().trimEnd().split('\n');
      for (const l of lines) this.log(`[ocr:py] ${l}`);
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50);
    });

    // spawn 异步错误（EAGAIN 资源耗尽等）：捕获、不崩进程、不自动重启（避免死循环）
    this.proc.on('error', (e) => {
      this.log(`[ocr] 子进程错误（不自动重启）: ${(e as Error).message}`);
      this.proc = null;
    });

    this.proc.on('exit', (code) => {
      if (this.proc) {
        const aliveMs = Date.now() - this.lastStartAt;
        this.proc = null;
        // 秒挂（存活 < 10s）基本是永久错误（缺依赖/端口占用/语法错），重启无意义，停手避免刷屏
        if (aliveMs < 10_000) {
          this.gaveUp = true;
          this.log(`[ocr] 子进程秒挂 (code=${code}, 存活 ${aliveMs}ms)，停止自动重启。请先看上方 [ocr:py] 报错`);
          return;
        }
        this.log(`[ocr] 子进程退出 (code=${code})，${AUTO_RESTART_DELAY_MS}ms 后自动重启`);
        setTimeout(() => this.start().catch((e) => this.log(`[ocr] 重启失败: ${e.message}`)), AUTO_RESTART_DELAY_MS);
      }
    });

    // 等待 /health 就绪；起不来只告警不抛（OCR 不可用不阻断 server 启动与发票/入账功能）
    await this.waitForHealth().catch((e) => this.log(`[ocr] ${e.message}`));
    if (this.proc) this.log('[ocr] 服务就绪');
  }

  async extract(formData: FormData): Promise<OcrExtractResult> {
    // OCR 子进程未就绪时给清晰错误，而不是让 fetch 撞 ECONNREFUSED 抛 opaque 的 cause
    if (!this.proc) throw new Error('OCR 服务未就绪（ocr_server.py 未启动或启动失败，详见服务端日志 [ocr] 行）');
    const url = `http://127.0.0.1:${this.port}/extract`;
    const res = await fetch(url, { method: 'POST', body: formData });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ocr-service ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as OcrExtractResult;
  }

  stop(): void {
    if (this.proc) {
      this.log('[ocr] 停止子进程');
      this.proc.kill();
      this.proc = null;
    }
  }

  private async waitForHealth(): Promise<void> {
    const healthUrl = `http://127.0.0.1:${this.port}/health`;
    for (let i = 0; i < HEALTH_RETRIES; i++) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    throw new Error(`[ocr] /health 未就绪（${HEALTH_RETRIES} 次重试后超时）`);
  }
}
