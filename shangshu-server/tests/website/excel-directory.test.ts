import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {needsFormulaRefresh,wroteFormula} from '../../../shangshu-web/js/domains/excel-univer/src/formula-values.ts';
import {retrySave} from '../../../shangshu-web/js/domains/excel-univer/src/save-retry.ts';
import {fontStyleToUniver} from '../../../shangshu-web/js/domains/excel-univer/src/font-style.ts';
import {mountEditAnchor} from '../../../shangshu-web/js/domains/excel-univer/src/edit-anchor.ts';
import {createInlineReviewController,proposalTargetTable} from '../../../shangshu-web/js/domains/excel-univer/src/inline-review.ts';
const engineRequire=createRequire(new URL('../../../shangshu-web/js/domains/excel-univer/package.json',import.meta.url));
const {CellValueType,Plugin,Injector,Inject,UniverInstanceType,VerticalAlign}=engineRequire('@univerjs/core');
import { parseClipboardTsv, serializeClipboardTsv } from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';
import { mountDirectory } from '../../../shangshu-web/js/domains/excel-univer/src/directory.ts';
import { editedProposalValue } from '../../../shangshu-web/js/domains/excel-univer/src/proposal-view.ts';
// ⚠️ 2026-10-30（PKG-133）：下面这些判据把 `main.ts` 的**函数片段**抽出来在沙箱里跑
//   （`actualMainFunction`）⇒ 片段用到的**导入件**与**闭包变量**沙箱里没有就会 ReferenceError。
//   按仓库里已有的先例（shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs：
//   片段用到的导入件在沙箱 context 里补上，补的是**真的那个**），这里补：
import { decideExtendWrite } from '../../../shangshu-web/js/domains/excel-univer/src/write-gate.ts';   // writeRange 的越界写入闸
import { createLatestRead } from '../../../shangshu-web/js/lib/latest-read.mjs';                      // runSearch 的「一次读一个作用域」
import { columnHeaderCfg } from '../../../shangshu-web/js/domains/excel-univer/src/managed-header-style.ts'; // sheet.ts 的列头样式配置
// 通过 = 复用文件中心容器；所有表能翻页找到；返回保留搜索；旧响应不覆盖新搜索。
const rows = Array.from({length:27}, (_, i) => ({key:String(i), title:`表 ${i}`, kind:'xlsx' as const}));
/**
 * **契约 2026-10-28 更新（PKG-132 · R11）**：loader 给回的是**这一页**
 * （**页码由服务端决定读取范围**）⇒ 目录页**不再本地分页**，只保留「最多一页」的上限。
 * ⚠️ 下面两条判据原来钉的是**旧契约**（loader 给全量、浏览器分页）⇒ 已按新契约改写，
 *    **行为保证一条没减**：一页 20 条、第 2 页 7 条、页码信息正确、搜索/清除要重读。
 */
function pageOf(page:number, term=''){
 const filtered=term?rows.filter(r=>r.title.includes(term)):rows;
 const start=(page-1)*20;
 return {entries:filtered.slice(start,start+20), total:filtered.length, truncated:false};
}
function setup(load = async (_q:string,_page:number)=>pageOf(1), initial = {}) {
 const dom=new JSDOM('<div id="host"></div>'); const host=dom.window.document.querySelector('#host') as HTMLElement;
 let opened:any; const directory=mountDirectory(host,{load,initial,open:(key,state)=>opened={key,state},upload:()=>{}});
 return {dom,host,directory,opened:()=>opened,button:(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!};
}
const tick=()=>new Promise(r=>setTimeout(r,0));
test('shared layout, real pagination, no fake ownership filter',async()=>{
 const asked:number[]=[];
 const s=setup(async(_q:string,page:number)=>{asked.push(page);return pageOf(page);}); await s.directory.ready;
 assert.ok(s.host.querySelector('.file-content .file-table-area .file-table-scroll .file-table'));
 assert.equal(s.host.querySelectorAll('tbody tr[data-table]').length,20); assert.equal(s.host.querySelector('[data-filter-scope]'),null);
 s.button('下一页').click(); await tick(); await tick();
 assert.ok(asked.includes(2),'翻页没有重新读（页码没交给服务端）');
 assert.equal(s.host.querySelectorAll('tbody tr[data-table]').length,7);
 assert.match(s.host.querySelector('[data-page-info]')!.textContent!,/第 2 \/ 2 页/);
 (s.host.querySelector('button.file-open[title="表 26"]') as HTMLButtonElement).click();
 assert.equal(s.opened().key,'26'); assert.equal(s.opened().state.page,2);
 assert.match(s.host.querySelector('button.file-open')!.textContent!,/文件工作簿/);
});
test('restore search/page and clear',async()=>{
 let term='';let page=0;
 const s=setup(async(q:string,p:number)=>{term=q;page=p;return pageOf(p,q);}, {term:'表',page:2});
 await s.directory.ready;assert.equal(term,'表');assert.equal(page,2,'恢复时没把页码交给服务端');
 assert.equal(s.host.querySelectorAll('tbody tr[data-table]').length,7);
 s.button('清除筛选').click();await tick();await tick();assert.equal(term,'');assert.equal(page,1,'清除筛选后页码要回到第 1 页');
 assert.equal(s.host.querySelectorAll('tbody tr[data-table]').length,20);
});
test('error is a valid table row, escaped, retryable',async()=>{
 const s=setup(async()=>{throw new Error('<img src=x onerror=alert(1)>')});await s.directory.ready;
 assert.equal(s.host.querySelector('tbody img'),null);assert.match(s.host.querySelector('tbody td')!.textContent!,/img src/);
 assert.equal(s.host.querySelector('tbody td')!.getAttribute('colspan'),'5');assert.ok(s.button('重试'));
});
test('late response cannot replace newer search',async()=>{
 let resolve:any;const s=setup((q:string)=>q==='new'?Promise.resolve({entries:[],total:0,truncated:false}):new Promise(r=>resolve=r));
 const input=s.host.querySelector('input[type=search]') as HTMLInputElement;input.value='new';input.dispatchEvent(new s.dom.window.Event('input'));
 await new Promise(r=>setTimeout(r,300));resolve({entries:rows,total:27,truncated:false});await s.directory.ready;
 assert.match(s.host.querySelector('tbody')!.textContent!,/没有匹配/);assert.equal(s.host.querySelectorAll('[data-table]').length,0);
});
test('truncation reports actual loaded versus total',async()=>{
 // 服务端说「只给了这些、还有更多」⇒ 计数里要写**它给了多少**（不是渲染了几行）。
 const s=setup(async()=>({entries:rows,total:200,truncated:true}));await s.directory.ready;
 assert.match(s.host.querySelector('[data-count]')!.textContent!,/已加载 27.*200/);
});
test('dispose prevents late repaint',async()=>{
 let resolve:any;const s=setup(()=>new Promise(r=>resolve=r));s.directory.dispose();s.host.textContent='other page';
 resolve({entries:rows,total:27,truncated:false});await s.directory.ready;assert.equal(s.host.textContent,'other page');
});
// 通过 = 引擎接收到系统绿色选区、13px正文/28px表头和Excel默认底对齐；编号仍按文本装填。
test('Excel网格沿系统令牌呈现，字号单位正确且显示配置不改变文本值',()=>{
 const dom=new JSDOM('<div id="grid" style="--green:#10b981;--green2:#0ea372;--green-ink:#0a6e4c;--fg2:#374151;--sans:Arial"></div>');
 const host=dom.window.document.querySelector('#grid') as HTMLElement;
 let config:any,workbook:any,header:any,values:any;const heights:any[]=[],wraps:any[]=[],forced:any[]=[];const rowData:any={};let measuredFont='';
 (dom.window.HTMLCanvasElement.prototype as any).getContext=()=>({set font(v:string){measuredFont=v},measureText:(text:string)=>({width:Array.from(text).reduce((sum,ch)=>sum+(ch==='W'?13:ch.charCodeAt(0)>127?13:8),0)})});
 let selection:any={startRow:2,startColumn:1,endRow:3,endColumn:4};
 const ws={getRange:(row:number,col:number,numRows=1)=>({setValues:(next:any)=>{values=Array.isArray(next)?next:[next[Object.keys(next)[0]]];},getDisplayValue:()=>values?.[0]?.[col]?.v,setWrapStrategy:()=>wraps.push([row,col,numRows]),activateAsCurrentCell:()=>selection={startRow:row,startColumn:col,endRow:row,endColumn:col}}),
   getSelection:()=>({getActiveRange:()=>selection?{getRange:()=>selection}:null}),scrollToCell:()=>{},customizeColumnHeader:(next:any)=>header=next,setRowAutoHeight:(...a:any[])=>heights.push(a),setRowHeightsForced:(start:number,count:number,height:number)=>{forced.push([start,count,height]);for(let r=start;r<start+count;r++)rowData[r]={h:height,ia:0};},getColumnWidth:()=>100,getRowHeight:(row:number)=>rowData[row]?.h??24,getVisibleRange:()=>({startRow:0,endRow:99}),getSheet:()=>({getSnapshot:()=>({rowData})})};
 const exports:any={};
 const src=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'');
 const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 runInNewContext(js,{exports,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),
   defaultTheme:{primary:{500:'#2563eb'},green:{500:'#16a34a'}},merge:(...parts:any[])=>Object.assign({},...parts),LocaleType:{ZH_CN:'zhCN'},VerticalAlign,CellValueType,Plugin,Injector,Inject,UniverInstanceType,fontStyleToUniver,mountEditAnchor,columnHeaderCfg,
   sheetsCoreZhCN:{},univerDesignCss:'',univerUiCss:'',univerSheetsUiCss:'',univerSheetsCoreCss:'',UniverSheetsCorePreset:(x:any)=>x,
   createUniver:(options:any)=>{config=options;return {univer:{createUnit:(_type:any,next:any)=>workbook=next,dispose:()=>{}},univerAPI:{Enum:{UniverInstanceType:{UNIVER_SHEET:2}},Event:{},addEvent:()=>({dispose:()=>{}}),getWorkbook:()=>({getSheetBySheetId:()=>ws})}};},
 });
 try{
  const grid=exports.createGrid(host,[{fieldId:'number',label:'编号',type:'text',readOnly:false},{fieldId:'date',label:'日期',type:'text',readOnly:false}],15550);
  assert.equal(config.theme.primary[500],'#10b981');
  assert.equal(config.presets[0].contextMenu,false,'未接受管保存的原生右键命令不能冒充可用功能');
  assert.equal(workbook.defaultStyle.fs,9.75,'fs以pt计；9.75pt对应13个CSS像素');
  assert.equal(workbook.defaultStyle.vt,VerticalAlign.BOTTOM);assert.equal(workbook.defaultStyle.cl.rgb,'#374151');
  assert.equal(workbook.sheets['sheet-b1'].columnHeader.height,28);
  assert.equal(workbook.sheets['sheet-b1'].defaultStyle.vt,VerticalAlign.BOTTOM,'引擎绘制读取的是worksheet默认样式');
  assert.equal(config.presets[0].disableTextFormatAlert,true,'@文本格式另有numfmt提示，不能漏关');
  assert.equal(config.presets[0].disableTextFormatMark,true);
  assert.equal(config.presets[0].sheets.disableForceStringAlert,true,'文本编号不是错误，不能出现转换数值警告浮块');
  assert.equal(config.presets[0].sheets.disableForceStringMark,true);
  assert.deepEqual(JSON.parse(JSON.stringify(grid.getSelection())),{rowIndex:2,colIndex:1},'官方FSelection对象必须能读取起点');
  assert.deepEqual(JSON.parse(JSON.stringify(grid.getSelectionRange())),{startRow:2,startCol:1,endRow:3,endCol:4},'2行4列范围不能按数组选区误读为无选区');
  grid.selectCell(5,4);assert.deepEqual(JSON.parse(JSON.stringify(grid.getSelection())),{rowIndex:5,colIndex:4});
  selection=null;assert.equal(grid.getSelectionRange(),null);
  grid.setColumnHeaders(['编号']);assert.equal(header.headerStyle.fontSize,12);assert.equal(header.columnsCfg[0],'编号');
  const raw=['00123','2026-10-14T00:00:00'];
  grid.setRow(0,raw,['text','date'],[{font_size:15,bold:true},undefined]);assert.equal(values[0][0].v,'00123');assert.equal(values[0][0].t,CellValueType.STRING);
  assert.equal(values[0][0].s.fs,15,'显式字体不能被默认9.75pt覆盖');assert.equal(values[0][0].s.bl,1,'原粗体必须保留');
  assert.equal(values[0][1].v,46309);assert.equal(values[0][1].s.n.pattern,'yyyy-mm-dd');assert.equal(raw[1],'2026-10-14T00:00:00','不能改动原始读取值');
  assert.equal(grid.getRowValue(0,'date'),'2026-10-14T00:00:00','编辑before必须保持原值');
  assert.equal(grid.getCellText(0,1),'2026-10-14','复制出口与工作面日期呈现必须一致');
  grid.setRow(1,['00123','2026-10-14T13:20:00']);assert.equal(values[0][1].v,'2026-10-14T13:20:00');
  grid.setRow(1,['00123','2026-10-14T13:20:00'],['text','date']);assert.equal(values[0][1].v,46309+800/1440);assert.equal(values[0][1].s.n.pattern,'yyyy-mm-dd hh:mm:ss');
  grid.setRow(2,['123456789012345678901234567890','2026-10-14T00:00:00'],['text','text']);assert.equal(values[0][1].v,'2026-10-14T00:00:00','普通文本不能被当日期截断');
  grid.wrapColumn(0);grid.wrapColumn(0);grid.recalcAutoHeights(0,3);
  assert.ok(forced.length>0,'真实字形测量应落实到行高字段，而不是只设ia等待未就绪skeleton');
  assert.ok(forced.every(a=>a[1]<=3),'15.5k行只计算已加载范围，不能全表自动行高');
  assert.equal(measuredFont,'13px Arial');assert.ok(grid.getDiag().rowHeights[2]>24,'实际行高字段须能容纳多行长ID');
  grid.setRow(3,['第一段\n第二段\n第三段',''],['text','text']);grid.recalcAutoHeights(3,1);assert.ok(grid.getDiag().rowHeights[3]>=64,'三段LF不能仅露最后一段');
  assert.ok(wraps.length<=3,'重复wrap不能再次物化整列空格');
  const numeric=exports.createGrid(host,[{fieldId:'mix',label:'金额',type:'decimal',readOnly:false}],20);
  numeric.setRow(0,['00123'],['text']);assert.equal(values[0][0].v,'00123');assert.equal(values[0][0].t,CellValueType.STRING);
  numeric.setRow(1,['非数字'],['text']);assert.equal(values[0][0].v,'非数字');
  numeric.setRow(2,[12.5],['number']);assert.equal(values[0][0].v,12.5);assert.equal(values[0][0].t,CellValueType.NUMBER);
  numeric.dispose();
  const startHeights=forced.length;for(let r=4;r<100;r++)grid.setRow(r,['行 '+r,'资料'],['text','text']);
  grid.recalcAutoHeights(0,100);assert.ok(forced.slice(startHeights).every(a=>a[1]<=100));
  grid.wrapColumn(0);assert.ok(wraps.every(a=>a[2]<=100),'100行装填不能产生15.5k行的style命令');
  grid.dispose();
 }finally{dom.window.close();}
});

// 直接执行产品中的 runUndo，夹具只替换 HTTP 与画布；通过 = 回执与可见值、本人步数一致。
/**
 * ★ 合并说明（2026-10-21）：backend.ts 的 `createXlsxTable` 合并后**带 export**
 *   （fast 那边就是导出的，ours 这边原来不是）。沙箱是用 vm 执行函数文本，
 *   `export` 关键字在里面是语法错误 ⇒ 这里只把函数文本**开头的 `export ` 去掉**，
 *   函数体一个字不改（跑的仍然是产品的真实实现，断言一条没删）。
 *   另：合并后 `createXlsxTable` 依赖同文件的模块级助手 `pasteValueTypes`
 *   （调用方没给列类型时，按列定义推一份 —— 编号列不转数字）。
 *   沙箱必须把它一起注入，否则粘贴那一路会 ReferenceError。
 */
function actualMainFunction(name:string,ctx:any,source='main.ts',also:string[]=[]){
 const file=ts.createSourceFile(source,readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/'+source,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
 const pick=(want:string)=>{let found:ts.FunctionDeclaration|undefined;const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===want)found=node;else ts.forEachChild(node,visit);};visit(file);return found;};
 const fn=pick(name);assert.ok(fn,'必须测试产品中的真实'+name);
 // 模块级助手先注入：它们是同一个文件的顶层函数，被目标函数按名字引用。
 for(const helper of also){const h=pick(helper);assert.ok(h,'必须测试产品中的真实'+helper);runInNewContext(ts.transpileModule(h.getText(file).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.'+helper+'='+helper+';',ctx);}
 const js=ts.transpileModule(fn.getText(file).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 runInNewContext(js+';globalThis.productFunction='+name+';',ctx);
 return ctx.productFunction;
}
function undoHarness(fetcher:(body:any)=>Promise<any>){
 const target={name:'r1',rowIndex:0,fieldId:'编号',fieldLabel:'编号',fieldType:'text',before:'00123',after:'00999',opId:'original-op'};
 const changes:any[]=[],requests:any[]=[];
 const ctx:any={hasUnsaved:()=>false,updateToolbar:()=>{},disposed:false,table:{kind:'xlsx',key:'sheet-one'},undoing:false,undoStack:[target],undoNoTarget:0,signal:new AbortController().signal,
  PAGE_LENGTH:100,pageCache:new Map([[1,[{name:'r1',编号:'00999'}]]]),nameToIndex:new Map([['r1',0]]),grid:{setRowValue:(...args:any[])=>changes.push(args),recalcAutoHeights:()=>{}},showSaveOverlay:()=>{},hideSaveOverlay:()=>{},notify:()=>{},describeError:String,rebuildAfterStructure:async()=>{},
  // ⚠️ `rowBehaviors` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 837 行）——
  //   抽出来的 `runUndo` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError。
  //   沙箱补上产品的「没有业务行行为」那个值（null）。
  rowBehaviors:null,
  fetch:async(_url:string,options:any)=>{const body=JSON.parse(options.body);requests.push(body);return fetcher(body);}};
 ctx.grid.getSelection=()=>null;ctx.needsFormulaRefresh=needsFormulaRefresh;ctx.wroteFormula=wroteFormula;ctx.refreshLoadedFormulaValues=async()=>changes.push(['formula-refresh']);
 ctx.syncFontControls=actualMainFunction('syncFontControls',ctx);
 ctx.executeUndo=actualMainFunction('runUndo',ctx);
 return {ctx,changes,requests,target};
}
// 新后端契约（2799f596）：before=撤回后恢复到的新值，after=撤回前的当前值。
// 断言不变：画布最终必须是 00123（撤回前是 00999）。
const undoOk=()=>({ok:true,status:200,json:async()=>({ok:true,result:{cells:[{row_id:'r1',header:'编号',before:{value:'00123'},after:{value:'00999'}}],skipped:[]}})});
test('Excel撤回成功使用回执after刷新画布，只消耗一次本人操作',async()=>{
 const t=undoHarness(async()=>undoOk());await t.ctx.executeUndo();
 assert.deepEqual(t.changes[0].slice(0,3),[0,'编号','00123']);assert.equal(t.ctx.pageCache.get(1)[0]['编号'],'00123','撤回不能只改画布，重绘缓存也须一致');assert.equal(t.ctx.undoStack.length,0);
 await t.ctx.executeUndo();assert.equal(t.requests.length,1);
});
function pasteHarness(){
 const calls:any[]=[],notices:string[]=[];
 const ctx:any={updateToolbar:()=>{},openingTable:false,pasteApplying:false,hasUnsaved:()=>false,parseClipboardTsv,disposed:false,columns:[{fieldId:'编号',label:'编号',type:'text'},{fieldId:'长号',label:'长号',type:'text'},{fieldId:'日期',label:'日期',type:'date'},{fieldId:'金额',label:'金额',type:'decimal'}],
  table:{writable:true,kind:'xlsx',pasteApply:async(args:any)=>{calls.push(args);return {cells:[],rowsAdded:0,colsAdded:0,actionCount:1};}},
  grid:{getSelection:()=>({rowIndex:2,colIndex:0}),recalcAutoHeights:()=>{}},el:{scope:{}},undoStack:[],totalRows:10,filled:new Set(),nameToIndex:new Map(),
  showSaveOverlay:()=>{},hideSaveOverlay:()=>{},notify:(text:string)=>notices.push(text),describeError:String,reportActionFact:async()=>{}};
 Object.assign(ctx,{retrySave,needsFormulaRefresh,wroteFormula,refreshLoadedFormulaValues:async()=>calls.push({formulaRefresh:true}),pendingInput:null,exportCapabilities:{canStructure:true},inlineControllers:new Map(),pageCache:new Map(),PAGE_LENGTH:100,newIdempotencyKey:()=> 'paste-'+calls.length,setSaveState:()=>{},renderSaveBar:()=>{},refreshAppendedRows:async()=>false,rebuildAfterStructure:async()=>{},loadPage:async()=>[],
  // ⚠️ `rowBehaviors` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 837 行）——
  //   抽出来的 `writeRange`/`handlePaste` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError。
  //   沙箱补上产品的「没有业务行行为」那个值（null）。
  rowBehaviors:null,
  // ⚠️ `decideExtendWrite` 是 main.ts 的**顶层 import**（越界写入那道闸）——
  //   片段在真代码里用的是真的那个，这里补上**真的那个**（公共件里的纯函数）。
  decideExtendWrite,
  // ★ 合并说明（2026-10-21）：合并后 writeRange 多了一句「还有保存/列宽/文件操作没核实 ⇒ 不许粘贴」
  //   （fast 那边的闸）。这三个是**挂载函数的闭包变量**，沙箱只执行单个函数时取不到 ⇒ 补上。
  pending:new Map(),pendingWidths:new Map(),pendingFileOperations:new Map()});
 ctx.writeRange=actualMainFunction('writeRange',ctx);
 return {run:actualMainFunction('handlePaste',ctx),calls,notices,ctx};
}
test('Excel同表复制后按目标列类型粘贴，文本编号不推导数字而金额可正常保存',async()=>{
 const t=pasteHarness();await t.run('00123\t123456789012345678\t2026-10-14\t12.50\n00124\t123456789012345679\t2026-10-15\t3.25');
 assert.equal(t.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(t.calls[0].matrixTypes)),[['text','text','date','number'],['text','text','date','number']]);
 assert.equal(t.calls[0].matrix[0][0],'00123');assert.equal(t.calls[0].matrix[0][1],'123456789012345678');assert.equal(t.calls[0].matrix[0][3],'12.50');
 const invalid=pasteHarness();await invalid.run('00123\t123456789012345678\t2026-10-14\t不是金额');assert.equal(invalid.calls.length,0);assert.match(invalid.notices.join(' '),/金额.*数字/);
});
test('Excel撤回网络失败或明确拒绝保留原栈，重试沿用原操作编号',async()=>{
 let fail=true;const t=undoHarness(async()=>{if(fail)throw new Error('connection lost');return undoOk();});
 await t.ctx.executeUndo();assert.equal(t.ctx.undoStack[0],t.target);assert.equal(t.changes.length,0);
 fail=false;await t.ctx.executeUndo();assert.equal(t.ctx.undoStack.length,0);assert.deepEqual(t.requests[1],t.requests[0]);
 const rejected=undoHarness(async()=>({ok:false,status:409,json:async()=>({ok:false,error:'version conflict'})}));
 await rejected.ctx.executeUndo();assert.equal(rejected.ctx.undoStack[0],rejected.target);assert.equal(rejected.changes.length,0);
});

test('Excel单格保存成功不重复计入本人三步撤回栈',async()=>{
 const op:any={key:'one',name:'r1',rowIndex:0,fieldId:'编号',fieldLabel:'编号',fieldType:'text',before:'00123',text:'00999',value:'00999'};
 const ctx:any={disposed:false,table:{writeCell:async()=>({contentVersion:2})},pending:new Map([['one',op]]),undoStack:[{opId:'one'}],pageCache:new Map(),PAGE_LENGTH:100,
  setSaveState:()=>{},reportActionFact:async()=>{},rebuildAfterStructure:async()=>{},columns:[],notify:()=>{},describeError:String,
  // ⚠️ `rowBehaviors` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 837 行）——
  //   抽出来的 `runSave` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError。
  //   沙箱补上产品的「没有业务行行为」那个值（null）。
  rowBehaviors:null,loadPage:async()=>[]};
 ctx.retrySave=retrySave;ctx.wroteFormula=wroteFormula;ctx.grid={setRowValue:()=>{throw Error('successful save must not restore old value')}};
 await actualMainFunction('runSave',ctx)(op);assert.equal(ctx.pending.size,0);assert.equal(ctx.undoStack.length,1,'onCommit登记过的同一操作不能再push一次');
});
test('Excel撤回回执推进版本，下一次粘贴用新版本且切表不串画布',async()=>{
 let version=1;const t=undoHarness(async()=>({ok:true,status:200,json:async()=>({ok:true,result:{content_version:3,structure_version:1,cells:[{row_id:'r1',header:'编号',after:{type:'text',value:'00123'}}],skipped:[]}})}));
 t.ctx.table.adoptVersions=(v:any)=>version=v.contentVersion;await t.ctx.executeUndo();assert.equal(version,3);
 let release:any;const changed=undoHarness(()=>new Promise(r=>release=r));const running=changed.ctx.executeUndo();
 changed.ctx.table={kind:'xlsx',key:'another'};release(undoOk());await running;assert.equal(changed.changes.length,0,'旧表撤回回执不能写入新表');
});
test('Excel粘贴保留quoted单元格换行和制表符，损坏剪贴板零写并可见拒绝',async()=>{
 const t=pasteHarness();await t.run('"格内\n换行"\t"含\tTAB"\t2026-10-14\t12.50');assert.equal(t.calls.length,1);assert.equal(t.calls[0].matrix.length,1);assert.equal(t.calls[0].matrix[0][0],'格内\n换行');
 const bad=pasteHarness();await bad.run('"未闭合');assert.equal(bad.calls.length,0);assert.ok(bad.notices.length);
});
test('Excel查找只取首批命中，不逐条加载全表，状态不会被查找条擦掉',async()=>{
 const calls:any[]=[],located:number[]=[],searchRows=Array.from({length:100},(_,i)=>({name:'r'+i,编号:'实用新型'}));
 const ctx:any={PAGE_LENGTH:100,searchSeq:0,disposed:false,table:{search:async(...args:any[])=>{calls.push(args);return {rows:searchRows,total:15500};}},
 el:{searchClear:{},searchCount:{},searchInput:{value:'实用新型'},searchPrev:{},searchNext:{}},hits:[],hitIndex:-1,searchTerm:'',searchPage:0,searchTotalRows:0,searchLoadedRows:0,searchLoading:false,
 columns:[{fieldId:'编号',label:'编号',type:'text'}],nameToIndex:new Map(),getRowViewMetadata:()=>undefined,
 findAllHits:(r:any)=>[{fieldId:'编号',fieldLabel:'编号',snippet:r.编号}],resolveIndex:async()=>{throw new Error('不得逐条定位')},dropHighlight:null,clearFind:()=>{},
 goToHit:async(i:number)=>located.push(i),
  // ⚠️ `searchReads` / `searchTicket` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 3560/3561 行）——
  //   抽出来的 `runSearch`/`appendSearchPage` 片段在真代码里看得见它们，在这里看不见 ⇒ ReferenceError。
  //   沙箱补上**真的那个** `createLatestRead`（公共件里的原物），以及「还没开始查」的票根。
  searchReads:createLatestRead(undefined),searchTicket:null,signal:new AbortController().signal};
 ctx.clearTimeout=clearTimeout;ctx.searchTimer=undefined;ctx.cancelSearchTimer=actualMainFunction('cancelSearchTimer',ctx);
 ctx.renderFindBar=actualMainFunction('renderFindBar',ctx);ctx.appendSearchPage=actualMainFunction('appendSearchPage',ctx);
 await actualMainFunction('runSearch',ctx)('实用新型');assert.equal(calls.length,1);assert.equal(located.length,1);assert.equal(ctx.hits.length,100);assert.match(ctx.el.searchCount.textContent,/15500/);
 ctx.hits=[];ctx.el.searchCount.textContent='无匹配';ctx.renderFindBar();assert.equal(ctx.el.searchCount.textContent,'无匹配');
});
// 产品已改为游标口（BASE967-44 / 09f63942）：先摘要、再按表过滤的 cursor 列表。
// 测试通过 = 两次 GET 走对地址，且只保留已明确绑定本表的提案。
test('Excel提案查询走游标口并按表过滤',async()=>{
 const urls:string[]=[];
 const ctx:any={disposed:false,table:{kind:'xlsx',key:'sheet-one'},signal:new AbortController().signal,proposals:[],proposalSummary:{},proposalsHasMore:false,inlineControllers:new Map(),window:{shangshuInlineReviews:new Map()},prepareInlineReviews:async()=>{},proposalTargetTable,notify:(message:string)=>{throw Error(message)},describeError:String,renderProposals:()=>{},console,
  // ⚠️ `table.kind` 少了 ⇒ 产品按 `table.resourceId ?? (kind==='xlsx' ? key : null)` 算「这张表的
  //   晋升徽标要查哪张表」时算出 null ⇒ 第三个 GET（files.promotion_status）压根不发 ⇒ 断言 urls.length===3 红。
  //   沙箱补上「这是一张文件表（xlsx）」——产品里 `table.kind` 一直都有。
  // ⚠️ `URLSearchParams` 是**浏览器 API**，不是 ECMAScript 内建对象 ——
  //   `runInNewContext` 出来的沙箱里没有它 ⇒ 产品拼徽标查询串时 ReferenceError，
  //   被那段自己的 catch 兜住（「徽标没拉到不挡列表」）⇒ 第三个 GET 仍然不发。
  URLSearchParams,
  fetch:async(u:any)=>{urls.push(String(u));
   if(String(u).includes('action-proposal-summary'))return {ok:true,json:async()=>({counts:{Proposed:3}})};
   if(String(u).includes('action-proposals?'))return {ok:true,json:async()=>({items:[
    {id:'p1',table:'sheet-one',payload:{}},{id:'p2',table:'other',payload:{}},{id:'p3',payload:{}}],has_more:false})};
   return {ok:true,json:async()=>({result:{}})};}};
 await actualMainFunction('loadProposals',ctx)();
 assert.equal(urls.length,3);assert.match(urls[2],/files.promotion_status/);assert.match(urls[0],/action-proposal-summary\?status=Proposed/);
 assert.match(urls[1],/action-proposals\?status=Proposed&limit=50/);
 assert.deepEqual(ctx.proposals.map((p:any)=>p.id),['p1'],'按表过滤：其他表及缺失目标的提案不混入');
});
// 回落路径：两个游标 GET 都不可用时，仍走旧动作并带平台 payload 信封。
test('Excel提案游标口不可用时回落旧payload信封',async()=>{
 let body:any,url='';
 const ctx:any={disposed:false,table:{key:'sheet-one'},signal:new AbortController().signal,proposals:[],proposalSummary:{},proposalsHasMore:false,inlineControllers:new Map(),window:{shangshuInlineReviews:new Map()},prepareInlineReviews:async()=>{},proposalTargetTable,notify:(message:string)=>{throw Error(message)},describeError:String,renderProposals:()=>{},console,
  fetch:async(u:any,o:any)=>{url=String(u);
   if(String(u).includes('action-proposal-summary')||String(u).includes('action-proposals?'))
    return {ok:false,status:404,json:async()=>({})};
   body=JSON.parse(o.body);return {ok:true,json:async()=>({proposals:[]})};}};
 await actualMainFunction('loadProposals',ctx)();
 assert.match(url,/files\.action_proposals\/invoke/);
 assert.deepEqual(body,{payload:{table:'sheet-one'}});
});

test('Excel真实适配器粘贴→撤回→再粘贴沿同一版本链继续保存',async()=>{
 const requests:any[]=[];let receiptVersion=2;
 // ★ 合并说明（2026-10-21）：合并后 backend 的粘贴回执**要完整性校验** ——
 //   回执里必须带 `table`（对得上这张表）、整数版本号、逐格回包，缺一項就当「没核实」。
 //   真实服务端 `_write_range` 本来就回表信息，我们这条线的回执契约一直要求表对得上
 //   ⇒ 这里把 `table` 补进 mock（**不是**放宽生产代码的校验）。
 const env:any={fetch:async(_url:any,opt:any)=>{const body=JSON.parse(opt.body);requests.push(body.payload);return {ok:true,json:async()=>({ok:true,result:{table:'sheet-one',content_version:receiptVersion++,structure_version:1,cells:[]}})};}};
 const realTable=actualMainFunction('createXlsxTable',env,'backend.ts',['pasteValueTypes'])({tableId:'sheet-one',sheetId:'s1',columns:[],totalRows:1,contentVersion:1,structureVersion:1,writable:true,columnWidths:{}});
 const opts={startRow:0,startCol:0,matrix:[['00123']],matrixTypes:[['text']],opId:'paste-one'};
 await realTable.pasteApply(opts);assert.equal(requests[0].expected_content_version,1);
 const t=undoHarness(async()=>({ok:true,status:200,json:async()=>({ok:true,result:{content_version:3,structure_version:1,cells:[],skipped:[]}})}));
 t.ctx.table=realTable;await t.ctx.executeUndo();
 await realTable.pasteApply({...opts,opId:'paste-two'});assert.equal(requests[1].expected_content_version,3,'撤回回执必须推进真实backend闭包版本');
});
test('Excel搜索后续命中按需取页，超过10000行仍能下一批定位且使用回包坐标',async()=>{
 const calls:any[]=[],loads:any[]=[],scrolled:any[]=[];const ctx:any={PAGE_LENGTH:100,searchSeq:1,disposed:false,searchLoading:false,searchTerm:'专利',searchPage:100,searchTotalRows:15500,searchLoadedRows:10000,
 hits:[{name:'r0',rowIndex:0,fieldId:'编号'}],hitIndex:0,nameToIndex:new Map(),columns:[{fieldId:'编号',label:'编号'}],el:{searchCount:{},searchInput:{value:'专利'},searchClear:{},searchPrev:{},searchNext:{}},dropHighlight:null,
 getRowViewMetadata:(r:any)=>({rowIndex:r.pos}),findAllHits:()=>[{fieldId:'编号',fieldLabel:'编号',snippet:'专利'}],
 table:{search:async(...args:any[])=>{calls.push(args);return {total:15500,rows:[{name:'r10000',编号:'专利',pos:12300}]};}},
 resolveIndex:async()=>{throw new Error('回包已带位置，禁止逐页扫描')},loadPage:async(p:any)=>loads.push(p),
 grid:{scrollToRow:(...a:any[])=>scrolled.push(a),selectCell:()=>{},highlightCell:()=>()=>{}},
  // ⚠️ `searchTicket` 是 `mountExcelPage` 的**闭包变量**（main.ts 第 3561 行）——
  //   抽出来的 `appendSearchPage` 片段在真代码里看得见它，在这里看不见 ⇒ ReferenceError
  //   （异常被 goToHit 的 catch 兜住 ⇒ 看起来像「搜索压根没发出去」）。
  //   沙箱补上「还没开始查」的票根（null ⇒ 搜索不带额外信号，与产品一致）。
  searchTicket:null,signal:new AbortController().signal};
 ctx.clearTimeout=clearTimeout;ctx.searchTimer=undefined;ctx.cancelSearchTimer=actualMainFunction('cancelSearchTimer',ctx);
 ctx.renderFindBar=actualMainFunction('renderFindBar',ctx);ctx.appendSearchPage=actualMainFunction('appendSearchPage',ctx);
 await actualMainFunction('goToHit',ctx)(1);assert.equal(calls[0][2],101);assert.deepEqual(loads,[124]);assert.equal(scrolled[0][0],12300);assert.match(ctx.el.searchCount.textContent,/15500/);
});

test('Excel数值目标拒绝前导零文本和超精度数字，整包零写且说明原因',async()=>{
 for(const value of ['00123','123456789012345678','1.2345678901234567']){const t=pasteHarness();await t.run('编号\t长号\t2026-10-14\t'+value);assert.equal(t.calls.length,0);assert.match(t.notices.join(' '),/前导零|精度|文本/);}
});
// Retired callResolve has no production callers. Exercise current unit accept and chat reject.
function reviewHarness(failed=false,type='text'){
 const descriptor:any={id:'p1',capability:'files.sheet_cells_write',status:'proposed',created_via:'ai',review_revision:'v1',target:{module:'excel',table:'t1'},remaining:1,accepted_count:0,units:[{unit_id:'u1',label:'编号',kind:'cell',target:{row_id:'r1',header:'编号'},value:{type,value:type==='number'?9:'原文'},current_value:{type,value:type==='number'?0:'old'},status:'pending'}]};
 const calls:any[]=[],reads:any[]=[],progress:any[]=[];let blocked=false;
 const controller=createInlineReviewController({descriptor,newKey:()=> 'review-op',blocking:()=>blocked,coerce:(_u,text)=>({type:type as any,value:type==='number'?Number(text):text}),change(){},progress:d=>progress.push(d),readback:async(_d,values)=>{reads.push(values);},fetcher:async(url,init)=>{const body=JSON.parse(String(init?.body));calls.push({url,body});return new Response(JSON.stringify(failed?{ok:true,result:{proposal:{id:'p1',status:'failed'}}}:{...descriptor,status:'confirmed',review_revision:'v2',remaining:0,accepted_count:1,accepted_units:['u1'],units:descriptor.units.map((u:any)=>({...u,status:'accepted'}))}));}});
 return {controller,calls,reads,progress,block:()=>blocked=true};
}
test('Excel当前inline审核保留人工文本编号并独立回读后完成',async()=>{
 const t=reviewHarness();try{t.controller.setEdit('u1','00123');assert.ok(await t.controller.acceptUnit('u1'));
 assert.match(String(t.calls[0].url),/action-proposals\/p1\/accept$/);assert.deepEqual(t.calls[0].body,{op_id:'review-op',expected_review_revision:'v1',units:['u1'],edited_value:{u1:{type:'text',value:'00123'}}});
 assert.equal(t.reads[0][0].value.value,'00123');assert.equal(t.progress.length,1);assert.equal(t.controller.hasEdits(),false);
 }finally{t.controller.dispose();}
});
test('Excel审核不能以HTTP200冒充成功，失败保留数值编辑且未保存时零确认',async()=>{
 const t=reviewHarness(true,'number');try{t.controller.setEdit('u1','12.5');assert.equal(await t.controller.acceptUnit('u1'),null);assert.equal(t.calls[0].body.edited_value.u1.type,'number');assert.equal(t.calls[0].body.edited_value.u1.value,12.5);assert.equal(t.controller.value('u1'),'12.5');assert.equal(t.controller.descriptor.remaining,1);assert.equal(t.reads.length,0);assert.equal(t.progress.length,0);assert.ok(t.controller.error);t.block();assert.equal(await t.controller.acceptUnit('u1'),null);assert.equal(t.calls.length,1);}finally{t.controller.dispose();}
});
test('Excel聊天实际驳回入口保留rejected决定且不调用accept',async()=>{
 const dom=new JSDOM('<section id="chat"></section>',{url:'http://localhost/index.html?object=t1#/excel',runScripts:'outside-only'}),w=dom.window as any,calls:any[]=[];
 try{w.esc=(x:any)=>String(x??'');w.money=String;w.toast=()=>{};w.chatScrollBottom=()=>{};w.chatUpdateFab=()=>{};w.chatConfirmFollowUp=async()=>{};
 w.api=async(url:any,init:any)=>{if(init?.method==='POST'){calls.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({id:'p1',status:'rejected'})};}return {ok:true,json:async()=>({id:'p1',status:'proposed',can_accept:true,can_reject:true,units:[],remaining:1,target:{module:'excel',table:'t1'}})};};
 const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
 w.chatAddConfirmCard(w.document.querySelector('#chat'),{id:'p1',capability:'files.sheet_cells_write',created_via:'ai',payload:{table:'t1'}});await tick();
 const button=Array.from(w.document.querySelectorAll('button')).find((b:any)=>/拒绝|驳回/.test(b.textContent)) as any;assert.ok(button);button.click();await tick();await tick();assert.equal(calls.length,1);assert.match(calls[0].url,/action-proposals\/p1\/resolve$/);assert.deepEqual(calls[0].body,{decision:'rejected'});assert.match(w.document.querySelector('[data-confirm-id]').textContent,/已拒绝.*未执行/);
 }finally{dom.window.close();}
});
test('Excel四次真实writeRange只保留最近三笔，逐笔撤回后第四次零请求',async()=>{
 const t=pasteHarness();let serial=0;
 t.ctx.newIdempotencyKey=()=> 'range-'+(++serial);
 t.ctx.table.key='sheet-one';
 // ★ 合并说明（2026-10-21）：回执要带 `headers`（真实后端 paste_apply 会回表头）。
 //   没有它，writeRange 判「列变了 ⇒ 要重建网格」，走到一半炸掉 ⇒ 这一笔会被记成
 //   「未核实的文件操作」，而合并后的新契约规定：**未核实的操作没处理完就不许下一次粘贴**。
 //   补上 headers 后四次粘贴都是**干净成功**，四次撤回栈断言测的仍是原来那件事。
 t.ctx.table.pasteApply=async()=>({cells:[{rowId:'r1',header:'编号',before:{value:'old'}}],headers:['编号','长号','日期','金额'],rowsAdded:0,colsAdded:0,actionCount:1});
 for(let n=0;n<4;n++)await t.ctx.writeRange([['value-'+n]]);
 assert.deepEqual(t.ctx.undoStack.map((x:any)=>x.opId),['paste-range-2','paste-range-3','paste-range-4']);
 const requests:any[]=[];Object.assign(t.ctx,{undoing:false,undoNoTarget:0,signal:new AbortController().signal,fetch:async(_url:string,init:any)=>{requests.push(JSON.parse(init.body));return {ok:true,json:async()=>({ok:true,result:{cells:[],skipped:[]}})};}});
 t.ctx.grid.getSelection=()=>null;t.ctx.syncFontControls=actualMainFunction('syncFontControls',t.ctx);
 const undo=actualMainFunction('runUndo',t.ctx);for(let n=0;n<4;n++)await undo();
 assert.equal(requests.length,3);assert.equal(t.ctx.undoStack.length,0);assert.deepEqual(requests.map(x=>x.payload?.op_id??x.op_id),['paste-range-4','paste-range-3','paste-range-2']);
});

test('Excel真实新建读取files.create返回的file并打开该表，失败不导航',async()=>{
 const requests:any[]=[],notices:any[]=[];const location={href:'http://localhost/index.html#/excel'};
 const ctx:any={el:{scope:{textContent:''}},signal:new AbortController().signal,location,URL,notify:(...a:any[])=>notices.push(a),fetch:async(_u:any,o:any)=>{requests.push(JSON.parse(o.body));return{ok:true,json:async()=>({result:{file:'real-created-file'}})}}};
 const create=actualMainFunction('createAndOpen',ctx);await create('我的表',{level:'personal'});
 assert.equal(new URL(location.href).searchParams.get('object'),'real-created-file');assert.deepEqual(requests[0].payload.attribution,{level:'personal'});
 assert.equal(requests[0].payload.file_name,'我的表.xlsx');location.href='http://localhost/';ctx.fetch=async()=>({ok:false,status:403,json:async()=>({error:'无权创建'})});
 await create('拒绝表',{level:'department',department:'ungranted'});assert.equal(location.href,'http://localhost/');assert.match(notices.at(-1)[0],/无权创建/);
});

test('Excel新建取消零调用，重复确认只创建一次且下次新建默认本人',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main')!,calls:any[]=[];
 const directory=mountDirectory(host,{load:async()=>({entries:[],total:0,truncated:false}),open(){},upload(){},create:(...args)=>calls.push(args)});
 try{await directory.ready;const click=(s:string)=>(host.querySelector(s) as HTMLButtonElement).click();
  click('[data-new-table]');click('[data-attribution-cancel]');click('[data-attribution-confirm]');assert.equal(calls.length,0);
  click('[data-new-table]');(host.querySelector('[data-attribution-name-input]') as HTMLInputElement).value='新表';click('[data-attribution-confirm]');click('[data-attribution-confirm]');assert.equal(calls.length,1);assert.equal(calls[0][1].level,'personal');await tick();
  (host.querySelector('[data-attribution-level]') as HTMLSelectElement).value='department';click('[data-new-table]');assert.equal((host.querySelector('[data-attribution-level]') as HTMLSelectElement).value,'personal');
 }finally{directory.dispose();dom.window.close();}
});

test('Excel新建未知结果保留归属与同键重试，确定拒绝后可修改',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main')!,calls:any[]=[];
 let mode='unknown';const directory=mountDirectory(host,{load:async()=>({entries:[],total:0,truncated:false}),open(){},upload(){},create:async(...args)=>{calls.push(args);return mode==='success'?{ok:true}:{ok:false,uncertain:mode==='unknown',error:'暂不能核实'};}});
 try{await directory.ready;const click=(s:string)=>(host.querySelector(s) as HTMLButtonElement).click();click('[data-new-table]');
  (host.querySelector('[data-attribution-name-input]') as HTMLInputElement).value='固定表';click('[data-attribution-confirm]');await tick();
  assert.equal((host.querySelector('[data-attribution-level]') as HTMLSelectElement).disabled,true);click('[data-attribution-cancel]');assert.equal((host.querySelector('[data-attribution-panel]') as HTMLElement).hidden,false);
  mode='success';click('[data-attribution-confirm]');await tick();assert.deepEqual(calls[1],calls[0]);assert.equal((host.querySelector('[data-attribution-panel]') as HTMLElement).hidden,true);
  click('[data-new-table]');(host.querySelector('[data-attribution-name-input]') as HTMLInputElement).value='可修改';mode='denied';click('[data-attribution-confirm]');await tick();assert.equal((host.querySelector('[data-attribution-level]') as HTMLSelectElement).disabled,false);
 }finally{directory.dispose();dom.window.close();}
});

test('Excel统一inputWrite按列类型传值并采用回执版本，明确HTTP拒绝保留status供队列处理',async()=>{
 const calls:any[]=[];let deny=false,version=5;
 const env:any={fetch:async(url:any,opt:any)=>{const body=JSON.parse(opt.body);calls.push({url,payload:body.payload,key:body.idempotency_key});return deny?{ok:false,status:403,json:async()=>({ok:false,error:'字段不可写'})}:{ok:true,status:200,json:async()=>({ok:true,result:{content_version:++version,structure_version:2,cells:[]}})};}};
 const table=actualMainFunction('createXlsxTable',env,'backend.ts',['pasteValueTypes'])({tableId:'mixed',sheetId:'s',columns:[{header:'备注',type:'text'},{header:'正式金额',type:'decimal',promoted:true}],totalRows:1,contentVersion:5,structureVersion:2,writable:true,columnWidths:{}});
 await table.inputWrite({startRow:0,startCol:0,matrix:[['00123']],matrixTypes:[['text']],opId:'ordinary'});
 await table.inputWrite({startRow:0,startCol:1,matrix:[['731.25']],matrixTypes:[['number']],opId:'formal'});
 assert.ok(calls.every(c=>c.url.endsWith('/files.sheet_input_write/execute')));assert.equal(calls[0].payload.value.value,'00123');assert.equal(calls[1].payload.value.type,'number');assert.equal(calls[1].payload.expected_content_version,6);assert.equal(table.contentVersion,7);deny=true;
 await assert.rejects(table.inputWrite({startRow:0,startCol:1,matrix:[['999']],matrixTypes:[['number']],opId:'rejected'}),(error:any)=>error.status===403&&/字段不可写/.test(error.message));assert.equal(table.contentVersion,7);
});

// —— FIX-12（2026-10-19 用户 A04 原话「点击上传-选择文件-选择归属-确认-上传」）——
// 测试通过 = 什么成立：点「上传表格」**先**打开文件选择器、此时还没弹归属面板；
// 文件选定后才弹归属面板（并显示已选文件名）；点「确认上传」才真的调上传。
test('Excel上传顺序＝选文件→选归属→确认→上传，取消不生成资源',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main')!,calls:any[]=[];
 const directory=mountDirectory(host,{load:async()=>({entries:[],total:0,truncated:false}),open(){},upload:(...args)=>calls.push(args),create:(...args)=>calls.push(args)});
 try{await directory.ready;
  const input=host.querySelector('[data-upload-input]') as HTMLInputElement;let fileDialogOpened=0;input.click=()=>{fileDialogOpened++;};
  const panel=host.querySelector('[data-attribution-panel]') as HTMLElement;
  (host.querySelector('[data-upload]') as HTMLButtonElement).click();
  assert.equal(fileDialogOpened,1,'点上传第一步就是选文件');
  assert.equal(panel.hidden,true,'还没选文件时不该先弹归属面板');
  const file=new dom.window.File(['x'],'试用表.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  Object.defineProperty(input,'files',{value:[file],configurable:true});
  input.dispatchEvent(new dom.window.Event('change'));
  assert.equal(panel.hidden,false,'选完文件才弹归属面板');
  const line=host.querySelector('[data-attribution-file]') as HTMLElement;
  assert.ok(line,'面板里要能看到已选文件名');
  assert.match(line.textContent||'',/试用表\.xlsx/,'面板要写清选的是哪个文件');
  (host.querySelector('[data-attribution-confirm]') as HTMLButtonElement).click();
  assert.equal(calls.length,1,'确认后才真的上传');
  assert.equal(calls[0][0].name,'试用表.xlsx');assert.equal(calls[0][1].level,'personal');
  (host.querySelector('[data-upload]') as HTMLButtonElement).click();
  Object.defineProperty(input,'files',{value:[new dom.window.File(['y'],'第二份.xlsx')],configurable:true});
  input.dispatchEvent(new dom.window.Event('change'));
  (host.querySelector('[data-attribution-cancel]') as HTMLButtonElement).click();
  assert.equal(calls.length,1,'取消不能生成资源');
  assert.equal(panel.hidden,true,'取消后面板要收起');
 }finally{directory.dispose();dom.window.close();}
});
