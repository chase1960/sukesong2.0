import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {createInlineReviewController,reviewValuesEqual,resolveCandidateCell,type ReviewDescriptor} from '../../../shangshu-web/js/domains/excel-univer/src/inline-review.ts';
import {mountCandidateOverlay} from '../../../shangshu-web/js/domains/excel-univer/src/candidate-overlay.ts';
import {mountHeaderRename} from '../../../shangshu-web/js/domains/excel-univer/src/header-rename.ts';
const initial=():ReviewDescriptor=>({id:'p1',capability:'files.sheet_cells_write',status:'proposed',created_via:'ai',review_revision:'v4',target:{module:'excel',table:'t1'},remaining:2,accepted_count:0,units:[['server-exact-z','编号','00123'],['server-exact-a','备注','line\nnext']].map(([unit_id,header,value])=>({unit_id,label:header,kind:'cell',target:{row_id:'r-000001',header},value:{type:'text',value},current_value:{type:'text',value:'formal'},status:'pending'}))});
test('Actual React first commit deletes unsafe mount children but preserves header/review siblings with the isolated Univer mount',async()=>{
  const dom=new JSDOM('<div id="unsafe"></div><div id="safe"></div>',{pretendToBeVisual:true});const descriptors=new Map(['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let unsafeRoot:any,safeRoot:any;
  try{
    Object.defineProperty(globalThis,'window',{configurable:true,value:dom.window});Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
    const require=createRequire(new URL('../../../shangshu-web/js/domains/excel-univer/package.json',import.meta.url));const {createRoot}=require('react-dom/client'),{flushSync}=require('react-dom'),React=require('react');
    const doc=dom.window.document,unsafe=doc.querySelector('#unsafe')!,lost=doc.createElement('input');lost.className='excel-header-editor';unsafe.append(lost);unsafeRoot=createRoot(unsafe);flushSync(()=>unsafeRoot.render(React.createElement('div',null,'canvas')));assert.equal(lost.isConnected,false,'reproduces the real unsafe React mount lifecycle');
    const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts',import.meta.url),'utf8'),prep=source.match(/  const renderHost=document\.createElement\('div'\);[^\n]+/);assert.ok(prep,'Univer must own an isolated inner mount');
    const safe=doc.querySelector('#safe')!,inner=new Function('document','host',prep[0]+';return renderHost;')(doc,safe),header=doc.createElement('input'),review=doc.createElement('div');header.className='excel-header-editor';review.className='excel-candidate-layer';safe.append(header,review);
    safeRoot=createRoot(inner);flushSync(()=>safeRoot.render(React.createElement('div',null,'canvas')));assert.equal(header.parentElement,safe);assert.equal(review.parentElement,safe);assert.equal(header.isConnected,true);assert.equal(review.isConnected,true);assert.match(source,/container: renderHost/);assert.match(source,/renderHost\.remove\(\)/);
    safeRoot.unmount();safeRoot=null;assert.equal(header.isConnected,true,'React cleanup cannot remove the outer header editor');
  }finally{unsafeRoot?.unmount();safeRoot?.unmount();await new Promise(resolve=>setTimeout(resolve,20));for(const [key,descriptor] of descriptors)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];dom.window.close();}
});
test('Actual unit controller retains edit/op on unknown result, sends exact unit IDs and independently verifies before clearing',async()=>{
  const calls:any[]=[],progress:any[]=[];let rejectRead=true,release:()=>void=()=>{};
  const controller=createInlineReviewController({descriptor:initial(),blocking:()=>false,newKey:()=> 'op-'+calls.length,coerce:(_u,text)=>({type:'text',value:text}),change(){},progress:d=>progress.push(d),
    async fetcher(_url,init){const body=JSON.parse(String(init?.body));calls.push(body);await new Promise<void>(resolve=>{release=resolve;});const selected=body.units??initial().units.map(unit=>unit.unit_id);return new Response(JSON.stringify({...initial(),review_revision:'v5',remaining:2-selected.length,accepted_count:selected.length,accepted_units:selected,units:initial().units.map(unit=>({...unit,status:selected.includes(unit.unit_id)?'accepted':'pending'}))}));},
    async readback(_d,expected){assert.equal(expected[0].value.value,'00999');if(rejectRead)throw Error('read failed');}});
  controller.setEdit('server-exact-z','00999');const first=controller.acceptUnit('server-exact-z');assert.equal(await controller.acceptUnit('server-exact-z'),null);release();assert.equal(await first,null);
  assert.equal(controller.value('server-exact-z'),'00999');assert.equal(controller.hasEdits(),true);assert.equal(progress.length,0);assert.equal(controller.descriptor.remaining,2);
  rejectRead=false;const second=controller.acceptUnit('server-exact-z');release();assert.equal((await second)?.remaining,1);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[0].units,['server-exact-z']);assert.equal(calls[0].edited_value['server-exact-z'].value,'00999');assert.equal(progress.length,1);assert.equal(controller.hasEdits(),false);
});
test('Remaining confirmation includes every unsaved candidate edit and never turns literal IDs/date display into a different stored value',async()=>{
  let sent:any;const descriptor=initial();const controller=createInlineReviewController({descriptor,blocking:()=>false,newKey:()=> 'all-original',coerce:(_u,text)=>({type:'text',value:text}),change(){},progress(){},async readback(){},async fetcher(_url,init){sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({...descriptor,review_revision:'v5',remaining:0,accepted_count:2,accepted_units:descriptor.units.map(u=>u.unit_id),units:descriptor.units.map(u=>({...u,status:'accepted'}))}));}});
  controller.setEdit('server-exact-z','00000');controller.setEdit('server-exact-a','a\tb');await controller.acceptRemaining();assert.equal('units' in sent,false);assert.deepEqual(Object.keys(sent.edited_value),['server-exact-z','server-exact-a']);
  assert.equal(reviewValuesEqual({type:'text',value:'00123'},{type:'number',value:123}),false);assert.equal(reviewValuesEqual({type:'date',value:'2026-10-15T00:00:00'},{type:'date',value:'2026-10-15'}),true);assert.equal(reviewValuesEqual({type:'text',value:'2026-10-15T00:00:00'},{type:'text',value:'2026-10-15'}),false);
});
test('Visible candidate overlay changes only DOM; double click cancels single accept, Escape fully removes its editor, overlaps remain individually reachable',async()=>{
  const dom=new JSDOM('<div id="grid"><canvas></canvas></div>',{pretendToBeVisual:true});try{
    const host=dom.window.document.querySelector('#grid') as HTMLElement,clock=new Map<number,()=>void>();let serial=0,accepts=0,edited='';
    const overlay=mountCandidateOverlay(host,{frame:()=>({clip:{left:46,top:28,width:200,height:100},visible:{startRow:0,endRow:1,startCol:0,endCol:1},rect:(r,c)=>({left:46+c*100,top:28+r*24,width:100,height:24})}),select(){},setTimer(fn,ms){assert.equal(ms,550);clock.set(++serial,fn);return serial;},clearTimer:id=>{clock.delete(id);}});
    const item={key:'p1:u1',proposalId:'p1',unitId:'u1',row:0,col:0,text:'00123',source:'assistant',busy:false,accept:async()=>{accepts++;},edit:(v:string)=>{edited=v;}};
    overlay.setItems([item,{...item,key:'p2:u2',proposalId:'p2',unitId:'u2',source:'automation',text:'other'},{...item,key:'offscreen',row:15000}]);await new Promise(r=>dom.window.setTimeout(r,25));
    assert.equal(host.querySelectorAll('.excel-candidate-cell').length,1);const cell=host.querySelector('.excel-candidate-cell')!;cell.dispatchEvent(new dom.window.MouseEvent('click',{detail:1,bubbles:true}));cell.dispatchEvent(new dom.window.MouseEvent('dblclick',{detail:2,bubbles:true}));assert.equal(clock.size,0);assert.equal(accepts,0);
    const input=host.querySelector('textarea')!;input.value='edited';input.dispatchEvent(new dom.window.Event('input'));assert.equal(edited,'edited');input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(host.querySelector('.excel-candidate-editor'),null);assert.equal(edited,'00123');assert.equal(host.querySelectorAll('canvas').length,1);
    host.querySelector<HTMLButtonElement>('.excel-candidate-count')!.click();await new Promise(r=>dom.window.setTimeout(r,25));assert.equal(host.querySelector('.excel-candidate-cell')?.getAttribute('data-proposal-id'),'p2');overlay.dispose();assert.equal(host.querySelector('.excel-candidate-layer'),null);
  }finally{dom.window.close();}
});
test('Normally mapped inline candidates do not require the floating fallback; missing mapping or write error remains explicitly reachable',()=>{
  const source=readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts',import.meta.url),'utf8');
  const start=source.indexOf('  function hasInlineMapping('),end=source.indexOf('\n  function clearInlineReviews',start);assert.ok(start>0&&end>start);
  const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const controller={id:'p1',descriptor:initial(),error:''};const controllers=new Map([['p1',controller]]),errors=new Map();let available=true;
  /* ⚠️ `hasInlineMapping` 会调 `resolveCandidateCell`（PKG-118-T01：候选落到单元格那笔引入的）
     ⇒ 抠出来单独跑时**要把它一起喂进去**，否则是 ReferenceError（不是「函数坏了」）。 */
  const mapped=new Function('inlineControllers','proposalErrors','grid','nameToIndex','columns','resolveCandidateCell',code+';return hasInlineMapping;')(controllers,errors,{getReviewFrame:()=>available?{rect:()=>({left:46,top:28,width:88,height:24})}:null},new Map([['r-000001',0]]),[{fieldId:'编号'},{fieldId:'备注'}],resolveCandidateCell);
  assert.equal(mapped({id:'p1'}),true);available=false;assert.equal(mapped({id:'p1'}),false);available=true;controller.error='save failed';assert.equal(mapped({id:'p1'}),false);controller.error='';assert.equal(mapped({id:'unknown'}),false);
  assert.match(source,/shangshuOpenReviewCard/);assert.match(source,/shangshu:review-location/);
  assert.doesNotMatch(source,/data-proposal-review|data-proposal-reject|el\.proposalReview/);
});
test('Header overlay saves the clicked column/version despite changed selection, empty/duplicate names do not write, Escape cancels',async()=>{
  const dom=new JSDOM('<div id="grid"></div>');try{const host=dom.window.document.querySelector('#grid') as HTMLElement,writes:any[]=[];let selected=7;
    const editor=mountHeaderRename(host,{locate:()=>({header:'客户',colIndex:0,contentVersion:4,structureVersion:2,rect:{left:46,top:0,width:88,height:28}}),allowed:()=>true,headers:()=>['客户','金额'],newKey:()=> 'captured-key',blocked(){},async save(target,value,opId){writes.push({target,value,opId,selected});}});
    host.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,clientX:50,clientY:5}));const input=host.querySelector('input')!;assert.equal(input.value,'客户');assert.equal(input.parentElement?.style.left,'46px');selected=9;
    for(const bad of ['', '金额']){input.value=bad;input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}assert.equal(writes.length,0);
    input.value='新客户';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,0));assert.equal(writes.length,1);assert.equal(writes[0].target.header,'客户');assert.equal(writes[0].target.contentVersion,4);assert.equal(writes[0].target.colIndex,0);assert.equal(writes[0].opId,'captured-key');
    host.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,clientX:50,clientY:5}));input.value='取消';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(editor.isOpen(),false);assert.equal(writes.length,1);editor.dispose();
  }finally{dom.window.close();}
});

// 隔离组件联验：真实聊天renderer + 真实Excel controller；服务/正式值仓为合成夹具。
function mountChatExcel(fail=false){
 const dom=new JSDOM('<section id="chat"></section>',{url:'http://localhost/index.html?object=t1#/excel',runScripts:'outside-only'}),w=dom.window as any;
 let stored=initial(),reject=fail;const calls:any[]=[],formal=new Map(stored.units.map(u=>[u.unit_id,u.current_value]));
 const clone=(d:any)=>JSON.parse(JSON.stringify(d));
 const controller=createInlineReviewController({descriptor:clone(stored),blocking:()=>false,newKey:()=> 'combined-'+calls.length,coerce:(_u,text)=>({type:'text',value:text}),change(){},
  progress(d){w.dispatchEvent(new w.CustomEvent('shangshu:review-progress',{detail:{proposal_id:d.id,descriptor:d}}));},
  async fetcher(_url,init){const body=JSON.parse(String(init?.body));calls.push(body);if(reject)return new Response(JSON.stringify({error:'合成503'}),{status:503});const ids=body.units||stored.units.filter(u=>u.status==='pending').map(u=>u.unit_id);for(const id of ids){const u=stored.units.find(u=>u.unit_id===id)!;formal.set(id,body.edited_value?.[id]??u.value);u.status='accepted';}stored.remaining=stored.units.filter(u=>u.status==='pending').length;stored.accepted_count=stored.units.length-stored.remaining;stored.status=stored.remaining?'proposed':'confirmed';stored.review_revision+='n';return new Response(JSON.stringify({...stored,accepted_units:ids}));},
  async readback(_d,expected){for(const x of expected)assert.deepEqual(formal.get(x.unit.unit_id),x.value);}
 });
 w.esc=(x:any)=>String(x??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));w.money=String;w.toast=()=>{};w.chatScrollBottom=()=>{};w.chatUpdateFab=()=>{};w.chatConfirmFollowUp=async()=>{};
 w.api=async()=>({ok:true,json:async()=>({...clone(stored),can_accept:true,can_reject:true})});
 const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
 w.shangshuInlineReviews=new w.Map([['p1',controller]]);w.shangshuNavigateReview=async()=>true;w.chatBindPendingReviews();w.chatAddConfirmCard(w.document.querySelector('#chat'),{id:'p1',capability:'files.sheet_cells_write',created_via:'ai',payload:{table:'t1'}});
 return {w,controller,calls,formal,card:()=>w.document.querySelector('[data-confirm-id]'),button:()=>w.document.querySelector('.cf-btn.ok'),retry(){reject=false;},close(){controller.dispose();dom.window.close();}};
}
test('隔离联验：Excel已确认一格后聊天全部确认只保存剩余人工改值，两端终态一致',async()=>{
 const t=mountChatExcel();try{await t.controller.acceptUnit('server-exact-z');assert.match(t.card().textContent,/已保存 1 项.*待确认 1 项/);t.controller.setEdit('server-exact-a','人工修改00999');assert.equal(t.button().textContent,'全部确认');await new Promise(r=>setTimeout(r,10));t.button().click();await new Promise(r=>setTimeout(r,30));assert.equal(t.calls.length,2);assert.equal(t.calls[1].units,undefined,'全部确认由服务按当前pending选择');assert.deepEqual(Object.keys(t.calls[1].edited_value),['server-exact-a']);assert.equal(t.formal.get('server-exact-z')?.value,'00123');assert.equal(t.formal.get('server-exact-a')?.value,'人工修改00999');assert.equal(t.controller.descriptor.remaining,0);assert.equal(t.controller.hasEdits(),false);assert.equal(t.card().classList.contains('resolved'),true);}finally{t.close();}
});
test('隔离联验：Excel全部确认失败保留人工值和待审卡，重试复用同一意图',async()=>{
 const t=mountChatExcel(true);try{t.controller.setEdit('server-exact-a','失败后保留');await new Promise(r=>setTimeout(r,10));t.button().click();await new Promise(r=>setTimeout(r,30));assert.equal(t.controller.descriptor.remaining,2);assert.equal(t.controller.value('server-exact-a'),'失败后保留');assert.equal(t.formal.get('server-exact-a')?.value,'formal');assert.equal(t.card().classList.contains('resolved'),false);assert.equal(t.button().disabled,false);t.retry();await new Promise(r=>setTimeout(r,10));t.button().click();await new Promise(r=>setTimeout(r,30));assert.deepEqual(t.calls[0],t.calls[1]);assert.equal(t.controller.descriptor.remaining,0);assert.equal(t.card().classList.contains('resolved'),true);}finally{t.close();}
});
test('explicit no-write descriptor blocks controller accepts and editing locally',async()=>{
 let calls=0;const controller=createInlineReviewController({descriptor:{...initial(),can_accept:false,accept_unavailable_reason:'无修改权限'},newKey:()=> 'blocked',blocking:()=>false,coerce:()=>undefined,change(){},progress(){},readback:async()=>{},fetcher:async()=>{calls++;throw Error('must not write');}});
 controller.setEdit('server-exact-z','changed');assert.equal(controller.value('server-exact-z'),'00123');assert.equal(await controller.acceptUnit('server-exact-z'),null);assert.equal(await controller.acceptRemaining(),null);assert.equal(calls,0);assert.match(controller.error,/无修改权限/);
});
test('disabled overlay describes reason and blocks click Enter double-click',async()=>{
 const dom=new JSDOM('<div id="grid"></div>',{pretendToBeVisual:true});try{let writes=0;const host=dom.window.document.querySelector('#grid') as HTMLElement;
 const overlay=mountCandidateOverlay(host,{frame:()=>({clip:{left:0,top:0,width:100,height:30},visible:{startRow:0,endRow:0,startCol:0,endCol:0},rect:()=>({left:0,top:0,width:100,height:30})}),select(){}});
 overlay.setItems([{key:'p:u',proposalId:'p',unitId:'u',row:0,col:0,text:'value',source:'automation',busy:false,disabled:true,blockedReason:'无修改权限',accept:async()=>{writes++;},edit:()=>{writes++;}}]);await new Promise(r=>setTimeout(r,30));const cell=host.querySelector('.excel-candidate-cell')!;
 cell.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));cell.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));cell.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));assert.equal(cell.getAttribute('aria-disabled'),'true');assert.equal(cell.getAttribute('aria-label'),'无修改权限');assert.equal(host.querySelector('textarea'),null);assert.equal(writes,0);overlay.dispose();}finally{dom.window.close();}
});
