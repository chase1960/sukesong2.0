/**
 * 决议③：**在全局、部门、个人后面加一档「无人（除管理员）」**（用户 2026-10-26 拍板）。
 *
 * 落点有两份档位清单，**都要改**：
 *  · `access-scope.ts` —— **字段权限面板** ＋ **表权限面板**（共用这一份）；
 *  · `promotion-scope.ts` —— **晋升入口**的另一份清单。
 *
 * **测试通过 = 下面全部成立**：
 *  1. 面板的档位下拉里有**第四档「无人（除管理员）」**，且**排在「个人」之后**
 *     （顺序不对 ⇒ 用户找不到那一档）；
 *  2. 选「无人」时**不要求**指到具体部门／人员（两张清单不出现、校验不拦），
 *     读回来的声明是 `{"scope":"none"}` —— **不许多带子键**
 *     （多带 `departments`／`users` ⇒ 后端那条口会拒）；
 *  3. 晋升入口那份清单**也有第四档**，读出来同样是 `{"scope":"none"}`；
 *  4. 声明**能被读回来**（`normalizeOperationAccess` 认这一档 ——
 *     认不得就会被**静默丢掉**，面板看着选了、存上去却是空的）。
 *
 * **跑法**（域内判据要**从 `shangshu-server` 目录跑**：那里有 tsx 也有 jsdom）：
 *   cd shangshu-server && node --import tsx --test --test-concurrency=1 \
 *     ../shangshu-web/js/domains/excel-univer/tests/scope-none.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {
  buildAccessEditor,
  normalizeAccessMap,
  normalizeOperationAccess,
  readAccessMap,
  validateAccessMap,
  type AccessMap,
} from '../src/access-scope';
import {buildPromotionScopeEditor, validatePromotionScopes} from '../src/promotion-scope';

const subjects = {
  departments: [{id: '财务', label: '财务部'}],
  users: [{id: 'a@b.com', label: '张三（a@b.com）'}],
};

/** 一行里那几档单选（按**顺序**读回来 —— 顺序是判据的一部分）。 */
function scopeChoices(row: Element): Array<{value: string; label: string}> {
  return Array.from(row.querySelectorAll('.access-scopes input')).map(input => {
    const label = (input.parentElement?.textContent || '').trim();
    return {value: (input as HTMLInputElement).value, label};
  });
}

test('① 面板的档位下拉里有第四档「无人（除管理员）」，且排在「个人」之后', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildAccessEditor({doc: dom.window.document, subject: '这一列', label: '金额', subjects});
  for (const op of ['read', 'write', 'download']) {
    const row = editor.element.querySelector(`[data-operation="${op}"]`)!;
    const choices = scopeChoices(row);
    const values = choices.map(choice => choice.value);
    assert.deepEqual(
      values.slice(0, 4),
      ['global', 'department', 'personal', 'none'],
      `「${op}」这一行的档位顺序不对（第四档没排在「个人」之后）：${values.join(' / ')}`,
    );
    const none = choices.find(choice => choice.value === 'none')!;
    assert.equal(none.label, '无人（除管理员）', `「${op}」这一行的第四档没有说人话：${none.label}`);
  }
  dom.window.close();
});

test('② 选「无人」时不要求指到具体部门／人员；读回来是 {"scope":"none"}（不许多带子键）', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildAccessEditor({doc: dom.window.document, subject: '这一列', label: '金额', subjects});
  const write = editor.element.querySelector('[data-operation="write"]')!;
  const radio = write.querySelector('input[value="none"]') as HTMLInputElement;
  assert.ok(radio, '「写」这一行没有「无人（除管理员）」这一档');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change'));

  /* 两张主体清单都**不出现** ⇒ 选「无人」不需要指到任何部门／人。 */
  assert.equal(
    write.querySelector('[data-subject-kind="departments"]')!.hasAttribute('hidden'),
    true,
    '选「无人」却还让人选部门',
  );
  assert.equal(
    write.querySelector('[data-subject-kind="users"]')!.hasAttribute('hidden'),
    true,
    '选「无人」却还让人选人',
  );

  /* 读回来的声明是 `{"scope":"none"}` —— **不许多带子键**。 */
  const access = editor.read();
  assert.deepEqual(access.write, {scope: 'none'}, '读回来的声明不干净（多了子键或变了形状）');
  assert.equal('departments' in (access.write as object), false, '「无人」这一档多带了 departments');
  assert.equal('users' in (access.write as object), false, '「无人」这一档多带了 users');

  /* 必填的三项都定成「无人」⇒ 校验**不拦**（不许报「还没选具体是哪个部门」）。 */
  for (const op of ['read', 'download']) {
    const row = editor.element.querySelector(`[data-operation="${op}"]`)!;
    const none = row.querySelector('input[value="none"]') as HTMLInputElement;
    none.checked = true;
    none.dispatchEvent(new dom.window.Event('change'));
  }
  const complete = editor.read();
  assert.deepEqual(complete.read, {scope: 'none'});
  assert.deepEqual(complete.download, {scope: 'none'});
  assert.doesNotThrow(
    () => validateAccessMap(complete, '金额', '这一列'),
    '选「无人」却被校验拦下来了（这一档不用指到具体对象）',
  );
  dom.window.close();
});

test('③ 声明能被读回来：「none」这一档认得（认不得会被静默丢掉）', () => {
  assert.deepEqual(normalizeOperationAccess({scope: 'none'}), {scope: 'none'});
  assert.deepEqual(normalizeOperationAccess({type: 'none'}), {scope: 'none'});
  assert.deepEqual(
    normalizeAccessMap({read: {scope: 'none'}, write: {scope: 'none'}}),
    {read: {scope: 'none'}, write: {scope: 'none'}},
    '「none」这一档被静默丢掉了（面板看着选了、存上去却是空的）',
  );
  assert.deepEqual(readAccessMap({access: {download: {scope: 'none'}}}), {download: {scope: 'none'}});
});

test('④ 晋升入口那份清单也有第四档，读出来同样是 {"scope":"none"}', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildPromotionScopeEditor(dom.window.document, ['客户', '金额'], subjects);
  const customer = editor.element.querySelector('fieldset[data-column="客户"]')!;
  const choices = scopeChoices(customer);
  assert.deepEqual(
    choices.map(choice => choice.value).slice(0, 4),
    ['global', 'department', 'personal', 'none'],
    `晋升入口的档位顺序不对：${choices.map(choice => choice.value).join(' / ')}`,
  );
  assert.equal(
    choices.find(choice => choice.value === 'none')!.label,
    '无人（除管理员）',
    '晋升入口的第四档没有说人话',
  );
  const radio = customer.querySelector('input[value="none"]') as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change'));
  /* 另一列也选「无人」—— 免得那一列空着（没选档）时读回来是空的。 */
  const amount = editor.element.querySelector('fieldset[data-column="金额"]')!;
  const amountNone = amount.querySelector('input[value="none"]') as HTMLInputElement;
  amountNone.checked = true;
  amountNone.dispatchEvent(new dom.window.Event('change'));
  const scopes = editor.read();
  assert.deepEqual(
    scopes[0].access,
    {read: {scope: 'none'}, write: {scope: 'none'}, download: {scope: 'none'}},
    '晋升入口读回来的「无人」这一档形状不对（多了子键或少了某一项）',
  );
  /* 不许多带子键。 */
  for (const scope of scopes) {
    for (const key of ['read', 'write', 'download']) {
      const value = scope.access[key] as Record<string, unknown>;
      assert.deepEqual(Object.keys(value), ['scope'], `「${scope.header}」的 ${key} 那一项多带了子键`);
      assert.equal(value.scope, 'none');
    }
  }
  assert.doesNotThrow(
    () => validatePromotionScopes(scopes, ['客户', '金额']),
    '选「无人」却被晋升校验拦下来了',
  );
  dom.window.close();
});

test('⑤ 面板上已有声明是「无人」时，那一档要选中（不能掉回空档）', () => {
  const dom = new JSDOM('<div></div>');
  const existing: AccessMap = {read: {scope: 'none'}, write: {scope: 'none'}, download: {scope: 'none'}};
  const editor = buildAccessEditor({
    doc: dom.window.document,
    subject: '这一列',
    label: '金额',
    subjects,
    access: existing,
  });
  const read = editor.element.querySelector('[data-operation="read"]')!;
  assert.equal(read.querySelector('input:checked')?.value, 'none', '已有的「无人」这一档没选中');
  assert.deepEqual(editor.read(), existing, '读回来的声明跟原来那份对不上');
  dom.window.close();
});
