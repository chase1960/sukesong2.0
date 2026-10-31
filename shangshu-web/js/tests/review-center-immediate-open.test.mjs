import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../scripts/tests/mini-dom.mjs';
import {loadShell,registerSampleDeclaration,sampleCard,pageHost,settle,fileCenterVersions} from './helpers/review-center-shell.mjs';
const pending=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const card=(reference='FILE-1')=>sampleCard({evidence:[{id:'ev-1',name:'原件.pdf',type:'pdf',required:true,available:true,reference,locator:{page:1}}]});

test('opening preserves the list and starts the original beside unresolved details; detail completion retains the mounted frame and in-flight read',async()=>{
 const dom=createDom(),detail=pending(),bytes=pending();let versions=0;
 const {window,calls}=loadShell(dom,{readFileCenterVersions:async file=>{versions++;return fileCenterVersions(file);},reply:()=>bytes.promise});
 const api=window.shangshuReviewCenter;registerSampleDeclaration(window,{list:async()=>[card()],detail:()=>detail.promise});
 await api.mountPage(pageHost(dom),{});
 const list=dom.body.querySelector('[data-review-card]');api.openCard('sample.notice','CARD-1');
 assert.ok(dom.body.querySelector('[data-review-card]')===list,'opening must not rebuild the list');
 const right=dom.body.querySelector('[data-review-slot="right"]'),frame=dom.body.querySelector('[data-review-original-frame]');
 assert.ok(frame,'original frame must exist before detail response');assert.equal(api.state.detailLoading,true);await settle();
 assert.equal(versions,1);assert.equal(calls.length,1,'original bytes start before detail response');
 assert.equal(dom.body.querySelector('[data-review-save]'),null);
 // A PDF iframe must stay attached, not just be detached and appended again.
 const body=right.parentNode;let detached=false;const remove=body.removeChild;
 body.removeChild=function(node){if(node===right)detached=true;return remove.call(this,node);};
 detail.resolve(card());await settle();
 assert.ok(dom.body.querySelector('[data-review-original-frame]')===frame);assert.ok(right.parentNode===body);assert.equal(detached,false);
 assert.equal(versions,1);assert.equal(calls.length,1);bytes.resolve({ok:true});await settle();assert.match(frame.getAttribute('src'),/^blob:/);
});

test('a changed original reference never reuses old bytes even when its evidence id is unchanged',async()=>{
 const dom=createDom(),detail=pending();const {window,calls}=loadShell(dom,{readFileCenterVersions:fileCenterVersions});
 const api=window.shangshuReviewCenter;registerSampleDeclaration(window,{list:async()=>[card()],detail:()=>detail.promise});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');await settle();
 const old=dom.body.querySelector('[data-review-original-frame]');assert.ok(old);const oldSrc=old.getAttribute('src');
 detail.resolve(card('FILE-2'));await settle();
 const current=dom.body.querySelector('[data-review-original-frame]');assert.ok(current!==old);assert.notEqual(current.getAttribute('src'),oldSrc);
 assert.equal(calls.length,2);assert.match(calls[1].path,/FILE-2/);
});

test('a preview failure started during loading still blocks the detailed card',async()=>{
 const dom=createDom(),detail=pending();const {window}=loadShell(dom,{readFileCenterVersions:fileCenterVersions,reply:async()=>({ok:false,status:403})});
 const api=window.shangshuReviewCenter;registerSampleDeclaration(window,{list:async()=>[card()],detail:()=>detail.promise});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');await settle();detail.resolve(card());await settle();
 const current=api.state.cards['sample.notice'][0];current.changes.forEach(c=>api.state.adopt.set(c.id,'adopted'));
 assert.equal(current.evidence[0].available,false);assert.equal(api.canSave(api.declarations()[0],current),false);
});

test('the shared PDF reader mounts once and is released on close instead of relying on browser PDF plugins',async()=>{
 const dom=createDom(),detail=pending();const {window,calls}=loadShell(dom,{readFileCenterVersions:fileCenterVersions});let mounted=0,released=0,readerCurrent;
 window.renderFileMediaPreview=(surface,options)=>{mounted++;readerCurrent=options.current;surface.textContent='站内PDF原件';surface._disposeFileMedia=()=>{released++;};};
 window.clearFileMediaPreview=surface=>{surface._disposeFileMedia?.();delete surface._disposeFileMedia;};
 const api=window.shangshuReviewCenter;registerSampleDeclaration(window,{list:async()=>[card()],detail:()=>detail.promise});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');await settle();
 assert.equal(mounted,1);assert.equal(calls.length,1);assert.equal(readerCurrent(),true);
 detail.resolve(card());await settle();assert.equal(mounted,1,'details must retain the existing PDF reader');
 api.closeCard();assert.equal(released,1);assert.equal(readerCurrent(),false);
});
