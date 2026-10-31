/**
 * 判据：**挪列的列序算法** ＋ **挪完之后不许把表卡住**。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「把某一列拖到某个位置 ⇒ 新的列序**就是**那一列插在落点前面/后面；
 *   而挪**完**之后 ⇒ 页面回到『没有未保存修改』的状态
 *   （不然列宽、拖列、写格子会**全被禁**，人就再也动不了这张表）。」
 *
 * ⚠️ **为什么有第二条**（用户 2026-10-29 15:2x 报「怎么都不行」的真事故）：
 *   挪列时画布上会先「预览」新顺序 ⇒ 预览期间页面被当成「有未保存修改」；
 *   挪完**忘了复位** ⇒ 后面所有操作（拖列/写格子/调列宽）**全被禁**，
 *   人看着就是「怎么都不行」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { reorderByMove } from '../src/column-drag.ts';

test('① 挪到某一列**前面** ⇒ 它插到那一列前面', () => {
  assert.deepEqual(reorderByMove(['A', 'B', 'C'], 'C', 'A'), ['C', 'A', 'B']);
});

test('② 挪到**末尾**（落点空）⇒ 它排最后', () => {
  assert.deepEqual(reorderByMove(['A', 'B', 'C'], 'A', ''), ['B', 'C', 'A']);
});

test('③ 挪到自己原来的位置 ⇒ 列序不变', () => {
  assert.deepEqual(reorderByMove(['A', 'B', 'C'], 'B', 'C'), ['A', 'B', 'C']);
});

test('④ 落点那一列**就是它自己** ⇒ 列序不变', () => {
  assert.deepEqual(reorderByMove(['A', 'B', 'C'], 'B', 'B'), ['A', 'B', 'C']);
});

test('⑤ 认不出那一列 / 落点不存在 ⇒ **原样返回**（不许悄悄乱排）', () => {
  assert.deepEqual(reorderByMove(['A', 'B'], 'Z', 'A'), ['A', 'B']);
  assert.deepEqual(reorderByMove(['A', 'B'], 'A', 'Z'), ['A', 'B']);
});

test('⑥ 挪完之后**预览状态必须复位**（不然表被卡成「一直有未保存修改」）', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const moveBlock = main.slice(main.indexOf("async function moveColumnInPersonalView"), main.indexOf("notify('列顺序已保存到个人视图'"));
  assert.ok(moveBlock.length > 0, '没找到挪列那段代码');
  assert.ok(
    /columnPreviewing\s*=\s*false/.test(moveBlock),
    '挪列落库之后没有把预览状态复位 ⇒ hasUnsaved() 永远为真 ⇒ 后面全被禁',
  );
});
