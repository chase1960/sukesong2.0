import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 三个弹窗的交互改版（FIX-36）—— 2026-10-20 用户上传三张截图后提出：
 * 「这些都设计一下，如果可以用下拉框就用下拉框，要优化一下」。
 *
 * 用户看得见的三个问题：
 *
 * ① **「更多格式」弹窗**
 *    截图实况：填充色 8 个色块 + 「无填充」按钮 + 自选色挤成两行；
 *    「文字对齐」下面 8 个按钮平铺，**「水平」和「垂直」两个标签的位置错乱**
 *    （「垂直」漂到了右边，贴着「默认」按钮）。
 *    改法：填充色改成一个**下拉框**（选项是色块 + 名称），文字对齐改成
 *    **两个下拉框**（水平对齐、垂直对齐各一）—— 八个平铺按钮收成两个下拉框。
 *
 * ② **「单元格关联」弹窗**
 *    截图实况：底部挤了 **5 个按钮**（取消 / 配置关系列 / 保存本行关联 /
 *    清除本行关联 / 解绑整列），用户分不出主次；「目标表」「目标列」两个下拉框
 *    贴在一起，「查找记录」输入框和按钮换行错位；「上一页下一页」是纯文字不像按钮。
 *    改法：**四个动作收成一个「操作」下拉框**，底部只留「取消 / 执行」两个按钮
 *    （与同域「行列操作」弹窗一致）；「查找记录」输入框与按钮排成一行；
 *    翻页做成真正的按钮。
 *
 * ③ **「我的表格视图」弹窗**
 *    截图实况：「冻结前 [0] 行　前 [0] 列」两个裸数字框，没有单位、没说明；
 *    筛选条件区空着，用户不知道要做什么。
 *    改法：冻结行数 / 冻结列数改成**下拉框**（常用档位 0/1/2/3/5/10/20），
 *    配一句单位说明；筛选条件区加一句引导（没有条件时说明「未设置条件＝不过滤」）。
 *
 * 测试通过 = 下面全部成立（对**源码**里弹窗的结构断言 —— 这些弹窗由代码拼装，
 *   DOM 结构本身就是用户看得见的界面）：
 *  1. 「更多格式」：填充色是 `<select>`（不是一排按钮）；水平对齐、垂直对齐
 *     各是一个 `<select>`；**不再有** 8 个平铺的对齐按钮
 *  2. 「单元格关联」：目标表/目标列/目标记录/操作 各是一个 `<select>`；
 *     底部动作**只剩两个**（取消 + 执行）；翻页是 `<button>`
 *  3. 「我的表格视图」：冻结行数、冻结列数各是一个 `<select>`；
 *     筛选条件区有引导文案
 *  4. **护栏**：三个弹窗都还走**公共 `ui.dialog`**（不许另造浮层）
 *  5. **护栏**：业务行为不许变 —— 关联动作的四种取值、填充色取值集合、
 *     冻结数量校验区间都保持原样
 */

const SRC = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, SRC), 'utf8');
const main = read('main.ts');
const relation = read('table-relation-dialog.ts');
const view = read('personal-view-dialog.ts');
/* 域内样式表（判据要钉浮层展开方向、z-index 这些看得见的排版）
   注意：样式表在 `shangshu-web/css/domains/excel-univer/`，不在域目录里。
   本文件在 `shangshu-web/js/domains/excel-univer/tests/` ⇒ 上 4 层到 `shangshu-web/`。 */
const CSS_FILES_CSS = readFileSync(new URL('../../../../css/domains/excel-univer/excel-univer.css', import.meta.url), 'utf8');
/* 域内自绘下拉组件（FIX-38）：浮层位置、关闭逻辑都在这里 */
const DROPDOWN = read('dropdown.ts');

/* 源码里「造一个 <select>」的痕迹：createElement('select') 或直接写 <select */
const countSelects = (source: string) =>
  (source.match(/createElement\('select'\)/g) || []).length
  + (source.match(/<select[\s>]/g) || []).length;

test('「更多格式」：填充色改成一个下拉框', () => {
  const panel = main.slice(main.indexOf('function openMoreStylePanel'), main.indexOf('function applyFontPatch'));
  assert.ok(panel, '找不到 openMoreStylePanel');
  /* FIX-38：实现从原生 <select> 换成**自绘下拉**（原生 select 的浮层方向不可控，
     在 <dialog> 里会向上弹、盖住内容）。判据钉的是**行为**（是个下拉、能选），
     不是「用哪个标签实现」—— 所以这里查「用了下拉组件 ＋ 用了填充色那套档位」。 */
  assert.match(panel, /createDropdown\(/, '填充色没有用下拉菜单');
  assert.match(panel, /FILL_PRESETS/, '填充色下拉框没有用上色值集合');
  assert.match(panel, /无填充/, '「无填充」这个档位不见了');
  /* 不许再把 8 个色块平铺成按钮 */
  assert.doesNotMatch(panel, /excel-style-swatches/, '填充色还在用一排色块按钮');
  assert.doesNotMatch(panel, /excel-style-swatch-none/, '「无填充」还是独立按钮');
});

test('「更多格式」：水平对齐、垂直对齐各是一个下拉框，不再平铺八个按钮', () => {
  const panel = main.slice(main.indexOf('function openMoreStylePanel'), main.indexOf('function applyFontPatch'));
  /* 两个对齐下拉框：用一个共用的 selectRow 助手造，所以按「调用两次 + 助手本身造下拉」来钉 */
  assert.match(panel, /createDropdown\(/, '对齐下拉框不是用下拉菜单造的');
  assert.match(panel, /selectRow\('水平'/, '没有「水平」对齐下拉框');
  assert.match(panel, /selectRow\('垂直'/, '没有「垂直」对齐下拉框');
  assert.match(panel, /aria-label/, '下拉框要带 aria-label（读屏知道这是什么）');
  /* 不许再有 choiceRow 那种一排 radiogroup 按钮 */
  assert.doesNotMatch(panel, /excel-style-choices/, '文字对齐还在用平铺按钮');
  assert.doesNotMatch(panel, /excel-style-choice\b/, '文字对齐还在用平铺按钮');
  /* 标签不许再用会错位的 inline-block */
  assert.doesNotMatch(panel, /excel-style-label/, '「水平」「垂直」标签还在用会错位的写法');
  /* 对齐档位一个不许少 */
  for (const v of ['left', 'center', 'right', 'top', 'bottom', 'none']) {
    assert.ok(panel.includes(`'${v}'`), `对齐档位 ${v} 不见了`);
  }
});

test('「单元格关联」：目标表/目标列/目标记录/操作 各是一个下拉框', () => {
  /* 四个下拉框各有一个 data-* 标记，缺一不可 */
  for (const [attr, what] of [
    ['data-table', '目标表'],
    ['data-column', '目标列'],
    ['data-row', '目标记录'],
    ['data-action', '操作'],
  ] as const) {
    assert.match(relation, new RegExp(`select ${attr}`), `「${what}」不是下拉框`);
    assert.match(relation, new RegExp(`aria-label="${what}"`), `「${what}」下拉框缺 aria-label`);
  }
  /* 四种业务动作一个不许少 */
  for (const v of ['define', 'set', 'remove']) {
    assert.ok(relation.includes(`'${v}'`), `关联动作 ${v} 不见了`);
  }
  assert.match(relation, /clear/, '「清除本行关联」这个动作不见了');
});

test('「单元格关联」：底部动作只剩「取消 / 执行」两个', () => {
  const actions = relation.slice(relation.indexOf('actions:['), relation.indexOf(']});if(!dialog)return;'));
  const labels = [...actions.matchAll(/label:'([^']+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, `底部有 ${labels.length} 个按钮：${labels.join('、')} —— 收成「取消 / 执行」两个`);
  assert.ok(labels.includes('取消'), '少了「取消」');
  assert.ok(labels.includes('执行'), '少了「执行」');
});

test('「单元格关联」：翻页是真按钮，不是纯文字', () => {
  assert.match(relation, /data-prev/, '少了「上一页」');
  assert.match(relation, /data-next/, '少了「下一页」');
  assert.match(relation, /type="button"[^>]*data-prev|data-prev[^>]*type="button"/, '「上一页」不是按钮');
});

test('「我的表格视图」：冻结行数、冻结列数改成下拉框', () => {
  assert.ok(countSelects(view) >= 1, '冻结区没有用下拉框');
  assert.match(view, /data-rows/, '少了冻结行数控件');
  assert.match(view, /data-cols/, '少了冻结列数控件');
  /* 冻结数量仍然要校验 0..1000 的整数 —— 业务规则不许被改版带跑 */
  assert.match(view, /1000/, '冻结数量的校验区间不见了');
});

test('「我的表格视图」：筛选条件区有引导文案', () => {
  assert.match(view, /筛选条件|未设置条件|不过滤/, '筛选条件区没有引导文案');
});

test('护栏：三个弹窗都还走公共 ui.dialog，不许另造浮层', () => {
  assert.match(main, /ui\.dialog\(/, '「更多格式」不走公共 ui.dialog');
  assert.match(relation, /ui\.dialog\(/, '「单元格关联」不走公共 ui.dialog');
  assert.match(view, /ui\.dialog\(/, '「我的表格视图」不走公共 ui.dialog');
  assert.doesNotMatch(main + relation + view, /createElement\('dialog'\)/, '有弹窗自己造了 <dialog> 浮层');
});

test('护栏：填充色的取值集合不许被改版弄丢', () => {
  const match = main.match(/const FILL_PRESETS=\[([^\]]+)\]/);
  assert.ok(match, '找不到 FILL_PRESETS');
  for (const c of ['#FFFFFF', '#FFF3C4', '#FFE08A', '#D9F0D3', '#CFE8FF', '#E3D9FF', '#FFD9DE', '#E5E7EB']) {
    assert.ok(match[1].includes(c), `常用色 ${c} 不见了`);
  }
  assert.match(main, /fill_color=fill\?\?'none'/, '「无填充」用 none 表达这个约定变了');
});

test('护栏：关联弹窗的业务校验不许被改版带跑', () => {
  assert.match(relation, /sourceColumnHasValues/, '「关联列必须是空白列」这条规则不见了');
  assert.match(relation, /canStructure/, '「能不能配表结构」的权限判断不见了');
  assert.match(relation, /expected_structure_version/, '结构版本校验不见了');
  assert.match(relation, /expected_revision/, '修订号校验不见了');
  /* 破坏性动作收进下拉后更易误触 ⇒ 必须有确认（FIX-36 补的护栏） */
  assert.match(relation, /confirm/, '破坏性动作（清除本行关联 / 解绑整列）没有二次确认');
});

/* ——————— FIX-37：工具栏向 Excel 交互逻辑趋同（用户 2026-10-20 定的口径） ———————
   Excel 的做法：高频操作直接放工具栏，低频操作收进一个下拉菜单。
   用户选的是「**中度**：只收拢最冷门的几个」＋「排序与筛选冻结都收进同一个「数据」下拉」。

   改后分组：
     · 编辑    —— 撤回 / 查找替换 平铺；**选择性粘贴 + 填充序列 收进「编辑」下拉**
     · 选区字体 —— 不动（字号 / 字体色 / B / I / U 直接放，与 Excel 一致）
     · 结构    —— 行列 / 适应列宽 平铺；**字段权限 收进「结构」下拉**
     · 格式    —— 不动（数字格式已是下拉；自动换行 / 边框 / 更多格式 直接放）
     · 数据    —— 关联 平铺；**筛选/冻结 + 升序 / 降序 / 原顺序 收进同一个「数据」下拉**

   测试通过 = 下面全部成立：
     1. 三个下拉菜单都在（编辑 / 结构 / 数据），每个下拉里能看到收进去的入口
     2. **排序与筛选冻结在同一个「数据」下拉里**（用户明确要求）
     3. 高频入口**不许被收进去**：撤回 / 查找替换 / 行列 / 适应列宽 / 关联 /
        自动换行 / 边框 / 更多格式 / 数字格式 / 字体组 都还在工具栏上直接可见
     4. **护栏**：分组标签不许少（编辑 / 选区字体 / 结构 / 格式 / 数据）、
        每个下拉都有名字（用户知道那是干什么的）
     5. **护栏**：收进去的入口一个都不许少（不许在改版里丢功能）
     6. **护栏**：下拉菜单**点外面要关掉**、按 Esc 要关掉（不然会挡住界面）
*/

test('FIX-37 工具栏：三个下拉菜单都在（编辑 / 结构 / 数据）', () => {
  for (const menu of ['edit', 'structure', 'data']) {
    assert.match(main, new RegExp(`data-${menu}-menu`), `工具栏缺少「${menu}」下拉菜单`);
    assert.match(main, new RegExp(`data-${menu}-toggle`), `工具栏缺少「${menu}」下拉菜单的开关按钮`);
  }
});

test('FIX-37 工具栏：排序与筛选冻结收进同一个「数据」下拉', () => {
  const dataMenu = main.slice(main.indexOf('data-data-menu'), main.indexOf('data-data-menu') + 1200);
  assert.ok(dataMenu, '找不到「数据」下拉菜单');
  assert.match(dataMenu, /data-personal-view/, '「筛选 / 冻结」不在「数据」下拉里');
  assert.match(dataMenu, /data-sort-asc/, '「升序」不在「数据」下拉里');
  assert.match(dataMenu, /data-sort-desc/, '「降序」不在「数据」下拉里');
  assert.match(dataMenu, /data-sort-reset/, '「原顺序」不在「数据」下拉里');
});

test('FIX-37 工具栏：冷门入口各自收进对应下拉', () => {
  const editMenu = main.slice(main.indexOf('data-edit-menu'), main.indexOf('data-edit-menu') + 800);
  assert.match(editMenu, /data-paste-special/, '「选择性粘贴」不在「编辑」下拉里');
  assert.match(editMenu, /data-fill-series/, '「填充序列」不在「编辑」下拉里');
  const structureMenu = main.slice(main.indexOf('data-structure-menu'), main.indexOf('data-structure-menu') + 800);
  assert.match(structureMenu, /data-field-permissions/, '「字段权限」不在「结构」下拉里');
});

test('FIX-37 工具栏：高频入口不许被收进去', () => {
  const toolbar = main.slice(main.indexOf('<div class="excel-toolrow"'), main.indexOf('</header>'));
  for (const [attr, what] of [
    ['data-undo', '撤回'],
    ['data-find-replace', '查找替换'],
    ['data-structure', '行列'],
    ['data-auto-fit', '适应列宽'],
    ['data-relation', '关联'],
    ['data-wrap-text', '自动换行'],
    ['data-border-open', '边框'],
    ['data-style-more', '更多格式'],
    ['data-number-format', '数字格式'],
  ] as const) {
    assert.match(toolbar, new RegExp(attr), `「${what}」不见了`);
  }
  /* 字体组还是直接放在工具栏上（Excel 就是这样） */
  assert.match(toolbar, /data-font-bold/, '「加粗」不见了');
  assert.match(toolbar, /data-font-italic/, '「斜体」不见了');
  assert.match(toolbar, /data-font-underline/, '「下划线」不见了');
  assert.match(toolbar, /data-font-size/, '「字号」不见了');
  assert.match(toolbar, /data-font-color/, '「字体颜色」不见了');
});

test('FIX-37 工具栏：分组标签一个不许少，每个下拉都有名字', () => {
  const toolbar = main.slice(main.indexOf('<div class="excel-toolrow"'), main.indexOf('</header>'));
  for (const want of ['编辑', '选区字体', '结构', '格式', '数据']) {
    assert.ok(toolbar.includes(`aria-label="${want}"`), `工具栏缺少「${want}」分组`);
  }
  for (const menu of ['edit', 'structure', 'data']) {
    assert.match(toolbar, new RegExp(`aria-label="[^"]*"`), '下拉菜单要带 aria-label');
  }
});

test('FIX-37 护栏：收进去的入口一个都不许少', () => {
  for (const attr of [
    'data-undo', 'data-find-replace', 'data-paste-special', 'data-fill-series',
    'data-font-size', 'data-font-color', 'data-font-bold', 'data-font-italic', 'data-font-underline',
    'data-structure', 'data-auto-fit', 'data-field-permissions', 'data-number-format',
    'data-wrap-text', 'data-border-open', 'data-style-more',
    'data-relation', 'data-personal-view', 'data-sort-asc', 'data-sort-desc', 'data-sort-reset',
    'data-search-input', 'data-export',
  ]) {
    assert.ok(main.includes(attr), `入口 ${attr} 不见了 —— 改版不许丢功能`);
  }
});

test('FIX-37 护栏：下拉菜单点外面要关掉、按 Esc 要关掉', () => {
  assert.match(main, /closeToolMenus/, '没有「关掉所有工具栏下拉」的函数');
  assert.match(main, /Escape/, '工具栏下拉没处理 Esc 键');
});

/* ——————— FIX-38：弹窗里的下拉要**在下方展开** ———————
   用户 2026-10-20 11:18 反馈：「还是向上，你换成原来的，然后下拉栏在下方展开」。

   根因：原生 `<select>` 的展开浮层是**浏览器画的**，位置由 Chrome 自己算 ——
   在 `<dialog>` 里它常常**向上弹**，盖住上面整片内容（用户截图里
   「垂直」的下拉正好压住「底色」「文字对齐」「水平」）。
   那个位置**用 CSS 改不动**，原生 select 也不给方向开关。

   修法：域内自绘一个下拉菜单（触发器 ＋ 浮层，浮层 `top:100%` ⇒ **永远在下方**）。
   公共壳**一个字没动**（公共壳里本来就没有下拉菜单组件）。

   测试通过 = 下面全部成立：
     1. 「更多格式」的三个设定（填充色/水平/垂直）**不再是原生 `<select>`**
     2. 下拉浮层在触发器**下方**（`top:100%`），不向上
     3. 浮层有 z-index，**不被父容器裁掉**
     4. 点外面 / 按 Esc 都关得掉
     5. 选中后触发器上显示新值
     6. **护栏**：档位一个不许少（填充色 9 项、对齐各 4 项）
*/

test('FIX-38 弹窗里的下拉是自绘菜单，浮层在下方展开', () => {
  const panel = main.slice(main.indexOf('function openMoreStylePanel'), main.indexOf('function applyFontPatch'));
  /* 不用原生 <select>（浮层方向不可控） */
  assert.doesNotMatch(panel, /createElement\('select'\)/, '还在用原生 <select>（浮层方向不可控）');
  /* 用域内自绘的下拉组件 */
  assert.match(panel, /createDropdown\(/, '没有用自绘下拉菜单');
  assert.ok(DROPDOWN.includes('excel-dropdown-menu'), '下拉组件里没有浮层');
  /* 浮层在触发器**下方** ⇒ 组件里按触发器底边算 top（不是 bottom） */
  assert.match(DROPDOWN, /rect\.bottom\s*\+\s*4/, '浮层不是按触发器底边定位的（不会在下方展开）');
  assert.doesNotMatch(DROPDOWN, /rect\.top\s*-\s*4/, '浮层不该按触发器顶边定位（那是向上）');
  /* 浮层用 fixed（absolute 会被弹窗 main 的 overflow 裁掉）＋ 有 z-index */
  assert.match(CSS_FILES_CSS, /\.excel-dropdown-menu\s*\{[^}]*position:\s*fixed/, '下拉浮层不是 fixed（会被父容器裁掉）');
  assert.match(CSS_FILES_CSS, /\.excel-dropdown-menu\s*\{[^}]*z-index:\s*\d+/, '下拉浮层缺 z-index（会压不住或被压住）');
});

test('FIX-38 下拉点外面、按 Esc 都关得掉', () => {
  assert.match(DROPDOWN, /closeDropdowns/, '下拉组件里没有「关掉所有下拉」的处理');
  assert.match(main, /closeDropdowns\(\)/, '主流程没调用「关掉所有下拉」');
  assert.match(main, /Escape/, '下拉没处理 Esc 键');
});

test('FIX-38 在弹窗里按 Esc 只收起下拉，不把整个弹窗一起关掉', () => {
  /* 公共弹窗（tool-workspace.js）在 document **冒泡阶段**监听 Esc，
     命中就 closeModal() ⇒ 下拉展开时按 Esc 会**连弹窗一起关**。
     所以下拉必须**在捕获阶段**先拦下 Esc。 */
  assert.match(DROPDOWN, /addEventListener\('keydown',\s*escGuard\s*,\s*true\)/,
    'Esc 捕获器没有在**捕获阶段**注册（会被公共弹窗抢先关掉整个弹窗）');
  assert.match(DROPDOWN, /stopImmediatePropagation\(\)/,
    'Esc 没有 stopImmediatePropagation（拦不住公共弹窗的处理）');
});

test('FIX-38 护栏：档位一个不许少', () => {
  const panel = main.slice(main.indexOf('function openMoreStylePanel'), main.indexOf('function applyFontPatch'));
  for (const v of ['left', 'center', 'right', 'top', 'bottom', 'none']) {
    assert.ok(panel.includes(`'${v}'`), `对齐档位 ${v} 不见了`);
  }
  assert.match(panel, /无填充/, '「无填充」这个档位不见了');
  /* 常用色在 FILL_PRESETS 里（它定义在面板函数之前，不能只切面板那一段） */
  for (const c of ['#FFFFFF', '#FFF3C4', '#FFE08A', '#D9F0D3', '#CFE8FF', '#E3D9FF', '#FFD9DE', '#E5E7EB']) {
    assert.ok(main.includes(c), `常用色 ${c} 不见了`);
  }
});

test('FIX-37 工具栏：字号是下拉框（Excel 的做法：常用字号直接选）', () => {
  const toolbar = main.slice(main.indexOf('<div class="excel-toolrow"'), main.indexOf('</header>'));
  assert.match(toolbar, /select data-font-size/, '字号不是下拉框');
  assert.doesNotMatch(toolbar, /input[^>]*data-font-size/, '字号还是数字输入框');
  /* 常用档位一个不许少 */
  for (const size of ['8', '9.75', '11', '14', '18', '24', '36', '48']) {
    assert.ok(main.includes(`${size}`), `常用字号 ${size} 不见了`);
  }
});

test('FIX-37 工具栏：三个下拉的开关按钮名字要能分辨，不能都叫「更多」', () => {
  const toolbar = main.slice(main.indexOf('<div class="excel-toolrow"'), main.indexOf('</header>'));
  const labels: string[] = [];
  for (const key of ['edit', 'structure', 'data']) {
    const at = toolbar.indexOf(`data-${key}-toggle`);
    assert.ok(at > 0, `缺少「${key}」下拉的开关按钮`);
    /* 开关按钮里的 <span> 文字就是它的名字 */
    const span = /<span>([^<]+)<\/span>/.exec(toolbar.slice(at, at + 600));
    assert.ok(span, `「${key}」下拉的开关按钮没有名字`);
    labels.push(span[1]);
  }
  assert.equal(new Set(labels).size, 3, `三个下拉的开关名字重样了：${labels.join('、')} —— 用户分不清哪个是哪个`);
  /* 而且不许都叫「更多」 */
  assert.ok(!labels.includes('更多'), `下拉开关不能都叫「更多」：${labels.join('、')}`);
});
