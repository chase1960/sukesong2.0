/**
 * 判据：**渲染层「形状」要成批画、没变就不画**（2026-10-30 用户口径：
 * 「那是不是可以把所有的特效、绿底、候选都放进这个里面，
 * 　这样让速度更快，**不用每次都计算一次**」）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「① 一组效果**内容没变** ⇒ **一个形状都不重画**（不重算）；
 *   ② 内容变了 ⇒ **一次重画**（成批，不是一格一次）；
 *   ③ 换掉一组 ⇒ **旧的那组被摘掉**、新的接上；
 *   ④ 不同颜色 ⇒ **各自一组**（各画各的，互不拖累）；
 *   ⑤ 表格里那些逐格效果（**必填空的红底**、**审核标记**）**都走这一层**
 *      —— 不再一处一格一格地画。」
 *
 * ⚠️ **为什么要有这一层**：Univer 的高亮是**渲染层的形状** ——
 *   加一个形状就要重画一次，而那一次重画会把**已有的全部形状**重算一遍 ⇒
 *   **逐格加 ⇒ N 次重画 ⇒ 越加越慢**（实测一格约 70ms）。
 * ⇒ 成批（一次重画）＋ 没变不动（不重算）＝ 又快又不闪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createShapeLayer } from '../src/shape-layer.ts';

/** 一个假的 Univer 表格：只记「被重画了几次、画了哪些格」。 */
function fakeWorksheet() {
  const calls: Array<{ ranges: any[]; style: any }> = [];
  const disposed: number[] = [];
  let seq = 0;
  return {
    calls,
    disposed,
    worksheet: {
      highlightRanges(ranges: any[], style: any) {
        calls.push({ ranges, style });
        const id = ++seq;
        return { dispose() { disposed.push(id); } };
      },
    },
  };
}

/** 造 N 格（每格的 range 是它自己）。 */
function cells(count: number, prefix = 'r') {
  return Array.from({ length: count }, (_, i) => ({
    key: `${prefix}${i}`,
    range: { id: `${prefix}${i}` },
  }));
}

test('① 内容没变 ⇒ 一个形状都不重画（不用每次都计算一次）', () => {
  const fake = fakeWorksheet();
  const layer = createShapeLayer({ worksheet: () => fake.worksheet });
  layer.setGroup('required-empty', { fill: 'rgba(220,38,38,0.14)' }, cells(3));
  assert.equal(fake.calls.length, 1, '第一次就该画一次：%r', fake.calls.length);
  // —— **同样的内容再来一次** ⇒ 一个形状都不动 ——
  layer.setGroup('required-empty', { fill: 'rgba(220,38,38,0.14)' }, cells(3));
  assert.equal(fake.calls.length, 1, '内容没变却重画了（每次都重算）：%r', fake.calls.length);
});

test('② 内容变了 ⇒ **一次**重画（成批，不是一格一次）', () => {
  const fake = fakeWorksheet();
  const layer = createShapeLayer({ worksheet: () => fake.worksheet });
  layer.setGroup('required-empty', { fill: 'red' }, cells(20));
  layer.setGroup('required-empty', { fill: 'red' }, cells(21));
  assert.equal(fake.calls.length, 2, '只该多一次重画：%r', fake.calls.length);
  assert.equal(fake.calls[1].ranges.length, 21, '这一批要一次画完 21 格：%r', fake.calls[1].ranges.length);
});

test('③ 换掉一组 ⇒ 旧的那组被摘掉（不留孤儿形状）', () => {
  const fake = fakeWorksheet();
  const layer = createShapeLayer({ worksheet: () => fake.worksheet });
  layer.setGroup('required-empty', { fill: 'red' }, cells(3));
  layer.setGroup('required-empty', { fill: 'red' }, cells(4));
  assert.equal(fake.disposed.length, 1, '旧那组没被摘掉：%r', fake.disposed);
  // —— **摘组** ⇒ 也清掉 ——
  layer.dropGroup('required-empty');
  assert.equal(fake.disposed.length, 2, '摘组没清掉：%r', fake.disposed);
  assert.equal(layer.stats().groups, 0, '摘组后还有组：%r', layer.stats());
});

test('④ 不同颜色 ⇒ 各自一组（各画各的，互不拖累）', () => {
  const fake = fakeWorksheet();
  const layer = createShapeLayer({ worksheet: () => fake.worksheet });
  layer.setGroup('review-automation', { stroke: '#3877d6' }, cells(2, 'a'));
  layer.setGroup('review-assistant', { stroke: '#10B981' }, cells(2, 'b'));
  assert.equal(fake.calls.length, 2, '两组该各画一次：%r', fake.calls.length);
  // —— **只动其中一组** ⇒ 另一组不动 ——
  layer.setGroup('review-automation', { stroke: '#3877d6' }, cells(3, 'a'));
  assert.equal(fake.calls.length, 3, '只该多一次重画：%r', fake.calls.length);
  assert.equal(layer.stats().groups, 2, '组数不对：%r', layer.stats());
});

test('⑤ 表格里那些逐格效果都走这一层（不再一处一格一格地画）', () => {
  const source = fs.readFileSync(new URL('../src/sheet.ts', import.meta.url), 'utf8');
  assert.ok(/createShapeLayer/.test(source), '网格没有用「形状层」');
  // —— **审核标记**：以前是一格一次 `highlight()`（N 次重画）——
  const review = source.slice(source.indexOf('markReviewCells(cells) {'));
  const reviewBody = review.slice(0, review.indexOf('\n    },'));
  assert.ok(!/\.highlight\(/.test(reviewBody),
    '审核标记还在逐格 highlight（一次重画一格 ⇒ N 次重画）');
  assert.ok(/shapeLayer|setGroup/.test(reviewBody),
    '审核标记没走形状层');
  // —— **必填空的红底**：走形状层 ——
  assert.ok(/REQUIRED_EMPTY_HIGHLIGHT/.test(source), '必填空的红底样式没了');
});
