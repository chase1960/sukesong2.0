/**
 * Excel 页 → 助手的「当前上下文」（2026-10-21）。
 *
 * 测试通过 = 什么成立：
 * - **选区一变，上报的选区就跟着变**（不是钉在开表那一刻）——这是现状已成立的那条，钉住它；
 * - 选区里那几格的内容（**行名 · 列名 · 值**）跟着进上下文（用户 2026-10-21 的原话）；
 * - **退回清单页**时上下文换成**清单级**（老口径不许破）；
 * - 换表后上下文跟着换（不会挂着上一张表）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settled } from './excel-mount-harness.ts';

test('选区一变 ⇒ 上报的选区跟着变（不是钉在开表那一刻）', async () => {
  const h = setup();
  try {
    await h.mountPage();
    assert.equal(h.contexts.at(-1)!.selection, 'A2', '开表时的选区是 A2');
    // 用户把选区挪到第 3 行第 2 列（B4）。
    h.grids[0].setSelectionRange({ startRow: 2, endRow: 2, startCol: 1, endCol: 1 });
    await settled(() => h.contexts.at(-1)?.selection === 'B4', h.errors);
    assert.equal(h.contexts.at(-1)!.selection, 'B4', '选区变了，上报的选区必须跟着变');
  } finally { h.close(); }
});

test('选区里那几格的内容（行名 · 列名 · 值）跟着进上下文', async () => {
  const h = setup();
  try {
    await h.mountPage();
    const content = h.contexts.at(-1)!.content;
    assert.ok(content, '上下文里要有内容段');
    assert.equal(content.kind, 'cells');
    assert.match(content.text, /行「one-r1」/, '要带行名（那一行的业务标识）');
    assert.match(content.text, /列「C1」/, '要带列名（表头）');
    assert.match(content.text, /= 原值/, '要带格子的值');
    assert.ok(Array.isArray(content.items) && content.items.includes('原值'), '可核对条目里要有那个值');
    assert.ok(content.refs.length > 0, '要给出处，服务端按当前身份重读它');
  } finally { h.close(); }
});

test('退回清单页 ⇒ 上下文换成清单级（不带表 ID、不带内容）', async () => {
  const h = setup();
  try {
    await h.mountPage();
    h.context.excelPageDiag;
    const { buildListContext } = await import('../../../shangshu-web/js/domains/excel-univer/src/chat-context.ts');
    const list = buildListContext();
    assert.equal(list.entity_type, 'page', '清单级上下文要让助手知道「没开表」');
    assert.equal(list.view, 'file-list');
    assert.equal(list.content, undefined, '清单页没有「正在看的内容」');
    assert.match(list.editable_scope, /不要自己挑一张/);
  } finally { h.close(); }
});

test('换表后上下文跟着换（不挂着上一张表）', async () => {
  const h = setup();
  try {
    const api = await h.mountPage();
    await api.openTableByKey('two');
    await settled(() => h.contexts.at(-1)?.entity_id === 'two', h.errors);
    const last = h.contexts.at(-1)!;
    assert.equal(last.entity_id, 'two');
    assert.equal(last.label, 'two');
  } finally { h.close(); }
});
