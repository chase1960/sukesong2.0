// 官网 API client（定制层）：base_url + x-api-key，8s 超时，错误归一。
// 连接参数全在 runtime_config.website（系统配置页可改），不写死。
import { loadConfig } from '../../../core/config.ts';

export class WebsiteError extends Error {
  constructor(
    public kind: 'OFFLINE' | 'UNAUTHORIZED' | 'UPSTREAM' | 'NOT_CONFIGURED',
    message: string,
    public status?: number,
  ) { super(message); }
}

export async function websiteApi<T = any>(method: string, path: string, body?: any): Promise<T> {
  const w = loadConfig().website;
  if (!w?.base_url || !w?.api_key) throw new WebsiteError('NOT_CONFIGURED', '未配置官网 base_url / api_key（系统配置页）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(w.base_url.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': w.api_key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) throw new WebsiteError('UNAUTHORIZED', '官网 API key 无效', res.status);
    if (!res.ok) throw new WebsiteError('UPSTREAM', `官网返回 ${res.status}`, res.status);
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new WebsiteError('UPSTREAM', '官网返回非 JSON 或响应损坏', res.status);
    }
  } catch (e) {
    if (e instanceof WebsiteError) throw e;
    throw new WebsiteError('OFFLINE', '官网不可达或超时');
  } finally {
    clearTimeout(timer);
  }
}
