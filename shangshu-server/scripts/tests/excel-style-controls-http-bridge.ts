import {writeFileSync} from 'node:fs';
import {readExportCapabilities,exportCurrentTable} from '../../../shangshu-web/js/domains/excel-univer/src/export-helper.ts';
import {buildClipboardPayload,workbookShortcutAllowed} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-toolbar.ts';
import {buildStyleTargets,validateFontPatch} from '../../../shangshu-web/js/domains/excel-univer/src/font-style.ts';
import {openTable as actualOpenTable} from '../../../shangshu-web/js/domains/excel-univer/src/backend.ts';
const TABLE=process.env.SS_QUEUE_TABLE!;
assert.ok(TABLE&&process.env.SS_BASE&&process.env.SS_QUEUE_COOKIE);
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import {ViewportReadScheduler} from '../../../shangshu-web/js/domains/excel-univer/src/read-scheduler.ts';
import {parseClipboardTsv,serializeClipboardTsv} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';
import {retrySave} from '../../../shangshu-web/js/domains/excel-univer/src/save-retry.ts';
import {getRowViewMetadata,setRowFontStyle} from '../../../shangshu-web/js/domains/excel-univer/src/backend.ts';
import {mountCandidateOverlay} from '../../../shangshu-web/js/domains/excel-univer/src/candidate-overlay.ts';
import {mountHeaderRename} from '../../../shangshu-web/js/domains/excel-univer/src/header-rename.ts';
import {reviewValuesEqual} from '../../../shangshu-web/js/domains/excel-univer/src/inline-review.ts';
import {needsFormulaRefresh} from '../../../shangshu-web/js/domains/excel-univer/src/formula-values.ts';
// Execute the entire production mount; only expose its existing closure to tests.
const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const mount=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='mountExcelPage') as ts.FunctionDeclaration;
assert.ok(mount);
const text=mount.getText(ast),instrumented=text.slice(0,text.lastIndexOf('}'))+'\n globalThis.testSession={openTableByKey,writeRange,runUndo,handlePaste,onCommit,refreshReviewValues};\n}';
const script=ts.transpileModule(instrumented,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
async function settled(check:()=>boolean,errors:string[]){for(let i=0;i<2000;i++){assert.deepEqual(errors,[]);if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'production mount did not settle');}
function setup(options:{beforeWrite?:()=>Promise<void>;columnType?:string;canStructure?:boolean;empty?:boolean}={}){
 const dom=new JSDOM('<div id="host"></div>',{url:process.env.SS_BASE+'/?object='+TABLE,runScripts:'outside-only'}),host=dom.window.document.querySelector('#host') as HTMLElement;
 const versions=new Map([[TABLE,1],['two',1]]);
 const values=new Map([[TABLE,'原值'],['two','另一表']]);
 const data=new Map<string,string[][]>([[TABLE,options.empty?[]:[['原值']]],['two',[['另一表']]]]);const headers=new Map([[TABLE,options.empty?[]:['C1']],['two',['C1']]]);const grids:any[]=[],opens:string[]=[],errors:string[]=[],requests:any[]=[],notifications:string[]=[],facts:any[]=[],styleRequests:any[]=[],structureRequests:any[]=[];let id=0,writes=0;
 const context:any={window:dom.window,document:dom.window.document,location:dom.window.location,history:dom.window.history,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,URLSearchParams,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,
  console:{log:()=>{},warn:()=>{},error:(...v:any[])=>errors.push(v.join(' '))},setTimeout,clearTimeout,Date,Math,Map,Set,PAGE_LENGTH:100,ViewportReadScheduler,retrySave,getRowViewMetadata,setRowFontStyle,buildClipboardPayload,workbookShortcutAllowed,buildStyleTargets,validateFontPatch,needsFormulaRefresh,reviewValuesEqual,parseClipboardTsv,serializeClipboardTsv,
  toast:(_title:string,message:string)=>notifications.push(message),newIdempotencyKey:()=>`${TABLE}-session-${++id}`,reportActionFact:async(event:any)=>facts.push(event),flushPendingActionFacts:async()=>{},
  readExportCapabilities,
  openTable:actualOpenTable,
  fetch:async()=>({ok:true,status:200,json:async()=>({items:[],total:0,pending:0,has_more:false,columns:[]})}),
  mountCandidateOverlay,mountHeaderRename,
  createGrid:(_host:any,_columns:any,rowCapacity:number,extraColumns:number)=>{const grid={rowCapacity,extraColumns,painted:[] as any[],disposed:false,selection:{rowIndex:0,colIndex:0},dispose(){this.disposed=true;},getSelection(){return this.selection;},selectCell(rowIndex:number,colIndex:number){this.selection={rowIndex,colIndex};},getSelectionRange:()=>({startRow:0,endRow:0,startCol:0,endCol:0}),getReviewFrame:()=>null,getDiag:()=>({}),getCellText:()=>values.get(opens.at(-1)!)??'',isEditing:()=>false,
    adoptColumns:()=>false,scrollToRow:()=>{},markReviewCells:()=>()=>{},onRowHeight(callback:any){this.rowHeight=callback;},onScroll:()=>{},wrapColumn:()=>{},getCellStyle:()=>undefined,onCommit:()=>{},onSelection:()=>{},onLayout:()=>{},onBlockedCommand:()=>{},onReadOnlyEdit:()=>{},onViewport:()=>{},onColumnWidth(callback:any){this.columnWidth=callback;},setCellStyles:()=>{},setRows:()=>{},setRowValue(row:number,field:string,value:unknown){this.painted.push({row,field,value});},setFreeze:()=>{},setColumnHeaders:()=>{},setColumnWidths:()=>{},setRowHeights:()=>{},snapshotColumnWidths:()=>{},recalcAutoHeights:()=>{},};grids.push(grid);return grid;},
 };
 dom.window.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js',import.meta.url),'utf8'));
 context.createToolWorkspace=(dom.window as any).createToolWorkspace;
 const structureSource=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/structure-dialog.ts',import.meta.url),'utf8');
 const structureAst=ts.createSourceFile('structure.ts',structureSource,ts.ScriptTarget.Latest,true);
 const structureFunction=structureAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='editStructure')!;
 runInNewContext(ts.transpileModule(structureFunction.getText(structureAst).replace('export function','function'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.editStructure=editStructure;',context);
 context.g=context;runInNewContext(script+';globalThis.mountProduction=mountExcelPage;',context);
 let controller:any;
 const mountPage=async()=>{controller=new dom.window.AbortController();context.mountProduction(host,controller.signal);await settled(()=>context.excelPageDiag?.().tableKey===TABLE&&host.querySelector('[data-scope]')?.textContent?.includes(options.empty?'共 0 行':'共 1 行')===true,errors);return context.testSession;};
 return {context,host,data,headers,values,grids,opens,errors,requests,notifications,facts,styleRequests,structureRequests,writes:()=>writes,mountPage,abort:()=>controller.abort(),close:()=>{controller?.abort();dom.window.close();}};
}


const transport=globalThis.fetch,requests:any[]=[],checks:string[]=[];
const check=(name:string,ok:boolean)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
async function actualFetch(url:any,options:any={}){
 if(options.signal&&!(options.signal instanceof AbortSignal)){const controller=new AbortController(),source=options.signal;if(source.aborted)controller.abort();else source.addEventListener('abort',()=>controller.abort(),{once:true});options={...options,signal:controller.signal};}
 const response=await transport(new URL(String(url),process.env.SS_BASE),{...options,headers:{...options.headers,cookie:process.env.SS_QUEUE_COOKIE}});
 if(String(url).includes('/execute'))requests.push({url:String(url),body:options.body?JSON.parse(options.body):null,status:response.status,response:await response.clone().json()});return response;
}
globalThis.fetch=actualFetch;const h=setup();h.context.fetch=actualFetch;
const fact=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reportActionFact')!;h.context._pendingActionFacts=[];runInNewContext(ts.transpileModule(fact.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.reportActionFact=reportActionFact;',h.context);
try{
 const api=await h.mountPage();const grid=h.grids.at(-1);let row=0,col=1;grid.getSelection=()=>({rowIndex:row,colIndex:col});grid.getSelectionRange=()=>({startRow:row,endRow:row,startCol:col,endCol:col});
 const choose=async(selector:string,value:string)=>{const before=requests.filter(r=>r.url.includes('sheet_style_write')).length;const control=h.host.querySelector(selector) as HTMLSelectElement;control.value=value;control.dispatchEvent(new h.context.window.Event('change'));await settled(()=>requests.filter(r=>r.url.includes('sheet_style_write')).length===before+1,h.errors);await new Promise(r=>setTimeout(r,40));const last=requests.filter(r=>r.url.includes('sheet_style_write')).at(-1);assert.equal(last.status,200,JSON.stringify(last.response));};
 await choose('[data-number-format]','#,##0.00');check('production amount format chooser stores managed format without value action',requests.at(-1).status===200);
 col=2;await choose('[data-number-format]','yyyy-mm-dd');check('production date format chooser stores calendar format',true);
 (h.host.querySelector('[data-wrap-text]') as HTMLElement).click();await settled(()=>requests.filter(r=>r.url.includes('sheet_style_write')).length===3,h.errors);await new Promise(r=>setTimeout(r,40));check('production wrap button stores explicit wrap',requests.filter(r=>r.url.includes('sheet_style_write')).at(-1).body.payload.style.wrap_text===true);
 await choose('[data-border]','all');check('production border chooser stores four thin edges',true);
 const formatted=await exportCurrentTable(TABLE,'xlsx');writeFileSync(process.env.SS_STYLE_BEFORE!,Buffer.from(formatted.bytes));check('actual authorized export of formatted current revision succeeds',formatted.bytes.byteLength>0);
 await api.runUndo();check('production personal undo invokes managed inverse for last border operation',requests.some(r=>/sheet_.*undo/.test(r.url)&&r.status===200));const undone=await exportCurrentTable(TABLE,'xlsx');writeFileSync(process.env.SS_STYLE_AFTER!,Buffer.from(undone.bytes));
 check('style-only controls and undo never invoke cell value writes',!requests.some(r=>/sheet_(cells|input|paste).*write/.test(r.url)));
 await api.openTableByKey(TABLE);check('same resource reopens after style inverse',h.context.excelPageDiag().tableKey===TABLE);
 console.log('STYLE_REQUESTS',JSON.stringify(requests));console.log('RESULT',checks.length,'/',checks.length);
}finally{h.close();globalThis.fetch=transport;}
