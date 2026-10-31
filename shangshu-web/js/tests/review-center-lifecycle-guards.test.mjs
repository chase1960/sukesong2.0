import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../scripts/tests/mini-dom.mjs';
import {loadShell,registerSampleDeclaration,sampleCard,pageHost,settle} from './helpers/review-center-shell.mjs';
const fire=(node,type)=>node.dispatchEvent({type});
function setup(){const dom=createDom(),shell=loadShell(dom);shell.window.AbortController=AbortController;return {dom,...shell,api:shell.window.shangshuReviewCenter};}

test('current detail AbortError remains a read failure, never unlocks summary saving',async()=>{
 const {dom,window,api}=setup();registerSampleDeclaration(window,{detail:async()=>{throw Object.assign(Error('详情读取中断'),{name:'AbortError'});}});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');await settle();
 const card=api.state.cards['sample.notice'][0];card.changes.forEach(c=>api.state.adopt.set(c.id,'adopted'));
 assert.match(api.state.detailError,/中断/);assert.equal(api.canSave(api.declarations()[0],card),false);
 assert.equal(dom.body.querySelector('[data-review-save]'),null);
});

for(const kind of ['empty','error'])test(`background list ${kind} retains editing snapshot but blocks save until explicit reread`,async()=>{
 const {dom,window,api}=setup();let stale=false;
 registerSampleDeclaration(window,{list:async()=>{if(stale){if(kind==='error')throw Error('列表故障');return [];}return [sampleCard()];}});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');
 const card=api.state.cards['sample.notice'][0];const candidate=dom.body.querySelector('[data-review-candidate]');fire(candidate,'dblclick');
 const editor=dom.body.querySelector('[data-review-edit]');editor.value='未失焦的手工改写';
 stale=true;await api.refreshPage();
 assert.equal(api.state.cards['sample.notice'][0],card);assert.equal(dom.body.querySelector('[data-review-edit]'),editor);
 assert.equal(editor.value,'未失焦的手工改写');assert.equal(api.canSave(api.declarations()[0],card),false);
 assert.equal(dom.body.querySelector('[data-review-save]').disabled,true);
 assert.match(dom.body.querySelector('[data-review-receipt]').textContent,/重新读取|关闭/);
 const retry=dom.body.querySelector('[data-review-detail-retry]');assert.ok(retry);
 stale=false;fire(retry,'click');await settle();
 assert.equal(api.state.detailError,'');assert.equal(api.state.edits.get('c1'),'未失焦的手工改写');
 assert.equal(api.state.adopt.size,0,'重读之后必须重新核对，不自动采用旧快照');
});

test('dispose closes the modal, invalidates late list/detail and refuses stale save',async()=>{
 const {dom,window,api,calls}=setup();let release;let delayed=false;
 registerSampleDeclaration(window,{list:()=>delayed?new Promise(resolve=>{release=resolve;}):Promise.resolve([sampleCard()])});
 const dispose=await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');
 const card=api.state.cards['sample.notice'][0];card.changes.forEach(c=>api.state.adopt.set(c.id,'adopted'));
 delayed=true;const refreshing=api.refreshPage();dispose();const readCount=calls.length;
 assert.equal(api.state.modalOpen,false);assert.equal(api.state.activeCardId,null);assert.equal(api.state.modal.getAttribute('open'),null);
 assert.equal(api.canSave(api.declarations()[0],card),false);await api.saveActiveCard();assert.equal(calls.length,readCount);
 release([sampleCard({id:'late'})]);await refreshing;
 assert.equal(api.state.cards['sample.notice'][0].id,'CARD-1');
});

test('an invalidated card cannot submit an already open difference form',async()=>{
 const {dom,window,api}=setup();let stale=false,submitted=0;
 registerSampleDeclaration(window,{list:async()=>stale?[]:[sampleCard()],handling:{entries:['adopt','edit','save','difference'],difference:async()=>{submitted+=1;}}});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');
 fire(dom.body.querySelector('[data-review-difference]'),'click');
 dom.body.querySelector('[data-review-difference-reason]').value='需要核对';
 const submit=dom.body.querySelector('[data-review-difference-submit]');
 stale=true;await api.refreshPage();fire(submit,'click');await settle();
 assert.equal(submitted,0);assert.match(api.state.detailError,/重新读取/);
});

test('leaving during a progressive list closes the ready card before the slow source returns',async()=>{
 const {dom,window,api}=setup();let release;
 registerSampleDeclaration(window);
 registerSampleDeclaration(window,{key:'sample.slow',list:()=>new Promise(resolve=>{release=resolve;})});
 const controller=new AbortController();
 const mounted=api.mountPage(pageHost(dom),{signal:controller.signal});await settle();
 api.openCard('sample.notice','CARD-1');assert.equal(api.state.modalOpen,true);
 controller.abort();assert.equal(api.state.modalOpen,false);assert.equal(api.state.pageDisposed,true);
 assert.equal(api.state.modal.getAttribute('open'),null);
 release([sampleCard({id:'late'})]);await mounted;
 assert.equal(api.state.pageHost,null);assert.equal((api.state.cards['sample.slow'] || []).length,0);
});
