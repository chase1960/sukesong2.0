// 判据：审核中心第 6 类（保存方式与完整范围）的**整组范围**怎么认，
//   ＋ 域声明**注册失败**时人能不能看见。
//
// **测试通过 =**（一句话）
// 「域把整组范围写成壳认不出的写法 ⇒ **注册当场拒**（那一类不许悄悄按「整卡」算）；
//   域声明写坏了 ⇒ **页面上看得见**（摆出「这一类审核没注册上」＋具体哪几处不对），
//   不再是「这一类人间蒸发、没人知道」；
//   两种合法写法（函数 / 字符串 `'card'`）照旧能用：整组保存时一次提交带上整组全部变更。」
//
// ⚠️ **为什么要有这几条**（2026-10-26 审计查出来的两个真缺口 · PKG-121）：
//
//   ③ **第 6 类只写「不允许部分保存」还不够，必须知道「整组」究竟包括什么**
//      （契约 §declaration.ten.6.hard）。原来壳里的 `groupChangesOf` **只认函数**
//      （`typeof policy.group === 'function'`）⇒ 域写字符串时**靠「落到最后一行」才碰巧对**
//      （example 写的是 `'card'`，整卡＝全部变更，恰好是这个意思）
//      ⇒ 域写**别的**字符串（`'row'` 之类）也一样**悄悄按整卡算**
//      ⇒ 「整组到底包括什么」**没人说得清**，而且没人会发现它不对。
//
//   ⑤ **域声明写错 ⇒ 那一类审核人间蒸发**
//      原来 `registerDeclaration` 只**返回** `{ok:false, errors}`，
//      **域可以不看返回值**（example 域侧两处就是直接调、不看回值）
//      ⇒ 那一类**根本没注册** ⇒ 页面上不出现 ⇒ 人只看到「这一类怎么没有」，
//      **没人知道是声明坏了**。契约 §declaration.note 早就写着
//      「注册失败 ⇒ 页面会把具体配置问题摆出来」，但壳里**从来没有这条路径**。
//
// ⚠️ **「注册失败看得见」怎么验才算数**（这条最容易写假）：
//   域**故意不看返回值**（照 example 域侧的真写法）⇒ 只看**页面上有没有那句话**
//   ⇒ 证明这条路径**不是**靠「域记得看返回值」才成立的。
//
// ⚠️ **「有牙齿」怎么证的**（2026-10-26 实证，判据写在前面）：
//   这条判据是**先把实现改完再补的**（没按「先红后绿」的顺序走，认）⇒
//   改成**拿旧壳跑一遍**当红灯证据：把 `shangshu-web/js/review-center.js` 退回 HEAD
//   （`git checkout HEAD -- shangshu-web/js/review-center.js`，判据与辅助件保留）
//   再跑本判据 ⇒ **7 条里 5 条当场红**（③④ 两条纯回归是绿的）⇒ 改回来再跑 ⇒ **7/7 绿**。
//
//   🔴 **旧壳实跑原文**（2026-10-26，`node --test shangshu-web/js/tests/review-center-declaration-contract.test.mjs`）：
//     ✖ ① AssertionError: 整组范围写成「row」（壳认不出的写法）居然注册成功了 ⇒ 域以为限住了、壳悄悄按整卡算
//     ✖ ② AssertionError: 整组范围写成一个对象居然注册成功了
//     ✔ ③（合法写法回归，旧的也该绿）
//     ✔ ④（合法写法回归，旧的也该绿）
//     ✖ ⑤ AssertionError: 页面上没有「声明没注册上」那块 ⇒ 那一类审核人间蒸发了，没人知道
//     ✖ ⑥ AssertionError: 注册失败的那一份居然还在声明列表里
//     ✖ ⑦ AssertionError: 第一次注册失败后页面上应当有那句话
//     ⇒ ℹ tests 7 ／ ℹ pass 2 ／ ℹ fail 5
//   🟢 **新壳实跑原文**（同一条命令）：ℹ tests 7 ／ ℹ pass 7 ／ ℹ fail 0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import { loadShell, registerSampleDeclaration, sampleCard, settle } from './helpers/review-center-shell.mjs';

const click = node => node.dispatchEvent({ type: 'click' });
const candidatesOf = dom => dom.body.querySelectorAll('[data-review-candidate]');

function mount(dom) {
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  return host;
}

/** 一份**故意写坏**的声明（域注册失败那种）。 */
function brokenDeclaration(overrides = {}) {
  return Object.assign({
    key: 'sample.broken',
    name: '示例：写坏了的声明',
    kind: 'automation',
    order: 1,
    domain: '示例业务域',
    where: '在示例工作面里处理',
    list: async () => [sampleCard()],
    identity: { title: '示例待核对', summary: '一份凭据一组变更', cardUnit: '一份凭据一组变更', entry: '审核中心', domain: '示例业务域' },
    leftSlot: { title: '要改成什么', format: 'field-table' },
    rightSlot: { title: '凭据', format: 'pdf' },
    evidenceBinding: { required: ['ev-1'], locator: 'page' },
    editable: { mode: 'adopt-and-edit', control: 'text' },
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    precondition: { checks: [], fingerprint: '' },
    audience: { mode: 'existing-permission' },
    handling: { entries: ['adopt', 'edit', 'save'] },
    execution: { saveAction: 'kernel.accept' },
  }, overrides || {});
}

/* —— 缺口③：整组范围只有两种写法，认不出的**注册当场拒**。 —— */

test('① 整组范围写成壳认不出的写法（字符串「row」）⇒ **注册当场拒**，不许悄悄按「整卡」算', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const result = window.shangshuReviewCenter.registerDeclaration(
    brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: 'row' } }));

  assert.equal(result.ok, false,
    '整组范围写成「row」（壳认不出的写法）居然注册成功了 ⇒ 域以为限住了、壳悄悄按整卡算');
  assert.ok(result.errors.some(err => /第 6 类/.test(err) && /整组范围/.test(err)),
    '报错没有点名「第 6 类 整组范围」：' + JSON.stringify(result.errors));
  assert.ok(result.errors.some(err => /card/.test(err)),
    '报错没有说清只有哪两种写法（函数 / 字符串 card）：' + JSON.stringify(result.errors));

  const keys = window.shangshuReviewCenter.declarations().map(item => item.key);
  assert.ok(!keys.includes('sample.broken'), '注册被拒了却还留在声明列表里');
});

test('② 整组范围写成**对象**（另一种认不出的写法）⇒ 也当场拒，不许放行', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const result = window.shangshuReviewCenter.registerDeclaration(
    brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: { scope: 'row' } } }));
  assert.equal(result.ok, false, '整组范围写成一个对象居然注册成功了');
  assert.ok(result.errors.some(err => /第 6 类/.test(err) && /整组范围/.test(err)),
    '报错没有点名「第 6 类 整组范围」：' + JSON.stringify(result.errors));
});

test('③ 合法写法照旧能用：字符串 「\'card\'」⇒ 整组＝整张卡，一次提交带上全部变更', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  const result = registerSampleDeclaration(window, {
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
  });
  assert.equal(result.ok, true, '合法的「\'card\'」写法被拒了：' + JSON.stringify(result.errors));

  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  for (const candidate of candidatesOf(dom)) { click(candidate); await settle(); }
  const save = dom.body.querySelector('[data-review-save]');
  assert.equal(save.disabled, false, '整组全核过了还是不许提交');
  click(save);
  await settle();

  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1, '整组保存只打了一次内核确认口');
  const body = JSON.parse(accepts[0].init.body);
  assert.equal(body.units.length, 3, '「\'card\'」的整组没有把三项一起带上');
  assert.deepEqual(body.units.slice().sort(), ['u-c1', 'u-c2', 'u-c3']);
});

test('④ 合法写法照旧能用：函数 ⇒ 整组＝函数算出来的那几项（回归，别被改坏）', async () => {
  const dom = createDom();
  const { window, calls } = loadShell(dom);
  const result = registerSampleDeclaration(window, {
    savePolicy: { partial: false, unit: '一条变更', group: card => card.changes.map(change => change.id) },
  });
  assert.equal(result.ok, true, '合法的函数写法被拒了：' + JSON.stringify(result.errors));

  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  click(dom.body.querySelector('[data-review-card-open]'));
  await settle();
  for (const candidate of candidatesOf(dom)) { click(candidate); await settle(); }
  click(dom.body.querySelector('[data-review-save]'));
  await settle();

  const accepts = calls.filter(call => /\/accept$/.test(call.path));
  assert.equal(accepts.length, 1, '整组保存只打了一次内核确认口');
  const body = JSON.parse(accepts[0].init.body);
  assert.equal(body.units.length, 3, '函数写法算出来的整组没有带上三项');
});

/* —— 缺口⑤：域声明注册失败 ⇒ 人看得见。 —— */

test('⑤ 域**不看返回值**（照 example 域侧的真写法）⇒ 那一类没注册上时，**页面上看得见**', async () => {
  const dom = createDom();
  const { window, consoleCalls } = loadShell(dom);
  /* ⚠️ **故意不看返回值** —— 这正是 example 域侧两处的写法（`registry.registerDeclaration({...})` 不接回值）。
     ⇒ 这条判据证明的是「壳自己把失败摆出来」，**不是**「域记得看返回值」。 */
  window.shangshuReviewCenter.registerDeclaration(
    brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: 'row' } }));

  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();

  const box = dom.body.querySelector('[data-review-decl-failures]');
  assert.ok(box, '页面上没有「声明没注册上」那块 ⇒ 那一类审核人间蒸发了，没人知道');
  const text = String(box.textContent || '');
  assert.match(text, /没注册上/, '那句话没说清「没注册上」：' + text);
  assert.match(text, /示例：写坏了的声明/, '那句话没点名是哪一类：' + text);
  assert.match(text, /整组范围/, '那句话没说是哪几处不对：' + text);

  const errors = consoleCalls.filter(call => call.level === 'error');
  assert.ok(errors.length >= 1, '控制台一句都没留 ⇒ 排查时第一眼看不见');
  assert.match(String(errors[0].args[0]), /没注册上/, '控制台那一句没说清是声明没注册上：'
    + String(errors[0].args[0]));
});

test('⑥ 注册失败的那一类**确实没进列表**（所以上面那块话是它唯一的痕迹，不许又悄悄出现一次）', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  window.shangshuReviewCenter.registerDeclaration(
    brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: 'row' } }));
  const keys = window.shangshuReviewCenter.declarations().map(item => item.key);
  assert.ok(!keys.includes('sample.broken'), '注册失败的那一份居然还在声明列表里');
});

test('⑦ 域把声明改对了**再注册一次** ⇒ 页面上那句错话撤掉，不许留着吓唬人', async () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  window.shangshuReviewCenter.registerDeclaration(
    brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: 'row' } }));
  await window.shangshuReviewCenter.mountPage(mount(dom), {});
  await settle();
  assert.ok(dom.body.querySelector('[data-review-decl-failures]'), '第一次注册失败后页面上应当有那句话');

  /* 同一个 key，把写错的地方改对再注册一次。 */
  const fixed = brokenDeclaration({ savePolicy: { partial: false, unit: '一条变更', group: 'card' } });
  const again = window.shangshuReviewCenter.registerDeclaration(fixed);
  assert.equal(again.ok, true, '改对之后还是注册不上：' + JSON.stringify(again.errors));

  await window.shangshuReviewCenter.refreshPage();
  await settle();
  assert.ok(!dom.body.querySelector('[data-review-decl-failures]'),
    '改对之后那句错话还挂在页面上');
});
