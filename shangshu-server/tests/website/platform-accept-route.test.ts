// 死路由清理：同一个「逐项审核采纳」口**只准注册一条**，且那条必须读 `expected_review_revision`。
//
// 改之前：`/api/platform/action-proposals/:id/accept` 注册了**两条** ——
//   ① 先注册的那条读 `expected_review_revision`（对的口）；
//   ② 后注册的那条读旧名 `review_revision` ⇒ Express **先匹配先注册** ⇒ 它**永远走不到**（死路由），
//      而且它写着一个**错的字段名** ⇒ 后来的人照着它改前端就会踩「回执读不出来」那个坑。
//
// 判据（行为）：
//   ① 路由表里 `/api/platform/action-proposals/:id/accept` 的 POST **恰好一条**；
//   ② 真调那一条：转发给内核的请求体里**有** `expected_review_revision`、**没有** `review_revision`。
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { platformRouter } from '../../src/adapters/web/platform.ts';

const originalFetch = globalThis.fetch;
const originalUpstream = process.env.FRAPPE_UPSTREAM;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUpstream === undefined) delete process.env.FRAPPE_UPSTREAM;
  else process.env.FRAPPE_UPSTREAM = originalUpstream;
});

function postRoutes(router: any, path: string) {
  const found: any[] = [];
  for (const layer of router.stack || []) {
    const route = layer.route;
    if (!route || route.path !== path) continue;
    for (const item of route.stack || []) {
      if (item.method === 'post') found.push(item.handle);
    }
  }
  return found;
}

it('逐项审核采纳口只注册一条，且转发的是 expected_review_revision（不是旧名 review_revision）', async () => {
  process.env.FRAPPE_UPSTREAM = 'http://frappe.invalid';
  const sent: any[] = [];
  globalThis.fetch = (async (url: any, options: any) => {
    const target = String(url);
    if (target.includes('http.csrf')) {
      return new Response(JSON.stringify({ message: { csrf_token: 'tok-1' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sent.push({ url: target, body: options?.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ message: { ok: true, id: 'APROP-1' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const router = platformRouter();
  const handlers = postRoutes(router, '/api/platform/action-proposals/:id/accept');
  assert.equal(handlers.length, 1, `同一个路径只准一条 POST 路由（实际 ${handlers.length} 条：多出来的那条永远走不到＝死路由）`);

  let answered: any = null;
  const res: any = {
    json: (value: any) => { answered = value; },
    status: () => res,
    setHeader: () => res,
  };
  const req: any = {
    params: { id: 'APROP-1' },
    body: { op_id: 'op-1', expected_review_revision: 'rev-7', units: ['u1'] },
    headers: { cookie: 'sid=x' },
  };
  await handlers[0](req, res);

  assert.ok(sent.length === 1, `应当只向上游发一次（实际 ${sent.length} 次）`);
  assert.equal(sent[0].body.expected_review_revision, 'rev-7', '版本号要按 expected_review_revision 转发');
  assert.equal('review_revision' in (sent[0].body || {}), false, '不许再转发旧名 review_revision');
  assert.ok(answered?.ok, `应当回 ok（收到 ${JSON.stringify(answered)}）`);
});
