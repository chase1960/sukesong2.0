import test from 'node:test';
import assert from 'node:assert/strict';
import {relationCommand,readRelations} from '../../../shangshu-web/js/domains/excel-univer/src/table-relations.ts';

test('relation retry retains immutable payload and key after uncertain response',async()=>{
 const original=globalThis.fetch;const bodies:string[]=[];
 try{
  globalThis.fetch=async(_url,init)=>{bodies.push(String(init?.body));if(bodies.length===1)throw new TypeError('connection interrupted');return new Response(JSON.stringify({receipt:{result:{revision:2}}}));};
  const payload={table:'one',header:'ref',row_id:'stable-row',target_row_id:'other-row',expected_revision:1};
  const command=relationCommand<{revision:number}>('set',payload);payload.target_row_id='mutated';
  await assert.rejects(command.execute,/interrupted/);assert.equal((await command.execute()).revision,2);
  assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[1]).payload.target_row_id,'other-row');
 }finally{globalThis.fetch=original;}
});
test('HTTP 200 does not turn unapplied action or missing receipt into success',async()=>{
 const original=globalThis.fetch;
 try{for(const body of [{result:{applied:false}},{result:{fatal:true}},{}]){
  globalThis.fetch=async()=>new Response(JSON.stringify(body));
  await assert.rejects(relationCommand('remove',{table:'one',header:'ref',expected_revision:1}).execute);
 }}finally{globalThis.fetch=original;}
});
test('definition-only read preserves explicit empty row selection',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async(_url,init)=>{assert.deepEqual(JSON.parse(String(init?.body)).payload,{table:'one',row_ids:[]});return new Response(JSON.stringify({result:{table:'one',definitions:[],values:[]}}));};
  assert.deepEqual((await readRelations('one',[])).values,[]);
 }finally{globalThis.fetch=original;}
});
test('service invocation accepts the actual flat BFF envelope',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,table:'one',definitions:[],values:[]}));
  assert.equal((await readRelations('one',[])).table,'one');
 }finally{globalThis.fetch=original;}
});
