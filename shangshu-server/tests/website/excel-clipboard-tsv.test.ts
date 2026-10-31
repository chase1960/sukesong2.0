import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClipboardTsv, serializeClipboardTsv } from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';

test('Excel quoted TSV preserves in-cell newline, tab, quotes and literal numeric text', () => {
  const rows = [['00123', '12.50', '甲\n乙', '左\t右', '他说"同意"', ''],
    ['00007', '2026-10-14', '甲\r\n乙', '普通值', '', '']];
  assert.deepEqual(parseClipboardTsv(serializeClipboardTsv(rows)), rows);
  assert.deepEqual(parseClipboardTsv('00123\t12.50\t"甲\n乙"\t"左\t右"\t"他说""同意"""\t\r\n'), [rows[0]]);
});

test('Only the terminal record artifact is removed; explicit empty rows and trailing cells remain', () => {
  assert.deepEqual(parseClipboardTsv('A\tB\t\r\n\t\t\r\n'), [['A', 'B', ''], ['', '', '']]);
  assert.deepEqual(parseClipboardTsv('A\r\n\r\n'), [['A'], ['']]);
  assert.deepEqual(parseClipboardTsv('A\t\t'), [['A', '', '']]);
  assert.deepEqual(parseClipboardTsv(''), []);
  assert.deepEqual(parseClipboardTsv(serializeClipboardTsv([[''], ['']])), [[''], ['']]);
});

test('Ragged values become a rectangle without trimming whitespace or guessing types', () => {
  const rows = [[' A ', '00123', ''], ['12.50'], ['', '文本"原样']];
  const expected = [[' A ', '00123', ''], ['12.50', '', ''], ['', '文本"原样', '']];
  assert.deepEqual(parseClipboardTsv(serializeClipboardTsv(rows)), expected);
  assert.deepEqual(parseClipboardTsv(' A \t00123\t\n12.50\n\t文本"原样'), expected);
});

test('Malformed quoted fields fail before any caller can paste a partial matrix', () => {
  assert.throws(() => parseClipboardTsv('good\t"unfinished\r\nnext'), /引号未闭合/);
  assert.throws(() => parseClipboardTsv('good\t"closed"garbage'), /引号闭合后/);
});

test('A deterministic mixed rectangle round-trips with all delimiter-sensitive positions intact', () => {
  const cells = ['', '00123', '12.50', '甲\n乙', '左\t右', '"双引号"', ' \r\n '];
  const rows = Array.from({ length: 21 }, (_, row) => Array.from({ length: 7 }, (_, col) => cells[(row + col) % cells.length]));
  assert.deepEqual(parseClipboardTsv(serializeClipboardTsv(rows)), rows);
});
