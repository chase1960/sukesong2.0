// Frappe 平台模式的 Node 兼容面采用显式 allowlist。
// 新平台身份、业务对象、流程、调度与工具目录必须走 /api/platform/*；
// 这里只保留尚未迁移但已明确批准的协作与 BFF 集成能力。
const PLATFORM_LEGACY_ALLOWLIST = [
  /^\/(?:login|logout|session)\/?$/,
  /^\/chat(?:\/|$)/,
  /^\/confirmations(?:\/|$)/,
  /^\/config(?:\/|$)/,
  /^\/im(?:\/|$)/,
  /^\/tasks(?:\/|$)/,
  /^\/posts(?:\/|$)/,
  /^\/people\/?$/,
  // 工作提醒（未读通知 + 我的任务）与已读标记：与 /tasks 同一批批准的协作兼容能力
  /^\/me\/(?:work|notifications)(?:\/|$)/,
  /^\/instance\/health\/?$/,
] as const;

export function isPlatformLegacyPathAllowed(path: string): boolean {
  const normalized = `/${String(path || '').replace(/^\/+/, '').split('?', 1)[0]}`;
  return PLATFORM_LEGACY_ALLOWLIST.some((rule) => rule.test(normalized));
}

export function platformLegacyGuard(path: string): { allowed: boolean; code?: string; message?: string } {
  if (isPlatformLegacyPathAllowed(path)) return { allowed: true };
  return {
    allowed: false,
    code: 'LEGACY_SURFACE_DISABLED',
    message: '该旧版能力未接入统一平台内核，已在平台模式停用',
  };
}
