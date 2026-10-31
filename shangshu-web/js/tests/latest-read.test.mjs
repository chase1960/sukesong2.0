import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatestRead} from '../lib/latest-read.mjs';

test('新查询中止旧查询，多个页面彼此独立', () => {
  const a=createLatestRead(), b=createLatestRead();
  const old=a.begin(), other=b.begin(), next=a.begin();
  assert.equal(old.signal.aborted,true);
  assert.equal(old.isCurrent(),false);
  assert.equal(next.isCurrent(),true);
  assert.equal(other.signal.aborted,false);
  a.dispose();b.dispose();
});

test('离页中止当前读、解绑父生命周期，已关闭作用域不能再发有效读', () => {
  const parent=new AbortController(), reads=createLatestRead(parent.signal);
  const request=reads.begin();
  parent.abort();
  assert.equal(request.signal.aborted,true);
  assert.equal(reads.begin().isCurrent(),false);
  assert.equal(reads.begin().signal.aborted,true);
});
