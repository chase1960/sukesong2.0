// 判据：审核中心是**平台的一道公共闸门**，不是任何一个业务域的页
// （用户 2026-10-22 18:15 原话：「审核中心他不应该归属于知识产权域……他是一道判断闸门，
//   以后的 uc 都会用到它」；内核契约 `frappe_apps/shangshu_core/shangshu_core/contracts/review-center-v1.json`）。
//
// **测试通过 =**（一句话）
// 「**这一页归核心域**：静态页面注册表里查得到 `review-center`、属主是核心域、平台模式进得去；
//   侧栏「工作」组里有一项「审核中心」；**公共壳自己提供这一页的渲染函数**（不靠域注册）；
//   域**只注册声明**：十类里每一类要么域明确给、要么引用一个已登记的定义、要么用公共默认值；
//   引用了不存在的定义 / 用了不存在的格式 / 找不到保存动作 / 保存策略和保存动作的能力对不上 /
//   只写「不允许部分保存」却没写整组范围 ⇒ **注册被拒并指出具体是哪一条**，而且**这一类压根没被登记**
//   （不许空白降级后照常允许确认）；
//   **第 5 类「可编辑范围」只有一档**（**所有候选都能改写** —— 用户 2026-10-24 12:0x 原话：
//   「**所有候选的内容都是能改的，审核中心只有『是只能全部采纳』和『允许部分采纳』**」），
//   域写了产品**没有**的那一档（只能采用／别的编辑控件）⇒ **注册被拒并说清只有哪一档**
//   （**不许「声明说了不算」**）；
//   **准入按 kind 默认**（assistant ⇒ context），域**可以显式改**，
//   但改的值只能是 evidence / context / derived 三档 —— 准入 evidence 的进这一页，
//   context / derived 的**不进这一页**、只给一条指路。」
//
// ⚠️ 判据断的是**行为**（注册口收不收、页面归谁、准入进不进），不是断字符串 ——
//   页面注册表是**真的执行一遍**再查它的（`shangshuPageDefinition` / `shangshuResolvePlatformPage`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDom } from '../../../scripts/tests/mini-dom.mjs';
import {
  loadShell, registerSampleDeclaration, registrySource, appSource, shellSource,
} from './helpers/review-center-shell.mjs';

/** 把静态页面注册表**真的执行一遍**，再查它（不是读源码找字符串）。 */
function loadRegistry() {
  const window = {};
  window.window = window;
  vm.runInNewContext(registrySource, window, { filename: 'page-registry.js' });
  return window;
}

test('① 页面归核心域：静态注册表里有这一页，属主是核心域，平台模式进得去', () => {
  const window = loadRegistry();
  const definition = window.shangshuPageDefinition('review-center');
  assert.ok(definition, '静态页面注册表里没有「审核中心」这一页 —— 它该是公共页');
  assert.equal(definition.owner, 'com.shangshu.core', '审核中心这一页不该归任何业务域');
  assert.equal(definition.status, 'implemented');
  assert.equal(definition.platform, true, '这一页得是平台正式页');
  /* 平台模式下这一页**进得去**（角色 staff / finance / manager 都行）。 */
  for (const role of ['staff', 'finance', 'manager', 'admin']) {
    assert.equal(window.shangshuResolvePlatformPage('review-center', role), 'review-center',
      '这一页对角色 ' + role + ' 进不去');
  }
});

test('② 侧栏「工作」组里有「审核中心」这一项（入口是平台自己的，不靠域注册）', () => {
  const workGroup = appSource.match(/\{ sec: '工作', items: \[[\s\S]*?\]}/);
  assert.ok(workGroup, 'app.js 里找不到「工作」分组');
  assert.match(workGroup[0], /id: 'review-center'/, '「工作」组里没有「审核中心」这一项');
  assert.match(workGroup[0], /name: '审核中心'/, '侧栏项的名字不是「审核中心」');
});

test('③ 公共壳自己提供这一页的渲染函数（域不注册页面本体）', () => {
  const dom = createDom();
  const window = { RENDER: {} };
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext(shellSource, context, { filename: 'review-center.js' });
  assert.equal(typeof window.RENDER['review-center'], 'function',
    '公共壳没有提供这一页的渲染函数 —— 页面得由核心域自己出');
  /* 公共壳**不写死任何域的页面 id**（契约 §ownership.domain_role）。 */
  assert.doesNotMatch(shellSource, /example-domain\./,
    '公共壳里写死了 example 的页面 id —— 公共壳不该知道任何域的页面 id');
});

test('④ 声明注册口：十类每类要么域明确给、要么引用既有定义、要么用公共默认值', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;

  /* 引用一个已登记的定义 —— 那是「用已有的那一份」，不是让内核猜业务。 */
  const ok = api.registerDefinition('sample.left-slot', { title: '左边要改什么', format: 'field-table' });
  assert.equal(ok.ok, true, '登记一个命名定义都不行');

  const registered = registerSampleDeclaration(window, {
    key: 'sample.ref',
    leftSlot: { ref: 'sample.left-slot' },
    rightSlot: undefined,          // 不给 ⇒ 用公共默认值
    savePolicy: undefined,         // 不给 ⇒ 用公共默认值
  });
  assert.equal(registered.ok, true, '一份十类齐备的声明不该被拒：' + JSON.stringify(registered.errors));
  const declaration = api.declarations().find(item => item.key === 'sample.ref');
  assert.ok(declaration, '声明没被登记');
  assert.equal(declaration.leftSlot.title, '左边要改什么', '引用没生效');
  assert.equal(declaration.rightSlot.format, 'attachment-list', '没给的第 3 类没落到公共默认值');
  assert.equal(declaration.savePolicy.partial, true, '没给的第 6 类没落到公共默认值');
  assert.equal(declaration.savePolicy.group, 'card', '没给的第 6 类没落到公共默认值');
});

test('⑤ 注册时校验：引用不存在的定义 ⇒ 指出具体问题，**且不登记**', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;
  const result = registerSampleDeclaration(window, {
    key: 'sample.bad-ref',
    leftSlot: { ref: '没登记过的定义' },
  });
  assert.equal(result.ok, false, '引用不存在的定义居然注册成功了');
  assert.ok(result.errors.some(text => /不存在的定义/.test(text)),
    '报错要指出是哪个引用找不到：' + JSON.stringify(result.errors));
  assert.equal(api.declarations().some(item => item.key === 'sample.bad-ref'), false,
    '校验没过却还是登记了 —— 那就是空白降级');
});

test('⑥ 注册时校验：不支持的部件 / 找不到的保存动作 / 策略与动作能力不匹配 / 没写整组范围 ⇒ 逐条指出', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;

  const badFormat = registerSampleDeclaration(window, {
    key: 'sample.bad-format', leftSlot: { title: '左', format: '自造格式' },
  });
  assert.equal(badFormat.ok, false, '用了不存在的格式居然注册成功了');
  assert.ok(badFormat.errors.some(text => /自造格式/.test(text)),
    '报错要指出是哪个格式不支持：' + JSON.stringify(badFormat.errors));

  const badAction = registerSampleDeclaration(window, {
    key: 'sample.bad-action', execution: { saveAction: '没登记过的保存动作' },
  });
  assert.equal(badAction.ok, false, '找不到保存动作居然注册成功了');
  assert.ok(badAction.errors.some(text => /找不到保存动作/.test(text)),
    '报错要指出保存动作找不到：' + JSON.stringify(badAction.errors));

  /* 保存方式与动作能力不匹配：动作只支持部分保存，声明却要整组。 */
  api.registerSaveAction('sample.partial-only', { id: 'sample.partial-only', groupAccept: false, partialAccept: true });
  const mismatch = registerSampleDeclaration(window, {
    key: 'sample.mismatch',
    savePolicy: { partial: false, unit: '一条变更', group: 'card' },
    execution: { saveAction: 'sample.partial-only' },
  });
  assert.equal(mismatch.ok, false, '保存策略与动作能力对不上居然注册成功了');
  assert.ok(mismatch.errors.some(text => /不支持整组/.test(text)),
    '报错要指出策略与动作能力对不上：' + JSON.stringify(mismatch.errors));

  /* 只写「不允许部分保存」却没写整组范围 —— 契约明说「只写这句还不够」。 */
  const noGroup = registerSampleDeclaration(window, {
    key: 'sample.no-group', savePolicy: { partial: false, unit: '一条变更' },
  });
  assert.equal(noGroup.ok, false, '没写整组范围居然注册成功了');
  assert.ok(noGroup.errors.some(text => /整组/.test(text)),
    '报错要指出没写整组范围：' + JSON.stringify(noGroup.errors));

  assert.equal(api.declarations().filter(item => String(item.key).startsWith('sample.')).length, 0,
    '校验没过的那几条居然都被登记了');
});

test('⑦ 第 5 类「可编辑范围」**只有一档**：所有候选都能改写 —— 域写了产品没有的那一档 ⇒ 注册被拒并说清', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;

  /* **为什么只有一档**（用户 2026-10-24 12:0x 原话）：
     「**所有候选的内容都是能改的，审核中心只有『是只能全部采纳』和『允许部分采纳』**」
     ⇒ 「哪些只能采用或暂不处理」这个档**这个产品没有** ⇒ 域若写了它，
     **注册当场拒**（不许「声明说了不算」：域以为它限住了，人却照样能改）。 */

  /* 不写 ⇒ 用公共默认值（**所有候选都能改写**）。 */
  const defaults = registerSampleDeclaration(window, { key: 'sample.editable-default' });
  assert.equal(defaults.ok, true, '不写第 5 类不该被拒：' + JSON.stringify(defaults.errors));
  const declaration = api.declarations().find(item => item.key === 'sample.editable-default');
  assert.ok(declaration, '声明没被登记');
  assert.equal(declaration.editable.mode, 'adopt-and-edit',
    '没给的第 5 类没落到公共默认值（所有候选都能改写）');
  assert.equal(declaration.editable.control, 'text', '没给的第 5 类没落到公共默认值（编辑控件）');

  /* 写「只能采用」那一档 ⇒ **当场拒** ＋ 报错要说明**只有哪一档** ＋ **不登记**。 */
  const adoptOnly = registerSampleDeclaration(window, {
    key: 'sample.adopt-only', editable: { mode: 'adopt-only', control: 'text' },
  });
  assert.equal(adoptOnly.ok, false, '写了产品没有的那一档居然注册成功了');
  assert.ok(adoptOnly.errors.some(text => /可编辑范围/.test(text) && /所有候选都能改写/.test(text)),
    '报错要说明可编辑范围只有哪一档：' + JSON.stringify(adoptOnly.errors));
  assert.equal(api.declarations().some(item => item.key === 'sample.adopt-only'), false,
    '校验没过却还是登记了 —— 那就是空白降级');

  /* 用了**公共编辑控件没有的**那个控件 ⇒ 同样当场拒（不许悄悄按文本框处理）。 */
  const badControl = registerSampleDeclaration(window, {
    key: 'sample.bad-control', editable: { mode: 'adopt-and-edit', control: '下拉' },
  });
  assert.equal(badControl.ok, false, '用了不存在的编辑控件居然注册成功了');
  assert.ok(badControl.errors.some(text => /编辑控件/.test(text)),
    '报错要指出是哪个编辑控件不支持：' + JSON.stringify(badControl.errors));
  assert.equal(api.declarations().some(item => item.key === 'sample.bad-control'), false,
    '校验没过却还是登记了 —— 那就是空白降级');
});

test('⑧ 准入：按 kind 默认，域可以显式改，但只许三档', () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;

  /* 默认：assistant ⇒ context（就地可判型）⇒ **不进这一页**，只给指路。 */
  const assistant = registerSampleDeclaration(window, {
    key: 'sample.assistant', kind: 'assistant', review: undefined,
  });
  assert.equal(assistant.ok, true, '一份 assistant 声明被拒了：' + JSON.stringify(assistant.errors));
  assert.equal(assistant.declaration.admission, 'context', 'assistant 没落到 context');
  assert.equal(api.pageDeclarations().some(item => item.key === 'sample.assistant'), false,
    '就地可判型不该进这一页');
  assert.equal(api.redirectDeclarations().some(item => item.key === 'sample.assistant'), true,
    '就地可判型该有一条指路');

  /* automation ⇒ evidence（凭据对照型）⇒ **进这一页**。 */
  const automation = registerSampleDeclaration(window, { key: 'sample.automation', kind: 'automation', review: undefined });
  assert.equal(automation.declaration.admission, 'evidence', 'automation 没落到 evidence');
  assert.equal(api.pageDeclarations().some(item => item.key === 'sample.automation'), true,
    '凭据对照型不进这一页');

  /* 域可以**显式**改（这里：把 official 显式改成 context）。 */
  const explicit = registerSampleDeclaration(window, {
    key: 'sample.explicit', kind: 'official', review: 'context',
  });
  assert.equal(explicit.declaration.admission, 'context', '域的显式覆盖没生效');

  /* 但不许另造语义：第四档一律拒。 */
  const invented = registerSampleDeclaration(window, { key: 'sample.invented', review: 'whatever' });
  assert.equal(invented.ok, false, '准入出现了第四档居然注册成功了');
  assert.ok(invented.errors.some(text => /evidence \/ context \/ derived/.test(text)),
    '报错要指出准入只许三档：' + JSON.stringify(invented.errors));
});

test('⑨ 公共规则不许各业务覆盖：声明里塞进来的脚本/样式不会变成页面上的东西', async () => {
  const dom = createDom();
  const { window } = loadShell(dom);
  const api = window.shangshuReviewCenter;
  registerSampleDeclaration(window, {
    key: 'sample.injected', identity: { title: 'x', script: 'alert(1)', css: 'body{display:none}' },
  });
  const host = dom.h('div', { class: 'main-scroll', 'data-page': 'review-center' });
  dom.body.appendChild(host);
  await api.mountPage(host, {});
  const text = dom.body.textContent;
  assert.ok(!text.includes('alert(1)'), '声明里塞的脚本被画到页面上了');
  assert.ok(!text.includes('display:none'), '声明里塞的样式被画到页面上了');
});
