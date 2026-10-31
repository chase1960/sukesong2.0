// 表格中心行内编辑（2026-08-28）：post.update 走 提案→确认→落库 全链路。
// 帖子是「事」不是「账」，允许改内容/认领人/状态；非法状态与不存在 id 必须拒绝。
import { proposeForTest as requestConfirmation } from '../helpers/actor.ts';
import { testActor } from '../helpers/actor.ts';
import { withActor } from '../../src/core/actor.ts';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ss-postupd-'));
  process.env._SS_DATA_DIR = dir;
  const { localStore } = await import('../../src/core/store.ts');
  const { registerAllActionHandlers } = await import('../../src/capabilities/actions.ts');
  registerAllActionHandlers();
  const { registerPresetObjects } = await import('../../src/core/objects.ts');
  registerPresetObjects();
  return localStore;
}

describe('post.update 表格行内编辑', () => {
  let store: any;
  let postId: string;
  beforeEach(async () => {
    store = await fresh();
    postId = await withActor(testActor, async () =>
      store.insert('process', 'posts', { content: '跟进蓝海制造催收', status: '待认领', assignee: '', author: '老板', source: '手动', created_at: new Date().toISOString() }));
  });

  it('提案→确认→行更新；只改声明过的字段', async () => {
    const eid = await requestConfirmation(store, {
      capability: 'post.update', entity_type: 'post', entity_id: postId,
      payload: { id: postId, assignee: '张一诺', status: '已认领' }, initiator: 'agent',
    });
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    await withActor(testActor, () => resolveConfirmation(store, eid, 'confirmed', testActor));
    const [row] = await store.query('process', 'posts', { id: postId });
    assert.equal(row.assignee, '张一诺');
    assert.equal(row.status, '已认领');
    assert.equal(row.content, '跟进蓝海制造催收');   // 未提交的字段不动
  });

  it('非法状态在提案即拒；帖子不存在/空 patch 在确认执行时拒', async () => {
    // 非法状态：inputSchema enum 在提案（checkAction）就拦下
    await assert.rejects(() => requestConfirmation(store, {
      capability: 'post.update', entity_type: 'post', entity_id: postId,
      payload: { id: postId, status: '已作废' }, initiator: 'agent',
    }), /已作废|allowed values|enum/);
    // 帖子不存在：提案通过（resolve 不在此路径），确认执行时 handler 拒绝
    const { resolveConfirmation } = await import('../../src/core/confirm.ts');
    const e1 = await requestConfirmation(store, {
      capability: 'post.update', entity_type: 'post', entity_id: 'no-such',
      payload: { id: 'no-such', assignee: 'x' }, initiator: 'agent',
    });
    await assert.rejects(() => withActor(testActor, () => resolveConfirmation(store, e1, 'confirmed', testActor)), /帖子不存在/);
    // 空 patch：同样在执行时拒绝
    const e2 = await requestConfirmation(store, {
      capability: 'post.update', entity_type: 'post', entity_id: postId,
      payload: { id: postId }, initiator: 'agent',
    });
    await assert.rejects(() => withActor(testActor, () => resolveConfirmation(store, e2, 'confirmed', testActor)), /没有可更新的字段/);
  });
});
