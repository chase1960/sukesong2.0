// 日常表格的模型投影。只缓存本轮实际读到的位置/版本，不保存第二份业务事实。
import { randomUUID } from 'node:crypto';

type Data = Record<string, any>;
type Scalar = string | number | boolean | null;
export type TableChatDependencies = {
  resolve: (table: string) => Promise<Data>;
  definition: (id: string) => Promise<Data>;
  query: (id: string, payload: Data) => Promise<Data>;
  service: (id: string, payload: Data) => Promise<Data>;
  authorized: (id: string) => boolean;
};
type Snapshot = {
  table: string; target: string; sheet?: string; source: 'file' | 'managed' | 'native' | 'companion';
  content?: number; structure?: number; revision?: number;
  headers: Map<string, string>; rows: Map<string, { version?: string; values: Data; types: Data }>;
  action: string; at: number;
  constrained?: Set<string>;
  inputs: Data;
  choices?: Map<string, Set<Scalar>>;
  companion?: { objectId: string; definitionRevision: string; managed: boolean; sourceHeaders: Set<string> };
};

export const VALUE_WRITE_ACTIONS = new Set([
  'files.cell_write', 'files.sheet_cell_write', 'files.sheet_cells_write',
  'files.sheet_input_write', 'files.sheet_paste_apply',
  'files.formal_value_write', 'files.edit_cells', 'platform.object.update', 'platform.object.update_many',
  'platform.object.companion_write',
]);
const FREE_INPUT = { options: null, allow_custom: true, nullable: true };
const MAX_REFS = 16;
const MAX_CELLS = 2000;
const MAX_AGE = 15 * 60_000;
const META_KEYS = ['table', 'headers', 'row_ids', 'search', 'page', 'page_length'];

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 250) throw Error(`${label}无效`);
  return value;
}
function list(value: unknown, label: string, cap: number): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > cap) throw Error(`${label}须为1至${cap}项列表`);
  const values = value.map(item => text(item, label));
  if (new Set(values).size !== values.length) throw Error(`${label}不能重复`);
  return values;
}
function page(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > max) throw Error('分页参数无效');
  return Number(n);
}
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
function version(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error(`读取结果缺少有效${label}，不能建立写入上下文`);
  return Number(value);
}
function unwrap(value: Data): Data { return value?.result && !value.rows ? value.result : value; }
export function tableReadArguments(input: Data): Data {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['table','sheet','headers','row_ids','page','page_length','search'].includes(k))) throw Error('表格读取参数无效');
  text(input.table, '表身份'); list(input.headers, '表头', 64); const ids = list(input.row_ids, '行身份', 50);
  page(input.page, 1); page(input.page_length, 20, 50);
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw Error('搜索词须为最多200字的文本');
  return { ...input, ...(!ids && input.page_length === undefined ? { page_length: 20 } : {}) };
}
function validConstraints(value: any): Data {
  if (!value || typeof value.allow_custom !== 'boolean' || typeof value.nullable !== 'boolean'
      || !(value.options === null || (Array.isArray(value.options?.items)
        && Number.isSafeInteger(value.options.total) && typeof value.options.has_more === 'boolean'))) {
    throw Error('字段输入信息不完整，不能假设为自由填写');
  }
  return { options: value.options, allow_custom: value.allow_custom, nullable: value.nullable };
}

export class ChatTableHarness {
  private refs = new Map<string, Snapshot>();
  constructor(private deps: TableChatDependencies) {}
  close() { this.refs.clear(); }
  private snapshot(ref: unknown): Snapshot {
    const saved = typeof ref === 'string' ? this.refs.get(ref) : undefined;
    if (!saved || Date.now() - saved.at > MAX_AGE) throw Error('读取上下文已失效，请重新读取要修改的位置；尚未生成提案');
    return saved;
  }
  actionFor(ref: unknown): string | undefined {
    const saved = this.snapshot(ref);
    return this.deps.authorized(saved.action) ? saved.action : undefined;
  }
  private remember(saved: Omit<Snapshot, 'at'>): string {
    if (Buffer.byteLength(JSON.stringify([...saved.rows]), 'utf8') > 1024 * 1024) throw Error('本次读取内容较大，请缩小行列范围；未截断值或建立写入引用');
    while (this.refs.size >= MAX_REFS) this.refs.delete(this.refs.keys().next().value!);
    const ref = randomUUID();
    const choices = new Map<string, Set<Scalar>>(Object.entries(saved.inputs).map(([header, info]) =>
      [header, new Set((info as Data).options?.items?.map((item: Data) => item.value) || [])]));
    this.refs.set(ref, { ...saved, choices, at: Date.now() });
    return ref;
  }
  private command(action: string, payload: Data): { action: string; payload: Data } {
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1024 * 1024) throw Error('本次修改内容较大，请缩小范围；尚未生成提案');
    return { action, payload };
  }

  async read(input: Data): Promise<Data> {
    if (Object.keys(input).some(key => !META_KEYS.includes(key))) throw Error('表格读取只接受table、headers、row_ids、search和分页参数');
    const table = text(input.table, '表身份');
    const headers = list(input.headers, '表头', 64), ids = list(input.row_ids, '行身份', 50);
    const p = page(input.page, 1), length = page(input.page_length, 20, 50);
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw Error('搜索词须为不超过200字的文本');
    if (ids && (input.search !== undefined || input.page !== undefined)) throw Error('指定行身份时不混用搜索或页码');
    const target = await this.deps.resolve(table);
    if (target.table !== table || !['db', 'xlsx'].includes(target.source)) throw Error('公共表身份响应无效');
    if (target.source === 'xlsx') {
      const payload = { table, ...(headers ? { headers } : {}), ...(ids ? { row_ids: ids } : { page: p, page_length: length }),
        ...(input.search !== undefined ? { search: input.search } : {}) };
      return this.fromFile(await this.deps.service('files.sheet_read', payload), payload, table);
    }
    const definition = await this.deps.definition(table);
    if (definition.id !== table) throw Error('公共对象身份不匹配');
    if (definition.companion?.file_id) {
      const payload = { table: definition.companion.file_id, ...(headers ? { headers } : {}),
        ...(ids ? { row_ids: ids } : { page: p, page_length: length }), ...(input.search !== undefined ? { search: input.search } : {}) };
      return this.fromFile(await this.deps.service('files.sheet_read', payload), payload, table, definition);
    }
    if (!['managed', 'native'].includes(definition.source)) throw Error('此资源未提供通用表格输入约定，请使用其业务动作');
    const columns = new Map<string, Data>();
    for (const field of definition.fields || []) {
      const header = String(field.label || field.id);
      if (columns.has(header)) throw Error('表头同名，须先通过业务配置明确字段身份');
      columns.set(header, field);
    }
    const scalarTypes = new Set(['text','long_text','integer','decimal','date','boolean','choice']);
    const chosen = headers || [...columns].filter(([, f]) => scalarTypes.has(f.type)).map(([h]) => h);
    if (chosen.length > 64) throw Error('列较多，请指定本次要读的headers，不读取全部字段');
    if (!chosen.length) throw Error('此表没有可用的标量列，请使用其业务动作');
    if (chosen.some(h => !columns.has(h))) throw Error('表头不存在或当前不可读');
    const fieldIds = chosen.map(h => String(columns.get(h)!.id));
    const query = (filters: Data, qpage: number, qlength: number) => this.deps.query(table, {
      filters, page: qpage, page_length: qlength, fields: fieldIds, include_definition: false,
      read_scope: { mode: 'query', purpose: 'interactive' },
    });
    const [metadata, response] = await Promise.all([
      this.deps.service('platform.object.input_constraints', { object_id: table, fields: fieldIds, page_length: 10 }),
      ids ? this.readKnownRows(table, ids, fieldIds, definition.source === 'native' ? id => query({ name: id }, 1, 1) : undefined)
        : query(input.search ? { $search: input.search } : {}, p, length),
    ]);
    if (!Array.isArray(response.rows) || response.rows.length > (ids?.length || length)) throw Error('公共记录分页响应无效');
    const rows = new Map<string, { version?: string; values: Data; types: Data }>();
    const inputs: Data = Object.create(null), mapping = new Map<string, string>();
    for (const header of chosen) {
      const field = columns.get(header)!;
      inputs[header] = validConstraints(metadata.fields?.[field.id]);
      mapping.set(header, field.id);
    }
    for (const row of response.rows) {
      const id = text(row.name, '行身份');
      if (rows.has(id) || (ids && !ids.includes(id))) throw Error('公共记录行身份不匹配');
      const values: Data = Object.create(null), types: Data = Object.create(null);
      for (const header of chosen) {
        const field = columns.get(header)!;
        if (Object.hasOwn(row, field.id) && scalar(row[field.id])) { values[header] = row[field.id]; types[header] = field.type; }
      }
      rows.set(id, { version: row.modified, values, types });
    }
    if (ids && rows.size !== ids.length) throw Error('请求的行不存在或当前不可读');
    const ref = this.remember({ table, target: table, source: definition.source, headers: mapping, rows, inputs,
      revision: version(definition.revision, '字段修订'),
      action: definition.source === 'managed' ? 'platform.object.update_many' : 'platform.object.update' });
    return { table, title: String(definition.title || definition.name || table), headers: chosen, inputs,
      rows: [...rows].map(([row_id, row]) => ({ row_id, values: row.values })),
      total: response.total, page: ids ? 1 : p, page_length: ids?.length || length, read_ref: ref };
  }

  private async readKnownRows(table: string, ids: string[], fields: string[], nativeQuery?: (id: string) => Promise<Data>): Promise<Data> {
    if (!nativeQuery) {
      const value = unwrap(await this.deps.service('platform.object.values_read', { object_id: table, names: ids, fields }));
      if (!Array.isArray(value.rows)) throw Error('按行值读取响应无效');
      return { rows: value.rows, total: value.rows.length };
    }
    const rows: Data[] = [];
    // 原生查询允许name等值；每次只取目标字段，读阶段最多4个独立请求并行。
    for (let start = 0; start < ids.length; start += 4) {
      const found = await Promise.all(ids.slice(start, start + 4).map(nativeQuery));
      for (const value of found) {
        if (!Array.isArray(value.rows) || value.rows.length !== 1) throw Error('指定记录不存在或当前不可读');
        rows.push(value.rows[0]);
      }
    }
    return { rows, total: rows.length };
  }

  async fromFile(raw: Data, payload: Data, visibleTable?: string, definition?: Data): Promise<Data> {
    const data = unwrap(raw);
    if (data.table !== payload.table || !Array.isArray(data.headers) || !Array.isArray(data.rows)
        || data.rows.length > (payload.row_ids?.length || payload.page_length || 50)) throw Error('表格读取响应不完整或超过请求范围');
    const requested = list(payload.headers, '表头', 64);
    if (!requested && data.headers.length > 64) throw Error('列较多，请指定本次要读的headers');
    let headers: string[] = requested || data.headers;
    if (headers.some(h => typeof h !== 'string' || !data.headers.includes(h))) throw Error('返回的表头与读取位置不符');
    headers = headers.filter(h => !data.rows.some((row: Data) => row.values?.[h]?.hidden || row.values?.[h]?.type === 'hidden'));
    if (!headers.length || data.rows.length * headers.length > MAX_CELLS) throw Error('读取范围过大或无可读列，请缩小行列后重试');
    if (!definition?.companion && data.rows.some((row: Data) => row.source_modified)) throw Error('当前入口缺少完整的表格绑定，请从表格中心对应入口读取');
    const metadata = unwrap(await this.deps.service('files.sheet_input_constraints', { table: data.table, headers, page_length: 10 }));
    if (metadata.table !== data.table || !metadata.columns || typeof metadata.columns !== 'object') throw Error('字段输入信息响应无效');
    const inputs = Object.fromEntries(headers.map(h => [h, Object.hasOwn(metadata.columns, h) ? validConstraints(metadata.columns[h]) : { ...FREE_INPUT }]));
    const mapping = new Map<string, string>(headers.map(h => [h, h]));
    let companion: Snapshot['companion'];
    if (definition?.companion) {
      if (definition.companion.file_id !== data.table || !['managed','native'].includes(definition.source)) throw Error('表格绑定身份失效');
      const columns = new Map<string, string>((definition.companion.field_columns || []).map((c: Data) => [c.header, c.field_id]));
      const selected = headers.filter(h => columns.has(h));
      const declared = selected.length ? unwrap(await this.deps.service('platform.object.input_constraints', {
        object_id: definition.id, fields: selected.map(h => columns.get(h)), page_length: 10,
      })) : { fields: {} };
      for (const h of selected) { inputs[h] = validConstraints(declared.fields?.[columns.get(h)!]); mapping.set(h, columns.get(h)!); }
      companion = { objectId: definition.id, definitionRevision: text(definition.companion.definition_revision, '绑定指纹'), managed: definition.source === 'managed', sourceHeaders: new Set(selected) };
    }
    const rows = new Map<string, { version?: string; values: Data; types: Data }>();
    const display: Data[] = [];
    for (const row of data.rows) {
      const id = text(row.row_id, '行身份');
      if (rows.has(id) || (payload.row_ids && !payload.row_ids.includes(id))) throw Error('表格返回了未请求或重复行');
      const values: Data = Object.create(null), types: Data = Object.create(null);
      for (const header of headers) {
        const cell = row.values?.[header];
        if (cell && Object.hasOwn(cell, 'value') && scalar(cell.value)) { values[header] = cell.value; types[header] = cell.type; }
      }
      rows.set(id, { version: companion ? row.source_modified : row.record_version, values, types });
      display.push({ row_id: id, ...(Number.isInteger(row.row_index) ? { row_index: row.row_index } : {}), values });
    }
    if (payload.row_ids && rows.size !== payload.row_ids.length) throw Error('请求的行不存在或当前不可读');
    const table = visibleTable || data.table;
    const ref = this.remember({ table, target: data.table, sheet: data.sheet, source: companion ? 'companion' : 'file',
      content: version(data.content_version, '内容版本'), structure: version(data.structure_version, '结构版本'),
      headers: mapping, rows, inputs, companion, constrained: new Set(Object.keys(metadata.columns)), ...(companion ? { revision: version(definition!.revision, '字段修订') } : {}),
      action: companion ? 'platform.object.companion_write' : 'files.sheet_cells_write' });
    return { table, title: data.table_title || table, headers, inputs, rows: display,
      total: data.total_rows, page: payload.page || 1, page_length: payload.row_ids?.length || payload.page_length || 20, read_ref: ref };
  }

  async options(input: Data): Promise<Data> {
    if (Object.keys(input).some(k => !['read_ref', 'header', 'search', 'page', 'page_length'].includes(k))) throw Error('可选值查询参数无效');
    const saved = this.snapshot(input.read_ref), header = text(input.header, '表头');
    const field = saved.headers.get(header);
    if (!field) throw Error('只能查询本次已读表头的可选值');
    const p = page(input.page, 1), length = page(input.page_length, 20, 50);
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw Error('可选值搜索词无效');
    const params = { page: p, page_length: length, ...(input.search === undefined ? {} : { search: input.search }) };
    const fileColumn = saved.source === 'file' || (saved.source === 'companion' && !saved.companion!.sourceHeaders.has(header));
    const data = unwrap(await this.deps.service(fileColumn ? 'files.sheet_input_constraints' : 'platform.object.input_constraints',
      fileColumn ? { table: saved.target, headers: [header], ...params } : { object_id: saved.companion?.objectId || saved.target, fields: [field], ...params }));
    const value = fileColumn ? data.columns?.[header] : data.fields?.[field];
    if (fileColumn && value === undefined && saved.constrained?.has(header)) throw Error('该列输入规则已变化，请重新读取；不能改成自由填写');
    const info = fileColumn && value === undefined ? FREE_INPUT : validConstraints(value);
    if (info.allow_custom !== saved.inputs[header].allow_custom || info.nullable !== saved.inputs[header].nullable) throw Error('字段输入规则已变化，请重新读取');
    for (const item of info.options?.items || []) saved.choices!.get(header)!.add(item.value);
    return { header, ...info };
  }

  prepare(input: Data, opId: string): { action: string; payload: Data } {
    if (Object.keys(input).some(k => !['read_ref', 'changes'].includes(k))) throw Error('填值只接受read_ref和changes，不接受存储位置或手填版本');
    const saved = this.snapshot(input.read_ref), changes = input.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CELLS) throw Error('changes须为1至2000个位置与值');
    if (!this.deps.authorized(saved.action)) throw Error('当前没有该表格写入动作的权限');
    const grouped = new Map<string, Data>(), cells: Data[] = [], seen = new Set<string>();
    for (const change of changes) {
      if (!change || typeof change !== 'object' || Object.keys(change).some(k => !['row_id', 'header', 'value'].includes(k))
          || !Object.hasOwn(change, 'value') || !scalar(change.value)) throw Error('每项只填写row_id、header和标量value（清空用null）');
      const row = saved.rows.get(change.row_id), field = saved.headers.get(change.header);
      if (!row || !field || !Object.hasOwn(row.values, change.header)) throw Error('只能修改本次实际读到的行和列，请先读取缺少的位置');
      const input = saved.inputs[change.header];
      if ((change.value === null || change.value === '') && !input.nullable) throw Error(`「${change.header}」不能留空；尚未生成提案`);
      if (change.value !== null && !input.allow_custom && input.options !== null && !saved.choices!.get(change.header)!.has(change.value)) {
        throw Error(`「${change.header}」请使用已读取的可选值；可用field_options查询其他选项，清空用null；尚未生成提案`);
      }
      const key = JSON.stringify([change.row_id, change.header]);
      if (seen.has(key)) throw Error('同一位置不能重复提交');
      seen.add(key);
      if (saved.source === 'file' || saved.source === 'companion') {
        const kind = change.value === null ? 'empty' : typeof change.value === 'boolean' ? 'boolean'
          : typeof change.value === 'number' ? 'number' : row.types[change.header] === 'date'
            && /^\d{4}-\d{2}-\d{2}$/.test(change.value) && !Number.isNaN(Date.parse(change.value))
            && new Date(change.value).toISOString().startsWith(change.value) ? 'date' : 'text';
        cells.push({ row_id: change.row_id, header: change.header, value: { type: kind, value: change.value } });
      } else {
        if (typeof row.version !== 'string' || !row.version) throw Error('原读取缺少记录版本，请重新读取；不能现取最新版本代填');
        const values = grouped.get(change.row_id) || Object.create(null);
        values[field] = change.value; grouped.set(change.row_id, values);
      }
    }
    if (saved.source === 'companion') {
      const targetRows = [...new Set(cells.map(c => c.row_id))];
      if (!saved.companion!.managed && targetRows.length > 1) throw Error('此表暂不支持多行原子写入；本次未生成提案');
      if (targetRows.some(id => !saved.rows.get(id)!.version)) throw Error('原读取缺少记录版本，请重新读取');
      return this.command(saved.action, { object_id: saved.companion!.objectId, file_id: saved.target,
        expected_revision: saved.revision, definition_revision: saved.companion!.definitionRevision,
        expected_modified: Object.fromEntries(targetRows.map(id => [id, saved.rows.get(id)!.version])),
        expected_content_version: saved.content, expected_structure_version: saved.structure, op_id: opId, cells });
    }
    if (saved.source === 'file') return this.command(saved.action, {
      table: saved.target, ...(saved.sheet ? { sheet: saved.sheet } : {}),
      expected_content_version: saved.content, expected_structure_version: saved.structure, op_id: opId,
      expected_record_versions: Object.fromEntries([...new Set(cells.map(c => c.row_id))]
        .filter(id => saved.rows.get(id)!.version).map(id => [id, saved.rows.get(id)!.version])), cells,
    });
    const records = [...grouped].map(([name, values]) => ({ name, expected_modified: saved.rows.get(name)!.version, values }));
    if (saved.source === 'native') {
      if (records.length !== 1) throw Error('此表暂不支持多行原子写入；本次未生成提案，请每次明确处理一行');
      return this.command(saved.action, { object_id: saved.target, expected_revision: saved.revision, ...records[0] });
    }
    return this.command(saved.action, { object_id: saved.target, expected_revision: saved.revision, records });
  }

  fileArguments(ref: unknown, payload: Data): Data {
    const saved = this.snapshot(ref);
    if (saved.source !== 'file') throw Error('此动作需要已读取的工作表位置，不能换另一种存储尝试');
    if (['table', 'sheet', 'expected_content_version', 'expected_structure_version', 'expected_record_versions','op_id'].some(k => Object.hasOwn(payload, k))) throw Error('表身份和版本由读取上下文提供，不允许手填覆盖');
    return { ...payload, table: saved.target, ...(saved.sheet ? { sheet: saved.sheet } : {}),
      expected_content_version: saved.content, expected_structure_version: saved.structure };
  }

  fromRow(raw: Data, payload: Data): Promise<Data> {
    const data = unwrap(raw);
    if (data.table !== payload.table || data.row_id !== payload.row_id || !data.cells) throw Error('固定行读取响应无效');
    const values = Object.fromEntries(Object.entries(data.cells).map(([header, value]) => [header,
      value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value : {
        type: value === null ? 'empty' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text', value,
      }]));
    return this.fromFile({ ...data, headers: Object.keys(data.cells), total_rows: 1,
      rows: [{ row_id: data.row_id, record_version: data.record_version, values }] },
      { ...payload, row_ids: [data.row_id], headers: payload.headers || Object.keys(data.cells) });
  }
}
