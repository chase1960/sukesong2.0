import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ManagedSaveQueue} from '../../../shangshu-web/js/domains/excel-univer/src/save-queue.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('连续输入按顺序保存，不能并发使用同一个旧内容版本',async()=>{
  let release!:()=>void;const calls:string[]=[];const queue=new ManagedSaveQueue();
  queue.add('first',async()=>{calls.push('first');await new Promise<void>(resolve=>release=resolve);return true;});
  queue.add('second',async()=>{calls.push('second');return true;});
  await tick();assert.deepEqual(calls,['first']);release();await tick();await tick();
  assert.deepEqual(calls,['first','second']);assert.equal(queue.pending,0);
});
test('未知或失败暂停后续输入，重试同一闭包和编号后才继续',async()=>{
  const calls:string[]=[];let accepted=false;const queue=new ManagedSaveQueue();
  queue.add('same-key',async()=>{calls.push('same-key');return accepted;});
  queue.add('later-key',async()=>{calls.push('later-key');return true;});
  await tick();assert.deepEqual(calls,['same-key']);assert.equal(queue.pending,2);
  accepted=true;queue.retry();await tick();await tick();
  assert.deepEqual(calls,['same-key','same-key','later-key']);assert.equal(queue.pending,0);
});
test('重复排队不重复写；销毁后不启动后续保存',async()=>{
  const calls:string[]=[];const queue=new ManagedSaveQueue();
  queue.add('one',async()=>{calls.push('one');return false;});
  queue.add('one',async()=>{calls.push('wrong');return true;});
  await tick();queue.dispose();queue.retry();await tick();assert.deepEqual(calls,['one']);
});
