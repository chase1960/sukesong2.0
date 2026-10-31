import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseClipboardTsv,serializeClipboardTsv} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';

test('Excel/WPS带引号的换行和制表符仍是一个单元格，前导零不变',()=>{
  assert.deepEqual(parseClipboardTsv('客户\t备注\r\n00123\t"首行\n次行\t说明"\r\n'),
    [['客户','备注'],['00123','首行\n次行\t说明']]);
});
test('只去终止符的虚拟行，保留实际空行、空尾格及引号',()=>{
  assert.deepEqual(parseClipboardTsv('"a""b"\t\r\n\r\n'),[['a"b',''],['','']]);
  assert.deepEqual(parseClipboardTsv('""'),[['']]);
});
test('复制再粘贴原矩阵不拆格、不推断类型',()=>{
  const rows=[['00123','2026-10-20','多行\n文本'],['=不是业务规则','"双引号"','尾格\t']];
  assert.deepEqual(parseClipboardTsv(serializeClipboardTsv(rows)),rows);
});
test('损坏的引用明确拒绝，不能把截断内容保存为成功',()=>{
  for(const value of ['"没闭合','"已闭合"多余'])assert.throws(()=>parseClipboardTsv(value),/引号/);
});
test('生产表格粘贴和复制都接通同一个TSV编解码，复制不劫持文本编辑器',()=>{
  const code=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts',import.meta.url),'utf8');
  assert.match(code,/parseClipboardTsv\(text\)/);
  assert.match(code,/serializeClipboardTsv\(rows\)/);
  assert.match(code,/if \(!table \|\| !grid \|\| grid\.isEditing\(\)\) return/);
  assert.match(code,/removeEventListener\('copy', handleCopy, true\)/);
});
