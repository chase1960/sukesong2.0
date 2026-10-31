// 判据：**公共壳里不许出现任何业务域的名字**（2026-10-30 用户口径：壳与域彻底分开）。
//
// **测试通过 =**（一句话）
// 「公共壳（`shangshu-web` 顶层：js/、css/、html 入口页，**不含 domains/**）里
//   **一处都不许出现** `example` / `example` / `example-domain` ——
//   无论是**页面上人看得见的字**（壳替域点名），
//   还是**源码注释里当例子举的域**（换一个域看这些说明会以为「壳跟那个域绑着」）⇒ **一处都不许有**。」
//
// **为什么要这条**（用户 2026-10-30 口径：host/壳 与 example 彻底分开）：
// · 壳里写死某个域的名字 ⇒ 换一个域用同一套壳，那张卡会**说错话**（说成别人的业务）；
// · 壳里的说明文字拿某个域当例子 ⇒ 看说明的人会以为**壳跟那个域绑着**。
//
// **怎么算「公共壳」**（尺子照 `fde-commit-policy.json` 的 core_paths 走）：
// · `shangshu-web/js/*.js`（顶层，**不含 `js/domains/`**、不含 `js/tests/`）
// · `shangshu-web/css/*.css`（顶层，**不含 `css/domains/`**）
// · `shangshu-web/*.html`（入口页与预览页）
// · `shangshu-web/js/lib/`、`js/vendor/`、`previews/`、`vendor/` —— **第三方/工具**，不看。
//
// ⚠️ **域目录里的 `example` 是对的**（那是它自己的名字）⇒ 不在扫描范围里。
// ⚠️ **判据文件自己**（`js/tests/`）也不在扫描范围里 —— 判据要提那个名字才能判它。
//
// **怎么跑**：`cd shangshu-web/js/tests && node --test check-shell-no-domain-name.test.mjs`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = new URL('../../', import.meta.url);
const WEB_DIR = fileURLToPath(WEB_ROOT);

/** 域的名字（大小写都算）：壳里一处都不许有。 */
const DOMAIN_NAME = /example|example|example-domain/;

/**
 * **用户自己说过的话照录** —— 这两处**不许改**（改了就是失真）。
 *
 * ⚠️ 用户 2026-10-30 口径里有一条：**用户自己的原话保留**（像壳卡面那句标题、拖列时的口述）。
 * · `real-chat.js`：用户 2026-10-23 拍板④ 的**原话**（他原话里就写的是「example」小写）⇒ 原样留着；
 * · `review-center.js`：用户 2026-10-28 的**原话**（他原话里说的是「开出来给example」）。
 *
 * ⇒ 判据卡的是「**壳自己写死**某个域的名字」；**引用户原话**不算 ⇒ 这两处单列白名单。
 * ⚠️ 白名单按「**该行往上两行之内**必须有出处标记（谁说的/什么时候说的）」来认 ——
 *   有人把原话删了、或把出处标记删了，白名单会当场失效并报错（不许悄悄多留一处）。
 *   `above` ＝ 出处标记允许出现在该行上方第几行内（1＝上一行，2＝上两行内）。
 */
const USER_QUOTE_ALLOWLIST = [
  { file: 'js/real-chat.js', line: 1256, must: '用户拍板④', above: 2 },
  { file: 'js/review-center.js', line: 3396, must: '用户口径', above: 2 },
];

function isAllowedUserQuote(hit) {
  return USER_QUOTE_ALLOWLIST.some(item => {
    if (item.file !== hit.relative || item.line !== hit.line) return false;
    const file = path.join(WEB_DIR, item.file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    // 出处标记在该行上方的允许范围内（该行自己也算）。
    for (let offset = 0; offset <= item.above; offset += 1) {
      const above = (lines[hit.line - 1 - offset] || '').trim();
      if (above.includes(item.must)) return true;
    }
    return false;
  });
}

/** 不在扫描范围里的目录（第三方、工具、域自己的目录、判据目录）。 */
const SKIP_DIRS = new Set(['domains', 'tests', 'lib', 'vendor', 'node_modules', 'dist', 'previews', 'fonts']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    out.push(path.join(dir, entry.name));
  }
  return out;
}

/** 公共壳里该看的文件（js / css / html 顶层）。 */
function shellFiles() {
  const files = [];
  for (const dir of ['js', 'css']) {
    const full = path.join(WEB_DIR, dir);
    if (!fs.existsSync(full)) continue;
    files.push(...walk(full));
  }
  for (const entry of fs.readdirSync(WEB_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) files.push(path.join(WEB_DIR, entry.name));
  }
  return files.filter(f => /\.(js|mjs|css|html)$/.test(f)).sort();
}

/**
 * 把一处命中变成**人话**：哪一行、那一行长什么样。
 * （光说「某文件有 example」没人知道要去改哪一行。）
 */
function hitsIn(file) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(WEB_DIR, file);
  const hits = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (DOMAIN_NAME.test(line)) hits.push({ relative, line: index + 1, text: line.trim() });
  });
  return hits;
}

test('① 公共壳里一处都不许出现任何域的名字（页面上看得见的字 ＋ 源码注释里的例子）', () => {
  const files = shellFiles();
  assert.ok(files.length >= 20, `公共壳的文件数不对（${files.length}）——扫描范围可能没生效`);

  const all = [];
  for (const file of files) all.push(...hitsIn(file));

  // 用户自己说过的话照录 —— 那一两处不算「壳写死域的名字」（口径见白名单说明）。
  const violations = all.filter(hit => !isAllowedUserQuote(hit));

  if (violations.length) {
    const detail = violations.slice(0, 20).map(h => `  ${h.relative}:${h.line}  ${h.text}`).join('\n');
    assert.fail(
      `公共壳里还有 ${violations.length} 处写了某个域的名字：\n${detail}\n` +
      `（页面上看得见的 ⇒ 壳替域点名，说错话；注释里的 ⇒ 看说明的人以为壳跟那个域绑着）`
    );
  }
});

test('①b 用户原话那几处白名单**不许失效**（有人删了/改了原话 ⇒ 当场报出来）', () => {
  for (const item of USER_QUOTE_ALLOWLIST) {
    const file = path.join(WEB_DIR, item.file);
    assert.ok(fs.existsSync(file), `白名单指的那个文件不在了：${item.file}`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const marked = Array.from({ length: item.above + 1 }, (_, offset) =>
      (lines[item.line - 1 - offset] || '').trim()).some(text => text.includes(item.must));
    assert.ok(marked,
      `白名单那处已经不是用户原话了（${item.file}:${item.line} 往上 ${item.above} 行内没有「${item.must}」）——` +
      `要么把原话补回去，要么从白名单里删掉这一条（不许悄悄多留一处域的名字）`);
  }
});

test('② 扫描范围本身是对的（域目录里的名字**不该**被这条判据拦住）', () => {
  // 域的目录里留着 `example` 是对的（那是它自己的名字）⇒ 拿它当反例。
  const domainCss = path.join(WEB_DIR, 'css', 'domains', 'example-domain', 'example-domain.css');
  assert.ok(fs.existsSync(domainCss), '域自己的 css 不在了——这条反例失效了');
  assert.ok(DOMAIN_NAME.test(fs.readFileSync(domainCss, 'utf8')), '域自己的 css 里没有域名——这条反例失效了');

  // 判据文件自己提到那个名字是必须的（不然判不到它）⇒ 它也不在扫描范围里。
  const self = path.join(WEB_DIR, 'js', 'tests', 'check-shell-no-domain-name.test.mjs');
  assert.ok(DOMAIN_NAME.test(fs.readFileSync(self, 'utf8')), '判据文件里没有那个名字——判不到它');

  // 域目录下的 js 也一样。
  const domainJs = path.join(WEB_DIR, 'js', 'domains', 'example-domain', 'example-domain-entry.js');
  assert.ok(fs.existsSync(domainJs), '域自己的 js 不在了——这条反例失效了');
});

test('③ 壳里**不许出现域的页面 id 当例子**（`example-domain.…` 那种写法）', () => {
  // 这一条单列：域的**页面 id**（`example-domain.cases`）比名字本身更具体 ——
  // 留着它，等于把「这个域注册了哪些页」抄进了壳里。
  const offenders = [];
  for (const file of shellFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (/example-domain\./.test(line)) offenders.push(`${path.relative(WEB_DIR, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `壳里还留着某个域的页面 id 当例子：\n  ${offenders.join('\n  ')}`);
});

test('③b 公共壳里**不许出现域自己的文件名**（`example-domain-review-center.js` 那种）', () => {
  // 域自己的文件名留在壳里 ⇒ 壳跟那个域的**实现细节**挂上了（改个文件名壳就失效）。
  const offenders = [];
  for (const file of shellFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (/example-domain-[\w-]+\.js/.test(line)) offenders.push(`${path.relative(WEB_DIR, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `壳里还留着某个域自己的文件名：\n  ${offenders.join('\n  ')}`);
});
