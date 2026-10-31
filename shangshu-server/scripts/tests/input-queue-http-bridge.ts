import {buildClipboardPayload} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-toolbar.ts';
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
  console:{log:()=>{},warn:()=>{},error:(...v:any[])=>errors.push(v.join(' '))},setTimeout,clearTimeout,Date,Math,Map,Set,PAGE_LENGTH:100,ViewportReadScheduler,retrySave,getRowViewMetadata,setRowFontStyle,buildClipboardPayload,buildStyleTargets,validateFontPatch,needsFormulaRefresh,reviewValuesEqual,parseClipboardTsv,serializeClipboardTsv,
  toast:(_title:string,message:string)=>notifications.push(message),newIdempotencyKey:()=>`${TABLE}-session-${++id}`,reportActionFact:async(event:any)=>facts.push(event),flushPendingActionFacts:async()=>{},
  readExportCapabilities:async()=>({available:false,canStructure:!!options.canStructure}),
  openTable:async(key:string)=>{opens.push(key);const adapter:any={kind:'xlsx',key,title:key,writable:true,columns:headers.get(key)!.map(header=>({fieldId:header,label:header,type:options.columnType??'text'})),columnWidths:{},canStructure:!!options.canStructure,insertColumn:async(before:string|null,header:string,key:string)=>{structureRequests.push({before,header,key});headers.get(opens.at(-1)!)!.push(header);},writeStyle:async(request:any)=>{styleRequests.push(request);return {applied:request.cells.length,cells:request.cells.map((cell:any)=>({...cell,before:{},after:request.style}))};},structureVersion:1,get contentVersion(){return versions.get(key);},
   loadPage:async()=>({total:data.get(key)!.length,rows:data.get(key)!.map((row,index)=>({name:key+'-r'+(index+1),...Object.fromEntries(headers.get(key)!.map((h,c)=>[h,index===0&&c===0?values.get(key):row[c]??'']))}))}),
   pasteApply:async(request:any)=>{const {matrix,startRow,startCol}=request;requests.push(JSON.parse(JSON.stringify(request)));await options.beforeWrite?.();writes++;versions.set(key,versions.get(key)!+1);
    const rows=data.get(key)!,cols=headers.get(key)!,oldRows=rows.length,oldCols=cols.length,cells:any[]=[];
    while(cols.length<startCol+matrix[0].length)cols.push('C'+(cols.length+1));while(rows.length<startRow+matrix.length)rows.push([]);
    matrix.forEach((row:string[],r:number)=>row.forEach((value,c)=>{const y=startRow+r,x=startCol+c,before=rows[y][x]??'';rows[y][x]=value;if(y===0&&x===0)values.set(key,value);cells.push({rowId:key+'-r'+(y+1),header:cols[x],before:{value:before},after:{type:'text',value}});}));
    return {cells,headers:[...cols],rowsAdded:rows.length-oldRows,colsAdded:cols.length-oldCols,actionCount:1,contentVersion:versions.get(key),structureVersion:1};},
  };adapter.inputWrite=adapter.pasteApply;return adapter;},
  fetch:async()=>({ok:true,status:200,json:async()=>({items:[],total:0,pending:0,has_more:false,columns:[]})}),
  mountCandidateOverlay,mountHeaderRename,
  createGrid:(_host:any,_columns:any,rowCapacity:number,extraColumns:number)=>{const grid={rowCapacity,extraColumns,painted:[] as any[],disposed:false,selection:{rowIndex:0,colIndex:0},dispose(){this.disposed=true;},getSelection(){return this.selection;},selectCell(rowIndex:number,colIndex:number){this.selection={rowIndex,colIndex};},getSelectionRange:()=>({startRow:0,endRow:0,startCol:0,endCol:0}),getReviewFrame:()=>null,getDiag:()=>({}),getCellText:()=>values.get(opens.at(-1)!)??'',isEditing:()=>false,
    adoptColumns:()=>false,scrollToRow:()=>{},markReviewCells:()=>()=>{},onRowHeight:()=>{},onScroll:()=>{},wrapColumn:()=>{},getCellStyle:()=>undefined,onCommit:()=>{},onSelection:()=>{},onLayout:()=>{},onBlockedCommand:()=>{},onReadOnlyEdit:()=>{},onViewport:()=>{},onColumnWidth:()=>{},setCellStyles:()=>{},setRows:()=>{},setRowValue(row:number,field:string,value:unknown){this.painted.push({row,field,value});},setFreeze:()=>{},setColumnHeaders:()=>{},setColumnWidths:()=>{},setRowHeights:()=>{},snapshotColumnWidths:()=>{},recalcAutoHeights:()=>{},};grids.push(grid);return grid;},
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
let hold=true,release!:()=>void,held=false,lost=0,active=0,maxActive=0;
const heldResponse=new Promise<void>(r=>release=r);
async function actualFetch(url:any,options:any={}){
 if(options.signal&&!(options.signal instanceof AbortSignal)){const controller=new AbortController(),source=options.signal;if(source.aborted)controller.abort();else source.addEventListener('abort',()=>controller.abort(),{once:true});options={...options,signal:controller.signal};}
 const input=/\/files\.sheet_(?:input_write|cells_write)\/execute$/.test(String(url));
 if(input){active++;maxActive=Math.max(maxActive,active);}
 try{const response=await transport(new URL(String(url),process.env.SS_BASE),{...options,headers:{...options.headers,cookie:process.env.SS_QUEUE_COOKIE}});
  if(input){const body=await response.clone().json();requests.push({payload:JSON.parse(options.body).payload,key:JSON.parse(options.body).idempotency_key,status:response.status,result:body.result});
   if(hold){hold=false;held=true;await heldResponse;}
   if(lost>0){lost--;throw new TypeError('controlled dropped response AFTER actual server success');}}
  return response;
 }finally{if(input)active--;}
}
globalThis.fetch=actualFetch;
const h=setup();h.context.openTable=actualOpenTable;h.context.fetch=actualFetch;
// Execute the product observation function too; only grid rendering remains a test boundary.
const fact=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reportActionFact')!;
h.context._pendingActionFacts=[];runInNewContext(ts.transpileModule(fact.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.reportActionFact=reportActionFact;',h.context);
try{
 const api=await h.mountPage();const event=(colIndex:number,fieldId:string,value:string,before:string)=>({rowIndex:0,colIndex,fieldId,value,before,type:colIndex===1?'decimal':'text'});
 api.onCommit(event(2,'备注','第一普通值','原备注'));await settled(()=>held,h.errors);
 api.onCommit(event(1,'金额','731.25','10.5'));api.onCommit(event(2,'备注','最新普通值','第一普通值'));
 check('three queued inputs dispatch one request while response held',requests.length===1&&h.context.excelPageDiag().inputQueue.length===3);
 release();await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);
 check('ordinary/formal/same-cell inputs all use one serial public input path',requests.length===3&&maxActive===1&&requests.every(r=>r.status===200));
 check('each next request adopts prior authoritative content version',requests.slice(1).every((r,i)=>r.payload.expected_content_version===requests[i].result.content_version));
 check('three confirmed input operations yield three own undo steps',h.context.excelPageDiag().undo.stackSize===3&&new Set(requests.map(r=>r.key)).size===3);
 check('late first receipt does not overwrite newest same-cell preview',h.grids.at(-1).painted.filter((r:any)=>r.field==='备注').at(-1).value==='最新普通值');
 lost=3;api.onCommit(event(1,'金额','812.5','731.25'));api.onCommit(event(2,'备注','恢复后普通值','最新普通值'));
 await settled(()=>h.context.excelPageDiag().inputQueue[0]?.state==='failed',h.errors);
 check('three actual successful responses dropped preserve two pending inputs',requests.length===6&&h.context.excelPageDiag().inputQueue.length===2&&h.context.excelPageDiag().inputQueue[1].text==='恢复后普通值');
 check('lost-response automatic retries use same operation and payload',requests.slice(3).every(r=>r.key===requests[3].key&&JSON.stringify(r.payload)===JSON.stringify(requests[3].payload)));
 (h.host.querySelector('[data-retry]') as HTMLElement).click();await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);
 check('manual retry resolves original operation then continues next input',requests.length===8&&requests[6].key===requests[3].key&&requests[7].payload.expected_content_version===requests[6].result.content_version);
 console.log('QUEUE_REQUESTS',JSON.stringify(requests));console.log('RESULT',checks.length,'/',checks.length);
}finally{h.close();globalThis.fetch=transport;}
