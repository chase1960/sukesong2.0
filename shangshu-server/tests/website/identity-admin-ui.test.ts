import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../../../shangshu-web/js/real-users.js', import.meta.url), 'utf8');
function setup(identity?: Record<string, unknown>) {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'https://shangshu.local' });
  const w = dom.window as any;
  const calls: any[] = [];
  Object.assign(w, { RENDER: {}, isPlatformManaged: () => true, currentUserInfo: { role: 'admin', username: 'admin' },
    mainBox: () => w.document.querySelector('main'), $: (s: string) => w.document.querySelector(s),
    esc: (v: any) => String(v ?? ''), toast: () => {}, confirm: () => true,
    apiJSON: async (url: string) => {
      calls.push(url);
      if (url === 'api/platform/identities') return { list: [identity || { email: 'person@example.test', display_name: '员工', enabled: true, platform_role: 'staff', roles: ['Desk User'], collaboration_key: 'collaboration-uuid' }] };
      if (url === 'api/platform/contributions') return { roles: [{ role: 'Expense Approver', label: '费用审批人', assignable: true }, { role: 'Finance Approver', label: '财务复核人' }] };
      if (url === 'api/people?scope=tasks') return { list: [{ email: 'person@example.test', username: 'collaboration-uuid' }] };
      if (url === 'api/tasks') return { list: [{ assignee_id: 'collaboration-uuid', title: '未完成任务', status: '进行中' }] };
      throw new Error('unexpected ' + url);
    }, api: async (url: string, options: any) => { calls.push({ url, body: JSON.parse(options.body) }); return { json: async () => ({ ok: true }) }; },
  });
  w.eval(source);
  return { dom, w, calls };
}

it('仅有业务审批角色时明确显示未分配平台角色，不把会话员工投影冒充授权', async () => {
  const { dom, w } = setup({ email: 'approver@example.test', display_name: '审批人', enabled: true,
    platform_role: 'staff', platform_roles: [], roles: ['Expense Approver'], collaboration_key: 'approver-key' });
  try {
    await w.RENDER.accounts();
    const row = [...w.document.querySelectorAll('tr')].find((item: any) => item.textContent.includes('approver@example.test')) as any;
    assert.match(row.querySelector('[data-user-roles] summary').textContent, /未分配平台角色/);
    assert.equal(row.querySelectorAll('input[data-platform-role]:checked').length, 0);
    assert.equal(row.querySelector('input[data-business-role][value="Expense Approver"]').checked, true);
  } finally { dom.window.close(); }
});

it('内置 Administrator 不显示假停用和任务范围编辑入口', async () => {
  const { dom, w } = setup({ email: 'Administrator', display_name: 'Administrator', enabled: true,
    platform_roles: ['admin'], roles: ['System Manager'], collaboration_key: 'builtin-admin' });
  try {
    await w.RENDER.accounts();
    const row = [...w.document.querySelectorAll('tr')].find((item: any) => item.textContent.includes('Administrator')) as any;
    assert.ok(row);
    assert.equal([...row.querySelectorAll('button')].some((button: any) => button.textContent === '停用'), false);
    assert.match(row.textContent, /不可停用/);
    assert.match(row.textContent, /全公司（系统管理员）/);
    assert.equal(row.querySelector('[data-task-scope]'), null);
  } finally { dom.window.close(); }
});

it('平台多角色勾选复用一个提交，创建账号默认员工而非管理员', async () => {
  const { dom, w, calls } = setup();
  try {
    await w.RENDER.accounts();
    const roles = w.document.querySelector('[data-user-roles]');
    assert.ok(roles);
    roles.querySelector('[value="staff"]').checked = false;
    roles.querySelector('[value="manager"]').checked = true;
    roles.querySelector('[value="finance"]').checked = true;
    roles.querySelector('[value="Expense Approver"]').checked = true;
    await w.userSaveRoles('person@example.test', roles);
    assert.deepEqual(calls.find((c: any) => c.body)?.body.payload.roles, ['finance', 'manager']);
    assert.deepEqual(calls.find((c: any) => c.body)?.body.payload.business_roles, ['Expense Approver']);
    assert.equal(roles.querySelector('[value="Finance Approver"]'), null);
    assert.equal(w.document.querySelector('#nu-roles input:checked').value, 'staff');
  } finally { dom.window.close(); }
});

it('部门与范围分别提交，不把未分配解释为全公司', async () => {
  const { dom, w, calls } = setup();
  try {
    await w.RENDER.accounts();
    const element = w.document.querySelector('[data-task-scope]');
    assert.match(element.textContent, /未分配.*仅本人/);
    element.querySelector('[data-department]').value = '开发';
    element.querySelector('[data-scope]').value = 'department';
    await w.userSaveDepartment('person@example.test', element);
    assert.deepEqual(calls.find((c: any) => c.body)?.body.payload,
      { email: 'person@example.test', collaboration_group: '开发', collaboration_scope: 'department' });
    assert.equal(w.document.querySelector('#nu-department [data-scope]').value, 'related');
  } finally { dom.window.close(); }
});

it('平台账号有管理员导航入口并复用内核列表，不放开旧 users 页', async () => {
  const { dom, w, calls } = setup();
  try {
    assert.equal(typeof w.RENDER.accounts, 'function');
    await w.RENDER.accounts();
    assert.match(w.document.body.textContent, /person@example.test/);
    assert.deepEqual(calls, ['api/platform/identities', 'api/platform/contributions']);
    const apps = readFileSync(new URL('../../../shangshu-web/js/real-apps.js', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
    assert.match(apps, /\['accounts',\s*'账号管理'\]/);
    assert.match(app, /id: 'accounts'.*roles: \['admin'\]/);
  } finally { dom.window.close(); }
});

it('账号页停用提交 false，启用提交 true；在途任务按协作键匹配', async () => {
  const { dom, w, calls } = setup();
  try {
    await w.RENDER.users();
    const button = [...w.document.querySelectorAll('button')].find((b: any) => b.textContent === '停用') as any;
    let warning = '';
    w.confirm = (message: string) => { warning = message; return true; };
    await w.eval(button.getAttribute('onclick'));
    assert.equal(calls.find((c: any) => c.body)?.body.payload.enabled, false);
    assert.match(warning, /未完成任务/);
    calls.length = 0;
    await w.userToggleStatus('person@example.test', false, '员工');
    assert.equal(calls.find((c: any) => c.body)?.body.payload.enabled, true);
  } finally { dom.window.close(); }
});

it('在途任务查询失败时不伪装空清单或提交停用', async () => {
  const { dom, w, calls } = setup();
  try {
    const original = w.apiJSON;
    w.apiJSON = (url: string) => url === 'api/tasks' ? Promise.reject(new Error('offline')) : original(url);
    await w.userToggleStatus('person@example.test', true, '员工');
    assert.equal(calls.some((c: any) => c.body), false);
  } finally { dom.window.close(); }
});
