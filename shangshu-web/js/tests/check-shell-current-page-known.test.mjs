// 判据：**开机那一趟，域问得到「壳要去哪一页」**（2026-10-30）。
//
// **测试通过 = 什么成立**（一句话）
// 「壳**刚加载完、还没换页**的时候 ⇒ `window.shangshuCurrentPage()` **给得出那一页**
//   （不是空）⇒ 域（邮件审核队列那类）在**开机那趟短暂挂载**时
//   **判得出「这不是我要的那一页」** ⇒ **不白拉**那份待审清单。」
//
// ⚠️ **为什么要有这条**（2026-10-30 用户授权「连开机那趟也省」）：
//   壳的 `go(初始页)` 跑在**脚本加载之后** ⇒ 域（邮件审核队列）**在脚本加载时**就挂了一次
//   ⇒ 那时壳的「当前页」是**空的** ⇒ 域**判不出** ⇒ 照拉 `action-proposals?limit=200`
//   ⇒ **表格页白花开销**（表格页根本用不着邮件的待审清单）。
//   ⇒ 壳在 `go()` 之前**已经把「要去哪一页」算出来了**（`initial`）⇒ 把它先记上。
//
// ⚠️ **不许拿「还没进页」当借口**：判不出就照拉是对的（宁可多拉一次），
//   但**壳明明知道要去哪一页**（`initial` 已算好）⇒ 那就不该让域猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = new URL('../app.js', import.meta.url);
const source = fs.readFileSync(APP, 'utf8');

test('① 壳**在 `go()` 之前**就把「要去哪一页」记上（开机那趟域才问得到）', () => {
  /* —— `initial` 是壳算出来的初始页 ⇒ 必须在 `go(initial)` **之前**记进「当前页」 —— */
  const initialAt = source.indexOf('const initial =');
  assert.ok(initialAt >= 0, 'app.js 里找不到 initial（壳算初始页那一句）');
  const goAt = source.indexOf('go(initial)', initialAt);
  assert.ok(goAt > initialAt, '找不到 go(initial)');
  const between = source.slice(initialAt, goAt);
  assert.match(between, /curPageId\s*=\s*String\(initial/,
    '在 `go(initial)` **之前**没有把 initial 记进「当前页」'
    + ' ⇒ 开机那趟（域在脚本加载时就挂了）问不到「要去哪一页」⇒ 判不出 ⇒ 白拉那份清单');
});

test('② 壳给的那个口：**知道要去哪一页时给得出值**（判不出才给 null）', () => {
  /* —— 「两样都空 ⇒ 返回 null」**本身是对的**（判不出就明说判不出）——
     开机那趟的问题不是这个口，是**那时 `curPageId` 也空**（`go()` 还没跑）。
     ⇒ 这里钉的是：**`curPageId` 一有值，口就得给得出 `page`**（不许有值也给 null）。 —— */
  const fnAt = source.indexOf('window.shangshuCurrentPage =');
  assert.ok(fnAt >= 0, 'app.js 里没有 window.shangshuCurrentPage 这个口');
  const body = source.slice(fnAt, fnAt + 700);
  assert.match(body, /page:\s*curPageId\s*\|\|\s*curMod/,
    '那个口没有把「当前页」（curPageId）给出去');
  assert.doesNotMatch(body, /page:\s*curMod\s*\|\|\s*curPageId/,
    '那个口给的是实现页优先 ⇒ 别名页（`ip.<域>.cases`）在域那边认不出来');
});

test('③ 换页时「当前页」照旧跟着换（不许为了开机那趟把它钉死）', () => {
  /* —— `go()` 里那一行「记当前页」必须还在 —— */
  assert.match(source, /curPageId\s*=\s*String\(requestedMod\s*\|\|\s*mod\)/,
    'go() 里没有按「被请求的页」记当前页 ⇒ 换页后域问到的还是旧页');
});
