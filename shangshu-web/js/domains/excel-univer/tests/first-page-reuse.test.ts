import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openTable, getRowViewMetadata} from '../src/backend.ts';
import type {SheetReadResult} from '../src/adapter.ts';
import type {PersonalViewResult} from '../src/personal-view.ts';

// 只替换 HTTP 边界：开表、个人视图、分页和类型/格式解码都运行生产代码。
async function fixture(run: (ctx: {
  sheet: SheetReadResult;
  view: PersonalViewResult;
  reads: Array<{page: number; page_length: number; row_ids?: string[]}>;
}) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const reads: Array<{page: number; page_length: number; row_ids?: string[]}> = [];
  const sheet: SheetReadResult = {
    table: 'first-page-table', table_title: '首次开表', sheet: 'sheet-1', sheet_title: 'Sheet1',
    content_version: 7, structure_version: 3, headers: ['名称'], writable: true,
    readonly_columns: [], column_widths: {}, column_width_unit: 'excel-char', total_rows: 205,
    rows: Array.from({length: 205}, (_, index) => ({
      row_id: `row-${index + 1}`, row_index: index + 2, record_version: `record-v${index + 1}`,
      values: {名称: {type: 'text', value: `值-${index + 1}`}},
      styles: {名称: {bold: true}},
    })),
  };
  const view: PersonalViewResult = {
    revision: 0, view: {filters: [], freeze: {rows: 0, columns: 0}},
    rows: sheet.rows.map(row => ({row_id: row.row_id, row_index: row.row_index!})),
    total_rows: 205, source_total_rows: 205, content_version: 7, structure_version: 3,
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path === '/api/platform/objects') return Response.json({list: []});
    if (path.startsWith('/api/platform/services/files.sheet_view_read/invoke?')) return Response.json(view);
    if (path.startsWith('/api/platform/services/files.sheet_read/invoke?')) {
      const request = JSON.parse(new URL(path,'http://test').searchParams.get('payload')!);
      reads.push(request);
      // row_ids 读口按物理顺序返回；前端必须按个人视图重新排列。
      const rows = request.row_ids
        ? sheet.rows.filter(row => request.row_ids.includes(row.row_id))
        : sheet.rows.slice((request.page - 1) * request.page_length, request.page * request.page_length);
      return Response.json({...sheet, rows});
    }
    throw Error(`不应调用的接口：${path}`);
  };
  try { await run({sheet, view, reads}); }
  finally { globalThis.fetch = previousFetch; }
}

test('默认首次开表只读一次首页，保留值与格式；翻页和后续刷新仍读取', () => fixture(async ({reads}) => {
  const table = await openTable('first-page-table',undefined,'xlsx');
  await table.loadPersonalView!();
  const first = await table.loadPage(1, 100);
  assert.equal(reads.length, 1, '默认开表不应在个人视图加载后再读同一首页');
  assert.equal(first.total, 205);
  assert.equal(first.rows.length, 100);
  assert.equal(first.rows[0].name, 'row-1');
  assert.equal(first.rows[0]['名称'], '值-1');
  assert.equal(getRowViewMetadata(first.rows[0])?.styles?.['名称']?.bold, true);
  const second = await table.loadPage(2, 100);
  assert.equal(reads.length, 2);
  assert.equal(second.rows[0].name, 'row-101');
  assert.equal(second.total, 205);
  await table.loadPage(1, 100);
  assert.equal(reads.length, 3, '首屏缓存只能消费一次，不能代替以后刷新');
}));

test('个人排序重新读取正确行，不能用原始首页冒充排序结果', () => fixture(async ({view, reads}) => {
  view.view.sort = {column: '名称', direction: 'desc'};
  view.rows.reverse();
  const table = await openTable('first-page-table',undefined,'xlsx');
  await table.loadPersonalView!();
  const page = await table.loadPage(1, 100);
  assert.equal(reads.length, 2);
  assert.deepEqual(page.rows.map(row => row.name), view.rows.slice(0, 100).map(row => row.row_id));
  assert.equal(page.total, 205);
}));

test('个人筛选保持命中总数和分页，不复用原始首页', () => fixture(async ({view, reads}) => {
  view.view.filters = [{column: '名称', operator: 'contains', value: '测试命中'}];
  view.rows = [view.rows[149], view.rows[169], view.rows[199]];
  view.total_rows = 3;
  const table = await openTable('first-page-table',undefined,'xlsx');
  await table.loadPersonalView!();
  const first = await table.loadPage(1, 2);
  const second = await table.loadPage(2, 2);
  assert.equal(reads.length, 3);
  assert.deepEqual(first.rows.map(row => row.name), ['row-150', 'row-170']);
  assert.deepEqual(second.rows.map(row => row.name), ['row-200']);
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
}));

test('筛选恰好命中全表也重新读取，不把它当成默认视图', () => fixture(async ({view, reads}) => {
  view.view.filters = [{column: '名称', operator: 'not_empty', value: ''}];
  const table = await openTable('first-page-table',undefined,'xlsx');
  await table.loadPersonalView!();
  await table.loadPage(1, 100);
  assert.equal(reads.length, 2);
}));

for (const version of ['content_version', 'structure_version'] as const) {
  test(`载入个人视图时 ${version} 已变化，必须读取新首页`, () => fixture(async ({sheet, view, reads}) => {
    const table = await openTable('first-page-table',undefined,'xlsx');
    sheet[version] += 1;
    view[version] = sheet[version];
    sheet.rows[0].values['名称'] = {type: 'text', value: '新版本值'};
    await table.loadPersonalView!();
    const page = await table.loadPage(1, 100);
    assert.equal(reads.length, 2);
    assert.equal(page.rows[0]['名称'], '新版本值');
  }));
}

test('无个人排序但行身份顺序改变时不复用旧页', () => fixture(async ({view, reads}) => {
  const table = await openTable('first-page-table',undefined,'xlsx');
  [view.rows[0], view.rows[1]] = [view.rows[1], view.rows[0]];
  await table.loadPersonalView!();
  const page = await table.loadPage(1, 100);
  assert.equal(reads.length, 2);
  assert.deepEqual(page.rows.slice(0, 2).map(row => row.name), ['row-2', 'row-1']);
}));

test('视图总数改变时不复用旧页，总数取已核实的个人视图', () => fixture(async ({view, reads}) => {
  const table = await openTable('first-page-table',undefined,'xlsx');
  view.rows.pop(); view.total_rows -= 1;
  await table.loadPersonalView!();
  const page = await table.loadPage(1, 100);
  assert.equal(reads.length, 2);
  assert.equal(page.total, 204);
}));

test('未载入个人视图但版本被推进时，也不能消费旧的首次读取', () => fixture(async ({sheet, reads}) => {
  const table = await openTable('first-page-table',undefined,'xlsx');
  sheet.content_version += 1;
  sheet.rows[0].values['名称'] = {type: 'text', value: '回执后的新值'};
  table.adoptVersions!({contentVersion: sheet.content_version});
  const page = await table.loadPage(1, 100);
  assert.equal(reads.length, 2);
  assert.equal(page.rows[0]['名称'], '回执后的新值');
}));
