// 判据：页面加载态 —— 一律用**会呼吸的骨架**，不许用文字。
//
// **测试通过 =**（一句话）
// 「页面还在加载的时候，人眼里是**会呼吸的灰底骨架**，**一个字都没有**；
//   骨架的呼吸**只有一份实现**（公共样式那一条），审核中心那句「正在读取…」已经撤掉；
//   契约点名的那几页源码里，也没有加载态的文字。」
//
// **为什么要有这条**（用户 2026-10-28 指示）：
//   「把审核中心上的正在读取去掉；写一个契约，因为我们有一个骨架代码，
//     所以每一个页面的加载都不要用文字了，都用骨架代码的呼吸来代替」
//   ⇒ 契约落在 `frappe_apps/shangshu_core/shangshu_core/contracts/loading-state-v1.json`。
//
// ⚠️ **判据断的是行为**（页面上有没有字、有没有会呼吸的骨架），不是断源码里有没有某个字符串。
//   例外只有一处：**契约点名的那几页**断的是源码里那句加载文字不许再写（写死了哪一句）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, pageHost, settle as settleReview } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const readSource = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const CONTRACT_REL = 'frappe_apps/shangshu_core/shangshu_core/contracts/loading-state-v1.json';
const PLATFORM_CSS_REL = 'shangshu-web/css/platform.css';
const REVIEW_CSS_REL = 'shangshu-web/css/review-center.css';

/**
 * **页面加载态不许写的话**（按文件点名）。
 *
 * ⚠️ **只点看得见的加载态** —— 这几样**不是**加载态，契约里写明了它们各归各：
 *   · **读失败的提示**（那是错误，要说人话）；
 *   · **空态**（读回来了，确实没有）；
 *   · **控件里的占位**（`<select>` 里那一条临时选项、按钮自己的忙碌态 —— 控件里放不下骨架）；
 *   · **读屏那一层的一句「正在读取…」**（公共类 `.platform-skeleton-status` 把它收得看不见）。
 */
const PAGE_LOADING_TEXT = [
  /* ⚠️ **审核中心不在这一张表里** —— 它的加载态是**读屏那一层**的一句「正在读取…」
   *   （公共类 `.platform-skeleton-status`：视觉上收起来）⇒ 上面 ③ 那条**断的是渲染出来的页面**
   *   （看得见的部分一个字都没有）。 */
  ['shangshu-web/js/personal-settings.js', ['正在读取当前账号']],
  ['shangshu-web/js/proposal-review.js', ['读取中', '正在读取原记录']],
  ['shangshu-web/js/real-chat.js', ['正在加载历史对话', '正在读取实际状态', '正在读取本次操作的真实内容', '正在读取当前状态']],
  ['shangshu-web/js/real-im.js', ['正在读取消息', '正在读取原消息', '正在读取…']],
  ['shangshu-web/js/file-reference-picker.js', ['正在读取…']],
  ['shangshu-web/js/file-pdf.mjs', ['正在加载PDF阅读器']],
  ['shangshu-web/js/sheet-center.js', ['正在读取数据表']],
  ['shangshu-web/js/real-erp.js', ['加载中…']],
  ['shangshu-web/js/real-accounting.js', ['加载中…']],
  ['shangshu-web/js/real-ai-tools.js', ['加载中…']],
  ['shangshu-web/js/domains/finance-process.js', ['正在读取流程实例']],
  ['shangshu-web/js/domains/example-domain/example-domain-review-center.js', ['案件表加载中']],
  ['shangshu-web/js/file-center.js', ['正在读取文件']],
  ['shangshu-web/js/mail-center.js', ['正在读取待审候选', '正在读取邮件列表']],
  ['shangshu-web/js/resource-attribution.mjs', ['正在读取']],
  ['shangshu-web/js/forms.js', ['正在读取…']],
];

/* ───────────────── ① 契约在，而且说的是「骨架不是文字」 ───────────────── */

test('① 契约在（loading-state-v1.json），并且写的是「加载态＝骨架，不是文字」', () => {
  const contract = JSON.parse(readSource(CONTRACT_REL));
  assert.equal(contract.contract, 'loading-state', '契约名不对');
  assert.match(String(contract.summary), /骨架/, '契约没说骨架');
  assert.match(String(contract.summary), /不许用文字|不用文字/, '契约没说「不许用文字」');
  /* 不许做的事里，**必须**有一条点名「加载态不许写加载文字」。 */
  const rules = (contract.never && contract.never.rules) || [];
  assert.ok(rules.some(rule => /加载态/.test(rule) && /文字/.test(rule)),
    `契约的「不许做的事」里没有「加载态不许写文字」那一条：${rules.join(' / ')}`);
  /* 骨架怎么标、怎么呼吸，契约里都要写清楚（不然各页各写一套）。 */
  assert.match(String(contract.rule && contract.rule.marker), /data-skeleton/,
    '契约没写骨架的标记（data-skeleton）');
  assert.match(String(contract.skeleton_parts && contract.skeleton_parts.animation), /keyframes/,
    '契约没写呼吸动画是哪一条');
  /* 契约要说明**哪些不是加载态**（不然「空态」「错误」也会被误伤）。 */
  assert.ok(Array.isArray(contract.not_covered && contract.not_covered.items),
    '契约没说清楚哪些不是加载态');
});

/* ───────────────── ② 骨架会呼吸，而且呼吸只有一份实现 ───────────────── */

test('② 骨架会呼吸：两族骨架共用**同一个**呼吸动画（一份实现）', () => {
  const platformCss = readSource(PLATFORM_CSS_REL);
  const reviewCss = readSource(REVIEW_CSS_REL);

  /* 呼吸的关键帧在公共样式里（各处不另写）。 */
  const keyframes = platformCss.match(/@keyframes\s+([\w-]*skeleton[\w-]*)/gi) || [];
  assert.equal(keyframes.length, 1,
    `公共样式里有 ${keyframes.length} 个骨架呼吸关键帧（${keyframes.join('、')}）⇒ 呼吸不止一份实现`);
  const name = (keyframes[0].match(/@keyframes\s+([\w-]+)/) || [])[1];
  assert.ok(name, '没看出呼吸动画叫什么');

  /* 两族灰条都挂上那一条。 */
  const breathing = platformCss.match(/[^{}]*\{[^{}]*animation\s*:[^;}]*breathe[^;}]*[^{}]*\}/gi) || [];
  const joined = breathing.join('\n');
  assert.match(joined, /\.platform-skeleton-bar/, '公共族的灰条没挂呼吸');
  assert.match(joined, /\.review-skeleton-bar/, '审核中心那一族的灰条没挂呼吸');

  /* 审核中心自己那份样式里**不许**另写一套呼吸（那就是两份实现了）。 */
  assert.doesNotMatch(reviewCss, /@keyframes[^{]*skeleton/i,
    '审核中心那份样式里自己又写了一套骨架呼吸 ⇒ 呼吸不止一份实现');
});

/* ───────────────── ③ 审核中心：加载态是骨架，一个字都没有 ───────────────── */

test('③ 审核中心：卡还没到 ⇒ 加载态是**会呼吸的骨架**，不是那句「正在读取…」', async () => {
  const dom = createDom();
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const { window } = loadShell(dom);
  /* 这一档的清单**一直不回来** ⇒ 页面停在「正在取数」那一刻。 */
  registerSampleDeclaration(window, { list: async () => { await gate; return [sampleCard()]; } });
  const host = pageHost(dom);
  const mounting = window.shangshuReviewCenter.mountPage(host, {});
  await settleReview();

  /* 加载标记还在（人知道它在等），但**看得见的部分一个字都没有**。 */
  const loading = dom.body.querySelector('[data-review-loading]');
  assert.ok(loading, '审核中心连加载标记都没有了 ⇒ 人不知道它在等');
  /* 它是**骨架**（有灰条），不是空壳。 */
  assert.ok(loading.querySelector('.platform-skeleton-bar, .review-skeleton-bar'),
    '加载态不是骨架（没有灰条）⇒ 人看见的是一片空白');
  assert.ok(loading.getAttribute('data-skeleton'), '加载骨架没有 data-skeleton 标记');
  /* **看得见的字**一个字都不许有 —— 有的话只能躲在读屏那一层（`.platform-skeleton-status`）。 */
  const visibleText = [...loading.childNodes]
    .filter(node => node.nodeType === 3)
    .map(node => String(node.textContent || '').trim())
    .join(' ')
    .trim();
  assert.equal(visibleText, '', '加载态里还看得见字：' + visibleText);
  [...loading.querySelectorAll('.platform-skeleton-bar, .review-skeleton-bar, .platform-skeleton-status')]
    .forEach(node => {
      if (node.closest('.platform-skeleton-status')) return;
      const text = String(node.textContent || '').trim();
      assert.equal(text, '', '加载态里还看得见字（不是读屏那一层）：' + text);
    });
  /* 读屏那一层留一句「正在读取…」—— 读屏的人看不见灰条的起伏，得知道他「在等」。 */
  const forScreen = loading.querySelector('.platform-skeleton-status');
  assert.ok(forScreen, '加载态里没有给读屏的那一句 ⇒ 读屏的人不知道页面在等');
  /* 它**看得见**的话就不成 ⇒ 公共类必须把它收起来。 */
  const platformCss = readSource(PLATFORM_CSS_REL);
  assert.match(platformCss, /\.platform-skeleton-status\{[^}]*clip-path:inset\(50%\)/,
    '公共类 `.platform-skeleton-status` 没把读屏那句收起来 ⇒ 那句话会被人看见');
  /* 它不住在卡片网格里（不占卡位）。 */
  assert.ok(!loading.closest('[data-review-card-grid]'),
    '加载态跑进卡片区里了（占卡位、把下面的卡挤歪）');

  /* 数据到了 ⇒ 加载标记撤掉，卡原位换上。 */
  release();
  await mounting;
  await settleReview();
  assert.ok(!dom.body.querySelector('[data-review-loading]'),
    '读完了加载标记还挂在页面上');
});

/* ───────────────── ④ 契约点名的那几页：源码里不许再写加载文字 ───────────────── */

test('④ 契约点名的那几页：页面加载态不许再写文字', () => {
  for (const [file, phrases] of PAGE_LOADING_TEXT) {
    const source = readSource(file);
    for (const phrase of phrases) {
      assert.ok(!source.includes(phrase),
        `${file} 里还写着「${phrase}」⇒ 加载态还在用文字（契约 loading-state-v1.json）`);
    }
  }
});
