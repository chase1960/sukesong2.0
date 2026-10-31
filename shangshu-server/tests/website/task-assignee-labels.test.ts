import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

it('任务创建及改派只显示姓名，同名加短标识而不改变协作键', async () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window as any;
  const people = [
    { username: 'aaaaaaaa-1111-4111-8111-111111111111', display_name: '甲' },
    { username: 'bbbbbbbb-1111-4111-8111-111111111111', display_name: '同名' },
    { username: 'cccccccc-1111-4111-8111-111111111111', display_name: '同名' },
  ];
  let form: any;
  Object.assign(w, { RENDER: {}, currentUserInfo: { role: 'admin' }, apiJSON: async () => ({ list: people }), openSchemaForm: (value: any) => { form = value; } });
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-task.js', import.meta.url), 'utf8') + '\nwindow.__setTaskRows = rows => { rtRows = rows; };');
    await w.rtCreateTaskForm();
    assert.equal(form.title, '新建任务');
    const check = () => {
      const field = form.properties.assignee_id;
      assert.deepEqual(Array.from(field.enum), people.map(p => p.username));
      assert.equal(field.enumNames[0], '甲');
      assert.notEqual(field.enumNames[1], field.enumNames[2]);
      assert.ok(field.enumNames.every((s: string) => s.length < 24));
    };
    check();
    w.__setTaskRows([{ id: 't', title: '任务', status: '待办', _version: 1 }]);
    form = undefined;
    await w.rtEditTask('t');
    assert.ok(form, '任务详情应打开可办理表单');
    check();
    assert.match(form.description, /任务负责人提交结果/);
    assert.match(form.description, /任务管理者验收或退回/);
    assert.doesNotMatch(form.description, /只有负责人可验收/);
  } finally { dom.window.close(); }
});
