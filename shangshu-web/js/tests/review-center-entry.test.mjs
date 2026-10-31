// 判据：审核中心的**入口与那一页**（用户 2026-10-22 的三次批注 ＋ 18:15 归核心域那次）。
//
// ① 15:21「去掉这个」—— 页顶那条「今日待核对 ｜ 新通知书带来的更新 0 ｜ 官文信息待核对 4 ｜ AI 建议修改 4」横条；
// ② 16:39「审核中心改成一个独立页，用旧项目的那种」—— 横条撤下来之后，入口改到侧栏一个「待核对」按钮；
// ③ 17:48「这个去掉吧」—— **侧栏那个「待核对」按钮也去掉**（审核中心已经有自己的页、自己在侧栏分组里的入口，
//    顶部再挂一个就是重复项；那是弹窗时代的遗留）。
// ④ 18:15「审核中心他不应该归属于知识产权域……他是一道判断闸门」—— **这一页归核心域**（静态注册表）。
//
// **测试通过 =**（一句话）
// 「**任何页面的页顶都不再出现那条「今日待核对」横条**（工作台页、邮件页都没有），
//   **侧栏顶部也不再有那个「待核对」按钮**（连同它的计数徽标），
//   但审核中心**没有被删掉**：它是**自己的一个页**（**静态页面注册表**里查得到、属主是核心域、
//   侧栏「工作」组里有一项、路由认它），
//   **分栏弹窗也还在**（页内还可以开窗核对）；
//   页面注册**不走域注册**（域不注册页面本体），公共壳**不写死任何域的页面 id**。」
//
// ⚠️ **不許「留着不挂」**：入口机制（`mountEntry` / `buildEntry` / 侧栏宿主）**整体撤掉**，
//   不是把它藏起来 —— 留着随时会被挂回侧栏顶上。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDom, h } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registrySource, appSource, shellSource } from './helpers/review-center-shell.mjs';




/** 业务页骨架：页头（`.page-hd`）＋ 邮件页头（`.mail-heading`）＋ 侧栏。 */
function businessPage(dom) {
  const heading = h(dom, 'header', { class: 'page-hd' }, [
    h(dom, 'h1', { text: '工作台' }),
    h(dom, 'button', { class: 'btn btn-pri', text: '新建' }),
  ]);
  const mail = h(dom, 'header', { class: 'mail-heading' }, [h(dom, 'h1', { text: '邮箱' })]);
  const side = h(dom, 'aside', { id: 'side' }, []);
  const scroll = h(dom, 'div', { class: 'main-scroll', 'data-page': 'dash' }, [heading, mail]);
  dom.body.appendChild(side);
  dom.body.appendChild(h(dom, 'main', { id: 'main' }, [scroll]));
  return { heading, mail, side, scroll };
}

test('① 页顶不再出现「今日待核对」横条（工作台页头、邮件页头都没有）', async () => {
  const dom = createDom();
  const page = businessPage(dom);
  const { window } = loadShell(dom);
  await window.shangshuReviewCenter.syncCounts();
  /* ⚠️ 断言里**不要**把 DOM 元素当「实际值」交给 assert.equal ——
     node 的断言会为一个**带环**的 DOM 树生成上百 KB 的 diff ⇒ 回归时**挂住**，不是「失败」。 */
  assert.ok(!dom.body.querySelector('[data-review-center-bar]'),
    '页面里还有那条「今日待核对」横条 —— 用户说了页顶不要');
  assert.ok(!page.heading.querySelector('[data-review-center-bar]'), '工作台页头还有那条');
  assert.ok(!page.mail.querySelector('[data-review-center-bar]'), '邮件页头还有那条');
});

test('② 侧栏顶部那个「待核对」入口**撤掉了**（连同徽标）—— 不是「留着不挂」', async () => {
  const dom = createDom();
  businessPage(dom);
  const { window } = loadShell(dom);
  await window.shangshuReviewCenter.syncCounts();
  assert.equal(dom.body.querySelector('[data-review-center-entry]'), null,
    '侧栏里还有那个「待核对」入口 —— 用户 17:48 说要去掉');
  assert.equal(dom.body.querySelector('[data-review-center-count]'), null,
    '侧栏里还有那个计数徽标');
  /* 公共壳的侧栏模板里**不再画**那块坑（查的是**标记本身**，不是注释里提到它的地方） */
  assert.doesNotMatch(appSource, /id="side-review-entry"/,
    'app.js 的侧栏模板里还画着那个入口的宿主 —— 它随时会回来');
  assert.doesNotMatch(appSource, /data-review-center-entry/,
    'app.js 里还留着那个入口按钮本身');
  /* 壳里那套「摆入口」的机制**整体撤掉**（留着不挂＝死代码，随时能被挂回来） */
  for (const gone of ['mountEntry', 'buildEntry', 'ENTRY_HOST_ID', 'ENTRY_COUNT_ATTR']) {
    assert.ok(!shellSource.includes(gone),
      'review-center.js 里还留着「' + gone + '」—— 那套侧栏入口机制要整体撤掉，不是留着不挂');
  }
});

test('③ 审核中心**没有被删掉**：它有自己的页（核心域的静态注册 ＋ 侧栏一项）＋ 分栏弹窗还在', async () => {
  const dom = createDom();
  businessPage(dom);
  const { window } = loadShell(dom);
  await window.shangshuReviewCenter.syncCounts();
  /* 分栏弹窗**保留**：页内还可以开窗核对（`openCard()`／`closeCard()` 不许删）。 */
  assert.equal(typeof window.shangshuReviewCenter.openCard, 'function', '分栏弹窗入口被删了');
  assert.equal(typeof window.shangshuReviewCenter.closeCard, 'function', '分栏弹窗入口被删了');
  assert.equal(typeof window.shangshuReviewCenter.open, 'function', '打开入口被删了');
  assert.equal(typeof window.shangshuReviewCenter.close, 'function', '关闭入口被删了');

  /* **独立页**还在：静态页面注册表里查得到，属主是核心域。 */
  const registryWindow = {};
  registryWindow.window = registryWindow;
  vm.runInNewContext(registrySource, registryWindow, { filename: 'page-registry.js' });
  const definition = registryWindow.shangshuPageDefinition('review-center');
  assert.ok(definition, '静态页面注册表里没有「审核中心」这一页');
  assert.equal(definition.owner, 'com.shangshu.core', '这一页不该归任何业务域');
  assert.match(appSource, /id: 'review-center'/, '侧栏里没有「审核中心」这一项');
});

test('④ 页面注册走**静态注册表**（公共页自己登记）', () => {
  assert.match(registrySource, /shangshuRegisterPages/,
    '页面注册表里没有域注册口 —— 域自己的页没地方登记了');
  assert.match(registrySource, /review-center/,
    '静态页面注册表里没有「审核中心」这一页 —— 它该是公共页');
  assert.doesNotMatch(shellSource, /example-domain\./,
    '公共壳里写死了 example 的页面 id —— 公共壳不该知道任何域的页面 id');
  /* ⚠️ 「域不注册页面本体」那一条**归域内判据**（`domains/example-domain/tests/`）——
     域自己的文件归域自己管，公共壳这边不越界去断它。 */
});

test('⑤ 横条那套「页头入口」代码整体撤掉了（不是留着不挂）', () => {
  assert.doesNotMatch(shellSource, /HEADER_SELECTORS/,
    'review-center.js 里还留着页头挂载点表 —— 横条随时可能被挂回页顶');
  /* 壳里现在**用** `.page-hd` 画独立页自己的页头（平台页头口径），
     但**不许拿任何页面的页头当挂载点** —— 那正是横条回来的地方。 */
  assert.doesNotMatch(shellSource, /querySelector\(['"]\.page-hd/,
    'review-center.js 里还在拿 .page-hd 当挂载点 —— 横条随时可能被挂回页顶');
  assert.doesNotMatch(shellSource, /\.mail-heading/,
    'review-center.js 里还在拿 .mail-heading 当挂载点');
});
