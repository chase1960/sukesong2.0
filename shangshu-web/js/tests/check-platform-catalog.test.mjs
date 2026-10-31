// 判据：**平台的清单（域的受管对象 / 域的动作 / 域的应用）同一轮里只读一次**。
//
// **测试通过 =**（一句话）
// 「两个地方同时要同一份清单 ⇒ **只发一次请求**、两边拿到的是**同一份**；
//   读失败 ⇒ **不留坏缓存**（下一次会重新读，不会一直拿着那个错）；
//   显式作废后 ⇒ 重新发一次；过了复用期 ⇒ 重新发一次。」
//
// **改之前**：开一张业务表实测（浏览器网络面板）——
//   受管对象清单 `/api/platform/objects` 拉 **2 遍**（域入口 ＋ 表格部件），
//   动作清单 `/api/platform/actions` 拉 **3 遍**（excel 域每次挂载都问服务端
//   「这个动作我能不能用」），应用清单 `/api/platform/applications` 拉 **2 遍**
//   ⇒ 人看着像「业务域又装了一遍」
//   （用户 2026-10-25 原话：「为什么总是会把业务域重新加载一遍」）。
//   ⚠️ 域的**代码**并没有每次重装（域脚本整页加载时执行一次；后端域只在 migrate 时
//   import 一次）—— 重的是**清单**。
// **改之后**：同一轮里每个清单**只发一次**，其余调用共用那一份。
// **怎么看**：浏览器打开 `http://127.0.0.1:3850/` ⇒ 点侧栏「example 邮件模板」
//   ⇒ 网络面板里 `/api/platform/actions`、`/api/platform/objects` 各**一条**
//   （改之前是 3 条 ＋ 2 条）。
//
// ⚠️ **判据怎么跑的**：**不是**读源码找字符串 —— 把 `app.js` 里那个「清单口」
//   **原样切出来**，在 `node:vm` 里**真跑一遍**（照 `check-sidebar-alias-highlight.test.mjs`
//   的老套路）。假上下文只给它真正用到的那几样：`window`／`fetch`／`Date`。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const appSource = fs.readFileSync(new URL('shangshu-web/js/app.js', ROOT), 'utf8');

/** 从 app.js 里切出一段（原样，不另造一套）。 */
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `app.js 里找不到起始标记：${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `app.js 里找不到结束标记：${to}`);
  return source.slice(start, end);
}

/* 「清单口」那一段（原样切出来）。 */
const PORT = slice(appSource, 'window.shangshuPlatformCatalog = (() => {', '\n})();') + '\n})();';

/**
 * 跑一遍那个「清单口」，回它的三个读法 ＋ 假 fetch 的调用记录。
 *
 * @param {object} o
 * @param {Function} o.fetchImpl 假 fetch（记调用次数与路径）
 * @param {Function} o.clock     假时钟（返回当前毫秒）
 */
function runPort({ fetchImpl, clock = () => 0 }) {
  const calls = [];
  const context = {
    fetch: (url) => {
      calls.push(url);
      return fetchImpl(url, calls.length);
    },
    Date: { now: () => clock() },
    Error,
    Promise,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(PORT, context);
  return { catalog: context.window.shangshuPlatformCatalog, calls, context };
}

/** 假服务器：成功时给一份清单。 */
function okFetch(payload) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

test('身份切换不复用旧清单，旧身份迟到失败不清掉新清单',async()=>{
  let rejectOld;
  const old=new Promise((_resolve,reject)=>{rejectOld=reject;});
  const {catalog,calls,context}=runPort({fetchImpl:(_url,count)=>count===1?old:okFetch({list:['new-user']})()});
  context.currentUserInfo={username:'old'};
  const running=catalog.objects();
  context.currentUserInfo={username:'new'};
  const fresh=await catalog.objects();
  rejectOld(Error('旧会话读取失败'));
  await assert.rejects(running,/旧会话/);
  assert.equal(await catalog.objects(),fresh);
  assert.equal(calls.length,2);
});

/* —— ⚠️ **2026-10-28 15:3x（站上实测：应用清单被读了**三遍**）**：
 *   病根是**身份从「还没有」变成「是谁」**（页面刚开，登录信息后到）
 *   ⇒ 清单口把**在途的那一次**当成「换人了」作废 ⇒ 同一轮里发了两次。
 *   ⚠️ 「从没有到有」**不是换人**，是**同一轮**⇒ 不许作废在途的那一次。 */
test('身份从「还没有」变成「是谁」（同一轮，不是换人）⇒ 不许作废在途的那一次', async () => {
  const { catalog, calls, context } = runPort({
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    },
  });
  /* 域脚本在登录信息到达**前**就重画了侧栏 ⇒ 清单口先被叫了一次（这时还不知道是谁）。 */
  const first = catalog.applications();
  /* 登录信息到了（同一轮，不是换人）。 */
  context.currentUserInfo = { username: 'tester' };
  const second = await catalog.applications();
  assert.equal(calls.length, 1, `同一轮里发了 ${calls.length} 次请求（改之前是 2 次）`);
  /* ⚠️ 比的是**读回来的那一份**（`await` 之后是值，不是 promise）。 */
  assert.deepEqual(second, await first, '两处拿到的不是同一份');
});

/* ───────────────── ① 同一轮里同一个清单只读一次 ───────────────── */
test('① 两个地方同时要同一份清单 ⇒ 只发一次请求，两边拿到的是同一份', async () => {
  const payload = { ok: true, list: [{ id: 'com.shangshu.app.x.object.1' }] };
  const { catalog, calls } = runPort({ fetchImpl: okFetch(payload) });
  const [first, second] = await Promise.all([catalog.objects(), catalog.objects()]);
  assert.equal(calls.length, 1, `同一个清单发了 ${calls.length} 次请求（改之前是两处各发一次）`);
  assert.equal(first, second, '两处拿到的不是同一份（没有共用那一次读的结果）');
  assert.deepEqual(first.list, payload.list, '拿到的清单内容不对');
});

/* ───────────────── ② 三个清单各读一次，互不串 ───────────────── */
test('② 受管对象清单 / 动作清单 / 应用清单各读一次，互不串', async () => {
  const { catalog, calls } = runPort({
    fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ ok: true, list: [url] }) }),
  });
  await Promise.all([catalog.objects(), catalog.actions(), catalog.applications()]);
  assert.equal(calls.length, 3, `三个清单发了 ${calls.length} 次`);
  assert.deepEqual([...calls].sort(), [
    '/api/platform/actions',
    '/api/platform/applications?summary=1',
    '/api/platform/objects',
  ].sort(), '拉的不是这三个清单口');
});

/* ───────────────── ③ 读失败不留坏缓存 ───────────────── */
test('③ 清单读失败 ⇒ 不留坏缓存（下一次会重新读，不会一直拿着那个错）', async () => {
  let attempt = 0;
  const { catalog, calls } = runPort({
    fetchImpl: async () => {
      attempt++;
      if (attempt === 1) return { ok: false, status: 500, json: async () => ({ ok: false, error: '服务端炸了' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [{ id: 'a' }] }) };
    },
  });
  await assert.rejects(() => catalog.objects(), /服务端炸了|读不到清单/, '第一次读失败本该报错');
  assert.equal(calls.length, 1, '第一次只该发一次');
  const again = await catalog.objects();
  assert.equal(calls.length, 2, `失败之后没有重新读（还是拿着第一次那个坏结果，共 ${calls.length} 次请求）`);
  assert.deepEqual(again.list, [{ id: 'a' }], '重新读到的清单内容不对');
});

/* ───────────────── ④ 显式作废后重新读 ───────────────── */
test('④ 某个清单变了（新建/退役/发布/权限变）⇒ 显式作废后重新读一次', async () => {
  const { catalog, calls } = runPort({ fetchImpl: okFetch({ ok: true, list: [] }) });
  await catalog.objects();
  assert.equal(calls.length, 1);
  catalog.invalidate('objects');
  await catalog.objects();
  assert.equal(calls.length, 2, '作废之后还是用的旧那一份');
});

/* ───────────────── ⑤ 过了复用期重新读 ───────────────── */
test('⑤ 过了复用期（动作能不能用会随权限变 ⇒ 不能永久缓存）⇒ 重新读一次', async () => {
  let now = 1000;
  const { catalog, calls } = runPort({ fetchImpl: okFetch({ ok: true, list: [] }), clock: () => now });
  await catalog.actions();
  assert.equal(calls.length, 1);
  now += 60000;                       // 一分钟以后
  await catalog.actions();
  assert.equal(calls.length, 2, '过了复用期还是用的旧那一份（清单被永久缓存了）');
});


test('导航应用目录只请求摘要，不下载字段和流程定义', async () => {
  const {catalog, calls} = runPort({fetchImpl: okFetch({ok:true,list:[]})});
  await catalog.applications();
  assert.equal(calls[0], '/api/platform/applications?summary=1');
});
