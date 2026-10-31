import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionRange} from '../../../shangshu-web/js/domains/excel-univer/src/selection.ts';
test('Univer 1.0.3 FSelection按官方activeRange读取，不把所有选区当A1',()=>{
 assert.deepEqual(selectionRange({getActiveRange:()=>({getRange:()=>({startRow:4,endRow:6,startColumn:1,endColumn:3})})}),
   {startRow:4,endRow:6,startCol:1,endCol:3});
});
test('空/损坏/多块选区不猜位置，单块旧结构兼容',()=>{
 assert.equal(selectionRange(null),null);assert.equal(selectionRange({}),null);
 assert.equal(selectionRange({getActiveRangeList:()=>[{},{}],getActiveRange:()=>({getRange:()=>({startRow:0,startColumn:0})})}),null);
 assert.deepEqual(selectionRange([{range:{startRow:2,endRow:1,startColumn:3,endColumn:1}}]),{startRow:1,endRow:2,startCol:1,endCol:3});
});
