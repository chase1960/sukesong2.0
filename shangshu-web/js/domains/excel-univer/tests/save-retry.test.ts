import test from 'node:test';
import assert from 'node:assert/strict';
import {retrySave} from '../src/save-retry';
test('initial failure plus exactly two retries, then release caller',async()=>{
 let calls=0;await assert.rejects(retrySave(async()=>{calls++;throw Error('denied');}),/denied/);assert.equal(calls,3);
});
test('success on second retry returns once without a fourth attempt',async()=>{
 let calls=0;const key='same-operation';const keys:string[]=[];
 assert.equal(await retrySave(async()=>{keys.push(key);if(++calls<3)throw Error('network');return 'saved';}),'saved');
 assert.deepEqual(keys,[key,key,key]);
});
test('leaving the page stops further attempts',async()=>{
 let active=true,calls=0;await assert.rejects(retrySave(async()=>{calls++;active=false;throw Error('network');},()=>active));assert.equal(calls,1);
});
test('successful first operation never retries',async()=>{
 let calls=0;assert.equal(await retrySave(async()=>++calls),1);assert.equal(calls,1);
});
