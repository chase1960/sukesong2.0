// 判据：侧栏那份**应用清单**的读口 —— **并发的调用只发一次**。
//
// **测试通过 =**（一句话）
// 「**同时**叫 5 次『刷新侧栏的应用清单』⇒ 那个读口**只被叫了 1 次**（不是 5 次）；
//   这一轮结束之后**再叫一次** ⇒ **又发 1 次**（不是从此永远不发 ——
//   那样就成了缓存，清单就永远不更新了）。」
//
// 为什么要有这条（2026-10-24 夜班站上实测，证据在开发日志 75 号）：
//   `shangshu-web/js/real-applications.js` 的 `refreshApplicationNavigation()` **没有在途去重** ——
//   而它被好几个地方叫：`app.js` 的 `renderChrome()`（侧栏每重画一次叫一次，**全站有 9 个调用点**）、
//   域声明受管对象到达时、发布之后、还有「重新加载」那个按钮。
//   ⇒ **每打开一个页面，那个同一个接口就被并发发 6～7 次**（站上 frappe 访问日志实测）。
//   ⇒ 并发排在同一个接口上 ⇒ **每个请求的耗时从 0.5 秒一路涨到 8.5 秒**（浏览器网络面板实测），
//   页面自己要的那一份也跟着排在后面 ⇒ **页面打开得慢，还偶发失败**。
//   ⇒ 在途去重：**同时**来的调用方**共用那一次**（不是各发各的）；**不是缓存** ——
//     这一轮结束后再叫，还是会再读一次（清单得能更新）。
//
// ⚠️ 判据断的是**行为**（那个读口被叫了几次），不是断源码里有没有某个字符串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApplicationsShell } from './helpers/real-applications-shell.mjs';

const LIST_PATH = '/api/platform/applications?summary=1';

/** 一个**慢**的回包（慢才让并发真的撞上 ⇒ 才测得出「在途去重」）。 */
function slowApi(calls) {
  return async (path) => {
    calls.push(String(path));
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, list: [{ id: 'APP-1', title: '邮件中心', source: 'domain', icon: 'mail' }] }),
    };
  };
}

test('① 并发叫 5 次「刷新侧栏的应用清单」⇒ 那个读口只被叫 1 次；这一轮结束后再叫 ⇒ 又发 1 次', async () => {
  const calls = [];
  const { context } = loadApplicationsShell({ api: slowApi(calls) });

  /* —— 同时叫 5 次（**不 await** ⇒ 它们真的并发）—— */
  const running = [];
  for (let round = 0; round < 5; round += 1) {
    running.push(context.refreshApplicationNavigation());
  }
  await Promise.all(running);

  assert.equal(calls.length, 1,
    '并发的 5 次叫出了 ' + calls.length + ' 次请求（那个同一个接口）—— '
    + '并发的调用方应当**共用那一次**，不是各发各的');

  /* —— 这一轮结束后再叫一次 ⇒ **又发 1 次**（不许变成永久缓存）—— */
  await context.refreshApplicationNavigation();
  assert.equal(calls.length, 2,
    '第二轮没有再读 ⇒ 那份清单从此不再更新了（**去重只限在途，不是不缓存**）');
});

test('② 带着现成清单来的时候**不读**（老规矩没动）', async () => {
  const calls = [];
  const { context } = loadApplicationsShell({ api: slowApi(calls) });
  await context.refreshApplicationNavigation([{ id: 'APP-2', title: '订单管理', source: 'domain' }]);
  assert.equal(calls.length, 0, '调用方已经给了清单，还去读了一次');
});

test('重画侧栏复用同身份清单，显式刷新和失效重新读', async () => {
  const {context,calls}=loadApplicationsShell();
  await context.refreshApplicationNavigation(undefined,{reuse:true});
  await context.refreshApplicationNavigation(undefined,{reuse:true});
  assert.equal(calls.length,1,'重画已有导航不应再次读取全目录');
  await context.refreshApplicationNavigation();
  assert.equal(calls.length,2,'显式刷新仍需实时读取');
  context.shangshuInvalidateApplicationNavigation();
  await context.refreshApplicationNavigation(undefined,{reuse:true});
  assert.equal(calls.length,3,'发布或启停失效后不能沿用旧快照');
});

test('切换身份不能复用另一人的侧栏清单', async () => {
  const {context,calls}=loadApplicationsShell();
  await context.refreshApplicationNavigation(undefined,{reuse:true});
  context.currentUserInfo={role:'staff',username:'another'};
  await context.refreshApplicationNavigation(undefined,{reuse:true});
  assert.equal(calls.length,2);
});
