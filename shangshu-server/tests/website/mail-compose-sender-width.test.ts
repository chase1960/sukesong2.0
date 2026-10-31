import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  写信窗的「发件身份」下拉要**按内容宽**，不许被拉成满栏（FIX-31）—— 2026-10-20 UX 走查第五轮实况：

  活站量到：`#c-from`（发件身份）**宽 765px**，里面只有 11 个字
  （「本人草稿（未绑定邮箱）」）—— 右边 700 多像素是空的，读起来像一条空的长框。
  同一栏里：收件人/抄送是**按内容宽**的胶囊区（`.dlg-chips .chip-input{width:auto}`）、
  附件是**按内容宽**的小按钮，**就它一条长框**，三行摆在一起明显不齐。

  根因：写信窗每一栏是 `display:grid; grid-template-columns:68px minmax(0,1fr)`，
  **网格项默认 `justify-self:stretch`** ⇒ 值区的控件被拉满那一栏（765px）。

  修法：`justify-self:start`（按内容宽）＋ `max-width` 封顶（长邮箱地址不顶开布局）。

  测试通过 = 下面全部成立：
  1. **不许再被拉成满栏**：那一栏宽 765px 时，下拉的用宽必须小于 765px
     ⇒ 它的 `justify-self` 必须是 `start`（默认的 `stretch` 就是满栏）
  2. **要有宽度上限**：长邮箱地址不许把布局顶开（`max-width` 得有，且 ≤ 360px）
  3. **护栏 · 收件人/抄送那两行不许被顺手收窄**：胶囊宿主仍是按内容宽
     （`.dlg-chips .chip-input{width:auto}` 还在）—— 胶囊多了要能铺开
  4. **护栏 · 主题框的「标题式」观感不变**：FIX-25 那条下边框规则还在

  ⚠️ 判据只能钉**样式契约**（这层是 CSS 的事）：像素宽度由活站实测记账
  （见《试用反馈统一修复计划-2026-10-19.md》第十一批证据表），本判据不冒充浏览器排版结果。
*/

const CSS_DIR = new URL('../../../shangshu-web/css/', import.meta.url);
const CSS_FILES = readdirSync(CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => [name, readFileSync(new URL(name, CSS_DIR), 'utf8')] as const);

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
  const order_hint = ['workbench.css', 'app-extra.css', 'kanban-module.css', 'chat-module.css', 'sidebar.css',
    'mobile.css', 'flows-module.css', 'file-center.css', 'mail-center.css', 'file-reference-picker.css',
    'sheet-center.css', 'deepseek.css', 'platform.css', 'controls.css'];
  const sorted = [...CSS_FILES].sort((a, b) => {
    const ia = order_hint.indexOf(a[0]), ib = order_hint.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  for (const [name, css] of sorted) allRules.push(...rulesOf(name, css, order++ * 100000));
}

/* 目标选择器：命中这些记号的规则才管「发件身份」下拉 */
const cFromRules = allRules.filter((r) => r.sel.includes('#c-from'));

const declOf = (prop: string): {value: string; from: string} | null => {
  let hit: {value: string; from: string} | null = null;
  for (const rule of cFromRules) {
    const v = rule.decls[prop];
    if (v !== undefined) hit = {value: v, from: `${rule.file} → ${rule.sel}`};
  }
  return hit;
};

/* 写信窗那一栏的宽度（活站量：值区 765px） */
const COLUMN_WIDTH = 765;

it('FIX-31 发件身份下拉不许再被拉成满栏：测试通过 = 它的 justify-self 是 start（不是 stretch）', () => {
  const justify = declOf('justify-self');
  assert.ok(justify, '「发件身份」下拉（#c-from）没有任何 justify-self 规则 —— '
    + '网格项默认 stretch ⇒ 它会被拉成满栏（活站量：765px，内容只有 11 个字）');
  assert.equal(justify.value, 'start',
    `「发件身份」下拉的 justify-self 是 ${justify.value} —— 不是 start 就还是满栏（来自：${justify.from}）`);
});

it('FIX-31 长邮箱地址不许把布局顶开：测试通过 = 它有 max-width 且 ≤ 360px', () => {
  const max = declOf('max-width');
  assert.ok(max, '「发件身份」下拉没有 max-width —— 换成很长的邮箱地址会把那一栏顶开');
  const px = /(\d+(?:\.\d+)?)px/.exec(max.value);
  assert.ok(px, `max-width 的写法算不出上限：${max.value}`);
  assert.ok(Number(px[1]) <= 360, `max-width 是 ${max.value} —— 上限太宽，长邮箱地址还是会顶开布局`);
  assert.ok(max.value.includes('%') || max.value.includes('min('),
    `max-width 应当是「不超过那一栏、也不超过上限」的写法（现在：${max.value}）`);
});

it('护栏：收件人/抄送两行的胶囊宿主仍是按内容宽（不许被顺手收窄）', () => {
  const chip = allRules.find((r) => r.sel.includes('.dlg-chips .chip-input'));
  assert.ok(chip, '找不到收件人/抄送胶囊宿主的样式规则');
  assert.equal(chip.decls['width'], 'auto',
    `胶囊宿主的宽度变成 ${chip.decls['width']} —— 胶囊多了要能铺开，不许收窄`);
});

it('护栏：主题框的「标题式」观感不变（FIX-25 那条下边框还在）', () => {
  const subject = allRules.filter((r) => r.sel.includes('.mail-compose-subject'));
  assert.ok(subject.length >= 1, '找不到主题框的样式规则');
  const hasBorder = subject.some((r) => r.decls['border-bottom-color'] !== undefined
    || /border-bottom/.test(r.decls['border'] || ''));
  assert.ok(hasBorder, '主题框的「标题式」下边框规则不见了 —— FIX-25 的成果不许被这次改动碰掉');
});
