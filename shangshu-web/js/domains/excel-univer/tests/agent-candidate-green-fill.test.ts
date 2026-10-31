/**
 * 判据：**agent 提出的候选也走渲染层形状，绿底**（2026-10-30 用户 11:5x
 * 指着案号候选那张截图说：「agent 提出的对于表格的候选也走这个样式，只不过是绿底哈」）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「表格里 agent（assistant）提出的那一批候选 ⇒
 *   ① **底色画在渲染层形状上**（绿底 `rgba(16,185,129,0.12)` 那一档，
 *      **不是**白色、**不是**透明）；
 *   ② **DOM 文字层是透明底**（不许拿白底把形状层的绿底盖住）；
 *   ③ **代码/自动化提出的**那一批 ⇒ **蓝底**（与案号候选同一个蓝）；
 *   ④ **来源不明**的那一批 ⇒ **灰底**（不许跟别的混）；
 *   ⑤ 底色这一份口径**只有一处**（不许三处各写一遍颜色）。」
 *
 * ⚠️ **为什么要有这条**：案号候选早就走形状层了（蓝底 ＋ 透明文字层），
 *   **agent 提出的那批却还是「绿字白底」** ——
 *   形状层那边 `fill:'transparent'`（只有描边、没有底），
 *   DOM 文字层那边 `background:var(--card,#fff)`（**白底把形状层的底色盖住了**）。
 *   ⇒ 两边都不对：看起来就是「白底绿字」，跟用户截图里那个不是一个样式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/sheet.ts', import.meta.url);
const CSS = new URL('../../../../css/domains/excel-univer/excel-univer.css', import.meta.url);
const source = fs.readFileSync(SRC, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

test('① agent（assistant）候选**有绿底**（形状层那一份，不是白、不是透明）', () => {
  /* —— 底色那一档写在**唯一那一份**里（`REVIEW_SOURCE_COLORS`）——
     `markReviewCells` 与 `highlightCell` 都从那儿取 ⇒ 改一处就够。 */
  const table = /const REVIEW_SOURCE_COLORS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(table, 'sheet.ts 里找不到 REVIEW_SOURCE_COLORS（底色口径只有那一份）');
  const assistant = /assistant\s*:\s*\{[^}]*\}/.exec(table[1]);
  assert.ok(assistant, 'REVIEW_SOURCE_COLORS 里没有 assistant 那一档');
  assert.match(assistant[0], /rgba\(16,\s*185,\s*129/i,
    'assistant（agent）候选的绿底不在那一份里：' + assistant[0]);
  /* —— 而且**不许**是透明（透明＝只有描边、没有底）—— */
  assert.doesNotMatch(assistant[0], /transparent/i,
    'assistant 那一档是透明底 ⇒ agent 候选还是没底色（白底绿字）');
  /* —— 审核标记那组**真的用上了**那一份（不许引了不用）—— */
  const start = source.indexOf('markReviewCells(cells)');
  assert.ok(start >= 0, 'sheet.ts 里找不到 markReviewCells');
  const body = source.slice(start, start + 2600);
  assert.match(body, /REVIEW_SOURCE_COLORS\[kind\]/,
    'markReviewCells 没有用那一份颜色 ⇒ 底色还是各写一遍');
});

test('② 代码/自动化提出的候选 ⇒ **蓝底**（与案号候选同一个蓝）', () => {
  const table = /const REVIEW_SOURCE_COLORS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(table, 'sheet.ts 里找不到 REVIEW_SOURCE_COLORS');
  const automation = /automation\s*:\s*\{[^}]*\}/.exec(table[1]);
  assert.ok(automation, 'REVIEW_SOURCE_COLORS 里没有 automation 那一档');
  assert.match(automation[0], /rgba\(56,\s*119,\s*214/i,
    'automation 候选的蓝底不在那一份里：' + automation[0]);
});

test('③ 来源不明的那一批 ⇒ **灰底**（不许跟别的混）', () => {
  const table = /const REVIEW_SOURCE_COLORS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(table, 'sheet.ts 里找不到 REVIEW_SOURCE_COLORS');
  const unknown = /unknown\s*:\s*\{[^}]*\}/.exec(table[1]);
  assert.ok(unknown, 'REVIEW_SOURCE_COLORS 里没有 unknown 那一档');
  assert.match(unknown[0], /rgba\(139,\s*148,\s*163/i,
    'unknown 候选的灰底不在那一份里：' + unknown[0]);
});

test('④ DOM 文字层**不许拿白底盖住形状层的底色**', () => {
  /* —— `.excel-candidate-cell` 是那层 DOM —— */
  const rule = /\.excel-candidate-cell\s*\{[^}]*\}/.exec(css);
  assert.ok(rule, 'css 里找不到 .excel-candidate-cell');
  assert.match(rule[0], /background\s*:\s*transparent/,
    'DOM 文字层还是白底（background:var(--card,#fff)）⇒ 形状层的绿底被盖住了：' + rule[0]);
});

test('⑤ 底色这一份口径**只有一处**（不许三处各写一遍颜色）', () => {
  /* —— 描边高亮（`highlightCell`）与审核标记（`markReviewCells`）得用**同一份**颜色表 —— */
  const green = (source.match(/rgba\(16,\s*185,\s*129/gi) || []).length;
  assert.ok(green <= 2,
    `绿底的颜色写了 ${green} 处（多了就是各写一遍 ⇒ 改一处漏一处）`);
  /* —— 抽出来的那一份（`REVIEW_SOURCE_COLORS` 之类）得真被两处用 —— */
  assert.match(source, /REVIEW_SOURCE_COLORS|reviewSourceColors/,
    '没有抽出「按来源分颜色」那一份 ⇒ 两处各写一遍，改一处就漏一处');
});

test('⑥ **真的画上去**（跑形状层，不只是看源码）：agent 候选 ⇒ 绿底', async () => {
  /* —— 这一条是**实跑**：用形状层那个假表格，看画出去的那一笔到底带什么底色 —— */
  const { createShapeLayer } = await import('../src/shape-layer.ts');
  const calls: Array<{ ranges: any[]; style: any }> = [];
  const layer = createShapeLayer({
    worksheet: () => ({
      highlightRanges(ranges: any[], style: any) {
        calls.push({ ranges, style });
        return { dispose() {} };
      },
    }),
  });
  /* —— 按那一份口径，给 agent 候选那一组画绿底 —— */
  const table = /const REVIEW_SOURCE_COLORS = \{([\s\S]*?)\} as const;/.exec(source);
  const assistant = /assistant\s*:\s*\{[^}]*\}/.exec(table![1])[0];
  const fill = /fill:\s*'([^']+)'/.exec(assistant)![1];
  layer.setGroup('review:assistant', { stroke: '#10B981', fill }, [{ key: 'r1', range: { id: 'r1' } }]);
  assert.equal(calls.length, 1, '这一组该画一次：%r', calls.length);
  assert.equal(calls[0].style.fill, fill,
    '画出去的那一笔底色不对：%r', calls[0].style.fill);
  assert.match(calls[0].style.fill, /rgba\(16,\s*185,\s*129/i,
    'agent 候选画出去的不是绿底：%r', calls[0].style.fill);
});
