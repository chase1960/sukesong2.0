/**
 * 判据：**在中间加行** —— 新行要**真的落在人指定的那一行的上面/下面**。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「在某一行的行号上右键 ⇒ 选『在上方插入行』⇒ 那条新行**就落在这一行上面**；
 *   选『在下方插入行』⇒ 新行**就落在这一行下面**（不是这一行上面、也不是表末尾）；
 *   就算要插的那一行**还没从服务器加载出来**（翻页时的下一行、末尾的空行），
 *   也**不许**把新行悄悄插到**表的末尾** ——
 *   要么把那一页加载出来、插到对的位置，要么**明确告诉人**『这一行还没加载出来』。」
 *
 * ⚠️ **为什么有这条判据**（用户 2026-10-29 14:5x 原话：「也要能在中间加行」）：
 *   原来右键菜单拿 `indexToName.get(那一行)` 当锚点 ——
 *   那一行**没加载**时拿到的是**空**，而「插在空锚点前面」＝ **插到表的末尾** ⇒
 *   人点了「在第 5 行下面插一行」，新行跑到了**表的最底下**，而且一声不响。
 *   ⇒ `unknown` 这一档就是专门钉这个的：**拿不到身份 ≠ 插末尾**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRowInsertAnchor } from '../src/structure-menu.ts';

/** 一张 4 行的表：显示序号 0～3 对应 r-000001～r-000004。 */
const IDS = ['r-000001', 'r-000002', 'r-000003', 'r-000004'];

function idAt(index: number): string | undefined {
  return IDS[index];
}

/** 只加载了前两行（模拟翻页：后面的行还没加载）。 */
function idAtFirstPageOnly(index: number): string | undefined {
  return index < 2 ? IDS[index] : undefined;
}

test('在上方插入行 ⇒ 插在选中行自己的前面', () => {
  const anchor = resolveRowInsertAnchor({
    direction: 'above', selectedIndex: 2, totalRows: 4, idAt,
  });
  assert.deepEqual(anchor, { kind: 'before', beforeRowId: 'r-000003' });
});

test('在下方的插入行 ⇒ 插在**下一行**的前面（不是选中行）', () => {
  const anchor = resolveRowInsertAnchor({
    direction: 'below', selectedIndex: 2, totalRows: 4, idAt,
  });
  assert.deepEqual(anchor, { kind: 'before', beforeRowId: 'r-000004' },
    '新行要落在选中行**下面** ⇒ 锚点是下一行');
});

test('选中的是**最后一行**时在下方插入 ⇒ 插到表的末尾', () => {
  const anchor = resolveRowInsertAnchor({
    direction: 'below', selectedIndex: 3, totalRows: 4, idAt,
  });
  assert.deepEqual(anchor, { kind: 'end' });
});

test('选中的是**末尾之外的空行**时在上面插入 ⇒ 插到表的末尾', () => {
  const anchor = resolveRowInsertAnchor({
    direction: 'above', selectedIndex: 7, totalRows: 4, idAt,
  });
  assert.deepEqual(anchor, { kind: 'end' });
});

test('目标行**还没加载** ⇒ 明确说「不知道」，不许悄悄插到末尾', () => {
  const above = resolveRowInsertAnchor({
    direction: 'above', selectedIndex: 3, totalRows: 4, idAt: idAtFirstPageOnly,
  });
  assert.equal(above.kind, 'unknown', '要插的那一行没加载 ⇒ 不许当成末尾');
  const below = resolveRowInsertAnchor({
    direction: 'below', selectedIndex: 1, totalRows: 4, idAt: idAtFirstPageOnly,
  });
  assert.equal(below.kind, 'unknown', '下一行没加载 ⇒ 不许当成末尾');
});

test('第一行上面插入 ⇒ 锚点是第一行自己（插到表最上面）', () => {
  const anchor = resolveRowInsertAnchor({
    direction: 'above', selectedIndex: 0, totalRows: 4, idAt,
  });
  assert.deepEqual(anchor, { kind: 'before', beforeRowId: 'r-000001' });
});
