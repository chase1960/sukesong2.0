import {it} from 'node:test';
import assert from 'node:assert/strict';
// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {
  buildAccessEditor,
  normalizeAccessMap,
  normalizeSubjectOptions,
  readAccessMap,
  stripOldRoleKeys,
  validateAccessMap,
  type AccessMap,
} from '../src/access-scope.ts';

/**
 * 权限声明的**形状** ＋ **面板零件**（PKG-117-T01）。
 *
 * **测试通过 = 下面全部成立**：
 *  1. **必填三项**（读／写／下载）没定 ⇒ 报错**点名是哪一列**、说的是人话；
 *  2. 选了「部门」却没指到具体部门、选了「个人」却没指到具体人 ⇒ 同样被拒（人话）；
 *  3. **三个操作**（读／写／下载）都必填，**没有「跟随读」这一档**；
 *  4. 读回：列上的新形状能读成一份声明；**旧三键不再被读**（不留兼容函数）；
 *  5. 落库形状里**剥得掉**旧三键。
 *  6. 面板上**不再有「助手」「筛」那两行**（2026-10-26 去掉「助手」；2026-10-27 降维：「筛」并进「读」）；
 *  7. 旧声明里还带着 `assistant`／`filter` ⇒ 前端**不炸**、也不把它们当成未知操作。
 */

const subjects = {
  departments: [{id: '财务', label: '财务部'}, {id: '法务', label: '法务部'}],
  users: [{id: 'a@b.com', label: '张三（a@b.com）'}],
};

it('必填三项没定 ⇒ 报错点名是哪一列，说的是人话', () => {
  assert.throws(
    () => validateAccessMap({ write: { scope: 'global' }, download: { scope: 'global' } }, '金额', '这一列'),
    /金额/,
    '报错没有点名是哪一列',
  );
  assert.throws(
    () => validateAccessMap({ write: { scope: 'global' }, download: { scope: 'global' } }, '金额', '这一列'),
    /还没定/,
    '报错没有说清「还没定」',
  );
  assert.throws(
    () => validateAccessMap({}, '整张表', '整张表'),
    /整张表/,
  );
});

it('选了「部门」却没指到具体部门、选了「个人」却没指到具体人 ⇒ 被拒（人话）', () => {
  assert.throws(
    () => validateAccessMap({ read: { scope: 'global' }, write: { scope: 'department', departments: [] }, download: { scope: 'global' } }, '金额', '这一列'),
    /具体是哪个部门/,
    '没选部门时没有说清要选哪个部门',
  );
  assert.throws(
    () => validateAccessMap({ read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'personal', users: [] } }, '金额', '这一列'),
    /具体是哪个人/,
    '没选人时没有说清要选哪个人',
  );
});

it('面板上：三行（读／写／下载），没有「跟随读」这一档；也没有「筛」「助手」那两行', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildAccessEditor({ doc: dom.window.document, subject: '这一列', label: '金额', subjects });
  const rows = Array.from(editor.element.querySelectorAll('.access-row'));
  assert.deepEqual(rows.map(row => row.getAttribute('data-operation')), ['read', 'write', 'download']);
  for (const op of ['read', 'write', 'download']) {
    const row = editor.element.querySelector(`[data-operation="${op}"]`)!;
    assert.equal(row.querySelector('input[value="follow"]'), null, `「${op}」这一行不该有「跟随读」这一档`);
    assert.equal(row.querySelector('input:checked'), null, `「${op}」这一行不该替他选好一档`);
  }
  /* 2026-10-26 用户拍定去掉「助手」；2026-10-27 降维：「筛」并进「读」⇒ 两行都不许在。 */
  assert.equal(editor.element.querySelector('[data-operation="assistant"]'), null, '面板上还留着「助手」那一行');
  assert.equal(editor.element.querySelector('[data-operation="filter"]'), null, '面板上还留着「筛」那一行');
  assert.equal(editor.element.textContent?.includes('助手'), false, '面板上还有「助手」两个字');
  assert.equal(editor.element.textContent?.includes('筛'), false, '面板上还有「筛」那个维度');
  dom.window.close();
});

it('旧声明里还带着「助手」「筛」 ⇒ 前端不炸、也不把它们当成未知操作', () => {
  /* 降维之前存下来的定义，回到前端时还带着 `assistant` 与 `filter`。 */
  const legacy = {
    read: { scope: 'global' },
    write: { scope: 'global' },
    download: { scope: 'global' },
    assistant: { scope: 'none' },
    filter: { scope: 'none' },
  };
  assert.deepEqual(
    normalizeAccessMap(legacy),
    { read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' } },
    '旧声明里的「助手」「筛」被读进来了（那两档已经没了）',
  );
  assert.deepEqual(
    readAccessMap({ access: legacy }),
    { read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' } },
    '旧声明里的「助手」「筛」被读进来了',
  );
  /* 校验也不许因为那两档报错（那两档没了，不是「还没定」）。 */
  assert.doesNotThrow(
    () => validateAccessMap(normalizeAccessMap(legacy), '金额', '这一列'),
    '旧声明里带着「助手」「筛」就被校验拦下来了',
  );
  /* 面板照样开得起来 —— 只有那三行。 */
  const dom = new JSDOM('<div></div>');
  const editor = buildAccessEditor({
    doc: dom.window.document,
    subject: '这一列',
    label: '金额',
    subjects,
    access: normalizeAccessMap(legacy),
  });
  assert.deepEqual(
    Array.from(editor.element.querySelectorAll('.access-row')).map(row => row.getAttribute('data-operation')),
    ['read', 'write', 'download'],
    '旧声明里带着「助手」「筛」时，面板不是那三行',
  );
  assert.equal(editor.element.textContent?.includes('助手'), false, '面板上还有「助手」两个字');
  dom.window.close();
});

it('面板上：选「部门」才出现部门清单、选「个人」才出现人员清单；读回的是选中那一档', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildAccessEditor({ doc: dom.window.document, subject: '这一列', label: '金额', subjects });
  const write = editor.element.querySelector('[data-operation="write"]')!;
  assert.equal(write.querySelector('[data-subject-kind="departments"]')!.hasAttribute('hidden'), true);
  const radio = write.querySelector('input[value="department"]') as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change'));
  assert.equal(write.querySelector('[data-subject-kind="departments"]')!.hasAttribute('hidden'), false);
  const box = write.querySelector('input[data-department="财务"]') as HTMLInputElement;
  box.checked = true;
  const access = editor.read();
  assert.deepEqual(access.write, { scope: 'department', departments: ['财务'] });
  dom.window.close();
});

it('读回：新形状读得成声明；旧三键不再被读（不留兼容函数）', () => {
  assert.deepEqual(
    readAccessMap({ access: { read: { scope: 'global' }, write: { scope: 'department', departments: ['财务'] } } }),
    { read: { scope: 'global' }, write: { scope: 'department', departments: ['财务'] } },
  );
  assert.deepEqual(readAccessMap({ read_roles: ['Desk User'], write_roles: ['Desk User'] }), {}, '旧三键还在被读');
  assert.deepEqual(normalizeAccessMap({ download: { scope: 'personal', users: ['a@b.com'] } }), {
    download: { scope: 'personal', users: ['a@b.com'] },
  });
});

it('落库形状：旧三键剥得掉（面板不再产出它们）', () => {
  const stripped = stripOldRoleKeys({ header: '金额', read_roles: ['Desk User'], write_roles: ['Desk User'], download_roles: ['Desk User'], access: { read: { scope: 'global' } } });
  assert.equal('read_roles' in stripped, false);
  assert.equal('write_roles' in stripped, false);
  assert.equal('download_roles' in stripped, false);
  assert.deepEqual((stripped as { access: AccessMap }).access, { read: { scope: 'global' } });
});

it('主体清单：认后端给的 departments / users，也认同义名；读不到就是空清单（不猜）', () => {
  assert.deepEqual(normalizeSubjectOptions({ departments: [{ id: '财务', label: '财务部' }], users: [{ id: 'a@b.com', label: '张三' }] }), {
    departments: [{ id: '财务', label: '财务部' }],
    users: [{ id: 'a@b.com', label: '张三' }],
  });
  assert.deepEqual(normalizeSubjectOptions({ department_options: ['财务'], user_options: ['a@b.com'] }), {
    departments: [{ id: '财务', label: '财务' }],
    users: [{ id: 'a@b.com', label: 'a@b.com' }],
  });
  assert.deepEqual(normalizeSubjectOptions(null), { departments: [], users: [] });
});
