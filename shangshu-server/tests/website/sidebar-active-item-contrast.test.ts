import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  侧栏**当前项**的绿字要看得清（FIX-34）—— 2026-10-20 全站对比度扫描实况：

  七个页面里，每个都有一处 2.68:1 的文字落在侧栏底色上：
    邮件「邮箱」/ 文件中心「文件中心」/ Excel 表格「Excel 表格」/ 工作台「工作台」/
    消息「消息」/ 待办「待办」 —— 全是 `.side-label`，字号 13px。

  根因：`deepseek.css` 的 `.side-item.on{color:var(--green2)}`。
  `--green2` ＝ #0EA372，压在侧栏底色 `--canvas` ＝ #E8EAEB 上
  ⇒ 实测 **2.68:1** —— 比 3:1 的底线还低。

  这不是装饰：**它就是「我现在在哪个模块」的唯一颜色线索**。
  侧栏当前项的底色是 `transparent`（位置靠那块滑动玻璃指示条指），
  文字颜色是唯一的颜色提示 —— 读不出来就分不清自己在哪一页。

  改法：改用**品牌层早就备好的** `--green-ink`（#0A6E4C）——
  这个变量的定义注释原文就是「绿字（浅底上保证对比）」，
  压在侧栏底上实测 **5.20:1**（原来 2.68:1）。
  仍然是品牌绿，仍然一眼认得出是「当前项」，但读得清了。

  为什么不用「把绿调得更亮」：亮绿在浅灰底上更看不清。
  品牌层为这件事准备好的就是 `--green-ink`，用它是**用公共令牌**而不是新造一个色值。

  测试通过 = 下面全部成立：
  1. 侧栏**当前项**的文字对比度 ≥ 4.5:1（按真实侧栏底色合成后算 WCAG 公式）
  2. 当前项的**图标**跟着一起改（`.side-item.on .ico`）—— 不许只改字不改图标
  3. **护栏**：非当前项（`--fg2`）观感不许被这次改动碰到
  4. **护栏**：品牌绿三个色值（`--green` / `--green2` / `--green-ink`）一个字节没动
  5. **护栏**：侧栏**分组标记**（`.side-sec`，FIX-32 刚修过）不许被这次改动碰到
*/

const CSS_DIR = new URL('../../../shangshu-web/css/', import.meta.url);
const CSS_FILES = readdirSync(CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => [name, readFileSync(new URL(name, CSS_DIR), 'utf8')] as const);

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

const over = (fg: RGBA, bg: {r: number; g: number; b: number}) => ({
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

/* 取某个文件里、某个选择器的声明（按出现次序，后者覆盖前者） */
function declsOf(file: string, selector: string): Record<string, string> {
  const css = CSS_FILES.find(([name]) => name === file)?.[1] ?? '';
  const out: Record<string, string> = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, '')))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel.split(',').some((s) => s.trim() === selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

it('侧栏当前项的文字对比度 ≥ 4.5:1：测试通过 = 分得清「我现在在哪个模块」', () => {
  const rule = declsOf('deepseek.css', '.side-item.on');
  const raw = rule['color'];
  assert.ok(raw, '找不到 .side-item.on 的颜色规则');
  const fg = parseColor(raw);
  assert.ok(fg, `解析不了 .side-item.on 的颜色：${raw}`);
  const sideBg = parseColor(vars['--side-bg'] || vars['--canvas'] || '#E8EAEB');
  assert.ok(sideBg, '解析不了侧栏底色（--side-bg / --canvas）');
  const ratio = contrast(over(fg, sideBg), {r: sideBg.r, g: sideBg.g, b: sideBg.b});
  assert.ok(ratio >= 4.5,
    `侧栏当前项（${raw} 压在 ${vars['--side-bg'] || vars['--canvas']} 上）只有 ${ratio.toFixed(2)}:1 —— `
    + `当前项底色是 transparent，文字颜色是唯一的「我在哪一页」线索，读不出来就分不清自己在哪`);
});

it('当前项的图标跟着一起改：不许只改字不改图标', () => {
  const rule = declsOf('deepseek.css', '.side-item.on .ico');
  const raw = rule['color'];
  assert.ok(raw, '找不到 .side-item.on .ico 的颜色规则');
  const fg = parseColor(raw);
  assert.ok(fg, `解析不了 .side-item.on .ico 的颜色：${raw}`);
  const sideBg = parseColor(vars['--side-bg'] || vars['--canvas'] || '#E8EAEB');
  assert.ok(sideBg, '解析不了侧栏底色');
  const ratio = contrast(over(fg, sideBg), {r: sideBg.r, g: sideBg.g, b: sideBg.b});
  assert.ok(ratio >= 4.5,
    `侧栏当前项的图标（${raw}）只有 ${ratio.toFixed(2)}:1 —— 图标要和文字一起改`);
});

it('护栏：非当前项（--fg2）的观感不许被这次改动碰到', () => {
  const rule = declsOf('deepseek.css', '.side-item .ico');
  const raw = rule['color'];
  assert.ok(!raw || !/var\(--green/.test(raw),
    `非当前项的图标变成了 ${raw} —— 本批只动当前项`);
  const item = declsOf('deepseek.css', '.side-item');
  assert.ok(!item['color'] || !/var\(--green/.test(item['color']),
    `.side-item 本身变成了 ${item['color']} —— 本批只动 .side-item.on`);
});

it('护栏：品牌绿三个色值一个字节没动', () => {
  assert.equal(vars['--green'], '#10B981', `--green 被改成了 ${vars['--green']}`);
  assert.equal(vars['--green2'], '#0EA372', `--green2 被改成了 ${vars['--green2']}`);
  assert.equal(vars['--green-ink'], '#0A6E4C', `--green-ink 被改成了 ${vars['--green-ink']}`);
});

it('护栏：侧栏分组标记（FIX-32 刚修过）不许被这次改动碰到', () => {
  const rule = declsOf('deepseek.css', '.side-sec');
  assert.ok(rule['color'], '找不到 .side-sec 的颜色规则');
  const fg = parseColor(rule['color']);
  assert.ok(fg, `解析不了 .side-sec 的颜色：${rule['color']}`);
  const sideBg = parseColor(vars['--side-bg'] || vars['--canvas'] || '#E8EAEB');
  assert.ok(sideBg, '解析不了侧栏底色');
  const ratio = contrast(over(fg, sideBg), {r: sideBg.r, g: sideBg.g, b: sideBg.b});
  assert.ok(ratio >= 4.5, `侧栏分组标记只有 ${ratio.toFixed(2)}:1 —— FIX-32 刚把它提到 5.04:1，不许被打回去`);
});
