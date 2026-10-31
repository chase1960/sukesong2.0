import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom} from '../../../scripts/tests/mini-dom.mjs';
import {loadShell, registerSampleDeclaration, sampleCard, pageHost, settle} from './helpers/review-center-shell.mjs';

const pending = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject};};
const fire = (node, type) => node.dispatchEvent({type});
function fixture() {
  const dom = createDom(), shell = loadShell(dom);
  shell.window.AbortController = AbortController;
  return {dom, ...shell, api:shell.window.shangshuReviewCenter};
}

test('a ready review source is usable while another source remains pending; later results preserve its open modal', async () => {
  const {dom, window, api} = fixture(), slow = pending();
  registerSampleDeclaration(window);
  registerSampleDeclaration(window, {key:'slow', list:()=>slow.promise});
  const mounted = api.mountPage(pageHost(dom), {});
  await settle();
  const open = dom.body.querySelector('[data-review-card-open]');
  assert.ok(open, 'fast cards must appear before slow list resolves');
  fire(open, 'click');
  const left = dom.body.querySelector('[data-review-slot="left"]');
  slow.resolve([sampleCard({id:'slow-card'})]);
  await mounted;
  assert.equal(dom.body.querySelector('[data-review-slot="left"]'), left);
});

test('details load only for the opened card; loading and failure cannot submit; retry reads only this card', async () => {
  const {dom, window, api} = fixture(), read = pending();
  let details = 0, lists = 0;
  registerSampleDeclaration(window, {
    list:async()=>{lists++;return [sampleCard()];},
    detail:async()=>{details++;return details === 1 ? read.promise : sampleCard();},
  });
  await api.mountPage(pageHost(dom), {});
  assert.equal(details, 0);
  fire(dom.body.querySelector('[data-review-card-open]'),'click');
  assert.equal(details,1);
  assert.equal(dom.body.querySelector('[data-review-save]'),null);
  await api.saveActiveCard();
  read.reject(Error('凭据读取失败'));
  await settle();
  assert.match(dom.body.querySelector('.review-error').textContent,/凭据读取失败/);
  assert.equal(dom.body.querySelector('[data-review-save]'),null);
  fire(dom.body.querySelector('[data-review-detail-retry]'),'click');
  await settle();
  assert.equal(details,2);
  assert.equal(lists,1);
  assert.ok(dom.body.querySelector('[data-review-candidate]'));
});

test('switching or closing cancels detail reads and ignores late results', async () => {
  const {dom,window,api}=fixture(), a=pending(), b=pending(), signals=[];
  registerSampleDeclaration(window, {
    list:async()=>[sampleCard({id:'A'}),sampleCard({id:'B'})],
    detail:(card,{signal})=>{signals.push(signal);return card.id==='A'?a.promise:b.promise;},
  });
  await api.mountPage(pageHost(dom),{});
  api.openCard('sample.notice','A');
  api.openCard('sample.notice','B');
  assert.equal(signals[0].aborted,true);
  a.resolve(sampleCard({id:'A',title:'迟到A'}));
  b.resolve(sampleCard({id:'B',title:'当前B'}));
  await settle();
  assert.equal(dom.body.querySelector('[data-review-split-title]').textContent,'当前B');
  api.openCard('sample.notice','A');
  api.closeCard();
  await settle();
  assert.equal(signals[2].aborted,true);
  assert.equal(api.state.modalOpen,false);
});

test('detail identity mismatch stays blocked; no-difference details remove the card', async () => {
  const {dom,window,api}=fixture(); let empty=false;
  registerSampleDeclaration(window,{detail:async()=>empty
    ?sampleCard({changes:[]}):sampleCard({id:'wrong'})});
  await api.mountPage(pageHost(dom),{});
  api.openCard('sample.notice','CARD-1');
  await settle();
  assert.match(dom.body.querySelector('.review-error').textContent,/不一致/);
  assert.equal(dom.body.querySelector('[data-review-save]'),null);
  empty=true;
  fire(dom.body.querySelector('[data-review-detail-retry]'),'click');
  await settle();
  assert.equal(api.state.modalOpen,false);
  assert.equal(api.state.cards['sample.notice'].length,0);
});
