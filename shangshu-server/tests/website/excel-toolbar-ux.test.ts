import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import {validateFontPatch} from '../../../shangshu-web/js/domains/excel-univer/src/font-style.ts';

const MAIN = readFileSync(
  new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts', import.meta.url), 'utf8');

/** 从 main.ts 里按名字抽出函数/常量声明（TS AST，不用正则啃源码）。 */
function extract(source: string, names: string[]): string {
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && names.includes(decl.name.text)) out.push(node.getText(ast));
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      out.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out.join('\n');
}

/** 工具栏那段 HTML（模板字面量里的原样文本）。 */
function toolbarHtml(): string {
  const start = MAIN.indexOf('<div class="excel-toolrow"');
  const end = MAIN.indexOf('</header>', start);
  assert.ok(start > 0 && end > start, 'main.ts 里应当找得到工具栏');
  return MAIN.slice(start, end);
}

function mountToolbar(): Document {
  const dom = new JSDOM(`<div id="root">${toolbarHtml()}</div>`);
  return dom.window.document;
}

// —— FIX-14：工具栏按功能分组，图标按钮配文字 ——
// 测试通过 = 什么成立：工具栏里至少 5 个具名分组（编辑/字体/结构/格式/数据），
// 每个分组都有 role=group 与 aria-label；用户能一眼看出哪组是哪组。
it('FIX-14 工具栏按功能分组，每组都有名字', () => {
  const doc = mountToolbar();
  const groups = [...doc.querySelectorAll('.excel-toolrow [role="group"]')];
  assert.ok(groups.length >= 5, `工具栏至少应有 5 个分组，实际 ${groups.length}`);
  const labels = groups.map(group => group.getAttribute('aria-label') || '');
  for (const want of ['编辑', '选区字体', '结构', '格式', '数据']) {
    assert.ok(labels.includes(want), `工具栏缺少「${want}」分组，现有：${labels.join('、')}`);
  }
});

// —— FIX-13：行列入口必须看得见 ——
// 测试通过 = 什么成立：工具栏里一直有「行列」按钮（不是 hidden），
// 并且带图标与文字，用户不点右键也能找到插入/删除/移动行列。
it('FIX-13 行列入口常驻可见，且带图标与文字', () => {
  const doc = mountToolbar();
  const structure = doc.querySelector('[data-structure]');
  assert.ok(structure, '工具栏必须有行列入口');
  assert.equal(structure!.hasAttribute('hidden'), false, '行列入口不能是 hidden');
  assert.match(structure!.textContent || '', /行列/, '行列入口要有文字');
  // 图标是运行时由 icon() 助手生成的（模板里是 ${icon(...)}），所以查源码片段。
  const raw = MAIN.slice(MAIN.indexOf('data-structure'), MAIN.indexOf('data-structure') + 400);
  assert.ok(raw.includes('${icon('), '行列入口要有图标');
});

// —— FIX-14：边框从「两项下拉」换成真设置 ——
// 测试通过 = 什么成立：工具栏里不再有只有两项的边框下拉，
// 而是一个打开边框面板的按钮。
it('FIX-14 边框不再是两项下拉，改成打开面板的按钮', () => {
  const doc = mountToolbar();
  assert.equal(doc.querySelector('select[data-border]'), null, '不能保留两项下拉');
  const open = doc.querySelector('[data-border-open]');
  assert.ok(open, '必须有打开边框面板的按钮');
  assert.match(open!.textContent || '', /边框/);
});

// —— FIX-13：没有结构修改权时，入口照样在，但要说明为什么 ——
// 测试通过 = 什么成立：表打开后「行列」按钮不会被藏起来；
// 没有结构权时，按钮标题里写清楚缺的是表结构修改权限（不让人猜）。
it('FIX-13 行列按钮不再被藏起来；无结构权时标题说明原因', () => {
  const code = ts.transpileModule(extract(MAIN, ['updateToolbar']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const run = (table: any) => {
    const el: any = {
      fieldPermissions: {}, structure: {}, personalView: {}, sortControls: {},
      sortAsc: {}, sortDesc: {}, sortReset: {}, undo: {},
      export: {querySelector: () => ({textContent: ''})},
      fontSize: {}, fontColor: {}, fontBold: {}, borderOpen: {}, fontGroup: {},
      // FIX-18 新增的入口（斜体 / 下划线 / 更多格式 / 适应列宽）
      fontItalic: {}, fontUnderline: {}, styleMore: {}, autoFit: {},
      // FIX-49 新增的入口（列头筛选）：工具栏上的「筛选」
      columnFilter: {},
      title: {classList: {toggle: () => {}}},
    };
    const context: any = {
      table, grid: {}, openingTable: false, el,
      canManageFieldPermissions: true, hasUnsaved: () => false, tableSort: null,
      undoStack: [], undoing: false, exporting: false,
      exportCapabilities: {available: true, canStructure: true},
      // ⚠️ `canChangeStructure` 是 `mountExcelPage` 的**闭包常量**（main.ts 第 857 行）——
      //   抽出来的 `updateToolbar` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError。
      //   这里照产品原样补上（产品：`table?.kind==='xlsx' && table.canStructure===true`）。
      canChangeStructure: () => table?.kind === 'xlsx' && table.canStructure === true,
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    context.updateToolbar();
    return el;
  };
  // ⚠️ 表的夹具要说明**这是哪一类表**（`kind`）——产品里 `table.kind` 一直都有
  //   （`canChangeStructure` 判的就是「xlsx 表 ＋ 有结构权」）。
  const withoutRight = run({kind: 'xlsx', canStructure: false, writable: true, writeStyle: true});
  assert.equal(withoutRight.structure.hidden, false, '没有结构权也不能把入口藏起来');
  assert.match(withoutRight.structure.title || '', /权限/, '标题要写清楚缺的是表结构修改权限');
  const withRight = run({kind: 'xlsx', canStructure: true, writable: true, writeStyle: true});
  assert.equal(withRight.structure.hidden, false);
  assert.match(withRight.structure.title || '', /插入/, '有能力时标题要说明能做什么');
});

// —— FIX-18：工具栏多出来的格式入口 ——
// 测试通过 = 什么成立：用户不靠右键就能找到斜体、下划线、更多格式（填充/对齐/清除格式）
// 和适应列宽；每个入口都带文字（不是纯图标），无样式权时说明原因。
it('FIX-18 工具栏有斜体、下划线、更多格式、适应列宽四个新入口', () => {
  const doc = mountToolbar();
  for (const [selector, label] of [
    ['[data-font-italic]', '斜体'],
    ['[data-font-underline]', '下划线'],
    ['[data-style-more]', '更多格式'],
    ['[data-auto-fit]', '适应列宽'],
  ] as const) {
    const node = doc.querySelector(selector);
    assert.ok(node, `工具栏缺少「${label}」入口`);
    assert.equal(node!.hasAttribute('hidden'), false, `「${label}」入口不能是 hidden`);
  }
  // 三个格式入口在同一个「选区字体/格式」组里，位置固定，用户不用找。
  const fontGroup = doc.querySelector('[data-font-group]');
  assert.ok(fontGroup!.querySelector('[data-font-italic]'), '斜体应在字体组里');
  assert.ok(fontGroup!.querySelector('[data-font-underline]'), '下划线应在字体组里');
  const more = doc.querySelector('[data-style-more]');
  assert.match(more!.getAttribute('title') || '', /填充色/, '「更多格式」要说明能做什么');
});

// —— FIX-18：更多格式面板走公共弹窗，且把三种设置都摆出来 ——
// 测试通过 = 什么成立：填充色、对齐、清除格式都在**公共弹窗**（ui.dialog）里，
// 不另造浮层；清除格式有中文说明。
it('FIX-18 更多格式面板用公共弹窗，含填充色/对齐/清除格式', () => {
  const code = ts.transpileModule(extract(MAIN, ['openMoreStylePanel']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  assert.match(code, /ui\.dialog\(/, '更多格式要用公共弹窗 ui.dialog');
  assert.match(code, /填充色/, '面板要有填充色');
  assert.match(code, /文字对齐/, '面板要有文字对齐');
  assert.match(code, /清除格式/, '面板要有清除格式');
  assert.match(code, /clear_format/, '清除格式要走受管样式动作');
});

// —— FIX-18：自动算宽走同一条 layout 写入口 ——
// 测试通过 = 什么成立：前端把「按内容算宽」的列号交给服务端算，
// 并把服务端算出来的宽度应用回网格（不是自己猜宽度）。
it('FIX-18 适应列宽把列号交给服务端算，并应用回执里的宽度', () => {
  const code = ts.transpileModule(extract(MAIN, ['autoFitSelectedColumns']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  assert.match(code, /writeLayout\(/, '适应列宽要走 layout 写入口');
  assert.match(code, /autoFitColumns|columns/, '要把列号交给服务端');
  assert.match(code, /setColumnWidth/, '要把算出来的宽度应用回网格');
});

// —— 第四批：查找替换 / 选择性粘贴 / 填充序列三个入口 ——
// 测试通过 = 什么成立：工具栏里一直有这三个带文字的入口（不靠右键找得到），
// 都在「编辑」组里；三个面板都走**公共弹窗**（ui.dialog），不另造浮层。
it('第四批 工具栏有查找替换、选择性粘贴、填充序列三个入口', () => {
  const doc = mountToolbar();
  for (const [selector, label] of [
    ['[data-find-replace]', '查找替换'],
    ['[data-paste-special]', '选择性粘贴'],
    ['[data-fill-series]', '填充序列'],
  ] as const) {
    const node = doc.querySelector(selector);
    assert.ok(node, `工具栏缺少「${label}」入口`);
    assert.equal(node!.hasAttribute('hidden'), false, `「${label}」入口不能是 hidden`);
    assert.match(node!.textContent || '', new RegExp(label), `「${label}」入口要有文字`);
  }
  const editGroup = doc.querySelector('[aria-label="编辑"]');
  assert.ok(editGroup, '要有「编辑」分组');
  for (const selector of ['[data-find-replace]', '[data-paste-special]', '[data-fill-series]']) {
    assert.ok(editGroup!.querySelector(selector), '成包编辑入口应放在「编辑」组里');
  }
});

// —— 第四批：三个面板走公共弹窗，把该有的选项都摆出来 ——
// 测试通过 = 什么成立：查找替换面板有「查找内容 / 替换为」两个输入，
// 选择性粘贴面板有「只贴值 / 只贴公式 / 只贴格式」三种贴法，
// 填充序列面板有「等差 / 日期 / 列表 / 复制」四种方式 —— 都在公共弹窗里。
it('第四批 三个成包编辑面板都走公共弹窗，且选项齐全', () => {
  const code = ts.transpileModule(
    extract(MAIN, ['openFindReplacePanel', 'openPasteSpecialPanel', 'openFillSeriesPanel']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const dialogs = (code.match(/ui\.dialog\(/g) || []).length;
  assert.equal(dialogs, 3, '三个面板都要用公共弹窗 ui.dialog');
  assert.match(code, /查找内容/, '查找替换面板要有查找内容');
  assert.match(code, /替换为/, '查找替换面板要有替换为');
  assert.match(code, /区分大小写/, '查找替换面板要有大小写开关');
  assert.match(code, /只贴值/, '选择性粘贴要有只贴值');
  assert.match(code, /只贴公式/, '选择性粘贴要有只贴公式');
  assert.match(code, /只贴格式/, '选择性粘贴要有只贴格式');
  assert.match(code, /等差/, '填充序列要有等差');
  assert.match(code, /日期/, '填充序列要有日期');
  assert.match(code, /列表/, '填充序列要有列表');
});

// —— 第四批：成包编辑走服务端动作，前端不自己改数据 ——
// 测试通过 = 什么成立：三个入口最终调的是服务端的受管动作
// （files.sheet_find_replace / sheet_fill_series / sheet_paste_special），不是前端本地改。
it('第四批 三个成包编辑走服务端受管动作', () => {
  const code = ts.transpileModule(
    extract(MAIN, ['runFindReplace', 'runFillSeries', 'runPasteSpecial']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  assert.match(code, /findReplace/, '查找替换走服务端的 findReplace');
  assert.match(code, /fillSeries/, '填充序列走服务端的 fillSeries');
  assert.match(code, /pasteSpecial/, '选择性粘贴走服务端的 pasteSpecial');
  assert.match(code, /newIdempotencyKey/, '每次操作要有自己的操作编号（撤回定位用）');
  assert.match(code, /retrySave/, '要用重试保存（回执丢了按原编号重试）');
});

// —— 第四批：桌面端选择粘贴的源区域靠「最近一次复制」——
// 测试通过 = 什么成立：复制时把区域记下来，选择性粘贴面板用它当源。
it('第四批 复制时记下区域，供选择性粘贴当源', () => {
  assert.match(MAIN, /lastCopiedRange/, '要记住最近一次复制的区域');
  const copyBlock = MAIN.slice(MAIN.indexOf('lastCopiedRange={'), MAIN.indexOf('lastCopiedRange={') + 200);
  assert.match(copyBlock, /payload\.range/, '记的应该是复制的那块区域');
});

// 测试通过 = 什么成立：合法的预设/线型/颜色都放行；
// 非法预设、非法线型、非法颜色都被中文消息挡下。
// —— FIX-14：边框补丁按「预设 + 线型 + 颜色」校验 ——
// 测试通过 = 什么成立：合法的预设/线型/颜色都放行；
// 非法预设、非法线型、非法颜色都被中文消息挡下。
it('FIX-14 边框补丁按预设、线型、颜色校验', () => {
  assert.deepEqual(validateFontPatch({border: {preset: 'outer', style: 'dashed', color: '#112233'}}),
    {border: {preset: 'outer', style: 'dashed', color: '#112233'}});
  assert.deepEqual(validateFontPatch({border: {preset: 'none'}}), {border: {preset: 'none'}});
  assert.throws(() => validateFontPatch({border: {preset: 'rainbow'} as any}), /边框预设/);
  assert.throws(() => validateFontPatch({border: {preset: 'all', style: 'squiggly'} as any}), /线型/);
  assert.throws(() => validateFontPatch({border: {preset: 'all', color: 'red'} as any}), /颜色/);
});

// —— FIX-14：边框面板走公共弹窗，八个预设 + 线型 + 颜色 ——
// 测试通过 = 什么成立：点「边框」打开的是**公共弹窗**（ui.dialog），
// 里面有 8 个边框预设可选、能改线型与颜色；
// 选中「内框」再点「应用」，最终交给保存动作的是 {preset:'inner',style,color}。
it('FIX-14 边框面板走公共弹窗，预设/线型/颜色能落到补丁上', () => {
  const code = ts.transpileModule(
    extract(MAIN, ['openBorderPanel', 'BORDER_PRESET_ITEMS', 'BORDER_STYLE_ITEMS']),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const dom = new JSDOM('<div id="host"></div>');
  const dialogs: any[] = [];
  const patches: any[] = [];
  // FIX-38：线型控件从原生 <select> 换成**域内自绘下拉**（原生 select 在 <dialog> 里
  // 展开会向上弹、盖住内容，而那个方向用 CSS 改不动）。
  // 沙箱里补上这个依赖 —— 判据要验的**行为**（能选线型、能落到补丁上）一条没少。
  const dropdownSource = readFileSync(
    new URL('../../../shangshu-web/js/domains/excel-univer/src/dropdown.ts', import.meta.url), 'utf8');
  // 去掉所有 export（这个沙箱用 vm 跑，不是 ES module）
  const dropdownCode = ts.transpileModule(
    dropdownSource.replace(/\bexport\s+/g, ''),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const context: any = {
    document: dom.window.document,
    window: dom.window,
    ui: {
      dialog: (options: any) => {
        dialogs.push(options);
        const host = dom.window.document.createElement('div');
        host.appendChild(options.body);
        return host;
      },
      closeModal: () => {},
    },
    applyFontPatch: (patch: any) => patches.push(patch),
  };
  vm.createContext(context);
  vm.runInContext(dropdownCode, context);
  vm.runInContext(code, context);
  context.openBorderPanel();

  assert.equal(dialogs.length, 1, '应当只开一个公共弹窗');
  assert.equal(dialogs[0].title, '设置边框');
  const body = dialogs[0].body as HTMLElement;
  const presets = [...body.querySelectorAll('.excel-border-preset')];
  assert.equal(presets.length, 8, '八个边框预设');
  // 线型：自绘下拉的触发器（不是原生 select —— 那个浮层方向不可控）
  const styleTrigger = body.querySelector('.excel-dropdown-trigger[aria-label="边框线型"]');
  assert.ok(styleTrigger, '要能选线型');
  assert.equal(body.querySelector('select[aria-label="边框线型"]'), null, '线型不该再用原生 <select>（浮层方向不可控）');
  assert.ok(body.querySelector('input[aria-label="边框颜色"]'), '要能选颜色');

  const inner = presets.find(button => button.getAttribute('data-preset') === 'inner')!;
  assert.ok(inner, '要有「内框」预设');
  (inner as HTMLButtonElement).click();
  assert.equal(inner.getAttribute('aria-checked'), 'true', '选中的预设要有选中态');
  // 选一个线型 ⇒ 落到补丁上（自绘下拉：点触发器展开，再点那一项）
  (styleTrigger as HTMLButtonElement).click();
  const styleItem = [...body.querySelectorAll('.excel-dropdown-item')]
    .find(item => (item as HTMLElement).dataset.value === 'dashed') as HTMLElement;
  assert.ok(styleItem, '线型下拉里要有「虚线」');
  styleItem.click();
  const apply = dialogs[0].actions.find((action: any) => action.label === '应用');
  assert.ok(apply, '面板要有「应用」动作');
  apply.onClick();
  assert.equal(patches.length, 1, '点应用要真的交出补丁');
  assert.equal(patches[0].border.preset, 'inner');
  assert.equal(patches[0].border.style, 'dashed');
  assert.match(patches[0].border.color, /^#[0-9A-Fa-f]{6}$/);
});
