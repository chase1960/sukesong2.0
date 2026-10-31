import test from 'node:test';import assert from 'node:assert/strict';
import {formulaDisplay,editableFormula,needsFormulaRefresh} from '../src/formula-values.ts';
import {decodeSheetView} from '../src/adapter.ts';
test('official result displays and copies as value while editing preserves formula',()=>{
 const cell={type:'formula' as const,formula:'=SUM(B2:B3)',value:1700,result_version:4};
 assert.equal(formulaDisplay(cell),1700);assert.equal(editableFormula(cell),'=SUM(B2:B3)');
 const result=decodeSheetView({table:'F',sheet:'S',table_title:'T',content_version:4,structure_version:1,headers:['总计'],rows:[{row_id:'r1',values:{总计:cell}}],total_rows:1,writable:true,readonly_columns:[],column_widths:{},has_formulas:true} as any);
 assert.equal(result.rows[0].values.总计,1700);assert.equal(result.rows[0].typed?.总计.type,'formula');assert.equal(result.meta.hasFormulas,true);
});
test('pending never displays stale value, hidden never exposes formula or result',()=>{
 assert.equal(formulaDisplay({type:'formula',formula:'=A1',value:900,calculation_pending:true}),'待计算');
 assert.equal(formulaDisplay({type:'hidden',hidden:true,value:null}),'无权查看');assert.equal(editableFormula({type:'hidden',hidden:true,value:null}),undefined);
});
test('formula removal still refreshes; ordinary values never demand full reload',()=>{
 assert.equal(needsFormulaRefresh(false,[{type:'formula',formula:'=A1',value:1}]),true);assert.equal(needsFormulaRefresh(false,[{type:'number',value:1}]),false);
});
