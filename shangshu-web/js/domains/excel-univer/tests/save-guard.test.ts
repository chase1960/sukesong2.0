/**
 * 判据：**不许把人锁在表里**（离页保护的那道判断）。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「表里有一笔**失败/结果不明**的操作 ⇒ **照样能刷新、照样能离开**（那笔没写进去，
 *   重开以服务端正式值为准）；只有**确实还在写**的那几笔才拦人 —— 不然人就被锁死了
 *   （用户 2026-10-29 15:4x 原话：「刷新页面也不能，显示有东西未完成」）。」
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideLeaveTable } from '../src/save-guard.ts';

const NONE = { inputStates: [], pendingStates: [], pendingWidthStates: [], pendingFileOpStates: [], editing: false };

test('① 什么都没有 ⇒ 放行', () => {
  assert.equal(decideLeaveTable(NONE).allow, true);
});

test('② **失败的**那笔（粘贴失败留下的）⇒ **放行**（不许把人锁死）', () => {
  const decision = decideLeaveTable({ ...NONE, pendingFileOpStates: ['failed'] });
  assert.equal(decision.allow, true, '一笔失败的操作把人锁在表里 ⇒ 刷新都刷不掉');
});

test('③ **结果不明**的那笔 ⇒ **也放行**（服务端有操作编号可核，工作没丢）', () => {
  const decision = decideLeaveTable({ ...NONE, pendingFileOpStates: ['failed'] });
  assert.equal(decision.allow, true);
});

test('④ **真的还在写**的那几笔 ⇒ **拦**（它可能正在写进去）', () => {
  assert.equal(decideLeaveTable({ ...NONE, pendingFileOpStates: ['saving'] }).allow, false);
  assert.equal(decideLeaveTable({ ...NONE, pendingStates: ['saving'] }).allow, false);
  assert.equal(decideLeaveTable({ ...NONE, pendingWidthStates: ['saving'] }).allow, false);
});

test('⑤ 输入队列：还在飞的那笔 ⇒ 拦；**已经被拒**的那笔 ⇒ 放行', () => {
  assert.equal(decideLeaveTable({ ...NONE, inputStates: ['idle'] }).allow, false, '刚入队还没发 ⇒ 拦');
  assert.equal(decideLeaveTable({ ...NONE, inputStates: ['saving'] }).allow, false, '正在写 ⇒ 拦');
  assert.equal(decideLeaveTable({ ...NONE, inputStates: ['failed'] }).allow, true, '已被拒 ⇒ 放行');
  assert.equal(decideLeaveTable({ ...NONE, inputStates: ['conflict'] }).allow, true, '冲突 ⇒ 放行');
});

test('⑥ 画布上正在编辑（有一格没敲完）⇒ 拦', () => {
  assert.equal(decideLeaveTable({ ...NONE, editing: true }).allow, false);
});
