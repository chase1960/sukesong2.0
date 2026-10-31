import {readExportCapabilities} from '../../../shangshu-web/js/domains/excel-univer/src/export-helper.ts';
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
 const api=await h.mountPage();await settled(()=>!h.host.querySelector('[data-structure]')?.hasAttribute('disabled'),h.errors);
 const dbl=()=>new h.context.window.MouseEvent('dblclick',{bubbles:true});const enter=()=>new h.context.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true});
 h.host.querySelector('[data-title]')!.dispatchEvent(dbl());const title=h.host.querySelector('[data-title-input]') as HTMLInputElement;title.value='控件验收-'+TABLE+'.xlsx';title.dispatchEvent(enter());await settled(()=>h.host.querySelector('[data-title]')!.textContent===title.value&&h.grids.length===2,h.errors);check('production title double-click submits and reopens same resource',h.context.excelPageDiag().tableKey===TABLE);
 h.grids.at(-1).getHeaderAtPoint=()=>({colIndex:2,rect:{left:0,top:0,width:100,height:24}});h.host.querySelector('[data-grid]')!.dispatchEvent(dbl());const header=h.host.querySelector('[aria-label="原位修改列名"]') as HTMLInputElement;header.value='跟进意见';header.dispatchEvent(enter());await settled(()=>h.grids.length===3,h.errors);check('production header editor confirms original column and rebuilds same resource',requests.some(r=>r.status===200&&r.body?.payload?.to_header==='跟进意见'));
 const grid=h.grids.at(-1);grid.selection={rowIndex:0,colIndex:2};grid.getSelectionRange=()=>({startRow:0,endRow:0,startCol:2,endCol:2});
 (h.host.querySelector('[data-font-bold]') as HTMLElement).click();await settled(()=>requests.some(r=>r.url.includes('sheet_style_write')&&r.status===200),h.errors);await settled(()=>!h.context.excelPageDiag().save?.pending,h.errors);
 check('production bold button calls style action rather than value action',requests.some(r=>r.url.includes('sheet_style_write')&&r.body.payload.style.bold===true));
 await new Promise(r=>setTimeout(r,50));grid.columnWidth(2,177);await settled(()=>requests.some(r=>r.url.includes('sheet_layout_update')&&r.status===200),h.errors);await new Promise(r=>setTimeout(r,50));grid.rowHeight({'0':39},{'0':20});await settled(()=>requests.some(r=>r.url.includes('sheet_row_heights_write')&&r.status===200),h.errors);
 check('actual grid width and height callbacks submit public formatting requests',true);
 grid.getCellText=()=> '00123';const clip=new Map<string,string>();const copy=new h.context.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:{setData:(k:string,v:string)=>clip.set(k,v)}});h.context.document.activeElement?.blur();h.context.document.dispatchEvent(copy);check('production copy gives plain leading-zero value and neutral HTML',clip.get('text/plain')==='00123'&&!/font-weight/.test(clip.get('text/html')||''));
 const paste=new h.context.window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:(k:string)=>k==='text/plain'?clip.get(k):'<b>WRONG</b>'}});h.host.querySelector('[data-grid]')!.dispatchEvent(paste);await settled(()=>requests.some(r=>r.url.includes('sheet_cells_write')&&r.status===200),h.errors);check('actual paste public payload includes only intended value',requests.filter(r=>r.url.includes('sheet_cells_write')).at(-1).body.payload.cells[0].value.type==='text'&&requests.filter(r=>r.url.includes('sheet_cells_write')).at(-1).body.payload.cells[0].value.value==='00123');
 await api.openTableByKey(TABLE);check('same URL resource reopens following control writes',h.context.excelPageDiag().tableKey===TABLE);
 console.log('CONTROL_REQUESTS',JSON.stringify(requests));console.log('RESULT',checks.length,'/',checks.length);
}finally{h.close();globalThis.fetch=transport;}
