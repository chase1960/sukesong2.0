/* CSS 层叠解析器 —— 边距判据的公共工具（**只此一份**）。
 *
 * 做什么：
 *   ① 把 CSS 解析成「规则 + 声明 + at-rule 上下文」；
 *   ② 按 **加载顺序**（shangshu-web/index.html 里的 <link> 次序）算出某个
 *      「选择器 + 属性」**真正生效**的值（媒体查询按视口宽度生效，
 *      容器查询无法在判据里求值 ⇒ 视同不生效）；
 *   ③ 把 margin / padding 简写**展开成四边**，并把一条包含链上的
 *      「左外边距 + 左内边距」加起来 ⇒ 得到**算出来的左边缘**。
 *
 * 为什么不用眼睛看：CSS 的层叠是「同属性最后一条 + 媒体查询 + 加载顺序 +
 * 跨文件覆盖」四件事搅在一起的，靠眼看一定会算错（本次实算就发现
 * `.admin-destinations` 在 admin-pages.css 里被改成 margin:0）。
 *
 * 用法：
 *   import { createResolver } from '../../../scripts/lib/css-cascade.mjs';
 *   const r = createResolver(rootUrl);
 *   r.resolve('.platform-page', 'padding', { viewport: 1440 });   // → { value, file, line }
 *   r.leftEdge([{ file: 'css/platform.css', selector: '.platform-section' }]);
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- 解析 ---------- */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') n++;
  return n;
}
export function parseDecls(inner) {
  const decls = [];
  let depth = 0, buf = '';
  const flush = () => {
    const raw = buf.trim();
    buf = '';
    if (!raw) return;
    const at = raw.indexOf(':');
    if (at < 0) return;
    const prop = raw.slice(0, at).trim().toLowerCase();
    const value = raw.slice(at + 1).trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*!important\s*$/i, '');
    if (prop) decls.push({ prop, value });
  };
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { flush(); continue; }
    buf += ch;
  }
  flush();
  return decls;
}
export function parseRules(text, start, atRules, out, base) {
  let i = start;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const prelude = text.slice(i, brace).replace(/\s+/g, ' ').trim();
    let depth = 1, j = brace + 1;
    while (j < text.length && depth) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const inner = text.slice(brace + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (inner.includes('{')) parseRules(inner, 0, atRules.concat([prelude]), out, base);
      else out.push({ selector: prelude, decls: parseDecls(inner), atRules, line: lineOf(base, brace) });
    } else {
      out.push({ selector: prelude, decls: parseDecls(inner), atRules, line: lineOf(base, brace) });
    }
    i = j;
  }
}
export function parseCssFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rules = [];
  parseRules(stripComments(raw), 0, [], rules, raw);
  return rules;
}

/* ---------- 媒体查询 ---------- */
/** 这条 @media 在给定视口宽度下**是否生效**。容器查询（@container）无法在判据里求值 ⇒ 视同不生效。 */
export function mediaApplies(atRule, viewport) {
  if (!atRule) return true;
  const query = atRule.replace(/^@media\s*/i, '').trim();
  if (/@container/.test(query)) return false;
  if (/print/.test(query) && !/screen/.test(query)) return false;
  const conditions = query.split(/\s+and\s+/i);
  for (const condition of conditions) {
    const text = condition.trim();
    if (!text) continue;
    const max = text.match(/max-width\s*:\s*([\d.]+)px/i);
    const min = text.match(/min-width\s*:\s*([\d.]+)px/i);
    if (!max && !min) return false;              // 认不出来的条件 ⇒ 不生效（宁可少算，不瞎算）
    if (max && viewport > Number(max[1])) return false;
    if (min && viewport < Number(min[1])) return false;
  }
  return true;
}

/* ---------- 简写 ---------- */
/** CSS 简写 → 四边 [top, right, bottom, left]。 */
export function sides(value) {
  if (value === null || value === undefined) return [0, 0, 0, 0];
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}
/** px 值；不是 px（auto / % / var / calc）⇒ null（判据里当「算不出来」处理，不当 0）。 */
export function px(value) {
  const text = String(value ?? '0').trim();
  if (text === '0') return 0;
  const matched = text.match(/^(-?[\d.]+)px$/);
  return matched ? Number(matched[1]) : null;
}

function selectorParts(selector) {
  return selector.split(',').map(part => part.trim());
}

/* ---------- 解析器 ---------- */
export function createResolver(root) {
  const rootPath = typeof root === 'string' ? root : fileURLToPath(root);
  const webRoot = path.join(rootPath, 'shangshu-web');
  const cache = new Map();

  /* 加载顺序：index.html 里 <link rel="stylesheet"> 的次序（域内 CSS 运行时追加 ⇒ 排在最后）。 */
  function stylesheetOrder() {
    const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
    const files = [];
    const re = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
    let matched;
    while ((matched = re.exec(html))) {
      const href = matched[1].split('?')[0];
      if (!href.startsWith('css/')) continue;
      files.push(path.join(webRoot, href));
    }
    const domainsDir = path.join(webRoot, 'css', 'domains');
    if (fs.existsSync(domainsDir)) {
      for (const dir of fs.readdirSync(domainsDir)) {
        const full = path.join(domainsDir, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const name of fs.readdirSync(full).sort()) {
          if (name.endsWith('.css')) files.push(path.join(full, name));
        }
      }
    }
    return files;
  }
  const order = stylesheetOrder();

  const rulesFor = file => {
    if (!cache.has(file)) cache.set(file, parseCssFile(file));
    return cache.get(file);
  };

  /** 某个文件里，该选择器该属性的**最后一条生效声明**（媒体查询按视口生效）。 */
  function resolveIn(file, selector, prop, viewport) {
    const rules = rulesFor(file);
    let hit = null;
    for (const rule of rules) {
      if (!selectorParts(rule.selector).includes(selector)) continue;
      if (!rule.atRules.every(at => mediaApplies(at, viewport))) continue;
      for (const decl of rule.decls) {
        if (decl.prop === prop) hit = { value: decl.value, file, line: rule.line, atRules: rule.atRules };
      }
    }
    return hit;
  }

  /** 按**加载顺序**在若干文件里解析（后加载的赢）。files 省略时用整站加载顺序。 */
  function resolve(selector, prop, { viewport = 1440, files } = {}) {
    const list = files || order;
    let hit = null;
    for (const file of list) {
      if (!fs.existsSync(file)) continue;
      const found = resolveIn(file, selector, prop, viewport);
      if (found) hit = found;
    }
    return hit;
  }

  /** 一条包含链的**算出来的左边缘** = Σ(每环的左外边距 + 左内边距)。 */
  function leftEdge(chain, { viewport = 1440 } = {}) {
    const computed = computeChain(chain, viewport);
    return { edge: computed.steps.reduce((sum, step) => sum + (step.marginLeft || 0) + (step.paddingLeft || 0), 0), steps: computed.steps };
  }

  /** 一条包含链的**容器外沿**左边缘 = Σ(每环的左外边距) —— 不算内边距。
   *  ⚠️ 页面根容器那一层的**内边距就是整页留白**（L1），要算进外沿请自己加上 `pageGutter()`。 */
  function leftEdgeOuter(chain, { viewport = 1440 } = {}) {
    const computed = computeChain(chain, viewport);
    return { edge: computed.steps.reduce((sum, step) => sum + (step.marginLeft || 0), 0), steps: computed.steps };
  }

  /** 页面根容器 `.platform-page` 给的**整页左右留白**（L1，px）。 */
  function pageGutter({ viewport = 1440 } = {}) {
    const hit = resolveIn(path.join(webRoot, 'css', 'platform.css'), '.platform-page', 'padding', viewport);
    if (!hit) return null;
    const value = px(sides(hit.value)[3]);
    return value === null ? null : value;
  }

  function computeChain(chain, viewport) {
    const steps = [];
    for (const link of chain) {
      const file = path.isAbsolute(link.file) ? link.file : path.join(webRoot, link.file);
      const margin = resolveIn(file, link.selector, 'margin', viewport);
      const padding = resolveIn(file, link.selector, 'padding', viewport);
      const ml = margin ? px(sides(margin.value)[3]) : 0;
      const pl = padding ? px(sides(padding.value)[3]) : 0;
      steps.push({
        ...link,
        margin: margin?.value ?? null,
        padding: padding?.value ?? null,
        marginLeft: ml === null ? null : ml,
        paddingLeft: pl === null ? null : pl,
        uncomputable: ml === null || pl === null,
      });
    }
    return { steps };
  }

  return {
    order, resolve, resolveIn, leftEdge, leftEdgeOuter, pageGutter, rulesFor,
    webRoot,
    rel: file => path.relative(rootPath, file),
  };
}
