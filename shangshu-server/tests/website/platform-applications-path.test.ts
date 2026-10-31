// 判据：工作台「常用应用」那条路（`GET /api/platform/applications`）**走得通**，
// 并且登录态没了的时候**说实话**（回 401，不是那句看不懂的「不是白名单」）。
//
// **测试通过 =**（一句话）
// 「登录态有效 ⇒ `GET /api/platform/applications` 回 200 ＋ 应用清单（转发到**白名单口**
//   `shangshu_core.public_api.http.applications`，且带着浏览器那枚 Frappe 会话）；
//   登录态没了（Frappe 那边把这次请求当 Guest 拒了）⇒ 回 **401 `AUTH_REQUIRED`** ＋
//   「请重新登录」这类人话，**不是** 403 ＋ Frappe 那句「Function … is not whitelisted」；
//   而登录态还在、只是**权限不够**（真·权限错）⇒ 仍然回 403（不许被上面那条顺手盖掉）。」
//
// ⚠️ 为什么盯「不是白名单」这句话：
//   Frappe 的 `is_whitelisted()`（frappe/__init__.py）对**两种**情况报同一句
//   「Function {0} is not whitelisted.」——① 这个方法不在白名单；② **这次请求是 Guest**。
//   `applications` **本来就在白名单里**（`public_api/http.py` 上有 `@frappe.whitelist()`），
//   所以站上看到的那句 403 其实是②。
//   2026-10-22 3850 实测：Frappe 会话一失效，工作台「常用应用」就一直空着，
//   用户只看到一句看不懂的 403 —— 前端只有 401 才会把人送回登录页
//   （`shangshu-web/js/app.js` 的 `api()`：`if (r.status === 401) location.href = 'login.html'`）。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withFrappeUpstream } from '../helpers/frappe-upstream.ts';

const APPLICATIONS_METHOD = 'shangshu_core.public_api.http.applications';

/** Frappe 拒绝「这次请求没登录」时的**真形状**（原样抄 Frappe 的回包）。 */
function frappeGuestRejection(method: string) {
  return {
    status: 403,
    payload: {
      message:
        '<details><summary>You are not permitted to access this resource. Login to access</summary>' +
        `Function <strong>${method}</strong> is not whitelisted.</details>`,
      exception: 'frappe.exceptions.PermissionError',
      exc_type: 'PermissionError',
    },
  };
}

describe('工作台「常用应用」那条路（GET /api/platform/applications）', () => {
  it('登录态有效 ⇒ 回 200 ＋ 应用清单，且转发到白名单口并带着浏览器那枚会话', async () => {
    await withFrappeUpstream(
      async (base, seen) => {
        const response = await fetch(`${base}/api/platform/applications`, {
          headers: { cookie: 'sid=abc123' },
        });
        const body = await response.json();
        assert.equal(response.status, 200, `没回 200：${JSON.stringify(body)}`);
        assert.equal(body.ok, true);
        assert.ok(Array.isArray(body.list), '没回应用清单');
        assert.ok(body.list.length > 0, '应用清单是空的');
        // 转发到的是**白名单适配口**，不是别的口。
        assert.ok(
          seen.includes(`GET ${APPLICATIONS_METHOD}`),
          `没转发到白名单口：${JSON.stringify(seen)}`,
        );
      },
      (method) => {
        if (method === APPLICATIONS_METHOD) return [{ id: 'com.shangshu.warehouse', title: '仓库管理' }];
        return undefined;
      },
    );
  });

  it('登录态没了（Frappe 把这次请求当 Guest 拒了）⇒ 回 401「请重新登录」，不是 403「不是白名单」', async () => {
    await withFrappeUpstream(
      async (base) => {
        const response = await fetch(`${base}/api/platform/applications`, {
          headers: { cookie: 'sid=dead-session' },
        });
        const body = await response.json();
        assert.equal(response.status, 401, `应是 401（前端据此把人送回登录页），实际 ${response.status}：${JSON.stringify(body)}`);
        assert.equal(body.code, 'AUTH_REQUIRED', '错误码不是 AUTH_REQUIRED');
        assert.match(String(body.error), /重新登录|登录/, '没告诉人要重新登录');
        assert.doesNotMatch(
          String(body.error),
          /not whitelisted/,
          '还在甩 Frappe 那句「不是白名单」——用户看不懂',
        );
      },
      undefined,
      undefined,
      (method) => frappeGuestRejection(method),
    );
  });

  it('登录态还在、只是权限不够 ⇒ 仍然回 403（不许被「登录态没了」那条顺手盖掉）', async () => {
    await withFrappeUpstream(
      async (base) => {
        const response = await fetch(`${base}/api/platform/applications?include_disabled=1`, {
          headers: { cookie: 'sid=abc123' },
        });
        const body = await response.json();
        assert.equal(response.status, 403, `真·权限错应当回 403，实际 ${response.status}：${JSON.stringify(body)}`);
        assert.equal(body.code, 'PERMISSION_DENIED', '权限错的错误码被改掉了');
      },
      (method) => {
        if (method === APPLICATIONS_METHOD) {
          return undefined;
        }
        return undefined;
      },
      undefined,
      (method) => {
        // 只有「要管理员」那一条被拒；**身份口读得到** ⇒ 登录态还在 ⇒ 是权限错，不是没登录。
        if (method === APPLICATIONS_METHOD) {
          return {
            status: 403,
            payload: { message: '需要系统管理员权限', exc_type: 'PermissionError' },
          };
        }
        return null;
      },
    );
  });
});
