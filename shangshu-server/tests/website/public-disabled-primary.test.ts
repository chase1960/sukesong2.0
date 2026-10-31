import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  公共壳里**禁用的主按钮**要看得清（FIX-27 / FIX-28）—— 2026-10-20 UX 走查实况：

  主按钮是**白字压绿底**。通用禁用写法把**整个元素**降透明度
  （`.os-dialog .btn:disabled{opacity:.45}` / `.file-center-page button:disabled{opacity:.48}` /
  `.file-detail-dialog .btn:disabled,.file-operation-dialog .btn:disabled{opacity:.45}`），
  透明度把**白字也一起洗淡**了 ⇒ 活站实测（2026-10-20，按 CSS 合成规则算最终像素）：
    · 公共弹窗里禁用的主按钮（实测「确认添加」置禁用）：**1.21:1**
      （底色 rgb(147,224,198)、字色 rgb(196,238,224)）—— 两个字几乎看不见
    · 文件中心「确认所选」（待审核视图、未选时就是禁用）：**1.25:1**
      （底色 rgb(140,221,195)、字色 rgb(195,238,224)）
  对照组：邮件页自己的「发送」已按 FIX-22 改成淡绿底 + 深绿字 ⇒ **5.40:1**。

  这三处是**同一个根因的三个地方**，所以修法要落在**公共壳**上（一条公共规则），
  而不是每个页面各写一份。

  关于 4.5:1 这条线：WCAG 1.4.3 对**禁用/失效控件**的对比度是**豁免**的。
  这里把它当**产品可读性**的线用 —— 沿用 FIX-22 已经定下的观感：
  一个禁用态主按钮如果看着像「渲染坏了」，用户会当成故障，而不是「现在不能按」。

  测试通过 = 下面全部成立：
  1. **公共弹窗**里禁用的主按钮：文字对比度 **≥ 4.5:1**（WCAG AA 正文）—— 现在 1.5:1
  2. **文件中心页面**里禁用的主按钮：文字对比度 **≥ 4.5:1** —— 现在 1.55:1
  3. **文件操作弹窗**里禁用的主按钮：文字对比度 **≥ 4.5:1**
  4. **公共壳里有且只有一条公共的「禁用的主按钮」规则**（写在公共样式表里，不是各页面各一份）
  5. **只改主按钮**：普通按钮（ghost 等）的禁用观感不许变
     —— 那几条一刀切的 `opacity` 规则必须**排除 `.btn-pri`**
  6. **启用态的主按钮一个字节没动**（白字配品牌绿 2.54:1 属品牌色层面，是已知缺口，本批不碰）

  判据怎么算：把公共样式表按**层叠顺序**叠起来（选择器匹配 ＋ 优先级 ＋ 出现次序），
  算出按钮的**最终**背景色、文字色、元素透明度，再按 CSS 的合成规则
  （元素透明度同时作用在底与字上）算出**最终像素颜色**，再按 WCAG 公式算对比度。
  改 CSS 的人换任何写法都逃不掉这条判据。
*/

const CSS_DIR = new URL('../../../shangshu-web/css/', import.meta.url);
const CSS_FILES = readdirSync(CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => [name, readFileSync(new URL(name, CSS_DIR), 'utf8')] as const);

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
  const mix = /^color-mix\(\s*in\s*srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i.exec(v);
  if (mix) {
    const c1 = parseColor(mix[1], depth + 1);
    const c2 = parseColor(mix[3], depth + 1);
    if (!c1 || !c2) return null;
    const p = +mix[2] / 100;
    return {r: c1.r * p + c2.r * (1 - p), g: c1.g * p + c2.g * (1 - p), b: c1.b * p + c2.b * (1 - p), a: c1.a * p + c2.a * (1 - p)};
  }
  return null;
}

type Rule = {file: string; sel: string; decls: Record<string, string>; order: number};

function rulesOf(file: string, css: string, offset: number): Rule[] {
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
    out.push({file, sel, decls, order: order++});
  }
  return out;
}

const allRules: Rule[] = [];
{
  let order = 0;
  /* index.html 里的加载顺序：workbench 最先、deepseek 靠后、controls 最后 */
  const order_hint = ['workbench.css', 'app-extra.css', 'kanban-module.css', 'chat-module.css', 'sidebar.css',
    'mobile.css', 'flows-module.css', 'file-center.css', 'mail-center.css', 'file-reference-picker.css',
    'sheet-center.css', 'deepseek.css', 'platform.css', 'controls.css'];
  const sorted = [...CSS_FILES].sort((a, b) => {
    const ia = order_hint.indexOf(a[0]), ib = order_hint.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  for (const [name, css] of sorted) allRules.push(...rulesOf(name, css, order++ * 100000));
}

type El = {tag: string; id?: string; classes: string[]; attrs: Record<string, string>; disabled?: boolean};
type Compound = {tag?: string; id?: string; classes: string[]; attrs: [string, string?][]; negAttrs: string[]; negClasses: string[]; pseudo: string[]; states: string[]};

function parseCompound(raw: string): Compound {
  const out: Compound = {classes: [], attrs: [], negAttrs: [], negClasses: [], pseudo: [], states: []};
  const negs = [...raw.matchAll(/:not\(([^)]*)\)/g)];
  for (const m of negs) {
    const inner = m[1].trim();
    if (inner.startsWith('.')) out.negClasses.push(inner.slice(1));
    else if (inner.startsWith('[')) out.negAttrs.push(inner.replace(/^\[|\].*$/g, ''));
  }
  const rest = raw.replace(/:not\([^)]*\)/g, ' ').trim();
  const typeMatch = /^([a-z0-9]+|\*)/i.exec(rest);
  if (typeMatch && typeMatch[1] !== '*') out.tag = typeMatch[1].toLowerCase();
  for (const m of rest.matchAll(/#([A-Za-z0-9_-]+)/g)) out.id = m[1];
  for (const m of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.classes.push(m[1]);
  for (const m of rest.matchAll(/\[([A-Za-z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
    if (m[2] === undefined) out.attrs.push([m[1]]);
    else out.attrs.push([m[1], m[2]]);
  }
  for (const m of rest.matchAll(/:(focus|hover|active|focus-visible|focus-within)\b/g)) out.pseudo.push(m[1]);
  /* :disabled / :enabled 是**状态**，层叠时必须按元素当前状态取舍 */
  for (const m of rest.matchAll(/:(disabled|enabled)\b/g)) out.states.push(m[1]);
  return out;
}

function compoundMatches(c: Compound, el: El, disabled: boolean): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  for (const st of c.states) {
    if (st === 'disabled' && !el.disabled) return false;
    if (st === 'enabled' && el.disabled) return false;
  }
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  for (const [name, value] of c.attrs) {
    const actual = el.attrs[name];
    if (actual === undefined) return false;
    if (value !== undefined && actual !== value) return false;
  }
  for (const name of c.negAttrs) if (el.attrs[name] !== undefined) return false;
  for (const cls of c.negClasses) if (el.classes.includes(cls)) return false;
  for (const p of c.pseudo) {
    if (p === 'focus' || p === 'focus-visible' || p === 'focus-within') {
      if (!disabled) return false;   /* 常态层叠不带聚焦态 */
    } else if (p === 'hover' || p === 'active') {
      return false;                  /* 常态层叠不带悬停态 */
    }
  }
  return true;
}

function specificity(parts: Compound[]): number {
  let a = 0, b = 0, c = 0;
  for (const part of parts) {
    if (part.id) a++;
    b += part.classes.length + part.attrs.length + part.negAttrs.length + part.negClasses.length;
    if (part.tag) c++;
  }
  return a * 10000 + b * 100 + c;
}

function selectorApplies(sel: string, subject: El, chain: El[], disabled: boolean): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (/[>+~]/.test(sel)) return false;
  if (sel.includes('::')) return false;
  const compounds = parts.map(parseCompound);
  if (!compoundMatches(compounds[compounds.length - 1], subject, disabled)) return false;
  let idx = 0;
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false;
    while (idx < chain.length) {
      if (compoundMatches(compounds[i], chain[idx], disabled)) {found = true; idx++; break;}
      idx++;
    }
    if (!found) return false;
  }
  return true;
}

type Style = {background: RGBA | null; color: RGBA | null; opacity: number; from: string[]};

function effective(subject: El, chain: El[], disabled: boolean): Style {
  const out: Style = {background: null, color: null, opacity: 1, from: []};
  const matched = allRules
    .map(rule => {
      let best = -1;
      for (const one of rule.sel.split(',')) {
        const trimmed = one.trim();
        if (!trimmed || !selectorApplies(trimmed, subject, chain, disabled)) continue;
        const spec = specificity(trimmed.split(/\s+/).filter(Boolean).map(parseCompound));
        if (spec > best) best = spec;
      }
      return best < 0 ? null : {rule, spec: best};
    })
    .filter((x): x is {rule: Rule; spec: number} => x !== null)
    .sort((a, b) => (a.spec - b.spec) || (a.rule.order - b.rule.order));

  for (const {rule} of matched) {
    const d = rule.decls;
    if (d['background']) { out.background = parseColor(d['background']); out.from.push(rule.file + ' → ' + rule.sel); }
    if (d['background-color']) { out.background = parseColor(d['background-color']); out.from.push(rule.file + ' → ' + rule.sel); }
    if (d['color']) { out.color = parseColor(d['color']); out.from.push(rule.file + ' → ' + rule.sel); }
    if (d['opacity'] !== undefined) { out.opacity = Number(d['opacity']); out.from.push(rule.file + ' → ' + rule.sel); }
  }
  return out;
}

const over = (fg: RGBA, bg: RGBA): RGBA => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
const luminance = (c: RGBA): number => {
  const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a: RGBA, b: RGBA): number => {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/* ── 三个目标：同一个主按钮，三个落点 ──
   活站实测的祖先链（2026-10-20）：
   A 公共弹窗：button.btn.btn-pri → footer → dialog.os-dialog → body
   B 文件操作弹窗：button.btn.btn-pri → footer → dialog.file-operation-dialog → body
   C 文件中心页面：button.btn.btn-pri → div#review-footer.cr-footer → section.file-table-area
     → div.file-content → div.main-scroll.file-center-page → main#main.main.workspace-card
     → div#workspace-shell → div.layout → body */
const BUTTON: El = {tag: 'button', classes: ['btn', 'btn-pri'], attrs: {type: 'button'}, disabled: true};
const BUTTON_ENABLED: El = {tag: 'button', classes: ['btn', 'btn-pri'], attrs: {type: 'button'}, disabled: false};

const CHAINS = {
  公共弹窗: [
    {tag: 'footer', classes: [], attrs: {}},
    {tag: 'dialog', classes: ['os-dialog'], attrs: {}},
    {tag: 'body', classes: [], attrs: {}},
  ],
  文件操作弹窗: [
    {tag: 'footer', classes: [], attrs: {}},
    {tag: 'dialog', classes: ['file-operation-dialog'], attrs: {}},
    {tag: 'body', classes: [], attrs: {}},
  ],
  文件中心页面: [
    {tag: 'div', id: 'review-footer', classes: ['cr-footer'], attrs: {id: 'review-footer'}},
    {tag: 'section', classes: ['file-table-area'], attrs: {}},
    {tag: 'div', classes: ['file-content'], attrs: {}},
    {tag: 'div', classes: ['main-scroll', 'file-center-page'], attrs: {}},
    {tag: 'main', id: 'main', classes: ['main', 'workspace-card'], attrs: {id: 'main'}},
    {tag: 'div', id: 'workspace-shell', classes: ['workspace-shell'], attrs: {id: 'workspace-shell'}},
    {tag: 'div', classes: ['layout'], attrs: {}},
    {tag: 'body', classes: [], attrs: {}},
  ],
};

/* 公共弹窗与文件中心页面的底色都是白（--bg / --card = #fff） */
const PAGE_BG: RGBA = {r: 255, g: 255, b: 255, a: 1};

function disabledLook(where: keyof typeof CHAINS) {
  const style = effective(BUTTON, CHAINS[where], true);
  const own = style.background || {r: 0, g: 0, b: 0, a: 0};
  const bg = over({...own, a: own.a * style.opacity}, PAGE_BG);
  const text = style.color || {r: 0, g: 0, b: 0, a: 1};
  const fg = over({...text, a: text.a * style.opacity}, bg);
  return {ratio: contrast(fg, bg), bg, fg, style};
}

function enabledLook(where: keyof typeof CHAINS) {
  const style = effective(BUTTON_ENABLED, CHAINS[where], false);
  const own = style.background || {r: 0, g: 0, b: 0, a: 0};
  const bg = over(own, PAGE_BG);
  const text = style.color || {r: 0, g: 0, b: 0, a: 1};
  const fg = over(text, bg);
  return {ratio: contrast(fg, bg), bg, fg, style};
}

const describe = (where: keyof typeof CHAINS) => {
  const look = disabledLook(where);
  return `底色 rgb(${Math.round(look.bg.r)},${Math.round(look.bg.g)},${Math.round(look.bg.b)})、`
    + `文字 rgb(${Math.round(look.fg.r)},${Math.round(look.fg.g)},${Math.round(look.fg.b)})、`
    + `元素透明度 ${look.style.opacity}`;
};

it('FIX-27 公共弹窗里禁用的主按钮要看得清：测试通过 = 文字对比度 ≥ 4.5:1', () => {
  const look = disabledLook('公共弹窗');
  assert.ok(look.ratio >= 4.5,
    `公共弹窗里禁用的主按钮文字对比度只有 ${look.ratio.toFixed(2)}:1 —— ${describe('公共弹窗')}`
    + '（白字被整体降透明度洗淡了）');
});

it('FIX-28 文件中心里禁用的主按钮要看得清：测试通过 = 文字对比度 ≥ 4.5:1', () => {
  const look = disabledLook('文件中心页面');
  assert.ok(look.ratio >= 4.5,
    `文件中心里禁用的主按钮（「确认所选」）文字对比度只有 ${look.ratio.toFixed(2)}:1 —— ${describe('文件中心页面')}`);
});

it('FIX-28 文件操作弹窗里禁用的主按钮要看得清：测试通过 = 文字对比度 ≥ 4.5:1', () => {
  const look = disabledLook('文件操作弹窗');
  assert.ok(look.ratio >= 4.5,
    `文件操作弹窗里禁用的主按钮文字对比度只有 ${look.ratio.toFixed(2)}:1 —— ${describe('文件操作弹窗')}`);
});

it('公共壳里有一条公共的「禁用的主按钮」规则：测试通过 = 公共样式表里写着，且三个落点都吃它', () => {
  const publicRules = allRules.filter((r) =>
    r.file === 'workbench.css'
    && /:disabled/.test(r.sel)
    && /btn-pri/.test(r.sel)
    && (r.decls['background'] || r.decls['background-color'] || r.decls['color']));
  assert.ok(publicRules.length >= 1,
    '公共样式表（workbench.css）里没有针对「禁用的主按钮」的规则 —— '
    + '三个落点只能各写一份，或继续吃一刀切的降透明度');
  for (const where of ['公共弹窗', '文件操作弹窗', '文件中心页面'] as const) {
    const look = disabledLook(where);
    assert.ok(look.ratio >= 4.5, `${where} 没吃到公共规则（对比度 ${look.ratio.toFixed(2)}:1）`);
  }
});

it('只改主按钮：普通按钮的禁用观感不许变 —— 一刀切的降透明度必须排除 .btn-pri', () => {
  /* 凡是「给禁用态按钮降透明度」的规则，只要它会命中主按钮，就必须显式排除 .btn-pri。 */
  const offenders: string[] = [];
  for (const rule of allRules) {
    if (!/:disabled/.test(rule.sel) || rule.decls['opacity'] === undefined) continue;
    if (rule.sel.includes(':not(.btn-pri)')) continue;
    /* 命中哪个主按钮落点？命中就必须排除 */
    for (const where of ['公共弹窗', '文件操作弹窗', '文件中心页面'] as const) {
      for (const one of rule.sel.split(',')) {
        const trimmed = one.trim();
        if (!trimmed) continue;
        if (selectorApplies(trimmed, BUTTON, CHAINS[where], true)) {
          offenders.push(`${rule.file} → ${trimmed}（会命中${where}的主按钮）`);
          break;
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    '这些规则把**主按钮**也一起降透明度了（白字被洗淡）：\n  ' + offenders.join('\n  ')
    + '\n  ⇒ 规则必须用 :not(.btn-pri) 把主按钮排除掉');
});

it('启用态的主按钮一个字节没动：测试通过 = 底色仍是品牌绿、文字仍是白字', () => {
  for (const where of ['公共弹窗', '文件操作弹窗', '文件中心页面'] as const) {
    const look = enabledLook(where);
    const green = parseColor(vars['--green'] || '#10B981')!;
    const same = Math.abs(look.bg.r - green.r) < 2 && Math.abs(look.bg.g - green.g) < 2 && Math.abs(look.bg.b - green.b) < 2;
    assert.ok(same,
      `${where} 启用态主按钮底色是 rgb(${Math.round(look.bg.r)},${Math.round(look.bg.g)},${Math.round(look.bg.b)})，`
      + `不是 --green rgb(${green.r},${green.g},${green.b}) —— 启用态不许被这次改动碰到`);
    assert.equal(Math.round(look.fg.r), 255, `${where} 启用态主按钮文字不是白字了`);
    assert.equal(look.style.opacity, 1, `${where} 启用态主按钮的透明度被改了`);
  }
});
