// 判据：**「审核中心」这一项要出现在侧栏里**（用户口径 2026-10-22 18:15：审核中心是
// 独立于 example 的**公共能力**，侧栏放在「工作」组，所有岗位都能用）。
//
// **测试通过 =**（一句话）
// 「不管你是管理员、会计、项目负责人还是员工，打开尚书，左侧栏『工作』那一组里
//   都有一项『审核中心』，点它就能打开审核中心那一页 —— 不用背地址。」
//
// ⚠️ **为什么要有这条**（2026-10-22 站上实测）：
//   按地址 `#/review-center` 能打开、页面也画得对，**但侧栏里没有那一项** ⇒ 用户点不到。
//   真凶**不是**「渲染函数挂得晚」，而是**岗位预设（`ROLE_PRESET`）里压根没列它**：
//   `defaultSidebarLayoutGroups()` 只保留
//   「在岗位预设里 ∨ 用户自己加过（extra）∨ 域注册入口（domainEntry）」的项，
//   四份预设里都没有 `review-center` ⇒ 无论有没有重画侧栏，它都进不了侧栏。
//   （此前那笔「load 之后重画侧栏」的兜底**已在站上**，侧栏仍然缺这一项 ⇒ 证明时序不是原因。）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const appSource = fs.readFileSync(path.join(ROOT, 'shangshu-web/js/app.js'), 'utf8');
const registrySource = fs.readFileSync(path.join(ROOT, 'shangshu-web/js/page-registry.js'), 'utf8');
const reviewCenterSource = fs.readFileSync(path.join(ROOT, 'shangshu-web/js/review-center.js'), 'utf8');

/** 从源码里切出一个字面量（`const X = {…}` / `[…]`），跳过注释与字符串。 */
function extractLiteral(src, header) {
  const at = src.indexOf(header);
  assert.ok(at > 0, `源码里找不到 ${header}`);
  const eq = src.indexOf('=', at);
  const open = (() => {                 // '=' 之后第一个非空白字符就是字面量的开口
    for (let i = eq + 1; i < src.length; i++) {
      if (/\s/.test(src[i])) continue;
      return i;
    }
    return -1;
  })();
  const openCh = src[open];
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {            // 行注释
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {        // 字符串
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `${header} 那个字面量没闭合`);
  return Function(`"use strict"; return (${src.slice(open, i + 1)});`)();
}

const ROLE_PRESET = extractLiteral(appSource, 'const ROLE_PRESET =');
const GROUPS = extractLiteral(appSource, 'const GROUPS =');

/** 页面注册表（page-registry.js 是纯 IIFE，直接在沙箱里跑一遍）。 */
const registryRoot = {};
new Function('window', registrySource)(registryRoot);
const pageMeta = registryRoot.shangshuPageDefinition;

/** 渲染函数存在与否：用 review-center.js 里的挂载语句代替（浏览器里跑不了整个前端）。 */
function renderRegistered(id) {
  return reviewCenterSource.includes(`RENDER['${id}']`) || reviewCenterSource.includes(`RENDER["${id}"]`);
}

const ROLES = ['admin', 'finance', 'manager', 'staff'];

/** 照抄 app.js 的 `pageAvailable()` 与 `defaultSidebarLayoutGroups()` 的过滤规则。 */
function defaultSidebarIdsFor(role) {
  const preset = ROLE_PRESET[role] || ROLE_PRESET.staff || [];
  const meta = pageMeta('review-center');
  const pageAvailable = !!meta && !!meta.platform && ['implemented', 'compatibility'].includes(meta.status) && renderRegistered('review-center');
  return GROUPS
    .filter(g => g.items.some(m => !m.roles && pageAvailable))
    .map(g => ({ sec: g.sec, items: g.items.filter(m => !m.roles && pageAvailable && preset.includes(m.id)).map(m => m.id) }))
    .filter(g => g.items.length);
}

test('① 每个岗位的预设里都有「审核中心」（不在预设 ⇒ 默认侧栏里就没有它）', () => {
  for (const role of ROLES) {
    const preset = ROLE_PRESET[role] || ROLE_PRESET.staff || [];
    assert.ok(preset.includes('review-center'),
      `岗位「${role}」的侧栏预设里没有「审核中心」⇒ 默认侧栏缺这一项，用户点不到`);
  }
});

test('② 按 app.js 的默认布局规则算出来，四个岗位的侧栏里都有「审核中心」', () => {
  for (const role of ROLES) {
    const groups = defaultSidebarIdsFor(role);
    const ids = groups.flatMap(g => g.items);
    assert.ok(ids.includes('review-center'),
      `岗位「${role}」的默认侧栏里没有「审核中心」（算出来的是：${JSON.stringify(groups)}）`);
  }
});

test('③ 「审核中心」落在侧栏「工作」组（用户口径：侧栏「工作」组）', () => {
  const group = GROUPS.find(g => g.items.some(m => m.id === 'review-center'));
  assert.ok(group, '侧栏分组表里根本没有「审核中心」这一项');
  assert.equal(group.sec, '工作', `「审核中心」现在在「${group.sec}」组，应在「工作」组`);
});

test('④ 准入闸放行：审核中心在页面注册表里是平台正式页（platform + implemented）', () => {
  const meta = pageMeta('review-center');
  assert.ok(meta, '页面注册表里没有审核中心这一页');
  assert.equal(meta.platform, true, '审核中心被标成非平台页 ⇒ 平台模式下进不去');
  assert.ok(['implemented', 'compatibility'].includes(meta.status),
    `审核中心状态是「${meta.status}」，不属于 implemented/compatibility ⇒ 侧栏不放行`);
  assert.ok(meta.roles.length >= ROLES.length,
    `审核中心声明的角色是 ${JSON.stringify(meta.roles)}，覆盖不到全部岗位`);
});

test('⑤ 渲染函数确实挂在 RENDER 上（侧栏那一项还得有页面可跳）', () => {
  assert.ok(renderRegistered('review-center'),
    'review-center.js 没有往 RENDER 上挂「审核中心」的渲染函数 ⇒ 点开是白屏');
});

test('⑥ 通用兜底仍在：所有脚本加载完之后重画一次侧栏（晚挂 RENDER 的页也能进侧栏）', () => {
  assert.match(appSource, /addEventListener\(\s*['"]load['"]/,
    'app.js 没有在 load 之后重画侧栏 ⇒ 晚挂 RENDER 的页进不了侧栏');
  const block = appSource.slice(appSource.indexOf("addEventListener('load'"));
  assert.match(block.slice(0, 400), /renderChrome\(\)/,
    'load 回调里没有调 renderChrome（侧栏不会被重画）');
});
