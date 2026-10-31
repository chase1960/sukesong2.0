// 假 Frappe 上游 + 平台模式的 BFF 起服工具（**公共工具只留一份**）。
//
// **为什么抽出来**：凡是验「BFF 把请求转发到 Frappe 的哪个 method、带了什么参数、
// 回包形状调用方认不认」这类判据，都要先起一个假上游 + `SHANGSHU_PLATFORM_MODE=frappe`
// 再 `buildApp()`。这套起停原先内联在 `frappe-proxy.test.ts` 的 before/after 里，
// 每来一个这样的判据就复制一遍 —— 那是「重搭一套测试工具」，不是「补用例」。
// 所以留在这里一份，谁要就 `withFrappeUpstream(...)`。
//
// **用法**：
//   await withFrappeUpstream(async (method) => ({ list: [] }), async (base) => {
//     const res = await fetch(`${base}/api/platform/action-proposals`);
//     ...
//   });
//
// `respond` 收到的是**解析后的 method 路径**（`/api/method/<method>` 里那段）和请求体，
// 回什么就原样当 Frappe 的 `message` 包回去。不传就用默认回声（path/method/body），
// 那是 `frappe-proxy.test.ts` 那类「只看转发了什么」的判据要的形状。
import { createServer, type Server, type ServerResponse } from 'node:http';
import { buildApp } from '../../src/adapters/web/server.ts';

export type UpstreamResponder = (method: string, body: unknown, reqUrl: string) => unknown;

/**
 * **自己回完响应**的上游钩子（返回 true 表示这一条已经处理完，别再走 JSON 那条路）。
 *
 * 为什么要有：有些内核口回的不是 JSON —— 比如 `file_content` 回的是**原件字节**
 * （`Content-Disposition` ＋ 二进制）。JSON 那条路回不了这个形状。
 * 公共工具只留一份 ⇒ 这里**加能力**，不叫每个判据自己起一套上游。
 */
export type RawResponder = (method: string, reqUrl: string, res: ServerResponse) => boolean;

/**
 * **让上游回一个错误状态**的钩子（Frappe 的 403/404 那些）。
 *
 * 为什么要有：判据要复现「Frappe 拒绝这次请求」时的**真实形状** ——
 * 状态码 ＋ `exc_type` ＋ `message`。只回 200 的上游答不了这种case，
 * 每个判据自己再起一套上游 = 复制公共工具。公共工具只留一份 ⇒ 这里**加能力**。
 *
 * 回 `null` 表示「这一条照常走 `respond` 那条路」。
 */
export type UpstreamFailure = (
  method: string,
  body: unknown,
  reqUrl: string,
) => { status: number; payload: unknown } | null;

const echo: UpstreamResponder = (_method, body, reqUrl) => ({ path: reqUrl, body });

/** 起假上游 + 平台模式 BFF，跑 `fn`，无论成败都拆干净（环境变量也还原）。 */
export async function withFrappeUpstream<T>(
  fn: (base: string, seen: string[]) => Promise<T>,
  respond: UpstreamResponder = echo,
  respondRaw: RawResponder = () => false,
  fail: UpstreamFailure = () => null,
): Promise<T> {
  // **平台身份是所有 BFF 路由的公共依赖**（`withCollaborationIdentity` 读
  // `public_api.http.session` / `.people`）。每个用例各写一份身份桩 = 复制公共工具。
  // 所以这里兜底：用例的 `respond` 回 `undefined`/`null` 时，身份两个口由 helper 答上。
  const withIdentity: UpstreamResponder = (method, body, url) => {
    const out = respond(method, body, url);
    if (out !== undefined && out !== null) return out;
    // 形状照 `platform-identity.ts:46-50` 的校验给 —— 缺 `identity_id`/`user_name`
    // 或 `user_name='Guest'` 会被判「需要有效的平台员工身份」，`user_type` 非
    // `System User` 会被判「协作功能需要员工身份」。（判据自己先写错过一回：
    // 给成 `{username, role}`，三条用例全 500，看着像功能坏了。）
    if (method.endsWith('.session')) {
      return { identity_id: 'emp-tester', user_name: 'tester', user_type: 'System User', role: 'admin' };
    }
    if (method.endsWith('.people')) return [];
    // `frappePost` 每次都要先取 csrf（`platform.ts:136`）—— 同身份一样是公共依赖。
    // 不答它，`csrf.csrf_token` 在 null 上取属性就 500，看着像 POST 坏了。
    if (method.endsWith('.csrf')) return { csrf_token: 'test-csrf' };
    return out;
  };
  const responder = withIdentity;
  const seen: string[] = [];
  const old = {
    upstream: process.env.FRAPPE_UPSTREAM,
    mode: process.env.SHANGSHU_PLATFORM_MODE,
    socket: process.env.FRAPPE_SOCKETIO_UPSTREAM,
  };
  let upstream: Server | undefined;
  let server: Server | undefined;
  try {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        const url = String(req.url || '');
        // `/api/method/<method>` 里的 method 段 —— 判据要核的是「转发到了哪个口」
        const method = url.split('/api/method/')[1]?.split('?')[0] || url;
        seen.push(`${req.method} ${method}`);
        // 原件字节那类口（`file_content`）自己回 —— JSON 那条路回不了二进制。
        if (respondRaw(method, url, res)) return;
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
        // 「这一条要回错误状态」先判 —— 它回的是 Frappe 的**真形状**（状态码 ＋ exc_type ＋ message）。
        const failure = fail(method, body, url);
        if (failure) {
          res.statusCode = failure.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(failure.payload));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: responder(method, body, url) }));
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    process.env.FRAPPE_UPSTREAM = `http://127.0.0.1:${port}`;
    process.env.SHANGSHU_PLATFORM_MODE = 'frappe';
    process.env.FRAPPE_SOCKETIO_UPSTREAM = `http://127.0.0.1:${port}`;

    server = buildApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return await fn(base, seen);
  } finally {
    if (old.upstream === undefined) delete process.env.FRAPPE_UPSTREAM;
    else process.env.FRAPPE_UPSTREAM = old.upstream;
    if (old.mode === undefined) delete process.env.SHANGSHU_PLATFORM_MODE;
    else process.env.SHANGSHU_PLATFORM_MODE = old.mode;
    if (old.socket === undefined) delete process.env.FRAPPE_SOCKETIO_UPSTREAM;
    else process.env.FRAPPE_SOCKETIO_UPSTREAM = old.socket;
    await Promise.all([
      new Promise<void>((r) => (server ? server.close(() => r()) : r())),
      new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r())),
    ]);
  }
}
