import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {buildStyleTargets,fontStyleToUniver,validateFontPatch,validateStyleReceipt} from '../../../shangshu-web/js/domains/excel-univer/src/font-style.ts';
import {parseClipboardTsv,serializeClipboardTsv} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';
import {retrySave} from '../../../shangshu-web/js/domains/excel-univer/src/save-retry.ts';
import {needsFormulaRefresh,wroteFormula} from '../../../shangshu-web/js/domains/excel-univer/src/formula-values.ts';
import {reviewValuesEqual} from '../../../shangshu-web/js/domains/excel-univer/src/inline-review.ts';
// ⚠️ 2026-10-30（PKG-133）：本文件把 `main.ts` 的**函数片段**抽出来在沙箱里跑
//   ⇒ 片段用到的**导入件**（main.ts 的顶层 import）与**闭包变量**沙箱里没有就会 ReferenceError。
//   按仓库里已有的先例（shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs：
//   片段用到的导入件在沙箱 context 里补上，补的是**真的那个**），这里补：
import {decideExtendWrite} from '../../../shangshu-web/js/domains/excel-univer/src/write-gate.ts';  // writeRange 的越界写入闸
import {decideLeaveTable} from '../../../shangshu-web/js/domains/excel-univer/src/save-guard.ts';    // renderSaveBar 的「能不能离开」闸
import {functionSource} from './source-extract.ts';
const engineRequire=createRequire(new URL('../../../shangshu-web/js/domains/excel-univer/package.json',import.meta.url));
const {CellValueType}=engineRequire('@univerjs/core');
const main=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts',import.meta.url),'utf8');
test('Only the sparse virtual extra columns use public text format; literal IDs stay text and existing real numeric columns stay numeric',()=>{
  const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');
  const expression=source.match(/        columnData: ([^\n]+),/)?.[1];assert.ok(expression);
  const columns=[{fieldId:'编号',type:'text'},{fieldId:'费用',type:'decimal'}];
  const data=new Function('columns','extraCol','defaultStyle','return ('+expression+');')(columns,3,{fs:9.75});
  assert.deepEqual(Object.keys(data),['2','3','4']);assert.equal(data[0],undefined);assert.equal(data[1],undefined);
  const require=createRequire(new URL('../../../shangshu-web/js/domains/excel-univer/package.json',import.meta.url));const {Styles}=require('@univerjs/core'),{getCellType,getCellValue}=require('@univerjs/sheets');
  const styles=new Styles({});
  for(const value of ['00123','12345678901234567890']){
    const cell={v:value,s:data[2].s};const type=getCellType(styles,cell,{});assert.equal(type,1);assert.equal(getCellValue(type,cell),value);
    const original={v:value,t:4,s:{n:{pattern:'@'}}};assert.equal(getCellType(styles,original,{}),4);assert.equal(getCellValue(4,original),value);
  }
  const number={v:123.5,t:2};assert.equal(getCellType(styles,number,{}),2);assert.equal(getCellValue(2,number),123.5);
});
test('Traditional toolbar exposes saved fonts; structure uses grid gestures and clipboard stays keyboard-only',()=>{
  const markup=main.match(/host\.innerHTML = `([\s\S]*?)`;\n\n  const el =/)?.[1];assert.ok(markup);
  const html=new Function('icon','return `'+markup+'`;')(()=>'<svg></svg>');const dom=new JSDOM(html);
  try{const doc=dom.window.document;assert.equal(doc.querySelector('[data-copy]'),null);assert.equal(doc.querySelector('[data-paste]'),null);
    for(const selector of ['[data-font-size]','[data-font-color]','[data-font-bold]'])assert.ok(doc.querySelector('.excel-toolrow '+selector),selector);
    for(const selector of ['[data-add-row]','[data-add-col]','[data-append-group]','[data-inline-edit]'])assert.equal(doc.querySelector(selector),null);
    // FIX-37（2026-10-20）：工具栏改版引入了「下拉菜单」机制（低频操作收进去）。
    // 这条契约的**原意**是「**行列入口不许被藏起来**」—— 用户不点右键也能找到插入/删除/移动行列。
    // 下拉机制本身允许存在，但**行列入口必须仍在工具栏上直接可见**，
    // 不能被收进任何一个下拉里。（FIX-13 另有一条判据钉「行列入口常驻可见且带图标与文字」。）
    const structureMenu=doc.querySelector('[data-structure-dropdown]');
    if(structureMenu)assert.equal(structureMenu.querySelector('[data-structure]'),null,'「行列」入口不许被收进下拉菜单');
    assert.ok(doc.querySelector('.excel-toolrow [data-structure]'),'「行列」入口必须直接在工具栏上可见');
    // 下拉菜单只收**低频**操作；「选择性粘贴 / 填充序列 / 字段权限」进去是对的。
    assert.equal(doc.querySelector('[data-rename-header]'),null);assert.equal(doc.querySelector('[data-rename-table]'),null);
    assert.match(main,/el\.title\.addEventListener\('dblclick'/);
    assert.equal(doc.querySelector('[data-save-state]')?.hasAttribute('hidden'),true);assert.equal(doc.querySelector('.excel-hint'),null);assert.equal(doc.querySelector('[data-scope]')?.hasAttribute('hidden'),true);
    assert.match(main,/addEventListener\('copy', gridCopyListener/);assert.match(main,/addEventListener\('paste', gridPasteListener/);
    assert.match(main,/handleInput\(event\)/);assert.match(main,/extend: pasteTable.kind === 'xlsx'/);
  }finally{dom.window.close();}
});
test('Actual blank-grid commits keep first-row text and far row/column coordinates through one atomic 1x1 paste',()=>{
  const start=main.indexOf('  function onCommit('),end=main.indexOf('\n  let gridCopyListener',start);assert.ok(start>0&&end>start);
  const code=ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const captured:any[]=[],restored:any[]=[];
  const inputCode=ts.transpileModule(functionSource(main,'handleInput'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const queue:any[]=[];const env={inputQueue:queue,openingTable:false,indexToName:new Map(),renderSaveBar:()=>{},updateToolbar:()=>{},drainInputs:()=>{const op=queue.at(-1);captured.push({matrix:op.matrix,row:op.row,col:op.col});},pendingStyle:null,undoing:false,pasteApplying:false,grid:{setRowValue:(...args:any[])=>restored.push(args)},notify:()=>{},table:{writable:true},columns:[{fieldId:'id'},{fieldId:'remark'}],totalRows:1,hasUnsaved:()=>false,newIdempotencyKey:()=> 'input-id',writeRange:(matrix:any,row:number,col:number)=>captured.push({matrix,row,col}),
  // ★ 合并说明（2026-10-21）：合并后 onCommit 多了一句「有未核实的文件操作 ⇒ 不许继续编辑」
  //   （fast 那边的闸）。pendingFileOperations 是**挂载函数的闭包变量**，
  //   沙箱只执行单个函数时取不到 ⇒ 补上（不改生产代码）。
  pendingFileOperations:new Map()};
  const commit=new Function(...Object.keys(env),'let pendingInput=null;'+inputCode+code+';return onCommit;')(...Object.values(env));
  for(const [row,col,value] of [[0,2,'00123'],[7,0,'far row'],[6,5,'a\tb\n"c"']] as const)commit({rowIndex:row,colIndex:col,fieldId:col<2?'编号':'__extra_'+col,value,before:'',type:'text'});
  assert.deepEqual(captured,[{matrix:[['00123']],row:0,col:2},{matrix:[['far row']],row:7,col:0},{matrix:[['a\tb\n"c"']],row:6,col:5}]);
  assert.equal(restored.length,0,'valid input preview stays until the managed input receipt or rejection');
});
test('The reused managed paste performs one expansion action and one Undo step, reloads only the target page, and rejection leaves no Undo',async()=>{
  const start=main.indexOf('  async function handlePaste('),end=main.indexOf('\n  function onCommit(',start);assert.ok(start>0&&end>start);
  const code=ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  for(const [row,col,text,denied] of [[0,3,'00123',false],[7,0,'far row',false],[6,5,'a\tb\n"c"',false],[7,5,'not allowed',true]] as const){
    const writes:any[]=[],undo:any[]=[],pages:number[]=[],selected:any[]=[],restored:any[]=[],notices:any[]=[];
    // ⚠️ `canStructure`：**越界写入那道闸问的是「表自己的结构权」**
    //   （`table.canStructure` ＝ `sheet_read` 回的 `my_access.structure`，开表那一刻就有），
    //   不是导出能力探测的结果（main.ts 第 1938 行，write-gate.ts）。
    //   夹具的表没说自己能不能改结构 ⇒ 闸判成「不能改行列」⇒ 粘贴整笔被拒（0 次写）。
    //   这里补上「这张表允许改结构」——产品里这个字段一直都有（见 excel-mount-harness.ts 的 adapter）。
    const table={kind:'xlsx',writable:true,canStructure:true,async pasteApply(request:any){writes.push(request);if(denied)throw Error('403 structure denied');return {cells:[{rowId:'server-row',header:'server-column',before:{type:'empty',value:null},after:{type:'text',value:text}}],headers:['a','b','c','d','e','f'],rowsAdded:Math.max(0,row),colsAdded:Math.max(0,col-1),actionCount:1};}};
    // ⚠️ `getViewState` / `restoreViewState`：产品 `sheet.ts` 提供的取景状态存取
    //   （main.ts 第 2063/2067 行用它「保住用户当时的取景」）。夹具不给就没有。
    const env={table,exportCapabilities:{canStructure:true},retrySave,newIdempotencyKey:()=> 'paste-id',needsFormulaRefresh,wroteFormula,renderSaveBar(){},disposed:false,openingTable:false,hasUnsaved:()=>false,parseClipboardTsv,columns:[{fieldId:'编号',type:'text'},{fieldId:'备注',type:'text'}],totalRows:1,filled:new Set([0]),inlineControllers:new Map(),nameToIndex:new Map(),grid:{getSelection:()=>({rowIndex:99,colIndex:99}),recalcAutoHeights(){},scrollToRow:(...v:any[])=>selected.push(v),selectCell(){},getViewState:()=>({range:{startRow:0,startCol:0,endRow:0,endCol:0},scroll:null}),restoreViewState:(state:any)=>restored.push(state)},showSaveOverlay(){},hideSaveOverlay(){},updateToolbar(){},el:{scope:{textContent:''}},undoStack:undo,async refreshAppendedRows(){return false;},async rebuildAfterStructure(){},async loadPage(page:number){pages.push(page);},pageCache:new Map(),reportActionFact(){},describeError:String,notify:(...v:any[])=>notices.push(v),PAGE_LENGTH:100,
     // ★ 合并说明（2026-10-21）：合并后 writeRange 多了「还有保存/列宽/文件操作没核实 ⇒ 不许粘贴」
     //   （fast 那边的闸）。这三个是挂载函数的闭包变量，沙箱只执行单个函数时取不到 ⇒ 补上。
     pending:new Map(),pendingWidths:new Map(),pendingFileOperations:new Map(),
     // ⚠️ `decideExtendWrite` 是 main.ts 的**顶层 import**（越界写入那道闸）——
     //   片段在真代码里用的是真的那个，这里补上**真的那个**（公共件里的纯函数）。
     decideExtendWrite,
     // ⚠️ `rowBehaviors` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 837 行）——
     //   抽出来的片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError。
     //   沙箱补上产品的「没有业务行行为」那个值（null）。
     rowBehaviors:null};
    const names=Object.keys(env);const run=new Function(...names,'let pasteApplying=false;'+code+';return handlePaste;')(...Object.values(env));await run(serializeClipboardTsv([[text]]),row,col);
    assert.equal(writes.length,denied?3:1);assert.ok(writes.every(request=>request.opId===writes[0].opId),'bounded retries reuse one operation identity');assert.deepEqual(writes[0].matrix,[[text]]);assert.deepEqual(writes[0].matrixTypes,[['text']]);assert.equal(writes[0].startRow,row);assert.equal(writes[0].startCol,col);assert.equal(writes[0].extend,true);
    if(denied){assert.equal(undo.length,0);assert.deepEqual(pages,[Math.floor(row/100)+1]);assert.ok(notices.some(n=>String(n[0]).includes('403')));}
    // ⚠️ **口径改过**：扩列后重建画布时，产品改成「**保住用户当时的取景**，
    //   不把用户拽回粘贴的那一格」（main.ts 第 2063/2067 行：`getViewState` → `restoreViewState`）。
    //   原来那条「粘贴后滚到粘贴处」（`grid.scrollToRow(startRow,startCol)`）被去掉了。
    //   ⇒ 这条断言原来钉的是**旧口径**；这里改钉**新口径**：不许强拉选区，取景要原样还回去。
    else{assert.equal(undo.length,1);assert.equal(undo[0].opId,writes[0].opId);assert.deepEqual(pages,[Math.floor(row/100)+1]);
     assert.deepEqual(selected,[],'扩列重建后不许把用户拽回粘贴处');assert.ok(restored.length>=1,'重建画布时要把用户当时的取景原样还回去');}
  }
});
test('Actual row-only refresh reads exactly one authoritative page and preserves grid; permission/schema/capacity changes refuse reuse',async()=>{
  const code=ts.transpileModule(functionSource(main,'refreshAppendedRows'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  for(const change of ['none','permission','header','capacity']){
    const reads:any[]=[],painted:any[]=[],versions:any[]=[],restored:any[]=[],cached=new Map([[1,[{name:'old'}]]]);
    const rows=Array.from({length:8},(_,index)=>({name:'row-'+index,编号:index===7?'kept value':''}));
    const meta={tableId:'t1',writable:change!=='permission',structureVersion:2,contentVersion:5,totalRows:8,displayName:'表',columnWidths:{},columns:[{header:change==='header'?'changed':'编号',type:'text',readOnly:false}]};
    const table={key:'t1',kind:'xlsx',writable:true,columnWidths:{},async loadPage(...args:any[]){reads.push(args);return{rows,total:8,meta};},adoptVersions:(value:any)=>versions.push(value)};
    // ⚠️ `refreshAppendedRows` 会调 `grid.getViewState()` / `grid.restoreViewState(view)`
    //   （main.ts 第 1266/1277 行，**不是**可选调用）⇒ 夹具的网格不给这两个方法就 TypeError。
    //   这里补上产品 `sheet.ts` 那两个方法的最小替身（记一笔，便于断言「网格被原样保住」）。
    const env={table,grid:{adoptColumns:()=>true,setColumnHeaders(){},getViewState:()=>({range:null,scroll:null}),restoreViewState:(state:any)=>restored.push(state)},gridRowCapacity:change==='capacity'?6:51,disposed:false,columns:[{fieldId:'编号',type:'text',readOnly:false}],totalRows:1,pageCache:cached,el:{title:{textContent:''}},applyRows:(rows:any[])=>painted.push(...rows),reapplyWrap(){},renderScope(){},renderProposals(){},PAGE_LENGTH:100};
    const names=Object.keys(env),run=new Function(...names,code+';return refreshAppendedRows;')(...Object.values(env));assert.equal(await run(7,7,2),change==='none');
    assert.equal(reads.length,change==='capacity'?0:1);assert.equal(painted.length,change==='none'?8:0);assert.equal(versions.length,change==='none'?1:0);
    assert.equal(restored.length,change==='none'?1:0,'复用网格时要把取景状态原样还回去（不许重画时跳回第一屏）');
    if(change==='none'){assert.equal(cached.get(1)?.[7].编号,'kept value');assert.deepEqual(versions,[{contentVersion:5,structureVersion:2}]);}
  }
});
test('Internal rebuild keeps candidate drafts/controllers and does not record another user open or reload proposal directory',()=>{
  const start=main.indexOf('  function clearInlineReviews('),end=main.indexOf('\n  function renderInlineCandidates',start);assert.ok(start>0&&end>start);
  const code=ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;let disposed=0,overlay=0,barCleared=0;
  const controller={dispose(){disposed++;}},controllers=new Map([['p1',controller]]),registry=new Map([['p1',controller]]);
  // ⚠️ 2026-10-26（PKG-125-T04）：`clearInlineReviews` 现在还会清**审核条**
  //   （`reviewBar?.clear()` —— 换表／关表时不留上一张表的提案和回执）⇒
  //   这个函数被**单独抽出来跑**时，得把 `reviewBar` 一并喂进去，
  //   否则报「reviewBar is not defined」（ReferenceError）。
  const run=new Function('candidateOverlay','inlineControllers','window','reviewBar',code+';return clearInlineReviews;')({dispose(){overlay++;}},controllers,{shangshuInlineReviews:registry},{clear(){barCleared++;}});run(true);assert.equal(disposed,0);assert.equal(overlay,1);assert.equal(registry.get('p1'),controller);assert.equal(controllers.get('p1'),controller);
  assert.equal(barCleared,1,'换表／关表时审核条必须一起清（不留上一张表的回执）');
  assert.match(main,/openTableByKey\(key,\{internal:true\}\)/);assert.match(main,/if\(!internal\)reportActionFact\(\{[^\n]*action: 'table.open'/);assert.match(main,/if\(!internal\)void loadProposals\(\)/);
});
test('After authoritative read a newer formal value is kept instead of being overwritten by the old POST after; real paste fact remains',async()=>{
  const start=main.indexOf('  async function handlePaste('),end=main.indexOf('\n  function onCommit(',start),code=ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const row={name:'server-row',编号:'newer formal value'},notices:any[]=[],facts:any[]=[],undo:any[]=[];let repainted=0;
  // ⚠️ 同上：越界写入闸问的是「表自己的结构权」（`table.canStructure`），夹具要补上。
  const table={kind:'xlsx',writable:true,canStructure:true,async pasteApply(){return{headers:['id'],rowsAdded:1,colsAdded:0,structureVersion:2,actionCount:1,cells:[{rowId:row.name,header:'编号',before:{type:'empty',value:null},after:{type:'text',value:'POST old value'}}]};}};
  const env={table,exportCapabilities:{canStructure:true},retrySave,newIdempotencyKey:()=> 'paste-id',needsFormulaRefresh,wroteFormula,renderSaveBar(){},disposed:false,openingTable:false,hasUnsaved:()=>false,parseClipboardTsv,columns:[{fieldId:'编号',type:'text'}],totalRows:1,filled:new Set([0]),inlineControllers:new Map(),nameToIndex:new Map([[row.name,7]]),grid:{getSelection:()=>null,recalcAutoHeights(){},scrollToRow(){},selectCell(){},setRowValue(){repainted++;}},showSaveOverlay(){},hideSaveOverlay(){},updateToolbar(){},el:{scope:{textContent:''}},undoStack:undo,async refreshAppendedRows(){return true;},async rebuildAfterStructure(){throw Error('unnecessary rebuild');},async loadPage(){throw Error('duplicate read');},pageCache:new Map([[1,[row]]]),getRowViewMetadata:()=>({types:{编号:'text'}}),reviewValuesEqual,reportActionFact:(fact:any)=>facts.push(fact),describeError:String,notify:(...v:any[])=>notices.push(v),PAGE_LENGTH:100,
   // ★ 合并说明（2026-10-21）：同上 —— writeRange 的「未核实不许粘贴」闸要这三个闭包变量。
   pending:new Map(),pendingWidths:new Map(),pendingFileOperations:new Map(),
   // ⚠️ 同上：越界写入闸（顶层 import）与行行为句柄（闭包变量）沙箱里也要有。
   decideExtendWrite,rowBehaviors:null};
  const names=Object.keys(env),run=new Function(...names,'let pasteApplying=false;'+code+';return handlePaste;')(...Object.values(env));await run('POST old value',7,0);
  assert.equal(row.编号,'newer formal value');assert.equal(repainted,0);assert.equal(undo.length,1);assert.ok(notices.some(n=>String(n[0]).includes('已提交')));assert.equal(notices.some(n=>n[1]==='success'),false);
  // ⚠️ **口径改过**：产品改成「**核心写入回执才是权威**」（main.ts 第 2142 行
  //   "No second 'saved' fact request: the core write receipt is authoritative."）
  //   ⇒ 界面**不再补发**第二条「已保存」事实（`paste.batch` / `cell.save`）。
  //   这条断言原来钉的是**旧口径**（界面补发一条 paste.batch）；
  //   同一口径在 excel-session-lifecycle.test.ts 也钉着（cell.save/paste.batch 的条数必须是 0）。
  //   这里改钉**新口径**：界面一条都不许补发（真实事实由核心回执带着）。
  assert.equal(facts.length,0,'新口径：核心写入回执才是权威，界面不许补发第二条「已保存」事实');
});
test('Style targets use stable row IDs/header names and refuse readonly/unloaded/oversize ranges without partial selection',()=>{
  const options={range:{startRow:0,endRow:1,startCol:0,endCol:1},columns:[{fieldId:'编号',readOnly:false},{fieldId:'金额',readOnly:false}],rowId:(n:number)=>['stable-z','stable-a'][n]};
  assert.deepEqual(buildStyleTargets(options),[{row_id:'stable-z',header:'编号'},{row_id:'stable-z',header:'金额'},{row_id:'stable-a',header:'编号'},{row_id:'stable-a',header:'金额'}]);
  assert.throws(()=>buildStyleTargets({...options,rowId:n=>n?'': 'r1'}),/未加载/);
  assert.throws(()=>buildStyleTargets({...options,columns:[{fieldId:'编号',readOnly:true}]}),/只读/);
  assert.throws(()=>buildStyleTargets({...options,range:{...options.range,endRow:10000}}),/两万/);
});
test('Font patch is sparse, exact pt/RGB/bold only; unrelated numeric format or theme color is never invented',()=>{
  assert.deepEqual(validateFontPatch({bold:true}),{bold:true});assert.deepEqual(fontStyleToUniver({font_size:11,font_color:'#12ABef',bold:false}),{fs:11,cl:{rgb:'#12ABef'},bl:0});
  assert.deepEqual(fontStyleToUniver({font_size:null,font_color:null,font_color_type:'theme',bold:false}),{fs:null,cl:null,bl:0});
  for(const patch of [{font_size:0},{font_size:410},{font_color:'red'},{bold:'yes'},{value:'change'}])assert.throws(()=>validateFontPatch(patch as any));
});
test('Malformed/duplicate/foreign style receipts never advance the canvas or versions',()=>{
  const targets=[{row_id:'r1',header:'编号'}];const receipt={kind:'style',table:'t1',op_id:'op1',applied:1,content_version:2,structure_version:1,cells:[{...targets[0],before:{bold:false},after:{bold:true}}]} as any;
  assert.equal(validateStyleReceipt(receipt,'t1','op1',targets),receipt);
  const noop={...receipt,applied:0,cells:[]};assert.equal(validateStyleReceipt(noop,'t1','op1',targets),noop);
  for(const bad of [{...receipt,table:'other'},{...receipt,op_id:'other'},{...receipt,cells:[]},{...receipt,cells:[{...receipt.cells[0],header:'other'}]}])assert.throws(()=>validateStyleReceipt(bad,'t1','op1',targets),/回执/);
});
test('Actual font adapter uses one authorized sparse-patch action with the original operation/version; errors stay rejected',async()=>{
  const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/adapter.ts',import.meta.url),'utf8');
  const body=source.match(/async writeStyle\(args,signal\)\{([\s\S]*?)\n  \},/)?.[1];assert.ok(body);
  const code=ts.transpileModule('async function invoke(args,signal){'+body+'}',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const calls:any[]=[];const args={tableId:'t1',expectedContentVersion:4,expectedStructureVersion:2,opId:'same-key',cells:[{row_id:'stable-z',header:'编号'}],style:{bold:true}};
  const result={kind:'style',table:'t1',op_id:'same-key',applied:1,content_version:5,structure_version:2,cells:[{row_id:'stable-z',header:'编号',before:{bold:false},after:{bold:true}}]};
  const request=async(path:string,init:any)=>{calls.push({path,body:JSON.parse(init.body)});return {ok:true,result};};
  const create=(request:any)=>new Function('request','validateFontPatch','validateStyleReceipt',code+';return invoke;')(request,validateFontPatch,validateStyleReceipt);
  await create(request)(args,undefined);await create(request)(args,undefined);assert.deepEqual(calls[0],calls[1]);
  assert.equal(calls[0].path,'/api/platform/actions/files.sheet_style_write/execute');assert.equal(calls[0].body.confirmed,true);assert.equal(calls[0].body.idempotency_key,'same-key');
  assert.deepEqual(calls[0].body.payload.style,{bold:true});assert.equal(calls[0].body.payload.expected_content_version,4);assert.equal(calls[0].body.payload.cells[0].row_id,'stable-z');
  await assert.rejects(()=>create(async()=>{throw Error('403 denied');})(args,undefined),/403 denied/);
});
test('Actual grid value refresh retains known font while literal identifiers keep their string type',()=>{
  const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');
  const cellFor=functionSource(source,'cellFor');
  const method=source.slice(source.indexOf('    setRowValue(rowIndex,'),source.indexOf('    recalcAutoHeights(startRow,',source.indexOf('    setRowValue(rowIndex,'))).trim().replace(/^setRowValue\(/,'function setRowValue(').replace(/,\s*$/,'');
  const code=ts.transpileModule(cellFor+'\n'+method,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const known=new Map([[0,new Map([['编号','00123']])]]),knownTypes=new Map([[0,new Map([['编号','text']])]]),knownStyles=new Map([[0,new Map([['编号',{font_size:18,font_color:'#ff0000',bold:true}]])]]);const writes:any[]=[];
  const execute=new Function('defaultStyle','fontStyleToUniver','wrapped','WRAP_VALUE','displayCellText','CELL_NUMBER','CELL_STRING','known','knownTypes','knownStyles','columns','worksheet','isProgrammaticUpdate','toText',code+';return setRowValue;');
  const write=execute({fs:9.75},fontStyleToUniver,new Set(),3,String,CellValueType.NUMBER,CellValueType.STRING,known,knownTypes,knownStyles,[{fieldId:'编号',type:'text'}],()=>({getRange:()=>({setValues:(values:any)=>writes.push(values)})}),false,String);
  write(0,'编号','00124','text');assert.equal(writes[0][0][0].v,'00124');assert.equal(writes[0][0][0].t,CellValueType.STRING);assert.equal(writes[0][0][0].s.fs,18);assert.equal(writes[0][0][0].s.bl,1);assert.deepEqual(writes[0][0][0].s.cl,{rgb:'#ff0000'});
});
test('The real selection event synchronizes persisted fonts after delayed default selection and subsequent navigation',()=>{
  const sheet=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');
  const event=sheet.match(/univerAPI\.addEvent\(univerAPI\.Event\.SelectionChanged, \(event\) => \{([\s\S]*?)\n    \}\)/)?.[1];assert.ok(event,'font toolbar requires the official selection-ready/change event');
  const method=sheet.match(/onSelection\(handler\) \{([\s\S]*?)\n    \},/)?.[1];assert.ok(method);
  const sync=main.slice(main.indexOf('  function syncFontControls()'),main.indexOf('  async function runStyleSave'));
  // FIX-37：字号控件从数字输入框改成**下拉框**（Excel 的做法：常用字号直接选），
  // 所以夹具也要按新契约用 <select>。**断言本身没变**（下面仍要验「当前格的字号同步到控件」）。
  const dom=new JSDOM('<select id="size"></select><input id="color"><button id="bold"></button><button id="italic"></button><button id="underline"></button>');
  try{
    let ready=false,row=0;const handlers:Array<()=>void>=[];
    const grid={getSelection:()=>ready?{rowIndex:row,colIndex:0}:null,getCellStyle:()=>row===0?{font_size:18,font_color:'#ff0000',bold:true,italic:true,underline:false}:{font_size:11,font_color:null,bold:false,italic:false,underline:false}};
    const el={fontSize:dom.window.document.querySelector('#size'),fontColor:dom.window.document.querySelector('#color'),fontBold:dom.window.document.querySelector('#bold'),fontItalic:dom.window.document.querySelector('#italic'),fontUnderline:dom.window.document.querySelector('#underline')} as any;
    const code=ts.transpileModule(sync,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
    const update=new Function('grid','columns','el','hasUnsaved',code+';return syncFontControls;')(grid,[{fieldId:'编号'}],el,()=>false);
    const register=new Function('handler','selectionHandlers','worksheet',method);register(update,handlers,()=>({getSelection:()=>({getActiveRange:()=>ready?{}:null})}));
    assert.equal(el.fontBold.getAttribute('aria-pressed'),null);
    const notify=new Function('event','selectionHandlers','workbookId','sheetId',event);
    const actualEvent={workbook:{id:'workbook-b1'},worksheet:{getSheetId:()=> 'sheet-b1'}};
    ready=true;notify(actualEvent,handlers,'workbook-b1','sheet-b1');assert.equal(el.fontBold.getAttribute('aria-pressed'),'true');assert.equal(el.fontSize.value,'18');
    // FIX-18：斜体/下划线按钮也要跟着当前格的样式亮起来（用户一眼看得出现在是斜体）。
    assert.equal(el.fontItalic.getAttribute('aria-pressed'),'true');
    assert.equal(el.fontUnderline.getAttribute('aria-pressed'),'false');
    row=1;notify(actualEvent,handlers,'workbook-b1','sheet-b1');assert.equal(el.fontBold.getAttribute('aria-pressed'),'false');assert.equal(el.fontSize.value,'11');
    row=0;notify({...actualEvent,workbook:{id:'other'}},handlers,'workbook-b1','sheet-b1');assert.equal(el.fontBold.getAttribute('aria-pressed'),'false');
    assert.match(main,/grid!\.onSelection\(syncFontControls\)/);
  }finally{dom.window.close();}
});
test('First-page data establishes a real primary selection before font sync; normal row loading resynchronizes the selected style',()=>{
  const sheet=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');
  assert.match(main,/applyRows\(probe\.rows,0\)[\s\S]*?if\(!grid.getSelection\(\)\)grid.selectCell\(0,0\);\s*syncFontControls\(\)/);
  assert.match(sheet,/const active=activeCellPosition\(\);\s*if\(active&&matrix\[active.rowIndex\]\)selectionHandlers.forEach/);
  assert.match(sheet,/getActiveCell\(\)\?\.getRange\(\)/);
  const body=main.match(/function renderSaveBar\(\) \{([\s\S]*?)\n  \}/)?.[1];assert.ok(body);
  const footer:any={hidden:false};const foot:any={innerHTML:'',querySelector:()=>null};const el={saveState:footer,foot,retry:{hidden:false},discard:{hidden:false}};
  const compiled=ts.transpileModule('function render(){'+body+'}',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  /**
  * ★ 合并说明（2026-10-21）：合并后 renderSaveBar 用上了 **fast 那边的「按状态汇总」口径**：
  *   · 状态条在没有**任何**未完成操作时才隐藏（旧的只看输入队列）；
  *   · 有失败/冲突时给出「重试原操作」和「放弃修改」（旧的只在输入队列里有失败时才给）；
  *   · 离开页面的闸：只要还有未核实的保存/列宽/文件操作，就**不许离开**
  *     （旧口径：失败的操作不困住用户）。
  *   新闭包变量 pendingFileOperations 与 grid（「正在编辑」）也要补进沙箱。
  * 断言按新契约重钉 —— 每一条都写明它现在钉住的是哪个新口径。
  */
  const render=new Function('pendingInput','pending','pendingWidths','pendingFileOperations','pendingStyle','el','ui','inputQueue','notify','grid','decideLeaveTable','lastDiscardableFailure',compiled+';return render();');
  // ⚠️ **沙箱参数要跟着实现走**（2026-10-30 · PKG-133 · 缺陷③）：
  //   `renderSaveBar` 多了一个闭包变量 `lastDiscardableFailure`
  //   （「明确没写进去」的那一笔**不进队列**、但**单独记一份** ⇒ 「放弃修改」的出口还在）
  //   ⇒ 沙箱里**漏了这个参数** ⇒ 读到它就 ReferenceError ⇒ 这条判据整条红。
  //   ⇒ 判据侧补上（**跟着实现走**的实现方要一起改，否则又是一次假红）。
  const run=(args:{pendingInput?:any;pending?:any;pendingWidths?:any;pendingFileOperations?:any;pendingStyle?:any;el?:any;ui?:any;inputQueue?:any;lastDiscardableFailure?:any}={})=>
    render(args.pendingInput??null,args.pending??new Map(),args.pendingWidths??new Map(),args.pendingFileOperations??new Map(),
      args.pendingStyle??null,args.el??el,args.ui??null,args.inputQueue??[],()=>{},{isEditing:()=>false},decideLeaveTable,
      args.lastDiscardableFailure??null);
  run();
  assert.equal(footer.hidden,true,'没有任何未完成操作时，保存状态条不占位');
  let leave:(()=>boolean)|undefined;
  run({pending:new Map([['op',{state:'failed'}]]),ui:{guardLeave:(check:()=>boolean)=>leave=check}});
  assert.equal(footer.hidden,false,'新口径：有未完成操作时状态条要露出来，用户看得见卡在哪一笔');
  assert.equal(el.retry.hidden,false,'新口径：有失败的操作就要给「重试原操作」按钮');
  assert.equal(el.discard.hidden,false,'新口径：有失败的操作也要给「放弃修改」按钮');
  assert.match(foot.innerHTML,/1 笔保存失败/,'状态文字要说明是「保存失败」这一类');
  assert.match(foot.innerHTML,/重试原操作/,'状态文字里带内联重试入口');
  // —— **新口径（2026-10-30 · PKG-133 · 缺陷③）**：队列空了、但有「明确没写进去」的那一笔
  //   ⇒ 状态条**要露出来**、**「放弃修改」要给**（出口不许消失）、**「重试」不给**（那一笔没发出去过）。
  run({lastDiscardableFailure:{message:'日期需为有效的 YYYY-MM-DD',uncertain:false,discardable:true}});
  assert.equal(footer.hidden,false,'「明确没写进去」的那一笔存在时，状态条要露出来');
  assert.equal(el.discard.hidden,false,'「明确没写进去」的那一笔必须给「放弃修改」出口');
  assert.equal(el.retry.hidden,true,'那一笔没发出去过 ⇒ 不给「重试原操作」');
  assert.match(foot.textContent||'',/没有存进去/,'状态文字要说清「这一笔没存进去」');
  // —— **结果不明的**（可能已经写进库里了）⇒ **不给放弃**（放弃＝丢数据）。
  run({lastDiscardableFailure:{message:'结果未明',uncertain:true,discardable:false}});
  assert.equal(el.discard.hidden,true,'结果不明时不给「放弃修改」（那会丢数据）');
  // ⚠️ **口径改过（2026-10-29，用户原话「刷新页面也不能，显示有东西未完成」⇒ 人被锁死在里面）**：
  //   离页那道闸现在只拦**还在飞**（saving）的那几笔；**失败／冲突**的没写进去 ⇒ 不拦
  //   （重开以服务端正式值为准，工作没丢）。
  //   ⇒ 这条断言原来钉的是**旧口径**（「未核实的操作没处理完就不许离开」）。
  //   完整口径由 `shangshu-web/js/domains/excel-univer/tests/save-guard.test.ts` 守着；
  //   这里保留「状态条这条线上的离页闸确实接上了」这一层：失败的**放行**、在飞的**拦**。
  assert.equal(leave?.(),true,'新口径：失败的那笔没写进去 ⇒ 不许把人锁在表里（能刷新、能离开）');
  run({pending:new Map([['op',{state:'saving'}]]),ui:{guardLeave:(check:()=>boolean)=>leave=check}});
  assert.equal(leave?.(),false,'新口径：还在飞的那笔必须拦（它可能正在写进去）');
});

test('UI008 managed display patches validate formats and map borders/wrap without editing values',()=>{
 assert.deepEqual(validateFontPatch({number_format:'#,##0.00',wrap_text:false,border:{preset:'all'}}),{number_format:'#,##0.00',wrap_text:false,border:{preset:'all'}});
 assert.throws(()=>validateFontPatch({number_format:'arbitrary-format'}));assert.throws(()=>validateFontPatch({border:'thin'} as any));assert.throws(()=>validateFontPatch({border:{preset:'rainbow'}} as any));assert.throws(()=>validateFontPatch({border:{preset:'all',style:'squiggly'}} as any));assert.throws(()=>validateFontPatch({wrap_text:'false'} as any));
 const edge={style:'thin',color:'#D1D5DB'};const mapped=fontStyleToUniver({number_format:'yyyy-mm-dd',wrap_text:false,border:{top:edge,bottom:{style:null,color:null},left:{style:'double',color:'#FF0000'},right:edge}});
 assert.deepEqual(mapped.n,{pattern:'yyyy-mm-dd'});assert.equal(mapped.tb,2);assert.deepEqual(mapped.bd,{t:{s:1,cl:{rgb:'#D1D5DB'}},b:null,l:{s:7,cl:{rgb:'#FF0000'}},r:{s:1,cl:{rgb:'#D1D5DB'}}});
});
test('UI008 actual engine cell projection applies number/date patterns while literal identifiers remain text',()=>{
 const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');const code=ts.transpileModule(functionSource(source,'cellFor'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const cell=new Function('defaultStyle','fontStyleToUniver','wrapped','WRAP_VALUE','displayCellText','CELL_NUMBER','CELL_STRING',code+';return cellFor;')({},fontStyleToUniver,new Set(['amount']),3,String,2,1);
 const amount=cell(1234.5,{fieldId:'amount'},'number',{number_format:'#,##0.00',wrap_text:false});assert.equal(amount.v,1234.5);assert.equal(amount.s.n.pattern,'#,##0.00');assert.equal(amount.s.tb,2);
 const date=cell('2026-10-19',{fieldId:'date'},'date',{number_format:'yyyy-mm-dd'});assert.equal(date.t,2);assert.equal(date.v,(Date.UTC(2026,9,19)-Date.UTC(1899,11,30))/86400000);assert.equal(date.s.n.pattern,'yyyy-mm-dd');
 const id=cell('00123',{fieldId:'id'},'text',{number_format:'0.00'});assert.equal(id.v,'00123');assert.equal(id.t,1);assert.equal(id.s.n.pattern,'@');
});
test('UI008 unpersisted native hide/unhide and number-format commands are blocked before engine mutation',()=>{
 const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8');const ast=ts.createSourceFile('sheet.ts',source,ts.ScriptTarget.Latest,true);const declaration=ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==='BLOCKED_COMMAND_PATTERNS'))!;const code=ts.transpileModule(declaration.getText(ast)+'\n'+functionSource(source,'isBlocked'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;const blocked=new Function(code+';return isBlocked;')();
 for(const id of ['sheet.command.set-col-hidden','sheet.command.set-rows-hidden','sheet.command.set-col-visible-on-cols','sheet.command.set-selected-cols-visible','sheet.command.set-specific-rows-visible','sheet.command.set-selected-rows-visible','sheet.command.numfmt.set.numfmt'])assert.equal(blocked(id),true,id);
 assert.equal(blocked('sheet.command.set-worksheet-col-width'),false);
});
