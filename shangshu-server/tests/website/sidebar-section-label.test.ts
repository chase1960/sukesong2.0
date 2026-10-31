import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/*
  侧栏的**分组标记**（「工作」「应用」「工具」）要看得清（FIX-32）—— 2026-10-20 UX 走查第六轮实况：

  活站实测：这三个字是 `10px` + `rgba(0,0,0,.38)`，压在侧栏底色 `--side-bg`（= `--canvas` = #E8EAEB）上
  ⇒ 算出来的对比度只有 **2.62:1** —— 是全站**最弱的可见文字**（比 3:1 的底线还低）。
  它是**导航分组标记**，不是装饰：读不出来就分不清「订单管理/费用管理/外采拨款」属于哪一组。

  修法：字号 10px → 11px，颜色提到 `rgba(0,0,0,.58)`（实测 **5.02:1**，过 4.5:1）。
  层级仍由**字号**承担（分组标记 11px、导航项 13px），不会跟导航项抢眼。

  测试通过 = 下面全部成立：
  1. 分组标记的**文字对比度 ≥ 4.5:1**（按真实底色合成后算 WCAG 公式）
  2. **字号 ≥ 11px**（10px 的中文在真实屏幕上已经糊了）
  3. 护栏：**导航项本身的观感不许被这次改动碰到**（`.side-label` 仍是 13px、颜色不变）
*/

const css = readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8');

/* 主题变量 */
const vars: Record<string, string> = {};
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) vars[m[1]] = m[2].trim();

const parseColor = (raw: string, depth = 0): {r: number; g: number; b: number; a: number} | null => {
  if (!raw || depth > 6) return null;
  const v = raw.trim();
  const vm = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*))?\)$/i.exec(v);
  if (vm) {
    const val = vars[vm[1]] ?? vm[2];
    return val ? parseColor(val, depth + 1) : null;
  }
  const hex6 = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex6) return {r: parseInt(hex6[1].slice(0, 2), 16), g: parseInt(hex6[1].slice(2, 4), 16), b: parseInt(hex6[1].slice(4, 6), 16), a: 1};
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (rgb) return {r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4]};
  return null;
};

const over = (fg: {r: number; g: number; b: number; a: number}, bg: {r: number; g: number; b: number}) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
});
const luminance = (c: {r: number; g: number; b: number}) => {
  const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a: {r: number; g: number; b: number}, b: {r: number; g: number; b: number}) => {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/* 规则里取某个选择器的声明（按出现次序，后者覆盖前者） */
function declsOf(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, '')))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel.split(',').some(s => s.trim() === selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

it('侧栏分组标记的文字对比度 ≥ 4.5:1：测试通过 = 按真实底色合成后算得过', () => {
  const rule = declsOf('.side-sec');
  assert.ok(rule['color'], '找不到 .side-sec 的颜色规则');
  const fg = parseColor(rule['color']);
  assert.ok(fg, `解析不了 .side-sec 的颜色：${rule['color']}`);
  const sideBg = parseColor(vars['--side-bg'] || vars['--canvas'] || '#E8EAEB');
  assert.ok(sideBg, '解析不了侧栏底色（--side-bg / --canvas）');
  const effective = over(fg, {r: sideBg.r, g: sideBg.g, b: sideBg.b});
  const ratio = contrast(effective, {r: sideBg.r, g: sideBg.g, b: sideBg.b});
  assert.ok(ratio >= 4.5,
    `侧栏分组标记（${rule['color']} 压在 ${JSON.stringify(vars['--side-bg'] || vars['--canvas'])} 上）`
    + `的对比度只有 ${ratio.toFixed(2)}:1 —— 全站最弱的可见文字，读不出「哪些入口属于哪一组」`);
});

it('侧栏分组标记的字号 ≥ 11px：10px 的中文在真实屏幕上已经糊了', () => {
  const rule = declsOf('.side-sec');
  const size = parseFloat(rule['font-size'] || '0');
  assert.ok(size >= 11, `侧栏分组标记的字号是 ${rule['font-size']} —— 至少 11px`);
});

it('护栏：导航项本身的观感不许被这次改动碰到（.side-label 仍是 13px、颜色不变）', () => {
  const label = declsOf('.side-item .side-label');
  const size = parseFloat(label['font-size'] || '0');
  assert.ok(size === 0 || size >= 13, `导航项的字号变成 ${label['font-size']} —— 本批只动分组标记`);
  assert.ok(!label['color'] || !/rgba\(0,\s*0,\s*0,\s*\.\d+\)/.test(label['color']) || parseFloat((/rgba\(0,\s*0,\s*0,\s*\.(\d+)\)/.exec(label['color']) || [0, '0'])[1]) >= 0.6,
    `导航项的颜色变成 ${label['color']} —— 本批只动分组标记`);
});
