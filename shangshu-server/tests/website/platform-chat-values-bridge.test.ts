import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createPlatformChatBridge } from '../../src/adapters/web/platform.ts';

async function fixture(run: (value: any) => Promise<void>) {
  const original = globalThis.fetch, upstream = process.env.FRAPPE_UPSTREAM;
  process.env.FRAPPE_UPSTREAM = 'http://harness.invalid';
  const requests: any[] = [];
  let revision = 1;
  const actions = [
    ['files.sheet_range_read', '读表', 'read', { table: {}, page_length: {}, headers: {} }],
    ['files.sheet_cells_write', '写表', 'write', { table: {}, cells: {}, expected_content_version: {}, expected_structure_version: {}, expected_record_versions: {}, op_id: {} }],
    ['files.sheet_row_append', '新增行', 'write', { table: {}, expected_content_version: {}, expected_structure_version: {}, count: {}, op_id: {} }],
    ['platform.object.update_many', '记录写入', 'write', { object_id: {}, records: {}, expected_revision: {} }],
    ['platform.object.query', '查询业务记录', 'read', { object_id: {}, filters: {} }],
    ['mail.save_draft', '写邮件', 'write', { subject: { type: 'string' }, body: { type: 'string' } }],
  ].map(([id, title, effect, properties]) => ({ id, title, effect, executable: true,
    confirmation: effect === 'read' ? 'none' : 'required',
    input_schema: { type: 'object', properties, required: Object.keys(properties as object) } }));
  const fileRead = () => ({ table: 'T1', table_title: '总表', sheet: 'sheet1', content_version: revision, structure_version: 2,
    headers: ['状态'], rows: [{ row_id: 'r-000001', record_version: 'db-original',
      values: { 状态: { type: 'text', value: '待确认' } }, source: 'DATABASE_MUST_NOT_LEAK' }], total_rows: 1,
    diagnostics: { cache: 'internal' }, promoted_columns: [{ field: 'private_mapping', header: '状态' }] });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url)), method = parsed.pathname.split('.').at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(parsed.searchParams);
    requests.push({ method, body, cookie: (init?.headers as any)?.cookie });
    const ok = (message: any) => new Response(JSON.stringify({ message }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'actions') return ok(actions);
    if (method === 'domains') return ok([{ contribution: { tools: actions.map(a => ({ id: a.id })) } }]);
    if (method === 'table_resource') return ok({ table: body.resource_id, source: 'xlsx' });
    if (method === 'csrf') return ok({ csrf_token: 'test-token' });
    if (method === 'session') return ok({ user_name: 'test', roles: ['Desk User'] });
    if (method === 'contributions') return ok({ services: ['files.sheet_read','files.row_read'].map(id => ({ id, effect: 'read', purpose: 'detail', roles: ['Desk User'] })) });
    if (method === 'service_read') {
      const input = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
      if (body.service_id === 'files.sheet_read') return ok({ result: fileRead() });
      if (body.service_id === 'files.sheet_input_constraints') return ok({ result: { table: input.table, columns: {
        状态: { options: { items: [{ value: '待确认' }, { value: '同意' }], total: 2, page: 1, page_length: 10, has_more: false }, allow_custom: false, nullable: true },
      } } });
    }
    if (method === 'action_execute' && body.action_id === 'files.sheet_range_read') return ok({ ok: true, result: fileRead() });
    if (method === 'action_propose') {
      assert.equal(body.source, 'ai-chat');
      if (body.payload.expected_content_version !== revision) return new Response(JSON.stringify({ message: '内容版本冲突，请重新读取', exc_type: 'TimestampMismatchError' }), { status: 417 });
      return ok({ id: 'P1', capability: body.action_id, entity_type: 'files.file', entity_id: 'T1',
        payload: body.payload, review_supported: true, created_via: 'ai-chat' });
    }
    throw Error('Unexpected upstream method: ' + method);
  };
  let bridge: Awaited<ReturnType<typeof createPlatformChatBridge>> | undefined;
  try {
    bridge = await createPlatformChatBridge({ headers: { cookie: 'sid=test' } } as any);
    const call = async (name: string, payload: any, hooks = {}) => {
      const def = bridge!.toolDefs.find(t => t.name === name)!; assert.ok(def, name);
      return JSON.parse(String((await bridge!.toolExecutor(def, { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(payload) } }, hooks, { requestId: 'request-from-engine' })).content));
    };
    await run({ bridge, call, requests, advance: () => { revision++; } });
  } finally {
    await bridge?.close(); globalThis.fetch = original;
    if (upstream === undefined) delete process.env.FRAPPE_UPSTREAM; else process.env.FRAPPE_UPSTREAM = upstream;
  }
}

it('同一模型投影收起重复写格schema，保留专业邮件schema和原布局工具的读取引用', () => fixture(async ({ bridge, call }) => {
  assert.ok(!bridge.toolDefs.some((t: any) => t.capability === 'files.sheet_cells_write'));
  const mail = await call('platform_action_schema', { action_id: 'mail.save_draft' });
  assert.deepEqual(mail.input_schema.required, ['subject','body']);
  const row = await call('platform_action_schema', { action_id: 'files.sheet_row_append' });
  assert.ok(row.input_schema.properties.read_ref); assert.equal(row.input_schema.properties.expected_content_version, undefined);
  const search = await call('platform_action_search', { query: 'files.sheet_cells_write' });
  assert.ok(!search.candidates.some((a: any) => a.action_id === 'files.sheet_cells_write'));
}));
it('table读取到三项约束，值写只提一次公共确认卡，实际身份与原版本由Harness填写', () => fixture(async ({ bridge, call, requests }) => {
  const read = await call('platform_resource_read', { operation: 'table', table: 'T1' });
  assert.deepEqual(Object.keys(read.inputs.状态).sort(), ['allow_custom','nullable','options']);
  assert.doesNotMatch(JSON.stringify(read), /private_mapping|DATABASE_MUST_NOT_LEAK|content_version|diagnostics/);
  const input = { read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: '同意' }] };
  const def = bridge.toolDefs.find((t: any) => t.name === 'platform_action_call');
  assert.equal(bridge.toolExecutor.resolveAuditAction(def, { function: { name: def.name, arguments: JSON.stringify(input) } }), 'files.sheet_cells_write');
  let confirm: any;
  const result = await call('platform_action_call', input, { onConfirm: (item: any) => { confirm = item; } });
  assert.equal(result.confirmation_id, 'P1'); assert.match(result.note, /尚未执行/);
  const writes = requests.filter((r: any) => r.method === 'action_propose'); assert.equal(writes.length, 1);
  assert.equal(writes[0].body.action_id, 'files.sheet_cells_write'); assert.equal(writes[0].body.payload.expected_content_version, 1);
  assert.deepEqual(writes[0].body.payload.expected_record_versions, { 'r-000001': 'db-original' });
  assert.equal(writes[0].body.idempotency_key, 'request-from-engine');
  assert.equal(confirm.payload.op_id, 'request-from-engine');
  assert.equal(requests.filter((r: any) => r.method === 'action_execute').length, 0);
}));
it('读后别人修改仍提交旧版本，返回真实error，不重读/换键/直接执行', () => fixture(async ({ call, requests, advance }) => {
  const read = await call('platform_resource_read', { operation: 'table', table: 'T1' }); advance();
  const before = requests.length;
  const result = await call('platform_action_call', { read_ref: read.read_ref, changes: [{ row_id: 'r-000001', header: '状态', value: '同意' }] });
  assert.match(result.error, /版本冲突/);
  assert.deepEqual(requests.slice(before).map((r: any) => r.method), ['csrf','action_propose']);
  assert.equal(requests.at(-1).body.payload.expected_content_version, 1);
}));
it('直接范围动作与只读Service都走同一最小投影，不留结构泄漏旁路', () => fixture(async ({ call }) => {
  const action = await call('platform_action_call', { action_id: 'files.sheet_range_read', payload: { table: 'T1' } });
  const service = await call('platform_resource_read', { operation: 'service', service_id: 'files.sheet_read', payload: { table: 'T1' } });
  for (const read of [action.result, service.result]) {
    assert.equal(typeof read.read_ref, 'string'); assert.equal(read.rows[0].values.状态, '待确认');
    assert.doesNotMatch(JSON.stringify(read), /content_version|promoted_columns|diagnostics/);
  }
}));
it('无效引用只回工具error；结构动作保留原上下文，不需模型操作版本', () => fixture(async ({ bridge, call, requests }) => {
  const def = bridge.toolDefs.find((t: any) => t.name === 'platform_action_call');
  const bad = { read_ref: 'stale', changes: [{ row_id: 'r-000001', header: '状态', value: 'x' }] };
  assert.equal(bridge.toolExecutor.resolveAuditAction(def, { function: { name: def.name, arguments: JSON.stringify(bad) } }), undefined);
  const before = requests.length; assert.match((await call('platform_action_call', bad)).error, /失效/);
  assert.equal(requests.length, before);
  const read = await call('platform_resource_read', { operation: 'table', table: 'T1' });
  const result = await call('platform_action_call', { action_id: 'files.sheet_row_append', payload: { read_ref: read.read_ref, count: 2 } });
  assert.equal(result.confirmation_id, 'P1');
  assert.equal(requests.at(-1).body.payload.expected_structure_version, 2); assert.equal(requests.at(-1).body.payload.table, 'T1');
}));
