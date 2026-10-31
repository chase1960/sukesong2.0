import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {editTableRelation} from '../../../shangshu-web/js/domains/excel-univer/src/table-relation-dialog.ts';

test('a revoked target can be unlinked without reading or disclosing its identity',async()=>{
 const dom=new JSDOM('<main></main>');const priorDocument=globalThis.document,priorFetch=globalThis.fetch,priorConfirm=globalThis.confirm;
 let actions:any[]=[],saved=false,payload:any,confirmed=false;
 try{
  globalThis.document=dom.window.document;
  // FIX-37/36：破坏性动作收进「操作」下拉后，点了还要有一道确认（防误触）⇒ 这里放行确认。
  globalThis.confirm=()=>{confirmed=true;return true;};
  globalThis.fetch=async(url,init)=>{
   if(String(url).includes('/services/'))return new Response(JSON.stringify({result:{table:'source',definitions:[{header:'Ref',revision:4,status:'unavailable'}],values:[{row_id:'row',header:'Ref',status:'unavailable'}]}}));
   payload=JSON.parse(String(init?.body)).payload;return new Response(JSON.stringify({result:{revision:5}}));
  };
  const ui={dialog(opts:any){actions=opts.actions;const el=dom.window.document.createElement('section');el.innerHTML=opts.body;dom.window.document.querySelector('main')!.append(el);return el;},guardModal(){},closeModal(){return true;}};
  await editTableRelation({table:'source',header:'Ref',rowId:'row',structureVersion:2,canStructure:false,targets:[],async loadTarget(){throw Error('no readable target');},async saved(){saved=true;}},ui);
  // FIX-37/36：底部只留「取消 / 执行」两个按钮，动作从「操作」下拉里选。
  assert.ok(actions.find(a=>a.label==='执行'),'底部要有「执行」按钮');
  const actionSelect=dom.window.document.querySelector('[data-action]') as HTMLSelectElement;
  assert.ok(actionSelect,'要有「操作」下拉框');
  actionSelect.value='clear';
  actions.find(a=>a.label==='执行').onClick();
  for(let i=0;i<10&&!saved;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(confirmed,true,'破坏性动作要先确认');
  assert.equal(saved,true);assert.deepEqual(payload,{table:'source',header:'Ref',row_id:'row',expected_revision:4});
  assert.equal('target_row_id' in payload,false);
 }finally{globalThis.fetch=priorFetch;globalThis.document=priorDocument;globalThis.confirm=priorConfirm;dom.window.close();}
});
