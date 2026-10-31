/**
 * 判据：**开表那一趟，「受管/必填列清单」只拉一次**（2026-10-30）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「开一张 xlsx 表 ⇒ `files.promotion_definition` **只发一次请求**
 *   （不是两次），
 *   而**星号与红底照样早几百毫秒上屏**（不等读表完）——
 *   **既要快，又不许拉两遍**。」
 *
 * ⚠️ **为什么要有这条**（实测出来的，2026-10-30 12:2x）：
 *   开表那一趟 `promotion_definition` **发了两次**（+774ms 与 +1772ms）
 *   —— 一次是「并行那份」（`earlyPromotion`，`await openTable()` **之前**发的），
 *   一次是「开表后那份」（`promotionPromise`，`await openTable()` **之后**发的）。
 *   ⚠️ **后那次本该复用前那个 promise** ⇒ 缓存当时还没填 ⇒ 又拉了一遍。
 *   ⇒ 两次都打同一个服务端（晋升定义是**算出来的**，不便宜）。
 *
 * ⚠️ **不许退回串行**：不能为了「只拉一次」把并行那份取消掉
 *   ⇒ 星号与红底会退回「等读表完才到」（旧产物上这段差 0–4.6 秒）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MAIN = new URL('../src/main.ts', import.meta.url);
const source = fs.readFileSync(MAIN, 'utf8');

test('① 开表那一趟，「受管/必填列清单」**只拉一次**', () => {
  /* —— 「并行那份」在 `await openTable()` 之前发起 ——
     ⇒ 后面那次**必须复用同一个 promise**，不能重新发起。 */
  const earlyAt = source.indexOf('const earlyPromotion =');
  assert.ok(earlyAt >= 0, '找不到并行那份（earlyPromotion）');
  const earlyBody = source.slice(earlyAt, earlyAt + 300);
  assert.match(earlyBody, /fetchPromotionDefinition\(key\)/,
    '并行那份不是取晋升定义');

  /* —— 开表后那次：**要么复用 earlyPromotion，要么用缓存** —— */
  const promiseAt = source.indexOf('const promotionPromise =');
  assert.ok(promiseAt >= 0, '找不到 promotionPromise');
  const promiseBody = source.slice(promiseAt, promiseAt + 600);
  assert.match(promiseBody, /earlyPromotion/,
    '开表后那次没有复用 earlyPromotion ⇒ 清单被打两遍');
  /* —— **不许无条件再发起一遍** —— */
  assert.doesNotMatch(promiseBody, /^\s*\?\?\s*\(isXlsxBacked\s*\?\s*fetchPromotionDefinition\(/m,
    '开表后那次**又发起了一遍**取数（earlyPromotion 没被复用）⇒ 同一个接口打两遍');
  /* —— **复用时要对一下表 id**（并行那份拿 `key` 发的，
       这里要的是 `promotionTableId`（`resourceId ?? key`））——
     不一致时**不许复用**（否则拿的是另一张表的清单）。
     ⚠️ 这个判断写在 `promotionPromise` **上面**那几行 ⇒ 往回看一段。 */
  const before = source.slice(Math.max(0, promiseAt - 500), promiseAt);
  assert.match(before, /promotionTableId\s*===\s*key/,
    '复用 earlyPromotion 前没有对表 id ⇒ 可能拿成另一张表的清单');
});

test('② **不许退回串行**（并行那份还在，早几百毫秒上屏这件事没丢）', () => {
  assert.match(source, /earlySource\s*===\s*'xlsx'\s*\?\s*fetchPromotionDefinition\(key\)\s*:\s*null/,
    '并行那份被去掉了 ⇒ 星号与红底要等读表完才到（旧产物上差 0–4.6 秒）');
  /* —— 并行那份要在 `await openTable()` **之前**发起 —— */
  const earlyAt = source.indexOf('const earlyPromotion =');
  const awaitAt = source.indexOf('await openTable(', earlyAt);
  assert.ok(awaitAt > earlyAt,
    '并行那份在 `await openTable()` 之后才发起 ⇒ 没有「早几百毫秒」那回事了');
});

test('③ 清单到货**仍要重跑一次自检**（否则第一次框红要等到下一次刷新）', () => {
  assert.match(source, /applyPromotionDefinition/,
    '找不到 applyPromotionDefinition');
  const body = source.slice(source.indexOf('function applyPromotionDefinition'));
  assert.match(body.slice(0, 1400), /refreshRequiredEmptyMarks/,
    '清单到货后没有重跑自检 ⇒ 必填空的红框要等下一次刷新才出来');
});
