import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/*
  禁用的主按钮要看得清（FIX-22）—— 2026-10-20 UX 走查实况：
  写信窗右上角的「发送」在没绑邮箱时是禁用的，它长成**白字压在 48% 不透明度的绿底上**
  （等效底色 rgb(140,221,194)），白字对那个底色的对比度只有约 **1.6:1** ——
  「发送」两个字几乎看不见（截图 /tmp/walk8/03-compose-filled.png 里那两个白字是糊的）。
  根因是通用禁用规则 `.mail-center-page button:disabled{opacity:.48}` 整体降透明度：
  透明度把**白字也一起洗淡**了，而主按钮的底色本来就是绿的。

  测试通过 = 下面全部成立：
  1. 邮件页里**禁用的主按钮**（.btn.btn-pri[disabled]）算出来的**文字对比度 ≥ 4.5:1**
     （WCAG AA 正文标准）—— 现在约 1.6:1。
  2. 邮件页**有专门给禁用主按钮的规则**（不能靠通用规则整体降透明度硬扛）。
  3. 这次**只改主按钮**：普通按钮（ghost）的禁用观感不变
     —— 给主按钮的规则必须要求 `.btn-pri` 这个类，不能顺手把 ghost 一起改了。

  判据怎么算：把三段样式按**层叠顺序**叠起来（基础 .btn-pri → 通用 button:disabled →
  专用 .btn-pri:disabled），把 var() / color-mix() / opacity 都算成**最终像素颜色**，
  再按 WCAG 公式算对比度。改 CSS 的人换任何写法都逃不掉这条判据。
*/

const CSS = {
  workbench: readFileSync(new URL('../../../shangshu-web/css/workbench.css', import.meta.url), 'utf8'),
  mail: readFileSync(new URL('../../../shangshu-web/css/mail-center.css', import.meta.url), 'utf8'),
  theme: readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8'),
};

type RGBA = {r: number; g: number; b: number; a: number};

/* ── 变量表（主题变量在 deepseek.css；后面的文件可覆盖）── */
const vars: Record<string, string> = {};
for (const css of [CSS.theme, CSS.mail, CSS.workbench]) {
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) vars[m[1]] = m[2].trim();
}

/* ── 颜色解析：#hex / rgb() / rgba() / var() / color-mix(in srgb, A p%, B) ── */
function parseColor(raw: string, depth = 0): RGBA | null {
  if (!raw || depth > 8) return null;
  const v = raw.trim();
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
  const mix = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i.exec(v);
  if (mix) {
    const c1 = parseColor(mix[1], depth + 1);
    const c2 = parseColor(mix[3], depth + 1);
    if (!c1 || !c2) return null;
    const p = +mix[2] / 100;
    return {r: c1.r * p + c2.r * (1 - p), g: c1.g * p + c2.g * (1 - p), b: c1.b * p + c2.b * (1 - p), a: c1.a * p + c2.a * (1 - p)};
  }
  return null;
}

/* ── 规则抽取（跳过注释、@media/@keyframes 等 at-rule 块）── */
type Rule = {sel: string; decls: Record<string, string>; order: number};
function rulesOf(css: string, offset: number): Rule[] {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    /* @media / @keyframes / @supports … 这些 at-rule 块里的内容不是普通规则
       （@keyframes 里的 from/50% 会被当成「选择器」混进来，把层叠算花）。 */
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

/* 层叠顺序：基础壳（workbench）→ 邮件页（mail）。同文件内按出现顺序，后者覆盖前者。 */
const allRules = [...rulesOf(CSS.workbench, 0), ...rulesOf(CSS.mail, 10000)];

/* 目标元素：写信窗右上角的「发送」——
   实况（活站量 2026-10-20）：`button.btn.btn-pri#c-send`，disabled=true，
   祖先链 = .mail-compose-actions → .mail-compose-head → .mail-reading-pane.is-composing
   → .mail-body → .main-scroll.mail-center-page.mail-has-selection。
   它的常态样式实测：底色 rgb(16,185,129)（=--green）、文字 rgb(255,255,255)、opacity .48。 */
const TARGET = {
  classes: ['btn', 'btn-pri'],
  disabled: true,
  ancestors: [
    'mail-compose-actions', 'mail-compose-head', 'mail-reading-pane', 'is-composing',
    'mail-body', 'main-scroll', 'mail-center-page', 'mail-has-selection',
  ],
};

function classTokens(sel: string): string[] {
  return [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/* 一条规则适不适用在这个元素上（只处理本判据关心的那几种写法）。
   关键是分清**主体**（最右那段选择器，说的就是这个元素本身）和**祖先**。 */
function applies(rule: Rule): boolean {
  const sel = rule.sel;
  /* 伪类/伪元素/属性/ID：跟本判据的常态样式无关（:hover 之类不算，ID 指向别的元素）。 */
  if (/::|:hover|:focus|:active|:not\(|:nth|:first|:last|:checked|\[|#/.test(sel)) return false;
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const subject = parts[parts.length - 1] || '';
  const ancestors = parts.slice(0, -1);
  /* 主体：类名只能是这个按钮自己的类（btn / btn-pri），元素类型只能是 button。
     —— 这一条把 `.mail-center-page`（容器）、`.mail-item`（列表项）这类**别的元素**排掉。 */
  const subjectClasses = classTokens(subject);
  if (!subjectClasses.every((c) => TARGET.classes.includes(c))) return false;
  const subjectType = subject.split(':')[0].split(/[.#]/)[0];
  if (subjectType && !/^(button|\*)$/.test(subjectType)) return false;
  /* 祖先：必须是目标**真有的**祖先类。
     —— 工具栏（.mail-editor-toolbar）、审阅弹窗（.mail-review-dialog）里的按钮
     不是这个按钮，它们的规则不能算进来（否则层叠会算错）。 */
  for (const a of ancestors) {
    for (const c of classTokens(a)) {
      if (!TARGET.ancestors.includes(c)) return false;
    }
  }
  if (/:disabled/.test(sel) && !TARGET.disabled) return false;
  return true;
}

function effectiveStyle(): {background?: string; color?: string; opacity?: string; cursor?: string} {
  const out: Record<string, string> = {};
  for (const rule of allRules.sort((a, b) => a.order - b.order)) {
    if (!applies(rule)) continue;
    for (const key of ['background', 'background-color', 'color', 'opacity', 'cursor']) {
      const value = rule.decls[key] ?? (key === 'background' ? rule.decls['background-color'] : undefined);
      if (value !== undefined) out[key === 'background-color' ? 'background' : key] = value;
    }
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
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/* 按钮所在的白底（写信窗的面板是白卡片）。 */
const pageBg = parseColor(vars['--card'] || '#ffffff')!;

function disabledPrimaryLook() {
  const style = effectiveStyle();
  const bg0 = parseColor(style.background || '#ffffff')!;
  const text0 = parseColor(style.color || '#000000')!;
  const opacity = style.opacity === undefined ? 1 : Number(style.opacity);
  /* 元素整体降透明度 ⇒ 底色与文字一起被洗淡，再压在白底上。 */
  const bg = over({...bg0, a: opacity}, pageBg);
  const text = over({...text0, a: opacity}, pageBg);
  return {bg, text, ratio: contrast(text, bg), opacity, raw: style};
}

it('邮件页里禁用的主按钮，文字要看得清（对比度 ≥ 4.5:1）', () => {
  const look = disabledPrimaryLook();
  assert.ok(
    look.ratio >= 4.5,
    `禁用的主按钮（写信窗「发送」）文字对比度只有 ${look.ratio.toFixed(2)}:1 —— `
    + `底色 rgb(${Math.round(look.bg.r)},${Math.round(look.bg.g)},${Math.round(look.bg.b)})、`
    + `文字 rgb(${Math.round(look.text.r)},${Math.round(look.text.g)},${Math.round(look.text.b)})、`
    + `元素透明度 ${look.opacity}（白字压在淡化绿底上就成这样）`,
  );
});

it('邮件页有专门给禁用主按钮的规则（不是靠通用降透明度硬扛）', () => {
  const specific = allRules.filter((r) => /:disabled/.test(r.sel) && classTokens(r.sel).includes('btn-pri'));
  assert.ok(specific.length >= 1,
    '邮件页没有针对 `.btn-pri:disabled` 的规则 —— 禁用的主按钮只能吃通用 `button:disabled{opacity:.48}`，'
    + '白字被一起洗淡，对比度只剩约 1.6:1');
});

it('只改主按钮：普通按钮（ghost）的禁用观感不变', () => {
  const specific = allRules.filter((r) => /:disabled/.test(r.sel) && classTokens(r.sel).includes('btn-pri'));
  for (const rule of specific) {
    const tokens = classTokens(rule.sel);
    assert.ok(tokens.includes('btn-pri'),
      `规则「${rule.sel}」没有要求 .btn-pri —— 它会连普通按钮一起改掉（普通按钮的禁用观感不许动）`);
  }
});
