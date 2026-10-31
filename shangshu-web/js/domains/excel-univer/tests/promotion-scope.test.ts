import {it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {createTableByPromotion} from '../src/db-capabilities.ts';
import {
  buildPromotionScopeEditor,
  defaultTableAccess,
  validatePromotionScopes,
} from '../src/promotion-scope.ts';

/**
 * **晋升入口**的「主体范围」（PKG-117-T01）。
 *
 * **测试通过 = 下面全部成立**：
 *  1. **缺主体范围不能提交**：报错**点名是哪一列**，而且**一个写请求都没发**
 *     （不许先建了表文件才发现没填）；
 *  2. 选了「部门」却没指到具体部门 ⇒ 同样被拒（人话）；
 *  3. 面板上每一列都能选「全局／部门／个人」，选部门／个人能指到具体对象；
 *  4. 落库载荷是**新形状**（列级 `access` ＋ 表级 `access`），**旧三键不再产出**。
 */

function fakeFetch(routes: Record<string, (body: any) => any>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    const key = Object.keys(routes).find(item => String(url).includes(item));
    if (!key) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: '没有这条路' }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...routes[key](body) }) } as unknown as Response;
  };
  return { fetcher, calls };
}

const subjects = {
  departments: [{ id: '财务', label: '财务部' }],
  users: [{ id: 'a@b.com', label: '张三（a@b.com）' }],
};

it('缺主体范围不能提交：报错点名是哪一列，且一个写请求都没发', async () => {
  const { fetcher, calls } = fakeFetch({
    'files.create/execute': () => ({ result: { file: 'FILE-1' } }),
    'files.promotion_definition/invoke': () => ({ structure_version: 3, definition_version: 2 }),
    'files.promotion_define/execute': () => ({ result: { lifecycle: { object_id: 'OBJ-9' } } }),
  });
  await assert.rejects(
    () => createTableByPromotion(fetcher, {
      fileName: '客户台账',
      headers: ['客户', '金额'],
      attribution: { level: 'personal' },
      idempotencyKey: 'k',
    }),
    /客户/,
    '报错没有点名是哪一列没填',
  );
  assert.equal(calls.length, 0, '没填主体范围却发了写请求（表文件已经建出去了）');
});

it('一列没填、另一列填了 ⇒ 报到**没填的那一列**', async () => {
  const { fetcher, calls } = fakeFetch({});
  await assert.rejects(
    () => createTableByPromotion(fetcher, {
      fileName: '客户台账',
      headers: ['客户', '金额'],
      attribution: { level: 'personal' },
      idempotencyKey: 'k',
      columns: [
        { header: '客户', access: { read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' } } },
      ],
    }),
    /金额/,
    '报错没有点名缺的是「金额」这一列',
  );
  assert.equal(calls.length, 0);
});

it('选了「部门」却没指到具体部门 ⇒ 被拒（人话），不发写请求', async () => {
  const { fetcher, calls } = fakeFetch({});
  await assert.rejects(
    () => createTableByPromotion(fetcher, {
      fileName: '客户台账',
      headers: ['客户'],
      attribution: { level: 'personal' },
      idempotencyKey: 'k',
      columns: [{ header: '客户', access: { read: { scope: 'department', departments: [] }, write: { scope: 'global' }, download: { scope: 'global' } } }],
    }),
    /具体是哪个部门/,
  );
  assert.equal(calls.length, 0);
});

it('每一列都指了档 ⇒ 落库是新形状：列级 access ＋ 表级 access，旧三键不再产出', async () => {
  const { fetcher, calls } = fakeFetch({
    'files.create/execute': () => ({ result: { file: 'FILE-1' } }),
    'files.promotion_definition/invoke': () => ({ structure_version: 3, definition_version: 2 }),
    'files.promotion_define/execute': () => ({ result: { lifecycle: { object_id: 'OBJ-9', promoted: 2, managed_records: 5 } } }),
  });
  const result = await createTableByPromotion(fetcher, {
    fileName: '客户台账',
    headers: ['客户', '金额'],
    attribution: { level: 'personal' },
    idempotencyKey: 'k-new',
    columns: [
      { header: '客户', access: { read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' } } },
      { header: '金额', access: { read: { scope: 'department', departments: ['财务'] }, write: { scope: 'department', departments: ['财务'] }, download: { scope: 'personal', users: ['a@b.com'] } } },
    ],
  });
  const promote = calls.find(call => call.url.includes('files.promotion_define'))!;
  assert.deepEqual(promote.body.payload.definition.columns[0].access, {
    read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' },
  });
  assert.deepEqual(promote.body.payload.definition.columns[1].access, {
    read: { scope: 'department', departments: ['财务'] },
    write: { scope: 'department', departments: ['财务'] },
    download: { scope: 'personal', users: ['a@b.com'] },
  });
  assert.deepEqual(promote.body.payload.definition.access, defaultTableAccess());
  for (const column of promote.body.payload.definition.columns) {
    for (const key of ['read_roles', 'write_roles', 'download_roles']) {
      assert.equal(key in column, false, `晋升载荷里还有旧键 ${key}`);
    }
  }
  assert.equal(result.objectId, 'OBJ-9');
});

it('面板上：每一列都能选全局／部门／个人，选了部门／个人能指到具体对象；没选就不许提交', () => {
  const dom = new JSDOM('<div></div>');
  const editor = buildPromotionScopeEditor(dom.window.document, ['客户', '金额'], subjects);
  assert.equal(editor.element.querySelectorAll('fieldset[data-column]').length, 2, '不是每列一组');
  const customer = editor.element.querySelector('fieldset[data-column="客户"]')!;
  const radio = customer.querySelector('input[value="department"]') as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change'));
  const box = customer.querySelector('input[data-department="财务"]') as HTMLInputElement;
  assert.ok(box, '选「部门」后没有出现部门清单');
  box.checked = true;
  const scopes = editor.read();
  assert.deepEqual(scopes[0].access, {
    read: { scope: 'department', departments: ['财务'] },
    write: { scope: 'department', departments: ['财务'] },
    download: { scope: 'department', departments: ['财务'] },
  });
  // 没选的那一列 ⇒ 校验时报出是哪一列。
  assert.throws(() => validatePromotionScopes(scopes, ['客户', '金额']), /金额/);
  dom.window.close();
});
