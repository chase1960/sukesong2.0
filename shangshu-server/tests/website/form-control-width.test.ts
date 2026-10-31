import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  FIX-50 —— 全站「表单控件宽度不按内容收敛」收敛。

  这条是修复计划里**一直挂着没销的已知缺口**（第十二批只收掉了写信窗的「发件身份」下拉）。
  子 agent 的**只读全站盘点**（`/tmp/ux7-report.md`）量出 **22 处**「控件渲染宽度 ≫ 内容需要宽度」
  （判定线：多出 ≥ 40px），落在 12 个落点上，根因归 **4 族**。

  ⚠️ **别拿 FIX-31 的判据去套**：盘点确认 **`justify-self:stretch`（网格项默认拉伸）那一族
  全站已经没有了** —— `justify-self` 在整个 CSS 里只剩 2 处（FIX-31 修复本身 ＋ Excel 返回按钮）。
  剩下这 4 族是**新根因**：
    ① 外层撑大 ＋ 内层 `width:100%`/`flex:1`（11 处）
    ② 网格列宽写死（6 处）
    ③ `width:100%` ＋ 固定上限（2 处）
    ④ 完全没给 `width`，落浏览器默认 20 字符（3 处）

  **测试通过 = 下面全部成立**（每一处都给出「内容需要多宽」与「上限是多少」）：
   1. 文件中心「搜索文件名或标签」：上限 ≤ 240px（活站量：渲染 374px / 内容 104px）
   2. 文件中心「目录」下拉：上限 ≤ 120px（活站量：渲染 280px / 内容 92px）
   3. 邮件中心「搜索主题、联系人或正文」：上限 ≤ 200px（活站量：渲染 290px / 内容 143px）
   4. 邮箱设置那一列：网格列宽 ≤ 220px（活站量：每格 280px / 内容最宽 160px）
   5. 全部应用「搜索应用」：上限 ≤ 200px（活站量：渲染 320px / 内容 82px）
   6. 全部数据「查找数据表」：上限 ≤ 130px（活站量：渲染 163px / 内容 78px）
   7. 应用页筛选栏那四个（发票号码/发票方向/状态/来源单号）：上限 ≤ 140px（活站量：渲染 180px / 内容最宽 100px）
   8. 消息「发起会话」的「新群聊」：上限 ≤ 200px（活站量：渲染 358px / 内容 61px）
   9. 订单管理「更多」菜单（回收站/列管理）：下限 ≤ 80px（活站量：按钮 136px / 内容 63px）
  10. 订单管理顶部「搜索全表文本或选项」：宽 ≤ 240px（活站量：渲染 298px / 内容 117px）
  11. **护栏**：写信窗「主题」框仍是 `width:100%`（FIX-25 明确保留的标题式观感，不许被顺手收窄）
  12. **护栏**：平台 KPI 卡的三列网格（`repeat(3,minmax(0,1fr))`）不许动 —— 那是网格决策，不是被拉满
  13. **护栏**：文件中心表格里的文件名按钮（`.file-open`）不许动 —— 列宽按百分比 ＋ ellipsis 是表格决策

  ⚠️ **判据只能钉样式契约**（这一层是 CSS 的事）：**像素宽度由活站实测记账**
  （见《试用反馈统一修复计划-2026-10-19.md》第二十三批证据表），本判据不冒充浏览器排版结果。
  ⚠️ **量不到的不算**：Excel 域那两处（工具条搜索框、行列操作弹窗的输入框）由域内那一批处理。

  —— 2026-10-20 20:5x **补测（admin 页）** ——
  盘点那轮**用员工账号进不去 admin 页**（`roles:["admin"]`）⇒ 那几页当时**没量**。
  这次拿到 Administrator 账号补量，量到 **10 处**真的被拉满：
    · 账号管理「新建账号」：邮箱/登录用户名/姓名/初始密码 4 个输入 ＋ 任务管理范围/部门 2 个下拉
      —— 全部渲染 **650px**，而内容只要 **48～209px**；
    · 系统设置：OCR 地址/模型 渲染 **566px**、OCR base_url **566px**、API Key **1146px**
      —— 内容只要 **87～342px**。
  根因是**两条通用规则**（不是某一页写歪了）：
    ① `.fgrid` 写 `grid-template-columns:1fr 1fr` ⇒ 两列各占满半幅（650px）；
    ② `.fld input, .fld select, .fld textarea` 写 `width:100%` ⇒ 控件填满那一格。
  ⇒ **网格列宽与控件宽度都要封上限**（只封上限，不改生长项）。
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

/* 真实层叠顺序 = index.html 里的 link 顺序（与 FIX-31 那条判据同一条 order_hint）。 */
const ORDER_HINT = ['workbench.css', 'app-extra.css', 'kanban-module.css', 'chat-module.css', 'sidebar.css',
  'mobile.css', 'flows-module.css', 'file-center.css', 'mail-center.css', 'file-reference-picker.css',
  'sheet-center.css', 'deepseek.css', 'platform.css', 'controls.css'];

const allRules: Rule[] = [];
{
  let order = 0;
  const sorted = [...CSS_FILES].sort((a, b) => {
    const ia = ORDER_HINT.indexOf(a[0]), ib = ORDER_HINT.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  for (const [name, css] of sorted) allRules.push(...rulesOf(name, css, order++ * 100000));
}

/**
 * 数 `grid-template-columns` 的轨道数。
 * ⚠️ `repeat(2,minmax(0,280px))` 是**一个 repeat 里写了两列** ——
 * 直接数括号或空格都会数错（repeat 一个、minmax 里的逗号也不算轨道）。
 */
function trackCount(value: string): number {
  const rep = /^\s*repeat\(\s*(\d+)\s*,/i.exec(value);
  if (rep) return Number(rep[1]);
  let depth = 0, count = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) { if (cur.trim()) { count++; cur = ''; } continue; }
    cur += ch;
  }
  if (cur.trim()) count++;
  return count;
}

/** 命中该选择器片段的规则里，某属性的最终值（按层叠顺序，后面的赢）。 */
function effective(selPart: string, prop: string): {value: string; from: string} | null {
  let hit: {value: string; from: string} | null = null;
  for (const rule of allRules) {
    if (!rule.sel.includes(selPart)) continue;
    const v = rule.decls[prop];
    if (v !== undefined) hit = {value: v, from: `${rule.file} → ${rule.sel}`};
  }
  return hit;
}

/**
 * 命中「选择器列表里**正好**有这一条」的规则里某属性的最终值。
 *
 * ⚠️ 为什么不能只用 `effective`（按 `includes` 找）：本文件里已有前车之鉴 ——
 * 同一类控件有多条规则时，「谁更靠后」不等于「谁在管」。
 * 补测 admin 页时又遇到同一类：**通用规则** `.fld input, .fld select, .fld textarea`
 * 与**长值字段规则** `.fld input[data-k="base_url"]` —— 后者的选择器**包含**前者那个片段，
 * `effective('.fld input','max-width')` 会被它顶掉（返回长值字段的 380px，而不是通用的 280px）。
 * ⇒ 查「通用那条」必须按**选择器完全相等**来查，否则量到的是别的控件的宽度。
 */
function effectiveExact(selText: string, prop: string): {value: string; from: string} | null {
  let hit: {value: string; from: string} | null = null;
  for (const rule of allRules) {
    const parts = rule.sel.split(',').map((s) => s.trim());
    if (!parts.includes(selText)) continue;
    const v = rule.decls[prop];
    if (v !== undefined) hit = {value: v, from: `${rule.file} → ${rule.sel}`};
  }
  return hit;
}

const pxOf = (value: string): number | null => {
  const m = /(\d+(?:\.\d+)?)px/.exec(value);
  return m ? Number(m[1]) : null;
};

/** 断言「这个控件有内容宽的上限」。 */
function assertCapped(selPart: string, limit: number, what: string) {
  const max = effective(selPart, 'max-width');
  assert.ok(max, `${what}：没有 max-width —— 它会被外层拉满（活站量：渲染宽度远大于内容需要宽度）`);
  const px = pxOf(max.value);
  assert.ok(px !== null, `${what}：max-width 的写法算不出上限（${max.value}，来自 ${max.from}）`);
  assert.ok(px <= limit,
    `${what}：max-width 是 ${max.value}（${max.from}）—— 上限 ${px}px 太大，内容只要 ${limit}px 以内就够`);
}

/**
 * 同上，但按**选择器完全相等**查 —— 用来查「通用那条」，
 * 免得被更具体的长值字段规则（选择器里**包含**通用那个片段）顶掉。
 */
function assertCappedExact(selText: string, limit: number, what: string) {
  const max = effectiveExact(selText, 'max-width');
  assert.ok(max, `${what}：没有 max-width —— 它会被外层拉满（活站量：渲染宽度远大于内容需要宽度）`);
  const px = pxOf(max.value);
  assert.ok(px !== null, `${what}：max-width 的写法算不出上限（${max.value}，来自 ${max.from}）`);
  assert.ok(px <= limit,
    `${what}：max-width 是 ${max.value}（${max.from}）—— 上限 ${px}px 太大，内容只要 ${limit}px 以内就够`);
}

it('FIX-50 文件中心：搜索框与目录下拉都按内容宽收敛', () => {
  assertCapped('.file-center-page .file-search', 240, '文件中心「搜索文件名或标签」');
  // ⚠️ **同一条控件还有一条更靠后、特异性也更高的规则**（`.file-filter-row>.file-search`，
  // 三 个类）⇒ 只改前面那条**不生效**。两条都要收成 240px。
  assertCapped('.file-filter-row>.file-search', 240, '文件中心「搜索文件名或标签」（筛选栏那条）');
  assertCapped('.file-directory-tools select', 120, '文件中心「目录」下拉');
});

it('FIX-50 订单管理：「更多」菜单里的按钮不再被拉成一样宽', () => {
  // 菜单宽度按内容（`width:max-content`）已经对了，但**网格项默认 stretch**
  // ⇒ 「回收站」「列管理」被拉成和最宽那条（「导出筛选结果」）一样宽。
  const j = effective('.sheet-settings-menu', 'justify-items');
  assert.ok(j, '「更多」菜单的 justify-items 规则不见了');
  assert.equal(j.value, 'start',
    `「更多」菜单的 justify-items 是 ${j.value}（${j.from}）—— 网格项默认 stretch，`
    + '里面的短按钮会被拉成和最宽那条一样宽');
});

it('FIX-50 邮件中心：搜索框与邮箱设置的字段宽度都按内容收敛', () => {
  assertCapped('.mail-search', 200, '邮件中心「搜索主题、联系人或正文」');
  const cols = effective('#mail-account-form', 'grid-template-columns');
  assert.ok(cols, '邮箱设置那一列的网格规则不见了');
  const px = [...cols.value.matchAll(/(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert.ok(px.length > 0, `网格列宽算不出像素（${cols.value}，来自 ${cols.from}）`);
  const widest = Math.max(...px);
  assert.ok(widest <= 220,
    `邮箱设置的网格列宽是 ${cols.value}（${cols.from}）—— 每格 ${widest}px，而字段内容最宽 160px`);
});

it('FIX-50 全部应用 / 全部数据：搜索框都按内容宽收敛', () => {
  assertCapped('.application-search', 200, '全部应用「搜索应用」');
  assertCapped('.dataset-search', 130, '全部数据「查找数据表」');
  const w = effective('.dataset-search', 'width');
  assert.ok(w && !/%/.test(w.value),
    `「查找数据表」的 width 仍是 ${w?.value}（${w?.from}）—— 百分比/calc 宽度会跟着容器长`);
});

it('FIX-50 应用页筛选栏：四个筛选控件都按内容宽收敛', () => {
  assertCapped('.dataset-filters label', 140, '应用页筛选栏（发票号码/发票方向/状态/来源单号）');
});

it('FIX-50 消息「发起会话」：新群聊输入框按内容宽收敛', () => {
  assertCapped('.im-input-field', 200, '消息「发起会话」的「新群聊」输入框');
});

it('FIX-50 订单管理：「更多」菜单与顶部搜索框按内容收敛', () => {
  const min = effective('.sheet-settings-menu', 'min-width');
  assert.ok(min, '订单管理「更多」菜单的 min-width 规则不见了');
  // min-width:0 / auto / max-content ＝「没有下限」（按内容宽），也算合规。
  const noFloor = /^(0|auto|max-content)$/i.test(min.value);
  const px = noFloor ? 0 : pxOf(min.value);
  assert.ok(px !== null, `min-width 算不出像素（${min.value}，来自 ${min.from}）`);
  assert.ok(px <= 80,
    `「更多」菜单的 min-width 是 ${min.value}（${min.from}）—— 里面的按钮内容只要 63px`);  // 订单管理顶部那个搜索框是 <label class="sheet-search">（**标签本身**有宽度规则，
  // 里面的 input 是 width:100%）⇒ 只认「选择器以 .sheet-search 结尾」的那条规则。
  const labelRules = allRules.filter(r => r.sel.split(',').some(s => s.trim().endsWith('.sheet-search')));
  let w: {value: string; from: string} | null = null;
  for (const r of labelRules) {
    const v = r.decls['width'];
    if (v !== undefined) w = {value: v, from: `${r.file} → ${r.sel}`};
  }
  assert.ok(w, '订单管理顶部搜索框的宽度规则不见了');
  const wpx = pxOf(w.value);
  assert.ok(wpx !== null, `宽度算不出像素（${w.value}，来自 ${w.from}）`);
  assert.ok(wpx <= 240,
    `订单管理顶部搜索框宽 ${w.value}（${w.from}）—— 内容只要 117px`);
});

it('FIX-50 护栏：文件中心搜索框保留 flex-grow:1（能生长、空间紧时先收缩）', () => {
  // ⚠️ 收窄它的时候**只许加 max-width 上限**，不许把 `flex-grow` 也去掉 ——
  // 去掉之后搜索框不再生长，工具条多出来的空间会把「列表/缩略图/分组」那组按钮挤散
  // （既有判据 `employee-layout.test.ts`「文件搜索先收缩，布局按钮组不可拆」就钉着这一条）。
  const flex = effective('.file-center-page .file-search', 'flex');
  assert.ok(flex, '找不到文件中心搜索框的 flex 规则');
  const grow = /^(\d+(?:\.\d+)?)/.exec(flex.value);
  assert.ok(grow, `flex 的写法算不出生长项（${flex.value}，来自 ${flex.from}）`);
  assert.equal(grow[1], '1',
    `文件中心搜索框的 flex-grow 变成 ${grow[1]}（${flex.from}）—— 它要能生长，`
    + '空间紧时先收缩；只该用 max-width 封上限，不该改生长项');
});

it('FIX-50 护栏：写信窗「主题」框仍是满宽（FIX-25 明确保留的标题式观感）', () => {
  const w = effective('.mail-compose-subject input', 'width');
  assert.ok(w, '找不到写信窗主题框的宽度规则');
  assert.equal(w.value, '100%',
    `写信窗主题框的 width 变成 ${w.value}（${w.from}）—— 那是 FIX-25 明确保留的标题式观感，不许被收窄`);
});

it('FIX-50 护栏：平台 KPI 卡的三列网格不许动（那是网格决策，不是被拉满）', () => {
  const g = effective('.platform-kpis', 'grid-template-columns');
  assert.ok(g, '找不到平台 KPI 卡的网格规则');
  assert.match(g.value, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    `平台 KPI 卡的网格变成 ${g.value}（${g.from}）—— 那是三列等分的布局决策，不是被拉满`);
});

it('FIX-50 护栏：文件中心表格里的文件名按钮不许动（列宽按百分比 ＋ ellipsis 是表格决策）', () => {
  const rule = allRules.find((r) => r.sel.includes('.file-open'));
  assert.ok(rule, '找不到文件中心文件名按钮的样式规则');
});

/* ══════════════════════════════════════════════════════════════════════
   2026-10-20 20:5x 补测：平台 admin 页（roles:["admin"]）—— 上一条判据的头注里
   写着「admin 页试用账号进不去，不在本判据范围内」。这次拿到 Administrator 账号，
   补量到 **10 处**真的被拉满 ⇒ 范围扩到这里，并把上一条头注的「不在范围内」改掉。

   **测试通过 = 下面全部成立**：
   1. 通用表单网格 `.fgrid` 的**列宽有上限**（不再是 `1fr 1fr` 各占满半幅 650px）
   2. 通用表单字段（input / select / textarea）**都有内容宽上限**（≤ 280px）
   3. **长值字段（地址、密钥）按内容留宽**：上限 ≤ 400px，**且 ≥ 340px**
      （内容要 342px —— 上限比内容还窄就等于把地址截断了，那不叫「按内容收敛」）
   4. 护栏：控件仍保留 `width:100%`（**只封上限，不改生长项**）
   5. 护栏：`.fgrid` 仍是**两列**（不许顺手塌成一列）
   ══════════════════════════════════════════════════════════════════════ */

it('FIX-50 补测 admin 页：通用表单网格的列宽不再各占满半幅', () => {
  const cols = effectiveExact('.fgrid', 'grid-template-columns');
  assert.ok(cols, '找不到通用表单网格 .fgrid 的规则');
  assert.ok(!/1fr/.test(cols.value),
    `通用表单网格的列宽是 ${cols.value}（${cols.from}）—— 1fr 会让两列各占满半幅`
    + '（活站量：每格 650px，而字段内容最宽 209px）');
  const px = [...cols.value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(px.length > 0, `网格列宽算不出像素（${cols.value}，来自 ${cols.from}）`);
  assert.ok(Math.max(...px) <= 280,
    `通用表单网格的列宽是 ${cols.value}（${cols.from}）—— 每格最多 ${Math.max(...px)}px，`
    + '而字段内容最宽 209px（活站量：原本每格 650px）');
});

it('FIX-50 补测 admin 页：通用表单控件（输入/下拉/多行）都有内容宽上限', () => {
  // ⚠️ 这里**必须**用精确匹配：通用规则的选择器是 `.fld input, .fld select, .fld textarea`，
  // 而长值字段那条 `.fld input[data-k="base_url"]` 的选择器**包含** `.fld input` 这个片段
  // ⇒ 用「片段匹配」会拿到长值字段的 380px，量到的不是通用那条。
  assertCappedExact('.fld input', 280, '平台通用表单输入框（账号管理/系统设置）');
  assertCappedExact('.fld select', 280, '平台通用表单下拉（部门/任务管理范围）');
  assertCappedExact('.fld textarea', 280, '平台通用表单多行输入');
});

it('FIX-50 补测 admin 页：长值字段（地址/密钥）按内容留宽，但仍有上限', () => {
  // 系统设置的 base_url / API Key 是长值：活站量内容要 342px。
  // ⇒ 上限既不能大到没收敛，也不能小到把地址截断（那不叫「按内容收敛」）。
  const wide = effectiveExact('.fld input[data-k="base_url"]', 'max-width');
  assert.ok(wide, '长地址字段（base_url）没有单独的上限规则');
  const px = pxOf(wide.value);
  assert.ok(px !== null, `长地址字段的 max-width 算不出像素（${wide.value}，来自 ${wide.from}）`);
  assert.ok(px <= 400, `长地址字段的上限是 ${wide.value}（${wide.from}）—— 收敛过头反而把地址截断了`);
  assert.ok(px >= 340, `长地址字段的上限是 ${wide.value}（${wide.from}）—— 比内容需要的 342px 还窄`);
});

it('FIX-50 补测 admin 页 护栏：控件仍保留 width:100%（只封上限，不改生长项）', () => {
  const w = effectiveExact('.fld input', 'width');
  assert.ok(w, '找不到通用表单输入框的宽度规则');
  assert.equal(w.value, '100%',
    `通用表单输入框的 width 变成 ${w.value}（${w.from}）—— 那是「填满所在格」的口径，`
    + '收敛只该用 max-width 封上限，不该改这一条');
});

it('FIX-50 补测 admin 页 护栏：通用表单网格仍是两列（不许塌成一列）', () => {
  const cols = effectiveExact('.fgrid', 'grid-template-columns');
  assert.ok(cols, '找不到通用表单网格 .fgrid 的规则');
  assert.equal(trackCount(cols.value), 2,
    `通用表单网格的列宽是 ${cols.value}（${cols.from}）—— 轨道数不是 2，`
    + '账号管理那六个字段是左右两排，塌成一列就变了样');
});

