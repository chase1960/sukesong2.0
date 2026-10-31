import assert from 'node:assert/strict';
import { it } from 'node:test';
import { withPeopleDirectory } from '../../src/core/auth/people.ts';
import { taskScopeMembers, createTask, updateTask, visibleTasks } from '../../src/capabilities/task-domain.ts';
import { SqliteStore } from '../../src/core/storage/sqlite.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('平台任务范围独立于部门，未分配和缺失人员不扩大权限', async () => {
  const people = [
    { username: 'jzy', identity_id: '1', group: '管理', scope: 'company', display_name: '江' },
    { username: 'hqf', identity_id: '2', group: '开发', scope: 'department', display_name: '黄' },
    { username: 'wzj', identity_id: '3', group: '开发', scope: 'department', display_name: '王' },
    { username: 'hzq', identity_id: '4', group: '', scope: 'department', display_name: '何' },
  ];
  const scope = (id: string, role = 'manager') => withPeopleDirectory(async () => people,
    () => taskScopeMembers({} as any, { id, role } as any));
  assert.deepEqual(await scope('hzq'), ['hzq']);
  assert.deepEqual(await scope('missing'), ['missing']);
  assert.deepEqual(await scope('hqf'), ['hqf', 'wzj']);
  assert.equal(await scope('jzy'), null);
  assert.equal(await scope('wzj', 'admin'), null);
});

it('无部门管理者可派单、跨部门改派和验收自己发起的任务，但不能读改无关任务', async () => {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'ss-related-task-')), 'state.sqlite'));
  const people = [
    { username: 'jzy', identity_id: '1', group: '', scope: 'related', display_name: '江' },
    { username: 'hqf', identity_id: '2', group: '开发', scope: 'related', display_name: '黄' },
    { username: 'peer', identity_id: '3', group: '', scope: 'related', display_name: '同事' },
  ];
  const ctx = (id: string, role: string) => ({store, actor: {id, role, kind: 'human', channel: 'web'}} as any);
  try {
    await withPeopleDirectory(async () => people, async () => {
      const jzy = ctx('jzy', 'finance'); // 多角色的 BFF 兼容投影仍为 finance
      const id = await createTask({title: '材料整理', assignee_id: 'hqf'}, jzy);
      await updateTask({id, assignee_id: 'peer'}, jzy);
      await updateTask({id, status: '进行中'}, ctx('peer', 'staff'));
      await updateTask({id, status: '待验收', result: '整理完成'}, ctx('peer', 'staff'));
      await updateTask({id, status: '已完成'}, jzy);
      const other = await store.insert('process', 'tasks', {title: '无关任务', created_by: 'peer', assignee_id: 'hqf', status: '待办'});
      assert.deepEqual((await visibleTasks(store, jzy.actor)).map(row => row.id), [id]);
      await assert.rejects(updateTask({id: other, title: '越权修改'}, jzy), /范围|权限/);
      assert.equal((await store.query('process', 'tasks', {id}))[0].status, '已完成');
    });
  } finally { await store.close(); }
});
