import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../scripts/tests/mini-dom.mjs';
import {loadShell,registerSampleDeclaration,sampleCard,pageHost} from './helpers/review-center-shell.mjs';

test('review cards paginate locally without rereading or changing pending scope',async()=>{
 const dom=createDom();const {window}=loadShell(dom);const api=window.shangshuReviewCenter;let reads=0;
 registerSampleDeclaration(window,{list:async()=>{reads++;return Array.from({length:25},(_,i)=>sampleCard({id:'CARD-'+i,title:'官文 '+i}));}});
 await api.mountPage(pageHost(dom),{});
 assert.equal(dom.body.querySelectorAll('[data-review-card]').length,12);assert.equal(reads,1);
 dom.body.querySelector('[data-review-page="next"]').dispatchEvent({type:'click'});assert.equal(dom.body.querySelectorAll('[data-review-card]').length,12);assert.equal(reads,1);
 dom.body.querySelector('[data-review-page="next"]').dispatchEvent({type:'click'});assert.equal(dom.body.querySelectorAll('[data-review-card]').length,1);assert.equal(reads,1);assert.equal(api.state.cards['sample.notice'].length,25);
 assert.equal(dom.body.querySelector('[data-review-page="next"]').disabled,true);
});
