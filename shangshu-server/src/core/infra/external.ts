// ExternalServices 聚合器 —— 统一管理 mail + ocr 外部服务。
// 可注入依赖（用于测试），否则创建默认实现。
import type { RuntimeConfig, ExternalServices, MailSource, OcrService } from '../types.ts';
import { createMailSource } from './mail.ts';
import { OcrServiceManager } from './ocr.ts';

export class ExternalServiceManager implements ExternalServices {
  mail: MailSource;
  ocr: OcrService;

  constructor(cfg: RuntimeConfig, deps?: Partial<ExternalServices>) {
    this.mail = deps?.mail ?? createMailSource(cfg.mail);
    this.ocr = deps?.ocr ?? new OcrServiceManager({ port: cfg.ocr?.port, log: console.log });
  }

  async start(): Promise<void> {
    await this.ocr.start();
  }

  stop(): void {
    this.ocr.stop();
  }
}
