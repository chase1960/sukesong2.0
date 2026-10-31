import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {needsFormulaRefresh, wroteFormula} from '../../../shangshu-web/js/domains/excel-univer/src/formula-values.ts';
import {retrySave} from '../../../shangshu-web/js/domains/excel-univer/src/save-retry.ts';
// ⚠️ 2026-10-30（PKG-133）：本文件把 `main.ts` 的**函数片段**抽出来在沙箱里跑
//   ⇒ 片段用到的**导入件**沙箱里没有就会 ReferenceError。
//   按仓库里已有的先例（shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs：
//   片段用到的导入件在沙箱 context 里补上，补的是**真的那个**），这里补：
import {decideExtendWrite} from '../../../shangshu-web/js/domains/excel-univer/src/write-gate.ts';   // writeRange 的越界写入闸

/*
 FIX-15 判据（活站 3870 实测复现）：**写进公式后，界面要显示服务端算出来的值**，
 不能停在公式文本。

 活站复现（试用-一部部门表2 快照，普通列第 5 行）：
 选中格 → 按 '=' → 输入 SUM(B2:B4) → Enter
 → 服务端确实存成公式并算出了值（读回是 138.65 = 42+88.88+7.77，xlsx 里 <f>SUM(B2:B4)</f><v>138.65</v>），
 → **但界面那一格一直显示 "=SUM(B2:B4)"**，要等下一次写或重开表才变成 138.65。

 真因（前端）：写入成功后要「重读公式值」才能拿到计算值；
 而重读回来的新值刚画上去，就被**「待保存输入」的本地回显**盖回用户刚敲的公式文本 ——
 因为这时那笔输入还挂在输入队列里、状态是 saving，`paintPendingInputs` 就把本地文本又画了一遍。

 测试通过 = 写进公式后，那一格**最后画上去的是服务端读回的计算值**，不是公式文本。
*/

function actualMainFunction(name: string, ctx: any, source = 'main.ts') {
  const file = ts.createSourceFile(source, readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/' + source, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let fn: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node; else ts.forEachChild(node, visit); };
  visit(file);
  assert.ok(fn, '必须测试产品中的真实' + name);
  const js = ts.transpileModule(fn!.getText(file), {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText;
  runInNewContext(js + ';globalThis.productFunction=' + name + ';', ctx);
  return ctx.productFunction;
}

/**
 * 输入一笔公式的沙箱。
 * `refreshLoadedFormulaValues` 按产品真链路模拟：先画服务端读回的值，再 `paintPendingInputs()`
 * （产品的 applyRows 就是这么做的：画完新值要重画待保存输入）。
 */
function formulaInputHarness(serverValue: number) {
  const painted: any[] = [];
  const columns = [{fieldId: '合计', label: '合计', type: 'text'}];
  const table: any = {
    writable: true, kind: 'xlsx', key: 'sheet-one',
    pasteApply: async () => ({cells: [], headers: ['合计'], rowsAdded: 0, colsAdded: 0, actionCount: 1}),
    inputWrite: async () => ({
      cells: [{rowId: 'r1', header: '合计', before: {type: 'empty', value: null}, after: {type: 'formula', formula: '=SUM(B2:B4)', value: null}}],
      headers: ['合计'], rowsAdded: 0, colsAdded: 0, actionCount: 1,
    }),
  };
  const input: any = {
    matrix: [['=SUM(B2:B4)']], row: 0, col: 0, fieldId: '合计', rowId: 'r1',
    before: '', key: 'input-1', state: 'idle', message: '', target: table, expectedStructureVersion: 1,
  };
  const ctx: any = {
    updateToolbar: () => {}, openingTable: false, pasteApplying: false, hasUnsaved: () => false,
    disposed: false, columns, totalRows: 10, filled: new Set([0]), nameToIndex: new Map([['r1', 0]]),
    table,
    inputQueue: [input], pendingInput: input, undoStack: [], pageCache: new Map(), PAGE_LENGTH: 100,
    el: {scope: {textContent: ''}}, showSaveOverlay: () => {}, hideSaveOverlay: () => {},
    notify: () => {}, describeError: String, reportActionFact: async () => {},
    retrySave, needsFormulaRefresh, wroteFormula,
    newIdempotencyKey: () => 'paste-1', setSaveState: () => {}, renderSaveBar: () => {},
    refreshAppendedRows: async () => false, rebuildAfterStructure: async () => {}, loadPage: async () => [],
    exportCapabilities: {canStructure: true}, inlineControllers: new Map(),
    grid: {
      getSelection: () => ({rowIndex: 0, colIndex: 0}), recalcAutoHeights: () => {},
      setRowValue: (...args: any[]) => painted.push(args),
    },
    refreshLoadedFormulaValues: async () => {
      // 产品的重读链路：服务端读回 → 画新值 → 重画待保存输入（applyRows 里就是这么做的）。
      painted.push([0, '合计', serverValue]);
      ctx.paintPendingInputs();
    },
    // ★ 合并说明（2026-10-21）：合并后 writeRange 多了一句「还有保存/列宽/文件操作没核实 ⇒ 不许粘贴」
    //   （fast 那边的闸）。这三个是**挂载函数的闭包变量**，沙箱只执行单个函数时取不到 ⇒ 补上
    //   （不改生产代码，也不改这条判据要验的事：那一格最后画的是计算值）。
    pending: new Map(), pendingWidths: new Map(), pendingFileOperations: new Map(),
    // ⚠️ `decideExtendWrite` 是 main.ts 的**顶层 import**（越界写入那道闸）——
    //   片段在真代码里用的是真的那个，这里补上**真的那个**（公共件里的纯函数）。
    decideExtendWrite,
    // ⚠️ `rowBehaviors` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 837 行）——
    //   抽出来的 `writeRange` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError
    //   （异常在「重读公式值」之前抛出 ⇒ 算出来的值根本没画上）。
    //   沙箱补上产品的「没有业务行行为」那个值（null）。
    rowBehaviors: null,
  };
  ctx.paintPendingInputs = actualMainFunction('paintPendingInputs', ctx);
  ctx.writeRange = actualMainFunction('writeRange', ctx);
  return {ctx, input, painted, run: () => ctx.writeRange([['=SUM(B2:B4)']], 0, 0, input)};
}

test('写进公式后界面显示服务端算出的值：测试通过 = 那一格最后画的是计算值，不是公式文本', async () => {
  const t = formulaInputHarness(138.65);
  await t.run();
  const last = t.painted.filter(entry => entry[1] === '合计').pop();
  assert.ok(last, '这一格必须被画过一次');
  assert.equal(last[2], 138.65,
    '重读回来的计算值必须留在界面上；被「待保存输入」的本地回显盖回公式文本 = 用户看不到算出来的数');
  assert.ok(!t.painted.some(entry => entry[1] === '合计' && entry[2] === '=SUM(B2:B4)'),
    '公式文本不能作为该格最终显示值');
});
