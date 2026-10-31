import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
// 确认卡路由（P1 Task 6）：GET /api/confirmations + POST /api/confirmations/:id
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

describe('确认卡路由', () => {
  let dir: string; let server: Server; let port: number; let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-cfg-'));
    process.env._SS_DATA_DIR = dir;
    const { registerActionHandler } = await import('../../src/core/confirm.ts');
    const { localStore } = await import('../../src/core/store.ts');
    registerActionHandler('demo.book', async (p) => {
      await localStore.insert('business', 'demo', { n: p.n });
    });
    // 预置一条待确认提案（模拟 AI 低置信自动入账提议）
    await requestConfirmation(localStore, { capability: 'demo.book', entity_type: 'demo', entity_id: 'd1', payload: { n: 42 }, initiator: 'agent' });
    const { buildApp } = await import('../../src/adapters/web/server.ts');
    const app = buildApp();
    await new Promise<void>(r => { server = app.listen(0, () => { port = (server.address() as any).port; r(); }); });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}',
    });
    cookie = login.headers.get('set-cookie') || '';
  });
  afterEach(() => { server.close(); });

  it('GET /api/confirmations 返回 proposed 列表（含 capability/实体/payload/发起人）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/confirmations`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const { list } = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'proposed');
    assert.equal(list[0].capability, 'demo.book');
    assert.equal(list[0].entity_id, 'd1');
    assert.equal(list[0].payload.n, 42);
    assert.equal(list[0].initiator, 'agent');
  });

  it('POST confirmed 执行 handler（投影更新），列表移除', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const res = await fetch(`http://127.0.0.1:${port}/api/confirmations`, { headers: { cookie } });
    const { list } = await res.json();
    const rid = list[0].id;
    const post = await fetch(`http://127.0.0.1:${port}/api/confirmations/${rid}`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'confirmed' }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true });
    const after = await (await fetch(`http://127.0.0.1:${port}/api/confirmations`, { headers: { cookie } })).json();
    assert.equal(after.list.length, 0);
    const demo = await localStore.query('business', 'demo');
    assert.equal(demo.length, 1, 'confirmed 后 handler 已执行投影更新');
    assert.equal(demo[0].n, 42);
  });

  it('POST rejected 不执行 handler，留痕为 rejected 事件', async () => {
    const { localStore } = await import('../../src/core/store.ts');
    const res = await fetch(`http://127.0.0.1:${port}/api/confirmations`, { headers: { cookie } });
    const { list } = await res.json();
    const post = await fetch(`http://127.0.0.1:${port}/api/confirmations/${list[0].id}`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'rejected' }),
    });
    assert.equal(post.status, 200);
    const evts = await localStore.query('execution', 'events');
    assert.equal(evts.filter((e: any) => e.status === 'rejected').length, 1);
    assert.equal((await localStore.query('business', 'demo')).length, 0);
  });

  it('未登录 → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/confirmations`);
    assert.equal(res.status, 401);
  });
});

// ================= 通用审核口的**非旧版路径**（A/C 换口终点）=================
// **为什么要有这一段**：通用审核口（**不按表筛**的那个）今天只活在旧口 `/api/confirmations`
// 上 —— 那条在删除清单里（`platform-legacy-policy.ts` 白名单），删了 A/C 就没口可换。
//
// **⚠️ 先把一个说法纠正在这里（不纠会照着错的做）**：
//   有人报「缺一个通用审核口」—— **不缺**。`/api/confirmations` 在平台模式下调的正是
//   `shangshu_core.public_api.http.action_proposals` → `list_action_proposals(status)`，
//   **本来就不按表筛**（按企业隔离 + 角色过滤）。缺的是**一条非旧版的路径**。
//
// **`files.action_proposals` 不是它的替代品** —— 那个**按表必填**（`proposals.py:listing`
// 没 table 就 throw），还带版本/过期增强，是表内提案用的。发票审批、对话确认卡、
// 邮件草稿都**没有表上下文**，套它就得编假表名。所以 `table` **根本不该出现在通用口上**
// （不是「可选」，是**没有这个参数**）—— 从根上堵死「必须编一个假表名」的压力。
//
// **测试通过 =**：
//   ① `GET /api/platform/action-proposals` 回 `{ok, list}`（A/C 取值链认得），
//      **不带 table 也工作**（这个口没有 table 参数）
//   ② `POST /api/platform/action-proposals/:id` 确认/拒绝能走通，`edited_value` **转发不丢**
//   ③ 这条路径**不在旧口白名单上** —— 旧口删了它还在（反例自检：`/api/confirmations` 在白名单上）
//   ④ 转发到的是**提案口本身**（`action_proposals` / `action_proposal_resolve`），不是别的
//   ⑤ **反例自检**：旧路径 `/api/confirmations` 照旧能用（迁移期两条并存，不是换完就断）
import { withFrappeUpstream } from '../helpers/frappe-upstream.ts';
import { isPlatformLegacyPathAllowed } from '../../src/adapters/web/platform-legacy-policy.ts';

describe('通用审核口的非旧版路径', () => {
  const PROPOSAL = {
    id: 'p1', status: 'proposed', capability: 'mail.save_draft', initiator: 'agent',
    payload: { subject: '助手原稿', body: '正文' }, actor_user: 'staff1@shangshu.local',
  };

  it('GET /api/platform/action-proposals 回 {ok,list}，不带 table 也工作', async () => {
    await withFrappeUpstream(async (base, seen) => {
      const res = await fetch(`${base}/api/platform/action-proposals`);
      assert.equal(res.status, 200, '新路径必须能调通（不是 404/410）');
      const body = await res.json() as any;
      assert.equal(body.ok, true, '回包要有 ok（A/C 取值链按它判成败）');
      assert.ok(Array.isArray(body.list), 'list 必须是数组（A/C 走 data.list）');
      assert.equal(body.list[0].capability, 'mail.save_draft');
      assert.equal(body.list[0].initiator, 'agent');
      // **转发到「表无关」的那个口**，不是按表的 `files.action_proposals`。
      // ⚠️ **这里先写过空判据**：`seen.includes('action_proposals')` —— `files.action_proposals`
      // 也含这个子串，换成按表那个照样绿。要认的是**完整 method 名**，不是子串。
      // （E 的形状要求②「反例在场」就是这条：终点换成按表那个，判据必须红。）
      assert.ok(seen.some((s) => s.includes('shangshu_core.public_api.http.action_proposals')),
        `转发记录里没有表无关的提案口：${seen}`);
      assert.ok(!seen.some((s) => s.includes('files.action_proposals')),
        `不许转发到按表的 files.action_proposals（那个 table 必填，套它就得编假表名）：${seen}`);
      // **不带 table** —— 这个口根本没有 table 参数；硬塞也别当必填
      assert.ok(!seen.some((s) => s.includes('table=')), `不该带 table 参数：${seen}`);
    }, (method) => method.endsWith('action_proposals') ? [PROPOSAL] : null);
  });

  it('POST /api/platform/action-proposals/:id 确认/拒绝走通，edited_value 转发不丢', async () => {
    await withFrappeUpstream(async (base, seen) => {
      const res = await fetch(`${base}/api/platform/action-proposals/p1`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'confirmed', edited_value: { type: 'text', value: '人改过的' } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.ok, true);
      // **只判 200 是空判据** —— P-⑨ 实测踩过：edited_value 被静默丢弃，请求照样 200。
      // 这里要核的是「真的转发下去了」，且是**内核那个口**（同 GET 的空判据教训：
      // 子串匹配会放过 `files.action_proposal_resolve`）。
      const hit = seen.find((s) => s.includes('shangshu_core.public_api.http.action_proposal_resolve'));
      assert.ok(hit, `转发记录里没有内核的 action_proposal_resolve：${seen}`);
      assert.ok(!seen.some((s) => s.includes('files.action_proposal_resolve')),
        `不许转发到领域自己的 resolve：${seen}`);
      assert.ok(!seen.some((s) => s.includes('edited_value')), '不该在 URL 里带 edited_value');
    }, (method) => method.endsWith('action_proposal_resolve')
      ? { id: 'p1', status: 'confirmed' } : null);
  });

  it('新路径不在旧口白名单上（旧口删了它还在）；反例：旧路径确实在', async () => {
    // **这条是本段的要害**：判据只验「能调通」不够 —— 旧口今天也能调通。
    // 要钉的是**这条路径不依赖旧口**，所以最后一批删 `/api/confirmations` 时它还活着。
    //
    // ⚠️ **传给闸门的路径是去掉 `/api` 前缀的那段** —— 闸门挂在 `app.use('/api', …)` 上，
    // Express 的 `req.path` 已经剥掉挂载点。所以白名单里写的是 `/confirmations`，
    // 不是 `/api/confirmations`。（判据自己先写错过一回：传全路径，反例自检恒假。）
    assert.equal(isPlatformLegacyPathAllowed('/platform/action-proposals'), false,
      '新路径不许挂进旧口白名单 —— 挂进去就等于又欠一笔删除债');
    assert.equal(isPlatformLegacyPathAllowed('/confirmations'), true,
      '反例自检：旧路径确实在白名单上（证明上面那条不是恒假的空判据）');
  });

  it('反例自检：迁移期旧路径 /api/confirmations 照旧能用', async () => {
    // **为什么要有这条**：新旧两条在迁移期要**并存**。我只该加新路径，不许顺手把旧的弄坏
    // ——旧路径还供着 mail-center.js / real-invoice.js / real-chat.js 共 8 处调用。
    //
    // **夹具说明（不是放宽期望）**：旧路径的 handler 比新路径多一层依赖 ——
    // `withCollaborationIdentity` 要读平台身份（`public_api.http.session` / `.people`）。
    // 假上游得把这两个口也答上，否则 500 是**夹具缺东西**，不是「旧路径坏了」。
    await withFrappeUpstream(async (base) => {
      const res = await fetch(`${base}/api/confirmations`);
      assert.equal(res.status, 200, '旧路径在迁移期不许先断 —— 换完 4 处再删');
      const body = await res.json() as any;
      assert.ok(Array.isArray(body.list), '旧路径回包形状不变（别顺手改坏）');
    }, (method) => (method.endsWith('action_proposals') ? [PROPOSAL] : null));
    // 身份两个口（session/people）由 `withFrappeUpstream` 统一答 —— 那是所有 BFF 路由的
    // 公共依赖，不在每个用例里复制一份（公共工具只留一份）。
  });
});
