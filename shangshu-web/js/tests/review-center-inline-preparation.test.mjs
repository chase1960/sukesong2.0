import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../scripts/tests/mini-dom.mjs';
import {loadShell,registerSampleDeclaration,sampleCard,pageHost,settle,fileCenterVersions} from './helpers/review-center-shell.mjs';

test('declared inline preparation occupies the left side and blocks candidate review until target confirmation',async()=>{
 const dom=createDom();const {window}=loadShell(dom,{readFileCenterVersions:fileCenterVersions});const api=window.shangshuReviewCenter;
 let mounted=0,context,disposed=0;
 registerSampleDeclaration(window,{list:async()=>[sampleCard()],handling:{entries:['adopt','edit','save'],panel:{id:'select-record',blocksReview:()=>true,mount(host,card,ctx){mounted++;context=ctx;host.textContent='待核对的关联记录';return()=>disposed++;}}}});
 await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');await settle();
 const panel=dom.body.querySelector('[data-review-preparation-panel]');assert.ok(panel);assert.ok(panel.closest('.review-slot-left'));
 assert.equal(mounted,1);assert.equal(dom.body.querySelector('[data-review-candidate]'),null);assert.ok(dom.body.querySelector('[data-review-slot="right"]'));
 assert.equal(api.canSave(api.declarations()[0],api.state.cards['sample.notice'][0]),false);
 api.closeCard();assert.equal(disposed,1);let writes=0;assert.equal(await context.run(async()=>{writes++;}),false);assert.equal(writes,0);
});

test('leaving the page disposes the inline component and late callbacks cannot write or reopen it',async()=>{
 const dom=createDom();const {window}=loadShell(dom);const api=window.shangshuReviewCenter;let context,disposed=0;
 registerSampleDeclaration(window,{list:async()=>[sampleCard()],handling:{entries:['adopt','edit','save'],panel:{id:'target',mount(host,card,ctx){context=ctx;return()=>disposed++;}}}});
 const dispose=await api.mountPage(pageHost(dom),{});api.openCard('sample.notice','CARD-1');dispose();
 let writes=0;await context.run(async()=>{writes++;return {refreshDeclarations:[]};});assert.equal(writes,0);assert.equal(disposed,1);assert.equal(api.state.modalOpen,false);
});

test('invalid preparation declarations are rejected before mounting',()=>{
 const dom=createDom();const {window}=loadShell(dom);
 const result=registerSampleDeclaration(window,{handling:{panel:{id:'bad',mount:'not a function'}}});
 assert.equal(result.ok,false);
});
