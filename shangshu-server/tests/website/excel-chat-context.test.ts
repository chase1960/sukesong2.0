/**
 * FIX-03（2026-10-19 A16）：Excel 页必须把「用户开着哪张表」告诉助手。
 *
 * 测试通过 = 什么成立：
 * - 开表后，助手上下文里**有这张表的 ID 与表名**（以前 Excel 域一个都不发）；
 * - 换表后上下文**跟着换**（不会还挂着上一张表）；
 * - 上下文里带**当前选区**（用户问「这一格」时助手能定位）；
 * - 回清单时上下文变成**清单级**（用户没开表，助手不许自己挑一张）；
 * - 上下文里**不含整张表**（不把整表塞给模型）；
 *   ⚠️ 2026-10-21 口径更新：上下文**要**带**当前选区里那几格**（行名 · 列名 · 值）——
 *     「不含表格内容」改成「不含整张表」，判据同步改成「只带选区里看得见的那几格」。
 * - 服务端白名单与模型提示词**认**这两个新字段（sheet / selection）。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildListContext,buildTableContext,selectionLabel} from '../../../shangshu-web/js/domains/excel-univer/src/chat-context.ts';
import {setup,settled} from './excel-mount-harness.ts';

test('FIX-03 开表后助手上报这张表的 ID、表名与工作表', async () => {
  const h = setup({sheetTitle:'库存'});
  try {
    await h.mountPage();
    assert.ok(h.contexts.length > 0, '开表必须报一次助手上下文');
    const last = h.contexts.at(-1)!;
    assert.equal(last.module, 'excel');
    assert.equal(last.view, 'table');
    assert.equal(last.entity_id, 'one', '上下文要带表 ID（助手读表时按它传 table）');
    assert.equal(last.label, 'one', '上下文要带表名');
    assert.equal(last.entity_type, 'files.file', '文件表要报成文件，助手才知道去读文件');
    assert.equal(last.sheet, '库存', '上下文要带当前工作表');
    assert.match(last.editable_scope, /表 ID：one/, '上下文里要写明表 ID');
    assert.match(last.editable_scope, /确认/, '写操作必须要求确认');
  } finally { h.close(); }
});

test('FIX-03 换表后上下文跟着换，不挂着上一张表', async () => {
  const h = setup();
  try {
    const api = await h.mountPage();
    await api.openTableByKey('two');
    await settled(() => h.contexts.at(-1)?.entity_id === 'two', h.errors);
    const last = h.contexts.at(-1)!;
    assert.equal(last.entity_id, 'two');
    assert.equal(last.label, 'two');
  } finally { h.close(); }
});

test('FIX-03 上下文带当前选区，且只带选区里那几格（不带整张表）', async () => {
  const h = setup();
  try {
    await h.mountPage();
    const last = h.contexts.at(-1)!;
    assert.equal(last.selection, 'A2', '第 1 行数据在表里是第 2 行（表头占第 1 行）');
    assert.equal(last.rows, undefined, '不能把整张表塞进上下文');
    assert.equal(last.values, undefined, '不能把整张表塞进上下文');
    /* 2026-10-21 起口径变了：上下文**要**带当前选区里那几格的内容
       （用户原话：要有这个格子或几个格子的行名、列名与值）——
       但**只带选区里看得见的那几格**，不带整张表（不许 rows/values 那种整表结构）。 */
    assert.ok(last.content, '要带选区那几格的内容');
    assert.equal(last.content.kind, 'cells');
    assert.match(last.content.text, /行「one-r1」/, '要带行名');
    assert.match(last.content.text, /列「C1」/, '要带列名');
    assert.match(last.content.text, /= 原值/, '要带格子的值');
    assert.equal((last.content as any).rows, undefined, '内容段里也不许塞整表');
  } finally { h.close(); }
});

test('FIX-03 回清单时上下文换成清单级，不带任何表 ID', async () => {
  const h = setup();
  try {
    await h.mountPage();
    h.context.excelPageDiag; // 挂载已完成
    const list = buildListContext();
    assert.equal(list.entity_type, 'page', '清单级上下文要让助手知道「没开表」');
    assert.equal(list.view, 'file-list');
    assert.match(list.editable_scope, /不要自己挑一张/, '清单级上下文要禁止助手乱挑表');
  } finally { h.close(); }
});

test('FIX-03 选区换算：单元格与区域都用表里那套坐标', () => {
  assert.equal(selectionLabel({startRow: 0, startCol: 0, endRow: 0, endCol: 0}), 'A2');
  assert.equal(selectionLabel({startRow: 1, startCol: 1, endRow: 4, endCol: 3}), 'B3:D6');
  assert.equal(selectionLabel({startRow: 0, startCol: 25, endRow: 0, endCol: 25}), 'Z2');
  assert.equal(selectionLabel({startRow: 0, startCol: 26, endRow: 0, endCol: 26}), 'AA2');
  assert.equal(selectionLabel(null), '');
});

test('FIX-03 业务表与文件表报的对象类型不同', () => {
  const file = buildTableContext({key: 'FILE-1', title: '库存表', kind: 'xlsx'});
  const object = buildTableContext({key: 'shangshu-stock-item', title: '存货', kind: 'db'});
  assert.equal(file!.entity_type, 'files.file');
  assert.equal(object!.entity_type, 'object');
  assert.equal(buildTableContext(null), null, '没有表就不报表上下文');
});

test('FIX-03 服务端白名单与模型提示词认这两个新字段', () => {
  const server = readFileSync(new URL('../../src/adapters/web/server.ts', import.meta.url), 'utf8');
  assert.match(server, /sheet: String\(rawUi\.sheet/, '服务端白名单要放行工作表名');
  assert.match(server, /selection: String\(rawUi\.selection/, '服务端白名单要放行选区');
  const chat = readFileSync(new URL('../../src/core/chat.ts', import.meta.url), 'utf8');
  assert.match(chat, /工作表=\$\{uiContext\.sheet/, '模型提示词要带上工作表');
  assert.match(chat, /当前选区=\$\{uiContext\.selection/, '模型提示词要带上选区');
});
