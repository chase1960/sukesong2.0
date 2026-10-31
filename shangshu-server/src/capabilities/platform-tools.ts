// Frappe Process Runtime 使用的抽象工具目录投影。
// 这里只注册稳定 ID 与说明，实际文件字节由同源 BFF 交给 OCR 服务；不会写 Node 主库。
import { registerCapability } from '../core/registry.ts';

export function registerPlatformTools(): void {
  const tools = [
    ['document.pdf_text_extract', 'PDF 文字层解析'],
    ['document.ocr_extract', 'OCR 票据识别'],
    ['document.vision_extract', '多模态票据识别'],
  ] as const;
  for (const [id, name] of tools) {
    registerCapability({
      id,
      revision: 1,
      name,
      impl: 'external',
      effect: 'extract',
      roles: ['admin', 'finance', 'manager', 'staff', 'service'],
      async run() {
        throw new Error(`${id} 只能由平台 BFF 在已授权的流程节点中执行`);
      },
    });
  }
}
