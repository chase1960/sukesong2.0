export type PlatformMode = 'legacy' | 'frappe';

export function resolvePlatformMode(env: NodeJS.ProcessEnv = process.env): PlatformMode {
  const raw = String(env.SHANGSHU_PLATFORM_MODE || '').trim().toLowerCase();
  if (!raw) {
    if (env.FRAPPE_UPSTREAM) {
      throw new Error('检测到 FRAPPE_UPSTREAM，但未显式设置 SHANGSHU_PLATFORM_MODE=frappe；为避免身份回退，拒绝启动');
    }
    return 'legacy';
  }
  if (raw !== 'legacy' && raw !== 'frappe') {
    throw new Error(`SHANGSHU_PLATFORM_MODE 仅支持 legacy 或 frappe，当前为 ${raw}`);
  }
  if (raw === 'frappe' && !env.FRAPPE_UPSTREAM) {
    throw new Error('SHANGSHU_PLATFORM_MODE=frappe 时必须配置 FRAPPE_UPSTREAM；平台不可用时禁止回退 Node 身份');
  }
  return raw;
}
