import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {needsFormulaRefresh} from '../src/formula-values.ts';
import {decideExtendWrite} from '../src/write-gate.ts';
import {retrySave} from '../src/save-retry.ts';
const src=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',src,ts.ScriptTarget.Latest,true);let fn,paint;
function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='writeRange')fn=n.getText(ast);if(ts.isFunctionDeclaration(n)&&n.name?.text==='paintPendingInputs')paint=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(fn);assert.ok(paint);
function harness({expand=false,structure=true,reused=false,hasFormulas=false}={}){
 const calls=[];const table={kind:'xlsx',writable:true};
 // ★ 2026-10-24：main.ts 的 writeRange 新增「保存浮层」的兄弟函数
 // （showSaveOverlay / hideSaveOverlay，main.ts:1058-1065，按一个计数器进出）。
 // 判据的沙箱原来没给 ⇒ **ReferenceError: showSaveOverlay is not defined**。
 // 这里**照产品同一口径**建一个计数浮层：进一次 +1、出一次 -1、回到 0 才隐藏 ——
 // 这样判据能真的验「粘贴完不留一层没关掉的模态」。
 let saveOverlayCount=0;const saveOverlay={hidden:true};
 const result={hasFormulas,cells:[],headers:expand?['a','b']:['a'],rowsAdded:0,colsAdded:expand?1:0,structureVersion:1,actionCount:1,savedView:{}};
 for(const method of ['pasteApply','inputWrite'])table[method]=async p=>{calls.push([method,p]);return result;};
 table.canStructure=structure;
 const c={rowBehaviors:{refresh:async()=>calls.push(['domain-refresh']),cellsChanged:()=>{}},decideExtendWrite,needsFormulaRefresh,refreshLoadedFormulaValues:async()=>calls.push(['formula-refresh']),retrySave,table,disposed:false,openingTable:false,pasteApplying:false,pendingInput:null,inputQueue:[],exportCapabilities:{canStructure:structure},columns:[{fieldId:'a',type:'text'}],totalRows:1,filled:new Set([0]),inlineControllers:new Map(),nameToIndex:new Map(),pageCache:new Map(),undoStack:[],PAGE_LENGTH:100,hasUnsaved:()=>false,newIdempotencyKey:()=> 'key',notify:(...v)=>calls.push(['notice',...v]),setSaveState:(...v)=>calls.push(['state',...v]),updateToolbar:()=>{},renderSaveBar:()=>{},el:{scope:{},saveOverlay},showSaveOverlay:()=>{saveOverlayCount++;saveOverlay.hidden=false;},hideSaveOverlay:()=>{saveOverlayCount=Math.max(0,saveOverlayCount-1);if(saveOverlayCount===0)saveOverlay.hidden=true;},reportActionFact:async()=>{},describeError:v=>v,refreshAppendedRows:async()=>reused,rebuildAfterStructure:async()=>{},loadPage:async()=>[],grid:{getSelection:()=>({rowIndex:expand?1:0,colIndex:expand?1:0}),scrollToRow:(...v)=>calls.push(['scroll',...v]),selectCell:(...v)=>calls.push(['select',...v]),recalcAutoHeights:()=>{}},
  // ★ 2026-10-24：main.ts 的 writeRange 新增「有未完成保存就挡住粘贴」的守卫
  // （pending / pendingWidths / pendingFileOperations 三个待办登记表）。
  // 判据的沙箱原来没给这三个 ⇒ **ReferenceError: pending is not defined**（6 条全红）。
  // 这里是**主表里的同名兄弟**，不是替身：判据要测的仍然是「没有待办时粘贴直接存下去」。
  pending:new Map(),pendingWidths:new Map(),pendingFileOperations:new Map()};
 vm.createContext(c);vm.runInContext(ts.transpileModule(paint+"\n"+fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);return {c,calls,table};
}
test('ordinary paste saves without modal or per-cell/action success toast',async()=>{const {c,calls}=harness();await c.writeRange([['00123']]);assert.equal(calls.filter(x=>x[0]==='pasteApply').length,1);assert.equal(calls.filter(x=>x[0]==='notice').length,0);
  // ★ 2026-10-24 补：产品按计数进出保存浮层 ⇒ 粘贴完**不许留下一层没关掉的模态**。
  assert.equal(c.el.saveOverlay.hidden,true,'粘贴完还留着保存浮层');});
test('有没完成的保存时，粘贴被挡住并说清原因（不许把新内容混进未核实的队列）',async()=>{const {c,calls}=harness();c.pending.set('op-1',{});
  await c.writeRange([['00123']]);
  assert.equal(calls.filter(x=>x[0]==='pasteApply').length,0,'有未完成保存时还把粘贴发出去了');
  assert.match(calls.find(x=>x[0]==='notice')[1],/已有保存/,'没告诉人为什么被挡住');});
test('extended input preserves native Enter next-row position across rebuild',async()=>{const {c,calls,table}=harness({expand:true});const input={key:'input-1',target:table};await c.writeRange([['00123']],0,1,input);assert.equal(calls.filter(x=>x[0]==='inputWrite').length,1);assert.deepEqual(calls.find(x=>x[0]==='select'),['select',1,1]);assert.equal(c.pendingInput,null);assert.equal(input.state,'saved');assert.equal(calls.filter(x=>x[0]==='notice').length,0);});
test('edit-only sharing rejects expansion before request but allows existing cells',async()=>{const {c,calls}=harness({expand:true,structure:false});await c.writeRange([['x']],0,1);assert.equal(calls.filter(x=>x[0]==='pasteApply').length,0);assert.match(calls.find(x=>x[0]==='notice')[1],/结构编辑权限/);const existing=harness({structure:false});await existing.c.writeRange([['x']],0,0);assert.equal(existing.calls.filter(x=>x[0]==='pasteApply').length,1);});

test('in-place extension does not override native selection',async()=>{const {c,calls,table}=harness({expand:true,reused:true});await c.writeRange([['x']],0,1,{key:'input-2',target:table});assert.equal(calls.filter(x=>x[0]==='select').length,0);});

test('formula dependency save refreshes loaded ranges while ordinary large-table save adds no refresh',async()=>{for(const hasFormulas of [false,true]){const {c,calls}=harness({hasFormulas});await c.writeRange([['12']]);assert.equal(calls.filter(row=>row[0]==='formula-refresh').length,hasFormulas?1:0);}});
test('formula matrix bypasses numeric literal precheck and preserves formula kind into inputWrite',async()=>{const {c,calls,table}=harness({hasFormulas:true});c.columns=[{fieldId:'a',label:'金额',type:'decimal'}];await c.writeRange([['=SUM(B2:B3)+1']],0,0,{key:'formula-input',target:table});const request=calls.find(row=>row[0]==='inputWrite');assert.ok(request);assert.equal(request[1].matrixTypes[0][0],'formula');assert.equal(calls.filter(row=>row[0]==='notice').length,0);});

test('committed paste with failed repaint does not lock later cell edits',async()=>{
 const {c,calls}=harness();
 c.grid.recalcAutoHeights=()=>{throw Error('render failed');};
 await c.writeRange([['x']],0,0);
 assert.equal(c.pendingFileOperations.size,0,'已确认保存的粘贴不能重新登记成未完成写入');
 assert.equal(c.pasteApplying,false);
 assert.equal(c.el.saveOverlay.hidden,true);
 assert.match(calls.find(x=>x[0]==='notice')[1],/已保存/);
});

test('batch paste never opens a saving modal while the request is pending',async()=>{const {c,table}=harness();let finish;table.pasteApply=()=>new Promise(resolve=>{finish=resolve;});const task=c.writeRange([['a'],['b']]);assert.equal(c.el.saveOverlay.hidden,true);finish({cells:[],headers:['a'],rowsAdded:0,colsAdded:0,structureVersion:1,actionCount:1});await task;assert.equal(c.el.saveOverlay.hidden,true);});

test('paste expansion preserves the live viewport and selection instead of jumping to paste origin',async()=>{
 const {c,calls}=harness({expand:true});
 const live={range:{startRow:7,endRow:8,startCol:5,endCol:6},scroll:{sheetViewStartRow:4,sheetViewStartColumn:3,offsetX:12,offsetY:5}};
 c.grid.getViewState=()=>live;c.grid.restoreViewState=(v)=>calls.push(['restore-view',v]);
 await c.writeRange([['x']],0,1);
 assert.equal(calls.some(v=>v[0]==='scroll'),false,'粘贴保存后不应强行滚回起点');
 assert.equal(calls.find(v=>v[0]==='restore-view')?.[1],live);
});
