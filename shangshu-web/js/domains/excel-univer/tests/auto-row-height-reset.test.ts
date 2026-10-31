/**
 * 判据：**「再点一次自动行高」的回头路**（2026-10-29 用户口径：
 * 自动行高要有一条**能退回去的路** —— 人手动拖高过的行，应该能再点一次恢复自动行高）。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「手动拖高第 3 行 ⇒ 之后的**自动行高重算不会覆盖它**（手拖的赢）；
 *   再调一次『**恢复自动行高**』⇒ 那一行**回到按内容算出来的高度**；
 *   **此后**自动行高重算**又能接管它**（内容一改，高度跟着改）。」
 *
 * ⚠️ **为什么这条判据不是「拖一下看看」**：Univer 的网格要真画布 ⇒ 判据跑不起来；
 *   而这里要验的是**行高那套账**（`manualHeights` 拦不拦自动重算、`resetAutoRowHeights` 把不把它撤掉），
 *   那是 `sheet.ts` 里两个函数自己的事 ⇒ 抽出来在 vm 里跑（同一套做法：
 *   `tests/managed-header-race.test.mjs`）。
 *
 * ⚠️ **为什么「手拖过」是照着手拖那条路的状态摆的**：
 *   `sheet.ts` 的命令监听里，手拖之后会把那一行记进 `manualHeights` **和** `appliedHeights`
 *   ⇒ 这里摆的就是那两个 Map 里的内容（不是自己另编一套）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/** 把 `sheet.ts` 里的一个函数**抽出来**（vm 里跑）。 */
function extractFunction(name: string): string {
  const source = fs.readFileSync(new URL('../src/sheet.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('sheet.ts', source, ts.ScriptTarget.Latest, true);
  let text = '';
  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(text, `sheet.ts 里找不到 ${name}`);
  return text;
}

/** 一张只有一列、一行的表；画布上的行高记在 `current` 里。 */
function gridHarness() {
  const forced: Array<{ start: number; count: number; height: number }> = [];
  /** 画布上每一行现在多高（`'auto'` ＝ 交回 Univer 自己管）。 */
  const current: Record<number, number | 'auto'> = {};
  let layoutChanges = 0;
  const known = new Map<number, Map<string, string>>();
  known.set(3, new Map([['a', 'x'.repeat(100)]]));
  const ws = {
    getColumnWidth: () => 100,
    setRowHeightsForced: (start: number, count: number, height: number) => {
      forced.push({ start, count, height });
      for (let row = start; row < start + count; row += 1) current[row] = height;
    },
    setRowAutoHeight: (row: number, count: number) => {
      for (let index = row; index < row + count; index += 1) current[index] = 'auto';
    },
  };
  const context: any = {
    worksheet: () => ws,
    known,
    knownStyles: new Map(),
    knownTypes: new Map([[3, new Map([['a', 'text']])]]),
    columns: [{ fieldId: 'a', label: '名称', type: 'text', readOnly: false }],
    manualHeights: new Map<number, number>(),
    appliedHeights: new Map<number, number>(),
    wrapped: new Set<string>(['a']),
    fontFamily: 'sans-serif',
    DEFAULT_ROW_HEIGHT: 24,
    rowCount: 10,
    // 显示值的取法（日期缩短那套跟这里无关）⇒ 给个直白的替身。
    displayCellText: (value: unknown) => String(value ?? ''),
    // 画布量字宽那套（canvas）⇒ 给个「每个字 7 像素」的替身。
    document: {
      createElement: () => ({
        getContext: () => ({
          font: '',
          measureText: (text: string) => ({ width: String(text ?? '').length * 7 }),
        }),
      }),
    },
    // 布局变了要通知上层（重画浮层那些）⇒ 这里只记个数。
    layoutChanged: () => { layoutChanges += 1; },
  };
  vm.createContext(context);
  for (const name of ['recalcLoadedHeights', 'resetAutoRowHeights']) {
    vm.runInContext(
      ts.transpileModule(extractFunction(name), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
  }
  return { context, current, forced, known, layoutChanges: () => layoutChanges };
}

test('① 手动拖高第 3 行 ⇒ 自动行高重算**不会覆盖它**', () => {
  const { context, current } = gridHarness();
  // 先按内容自动算一次（开表后的兜底）。
  context.recalcLoadedHeights();
  const autoHeight = current[3];
  assert.ok(typeof autoHeight === 'number' && autoHeight > 24,
    '自动行高没算出来（内容折行了就该更高）：%r', autoHeight);

  // —— 人手拖高第 3 行（照着手拖那条路的状态摆）——
  context.manualHeights.set(3, 60);
  context.appliedHeights.set(3, 60);
  current[3] = 60;

  // 内容变了 ⇒ 自动行高又算了一遍 ⇒ **手拖的赢**，那一行不许被覆盖。
  context.known.get(3)!.set('a', 'y'.repeat(30));
  context.recalcLoadedHeights();
  assert.equal(current[3], 60, '自动行高把手动拖的行高覆盖了：%r', current[3]);
});

test('② 再调一次『恢复自动行高』⇒ 那一行**回到按内容算出来的高度**', () => {
  const { context, current } = gridHarness();
  context.recalcLoadedHeights();
  const autoHeight = current[3];
  assert.ok(typeof autoHeight === 'number' && autoHeight > 24, '自动行高没算出来：%r', autoHeight);

  // —— 人手拖高第 3 行 ——
  context.manualHeights.set(3, 60);
  context.appliedHeights.set(3, 60);
  current[3] = 60;

  // —— 「恢复自动行高」——
  context.resetAutoRowHeights([3]);
  assert.equal(context.manualHeights.has(3), false,
    '恢复自动之后那一行还在手动名单里（自动行高再也不接管它）');
  assert.equal(current[3], autoHeight,
    '恢复自动之后那一行没回到按内容算出来的高度：%r（自动算的是 %r）', current[3], autoHeight);
});

test('③ 恢复之后，自动行高**又能接管它**（内容一改，高度跟着改）', () => {
  const { context, current } = gridHarness();
  context.recalcLoadedHeights();
  const autoHeight = current[3];

  context.manualHeights.set(3, 60);
  context.appliedHeights.set(3, 60);
  current[3] = 60;
  context.resetAutoRowHeights([3]);
  assert.equal(current[3], autoHeight, '恢复自动之后高度不对：%r', current[3]);

  // 内容变短 ⇒ 自动行高重新算 ⇒ 高度**跟着变**（说明这一行又被自动接管了）。
  context.known.get(3)!.set('a', 'y'.repeat(30));
  context.recalcLoadedHeights();
  assert.notEqual(current[3], autoHeight,
    '恢复自动之后，自动行高重算还是没接管这一行（高度没跟着内容变）：%r', current[3]);
  assert.notEqual(current[3], 60, '这一行还停在手动拖的那个高度：%r', current[3]);
});

test('④ 恢复的是**指定的行**，别的行不受影响', () => {
  const { context, current, known } = gridHarness();
  known.set(5, new Map([['a', 'x'.repeat(100)]]));
  known.get(5)!.set('a', 'x'.repeat(100));
  context.recalcLoadedHeights();
  const otherAuto = current[5];

  context.manualHeights.set(3, 60);
  context.appliedHeights.set(3, 60);
  current[3] = 60;

  context.resetAutoRowHeights([3]);
  assert.equal(current[5], otherAuto, '别的行被连坐改了：%r', current[5]);
  assert.equal(context.manualHeights.has(5), false);
});
