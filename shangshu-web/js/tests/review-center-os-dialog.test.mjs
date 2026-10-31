// 判据：审核中心那个左右分栏大弹窗**就是尚书的公共弹窗**（复用公共组件，不是自己另写一套）
// （用户 2026-10-23 原话：「首先这个弹窗，**它就不是我们尚书的统一样式**，其次**也没有复用任何的组件**，
//   导致视觉不是很统一」；「弹窗背后的页面信息太多太杂」；「和底边的 padding 也太大了，不美观」）。
//
// **测试通过 =**（一句话）
// 「点开一张审核卡 ⇒ 那扇弹窗**就是公共弹窗组件**：
//   它挂着公共件 `os-dialog`（字体/圆角/背景/阴影/遮罩/按钮尺寸全从公共件来，
//   **不再自己另写一套外框**）；
//   骨架是公共件的 **header／main／footer** 三段；
//   底栏按钮吃得到公共件的 `.btn`／`.btn-pri`（不是浏览器默认那个小按钮）；
//   **底栏与两栏的留白收小**到公共件那一档；
//   而**预览页把公共样式表真的加载上**（不然公共件的样式根本不生效 ——
//   那个按钮掉回浏览器默认、字体掉回衬线体，就是这么来的）；
//   并且**弹窗背后的页面是精简的**（没有图例行、没有页级底栏，
//   预览页那一屏说明收进折叠块）。」
//
// ⚠️ **为什么这条要有护栏**（2026-10-23 实踩）：
//   `shangshu-web/css/workbench.css` 里 **`.os-dialog .btn{…}` / `.os-dialog header{…}` 这些规则
//   **挂在 `.os-dialog` 底下** —— 不挂那个类，公共件的样式**一条都不生效**
//   （实测：底栏那个「整组保存」高 **23px**、内边距 `1px 6px`、弹窗字体掉回 `16px Times`）。
//   excel-univer 域早有同样的护栏（「三个弹窗都还走公共 `ui.dialog`，不许另造浮层」），
//   审核中心这条公共壳自己**没有** ⇒ 这次补上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { createResolver } from '../../../scripts/lib/css-cascade.mjs';
import { createEffective } from './helpers/css-effective.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle, pageHost, fileCenterVersions } from './helpers/review-center-shell.mjs';

const ROOT = new URL('../../../', import.meta.url);
const resolver = createResolver(ROOT);
const WIDE = 1440;
const effective = createEffective(resolver, WIDE);

/** 把壳装好、登记示例声明、挂上这一页。 */
async function openDialog(dom) {
  const { window } = loadShell(dom, {
    readFileCenterVersions: fileCenterVersions,
  });
  registerSampleDeclaration(window, { list: async () => [sampleCard()] });
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();
  dom.body.querySelector('[data-review-card-open]').dispatchEvent({ type: 'click' });
  await settle();
  return dom.body.querySelector('[data-review-split]');
}

test('① 那扇弹窗**挂着公共件 `os-dialog`**（不挂 ⇒ 公共件的字体/圆角/阴影/按钮一条都不生效）', async () => {
  const dom = createDom();
  const dialog = await openDialog(dom);
  assert.ok(dialog, '弹窗不见了');
  const classes = String(dialog.className || '').split(/\s+/);
  assert.ok(classes.includes('os-dialog'),
    '弹窗没挂公共件 `os-dialog`（class=' + dialog.className + '）'
    + ' ⇒ 公共件的字体/圆角/背景/阴影/遮罩/按钮尺寸全部不生效');
});

test('② 骨架是公共件的**三段**：header ／ main ／ footer', async () => {
  const dom = createDom();
  const dialog = await openDialog(dom);
  const kids = [...dialog.children].map(node => node.tagName && node.tagName.toLowerCase());
  assert.ok(kids.includes('header'), '弹窗没有 header 段（公共件的表头样式靠这个标签）：' + kids.join(','));
  assert.ok(kids.includes('main'), '弹窗没有 main 段（公共件的正文样式靠这个标签）：' + kids.join(','));
  assert.ok(kids.includes('footer'), '弹窗没有 footer 段（公共件的页脚样式靠这个标签）：' + kids.join(','));
});

test('③ 底栏按钮吃得到**公共件的 `.btn`／`.btn-pri`**（不是浏览器默认那个小按钮）', async () => {
  const dom = createDom();
  const dialog = await openDialog(dom);
  const save = dialog.querySelector('[data-review-save]');
  assert.ok(save, '弹窗上没有保存按钮');
  const classes = String(save.className || '').split(/\s+/);
  assert.ok(classes.includes('btn'), '保存按钮没有公共件类 `btn`（class=' + save.className + '）');
  assert.ok(classes.includes('btn-pri'), '保存按钮没有公共件主按钮类 `btn-pri`（class=' + save.className + '）');
});

test('④ 弹窗**不再自己另写一套外框**（边框/圆角/背景/阴影/字体/字色都归公共件）', () => {
  /* 修饰类写成 `.os-dialog.review-split`（范本：`.os-dialog.mail-review-dialog`）——
     它的**职责只有宽高与三段布局**，外框那套一律不写。 */
  for (const prop of ['border', 'border-radius', 'background', 'box-shadow', 'font', 'color']) {
    const hit = resolver.resolve('.os-dialog.review-split', prop, { viewport: WIDE });
    assert.ok(!hit, '`.os-dialog.review-split` 又自己写了 `'
      + prop + '`（' + (hit ? hit.value : '—') + '）⇒ 外框没归公共件，弹窗还是自己那套');
  }
});

test('⑤ **底栏**贴底那侧**留白收小**；与正文之间靠**留白**分层', () => {
  /* ⚠️ 选择器要带 `.os-dialog ` 前缀：这条修饰规则写的是 `.os-dialog .review-split-foot`
     （不带前缀压不过公共件的 `.os-dialog footer`，那是 (0,1,1)）。 */
  const hit = resolver.resolve('.os-dialog .review-split-foot', 'padding', { viewport: WIDE });
  assert.ok(hit, '底栏没有自己的 padding 规则');
  const parts = String(hit.value).trim().split(/\s+/);
  /* `padding: a b` ⇒ 上下 a、左右 b；`padding: a b c` ⇒ 上 a、左右 b、下 c。 */
  const top = parseFloat(parts[0]);
  const bottom = parts.length >= 3 ? parseFloat(parts[2]) : top;
  /* ⚠️ **契约变化（2026-10-28 上午 · 用户口径）**：
   *   · **贴底那侧仍收小**（用户 2026-10-23 原话：「和底边的 padding 太大了，不美观」
   *     ⇒ 公共件页脚 12px 20px、邮件先例 7px 18px）⇒ **下边 ≤8px**，这一条**没动**。
   *   · **上边**（底栏与正文之间）从 7px 提到 **16px**：这一轮把头栏/底栏的**横线全去掉**了
   *     （用户：「去掉图一图二图三图四所有的横线分割」）⇒ 原来那道线腾出来的 7px
   *     不够分层（UI/UX 审核实测：整窗看着「一整块白」）⇒ 按旧项目
   *     `ip.css:4598-4602` 改成**留白 16px**。
   *   ⇒ 判据从「上下都 ≤8」改成「**下边 ≤8、上边 ≥12**」。 */
  assert.ok(bottom <= 8,
    '底栏**贴底**那侧的留白是 ' + bottom + 'px（用户说的「和底边的 padding 太大」没改）');
  assert.ok(top >= 12,
    '底栏与正文之间只隔 ' + top + 'px（去线之后没有分层）⇒ 旧项目那档是 16px');
});

test('⑥ **预览页把公共样式表真的加载上**（否则公共件的样式根本不生效）', () => {
  const html = fs.readFileSync(new URL('../../review-center-preview.html', import.meta.url), 'utf8');
  const index = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

  /* 公共弹窗 `.os-dialog` 与全局 `.btn` 都在 `css/workbench.css` —— 不加载它，
     公共件的样式一条都不生效（按钮掉回浏览器默认、字体掉回衬线体）。 */
  assert.match(html, /href="css\/workbench\.css/, '预览页没加载 `css/workbench.css`'
    + '（公共弹窗 `.os-dialog` ＋ 全局 `.btn` 都在那张表里）');

  /* 全站只用一个版本戳（改一次全站换新，不会一半新一半旧）。 */
  const stamp = (text) => {
    const hits = [...text.matchAll(/\?v=([^"'&\s]+)/g)].map(m => m[1]);
    return [...new Set(hits)];
  };
  const previewStamps = stamp(html);
  const indexStamps = stamp(index);
  assert.deepEqual(previewStamps, indexStamps,
    '预览页的资源戳跟全站不一致（预览页 ' + previewStamps.join('、') + ' / 全站 ' + indexStamps.join('、')
    + '）⇒ 改了文件浏览器还拿旧的');
});

test('⑦ **弹窗背后的页面精简了**：产品页不再挂图例行与页级底栏；预览页的说明收进折叠块', async () => {
  /* 用户 2026-10-23 原话：「**更加严重的是，弹窗背后的页面信息太多太杂，要精简**」。
   * 旧项目那页背后是：页头（标题+一句说明）＋ 工具条（两档 ＋ 搜索 ＋ 刷新）＋ 卡片列表 ——
   * **没有**图例行，也**没有**页级底栏（那份底栏是 `hidden` 的）。 */
  const dom = createDom();
  const { window } = loadShell(dom, {
    readFileCenterVersions: fileCenterVersions,
  });
  registerSampleDeclaration(window, { list: async () => [sampleCard()] });
  const host = pageHost(dom);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();

  assert.ok(!host.querySelector('.review-legend'),
    '弹窗背后还挂着图例行（「彩色文字呼吸：待确认　黑字粗体：已保存」）⇒ 信息太杂');
  assert.ok(!host.querySelector('.review-center-footer'),
    '弹窗背后还挂着页级底栏（那一行「共 N 项待核对」和分档里的计数重复）⇒ 信息太杂');

  /* 预览页：**常驻只剩顶部那一行**（用户 2026-10-23 10:1x 批注：「去掉」）
     —— 说明文字块（折叠块）也撤了，不要在弹窗背后再摆一屏字。 */
  const html = fs.readFileSync(new URL('../../review-center-preview.html', import.meta.url), 'utf8');
  assert.ok(!/<details\b/i.test(html),
    '预览页还有一块折叠说明（弹窗背后又一屏字）⇒ 用户批注「去掉」没改');
});

test('⑨ **弹窗里没有那颗「样例预览 · 数据是示例 · 只读」的绿标**（那是预览页自己加的，不是产品的一部分）', () => {
  /* 用户 2026-10-23 10:1x 在弹窗表头那颗绿标上圈了「去掉」——
     它是**预览页自己**用 `::before` 加的说明文字（提醒「这是样例、只读」），
     产品的那扇弹窗里**本来就没有**这东西 ⇒ 预览页也不该有。
     「只读／样例数据」的话**留在顶部那一行**里（那里本来就是干这个的）。 */
  const html = fs.readFileSync(new URL('../../review-center-preview.html', import.meta.url), 'utf8');
  assert.ok(!/review-split-head::before/.test(html),
    '预览页还在给弹窗表头加那颗绿标 ⇒ 用户批注「去掉」没改');
  /* 看**页面上真会出现的内容**（注释里提到那几个字不算 —— 那是留给读代码的人的）。 */
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  assert.ok(!visible.includes('样例预览'),
    '预览页的弹窗里还留着「样例预览」那几个字');
  /* 只读的话**不许一起没** —— 顶部那一行必须还写着。 */
  assert.match(visible, /只读/, '预览页顶部那一行把「只读」也弄没了 ⇒ 人看不出这是样例页');
});

test('⑧ **域标签是一枚徽标**（不是一整条灰带）', async () => {
  /* 2026-10-23 实踩：域标签挂上公共件 `.tag` 之后，它本体是个 `div`（块级）⇒
     徽标的底色**铺满整行**（弹窗表头里一条灰带，顶开标题）。
     ⇒ 徽标本体要是**行内件**（`span` ＋ `display:inline-block`）。 */
  const dom = createDom();
  const dialog = await openDialog(dom);
  const domain = dialog.querySelector('[data-review-split-domain]');
  assert.ok(domain, '弹窗表头里没有域标签');
  assert.equal(String(domain.tagName || '').toLowerCase(), 'span',
    '域标签本体是 `' + domain.tagName + '`（块级）⇒ 徽标底色铺满整行，成了一条灰带');
  const hit = resolver.resolve('.review-split-domain', 'display', { viewport: WIDE });
  assert.ok(hit && /inline/.test(String(hit.value)),
    '域标签没有行内展示的规则（display=' + (hit ? hit.value : '—') + '）⇒ 徽标会铺满整行');
});

test('⑪ **两种保存方式在同一页上都能看见**（一个页签整组保存、一个页签允许部分保存）', async () => {
  /* 目标第四件事里那句「交付须同时验证……**两种保存方式**」。
   * 后端那半**已经在站上验过**（PKG-052-T01：example 整组「只交一部分 ⇒ 被拒 ＋ 零写入」、
   * 邮件域「只保存选中的那一项 ⇒ 成功、其余仍待审」），
   * 但**界面上**只有整组那一种看得见 ⇒ 人看不到「另一半长什么样」。
   * 公共壳的页签是**按声明一页一个**（`renderTabs` 遍历 `pageDeclarations()`）
   * ⇒ 再注册一份 `partial:true` 的声明就多出一个页签，切过去底栏按钮变成「确认所选 N 项」。 */
  const dom = createDom();
  const { window } = loadShell(dom, { readFileCenterVersions: fileCenterVersions });
  /* 两份声明：一份整组、一份允许部分保存。 */
  registerSampleDeclaration(window, { list: async () => [sampleCard()] });
  registerSampleDeclaration(window, {
    key: 'sample.partial',
    name: '示例：可部分保存的场景',
    order: 2,
    savePolicy: { partial: true, unit: '一条变更', group: 'card' },
    list: async () => [sampleCard({ id: 'CARD-PARTIAL', title: '可部分保存那一份' })],
  });
  const host = pageHost(dom);
  await window.shangshuReviewCenter.mountPage(host, {});
  await settle();

  /* ① 页面上有**两片**（公共壳一页一个声明 ⇒ 两种保存方式摆得开）。
   * ⚠️ **机制换了**（PKG-068-T01）：原来那一行「分档标签」（`[data-review-tab]`）撤了 ⇒
   *   分档片搬到**页头右上**（`[data-review-deck]`）⇒ **要证明的事一个字没变**
   *   （两种保存方式在**同一页上**都看得见）。 */
  const decks = host.querySelectorAll('[data-review-deck]');
  const declarationDecks = decks.filter(chip => {
    const key = chip.getAttribute('data-review-deck');
    return key === 'sample.notice' || key === 'sample.partial';
  });
  assert.equal(declarationDecks.length, 2,
    '两种保存方式摆不到一起（域给的两档没有各一片）：' + declarationDecks.length);
  assert.ok(host.querySelector('[data-review-deck="__done__"]'), '「已确认」那一档不见了');

  /* ② 两档的**保存按钮标题不一样**（弹窗挂在 document.body 上，不在页面宿主里）。 */
  await window.shangshuReviewCenter.open('sample.notice');
  await settle();
  const wholeSave = dom.body.querySelector('[data-review-save]');
  const wholeText = wholeSave ? wholeSave.textContent : '';
  await window.shangshuReviewCenter.open('sample.partial');
  await settle();
  const partialSave = dom.body.querySelector('[data-review-save]');
  const partialText = partialSave ? partialSave.textContent : '';
  assert.match(wholeText, /整组保存/, '整组那档的保存按钮不是「整组保存」：' + wholeText);
  assert.match(partialText, /确认所选/, '允许部分保存那档的保存按钮不是「确认所选 N 项」：' + partialText);
});

/**
 * 预览页里**一份一份的声明**（key ＋ 它的保存方式）。
 *
 * 怎么找：**每份声明都有一个 `savePolicy:`** ⇒ 按它切块，
 * 每块里**最后一个** `key:` 就是那份声明自己的 key
 * （声明对象里 key 之后没有别的 key；卡片里的 `checks[].key` 在声明之前，不会被当成声明的 key）。
 * `key` 既认字面量（`key: 'preview.x'`）也认常量（`key: DECL_KEY`）—— 不逼源码用哪种写法。
 */
function declaredSavePolicies(html) {
  const consts = new Map();
  for (const m of html.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g)) consts.set(m[1], m[2]);
  const out = [];
  const blocks = html.split(/\bsavePolicy\s*:/);
  for (let i = 1; i < blocks.length; i += 1) {
    const hits = [...blocks[i - 1].matchAll(/\bkey\s*:\s*(?:'([^']*)'|([A-Za-z_$][\w$]*))/g)];
    const hit = hits[hits.length - 1];
    const key = hit ? (hit[1] !== undefined ? hit[1] : (consts.get(hit[2]) || '')) : '';
    const partial = /partial\s*:\s*(true|false)/.exec(blocks[i]);
    out.push({ key, partial: partial ? partial[1] : '' });
  }
  return out;
}

test('⑫ **预览页把两种保存方式都摆出来**（用户明天打开的那一页，不能只有整组那一种）', async () => {
  /* ⑪ 断的是**公共壳**（壳本来就能摆两份声明 ⇒ 那条是护栏）。
   * 这一条断的是**预览页**：用户明天打开 `http://127.0.0.1:3850/review-center-preview.html`
   * 就是来看审核页的 ⇒ **那上面必须两种保存方式都看得见**，
   * 否则「交付须同时验证两种保存方式」在界面上就只验了一半。 */
  const html = fs.readFileSync(new URL('../../review-center-preview.html', import.meta.url), 'utf8');
  const decls = declaredSavePolicies(html);

  /* ① **两份声明**（公共壳一页一个声明 ⇒ 两份声明就是两个页签）。 */
  assert.ok(decls.length >= 2, '预览页只注册了一份声明（找到 ' + decls.length + ' 份）'
    + ' ⇒ 页上只有一种保存方式');
  const keys = decls.map(d => d.key);
  assert.equal(new Set(keys).size, keys.length,
    '两份声明的 key 撞了（' + keys.join('、') + '）⇒ 页上只有一个页签');

  /* ② 两种保存方式**一档整组、一档允许部分保存**。 */
  assert.ok(decls.some(d => d.partial === 'false'), '预览页没有「整组保存」那一种声明');
  assert.ok(decls.some(d => d.partial === 'true'),
    '预览页没有「允许部分保存」那一种声明（找到 '
    + decls.map(d => d.key + '=' + (d.partial || '?')).join('、') + '）⇒ 那一半看不见');
});

/* ⑬（2026-10-25 · PKG-102-T01 建 · **2026-10-25 · PKG-104-T03 订正**）：
 * **这扇弹窗的「生效遮罩」够深**（底下那排分档片被盖住、看着是灰的）。
 *
 * **为什么**（2026-10-25 真浏览器实走查出来的，PKG-101 的 F1）：
 *   弹窗用 `<dialog>` + `showModal()` ⇒ **浏览器把背景整片变成 inert**（底下点不动）；
 *   而**页头那排分档片在弹窗上沿之外、看得见** ⇒ 看着像活的、点下去没反应。
 *   ⇒ 遮罩得够深，底下那排片才**被盖住、看着是灰的**。
 *
 * ⚠️ **2026-10-25 订正（PKG-104-T03，原句保留不删）**：**候选列表必须把公共件那条也算进去**。
 *   早先这条判据只算「**自己那一条**」⇒ 量到的**不是生效值**：
 *   这扇弹窗**挂着公共件 `os-dialog`** ⇒ `css/workbench.css` 的
 *   `.os-dialog::backdrop{background:#0004}` **早就在生效**
 *   （`#0004` 是 **4 位 hex** ⇒ alpha = **4/15 ≈ 0.267**，**不是**浏览器默认的 0.1）
 *   ⇒ **PKG-102 之前**这扇弹窗的生效遮罩就已经是 ≈0.267；PKG-102 把它改成 0.28
 *   ⇒ **只差 3/255**（白底 187 → 184）⇒ **肉眼基本看不出**。
 *   ⇒ 旧判据还逼着「必须有自己那一条」，而**删掉它生效值一点不变** ⇒ 那条判据量错了东西。
 *   ⇒ 现在算**生效值**：公共件那条一起进候选列表，按「特异性高者赢、同特异性后加载者赢」排。
 *
 * **测试通过 =**（一句话）
 *   「这扇弹窗的**生效遮罩**（**含公共件 `.os-dialog::backdrop`**）alpha ≥ 0.25
 *     ⇒ 底下那排分档片被盖住、看着是灰的，不该像活的一样亮着。」
 *
 * ⚠️ 断的是**算出来的生效值**，不是「样式表里有没有那句话」—— 这是本仓库判据的一贯口径。
 */

/** 从生效值里把 alpha 抠出来：`rgba(...)`、8 位 hex、**4 位 hex**（alpha = digit/15）、6 位 hex。 */
function alphaOf(value) {
  const s = String(value).trim();
  let m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i.exec(s);
  if (m) return Number(m[1]);
  m = /^#([0-9a-f]{8})$/i.exec(s);
  if (m) return parseInt(m[1].slice(6, 8), 16) / 255;
  m = /^#([0-9a-f]{4})$/i.exec(s);
  if (m) return parseInt(m[1][3], 16) / 15;   // ← 4 位 hex 的 alpha 是 digit/15
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return 1;
  return null;
}

test('⑬ 这扇弹窗的**生效遮罩**够深（底下那排分档片被盖住、看着是灰的）', () => {
  const hit = effective([
    '.os-dialog.review-split::backdrop',
    '.review-split::backdrop',
    '.os-dialog::backdrop',            // ← 公共件那条**本来就在生效**（PKG-104-T03 补进候选列表）
  ], 'background', WIDE);
  assert.ok(hit,
    '这扇弹窗**一条遮罩都没有** ⇒ 底下用浏览器默认那 10% ⇒ '
    + '弹窗开着时页头那排分档片**看着像活的、点下去没反应**（模态把背景锁了）'
    + ' ⇒ 照站内别的弹窗那一档（`.schema-dialog::backdrop`=.28／`.file-review-dialog::backdrop`=.25）补一条。');
  const alpha = alphaOf(hit.value);
  assert.ok(alpha !== null,
    '遮罩的生效值抠不出透明度（' + hit.value + '，来自 ' + hit.file + '）⇒ 判据看不懂这条规则');
  assert.ok(alpha >= 0.25,
    '遮罩的**生效值**只有 ' + alpha + '（' + hit.value + '，来自 ' + hit.file + '）⇒ 太浅 ⇒ 底下那排分档片看着还是像活的、点不动'
    + ' ⇒ 至少 .25（照站内 `.file-review-dialog::backdrop`=.25／`.schema-dialog::backdrop`=.28 那一档）');
});
