import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import {
  excelAddress,
  excelColumnLetter,
  hitCell,
  insertAtCaret,
  rangeAddress,
  formulaRangeHint,
  shouldTakeFormulaShortcut,
  formulaSeed,
  replaceReferenceAtCaret,
} from '../../../shangshu-web/js/domains/excel-univer/src/formula-range.ts';
import {needsFormulaRefresh, wroteFormula} from '../../../shangshu-web/js/domains/excel-univer/src/formula-values.ts';
import {functionSource} from './source-extract.ts';

/*
 FIX-15 / A14：「公式无法向 excel 一样能够选择 xxx：xxx」。
 用户要在写公式时用鼠标框出引用范围（如 SUM 的 A2:B10）。

 判据口径：**地址换算必须与后端公式引擎同一把尺子** ——
 表头占第 1 行 → 第一个数据行是第 2 行；A 列是第一个数据列。
 依据后端 `shangshu_files/formulas.py`：`r<2` 判引用非法、取值用 `row-2`。
 前端多算一行，公式就会静默算错 —— 这条比界面好不好看更要紧。
*/

test('地址换算与后端同一把尺子：测试通过 = 第 0 个数据行是第 2 行，第 0 个数据列是 A 列', () => {
  assert.equal(excelColumnLetter(0), 'A');
  assert.equal(excelColumnLetter(25), 'Z');
  assert.equal(excelColumnLetter(26), 'AA');
  assert.equal(excelColumnLetter(27), 'AB');
  assert.equal(excelAddress(0, 0), 'A2', '第一个数据行应是第 2 行（表头占第 1 行）');
  assert.equal(excelAddress(0, 1), 'B2');
  assert.equal(excelAddress(8, 2), 'C10');
});

test('非法坐标当场报错，不静默算出一个错地址：测试通过 = 负数/非整数行号抛错', () => {
  assert.throws(() => excelAddress(-1, 0), /行序号无效/);
  assert.throws(() => excelAddress(1.5, 0), /行序号无效/);
  assert.throws(() => excelColumnLetter(-1), /列序号无效/);
});

test('选区地址：单格给单地址，多格给区间，且起止归一：测试通过 = 反向框选给出同一个区间', () => {
  assert.equal(rangeAddress({ row: 0, col: 0 }, { row: 0, col: 0 }), 'A2');
  assert.equal(rangeAddress({ row: 0, col: 0 }, { row: 3, col: 1 }), 'A2:B5');
  assert.equal(rangeAddress({ row: 3, col: 1 }, { row: 0, col: 0 }), 'A2:B5', '从右下往左上框要给同一个区间');
  assert.equal(rangeAddress({ row: 0, col: 0 }, { row: 3, col: 0 }), 'A2:A5', '单列区间不给多余的 B');
});

test('命中判定：点落在哪一格，格线算左边那格，没落在任何格上不猜：测试通过 = 命中/未命中分明', () => {
  const cells = [
    { row: 0, col: 0, rect: { left: 0, top: 0, width: 100, height: 24 } },
    { row: 0, col: 1, rect: { left: 100, top: 0, width: 100, height: 24 } },
    { row: 1, col: 0, rect: { left: 0, top: 24, width: 100, height: 24 } },
  ];
  assert.deepEqual(hitCell(cells, 10, 10), { row: 0, col: 0 });
  assert.deepEqual(hitCell(cells, 150, 10), { row: 0, col: 1 });
  assert.deepEqual(hitCell(cells, 10, 30), { row: 1, col: 0 });
  assert.deepEqual(hitCell(cells, 100, 10), { row: 0, col: 1 }, '格线算右边那一格（半开区间）');
  assert.equal(hitCell(cells, 500, 500), null, '没落在任何格上不猜');
});

test('光标插入：引用插在光标处，后面的内容不丢：测试通过 = 文本与新光标都对', () => {
  const r = insertAtCaret('=SUM()', 5, 'A2:B10');
  assert.equal(r.text, '=SUM(A2:B10)');
  assert.equal(r.caret, 11, '新光标落在插入内容之后');
  const mid = insertAtCaret('=SUM(A2)', 5, 'B2');
  assert.equal(mid.text, '=SUM(B2A2)', '插在光标处，不是替换后面');
  assert.equal(mid.caret, 7);
  assert.equal(insertAtCaret('=SUM()', 99, 'A2').text, '=SUM()A2', '越界光标夹到末尾，不抛错');
});

test('提示语说清三件事：怎么框范围、怎么保存、怎么取消：测试通过 = 提示里都有', () => {
  const hint = formulaRangeHint();
  assert.match(hint, /拖选/, '要说明怎么框范围');
  assert.match(hint, /Enter/, '要说明怎么保存');
  assert.match(hint, /Esc/, '要说明怎么取消');
});

/*
 FIX-15 判据（活站实测后补）：在网格上按 '=' **必须**接管成��域公式编辑器。

 活站复现（3870，试用-混合表）：选中「金额」第 5 行 → 按 '=' → 单元格出现 "="，
 但**没有**本域的公式编辑器与提示条 —— '=' 落进了 Univer 原生编辑器。

 真因：Univer 的网格键盘输入落在一个**隐藏的 contenteditable div** 上
 （`#__editor___INTERNAL_EDITOR__DOCS_NORMAL`，z-index:-2，opacity:1 但透明），
 也就是说网格里按下的**每一个键，target 都是 contenteditable**。
 早前按「target 是可编辑元素就不接管」来避让，结果网格里的 '=' 永远接不到。

 测试通过 = 下面全部成立：
 1. target 是 Univer 内部编辑器时，'=' **要接管**（哪怕它是 contenteditable）；
 2. target 是人用的输入框（input/textarea/contenteditable）时，**不接管**；
 3. Univer 原生编辑器已经开着时**不接管**（'=' 只是正文里的一个字）；
 4. 按别的键、带 Ctrl/Shift/Alt/Meta、没有可改的当前格，都**不接管**。
*/
test('接管判定：网格里的 = 要接管，人用的输入框不接管：测试通过 = Univer 内部编辑器照接管，表单输入框不接管', () => {
  const univerInternal = {tagName: 'DIV', id: '__editor___INTERNAL_EDITOR__DOCS_NORMAL', isContentEditable: true};
  assert.equal(
    shouldTakeFormulaShortcut({key: '=', target: univerInternal, editorVisible: false, hasEditableCell: true}),
    true,
    "Univer 内部编辑器也是 contenteditable，避让它就等于永远接不到网格里的 =",
  );
  assert.equal(
    shouldTakeFormulaShortcut({key: '=', target: {tagName: 'INPUT'}, editorVisible: false, hasEditableCell: true}),
    false,
    '人用的输入框里按 = 不该被抢走',
  );
  assert.equal(
    shouldTakeFormulaShortcut({key: '=', target: {tagName: 'TEXTAREA'}, editorVisible: false, hasEditableCell: true}),
    false,
    '人用的文本域里按 = 不该被抢走',
  );
  assert.equal(
    shouldTakeFormulaShortcut({key: '=', target: {tagName: 'DIV', id: 'rich-editor', isContentEditable: true}, editorVisible: false, hasEditableCell: true}),
    false,
    '人用的富文本里按 = 不该被抢走',
  );
});

test('接管判定的其余边界：测试通过 = 已在编辑/别的键/带修饰键/无可改格都不接管', () => {
  const grid = {tagName: 'DIV', id: '__editor___INTERNAL_EDITOR__DOCS_NORMAL', isContentEditable: true};
  assert.equal(shouldTakeFormulaShortcut({key: '=', target: grid, editorVisible: true, hasEditableCell: true}), false,
    '原生编辑器开着时，= 只是正文里的一个字');
  assert.equal(shouldTakeFormulaShortcut({key: 'a', target: grid, editorVisible: false, hasEditableCell: true}), false,
    '只有 = 才接管');
  assert.equal(shouldTakeFormulaShortcut({key: '=', ctrlKey: true, target: grid, editorVisible: false, hasEditableCell: true}), false,
    '带 Ctrl 的 = 不接管');
  assert.equal(shouldTakeFormulaShortcut({key: '=', shiftKey: true, target: grid, editorVisible: false, hasEditableCell: true}), false,
    '带 Shift 的 + 不接管');
  assert.equal(shouldTakeFormulaShortcut({key: '=', altKey: true, target: grid, editorVisible: false, hasEditableCell: true}), false,
    '带 Alt 的不接管');
  assert.equal(shouldTakeFormulaShortcut({key: '=', metaKey: true, target: grid, editorVisible: false, hasEditableCell: true}), false,
    '带 Meta 的不接管');
  assert.equal(shouldTakeFormulaShortcut({key: '=', target: grid, editorVisible: false, hasEditableCell: false}), false,
    '没有可改的当前格（或该列只读）不接管');
});

/*
 FIX-15 判据（活站实测后补）：按 '=' 打开的公式编辑器**必须已经带上 "="**。

 活站复现（3870，试用-混合表，普通列）：
 选中普通列第 1 行 → 按 '=' → 编辑器打开（提示条在）→ 键入 SUM → 点金额第 1 行插引用 → Enter，
 格子存进去的是 **"SUMB2"**（一个字面量，**不是公式**）。

 真因：接管 '=' 快捷键时 `preventDefault()` 把 "=" 这个字符**吃掉了**，
 而编辑器初值是「该格已有的公式」（空表就是空串）——
 于是用户接着写的 "SUM(B2)" 少了开头的 "="，后端按普通文本存，公式不生效。

 测试通过 = 打开编辑器时输入框里的初值是：
 1. 该格**已有公式** → 原样显示（不覆盖用户正在改的公式）；
 2. 该格**没有公式** → 预填 "="（用户接着写 SUM(… 就行，不必自己再敲一个等号）。
*/
test('公式编辑器初值：测试通过 = 空表预填 "="，已有公式原样显示', () => {
  assert.equal(formulaSeed(''), '=', '空表按 = 打开编辑器要预填 "="，否则用户写的公式少了开头的等号');
  assert.equal(formulaSeed('=SUM(B2:B10)'), '=SUM(B2:B10)', '已有公式原样显示，不覆盖');
  assert.equal(formulaSeed(undefined), '=', '取不到已有公式时也预填 "="');
});

/*
 FIX-15 判据（活站实测后补）：**写进公式后，界面要立刻显示计算值**，不能停在公式文本。

 活站复现（3870，试用-一部部门表2 快照，普通列第 1 行）：
 选中格 → 按 '=' → 输入 SUM(B2:B3) → Enter
 → 服务端确实存成了公式（xlsx 里是 `<f>SUM(B2:B3)</f><v>1323.44</v>`，缓存值算对了），
 → **但界面上那一格一直显示 "=SUM(B2:B3)"**，要等用户重开表才看到 1323.44。

 真因：写完之后要不要「重读公式值」由 `needsFormulaRefresh` 决定，
 而它只看服务端回执里的 has_formulas / 类型化值 ——
 **本次写进去的公式原文（"=SUM(B2:B3)"）不在里面**，
 于是判成「不用重读」，页面留着用户刚敲的公式文本。

 测试通过 = 写进公式时判定为「要重读公式值」：
 1. 写进 "=SUM(B2:B3)" → 要重读（否则界面停在公式文本，用户看不到算出来的数）；
 2. 写进普通文本 → 不重读（普通值回填不需要重读整页）。
*/
test('写进公式后要重读公式值：测试通过 = 写进 "=SUM(B2:B3)" 判定要重读，普通文本不重读', () => {
  assert.equal(wroteFormula(['=SUM(B2:B3)']), true, '写进公式文本 → 必须重读公式值');
  assert.equal(wroteFormula(['普通文本']), false, '普通文本不重读');
  assert.equal(wroteFormula([]), false, '没写东西不重读');
  assert.equal(needsFormulaRefresh(false, ['=SUM(B2:B3)']), true,
    '只靠服务端 has_formulas 判会漏掉本次写入的公式 → 界面停在公式文本');
  assert.equal(needsFormulaRefresh(false, ['普通文本']), false, '普通文本不触发重读');
  assert.equal(needsFormulaRefresh(false, [{type: 'formula', formula: '=A1', value: 1}]), true, '类型化公式仍要重读');
  assert.equal(needsFormulaRefresh(false, [{type: 'number', value: 1}]), false, '普通数值不触发重读');
});

/*
 FIX-15 判据（第五批，2026-10-20 活站实测后补）：**第二次框选要替换掉第一次的引用**，不是接在后面。

 活站复现（3870，A14-区间选择-临时表）：在「合计」格里按 = → 输入 SUM( →
 先点「数量」第一行 → 公式成 =SUM(B2)；
 再按住拖「数量」第二行到第三行 → 公式成 **=SUM(B2B3:B4)** ——
 中间的 B2B3 不是一个合法引用，存进去是「公式语法不完整」，算不出数
 （活站底部当时正挂着「有 2 笔输入待核实：公式语法不完整」）。

 Excel 的做法：新框的引用**替换**光标处那个引用，不是接在它后面。
 框错了再框一次，是写公式时最常见的动作 —— 这条不通，整个区间选择就等于不好用。

 测试通过 = 框第二次后，公式里不出现两个引用拼在一起（旧引用被换掉）。
 本条**跑的是生产代码**（sheet.ts 里的 editFormula 原样抽出来执行），
 不是照着实现重写一遍 —— 重写一遍只会全绿、也发现不了用户真正遇到的问题。
*/
test('第二次框选替换旧引用：测试通过 = 公式里不出现两个引用拼在一起', () => {
  const source = readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(functionSource(source, 'editFormula'), {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText;
  const dom = new JSDOM('<div id="host"></div>');
  try {
    const host = dom.window.document.querySelector('#host') as HTMLElement;
    const commits: any[] = [];
    /* 列要和真表一样：名称(A) 数量(B) 合计(C) —— 地址口径才和活站对得上。 */
    const columns = [{fieldId: '名称', type: 'text'}, {fieldId: '数量', type: 'number'}, {fieldId: '合计', type: 'text'}];
    /* 假网格：第 0 行是**第一个数据行**（表头不算行），列宽 100、行高 24。 */
    const frame = {
      visible: {startRow: 0, endRow: 30, startCol: 0, endCol: 6},
      rect: (row: number, col: number) => ({left: col * 100, top: row * 24, width: 100, height: 24}),
    };
    const env: any = {
      host, columns, reviewFrame: () => frame,
      commitHandlers: [(value: any) => commits.push(value)],
      endFormulaEditor: () => {}, formulaEditor: null, formulaHint: null, cancelFormulaEditor: null,
      hitCell, rangeAddress, insertAtCaret, replaceReferenceAtCaret, formulaRangeHint, formulaSeed,
    };
    const names = Object.keys(env);
    const editFormula = new Function(...names, code + ';return editFormula;')(...(Object.values(env) as any));
    editFormula(0, 2, '', '=');
    const input = host.querySelector('input[data-formula-editor]') as HTMLInputElement;
    assert.ok(input, '公式编辑器应当打开');
    input.focus();
    input.value = '=SUM(';
    input.setSelectionRange(5, 5);
    const pointer = (type: string, x: number, y: number) =>
      host.dispatchEvent(new dom.window.MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true}));
    /* 第一次框选：从「数量」第 1 行拖到第 2 行 → B2:B3。 */
    pointer('pointerdown', 150, 0);
    pointer('pointermove', 150, 24);
    pointer('pointerup', 150, 24);
    assert.equal(input.value, '=SUM(B2:B3', '第一次框选应当把区间插到光标处');
    /* 第二次框选：再框到第 3 行 → 旧引用要被换掉，不能拼成 =SUM(B2:B3B2:B4)。 */
    pointer('pointerdown', 150, 0);
    pointer('pointermove', 150, 48);
    pointer('pointerup', 150, 48);
    assert.equal(input.value, '=SUM(B2:B4', '第二次框选要替换旧引用（Excel 的做法），不能接在后面');
  } finally {
    dom.window.close();
  }
});

/*
 引用替换的边界（纯规则）：
 · 光标处**已有引用** → 换掉它（框错了再框一次才修得回来）；
 · 光标处**没有引用** → 照插；
 · 光标处的词不是引用（如 '=A1+' 末尾是运算符、或 '=RATE1' 里的名字）→ 照插，别乱改用户写的字。
*/
test('引用替换的边界：测试通过 = 有旧引用才换，没有就照插', () => {
  assert.deepEqual(replaceReferenceAtCaret('=SUM(B2', 7, 'B3:B4'), {text: '=SUM(B3:B4', caret: 10}, '光标处的单格引用被换掉');
  assert.deepEqual(replaceReferenceAtCaret('=SUM(B2:B5', 10, 'B3:B4'), {text: '=SUM(B3:B4', caret: 10}, '光标处的区间整段被换掉');
  assert.deepEqual(replaceReferenceAtCaret('=SUM(', 5, 'B3:B4'), {text: '=SUM(B3:B4', caret: 10}, '没有旧引用就照插');
  assert.deepEqual(replaceReferenceAtCaret('=A1+', 4, 'B2'), {text: '=A1+B2', caret: 6}, '末尾是运算符，不动用户写的字');
  assert.deepEqual(replaceReferenceAtCaret('=RATE1', 6, 'B2'), {text: '=RATE1B2', caret: 8}, '名字不是引用，不动它');
  assert.deepEqual(replaceReferenceAtCaret('=A1B2', 5, 'C3'), {text: '=A1B2C3', caret: 7}, '不是独立的一个引用，不动它');
});
