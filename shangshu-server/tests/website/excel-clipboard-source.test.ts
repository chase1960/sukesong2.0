/**
 * 第六批：复制源必须和粘贴目标是**同一张表**。
 *
 * 起因（真缺陷）：服务端 files.sheet_paste_special 只按**坐标**从「当前这张表」取源
 * —— 源码 sheet.py 的 paste_special 写着「源区域与目标区域都在这张表里」，
 * 载荷里也只有 source_row / source_col，没有表身份。
 * 而前端的复制源是闭包里的隐藏状态、换表不复位：
 * 在 A 表复制一块 → 切到 B 表 → 点选择性粘贴 → 面板还显示「源：A1:B2（你刚复制的那块）」，
 * 服务端却从 **B 表**按同一坐标取源 —— **不报错**，直接把 B 表的数据粘过去。
 *
 * 测试通过 = 什么成立：
 * ① 复制时记下「源属于哪张表」；
 * ② 换表后复制源失效（同一张表重开不算换表，源要留着）；
 * ③ 源在另一张表时，选择性粘贴面板**不打开**，并用中文说清为什么；
 * ④ 同一张表时照常打开（不能把正常用法也堵了）。
 */
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import * as clipboard from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-toolbar.ts';
import {functionSource} from './source-extract.ts';

const MAIN = readFileSync(
  new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts', import.meta.url), 'utf8');

/** 跨表判定规则（clipboard-toolbar 里的那一份）。缺了就报错，不静默当「同表」。 */
const copiedSourceMatchesTable: (source: string | null, current: string | null) => boolean =
  (clipboard as any).copiedSourceMatchesTable
  ?? (() => { throw Error('clipboard-toolbar 里还没有 copiedSourceMatchesTable（跨表判定规则）'); });

/** 把几个生产函数抽出来放进同一个脚本里跑（跑的是产品码，不是抄一遍的实现）。 */
function runProduction(names: string[]): string {
  return ts.transpileModule(names.map(name => functionSource(MAIN, name)).join('\n'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
}

/** 造一个「选择性粘贴面板」的运行环境，返回对话框与提示语的收集口。 */
function panelHarness(tableKey: string, copiedTableKey: string) {
  const dom = new JSDOM('<div id="host"></div>');
  const dialogs: any[] = [];
  const notices: string[] = [];
  const context: any = {
    document: dom.window.document,
    ui: {dialog: (options: any) => dialogs.push(options), closeModal: () => {}},
    table: {key: tableKey, writable: true},
    grid: {getSelectionRange: () => ({startRow: 5, startCol: 0, endRow: 5, endCol: 0})},
    hasUnsaved: () => false,
    notify: (message: string) => notices.push(message),
    lastCopiedRange: {startRow: 0, startCol: 0, endRow: 1, endCol: 1},
    lastCopiedTableKey: copiedTableKey,
    describeRange: (range: any) => `R${range.startRow}C${range.startCol}`,
    copiedSourceMatchesTable,
  };
  vm.createContext(context);
  vm.runInContext(runProduction(['openPasteSpecialPanel', 'bulkSection', 'bulkChoice', 'bulkCheck', 'bulkNote']), context);
  return {context, dialogs, notices};
}

it('第六批 复制时记下「源属于哪张表」', () => {
  const copyAt = MAIN.indexOf('lastCopiedRange={');
  assert.ok(copyAt > 0, '复制监听里应当给 lastCopiedRange 赋值');
  const copyBlock = MAIN.slice(copyAt, copyAt + 260);
  assert.match(copyBlock, /lastCopiedTableKey\s*=\s*table\?\.key/,
    '复制时要把「源属于哪张表」一起记下来，否则换表后分不清源是哪张表的');
});

it('第六批 换表后复制源失效；同一张表重开源还在', () => {
  const forgetCode = runProduction(['forgetCopiedSource']);
  assert.match(forgetCode, /lastCopiedRange\s*=\s*null/, '换表要把复制区域清掉');
  assert.match(forgetCode, /lastCopiedTableKey\s*=\s*null/, '换表要把源属于哪张表也清掉');
  const context: any = {
    lastCopiedRange: {startRow: 0, startCol: 0, endRow: 1, endCol: 1},
    lastCopiedTableKey: 'table-a',
  };
  vm.createContext(context);
  vm.runInContext(forgetCode, context);
  context.forgetCopiedSource(true);
  assert.deepEqual(context.lastCopiedRange, {startRow: 0, startCol: 0, endRow: 1, endCol: 1},
    '同一张表重开，复制源应当还在');
  assert.equal(context.lastCopiedTableKey, 'table-a', '同一张表重开，源属于哪张表不变');
  context.forgetCopiedSource(false);
  assert.equal(context.lastCopiedRange, null, '换表后复制源必须清掉');
  assert.equal(context.lastCopiedTableKey, null, '换表后源属于哪张表也要清掉');
});

it('第六批 源在另一张表时不打开选择性粘贴面板，并说明原因', () => {
  const {context, dialogs, notices} = panelHarness('table-b', 'table-a');
  context.openPasteSpecialPanel();
  assert.equal(dialogs.length, 0, '源在另一张表时不能打开选择性粘贴面板（会静默粘错数据）');
  assert.equal(notices.length, 1, '要有一条中文提示说明为什么');
  assert.match(notices[0], /另一张表/, `提示要说清是跨表了，实际：${notices[0]}`);
});

it('第六批 同一张表里照常打开选择性粘贴面板', () => {
  const {context, dialogs, notices} = panelHarness('table-a', 'table-a');
  context.openPasteSpecialPanel();
  assert.equal(dialogs.length, 1, '同一张表里照常打开选择性粘贴面板');
  assert.equal(notices.length, 0, '同一张表不该有拦下提示');
});

it('第六批 跨表判定是纯规则：源表未知时不误伤', () => {
  assert.equal(typeof (clipboard as any).copiedSourceMatchesTable, 'function',
    'clipboard-toolbar 里应当有 copiedSourceMatchesTable（跨表判定规则只有一份）');
  assert.equal(copiedSourceMatchesTable('table-a', 'table-a'), true, '同一张表可以粘');
  assert.equal(copiedSourceMatchesTable('table-a', 'table-b'), false, '跨表不能粘');
  assert.equal(copiedSourceMatchesTable(null, 'table-b'), true, '源表未知时不拦下');
  assert.equal(copiedSourceMatchesTable('table-a', null), true, '当前表未知时不拦下');
});
