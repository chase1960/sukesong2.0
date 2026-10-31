import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  全站**次要文字**要看得清（FIX-33）—— 2026-10-20 全站对比度扫描实况：

  扫描了试用站七个页面（邮件 / 文件中心 / 全部数据 / Excel 表格 / 工作台 / 消息 / 待办），
  把每个**看得见**的文字都按 WCAG 公式算了一遍对比度，一共 **102 处不达标**。归因下来，
  **约 90 处是同一个根因**：次要文字色令牌 `--fg3` = `rgba(0,0,0,.45)`。

    · 压在白底上（`--bg` / `--card`）⇒ **3.35:1**
    · 压在浅灰底上（`--bg-alt` ＝ 白色上的 4% 黑 ⇒ rgb(245,245,245)）⇒ **3.31:1**
    · 压在侧栏底上（`--canvas` ＝ #E8EAEB）⇒ **3.25:1**

  这些不是装饰字，是**表头**（「文件名」「标签」「来源」「更新时间」「权限」）、
  **计数**（「0 个文件」「16 张表格」「共 4 条」）、**页码**（「1 / 1」「第 1 / 1 页」）、
  **空态提示**、**筛选器说明** —— 用户要靠它们判断「现在看到的是哪一批、哪些能点」。

  修法：把**令牌**从 `rgba(0,0,0,.45)` 提到 `rgba(0,0,0,.55)`，一次改完全站所有落点。
  合成后实测：白底 **4.76:1**、浅灰底 **4.66:1**、侧栏底 **4.54:1** —— 三种底色全过 4.5:1。

  为什么改令牌而不是逐个页面改：`--fg3` 是**全站主题层**的一个变量，
  表头/计数/页码这些落点分布在六七个样式表里，逐个改就是七份重复写法，
  改漏一处就留一处看不清。改一处 = 收成一条公共规则。

  层级不许塌：次要文字要比正文淡一档。`--fg2`（`rgba(0,0,0,.65)`）合成后是 rgb(89,89,89)，
  `--fg3` 提到 `.55` 合成后是 rgb(115,115,115) —— 仍然淡一档，层级关系没变。

  关于 4.5:1 这条线：WCAG 1.4.3 对**普通正文**要求 4.5:1。这里把它当**产品可读性**的线用
  —— 沿用 FIX-22 / FIX-32 已经定下的口径。

  测试通过 = 下面全部成立：
  1. `--fg3` 压在**三种真实底色**上（白 / 浅灰 / 侧栏灰）对比度都 **≥ 4.5:1**
  2. **层级护栏**：`--fg3` 仍然比 `--fg2` 淡（次要文字不许跟正文一样重）
  3. **护栏**：`--fg`（正文色）与 `--green` / `--green2` / `--green-ink` 一个字节没动
  4. **护栏**：`--fg3` 的**非文字用途**（描边 / 圆点 / 箭头填充）继续能用（不能把变量改成不可解析的值）
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

/* `--bg-alt` ＝ rgba(0,0,0,.04) 压在白底上 ⇒ rgb(245,245,245) */
const WHITE = {r: 255, g: 255, b: 255};
const BG_ALT = over({r: 0, g: 0, b: 0, a: 0.04}, WHITE);

function bgOf(varName: string): {r: number; g: number; b: number} {
  const c = parseColor(vars[varName] || '');
  assert.ok(c, `解析不了底色变量 ${varName} = ${vars[varName]}`);
  return {r: c.r, g: c.g, b: c.b};
}

it('次要文字色在三种真实底色上都过 4.5:1：测试通过 = 白底/浅灰底/侧栏底都看得清', () => {
  const fg = parseColor(vars['--fg3'] || '');
  assert.ok(fg, `解析不了 --fg3 = ${vars['--fg3']}`);

  const cases: [string, {r: number; g: number; b: number}][] = [
    ['白底 --bg / --card', bgOf('--bg')],
    ['浅灰底 --bg-alt（白色上的 4% 黑）', BG_ALT],
    ['侧栏底 --canvas', bgOf('--canvas')],
  ];
  for (const [name, bg] of cases) {
    const effective = over(fg, bg);
    const ratio = contrast(effective, bg);
    assert.ok(ratio >= 4.5,
      `次要文字色 --fg3（${vars['--fg3']}）压在${name}上只有 ${ratio.toFixed(2)}:1 —— `
      + `表头、计数、页码、空态提示都用它，用户要靠它判断「看到的是哪一批、哪些能点」`);
  }
});

it('层级护栏：次要文字仍比正文淡一档，不许跟正文一样重', () => {
  const fg2 = parseColor(vars['--fg2'] || '');
  const fg3 = parseColor(vars['--fg3'] || '');
  assert.ok(fg2 && fg3, '解析不了 --fg2 / --fg3');
  /* 合成到白底上比「深浅」：合成得越深 = 越重 */
  const w2 = over(fg2, WHITE).r;
  const w3 = over(fg3, WHITE).r;
  assert.ok(w3 > w2,
    `--fg3 合成后 rgb(${Math.round(w3)}) 不比 --fg2 合成后 rgb(${Math.round(w2)}) 淡 —— `
    + `层级塌了，次要文字会跟正文一样重`);
  /* 也不能淡到跟正文断档太多（不然又回到看不清） */
  assert.ok(w2 - w3 <= 60,
    `--fg2 与 --fg3 合成后差了 ${Math.round(w2 - w3)} —— 次要文字与正文断档过大，弱到不像同一套层级`);
});

it('护栏：正文色与品牌绿一个字节没动', () => {
  assert.equal(vars['--fg'], '#1e232c', `--fg（正文色）被改成了 ${vars['--fg']}`);
  assert.equal(vars['--green'], '#10B981', `--green 被改成了 ${vars['--green']}`);
  assert.equal(vars['--green2'], '#0EA372', `--green2 被改成了 ${vars['--green2']}`);
  assert.equal(vars['--green-ink'], '#0A6E4C', `--green-ink 被改成了 ${vars['--green-ink']}`);
});

it('护栏：--fg3 的非文字用途（描边/圆点/箭头填充）继续能用', () => {
  /* 这些用法：file-center.css 的 outline/stroke、workbench.css 的 border-color、
     chat-module.css 的圆点底色、platform.css 的箭头填充 */
  const users: [string, string][] = [
    ['file-center.css', 'outline:1px solid var(--fg3)'],
    ['file-center.css', 'stroke:var(--fg3)'],
    ['workbench.css', 'border-color:var(--fg3)'],
    ['chat-module.css', 'background:var(--fg3)'],
  ];
  for (const [file, needle] of users) {
    const css = CSS_FILES.find(([name]) => name === file)?.[1] ?? '';
    assert.ok(css.includes(needle), `${file} 里找不到 ${needle} —— 本批不许动 --fg3 的非文字用途`);
  }
  /* 且 --fg3 必须仍然是一个**可解析的颜色**（不能改成什么都不是） */
  assert.ok(parseColor(vars['--fg3'] || ''), `--fg3 = ${vars['--fg3']} 解析不出来`);
});
