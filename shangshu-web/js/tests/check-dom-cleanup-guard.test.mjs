// 判据：公共壳里「先查再删」的写法 —— **不许打空**，也**不许删一个本文件根本没有的元素**。
//
// **测试通过 =**（一句话）
// 「点开任何一个页面，**不会因为一句『删某个元素』的代码而整页挂掉**：
//   ① 凡是『查了再删』的语句，删之前都承认了『它可能不在』（写成 `?.remove()`，或先判存在）；
//   ② 凡是『删某个元素』的语句，它删的那个元素**这个文件真的造得出**
//      （类名 ／ id ／ data 属性都算）—— 不许留一句删空气的死代码。」
//
// ⚠️ **这条判据是从一次真事故倒推出来的**（2026-10-23 巡站抓到，2026-10-24 开包修）：
//   `shangshu-web/js/real-objects.js` 第 54 行 `$('.sub',shell).remove();`
//   —— 而模板里那个 `.sub` 元素**已经在 PKG-063（ffa581f54）里删掉了**
//   （页头条上那行「这个页面是干什么的」解释，PKG-063 删了 47 条里的一条）。
//   ⇒ 查不到 ⇒ `null.remove()` ⇒ 站上控制台报
//     `Cannot read properties of null (reading 'remove')`
//   ⇒ **「数据」页（`#/objects`）整页挂掉**，页面上只剩「数据目录暂时无法读取」。
//
// **改之前**（一个能照着重做的具体操作）：
//   点开侧栏的「**数据**」⇒ 页面中间那块不是数据表列表，
//   而是「**数据目录暂时无法读取**」＋ 一个「重新加载」按钮（按了还是这句）。
//
// **改之后**（同样的操作）：
//   点开「**数据**」⇒ 左边「数据表」一栏列出数据表，右侧显示选中那张表的记录；
//   控制台**没有** `Cannot read properties of null` 那一行。
//
// **怎么看**：
//   浏览器打开 `http://127.0.0.1:3850/#/objects` ⇒ 「数据」页**能打开**（不再显示
//   「数据目录暂时无法读取」），控制台无 `reading 'remove'` 的报错。
//
// 📌 **这条判据的边界**（说清楚它管得到什么、管不到什么）：
//   · 只断**「查询结果直接被删」**这一种写法 ——
//     即 `$('.x').remove()` / `q('#x').remove()` / `host.querySelector('[data-x]').remove()`
//     （`.closest(...)` 链式不算：它的接收者是查到的元素的祖先，语义不同）；
//   · **先存进变量再删**的写法（`const el=$('.x'); … el.remove()`）**断不了** ——
//     那一条靠人看；本判据不假装管得到；
//   · 「查的助手」只认三种：`$`（全局 `querySelector`）、`X.querySelector`、
//     以及**本文件里自己定义成 `querySelector` 的本地助手**（如 `mail-center.js` 的 `q`）——
//     `q` 这种名字在别的文件里可能是别的东西（`new URLSearchParams` / `Number`），
//     所以**按文件认**，不按名字认。
//   · 扫描范围：`shangshu-web/js/` 全部源码（公共壳 ＋ 域内）；
//     `domains/excel-univer/` 是构建产物，不算源码。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
/* ⚠️ **不许用 `url.pathname` 当文件路径**：仓库路径里有中文（`尚书重构`）⇒
   `.pathname` 给的是**百分号编码**的串 ⇒ 读文件直接 ENOENT。⇒ 一律走 `fileURLToPath()`。 */
const ROOT_PATH = fileURLToPath(ROOT);

const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

/** `shangshu-web/js/` 下的 .js 源码（构建产物 `domains/excel-univer/` 不算）。 */
function jsFiles(dir = new URL('shangshu-web/js/', ROOT)) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      if (fileURLToPath(full).includes('domains/excel-univer')) continue;
      out.push(...jsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(fileURLToPath(full));
    }
  }
  return out;
}

/* ───────────────── 名字归一（让「同一个元素」在不同写法下能对上） ───────────────── */

/** `chatWelcome` → `chat-welcome`；`PF_Simulation` → `pf-simulation`；中文原样。 */
const canonical = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/[_\s]+/g, '-')
  .toLowerCase();

/** 选择器 → 元素身份：`.cf-error` → `cf-error`；`#x` → `x`；`[data-x]` → `x`。 */
function selectorToken(selector) {
  const s = String(selector).trim();
  if (s.startsWith('.')) return canonical(s.slice(1));
  if (s.startsWith('#')) return canonical(s.slice(1));
  const attr = s.match(/^\[([\w-]+)\]$/);
  if (attr) {
    const name = attr[1];
    return canonical(name.startsWith('data-') ? name.slice(5) : name);
  }
  return canonical(s);
}

/** 这个文件**造得出**哪些元素身份**（字符串字面量 ＋ `dataset.xxx`）。 */
function producedTokens(source) {
  const tokens = new Set();
  for (const m of source.matchAll(/(['"`])([^'"`\n]*)\1/g)) tokens.add(canonical(m[2]));
  for (const m of source.matchAll(/dataset\.([A-Za-z_$][\w$]*)/g)) tokens.add(canonical(m[1]));
  return tokens;
}

/* ───────────────── 「先查再删」的语句在哪 ───────────────── */

/** 这个文件里 `q` / `qs` 是不是**查询助手**（`q = s => ....querySelector(s)`）。 */
function isQueryHelper(source, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*[^;]*querySelector`, 'm');
  return re.test(source);
}

/**
 * 找出「查询结果直接被删」的语句。
 * 返回 `{file, line, selector, guarded, text}`；`guarded`＝删除是否空安全（`?.remove()`）。
 */
function findQueryRemovals() {
  const out = [];
  for (const file of jsFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT_PATH, file);
    const helpers = new Set(['$']);
    for (const name of ['q', 'qs']) if (isQueryHelper(source, name)) helpers.add(name);
    const lines = source.split('\n');
    lines.forEach((text, i) => {
      const push = (selector, guarded) => out.push({
        file: rel, line: i + 1, selector, guarded, text: text.trim(),
      });
      // `$('.x')` / `q('.x')` —— 只接一个字符串参数（`$(sel, ctx)` 也认）
      /* ⚠️ **助手名必须转义**：JS 里 `$` 在正则的**任何位置**都是「行尾/结尾」锚点，
         不是字面量 ⇒ 不转义写成 `($)` 就变成「匹配到结尾」，一条都匹配不上。 */
      const helperAlt = [...helpers].map(h => h.replace(/\$/g, '\\$')).join('|');
      const helperRe = new RegExp(
        `(?<![\\w$])(${helperAlt})\\(\\s*(['"\`])([^'"\`]+)\\2\\s*(?:,[^()]*)?\\)\\s*(\\?)?\\s*\\.remove\\(\\)`,
        'g');
      let m;
      while ((m = helperRe.exec(text))) push(m[3], m[4] === '?');
      // `host.querySelector('.x')` —— 成员查询
      const memberRe = /([A-Za-z_$][\w$]*)\.querySelector\(\s*(['"])([^'"]+)\2\s*\)\s*(\?)?\s*\.remove\(\)/g;
      while ((m = memberRe.exec(text))) push(m[3], m[4] === '?');
    });
  }
  return out;
}

const REMOVALS = findQueryRemovals();

/* ───────────────── ① 先查再删 ⇒ 不许打空 ───────────────── */
test('① 公共壳里「查了再删」的语句都空安全（查不到不会把整页带崩）', () => {
  const unsafe = REMOVALS.filter(r => !r.guarded);
  assert.equal(unsafe.length, 0,
    '下面这些「查了再删」的语句**没判存在就直接删** —— 查不到就是 `null.remove()`，整页带崩：\n'
    + unsafe.map(r => `   · ${r.file}:${r.line} ${r.text}`).join('\n')
    + '\n⇒ 改成 `?.remove()`（或先判存在再删）。');
});

/* ───────────────── ② 删的元素必须是本文件造得出来的 ───────────────── */
test('② 公共壳里「删某个元素」的语句，它删的元素这个文件真的造得出（不许留删空气的死代码）', () => {
  const dead = [];
  for (const r of REMOVALS) {
    const source = fs.readFileSync(path.join(ROOT_PATH, r.file), 'utf8');
    const token = selectorToken(r.selector);
    if (producedTokens(source).has(token)) continue;
    dead.push(`   · ${r.file}:${r.line} 删「${r.selector}」（身份 ${token}）—— 这个文件里**从来没有**造出过它`);
  }
  assert.equal(dead.length, 0,
    '下面这些语句在删一个**这个文件根本没有**的元素 —— 元素没了、清理代码还留着：\n'
    + dead.join('\n')
    + '\n⇒ 元素没了就把清理代码一起删掉（留着它就是一句骗人的死代码）。');
});

/* ───────────────── ③ 真事故那一行：数据页不许再有「删 `.sub`」 ───────────────── */
test('③ 「数据」页（real-objects.js）里那句删 `.sub` 的代码没了（PKG-063 删了元素、清理代码没跟着删）', () => {
  const source = read('shangshu-web/js/real-objects.js');
  assert.ok(!/\$?\(\s*['"]\.sub['"]\s*,\s*[^)]*\)\s*\.remove\(\)/.test(source),
    'real-objects.js 里还在删 `.sub` —— 那个元素 PKG-063 已经从模板里删掉了，'
    + '这句必然打空 ⇒「数据」页整页挂掉（`Cannot read properties of null (reading \'remove\')`）。');
  assert.ok(!/class="sub"/.test(source),
    'real-objects.js 的模板里又挂了一个 `.sub` —— 页头条不许挂解释性副标题（PKG-063 的规矩）。');
});
