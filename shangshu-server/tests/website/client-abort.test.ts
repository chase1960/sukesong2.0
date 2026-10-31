import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readSignal, clientAbortSignal} from '../../src/adapters/web/client-abort.ts';

/**
 * **客户端断开 ⇒ 上游也停**（2026-10-28 · PKG-132 · 审查报告 R06）。
 *
 * 测试通过 = 下面全部成立：
 *  1. **客户端断开后，上游请求真的被中止**（不再继续跑）
 *  2. **响应正常发完时不会误中止**（`finish` 之后不算断开）
 *  3. **固定超时仍然生效**（客户端没取消时，超时照旧兜底）
 *  4. **拿不到响应对象时退化成「只有超时」**，不报错
 *
 * 断的是**响应事件**（Express：`res` 发 `finish` ＝ 正常发完；只发 `close` ＝ 被掐断）。
 */

class FakeRes extends EventEmitter {}

test('客户端断开 ⇒ 上游请求被中止', () => {
  const res = new FakeRes();
  const signal = readSignal({res} as any, 30_000);
  assert.equal(signal.aborted, false, '还没断开就不该中止');
  res.emit('close');                       // 连接被掐断（没有 finish）
  assert.equal(signal.aborted, true, '客户端断开后上游请求没有被中止');
  assert.match(String(signal.reason), /客户端已取消/);
});

test('响应正常发完 ⇒ 不会误中止', () => {
  const res = new FakeRes();
  const signal = readSignal({res} as any, 30_000);
  res.emit('finish');                      // 正常发完
  res.emit('close');                       // 之后连接关闭（正常收尾）
  assert.equal(signal.aborted, false, '响应正常发完却被当成断开 ⇒ 上游被误中止');
});

test('客户端没取消时，固定超时仍然兜底', async () => {
  const res = new FakeRes();
  const signal = readSignal({res} as any, 80);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(signal.aborted, true, '固定超时没兜住');
});

test('没有响应对象时退化成「只有超时」，不报错', () => {
  assert.equal(clientAbortSignal({} as any), undefined);
  const signal = readSignal({} as any, 5_000);
  assert.ok(signal, '拿不到 res 也要给一个信号');
  assert.equal(signal.aborted, false);
});
