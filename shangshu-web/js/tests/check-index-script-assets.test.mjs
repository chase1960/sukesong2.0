// 判据：**入口页的每个 `<script>` 标签都得真能加载** —— 一个标签坏一次，
// 那一整页的脚本就永远不加载（PKG-128-T01 · 2026-10-26）。
//
// **测试通过 =**（一句话）
// 「**入口页 `index.html` 里每一个 `<script src=...>` 都写对了（属性名是 `src`、等号不缺、
//   引号成对）⇒ 浏览器每个都真去加载；同一个文件只引一次；引的文件在磁盘上真的存在。**」
//
// **改之前**：`index.html` 里有 **8 个 `<script src"js/xxx.js">`** —— `src` 后面**少了等号**
//   （10-22 那笔「前端资源全站只用一个版本戳」改坏的：给原来没带戳的 8 个文件补戳时，
//   把 `src="js/erp-mock.js"` 写成了 `src"js/erp-mock.js?v=..."`）。
//   浏览器把 `src"js/erp-mock.js"` 当成一个**未知属性名** ⇒ **没有 src** ⇒ 这 8 个脚本
//   **从 2026-10-22 起一次都没加载过**。
//   ⇒ 后果（站上实测）：侧栏「消息」「日历」「项目管理」「数字员工」「Skill 同步」
//   「协作任务」「消息参考」等入口点进去，因为 `RENDER` 没定义 ⇒ **弹回工作台**。
//   另外 `js/file-center.js` 在 165、166 两行**引了两次**。
// **改之后**：8 个标签的等号补上、重复引用去掉 ⇒ 这 8 个脚本重新加载 ⇒
//   上面那些侧栏入口不再弹回工作台。
// **怎么看**：浏览器打开 `http://127.0.0.1:3850/index.html`，看控制台网络面板里
//   `erp-mock.js`／`mock-pages.js` 等 8 个文件**是 200 且真的被请求了**；
//   再点侧栏「消息」⇒ **落在消息那一页**，不是弹回工作台。
//
// ⚠️ **这条不许只看「标签长得像对的」**：真拿浏览器解析一遍 HTML 再看它认不认这个 src。
//   只用正则查 `src="` 会**漏掉** `src"` 这种少等号的写法（那正是这次的真凶）。
// ⚠️ 也别只查重复：重复的 `file-center.js` 是另一个毛病，两条一起断。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const INDEX_PATH = ROOT_PATH + 'shangshu-web/index.html';
const html = fs.readFileSync(INDEX_PATH, 'utf8');

/**
 * 用**浏览器同款**的解析规则取出 script 标签 —— 不是正则。
 * HTML 解析器遇到 `src"js/x.js"` 时：属性名读到 `src` 后遇到 `"`（不是 `=`），
 * 于是它认为**属性名还没结束**，把整段 `src"js/x.js"` 当成一个属性名 ⇒ **这个标签没有 src**。
 * 所以判据必须复刻这条规则，不能只查「有没有 src="」。
 */
function parseScriptTags(source) {
  const tags = [];
  const re = /<script\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(source))) {
    const attrs = match[1];
    const tag = { raw: attrs, src: null, hasSrcAttribute: false, malformed: [] };

    // —— 按 HTML 规范扫属性（属性名状态 / 属性值状态）——
    // 规范要点：**属性名读到空白、`/`、`>`、`=` 为止**；引号在属性名里是「解析错误但仍算名字的一部分」。
    // ⇒ `src"js/x.js"` 的属性名是 `src"js/x.js?v`（`=` 之后进值状态），
    //    **没有名叫 src 的属性** ⇒ 浏览器不会加载这个脚本。
    //    判据必须复刻这条，不能只查「有没有 src="」。
    let i = 0;
    const s = attrs;
    const isSpace = ch => /\s/.test(ch);
    while (i < s.length) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === '/') { i++; continue; }
      let name = '';
      while (i < s.length && !/[\s=/>]/.test(s[i])) { name += s[i]; i++; }
      if (!name) { i++; continue; }
      let j = i;
      while (j < s.length && isSpace(s[j])) j++;
      let value = null;
      if (s[j] === '=') {
        j++;
        while (j < s.length && isSpace(s[j])) j++;
        if (s[j] === '"' || s[j] === "'") {
          const quote = s[j]; j++;
          const end = s.indexOf(quote, j);
          value = end < 0 ? s.slice(j) : s.slice(j, end);
          j = end < 0 ? s.length : end + 1;
        } else {
          let v = '';
          while (j < s.length && !/[\s>/]/.test(s[j])) { v += s[j]; j++; }
          value = v;
        }
        i = j;
      }
      if (name.toLowerCase() === 'src') {
        tag.hasSrcAttribute = true;
        tag.src = value === null ? '' : value;
      } else {
        tag.attrNames = tag.attrNames || [];
        tag.attrNames.push(name);
        // 属性名里混进引号 ⇒ 书写坏了（浏览器不会把它当 src）。
        if (/["'<>]/.test(name)) tag.malformed.push(name);
      }
    }
    tags.push(tag);
  }
  return tags;
}

const scriptTags = parseScriptTags(html);

/* ───────────────── ① 每个带外部引用的 script 都必须有真 src ───────────────── */
test('① 入口页每个 `<script>` 都真的带 src（属性名写对了、等号不缺、引号成对）', () => {
  // 内联脚本（只有 id/type 之类、没有 src）本来就该没有 src ⇒ 不算坏。
  // 坏的是：**想引外部文件、却因为少一个等号把 src 写坏了**
  // （`src"js/x.js"` ⇒ 属性名变成 `src"js/x.js?v` ⇒ 浏览器当它内联，空跑）。
  const broken = scriptTags.filter(tag => tag.malformed.length);
  assert.deepEqual(
    broken.map(tag => tag.raw.trim()),
    [],
    '这些 `<script>` 标签浏览器**不会去加载**（属性名不是 src／缺等号）：\n'
    + broken.map(tag => '  ' + tag.raw.trim()).join('\n')
    + '\n⇒ 这些脚本一次都没加载过 ⇒ 依赖它们的页面入口会弹回工作台。'
  );
});

/* ───────────────── ② 同一个文件不许引两次 ───────────────── */
test('② 同一个脚本文件只引一次（重复引用＝多下一份、多跑一遍初始化）', () => {
  const seen = new Map();
  for (const tag of scriptTags) {
    if (!tag.src) continue;
    const file = tag.src.split('?')[0];
    if (!seen.has(file)) seen.set(file, 0);
    seen.set(file, seen.get(file) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicated, [],
    '这些文件在入口页里被引了不止一次：\n'
    + duplicated.map(([file, count]) => `  ${file} ×${count}`).join('\n')
    + '\n⇒ 多下一份、多跑一遍初始化。');
});

/* ───────────────── ③ 引的文件真的在磁盘上 ───────────────── */
test('③ 入口页引的每个脚本文件在磁盘上真的存在（不许引一个 404 的文件名）', () => {
  const missing = [];
  for (const tag of scriptTags) {
    if (!tag.src) continue;
    const rel = tag.src.split('?')[0].replace(/^\.?\//, '');
    if (!rel.startsWith('js/')) continue;
    if (!fs.existsSync(ROOT_PATH + 'shangshu-web/' + rel)) missing.push(tag.src);
  }
  assert.deepEqual(missing, [],
    '入口页引了这些文件，但磁盘上没有 ⇒ 浏览器请求它们会 404：\n'
    + missing.map(src => '  ' + src).join('\n'));
});

/* ───────────────── ④ 侧栏要能进的那些页，渲染函数得真的加载得到 ───────────────── */
test('④ 侧栏里 platform 可进入的页，渲染它的脚本得真被加载（不许整页的入口都失效）', () => {
  // 入口页引的脚本集合（只有真被加载的才算）。
  const loaded = new Set(
    scriptTags.map(tag => tag.src).filter(Boolean).map(src => src.split('?')[0].replace(/^\.?\//, ''))
  );

  // 找出「某个 RENDER 是在哪个脚本里定义的」，再核对那个脚本有没有真被加载。
  const jsDir = ROOT_PATH + 'shangshu-web/js';
  const scripts = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = dir + '/' + entry.name;
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.js')) scripts.push(abs);
    }
  };
  walk(jsDir);

  // 页面注册表里 platform 可进入的那些页（platform:true 且不是 retired/mock）。
  const registrySource = fs.readFileSync(jsDir + '/page-registry.js', 'utf8');
  const enterable = new Set();
  const addRe = /add\(\[([^\]]*)\]\s*,\s*\{([^}]*)\}/g;
  let m;
  while ((m = addRe.exec(registrySource))) {
    const ids = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const meta = m[2];
    const platform = /platform:\s*true/.test(meta);
    const status = (meta.match(/status:\s*'([^']+)'/) || [])[1];
    if (!platform) continue;
    if (status && !['implemented', 'compatibility'].includes(status)) continue;
    ids.forEach(id => enterable.add(id));
  }

  // 每个页的 RENDER 定义在哪个文件里。
  const defineRe = /RENDER\[['"]?([\w.-]+)['"]?\]/g;
  const broken = [];
  for (const scriptAbs of scripts) {
    const rel = 'js/' + scriptAbs.slice(jsDir.length + 1);
    const source = fs.readFileSync(scriptAbs, 'utf8');
    let hit;
    while ((hit = defineRe.exec(source))) {
      const id = hit[1];
      if (!enterable.has(id)) continue;
      if (loaded.has(rel)) continue;
      broken.push(`${id}（定义在 ${rel}，但那个文件没被加载）`);
    }
  }
  assert.deepEqual(broken, [],
    '这些页在侧栏进得去，但定义它的脚本**没被加载** ⇒ 点进去会弹回工作台：\n'
    + broken.map(line => '  ' + line).join('\n'));
});
