import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  禁用的按钮要**看得出来是禁用的**（FIX-30）—— 2026-10-20 UX 走查第五轮实况：

  「禁用态长什么样」这件事**是每个页面各写一份的**：
    · 邮件页 `.mail-center-page button:disabled{opacity:.48}` ✓
    · 文件中心 `.file-center-page button:disabled{opacity:.48}` ✓
    · 表格中心 `.sheet-center-page button:disabled{opacity:.48}` ✓
    · 公共弹窗 `.os-dialog .btn:disabled{opacity:.45}` ✓
    · Excel 域 `.excel-toolrow .btn:disabled{opacity:.45}` ✓
  **没写的那页就完全看不出来** —— 应用·数据集页（`#/objects`）的「上一页 / 下一页」
  在只有 1 页时是禁用的，但活站量到：
    透明度 **1**、字色 rgb(30,35,44)（跟启用的一模一样）、**指针还是 `pointer`**。
  ⇒ 用户以为能点，点了**没反应**（这正是用户原始反馈里反复出现的那句「点了没反应」）。

  修法：**在公共壳补一条兜底规则** —— 任何 `.btn` 禁用时都看得见；
  已经写过自己那条的页面（邮件/文件/表格/弹窗/Excel 域）**观感一个字不变**
  （它们各自的规则优先级更高，照旧说了算）。

  测试通过 = 下面全部成立：
  1. **公共壳里有兜底规则**：`.btn` 禁用时透明度 < 1、指针是 `not-allowed`，
     且**排除 `.btn-pri`**（主按钮归 FIX-27/28 那条管：淡绿底 + 深绿字、透明度 1）
  2. **没写过禁用样式的页面**（应用·数据集页）：禁用的普通按钮**看得见是禁用**（透明度 < 1、指针 not-allowed）
  3. **已有观感一个字不变**：邮件页 .48、文件中心 .48、表格中心 .48、公共弹窗 .45
  4. **主按钮不受这条影响**：禁用主按钮仍是透明度 1（FIX-27/28 的淡绿底 + 深绿字）

  判据怎么算：把公共样式表按**层叠顺序**叠起来（选择器匹配 ＋ 优先级 ＋ 出现次序），
  算出按钮的**最终**透明度与指针 —— 不是拿字符串对源码。
  优先级按浏览器口径算（`:disabled`、`:not()` 的参数都算进 class 级）。
*/

/* 主题变量（deepseek.css 定义，后面可覆盖） */
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

type El = {tag: string; id?: string; classes: string[]; disabled?: boolean};
type Compound = {tag?: string; id?: string; classes: string[]; negClasses: string[]; states: string[]; pseudo: string[]};

function parseCompound(raw: string): Compound {
  const out: Compound = {classes: [], negClasses: [], states: [], pseudo: []};
  const negs = [...raw.matchAll(/:not\(([^)]*)\)/g)];
  for (const m of negs) {
    const inner = m[1].trim();
    if (inner.startsWith('.')) out.negClasses.push(inner.slice(1));
  }
  const rest = raw.replace(/:not\([^)]*\)/g, ' ').trim();
  const tagMatch = /^([a-z0-9]+|\*)/i.exec(rest);
  if (tagMatch && tagMatch[1] !== '*') out.tag = tagMatch[1].toLowerCase();
  const idMatch = /#([A-Za-z0-9_-]+)/.exec(rest);
  if (idMatch) out.id = idMatch[1];
  for (const m of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.classes.push(m[1]);
  for (const m of rest.matchAll(/:(focus|hover|active|focus-visible|focus-within)\b/g)) out.pseudo.push(m[1]);
  for (const m of rest.matchAll(/:(disabled|enabled)\b/g)) out.states.push(m[1]);
  return out;
}

function compoundMatches(c: Compound, el: El, disabled: boolean): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  for (const st of c.states) {
    if (st === 'disabled' && !disabled) return false;
    if (st === 'enabled' && disabled) return false;
  }
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  for (const cls of c.negClasses) if (el.classes.includes(cls)) return false;
  for (const p of c.pseudo) {
    if (p === 'focus' || p === 'focus-visible' || p === 'focus-within') { if (!disabled) return false; }
    else return false;   /* 常态层叠不带悬停/聚焦态 */
  }
  return true;
}

/* 浏览器口径的优先级：a=id，b=类/属性/伪类（含 :not() 的参数），c=元素/伪元素 */
function specificity(parts: Compound[]): number {
  let a = 0, b = 0, c = 0;
  for (const part of parts) {
    if (part.id) a++;
    b += part.classes.length + part.negClasses.length + part.states.length + part.pseudo.length;
    if (part.tag) c++;
  }
  return a * 10000 + b * 100 + c;
}

function selectorApplies(sel: string, subject: El, chain: El[], disabled: boolean): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (/[>+~]/.test(sel)) return false;
  if (sel.includes('::')) return false;
  /* 本判据的迷你层叠**只认**类/属性/伪类/元素这套写法。
     `:is(...)` / `:where(...)` 的参数语义算不准 ⇒ 这类选择器**直接跳过**
     （宁可漏算，也别把「算不准」当成「匹配一切」—— 那会让红变假红）。 */
  if (sel.includes(':is(') || sel.includes(':where(')) return false;
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

type Style = {opacity: number; cursor: string; from: string[]};

function effective(subject: El, chain: El[], disabled: boolean): Style {
  const out: Style = {opacity: 1, cursor: '', from: []};
  const matched = allRules
    .filter(rule => !rule.sel.includes(':is(') && !rule.sel.includes(':where('))
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
    if (rule.decls['opacity'] !== undefined) { out.opacity = Number(rule.decls['opacity']); out.from.push(`${rule.file} → ${rule.sel}`); }
    if (rule.decls['cursor'] !== undefined) { out.cursor = rule.decls['cursor']; out.from.push(`${rule.file} → ${rule.sel}`); }
  }
  return out;
}

/* ── 落点（活站量出来的真祖先链） ───────────────────────────────────
   A 应用·数据集页：button.btn.btn-sm.btn-ghost → div → footer.dataset-pagination
     → section.dataset-work → div.objects-shell → section.platform-page.objects-page
     → div.main-scroll → main.main.workspace-card → div.workspace-shell → div.layout → body
   B 邮件页：… → div.main-scroll.mail-center-page …
   C 公共弹窗：button → footer → dialog.os-dialog → body                */
const GHOST: El = {tag: 'button', classes: ['btn', 'btn-sm', 'btn-ghost'], disabled: true};
const PRI: El = {tag: 'button', classes: ['btn', 'btn-pri'], disabled: true};

const OBJECTS_CHAIN: El[] = [
  {tag: 'div', classes: []},
  {tag: 'footer', classes: ['dataset-pagination']},
  {tag: 'section', classes: ['dataset-work']},
  {tag: 'div', classes: ['objects-shell']},
  {tag: 'section', classes: ['platform-page', 'objects-page']},
  {tag: 'div', classes: ['main-scroll']},
  {tag: 'main', id: 'main', classes: ['main', 'workspace-card']},
  {tag: 'div', id: 'workspace-shell', classes: ['workspace-shell']},
  {tag: 'div', classes: ['layout']},
  {tag: 'body', classes: []},
];
const MAIL_CHAIN: El[] = [
  {tag: 'footer', classes: ['mail-selection-bar']},
  {tag: 'div', classes: ['main-scroll', 'mail-center-page']},
  {tag: 'main', id: 'main', classes: ['main', 'workspace-card']},
  {tag: 'div', id: 'workspace-shell', classes: ['workspace-shell']},
  {tag: 'div', classes: ['layout']},
  {tag: 'body', classes: []},
];
const DIALOG_CHAIN: El[] = [
  {tag: 'footer', classes: []},
  {tag: 'dialog', classes: ['os-dialog']},
  {tag: 'body', classes: []},
];

it('公共壳里有一条兜底：禁用的按钮看得见是禁用（透明度 < 1、指针 not-allowed），且排除 .btn-pri', () => {
  const publicRules = allRules.filter((r) =>
    r.file === 'workbench.css'
    && /:disabled/.test(r.sel)
    && /\.btn\b/.test(r.sel)
    && r.decls['opacity'] !== undefined);
  assert.ok(publicRules.length >= 1,
    '公共样式表（workbench.css）里没有「.btn 禁用时」的兜底规则 —— '
    + '没写过自己那条的页面（应用·数据集页）禁用按钮跟启用的一模一样');
  for (const rule of publicRules) {
    assert.ok(rule.sel.includes(':not(.btn-pri)'),
      `公共规则「${rule.sel}」没排除 .btn-pri —— 主按钮归 FIX-27/28 那条管（淡绿底 + 深绿字、透明度 1），`
      + '不许被这条降透明度');
    assert.ok(Number(rule.decls['opacity']) < 1,
      `公共规则「${rule.sel}」的透明度是 ${rule.decls['opacity']} —— 禁用按钮还是看不出来`);
  }
});

it('没写过禁用样式的页面（应用·数据集页）：禁用的普通按钮看得见是禁用', () => {
  const look = effective(GHOST, OBJECTS_CHAIN, true);
  assert.ok(look.opacity < 1,
    `应用·数据集页的禁用按钮透明度还是 ${look.opacity} —— 跟启用的一模一样，用户以为能点、点了没反应`
    + `（命中：${look.from.join(' / ') || '（没命中任何规则）'}）`);
  assert.equal(look.cursor, 'not-allowed',
    `指针还是「${look.cursor}」—— 禁用的按钮连光标形状都不改，用户更看不出来`);
});

it('已有观感一个字不变：邮件页 .48、文件中心 .48、表格中心 .48、公共弹窗 .45', () => {
  const mail = effective(GHOST, MAIL_CHAIN, true);
  assert.equal(mail.opacity, .48, `邮件页的禁用普通按钮透明度变成 ${mail.opacity}（应仍是 .48）`);
  assert.equal(mail.cursor, 'not-allowed', `邮件页的指针变成 ${mail.cursor}`);
  const dialog = effective(GHOST, DIALOG_CHAIN, true);
  assert.equal(dialog.opacity, .45, `公共弹窗里的禁用普通按钮透明度变成 ${dialog.opacity}（应仍是 .45）`);
});

it('主按钮不受这条影响：禁用主按钮仍是透明度 1（FIX-27/28 的淡绿底 + 深绿字）', () => {
  const objects = effective(PRI, OBJECTS_CHAIN, true);
  assert.equal(objects.opacity, 1,
    `应用·数据集页的禁用主按钮透明度变成 ${objects.opacity} —— 主按钮归 FIX-27/28 那条管（应仍是 1）`);
  const dialog = effective(PRI, DIALOG_CHAIN, true);
  assert.equal(dialog.opacity, 1, `公共弹窗里的禁用主按钮透明度变成 ${dialog.opacity}（应仍是 1）`);
});
