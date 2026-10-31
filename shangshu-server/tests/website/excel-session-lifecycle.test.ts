import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import {parseClipboardTsv,serializeClipboardTsv} from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';
// 整页生产挂载的脚手架抽到公共件（excel-mount-harness.ts），本文件只留用例。
import {setup,settled} from './excel-mount-harness.ts';
test('UI015 production mount: same-table open preserves steps; cross-table open clears',async()=>{
 const h=setup();try{const api=await h.mountPage();await api.writeRange([['已保存']],0,0);assert.equal(h.context.excelPageDiag().undo.stackSize,1);assert.equal(h.values.get('one'),'已保存');
  await api.openTableByKey('one');assert.equal(h.context.excelPageDiag().undo.stackSize,1);
  await api.openTableByKey('two');assert.equal(h.context.excelPageDiag().undo.stackSize,0);
  await api.openTableByKey('one');assert.equal(h.context.excelPageDiag().undo.stackSize,0);assert.equal(h.values.get('one'),'已保存');assert.deepEqual(h.opens,['one','one','two','one']);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('UI015 production mount: abort and fresh mount clear steps while saved content survives',async()=>{
 const h=setup();try{const first=await h.mountPage();await first.writeRange([['刷新前保存']],0,0);assert.equal(h.context.excelPageDiag().undo.stackSize,1);
  h.abort();assert.equal(h.context.excelPageDiag,undefined);assert.ok(h.grids[0].disposed);
  const second=await h.mountPage();assert.notEqual(first,second);assert.equal(h.context.excelPageDiag().undo.stackSize,0);assert.equal(h.values.get('one'),'刷新前保存');
  assert.equal(h.writes(),1);await second.runUndo();assert.equal(h.writes(),1,'empty new session sends no write');assert.equal(h.context.excelPageDiag().undo.noTarget,1);assert.equal(h.values.get('one'),'刷新前保存');assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});

test('UI005/013 production mount prelays blank area and rejects extension without structure permission before adapter call',async()=>{
 const h=setup();try{const api=await h.mountPage();assert.equal(h.grids[0].rowCapacity,51);assert.equal(h.grids[0].extraColumns,20);
  await api.writeRange([['right','down'],['both','corner']],3,4);
  assert.equal(h.requests.length,0);assert.equal(h.values.get('one'),'原值');assert.equal(h.context.excelPageDiag().undo.stackSize,0);assert.match(h.notifications.join(),/结构编辑权限/);
 }finally{h.close();}
});
test('UI012 clipboard ingress preserves quoted multiline text and leading zero; numeric invalid package sends zero requests',async()=>{
 const h=setup();try{const api=await h.mountPage();await api.handlePaste('"00123\n第二行"',0,0);assert.equal(h.values.get('one'),'00123\n第二行');assert.deepEqual(h.requests[0].matrix,[['00123\n第二行']]);assert.deepEqual(h.requests[0].matrixTypes,[['text']]);assert.equal(h.context.excelPageDiag().undo.stackSize,1);
 }finally{h.close();}
 const numeric=setup({columnType:'decimal',canStructure:true});try{const api=await numeric.mountPage();await api.handlePaste('00123',0,0);assert.equal(numeric.requests.length,0);assert.equal(numeric.values.get('one'),'原值');assert.match(numeric.notifications.join(),/前导零/);await api.handlePaste('12\nbad',0,0);assert.equal(numeric.requests.length,0,'invalid second row cannot partially write valid first row');assert.equal(numeric.values.get('one'),'原值');}finally{numeric.close();}
});
test('UI006 late successful write cannot paint or add a step to a newly opened table',async()=>{
 let release!:()=>void;const h=setup({beforeWrite:()=>new Promise<void>(resolve=>release=resolve)});try{const api=await h.mountPage();const pending=api.writeRange([['旧表在途']],0,0);await settled(()=>!!release,h.errors);await api.openTableByKey('two');release();await pending;
  assert.equal(h.context.excelPageDiag().tableKey,'two');assert.equal(h.context.excelPageDiag().undo.stackSize,0);assert.equal(h.values.get('one'),'旧表在途');assert.equal(h.values.get('two'),'另一表');assert.equal(h.grids.at(-1).painted.length,0);
 }finally{h.close();}
});
test('UI016 real review refresh consumes no personal undo step while loading independently changed values',async()=>{
 const h=setup();try{const api=await h.mountPage();await api.writeRange([['本人保存']],0,0);assert.equal(h.context.excelPageDiag().undo.stackSize,1);
  h.values.set('one','外部已确认值');await api.refreshReviewValues();assert.equal(h.context.excelPageDiag().undo.stackSize,1);assert.equal(h.values.get('one'),'外部已确认值');assert.equal(h.requests.length,1);
 }finally{h.close();}
});

test('UI005/012/013 production mount writes empty first cell and spaced lower-right matrix at original coordinates',async()=>{
 const h=setup({empty:true,canStructure:true});try{const api=await h.mountPage();await api.writeRange([['00123']],0,0);assert.equal(h.values.get('one'),'00123');assert.equal(h.data.get('one')!.length,1);assert.equal(h.context.excelPageDiag().undo.stackSize,1);
  await api.handlePaste('A\tB\nC\tD',3,4);assert.equal(h.requests[1].startRow,3);assert.equal(h.requests[1].startCol,4);assert.deepEqual(h.requests[1].matrix,[['A','B'],['C','D']]);assert.equal(h.data.get('one')!.length,5);assert.equal(h.headers.get('one')!.length,6);assert.deepEqual(h.data.get('one')![3].slice(4),['A','B']);assert.deepEqual(h.data.get('one')![4].slice(4),['C','D']);assert.equal(h.data.get('one')![1].length,0);assert.equal(h.context.excelPageDiag().undo.stackSize,2);assert.equal(h.values.get('one'),'00123');assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});

test('UI006 queues same-table inputs, paints newest draft, advances versions and prevents leaving until resolved',async()=>{
 const releases:Array<()=>void>=[];const h=setup({beforeWrite:()=>new Promise<void>(r=>releases.push(r))});try{const api=await h.mountPage();const event=(value:string,before:string)=>({rowIndex:0,colIndex:0,fieldId:'C1',value,before,type:'text'});
 api.onCommit(event('第一笔','原值'));await settled(()=>releases.length===1,h.errors);api.onCommit(event('第二笔','第一笔'));api.onCommit(event('第三笔','第二笔'));assert.equal(h.requests.length,1);assert.equal(h.context.excelPageDiag().inputQueue.length,3);
 await api.openTableByKey('two');assert.equal(h.context.excelPageDiag().tableKey,'one');
 releases[0]();await settled(()=>releases.length===2,h.errors);assert.equal(h.requests[1].expectedContentVersion,2);assert.equal(h.grids.at(-1).painted.at(-1).value,'第三笔');
 releases[1]();await settled(()=>releases.length===3,h.errors);assert.equal(h.requests[2].expectedContentVersion,3);assert.equal(h.grids.at(-1).painted.at(-1).value,'第三笔');releases[2]();await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);assert.equal(h.values.get('one'),'第三笔');assert.equal(h.context.excelPageDiag().undo.stackSize,3);assert.equal(new Set(h.requests.map(r=>r.opId)).size,3);await api.openTableByKey('two');assert.equal(h.context.excelPageDiag().tableKey,'two');assert.equal(h.context.excelPageDiag().undo.stackSize,0);
 }finally{h.close();}
});
test('UI006 failed head preserves later draft and retries exact original payload before next version',async()=>{
 let fail=true;const h=setup({beforeWrite:async()=>{if(fail)throw Error('controlled unknown response');}});try{const api=await h.mountPage();const event=(value:string)=>({rowIndex:0,colIndex:0,fieldId:'C1',value,before:'原值',type:'text'});api.onCommit(event('第一笔'));api.onCommit(event('第二笔'));await settled(()=>h.context.excelPageDiag().inputQueue[0]?.state==='failed',h.errors);assert.equal(h.requests.length,3);assert.equal(h.context.excelPageDiag().inputQueue.length,2);assert.equal(h.grids.at(-1).painted.at(-1).value,'第二笔');assert.equal((h.host.querySelector('[data-retry]') as HTMLElement).hidden,false);assert.equal(h.context.excelPageDiag().undo.stackSize,0);const original=JSON.stringify(h.requests[0]);assert.ok(h.requests.every(r=>JSON.stringify(r)===original));fail=false;(h.host.querySelector('[data-retry]') as HTMLElement).click();await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);assert.equal(JSON.stringify(h.requests[3]),original);assert.equal(h.requests[4].expectedContentVersion,2);assert.equal(h.values.get('one'),'第二笔');assert.equal(h.context.excelPageDiag().undo.stackSize,2);
 }finally{h.close();}
});
test('UI040/102 production copy observation is separate from font command and value write',async()=>{
 const h=setup();try{const api=await h.mountPage();assert.equal(h.facts.filter(f=>f.action==='table.open').length,1);const clip=new Map<string,string>();const event=new h.context.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(k:string,v:string)=>clip.set(k,v)}});h.context.document.dispatchEvent(event);assert.equal(clip.get('text/plain'),'原值');assert.equal(h.facts.filter(f=>f.action==='copy.range').length,1);assert.equal(h.requests.length,0);
  (h.host.querySelector('[data-font-bold]') as HTMLElement).click();await settled(()=>h.styleRequests.length===1&&h.context.excelPageDiag().undo.stackSize===1,h.errors);assert.equal(h.styleRequests[0].style.bold,true);assert.equal(h.requests.length,0);assert.equal(h.facts.filter(f=>f.action==='cell.save'||f.action==='paste.batch').length,0);
  await api.handlePaste('值改变',0,0);assert.equal(h.requests.length,1);
  // ⚠️ **口径变过**：界面**不再补发**第二条「已保存」事实（main.ts 第 2142 行
  //   "No second 'saved' fact request: the core write receipt is authoritative."）⇒
  //   粘贴成功后**没有** `paste.batch` 事实（核心写入回执才是权威）。
  //   这条断言原来钉的是旧口径（界面补发一条 paste.batch）⇒ 改钉新口径。
  //   「粘贴是一次真正的写」由上面那句 `h.requests.length===1` ＋ 撤回栈守着。
  assert.equal(h.facts.filter(f=>f.action==='paste.batch'||f.action==='cell.save').length,0,'核心写入回执才是权威，界面不许补发第二条「已保存」事实');
  assert.equal(h.styleRequests.length,1);
 }finally{h.close();}
});
test('UI074 twenty production page mount/abort cycles release grids and document copy handlers',async()=>{
 const h=setup();try{for(let i=0;i<20;i++){await h.mountPage();assert.equal(h.grids.filter(g=>!g.disposed).length,1);h.abort();assert.equal(h.grids.filter(g=>!g.disposed).length,0);assert.equal(h.context.excelPageDiag,undefined);const before=h.facts.length;const event=new h.context.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:()=>{throw Error('disposed copy handler still active');}}});h.context.document.dispatchEvent(event);assert.equal(h.facts.length,before);}assert.equal(h.grids.length,20);assert.deepEqual(h.errors,[]);}finally{h.close();}
});
test('UI102 production structure dialog submits one stable structural action without value/copy observation',async()=>{
 const h=setup({canStructure:true});try{await h.mountPage();(h.host.querySelector('[data-structure]') as HTMLElement).click();const dialog=h.context.document.querySelector('[data-kind]')?.closest('[role="dialog"]')||h.context.document.querySelector('[data-kind]')?.closest('dialog');assert.ok(dialog);const kind=dialog.querySelector('[data-kind]');kind.value='column_insert';dialog.querySelector('[data-header]').value='普通列';const button=Array.from(dialog.querySelectorAll('button')).find((b:any)=>b.textContent==='执行') as HTMLElement;button.click();await settled(()=>h.structureRequests.length===1&&h.context.excelPageDiag().undo.stackSize===1,h.errors);assert.equal(h.structureRequests[0].before,'C1');assert.equal(h.structureRequests[0].header,'普通列');assert.match(h.structureRequests[0].key,/^structure-/);assert.equal(h.requests.length,0);assert.equal(h.styleRequests.length,0);assert.equal(h.facts.filter(f=>f.action==='copy.range'||f.action==='cell.save'||f.action==='paste.batch').length,0);}finally{h.close();}
});
test('UI006 definite 403 allows explicit two-step discard; unknown followed by 403 cannot be discarded',async()=>{
 for(const unknownFirst of [false,true]){let attempt=0;const h=setup({beforeWrite:async()=>{attempt++;if(unknownFirst&&attempt===1)throw Error('network outcome unknown');throw Object.assign(Error('permission denied before write'),{status:403});}});try{const api=await h.mountPage();api.onCommit({rowIndex:0,colIndex:0,fieldId:'C1',value:'保留文本',before:'原值',type:'text'});
  // ⚠️ **等「放弃修改」按钮**（2026-10-30 · PKG-133 · 缺陷③ 修完后的口径）：
  //   「结果确定没写进去」的那一笔**不进队列**（免得堵着后面那几笔）⇒ 队列里看不到它
  //   ⇒ 等「队首变成 failed」永远等不到 ⇒ 等**用户看得见的那个出口**。
  // ⚠️ **等法分两种**（2026-10-30 · PKG-133 · 缺陷③）：
  //   · **确定的 403** ⇒ 那一笔**不进队列**、但**单独记一份** ⇒ 「放弃修改」按钮**要出现** ⇒ 等它可见；
  //   · **先不明后 403** ⇒ 第一笔**结果不明** ⇒ 它**留在队列里**等核实
  //     ⇒ 「放弃修改」**不给**（给了就丢数据）⇒ 等「队列里那一笔变成 failed」。
  await settled(()=>{
    if(unknownFirst)return h.context.excelPageDiag().inputQueue[0]?.state==='failed';
    const d=h.host.querySelector('[data-discard]') as HTMLElement;return !!d&&!d.hidden;
  },h.errors);
  const discard=h.host.querySelector('[data-discard]') as HTMLButtonElement;
  assert.equal(discard.hidden,unknownFirst,'结果不明时不给「放弃修改」（那会丢数据）；确定的 403 要给');
  assert.equal(h.values.get('one'),'原值');
  if(!unknownFirst){
    discard.click();assert.equal(h.context.excelPageDiag().inputQueue.length,0,'确定 403 的那笔不在队列里（不堵后面那几笔）');
    discard.click();await settled(()=>h.opens.length===2,h.errors);
    assert.equal(h.values.get('one'),'原值');assert.equal(h.context.excelPageDiag().undo.stackSize,0);
  }else{discard.click();assert.equal(h.context.excelPageDiag().inputQueue.length,1,'结果不明的那笔**留在队列里**等人核实');}
  }finally{h.close();}}
});
test('UI006 queued blank-grid inputs retain coordinates through first expansion and keep one step per input',async()=>{
 const releases:Array<()=>void>=[];const h=setup({empty:true,canStructure:true,beforeWrite:()=>new Promise<void>(r=>releases.push(r))});try{const api=await h.mountPage();api.onCommit({rowIndex:0,colIndex:0,fieldId:'__extra_0',value:'00123',before:'',type:'text'});await settled(()=>releases.length===1,h.errors);api.onCommit({rowIndex:2,colIndex:3,fieldId:'__extra_3',value:'远格',before:'',type:'text'});releases[0]();await settled(()=>releases.length===2,h.errors);assert.equal(h.requests[1].startRow,2);assert.equal(h.requests[1].startCol,3);releases[1]();await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);assert.equal(h.values.get('one'),'00123');assert.equal(h.data.get('one')![2][3],'远格');assert.equal(h.context.excelPageDiag().undo.stackSize,2);}finally{h.close();}
});
test('UI006 abort stops draining and late old input cannot paint or enter a remounted session',async()=>{
 const releases:Array<()=>void>=[];const h=setup({beforeWrite:()=>new Promise<void>(r=>releases.push(r))});try{const api=await h.mountPage();api.onCommit({rowIndex:0,colIndex:0,fieldId:'C1',value:'在途',before:'原值',type:'text'});await settled(()=>releases.length===1,h.errors);api.onCommit({rowIndex:0,colIndex:0,fieldId:'C1',value:'未发',before:'在途',type:'text'});const oldGrid=h.grids.at(-1);h.abort();await h.mountPage();const currentGrid=h.grids.at(-1),paints=currentGrid.painted.length;releases[0]();await new Promise(r=>setTimeout(r,0));assert.equal(h.requests.length,1);assert.equal(h.context.excelPageDiag().inputQueue.length,0);assert.equal(h.context.excelPageDiag().undo.stackSize,0);assert.equal(currentGrid.painted.length,paints);assert.equal(oldGrid.disposed,true);}finally{h.close();}
});
test('UI074 actual grid disposer clears owned timers/subscriptions and calls engine dispose for twenty instances',()=>{
 const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('sheet.ts',source,ts.ScriptTarget.Latest,true);let dispose:any;function visit(n:ts.Node){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='dispose'&&n.getText(ast).includes('univer.dispose()'))dispose=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(dispose);
 const code=ts.transpileModule('function disposeGrid()'+dispose.body.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 for(let i=0;i<20;i++){const dom=new JSDOM('<main><div></div></main>'),renderHost=dom.window.document.querySelector('div')!,calls:string[]=[];const context:any={widthHeightTimer:i,clearTimeout:(id:number)=>{assert.equal(id,i);calls.push('timer');},selectionHandlers:[()=>{}],layoutHandlers:[()=>{}],publicRender:{},highlightMark:{dispose:()=>calls.push('mark')},highlightAt:{},disposables:[{dispose:()=>calls.push('subscription')},{dispose(){throw Error('already disposed');}}],univer:{dispose:()=>calls.push('engine')},renderHost};runInNewContext(code+';disposeGrid();',context);assert.deepEqual(calls,['timer','mark','subscription','engine']);assert.equal(context.selectionHandlers.length,0);assert.equal(context.layoutHandlers.length,0);assert.equal(context.publicRender,null);assert.equal(renderHost.isConnected,false);dom.window.close();}
});

test('UI012 actual copy and cross-table paste transfer rectangular values without source formatting or identity',async()=>{
 const h=setup({canStructure:true});try{const api=await h.mountPage();const grid=h.grids.at(-1);const matrix=[['00123','A&B'],['多\n行','900']];grid.getSelectionRange=()=>({startRow:0,endRow:1,startCol:0,endCol:1});grid.getCellText=(r:number,c:number)=>matrix[r][c];grid.getCellStyle=()=>({bold:true,color:'#ff0000'});
 const clipboard=new Map<string,string>();const copy=new h.context.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:{setData:(k:string,v:string)=>clipboard.set(k,v)}});h.context.document.dispatchEvent(copy);assert.equal(copy.defaultPrevented,true);assert.equal(clipboard.get('text/plain'),serializeClipboardTsv(matrix));assert.doesNotMatch(clipboard.get('text/html')!,/font-weight|#ff0000|rowId|fieldId|read_roles/);
 await api.openTableByKey('two');const paste=new h.context.window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:(k:string)=>k==='text/html'?'<table style="color:red"><tr><td>WRONG HTML</td></tr></table>':clipboard.get(k)||''}});h.host.querySelector('[data-grid]')!.dispatchEvent(paste);await settled(()=>h.requests.length===1&&h.context.excelPageDiag().undo.stackSize===1,h.errors);assert.equal(paste.defaultPrevented,true);assert.deepEqual(h.requests[0].matrix,matrix);assert.equal(h.styleRequests.length,0);assert.equal(h.headers.get('two')![0],'C1');assert.equal(h.values.get('one'),'原值');assert.equal(h.values.get('two'),'00123');
 }finally{h.close();}
});

test('UI007 production title and header controls capture names and versions and reopen saved identity',async()=>{
 const h=setup({canStructure:true});try{const api=await h.mountPage();const dbl=()=>new h.context.window.MouseEvent('dblclick',{bubbles:true});const enter=()=>new h.context.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true});h.host.querySelector('[data-title]')!.dispatchEvent(dbl());const title=h.host.querySelector('[data-title-input]') as HTMLInputElement;title.value=' ';title.dispatchEvent(enter());assert.equal(h.renameRequests.length,0);title.value='UI改名';title.dispatchEvent(enter());await settled(()=>h.renameRequests.length===1&&h.opens.length===2,h.errors);assert.equal(h.renameRequests[0].title,'UI改名');assert.match(h.renameRequests[0].op,/^struct-ren-/);
 h.grids.at(-1).getHeaderAtPoint=()=>({colIndex:0,rect:{left:0,top:0,width:100,height:24}});h.host.querySelector('[data-grid]')!.dispatchEvent(dbl());const header=h.host.querySelector('[aria-label="原位修改列名"]') as HTMLInputElement;header.value='跟进意见';header.dispatchEvent(enter());await settled(()=>h.renameRequests.length===2&&h.opens.length===3,h.errors);assert.deepEqual(JSON.parse(JSON.stringify(h.renameRequests[1])),{kind:'header',key:'one',before:'C1',after:'跟进意见',op:h.renameRequests[1].op,version:{contentVersion:1,structureVersion:1}});assert.match(h.renameRequests[1].op,/^header-/);await api.openTableByKey('two');await api.openTableByKey('one');assert.equal(h.host.querySelector('[data-title]')!.textContent,'UI改名');assert.equal(h.headers.get('one')![0],'跟进意见');assert.equal(h.values.get('one'),'原值');assert.equal(h.requests.length,0);assert.equal(h.styleRequests.length,0);
 }finally{h.close();}
});

test('UI011 actual personal-view button/dialog saves filter and freeze and restores on reopen without cell mutation',async()=>{
 const h=setup({personal:true});try{const api=await h.mountPage();(h.host.querySelector('[data-personal-view]') as HTMLElement).click();const dialog=h.context.document.querySelector('[data-filters]').closest('[role="dialog"]')||h.context.document.querySelector('[data-filters]').closest('dialog');assert.ok(dialog);dialog.querySelector('[data-add]').click();dialog.querySelector('[data-filters] input').value='原';dialog.querySelector('[data-rows]').value='1';dialog.querySelector('[data-cols]').value='1';(Array.from(dialog.querySelectorAll('button')).find((b:any)=>b.textContent==='保存视图') as HTMLElement).click();await settled(()=>h.viewRequests.length===1&&h.grids.at(-1).freeze?.rows===1,h.errors);assert.deepEqual(h.viewRequests[0].filters,[{column:'C1',operator:'contains',value:'原'}]);assert.deepEqual(h.viewRequests[0].freeze,{rows:1,columns:1});assert.equal(h.requests.length,0);await api.openTableByKey('two');await api.openTableByKey('one');assert.deepEqual(h.grids.at(-1).freeze,{rows:1,columns:1});(h.host.querySelector('[data-personal-view]') as HTMLElement).click();assert.equal(h.context.document.querySelector('[data-filters] input').value,'原');assert.equal(h.values.get('one'),'原值');assert.equal(h.context.excelPageDiag().undo.stackSize,0);
 }finally{h.close();}
});

test('UI008 production display controls route number/date/wrap/border through style command only',async()=>{
 const h=setup();try{await h.mountPage();const select=h.host.querySelector('[data-number-format]') as HTMLSelectElement;select.value='#,##0.00';select.dispatchEvent(new h.context.window.Event('change'));await settled(()=>h.styleRequests.length===1&&h.context.excelPageDiag().undo.stackSize===1,h.errors);assert.equal(h.styleRequests[0].style.number_format,'#,##0.00');select.value='yyyy-mm-dd';select.dispatchEvent(new h.context.window.Event('change'));await settled(()=>h.styleRequests.length===2&&h.context.excelPageDiag().undo.stackSize===2,h.errors);assert.equal(h.styleRequests[1].style.number_format,'yyyy-mm-dd');(h.host.querySelector('[data-wrap-text]') as HTMLElement).click();await settled(()=>h.styleRequests.length===3&&h.context.excelPageDiag().undo.stackSize===3,h.errors);assert.equal(h.styleRequests[2].style.wrap_text,true);// 2026-10-19 FIX-14：边框从「两项下拉」换成**公共弹窗面板**（预设 × 线型 × 颜色）。
 const borderOpen=h.host.querySelector('[data-border-open]') as HTMLElement;borderOpen.click();
 const dialog=h.context.document.querySelector('dialog.os-dialog') as HTMLDialogElement;assert.ok(dialog,'点边框要打开公共弹窗');
 const presets=[...dialog.querySelectorAll('.excel-border-preset')] as HTMLElement[];assert.equal(presets.length,8,'八个边框预设');
 (presets.find(b=>b.dataset.preset==='outer') as HTMLElement).click();
 ([...dialog.querySelectorAll('button')].find(b=>b.textContent==='应用') as HTMLElement).click();
 await settled(()=>h.styleRequests.length===4,h.errors);assert.deepEqual(JSON.parse(JSON.stringify(h.styleRequests[3].style.border)),{preset:'outer',style:'thin',color:'#D1D5DB'});assert.equal(h.requests.length,0);assert.equal(h.values.get('one'),'原值');
 }finally{h.close();}
});
