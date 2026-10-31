// 判据：全站**页标题**（`.page-hd` 那一族）的字号与行高**同一个数**（用户 2026-10-22 21:25：
// 「工作台的标题感觉高度和其他的不对」）。
//
// **测试通过 =**（一句话）
// 「**任何页面的页标题都是 20px**（与参照系文件中心 `.file-heading h1` 同一个数），
//   **上下外边距都是 0**（标题的位置由页面容器给，不由 h1 自己顶开），
//   ⇒ 页标题的**高度与位置**全站一致 —— 工作台不再比别的页大一圈。」
//
// ⚠️ **病根**（查实，不是猜的）：公共壳只写了 `.page-hd h1{font-weight:650}`
//   （`shangshu-web/css/deepseek.css:846`）—— **没定字号** ⇒ 浏览器默认 h1 ＝ **2em ＝ 32px**。
//   而域内页（`.example-host-page .page-hd h1`）、审核中心（`.review-center-page .page-hd h1`）、
//   受管表页（`.objects-page>.page-hd h1`）、管理员页（`.admin-page .page-hd h1`）、
//   文件中心（`.file-heading h1`）**全都是 20px** ⇒ 全站**五个数**里只有 `.platform-page` 族
//   （工作台／应用中心／个人设置…）落在 32px。
//   ⇒ 修法是**公共壳给 `.page-hd h1` 定 20px ＋ margin 0**（口径统一），
//     **不是**给工作台单开一条（单开一条＝又立一套口径，明天的散乱就是这么来的）。
//
// 判据断的是**算出来的生效值**（`scripts/lib/css-cascade.mjs`，与检查器同一套），
// 不是「文件里有没有 20px 这几个字」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, px } from '../../../scripts/lib/css-cascade.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);

const WIDE = 1440;
const NARROW = 600;

/** 全站页标题的标准字号＝参照系（文件中心标题）那个数。 */
const TITLE_SIZE = 20;

const resolve = (selector, property, viewport = WIDE) => {
  const hit = resolver.resolve(selector, property, { viewport });
  return hit ? hit.value : null;
};

/* ───────────────────────── 参照系（不许动） ───────────────────────── */
test('① 参照系：文件中心标题是 20px ＋ margin 0', () => {
  const size = resolve('.file-center-page .file-heading h1', 'font-size');
  assert.ok(size, '参照系 `.file-heading h1` 的 font-size 声明不见了');
  assert.equal(px(size), TITLE_SIZE, `参照系标题字号现在是 ${size}`);
  const margin = resolve('.file-center-page .file-heading h1', 'margin');
  assert.ok(margin, '参照系 `.file-heading h1` 的 margin 声明不见了');
  assert.equal(px(margin), 0, `参照系标题的外边距现在是 ${margin}`);
});

/* ───────────────────────── 平台页（这一条是这次要修的） ───────────────────────── */
test('② 平台页的页标题（`.page-hd h1`）也是 20px ＋ margin 0 —— 公共壳定，不许各页单开', () => {
  const size = resolve('.page-hd h1', 'font-size');
  assert.ok(size,
    '`.page-hd h1` **没有字号声明** ⇒ 吃浏览器默认 h1（2em ＝ 32px）—— 工作台标题比别的页大一圈就是这么来的');
  assert.equal(px(size), TITLE_SIZE, `平台页标题字号现在是 ${size}（应与参照系同一个数）`);
  const margin = resolve('.page-hd h1', 'margin');
  assert.ok(margin, '`.page-hd h1` 没有 margin 声明 ⇒ 标题会被 h1 自己的默认外边距顶开');
  assert.equal(px(margin), 0, `平台页标题的外边距现在是 ${margin}`);
});

test('③ 窄屏也是同一个数', () => {
  const size = resolve('.page-hd h1', 'font-size', NARROW);
  assert.ok(size, '`.page-hd h1` 的字号声明不见了');
  assert.equal(px(size), TITLE_SIZE, `窄屏平台页标题字号现在是 ${size}`);
});

/* ───────────────────────── 不许走样 ───────────────────────── */
test('④ 域内页／审核中心／受管表页／管理员页的标题**不受这次改动影响**（都还是 20px）', () => {
  for (const selector of [
    '.example-host-page .page-hd h1',
    '.example-rules-page .page-hd h1',
    '.review-center-page .page-hd h1',
    '.objects-page>.page-hd h1',
    '.admin-page .page-hd h1',
  ]) {
    const size = resolve(selector, 'font-size');
    assert.ok(size, `${selector} 的字号声明不见了`);
    assert.equal(px(size), TITLE_SIZE, `${selector} 的字号现在是 ${size}（应仍是 ${TITLE_SIZE}）`);
  }
});

test('⑤ 不许给某一页**单开**一条标题字号（口径只能有一个地方给）', () => {
  /* 工作台页容器 `.workbench-page` 不许自己定 h1 字号 ——
     否则又变成「每个页一套」，正是这轮要收掉的散乱。 */
  const own = resolve('.workbench-page .page-hd h1', 'font-size');
  assert.ok(!own, '工作台自己给页标题单开了一条字号 —— 口径只能由公共壳 `.page-hd h1` 给');
});

/* ───────────────────────── 页面骨架（PKG-045-T02） ───────────────────────── */
test('⑥ 公共骨架类的标题也是 20px —— 页头条统一后，标题口径仍只有一个出处', () => {
  /* 2026-10-23 PKG-045-T02：全站页头条收成同一副骨架（`.page-heading`，公共壳
     `css/deepseek.css`）⇒ 标题口径跟着骨架走，仍是 20px/650/margin 0。 */
  const size = resolve('.page-heading h1', 'font-size');
  assert.ok(size, '公共骨架类 `.page-heading h1` **没有字号声明**');
  assert.equal(px(size), TITLE_SIZE, `公共骨架的标题字号现在是 ${size}`);
  const margin = resolve('.page-heading h1', 'margin');
  assert.ok(margin, '公共骨架类 `.page-heading h1` 没有 margin 声明');
  assert.equal(px(margin), 0, `公共骨架的标题外边距现在是 ${margin}`);
});

test('⑦ 页头条的高度由骨架给（68px）—— 不许某一族自己再定一个高度', () => {
  /* 病根（2026-10-23）：结构没统一 ⇒ 全站页头条有 6 个高度（32/51/55/32/56/68px）。
     ⇒ 高度只能由公共骨架 `.page-heading` 给（参照系＝邮件中心/Excel 清单页/文件中心）。 */
  const height = resolve('.page-heading', 'height');
  assert.ok(height, '公共骨架类 `.page-heading` **没有高度声明**');
  assert.equal(px(height), 68, `公共骨架的页头条高度现在是 ${height}（应与参照系同一个数 68px）`);
});
