import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openTable, listTables} from '../src/backend.ts';
import type {ObjectInfo} from '../src/api.ts';
import {xlsxSource} from '../src/adapter.ts';

// 只替换 HTTP 边界；真正执行开表分流、首页复用和目录分页。
const open = openTable as (key: string, signal?: AbortSignal, source?: 'db' | 'xlsx') => ReturnType<typeof openTable>;
const SHEET = '/api/platform/services/files.sheet_read/invoke';
const OBJECTS = '/api/platform/objects';
const FILES = '/api/platform/datasets/files.file/records';
function object(id: string): ObjectInfo {
  return {id, title: '测试表', revision: 3, operations: ['read', 'update'],
    fields: [{id: 'amount', label: '金额', type: 'decimal'}], input_schema: {properties: {amount: {}}}};
}
function sheet(table: string) {
  return {ok: true, table, table_title: '测试工作簿', sheet: 'S', sheet_title: 'Sheet1',
    content_version: 7, structure_version: 2, headers: ['金额', '备注'], writable: true,
    readonly_columns: [], column_widths: {}, total_rows: 1,
    rows: [{row_id: 'row-1', row_index: 2, source_modified: 'v1', values: {
      金额: {type: 'number', value: 12}, 备注: {type: 'text', value: '原文'},
    }}]};
}
type Call = {path: string; payload?: any};
async function fixture(run: (calls: Call[]) => Promise<void>, handler: (call: Call) => Promise<Response> | Response) {
  const previous = globalThis.fetch;
  const shared = (globalThis as any).shangshuPlatformCatalog;
  const calls: Call[] = [];
  delete (globalThis as any).shangshuPlatformCatalog;
  globalThis.fetch = async (url, init) => {
    const raw=String(url),query=new URL(raw,'http://test').searchParams;
    const call = {path:raw.includes('/services/')?raw.split('?')[0]:raw,
      payload:init?.body?JSON.parse(String(init.body)).payload:query.has('payload')?JSON.parse(query.get('payload')!):undefined};
    calls.push(call);
    return handler(call);
  };
  try { await run(calls); }
  finally { globalThis.fetch = previous; (globalThis as any).shangshuPlatformCatalog = shared; }
}
function unexpected(call: Call): never { throw Error(`不应读取：${call.path}`); }

test('文件范围读取把行身份和所需表头一起交给既有公共口',()=>fixture(async calls=>{
  await xlsxSource.readPage('target-file',{page:1,pageLength:100,rowIds:['row-1'],headers:['金额']});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].payload.row_ids,['row-1']);
  assert.deepEqual(calls[0].payload.headers,['金额']);
},call=>call.path===SHEET?Response.json(sheet(call.payload.table)):unexpected(call)));

test('明确 xlsx 来源只读目标首页，首次 loadPage 复用；带点 ID 不被猜成数据库', () => fixture(async calls => {
  const table = await open('orders.looks.like.db', undefined, 'xlsx');
  const page = await table.loadPage(1, 100);
  assert.equal(table.kind, 'xlsx');
  assert.equal(page.rows[0]['备注'], '原文');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.table, 'orders.looks.like.db');
  assert.equal(calls[0].payload.page, 1);
  assert.equal(calls[0].payload.page_length, 100);
}, call => call.path === SHEET ? Response.json(sheet(call.payload.table)) : unexpected(call)));

test('明确 db 来源定点读对象再按页读记录，短随机 ID 不被猜成文件', () => {
  const info = object('akr6lm8fo1');
  return fixture(async calls => {
    const table = await open(info.id, undefined, 'db');
    assert.equal(table.kind, 'db');
    assert.deepEqual(calls.map(c => c.path), [`${OBJECTS}/${info.id}`]);
    const page = await table.loadPage(1, 100);
    assert.equal(page.rows[0].amount, 12);
    assert.equal(calls.length, 2);
    assert.match(calls[1].path, /\/akr6lm8fo1\/records\?/);
    const query=new URL(calls[1].path,'http://test').searchParams;
    assert.deepEqual(JSON.parse(query.get('fields')||'null'),['amount']);
    assert.equal(query.get('include_definition'),'0','分页复用已取得定义，不反复装配定义');
    assert.deepEqual(JSON.parse(query.get('read_scope')||'null'),{mode:'query',purpose:'interactive',fields:['amount']});
  }, call => {
    if (call.path === `${OBJECTS}/${info.id}`) return Response.json({ok: true, object: info});
    if (call.path.startsWith(`${OBJECTS}/${info.id}/records?`)) return Response.json({object: info, rows: [{name: 'R', modified: 'v1', amount: 12}], total: 1, page: 1, page_length: 100});
    return unexpected(call);
  });
});

test('明确来源的拒绝不能转目录或另一种存储重试', async () => {
  for (const source of ['xlsx', 'db'] as const) {
    const intended = source === 'xlsx' ? SHEET : `${OBJECTS}/same-key`;
    await fixture(async calls => {
      await assert.rejects(() => open('same-key', undefined, source), /来源读取被拒/);
      assert.deepEqual(calls.map(c => c.path), [intended]);
    }, call => call.path === intended
      ? Response.json({ok: false, error: '来源读取被拒'}, {status: 403}) : unexpected(call));
  }
});

test('明确 db 的 companion 经对象详情绑定到正确工作簿，首页只读一次', () => {
  const info = {...object('orders.order'), companion: {object_id: 'orders.order', file_id: 'bound-file', definition_revision: 9,
    field_columns: [{field_id: 'amount', header: '金额', type: 'decimal'}]}};
  return fixture(async calls => {
    const table = await open(info.id, undefined, 'db');
    const page = await table.loadPage(1, 100);
    assert.equal(table.key, info.id);
    assert.equal(table.resourceId, 'bound-file');
    assert.equal(page.rows[0]['备注'], '原文');
    assert.deepEqual(calls.map(c => c.path), [`${OBJECTS}/${info.id}`, SHEET]);
    assert.equal(calls[1].payload.table, 'bound-file');
  }, call => {
    if (call.path === `${OBJECTS}/${info.id}`) return Response.json({ok: true, object: info});
    if (call.path === SHEET) return Response.json(sheet(call.payload.table));
    return unexpected(call);
  });
});

test('未声明来源的链接只经公共表身份解析器定位，不读取全目录', async () => {
  const info = object('old-object');
  await fixture(async calls => {
    assert.equal((await open(info.id)).kind, 'db');
    const file = await open('old-file');
    await file.loadPage(1, 100);
    assert.equal(file.kind, 'xlsx');
    assert.deepEqual(calls.map(c => c.path), ['/api/platform/table-resources/old-object',OBJECTS+'/old-object','/api/platform/table-resources/old-file',SHEET]);
  }, call => {
    if (call.path.startsWith('/api/platform/table-resources/'))return Response.json({table:call.path.split('/').at(-1),source:call.path.endsWith('old-object')?'db':'xlsx'});
    if (call.path === OBJECTS+'/old-object') return Response.json({object:info});
    if (call.path === SHEET) return Response.json(sheet(call.payload.table));
    return unexpected(call);
  });
});

test('身份解析被拒不扫描目录、不改走文件或对象',()=>fixture(async calls=>{
  await assert.rejects(()=>open('ambiguous'),/身份冲突/);
  assert.deepEqual(calls.map(call=>call.path),['/api/platform/table-resources/ambiguous']);
},call=>call.path==='/api/platform/table-resources/ambiguous'?Response.json({ok:false,error:'身份冲突'},{status:409}):unexpected(call)));

test('目录两源首请求并发：对象响应未释放时 xlsx 请求已经启动', async () => {
  let release!: (value: Response) => void;
  const gate = new Promise<Response>(resolve => {release = resolve;});
  await fixture(async calls => {
    const pending = listTables();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(calls.some(c => c.path.startsWith(FILES)), '对象清单尚未响应，但 xlsx 首请求应已发出');
    } finally { release(Response.json({list: [],total:0})); await pending; }
  }, call => {
    if (call.path.startsWith(OBJECTS+'?')) return gate;
    if (call.path.startsWith(FILES)) return Response.json({rows: [], total: 0});
    return unexpected(call);
  });
});

test('目录跨页及总上限边缘不重叠、不漏文件，页长改变不能移动偏移', () => {
  const rows = Array.from({length: 499}, (_, i) => ({name: `F-${i}`, file_name: `表-${i}.xlsx`}));
  return fixture(async calls => {
    const result = await listTables();
    assert.equal(result.total, 500);
    assert.equal(result.entries.length, 500);
    assert.equal(new Set(result.entries.map(entry => entry.key)).size, 500, '分页不能重复已有文件');
    assert.ok(result.entries.some(entry => entry.key === 'F-498'), '最后一张文件不能漏掉');
    assert.equal(result.truncated, false);
    assert.equal(calls.filter(c => c.path.startsWith(FILES)).length, 5);
  }, call => {
    if (call.path.startsWith(OBJECTS+'?')) return Response.json({list: [object('O')],total:1});
    if (call.path.startsWith(FILES)) {
      const query = new URL(call.path, 'http://test').searchParams;
      const page = Number(query.get('page')), length = Number(query.get('page_length'));
      assert.equal(JSON.parse(query.get('filters')!).scope, 'sheet');
      return Response.json({rows: rows.slice((page - 1) * length, page * length), total: rows.length});
    }
    return unexpected(call);
  });
});

test('目录任一来源失败仍显示成功侧，但明确 errors 非空，不能冒充完整清单', async () => {
  for (const failed of ['db', 'xlsx']) {
    await fixture(async () => {
      const result = await listTables() as Awaited<ReturnType<typeof listTables>> & {errors?: string[]};
      assert.equal(result.entries.length, 1);
      assert.ok(result.errors?.length, `${failed} 失败必须标记清单不完整`);
      assert.ok(result.errors.some(error => error.includes('测试来源故障')), '保留服务端失败原因');
    }, call => {
      if (call.path.startsWith(OBJECTS+'?')) return failed === 'db'
        ? Response.json({ok: false, error: '测试来源故障'}, {status: 503}) : Response.json({list: [object('O')],total:1});
      if (call.path.startsWith(FILES)) return failed === 'xlsx'
        ? Response.json({ok: false, error: '测试来源故障'}, {status: 503}) : Response.json({rows: [{name: 'F', file_name: '表.xlsx'}], total: 1});
      return unexpected(call);
    });
  }
});
