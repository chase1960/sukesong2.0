import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/*
  写信窗的「主题」要看得见是个能点的字段（FIX-25）—— 2026-10-20 UX 走查实况：

  写信窗顶部左上角那行 18px/600 的「邮件主题」**其实是个输入框**（`<input id="c-subject">`），
  但它的边框被写成 `border-color:transparent`（mail-center.css 第 113 行）、底色也透明
  ⇒ 活站算出来的边框是「1px solid rgba(0,0,0,0)」—— 四边全透明，
  **跟一段静态大标题一模一样**。占位文字还是浏览器默认灰 rgb(117,117,117)，
  页面左上角最大的那行字看着就是标题，用户不知道那能点、也不知道该往哪写主题。

  （同一族的缺陷本轮已修两处：FIX-21 那颗没人知道要点的小「+」、FIX-24 600 多像素点不动的空白栏。）

  测试通过 = 下面全部成立：
  1. 主题输入框**没聚焦**时，**下边框是可见的**（算出来的边框色不是透明的）—— 看得出是个能点的字段。
  2. **聚焦**时那条线变**绿**（--green-ink）—— 告诉人「你正在这儿输入」。
  3. **另外三边仍然透明** —— 产品刻意做的「标题式」观感不许被顺手改成普通方框输入框。
  4. 主题**仍然是能打字的输入框**（不是静态文字、不是只读、不是 disabled）。

  判据怎么算：把 deepseek.css（基础表单控件外观）→ workbench.css → mail-center.css 三份样式
  按**层叠顺序**叠起来（选择器匹配 + 优先级 + 出现次序），
  算出 `#c-subject` 这个 input 的**最终边框色**。改 CSS 的人换任何写法都逃不掉这条判据。
*/

const CSS_FILES = [
  ['deepseek', readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8')],
  ['workbench', readFileSync(new URL('../../../shangshu-web/css/workbench.css', import.meta.url), 'utf8')],
  ['mail', readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8')],
] as const;

/* 主题变量（deepseek.css 定义，后面可覆盖） */
const vars: Record<string, string> = {};
for (const [, css] of CSS_FILES) {
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) vars[m[1]] = m[2].trim();
}

type RGBA = {r: number; g: number; b: number; a: number};

function parseColor(raw: string, depth = 0): RGBA | null {
  if (!raw || depth > 8) return null;
  const v = raw.trim();
  if (v.toLowerCase() === 'transparent') return {r: 0, g: 0, b: 0, a: 0};
  const vm = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*))?\)$/i.exec(v);
  if (vm) {
    const val = vars[vm[1]] ?? vm[2];
    return val ? parseColor(val, depth + 1) : null;
  }
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (hex3) return {r: parseInt(hex3[1] + hex3[1], 16), g: parseInt(hex3[2] + hex3[2], 16), b: parseInt(hex3[3] + hex3[3], 16), a: 1};
  const hex6 = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex6) return {r: parseInt(hex6[1].slice(0, 2), 16), g: parseInt(hex6[1].slice(2, 4), 16), b: parseInt(hex6[1].slice(4, 6), 16), a: 1};
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (rgb) return {r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4]};
  return null;
}

/* 边框简写（`1px solid var(--line2)`）里的颜色要单独挑出来 —— 简写里还混着宽度和线型。 */
function colorOfShorthand(value: string): RGBA | null {
  const direct = parseColor(value);
  if (direct) return direct;
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)$/i.test(token)) continue;
    if (/^[\d.]+(px|em|rem|%)?$/i.test(token)) continue;
    const c = parseColor(token);
    if (c) return c;
  }
  return null;
}

/* ── 规则抽取（跳过注释与 at-rule 块）── */
type Rule = {sel: string; decls: Record<string, string>; order: number};

function rulesOf(css: string, offset: number): Rule[] {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, '');
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let order = offset;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    const decls: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    out.push({sel, decls, order: order++});
  }
  return out;
}

const allRules: Rule[] = [];
let order = 0;
for (const [, css] of CSS_FILES) allRules.push(...rulesOf(css, order++ * 100000));

/* ── 目标元素：写信窗顶部的主题输入框 ──
   活站实测的祖先链（2026-10-20）：
     input#c-subject → label.mail-compose-subject → div.mail-compose-head
     → div.mail-reading-pane.is-composing → div.mail-body
     → div.main-scroll.mail-center-page.mail-has-selection → main#main.main.workspace-card
     → div#workspace-shell → div.layout → body
   这个 input **没有 type 属性**（`<input id="c-subject" placeholder="邮件主题" …>`）。 */
type El = {tag: string; id?: string; classes: string[]; attrs: Record<string, string>};

const SUBJECT: El = {
  tag: 'input',
  id: 'c-subject',
  classes: [],
  attrs: {id: 'c-subject', placeholder: '邮件主题', autocomplete: 'off', 'aria-label': '主题'},
};

const ANCESTORS: El[] = [
  {tag: 'label', classes: ['mail-compose-subject'], attrs: {}},
  {tag: 'div', classes: ['mail-compose-head'], attrs: {}},
  {tag: 'div', classes: ['mail-reading-pane', 'is-composing'], attrs: {}},
  {tag: 'div', classes: ['mail-body'], attrs: {}},
  {tag: 'div', classes: ['main-scroll', 'mail-center-page', 'mail-has-selection'], attrs: {}},
  {tag: 'main', id: 'main', classes: ['main', 'workspace-card'], attrs: {}},
  {tag: 'div', id: 'workspace-shell', classes: ['workspace-shell'], attrs: {}},
  {tag: 'div', classes: ['layout'], attrs: {}},
  {tag: 'body', classes: [], attrs: {}},
];

/* 一段复合选择器（只处理本判据用得到的写法：类型/类/ID/属性/:not()/:focus/:hover） */
type Compound = {tag?: string; id?: string; classes: string[]; attrs: [string, string?][]; negAttrs: string[]; pseudo: string[]};

function parseCompound(raw: string): Compound {
  const out: Compound = {classes: [], attrs: [], negAttrs: [], pseudo: []};
  /* :not([x]) 里的 [x] 是**否定**条件，不能再当成肯定属性收进来
     （否则 `.main input:not([type])` 会被当成「必须有 type 属性」，规则就再也匹配不上了）。 */
  const negs = [...raw.matchAll(/:not\(\[([A-Za-z0-9_-]+)\]\)/g)];
  for (const m of negs) out.negAttrs.push(m[1]);
  const rest = raw.replace(/:not\(\[[A-Za-z0-9_-]+\]\)/g, ' ').trim();
  const typeMatch = /^([a-z0-9]+|\*)/i.exec(rest);
  if (typeMatch && typeMatch[1] !== '*') out.tag = typeMatch[1].toLowerCase();
  for (const m of rest.matchAll(/#([A-Za-z0-9_-]+)/g)) out.id = m[1];
  for (const m of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.classes.push(m[1]);
  for (const m of rest.matchAll(/\[([A-Za-z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
    if (m[2] === undefined) out.attrs.push([m[1]]);
    else out.attrs.push([m[1], m[2]]);
  }
  for (const m of rest.matchAll(/:(focus|hover|active|focus-visible|focus-within)\b/g)) out.pseudo.push(m[1]);
  return out;
}

function compoundMatches(c: Compound, el: El, state: 'normal' | 'focus'): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  for (const [name, value] of c.attrs) {
    const actual = el.attrs[name];
    if (actual === undefined) return false;
    if (value !== undefined && actual !== value) return false;
  }
  for (const name of c.negAttrs) if (el.attrs[name] !== undefined) return false;
  for (const p of c.pseudo) {
    if (p === 'focus' || p === 'focus-visible' || p === 'focus-within') {
      if (state !== 'focus') return false;
    } else if (p === 'hover' || p === 'active') {
      if (state !== 'focus') return false;   /* 常态层叠里不带悬停态 */
    }
  }
  return true;
}

function specificity(parts: Compound[]): number {
  let a = 0, b = 0, c = 0;
  for (const part of parts) {
    if (part.id) a++;
    b += part.classes.length + part.attrs.length + part.negAttrs.length;
    if (part.tag) c++;
  }
  return a * 10000 + b * 100 + c;
}

/* 一条完整选择器适不适用于目标（按后代组合子拆） */
function selectorApplies(sel: string, state: 'normal' | 'focus'): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  /* 关系组合子（> + ~）本判据用不到，出现了就判不适配（宁可漏算也不误算）。 */
  if (/[>+~]/.test(sel)) return false;
  /* 伪元素（::before / ::placeholder …）说的是**另一个盒子**，不是这个元素本身。 */
  if (sel.includes('::')) return false;
  const compounds = parts.map(parseCompound);
  const subject = compounds[compounds.length - 1];
  if (!compoundMatches(subject, SUBJECT, state)) return false;
  /* 祖先：从最近的一个往上找，每个祖先段都得能落到某个真实祖先上 */
  /* 祖先段按「由近及远」配对：ANCESTORS[0] 是最近的祖先。
     （祖先组合子必须从右往左匹配，写反了会把不相关的规则也算进来。） */
  let idx = 0;
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false;
    while (idx < ANCESTORS.length) {
      if (compoundMatches(compounds[i], ANCESTORS[idx], state)) {found = true; idx++; break;}
      idx++;
    }
    if (!found) return false;
  }
  return true;
}

/* 最终边框色（四边分别算）：把命中的规则按优先级+次序叠起来 */
function finalBorders(state: 'normal' | 'focus'): {top: RGBA | null; right: RGBA | null; bottom: RGBA | null; left: RGBA | null} {
  const sides: Array<'top' | 'right' | 'bottom' | 'left'> = ['top', 'right', 'bottom', 'left'];
  const out: Record<string, RGBA | null> = {top: null, right: null, bottom: null, left: null};

  const matched = allRules
    .map(rule => {
      /* 选择器列表：只要有一段匹配就整条适用（按 CSS 规范，各段独立算优先级；这里取匹配段里最高的） */
      let best: {parts: Compound[]; spec: number} | null = null;
      for (const one of rule.sel.split(',')) {
        const trimmed = one.trim();
        if (!trimmed) continue;
        if (!selectorApplies(trimmed, state)) continue;
        const parts = trimmed.split(/\s+/).filter(Boolean).map(parseCompound);
        const spec = specificity(parts);
        if (!best || spec > best.spec) best = {parts, spec};
      }
      return best ? {rule, spec: best.spec} : null;
    })
    .filter((x): x is {rule: Rule; spec: number} => x !== null)
    .sort((a, b) => (a.spec - b.spec) || (a.rule.order - b.rule.order));

  for (const {rule} of matched) {
    const d = rule.decls;
    /* border 简写：四边一起设 */
    if (d['border']) {
      const color = colorOfShorthand(d['border']);
      for (const s of sides) out[s] = color;
    }
    /* border-<side> 简写 */
    for (const s of sides) {
      const v = d[`border-${s}`];
      if (v) out[s] = parseColor(v);
    }
    /* border-color：四边一起设 */
    if (d['border-color']) {
      const color = parseColor(d['border-color']);
      for (const s of sides) out[s] = color;
    }
    /* border-<side>-color */
    for (const s of sides) {
      const v = d[`border-${s}-color`];
      if (v) out[s] = parseColor(v);
    }
  }
  return out as any;
}

const visible = (c: RGBA | null): boolean => !!c && c.a > 0;

it('FIX-25 主题输入框没聚焦时也看得出能点：测试通过 = 下边框不是透明的', () => {
  const b = finalBorders('normal');
  assert.ok(
    visible(b.bottom),
    '主题输入框没聚焦时下边框还是透明的 —— 算出来是「'
    + (b.bottom ? `rgba(${b.bottom.r},${b.bottom.g},${b.bottom.b},${b.bottom.a})` : 'none')
    + '」，跟一段静态大标题一模一样，用户不知道那儿能点',
  );
});

it('FIX-25 聚焦时那条线变绿：测试通过 = 聚焦态下边框是 --green-ink', () => {
  const b = finalBorders('focus');
  const green = parseColor(vars['--green-ink'] || '#0A6E4C');
  assert.ok(green, '读不到 --green-ink');
  assert.ok(b.bottom, '聚焦态没有下边框颜色');
  const same = Math.abs(b.bottom.r - green.r) < 2 && Math.abs(b.bottom.g - green.g) < 2 && Math.abs(b.bottom.b - green.b) < 2;
  assert.ok(same,
    `聚焦时那条线是 rgb(${Math.round(b.bottom.r)},${Math.round(b.bottom.g)},${Math.round(b.bottom.b)})，`
    + `不是 --green-ink rgb(${green.r},${green.g},${green.b}) —— 聚焦反馈不认`,
  );
});

it('FIX-25 保留标题式观感：测试通过 = 另外三边仍然透明（没被改成普通方框输入框）', () => {
  const b = finalBorders('normal');
  for (const side of ['top', 'right', 'left'] as const) {
    assert.ok(!visible(b[side]),
      `${side} 边框不透明了 —— 产品刻意把主题做成「标题式」的一行，`
      + '不许顺手改成普通方框输入框（那是另一种改法，本批不做）');
  }
});

it('FIX-25 主题仍然是能打字的输入框：测试通过 = 是 input、不是只读、不是静态文字', () => {
  const src = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');
  const m = /<input id="c-subject"[^>]*>/.exec(src);
  assert.ok(m, '写信窗模板里找不到主题输入框');
  const tag = m![0];
  assert.doesNotMatch(tag, /readonly/i, '主题输入框被设成只读了 —— 用户没法自己写主题');
  assert.doesNotMatch(tag, /disabled/i, '主题输入框被禁用了');
  assert.match(tag, /placeholder="[^"]+"/, '主题输入框没有占位文字 —— 空着的时候更看不出能点');
  assert.match(tag, /aria-label="[^"]+"/, '主题输入框没有无障碍名');
});
