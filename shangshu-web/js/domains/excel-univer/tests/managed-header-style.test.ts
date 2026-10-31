/**
 * 判据：**受管列的列头样式**（2026-10-29 · 用户口径：
 * 「受管列就不要 svg 了，直接把列头加粗变成灰色就行了」＋「backgroundColor 也行」
 * ＋「**变绿色嘛**」⇒ **最终口径：受管列的列头变绿**（产品主色那套绿））。
 *
 * **测试通过 =**（一句话）
 * 「受管列的列头**画在画布上**（不是浮层）⇒ **变绿** ＋ **字号更大**（看起来更重）
 * ＋ **底色是淡绿**（跟普通列的白底分得开）；而**普通列**照旧是原来的样子；
 * 并且**那个 svg 浮层不再挂**（它就是『锁图案跟着鼠标跑到别的位置』的根源）。」
 *
 * ⚠️ **为什么改成画在画布上**（用户 2026-10-29 原话＋实测）：
 *   · 原来的受管标记是**一层浮层**（`managed-badge.ts`）⇒ 它的位置是**算出来的**
 *     （按列索引去问网格要列头矩形）⇒ **拖列 / 滚动 / 换表**时对不上
 *     ⇒ 用户看到「锁图案跟着鼠标走到别的位置」；
 *   · 改成**列头自己的样式**（Univer 画在画布上）⇒ **跟着列走** ⇒ 不会再跑。
 *
 * ⚠️ **为什么不是真「加粗」**：Univer 的列头样式**没有粗细字段**
 *   （`IHeaderStyleCfg` 只有 fontFamily／fontColor／fontSize／borderColor／
 *   textAlign／textBaseline／backgroundColor／size）
 *   ⇒ 用「**字号更大 ＋ 变绿**」做出「更醒目」的观感（用户要的效果），
 *   **不新造一个 Univer 不支持的粗体**（宁可少一个效果，也不编一个假的）。
 *
 * ⚠️ **颜色用产品那套绿**（不是自编的）：`--green-ink`（绿字）＋ `--accd`（淡绿底）
 *   —— 与「已确认／主行动」那一套同一个色系 ⇒ 一眼认得出、也不像错误提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MANAGED_HEADER_FONT_COLOR,
  MANAGED_HEADER_FONT_SIZE,
  MANAGED_HEADER_BACKGROUND,
  columnHeaderCfg,
} from '../src/managed-header-style.ts';

const BASE = {
  fontFamily: 'sans-serif',
  fontColor: '#374151',
  fontSize: 12,
  backgroundColor: 'gray.50',
  borderColor: 'gray.200',
  textBaseline: 'middle',
};

const LABELS = ['我司案号', '申请号', '专利名称', '备注'];

/* ───────────────── ① 受管列给样式、普通列照旧 ───────────────── */

test('① 受管列的列头**带样式**，普通列**还是原来那个样子**', () => {
  const cfg = columnHeaderCfg(LABELS, new Set(['我司案号', '申请号']), BASE);
  // —— 受管列：给的是**对象**（带样式）——
  assert.equal(typeof cfg[0], 'object', '受管列没给样式（还是纯文字）');
  assert.equal((cfg[0] as any).text, '我司案号', '样式里的文字对不上');
  assert.equal((cfg[1] as any).text, '申请号');
  // —— 普通列：**纯文字**（跟原来一样，不多给样式）——
  assert.equal(cfg[2], '专利名称', '普通列不该被改成对象');
  assert.equal(cfg[3], '备注');
});

/* ───────────────── ② 受管列**变绿 ＋ 字号更大 ＋ 淡绿底** ───────────────── */

test('② 受管列：**白字绿底** ＋ **字号更大**（看起来更重）', () => {
  const cfg = columnHeaderCfg(LABELS, new Set(['我司案号']), BASE);
  const managed = cfg[0] as any;
  assert.equal(managed.fontColor, MANAGED_HEADER_FONT_COLOR);
  // —— **白字**（跟产品的「绿底按钮」同一套）——
  assert.equal(String(managed.fontColor).toUpperCase(), '#FFFFFF',
    '受管列的字不是白的：%r', managed.fontColor);
  // —— **绿底**（＝产品的 `--green` 主绿）——
  assert.equal(String(managed.backgroundColor).toUpperCase(), '#10B981',
    '受管列的底色不是主绿：%r', managed.backgroundColor);
  assert.notEqual(managed.fontColor, BASE.fontColor, '受管列的字色跟普通列一样（看不出来）');
  assert.ok(managed.fontSize > BASE.fontSize,
    '受管列的字号没变大（看起来不会更重）：%r vs %r', managed.fontSize, BASE.fontSize);
  assert.notEqual(managed.backgroundColor, BASE.backgroundColor,
    '受管列的底色跟普通列一样（分不出来）');
  assert.equal(managed.backgroundColor, MANAGED_HEADER_BACKGROUND);
});

/* ───────────────── ③ 不在表里的列名不许乱套样式 ───────────────── */

test('③ 清单里没有的列名**不套样式**（受管集合只认它自己那几列）', () => {
  const cfg = columnHeaderCfg(LABELS, new Set(['不存在的列']), BASE);
  assert.equal(cfg[0], '我司案号', '不存在的列名把第一列也改了');
  assert.equal(cfg[1], '申请号');
});

/* ───────────────── ④ 那个 svg 浮层**不再挂** ───────────────── */

test('④ 那个 svg 浮层（受管列的锁角标）**不再挂**（它就是『锁图案乱跑』的根源）', () => {
  // —— 源码断言：主控里不再挂 `mountManagedBadges` ——
  const url = new URL('../src/main.ts', import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  assert.ok(!/mountManagedBadges\(/.test(source),
    '主控里还在挂那个 svg 浮层（锁图案会乱跑）');
  assert.ok(!/managed-badge/.test(source),
    '主控里还在引那个 svg 浮层的模块');
});
