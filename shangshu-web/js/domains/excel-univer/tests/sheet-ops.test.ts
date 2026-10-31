import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFillSeriesPayload,
  buildFindReplacePayload,
  buildPasteSpecialPayload,
  columnLabel,
  describeRange,
  fillDirection,
  isSingleLine,
  rangeCols,
  rangeRows,
  type GridRange,
} from '../src/sheet-ops';

/**
 * 第四批：成包编辑的前端纯逻辑（查找替换 / 填充序列 / 选择性粘贴）。
 * 判据（对用户看得见的现象）：
 *  ① 范围算得对：几行几列、往哪边填、区域标签是人话（A1、B2:C4）；
 *  ② 跨多行多列的选区**当场挡住**并给中文提示（不当成能填）；
 *  ③ 三种载荷字段名与服务端动作 schema 一字不差（少一个字段服务端就拒）；
 *  ④ 查找内容为空**当场挡住**（不许把空查找发出去做全表清空）。
 */
const range = (startRow: number, startCol: number, endRow: number, endCol: number): GridRange =>
  ({ startRow, startCol, endRow, endCol });

test('范围算得对：几行几列', () => {
  assert.equal(rangeRows(range(0, 0, 4, 0)), 5);
  assert.equal(rangeCols(range(0, 0, 4, 0)), 1);
  assert.equal(rangeRows(range(2, 1, 2, 3)), 1);
  assert.equal(rangeCols(range(2, 1, 2, 3)), 3);
});

test('填充方向：一列往下，一行往右', () => {
  assert.equal(fillDirection(range(0, 0, 4, 0)), 'down');
  assert.equal(fillDirection(range(0, 0, 0, 4)), 'right');
});

test('跨多行多列的选区不算「一列或一行」', () => {
  assert.equal(isSingleLine(range(0, 0, 4, 0)), true);
  assert.equal(isSingleLine(range(0, 0, 0, 4)), true);
  assert.equal(isSingleLine(range(0, 0, 4, 4)), false);
});

test('填充跨多行多列时当场挡住并给中文提示', () => {
  assert.throws(
    () => buildFillSeriesPayload(range(0, 0, 4, 4), { seriesType: 'linear', unit: 'day' }),
    /一列或一行/,
  );
});

test('列名按 Excel 的规则：A、Z、AA', () => {
  assert.equal(columnLabel(0), 'A');
  assert.equal(columnLabel(25), 'Z');
  assert.equal(columnLabel(26), 'AA');
  assert.equal(columnLabel(27), 'AB');
});

test('区域标签是人话：单格 A1，区域 B2:C4', () => {
  assert.equal(describeRange(range(0, 0, 0, 0)), 'A1');
  assert.equal(describeRange(range(1, 1, 3, 2)), 'B2:C4');
});

test('查找替换载荷：查找/替换/两个开关都在', () => {
  const payload = buildFindReplacePayload({ find: '甲', replace: '乙', matchCase: true, wholeCell: false });
  assert.deepEqual(payload, { find: '甲', replace: '乙', match_case: true, whole_cell: false });
});

test('查找内容为空当场挡住（不许发全表清空）', () => {
  assert.throws(
    () => buildFindReplacePayload({ find: '', replace: '乙', matchCase: false, wholeCell: false }),
    /查找的内容/,
  );
});

test('填充载荷：范围、方式、步长、单位都对得上服务端字段名', () => {
  const payload = buildFillSeriesPayload(range(1, 0, 5, 0), {
    seriesType: 'date',
    step: 2,
    unit: 'month',
    stopValue: '2026-12-31',
  });
  assert.equal(payload.start_row, 1);
  assert.equal(payload.start_col, 0);
  assert.equal(payload.end_row, 5);
  assert.equal(payload.end_col, 0);
  assert.equal(payload.series_type, 'date');
  assert.equal(payload.step, 2);
  assert.equal(payload.unit, 'month');
  assert.equal(payload.stop_value, '2026-12-31');
});

test('列表填充带候选清单；没给步长就不发步长', () => {
  const payload = buildFillSeriesPayload(range(0, 0, 2, 0), {
    seriesType: 'list',
    unit: 'day',
    values: ['甲', '乙'],
  });
  assert.deepEqual(payload.values, ['甲', '乙']);
  assert.equal('step' in payload, false);
});

test('选择性粘贴载荷：源区域、目标区域、方式、跳过空', () => {
  const payload = buildPasteSpecialPayload(range(0, 0, 1, 1), range(4, 2, 4, 2), {
    mode: 'formats',
    skipEmpty: true,
  });
  assert.equal(payload.source_row, 0);
  assert.equal(payload.source_col, 0);
  assert.equal(payload.source_rows, 2);
  assert.equal(payload.source_cols, 2);
  assert.equal(payload.target_row, 4);
  assert.equal(payload.target_col, 2);
  assert.equal(payload.mode, 'formats');
  assert.equal(payload.skip_empty, true);
});
