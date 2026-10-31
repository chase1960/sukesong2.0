// 判据：预览页那两份样例的**定位提示（段号）得是数** —— 不许写成「第 1 段」那种文字。
//
// （PKG-067-T01 · 2026-10-23 **自己上 3850 站看时抓到的一处真缺陷**：
//   预览页上印出「定位：第 1 页 · 首页 · **第 第 1 段 段**」——
//   壳那行是 `'第 ' + paragraph + ' 段'`（**段号是数**），
//   而预览页的样例数据把段号写成了文字 `'第 1 段'` ⇒ 拼出双前缀。
//   **是样例页数据不对，不是壳错** —— 生产 example 那条路给的是
//   `locator:{kind:'file',file,table,row}` ⇒ 那里显示的是「定位：未给出」。）
//
// **测试通过 =**（一句话）
// 「预览页那两份样例的段号**是数**（不是「第 1 段」那种文字）⇒
//   把样例里那个值**真的摆进壳里渲染一遍**，弹窗里那一行定位**读得通**
//   （`定位：第 1 页 · 首页 · 第 1 段`），**没有「第 第 … 段 段」这种双前缀**。」
//
// ⚠️ 第二条**不是读源码找字符串** —— 它把**样例里那个字面量的真实值**
//   （不替换、不洗白）喂给壳，看壳**真的印出什么**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle, fileCenterVersions } from './helpers/review-center-shell.mjs';

const previewSource = fs.readFileSync(new URL('../../review-center-preview.html', import.meta.url), 'utf8');

/** 样例数据里所有的「段号」原文（`paragraph:` 后面那一段字面量，原文照抄，不解析）。 */
const paragraphLiterals = [...previewSource.matchAll(/paragraph:\s*([^,}\n]+)/g)].map(m => m[1].trim());

test('① 预览页那两份样例的**段号是数**（不许写成「第 1 段」那种文字）', () => {
  assert.ok(paragraphLiterals.length >= 2,
    '预览页里没找到样例的段号（样例改掉了？）：找到 ' + paragraphLiterals.length + ' 处');
  for (const literal of paragraphLiterals) {
    assert.match(literal, /^\d+$/,
      '段号不是数：' + literal + '（壳那行是「\'第 \' + paragraph + \' 段\'」⇒ 文字会被印成「第 第 1 段 段」）');
  }
});

test('② 把样例那个段号**真的摆进壳里渲染一遍** ⇒ 定位那一行读得通（没有双前缀）', async () => {
  /* 用**样例里那个字面量的真实值** —— 样例写错了，这一行就会印出双前缀。 */
  const literal = paragraphLiterals[0];
  const paragraph = vm.runInNewContext('(' + literal + ')');

  const dom = createDom();
  const { window } = loadShell(dom, { readFileCenterVersions: fileCenterVersions });
  registerSampleDeclaration(window, {
    list: async () => [sampleCard({
      evidence: [{
        id: 'ev-1',
        name: '受理通知书.pdf',
        type: 'pdf',
        required: true,
        available: true,
        reference: 'FILE-1',
        locator: { page: 1, region: '首页', paragraph },
      }],
    })],
  });
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();

  dom.body.querySelector('[data-review-card-open]').dispatchEvent({ type: 'click' });
  await settle();

  /* ⚠️ **判据改口**（PKG-132 · 用户 2026-10-27 20:31 实拍后要求去掉那一行）：
     *   右栏**摆的是原件本体**（PDF 就嵌在上面）⇒「定位：第 N 页 · 首页 · 第 N 段」
     *   是**重复描述**（原件自己的阅读器管翻页）⇒ **那一行去掉**。
     *   ⇒ 这里断的是「**定位那一行不再出现**」，并且**别的地方也不许补一句同样的描述**。 */
  const locator = dom.body.querySelector('.review-pdf-locator');
  assert.equal(locator, null, '右栏还在印「定位：第 N 页…」那一行（用户已要求去掉）');
  assert.doesNotMatch(String(dom.body.textContent), /定位：/,
    '页面上还有别的「定位：」那一行描述');
  assert.doesNotMatch(String(dom.body.textContent), /第 1 页 · 首页 · 第 1 段/,
    '页面上还印着那一串「第 1 页 · 首页 · 第 1 段」');
});
