import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/sheet.ts',import.meta.url),'utf8');
// Exercise the production page-install functions without mounting a second browser/runtime.
function harness(){
 const calls=[],known=new Map(),knownTypes=new Map(),knownStyles=new Map(),lastWidths=new Map();
 const context={formulas:new Map(),Map,Object,Array,Number,Error,known,knownTypes,knownStyles,lastWidths,columns:[{fieldId:'id',type:'text'},{fieldId:'fee',type:'decimal'}],rowCount:15600,columnCount:4,isProgrammaticUpdate:false,applyingWidths:0,selectionHandlers:[()=>calls.push(['selection'])],activeCellPosition:()=>({rowIndex:0}),toText:v=>v==null?'':String(v),cellFor:(raw,column,type,font)=>({v:raw,t:typeof raw==='number'?2:1,s:font}),recalcLoadedHeights:()=>calls.push(['heights']),worksheet:()=>({getRange:()=>({setValues:matrix=>{calls.push(['values',matrix]);if(context.fail)throw Error('install failed');}}),setColumnWidths:(...args)=>calls.push(['widths',...args])})};
 const start=source.indexOf('  function setRows(rows:GridRowInput[])');
 const end=source.indexOf('\n  return {\n    setRows,',start);
 vm.createContext(context);vm.runInContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {context,calls,known};
}
test('100 loaded rows produce one sparse value command with types/styles and no gap materialization',()=>{
 const {context,calls,known}=harness();
 context.setRows(Array.from({length:100},(_,i)=>({rowIndex:15000+i,values:['00123',800+i],cellTypes:['text','decimal'],cellStyles:[{bold:true},undefined]})));
 assert.equal(calls.filter(c=>c[0]==='values').length,1);
 const matrix=calls[0][1];assert.equal(Object.keys(matrix).length,100);assert.equal(matrix[0],undefined);
 assert.equal(matrix[15000][0].v,'00123');assert.equal(matrix[15000][1].v,800);assert.equal(matrix[15000][0].s.bold,true);
 assert.equal(known.get(15000).get('id'),'00123');assert.equal(Object.keys(matrix[15000]).length,4);
});
test('failed install does not overwrite edit/undo original values',()=>{
 const {context,known}=harness();known.set(0,new Map([['id','old']]));context.fail=true;
 assert.throws(()=>context.setRows([{rowIndex:0,values:['new',1]}]),/install failed/);
 assert.equal(known.get(0).get('id'),'old');assert.equal(context.isProgrammaticUpdate,false);
});
test('programmatic widths group adjacent equal widths, recalc once, repeat is no-op',()=>{
 const {context,calls}=harness();const widths=[{colIndex:0,width:120},{colIndex:1,width:120},{colIndex:2,width:180}];
 context.setColumnWidths(widths);assert.equal(calls.filter(c=>c[0]==='widths').length,2);assert.equal(calls.filter(c=>c[0]==='heights').length,1);
 assert.deepEqual(Array.from(calls[0]),['widths',0,2,120]);const count=calls.length;context.setColumnWidths(widths);assert.equal(calls.length,count);assert.equal(context.applyingWidths,0);
});
test('formula source stays separate from canvas official value and failed redraw preserves source',()=>{
 const {context,calls}=harness();context.setRows([{rowIndex:0,values:[1700,12],cellTypes:['formula','number'],formulas:['=SUM(B2:B3)',undefined]}]);
 const matrix=calls.find(row=>row[0]==='values')[1];assert.equal(matrix[0][0].v,1700);assert.equal(matrix[0][0].f,undefined);assert.equal(context.formulas.get(0).get('id'),'=SUM(B2:B3)');
 context.fail=true;assert.throws(()=>context.setRows([{rowIndex:0,values:[900,12],formulas:['=B2',undefined]}]),/install failed/);assert.equal(context.formulas.get(0).get('id'),'=SUM(B2:B3)');
});
