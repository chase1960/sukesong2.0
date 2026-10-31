import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ChatTableHarness, type TableChatDependencies } from '../../src/adapters/web/platform-chat-table.ts';

const free = () => ({ options: null, allow_custom: true, nullable: true });
const fixed = () => ({ options: { items: [{ value: 'DD', label: '标准项' }], total: 73, page: 1, page_length: 10, has_more: true }, allow_custom: false, nullable: false });
function fixture(source: 'xlsx' | 'managed' | 'native' = 'xlsx') {
  const calls: any[] = [];
  let current = 1;
  const file = (): any => ({ table: 'file-1', table_title: '业务表', sheet: 's1', content_version: current,
    structure_version: 4, headers: ['状态', '是否', '数量', '编号', '备注'], total_rows: 1,
    column_widths: { 状态: 88 }, column_types: { 是否: 'boolean' }, promoted_columns: [{ field: 'db_status', header: '状态' }],
    diagnostics: { internal: 'no-model' }, rows: [{ row_id: 'r-000001', row_index: 2, record_version: `record-${current}`,
      values: { 状态: { type: 'text', value: 'DD' }, 是否: { type: 'boolean', value: false }, 数量: { type: 'number', value: 0 }, 编号: { type: 'text', value: '001' }, 备注: { type: 'text', value: '附注' } }, styles: { 状态: 'no-model' } }] });
  const deps: TableChatDependencies = {
    resolve: async table => { calls.push(['resolve', table]); return { table, source: source === 'xlsx' ? 'xlsx' : 'db' }; },
    definition: async id => { calls.push(['definition', id]); return { id, source, revision: 3, title: '业务表',
      doctype: 'Private Physical Table', fields: [{ id: 'db_status', label: '状态', type: 'text' }, { id: 'db_flag', label: '是否', type: 'boolean' }], input_schema: { private: true } }; },
    query: async (id, payload) => { calls.push(['query', id, payload]); return { total: 1, rows: [{ name: payload.filters.name || 'row-1', modified: `m${current}`, db_status: 'DD', db_flag: false, secret: 'not-selected' }] }; },
    service: async (id, payload) => {
      calls.push(['service', id, payload]);
      if (id === 'files.sheet_read') return file();
      if (id === 'platform.object.values_read') return { rows: payload.names.map((name: string) => ({ name, modified: `m${current}`, db_status: 'DD', db_flag: false })) };
      if (id === 'files.sheet_input_constraints') return { table: 'file-1', columns: payload.headers.includes('状态') ? { 状态: fixed() } : {} };
      if (id === 'platform.object.input_constraints') return { fields: Object.fromEntries(payload.fields.map((f: string) => [f, f === 'db_status' ? fixed() : { options: { items: [{ value: true }, { value: false }], total: 2, has_more: false }, allow_custom: false, nullable: true }])) };
      throw Error('unexpected service');
    },
    authorized: () => true,
  };
  return { deps, calls, harness: new ChatTableHarness(deps), setVersion: (n: number) => { current = n; }, file };
}

it('日常文件表只给位置/值/三项约束，不给布局、控件、晋升映射、版本或诊断', async () => {
  const { harness } = fixture();
  const result = await harness.read({ table: 'file-1' });
  assert.deepEqual(Object.keys(result.inputs.状态).sort(), ['allow_custom', 'nullable', 'options']);
  assert.deepEqual(result.inputs.编号, free());
  assert.equal(result.rows[0].values.是否, false); assert.equal(result.rows[0].values.数量, 0);
  assert.equal(result.rows[0].values.编号, '001');
  assert.doesNotMatch(JSON.stringify(result), /diagnostics|column_widths|column_types|promoted|db_status|record_version|content_version|control_type|no-model/);
});
it('一次改多格只组一个公共包，Harness带原表/行版本，不发额外读请求', async () => {
  const { harness, calls } = fixture();
  const result = await harness.read({ table: 'file-1' }), count = calls.length;
  const prepared = harness.prepare({ read_ref: result.read_ref, changes: [
    { row_id: 'r-000001', header: '是否', value: false }, { row_id: 'r-000001', header: '数量', value: 0 },
    { row_id: 'r-000001', header: '编号', value: '001' }, { row_id: 'r-000001', header: '备注', value: null },
  ] }, 'request-1');
  assert.equal(prepared.action, 'files.sheet_cells_write');
  assert.equal(prepared.payload.expected_content_version, 1);
  assert.deepEqual(prepared.payload.expected_record_versions, { 'r-000001': 'record-1' });
  assert.deepEqual(prepared.payload.cells.map((c: any) => c.value), [
    { type: 'boolean', value: false }, { type: 'number', value: 0 }, { type: 'text', value: '001' }, { type: 'empty', value: null },
  ]);
  assert.equal(calls.length, count, '写前不重读最新版');
});
it('两个不同读取上下文分别钉原版本，后一次读取不会改掉前一次版本', async () => {
  const { harness, setVersion } = fixture();
  const old = await harness.read({ table: 'file-1' }); setVersion(2);
  const fresh = await harness.read({ table: 'file-1' });
  const changes = [{ row_id: 'r-000001', header: '状态', value: 'DD' }];
  assert.equal(harness.prepare({ read_ref: old.read_ref, changes }, 'a').payload.expected_content_version, 1);
  assert.equal(harness.prepare({ read_ref: fresh.read_ref, changes }, 'b').payload.expected_content_version, 2);
});
it('未读位置、重复位置、手填版本、类型包和非有限数字都拒绝，不默默扩大范围', async () => {
  const { harness } = fixture(); const read = await harness.read({ table: 'file-1', headers: ['状态'] });
  for (const changes of [[{ row_id: 'other', header: '状态', value: 'x' }], [{ row_id: 'r-000001', header: '是否', value: true }],
    [{ row_id: 'r-000001', header: '状态', value: { type: 'text', value: 'x' } }], [{ row_id: 'r-000001', header: '状态', value: Infinity }],
    Array(2).fill({ row_id: 'r-000001', header: '状态', value: 'x' })]) {
    assert.throws(() => harness.prepare({ read_ref: read.read_ref, changes }, 'op'));
  }
  assert.throws(() => harness.prepare({ read_ref: read.read_ref, changes: [], expected_content_version: 99 }, 'op'));
});
it('读取引用隔离于本轮/身份，关闭后失效，不为旧ref现读代填', async () => {
  const one = fixture(), two = fixture(); const read = await one.harness.read({ table: 'file-1' });
  const input = { read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: 'x' }] };
  assert.throws(() => two.harness.prepare(input, 'op'), /失效/);
  one.harness.close(); assert.throws(() => one.harness.prepare(input, 'op'), /失效/);
  assert.deepEqual(two.calls, []);
});
it('选项搜索只查当前已读字段，不取行或整表；明确保留码与显示名及分页', async () => {
  const { harness, calls, deps } = fixture(); const read = await harness.read({ table: 'file-1' }); calls.length = 0;
  deps.service = async (id, payload) => { calls.push([id, payload]); return { table: 'file-1', columns: { 状态: fixed() } }; };
  const result = await harness.options({ read_ref: read.read_ref, header: '状态', search: 'D', page: 2, page_length: 5 });
  assert.deepEqual(calls, [['files.sheet_input_constraints', { table: 'file-1', headers: ['状态'], search: 'D', page: 2, page_length: 5 }]]);
  assert.equal(result.options.items[0].value, 'DD'); assert.equal(result.options.items[0].label, '标准项');
  await assert.rejects(() => harness.options({ read_ref: read.read_ref, header: 'secret' }), /已读/);
});
it('受管对象同样给表头和值，内部映射为单次update_many并保原modified/revision', async () => {
  const { harness, calls } = fixture('managed'); const read = await harness.read({ table: 'object-1', headers: ['是否'] });
  assert.deepEqual(read.headers, ['是否']); assert.equal(read.rows[0].values.是否, false);
  assert.doesNotMatch(JSON.stringify(read), /doctype|db_flag|managed|expected_|input_schema/);
  const before = calls.length;
  const prepared = harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'row-1', header: '是否', value: false }] }, 'op');
  assert.equal(prepared.action, 'platform.object.update_many');
  assert.equal(prepared.payload.expected_revision, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.payload.records)), [{ name: 'row-1', expected_modified: 'm1', values: { db_flag: false } }]);
  assert.equal(calls.length, before);
  const q = calls.find(x => x[0] === 'query')[2]; assert.deepEqual(q.fields, ['db_flag']); assert.equal(q.include_definition, false);
});
it('数据库按已知行只查该行，不能返回另一行冒充或缺版本后默认写', async () => {
  const { harness, deps, calls } = fixture('managed');
  const read = await harness.read({ table: 'object-1', row_ids: ['only'], headers: ['状态'] });
  assert.deepEqual(calls.find(x => x[0] === 'service' && x[1] === 'platform.object.values_read'),
    ['service','platform.object.values_read', { object_id: 'object-1', names: ['only'], fields: ['db_status'] }]);
  assert.equal(calls.some(x => x[0] === 'query'), false, '不拿不支持的name筛选或整表查询冒充精确读');
  assert.equal(read.rows[0].row_id, 'only');
  const old = deps.service;
  deps.service = async (id, payload) => id === 'platform.object.values_read' ? { rows: [{ name: 'other', modified: 'm2', db_status: 'x' }] } : old(id, payload);
  await assert.rejects(() => harness.read({ table: 'object-1', row_ids: ['only'], headers: ['状态'] }), /身份/);
});
it('原生对象单行沿原CAS，多行不拆动作、不冒充支持原子包', async () => {
  const { harness, deps } = fixture('native');
  const read = await harness.read({ table: 'native-1', headers: ['状态'] });
  const one = harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'row-1', header: '状态', value: 'DD' }] }, 'op');
  assert.equal(one.action, 'platform.object.update'); assert.equal(one.payload.expected_modified, 'm1');
  deps.query = async () => ({ rows: [{ name: 'a', modified: 'a1', db_status: 'a' }, { name: 'b', modified: 'b1', db_status: 'b' }], total: 2 });
  const two = await harness.read({ table: 'native-1', headers: ['状态'] });
  assert.throws(() => harness.prepare({ read_ref: two.read_ref, changes: ['a', 'b'].map(row_id => ({ row_id, header: '状态', value: 'DD' })) }, 'op'), /多行原子/);
});
it('权限和约束服务失败不改成自由输入，不回退其他存储', async () => {
  const { harness, deps, calls } = fixture(); deps.service = async () => { throw Error('当前字段无权读取'); };
  await assert.rejects(() => harness.read({ table: 'file-1' }), /无权/);
  assert.deepEqual(calls, [['resolve', 'file-1']]);
  const other = fixture(); const read = await other.harness.read({ table: 'file-1' }); other.deps.authorized = () => false;
  assert.throws(() => other.harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: 'x' }] }, 'op'), /权限/);
});
it('隐藏列不会变成自由列暴露其值或选项', async () => {
  const { harness, deps, file } = fixture(); deps.service = async (id, payload) => {
    if (id === 'files.sheet_read') { const raw = file(); raw.rows[0].values.状态 = { type: 'hidden', value: null } as any; return raw; }
    assert.ok(!payload.headers.includes('状态')); return { table: 'file-1', columns: {} };
  };
  const read = await harness.read({ table: 'file-1' });
  assert.ok(!read.headers.includes('状态')); assert.equal(read.inputs.状态, undefined);
});
it('大范围和非法参数在上游前拒绝；不静默只返回前64列', async () => {
  const { harness, calls } = fixture();
  await assert.rejects(() => harness.read({ table: 'file-1', headers: Array.from({ length: 65 }, (_, i) => String(i)) }));
  await assert.rejects(() => harness.read({ table: 'file-1', page_length: 500 }));
  assert.deepEqual(calls, []);
});
it('伴随表沿既有companion_write携带原对象/绑定/源行版本，模型不见这些映射', async () => {
  const { harness, deps, file } = fixture('managed');
  deps.definition = async id => ({ id, title: '业务表', source: 'managed', revision: 3,
    companion: { file_id: 'file-1', definition_revision: 'binding-original-fingerprint', field_columns: [{ header: '状态', field_id: 'db_status' }] },
    fields: [{ id: 'db_status', label: '状态', type: 'text' }] });
  const old = deps.service;
  deps.service = async (id, payload) => {
    if (id === 'files.sheet_read') { const raw = file(); raw.rows[0].source_modified = 'source-v1'; return raw; }
    return old(id, payload);
  };
  const read = await harness.read({ table: 'object-1', headers: ['状态','编号'] });
  assert.doesNotMatch(JSON.stringify(read), /companion|definition_revision|db_status|source-v1|file-1/);
  const write = harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: 'DD' }, { row_id: 'r-000001', header: '编号', value: '001' }] }, 'op');
  assert.equal(write.action, 'platform.object.companion_write');
  assert.equal(write.payload.object_id, 'object-1'); assert.equal(write.payload.file_id, 'file-1');
  assert.equal(write.payload.expected_revision, 3); assert.equal(write.payload.definition_revision, 'binding-original-fingerprint');
  assert.deepEqual(write.payload.expected_modified, { 'r-000001': 'source-v1' });
  assert.equal(write.payload.expected_record_versions, undefined);
});
it('伴随表绑定指纹必须为原字符串，不能把数字修订当作有效绑定', async () => {
  const { harness, deps } = fixture('managed');
  deps.definition = async id => ({ id, title: '业务表', source: 'managed', revision: 3,
    companion: { file_id: 'file-1', definition_revision: 6, field_columns: [{ header: '状态', field_id: 'db_status' }] },
    fields: [{ id: 'db_status', label: '状态', type: 'text' }] });
  await assert.rejects(() => harness.read({ table: 'object-1', headers: ['状态'] }), /绑定指纹/);
});
it('普通日期格允许新文字，不按旧值类型把新输入强制当日期', async () => {
  const { harness, deps, file } = fixture(); const old = deps.service;
  deps.service = async (id, payload) => {
    if (id === 'files.sheet_read') { const raw = file(); raw.rows[0].values.编号 = { type: 'date', value: '2026-01-01' }; return raw; }
    return old(id, payload);
  };
  const read = await harness.read({ table: 'file-1', headers: ['编号'] });
  const write = (value: string) => harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '编号', value }] }, 'op').payload.cells[0].value;
  assert.deepEqual(write('待核实'), { type: 'text', value: '待核实' });
  assert.deepEqual(write('2026-02-30'), { type: 'text', value: '2026-02-30' });
  assert.deepEqual(write('2026-02-28'), { type: 'date', value: '2026-02-28' });
});
it('旧读取引用的正式输入声明消失时明确重读，不能降为自由输入', async () => {
  const { harness, deps } = fixture(); const read = await harness.read({ table: 'file-1', headers: ['状态'] });
  deps.service = async () => ({ table: 'file-1', columns: {} });
  await assert.rejects(() => harness.options({ read_ref: read.read_ref, header: '状态' }), /规则已变化/);
});
it('特殊表头不改对象原型，也不会丢失该列的三项输入信息', async () => {
  const { harness, deps } = fixture('managed');
  deps.definition = async id => ({ id, source: 'managed', revision: 1, fields: [{ id: 'flag', label: '__proto__', type: 'boolean' }] });
  deps.query = async () => ({ rows: [{ name: 'r1', modified: 'm1', flag: false }], total: 1 });
  const read = await harness.read({ table: 'obj' });
  assert.equal(Object.hasOwn(read.inputs, '__proto__'), true);
  assert.equal(JSON.parse(JSON.stringify(read)).rows[0].values.__proto__, false);
  const prepared = harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r1', header: '__proto__', value: true }] }, 'op');
  assert.equal(prepared.payload.records[0].values.flag, true);
});
it('固定值和不可空提示在生成提案前返回可纠正error；false和0不等于空', async () => {
  const { harness, calls } = fixture(); const read = await harness.read({ table: 'file-1' }); const before = calls.length;
  for (const value of [null, '不在清单']) assert.throws(() => harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value }] }, 'op'), /尚未生成提案/);
  harness.prepare({ read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '是否', value: false }, { row_id: 'r-000001', header: '数量', value: 0 }] }, 'op');
  assert.equal(calls.length, before);
});
it('长清单其他合法值查询后可选，不因首页未出现而误称业务规则禁止', async () => {
  const { harness, deps } = fixture(); const read = await harness.read({ table: 'file-1' });
  const input = { read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: '另一标准' }] };
  assert.throws(() => harness.prepare(input, 'op'), /field_options/);
  deps.service = async () => ({ table: 'file-1', columns: { 状态: { ...fixed(), options: { items: [{ value: '另一标准' }], total: 1, page: 1, page_length: 20, has_more: false } } } });
  await harness.options({ read_ref: read.read_ref, header: '状态', search: '另一标准' });
  assert.equal(harness.prepare(input, 'op').payload.cells[0].value.value, '另一标准');
});
