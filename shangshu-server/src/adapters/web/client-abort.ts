/**
 * **客户端断开 ⇒ 上游也停**（2026-10-28 · PKG-132 · 审查报告 R06）。
 *
 * **背景**：前端已经接了取消信号（`real-applications.js` / `real-objects.js` /
 * `real-dashboard.js` 把 `AbortSignal` 传下来），但 Node → 上游（Frappe）的请求
 * **全是固定超时**（`AbortSignal.timeout(...)`）⇒ **浏览器取消后，上游还在跑**
 * （连点侧栏 ⇒ 一串用不上的请求继续打过去，白占上游与数据库）。
 *
 * **怎么做**：Express 的 `req.res` 在**响应正常发完**时发 `finish`，
 * 在**连接被掐断**时只发 `close` ⇒ 用这两者的差别判断「客户端是不是不等了」。
 *
 * ⚠️ **只给读路用**（`readSignal`）：**写动作不盲中止** ——
 *   写已经在服务端落下（超时也一样：用户看到失败、版本却已落库），
 *   中止只会让回执丢得更彻底 ⇒ 写路**保持固定超时**（核验/恢复语义不变）。
 */
import type { Request, Response } from 'express';

/** 客户端断开时触发的信号；拿不到响应对象时回 undefined（⇒ 不合并）。 */
export function clientAbortSignal(req: Request): AbortSignal | undefined {
  const res = (req as unknown as { res?: Response }).res;
  if (!res || typeof res.once !== 'function') return undefined;
  const controller = new AbortController();
  let finished = false;
  res.once('finish', () => { finished = true; });
  res.once('close', () => {
    if (!finished) controller.abort(new Error('客户端已取消请求'));
  });
  return controller.signal;
}

/**
 * **读路**的上游信号 ＝ 客户端断开 **或** 固定超时（先到先算）。
 *
 * ⚠️ 写路**不要**用这个 —— 见文件头的说明。
 */
export function readSignal(req: Request, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const client = clientAbortSignal(req);
  return client ? AbortSignal.any([client, timeout]) : timeout;
}
