import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/*
  附件入口不该画成「满行虚线的假拖放区」（FIX-26）—— 2026-10-20 UX 走查实况：

  写信窗「附件」那一行里，`[data-attachment-value]` 是**一整行宽的虚线块**
  （活站实测 765×39px，`border:1px dashed var(--line2)` ＋ 白底），
  四个字「选择附件」占满整行，视觉上比正文还重。

  虚线框在 UI 惯例里＝「可以把文件拖进来」。但这个控件**根本没有 drop 处理**：
  组件 file-reference-picker.js 里只有 click / 双击 / Enter 打开**公共弹窗**；
  整个邮件页唯一接文件拖放的是**正文编辑器**（mail-editor.js:1477/1484），
  而且那里**只收图片**，非图片整批拒绝。
  ⇒ 那个虚线框在骗人：看着能拖，拖了没反应。

  测试通过 = 下面全部成立：
  1. 附件入口**不再画成虚线**（不假装是拖放区）。
  2. 它**不再撑满整行**（宽度按内容，不是 width:100%）。
  3. FIX-16 判据 8 那三条**一条不许破**：仍有边框、有底色、指针是 pointer
     —— 不许为了收窄把它变回「一段普通文字」（用户原话「点选择附件没反应」）。
  4. 挂载点底下**不许还留一条满行的灰带**（按钮收窄后，灰带比按钮还宽、更抢眼）。
  5. 若有人把虚线加回来，那它**必须真的接 drop**（组件里要有 drop 处理）—— 画成拖放区就得真能拖。
  6. 写信窗的附件入口**走公共组件**（window.mountFileReferencePicker），不许另造一个本地按钮件/浮层。
*/

const CSS_FILES = [
  ['deepseek', readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8')],
  ['workbench', readFileSync(new URL('../../../shangshu-web/css/workbench.css', import.meta.url), 'utf8')],
  ['mail', readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8')],
  ['picker', readFileSync(new URL('../../../shangshu-web/css/file-reference-picker.css', import.meta.url), 'utf8')],
] as const;

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

const BORDER_STYLES = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];

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

type El = {tag: string; id?: string; classes: string[]; attrs: Record<string, string>};
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

function compoundMatches(c: Compound, el: El): boolean {
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
    if (p === 'hover' || p === 'active') return false;   /* 常态层叠里不带悬停态 */
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

/* ── 目标：写信窗附件区的入口按钮 + 它的挂载点 ──
   活站实测（2026-10-20，1440 宽视口）：
     button[data-attachment-value]  765×39  1px dashed  白底
       └ div#c-attachments.file-reference-picker  765×39  背景 rgba(0,0,0,.04)
          └ div.dlg-field → div.dlg-body → div.mail-reading-pane.is-composing → … */
const BUTTON: El = {
  tag: 'button',
  classes: [],
  attrs: {
    'data-attachment-value': '',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    type: 'button',
    title: '点击选择文件；Enter 打开选择弹窗',
  },
};

const MOUNT: El = {tag: 'div', id: 'c-attachments', classes: ['file-reference-picker'], attrs: {id: 'c-attachments'}};

const ANCESTORS: El[] = [
  {tag: 'div', classes: ['dlg-field'], attrs: {}},
  {tag: 'div', classes: ['dlg-body'], attrs: {}},
  {tag: 'div', classes: ['mail-reading-pane', 'is-composing'], attrs: {}},
  {tag: 'div', classes: ['mail-body'], attrs: {}},
  {tag: 'div', classes: ['main-scroll', 'mail-center-page', 'mail-has-selection'], attrs: {}},
  {tag: 'main', id: 'main', classes: ['main', 'workspace-card'], attrs: {}},
  {tag: 'div', id: 'workspace-shell', classes: ['workspace-shell'], attrs: {}},
  {tag: 'div', classes: ['layout'], attrs: {}},
];

function selectorApplies(sel: string, subject: El, chain: El[]): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (/[>+~]/.test(sel)) return false;
  /* 伪元素（::before / ::placeholder …）说的是**另一个盒子**，不是这个元素本身。 */
  if (sel.includes('::')) return false;
  const compounds = parts.map(parseCompound);
  if (!compoundMatches(compounds[compounds.length - 1], subject)) return false;
  /* 祖先段按「由近及远」配对（chain[0] 是最近的祖先）。 */
  let idx = 0;
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false;
    while (idx < chain.length) {
      if (compoundMatches(compounds[i], chain[idx])) {found = true; idx++; break;}
      idx++;
    }
    if (!found) return false;
  }
  return true;
}

type Style = {
  borderStyle: string | null;
  borderColor: RGBA | null;
  width: string | null;
  background: string | null;
  backgroundColor: RGBA | null;
  cursor: string | null;
  display: string | null;
};

function effective(subject: El, chain: El[]): Style {
  const out: Style = {borderStyle: null, borderColor: null, width: null, background: null, backgroundColor: null, cursor: null, display: null};
  const matched = allRules
    .map(rule => {
      let best = -1;
      for (const one of rule.sel.split(',')) {
        const trimmed = one.trim();
        if (!trimmed || !selectorApplies(trimmed, subject, chain)) continue;
        const spec = specificity(trimmed.split(/\s+/).filter(Boolean).map(parseCompound));
        if (spec > best) best = spec;
      }
      return best < 0 ? null : {rule, spec: best};
    })
    .filter((x): x is {rule: Rule; spec: number} => x !== null)
    .sort((a, b) => (a.spec - b.spec) || (a.rule.order - b.rule.order));

  for (const {rule} of matched) {
    const d = rule.decls;
    const border = d['border'];
    if (border) {
      const style = BORDER_STYLES.find(s => new RegExp(`\\b${s}\\b`).test(border));
      if (style) out.borderStyle = style;
      const color = colorOfShorthand(border);
      if (color) out.borderColor = color;
    }
    if (d['border-style']) out.borderStyle = d['border-style'];
    if (d['border-color']) {
      const color = parseColor(d['border-color']);
      if (color) out.borderColor = color;
    }
    if (d['background']) { out.background = d['background']; out.backgroundColor = parseColor(d['background']); }
    if (d['background-color']) { out.background = d['background-color']; out.backgroundColor = parseColor(d['background-color']); }
    if (d['width']) out.width = d['width'];
    if (d['cursor']) out.cursor = d['cursor'];
    if (d['display']) out.display = d['display'];
  }
  return out;
}

const buttonStyle = () => effective(BUTTON, [MOUNT, ...ANCESTORS]);
const mountStyle = () => effective(MOUNT, ANCESTORS);

it('FIX-26 附件入口不再画成虚线：测试通过 = 边框样式不是 dashed（不假装能拖文件）', () => {
  const s = buttonStyle();
  assert.notEqual(s.borderStyle, 'dashed',
    '附件入口还是虚线框 —— 虚线在 UI 惯例里＝「把文件拖进来」，'
    + '而这个控件根本没有 drop 处理（点了才开公共弹窗），看着能拖其实拖了没反应');
});

it('FIX-26 附件入口不再撑满整行：测试通过 = 宽度按内容，不是 width:100%', () => {
  const s = buttonStyle();
  assert.ok(s.width !== '100%',
    `附件入口还是 width:${s.width} —— 四个字占满 765px 一整行，视觉上比正文还重`);
});

it('FIX-26 收窄了但还得看得出是按钮：测试通过 = 有边框、有底色、指针是 pointer', () => {
  const s = buttonStyle();
  assert.ok(s.borderStyle && s.borderStyle !== 'none',
    `附件入口没有边框（border-style = ${s.borderStyle}）—— 看着像一段普通文字`);
  assert.ok(s.borderColor && s.borderColor.a > 0,
    '附件入口的边框色是透明的 —— 边框画了也看不见');
  assert.ok(s.background && s.background !== 'transparent',
    `附件入口是透明底（background = ${s.background}）—— 看着像一段普通文字`);
  assert.equal(s.cursor, 'pointer',
    '附件入口的鼠标指针不是 pointer —— 看着像一段普通文字');
});

it('FIX-26 挂载点不许还留一条满行灰带：测试通过 = 挂载点背景是透明的', () => {
  const s = mountStyle();
  const bg = s.backgroundColor;
  assert.ok(!bg || bg.a === 0,
    `挂载点还铺着 ${s.background} 的满行灰底 —— 按钮收窄后那条灰带比按钮还宽、更抢眼`);
});

it('FIX-26 画成拖放区就得真能拖：测试通过 = 虚线样式必须配真实的 drop 处理', () => {
  const s = buttonStyle();
  if (s.borderStyle !== 'dashed') return;   /* 不画成拖放区，这一条自动成立 */
  const js = readFileSync(new URL('../../../shangshu-web/js/file-reference-picker.js', import.meta.url), 'utf8');
  assert.match(js, /addEventListener\(\s*['"]drop['"]/,
    '附件入口画成了虚线（拖放区），组件却没有 drop 处理 —— 骗人的 affordance');
});

it('FIX-26 写信窗的附件入口走公共组件：测试通过 = 用 window.mountFileReferencePicker，不另造件', () => {
  const js = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');
  assert.match(js, /mountFileReferencePicker/,
    '写信窗的附件入口没走公共组件 window.mountFileReferencePicker —— 另造件会让两处观感分裂');
  const comp = readFileSync(new URL('../../../shangshu-web/js/file-reference-picker.js', import.meta.url), 'utf8');
  assert.match(comp, /ui\.dialog\(/,
    '公共组件没走公共弹窗 ui.dialog —— 附件选择不许就地展开一大块把正文挤掉');
});
