/**
 * 受管对象（业务表）在 **Excel 工作面**上的八项能力。
 *
 * 为什么单独一个模块：八项能力**全都走既有公开口**
 * （`platform.object.*` 动作 ＋ `platform.object.*` 服务），
 * 一律不新造业务动作、不新造平行写口。
 *
 * 全链路 0 次 LLM 调用。
 *
 * 口径两条：
 *  · **能力闸 fail-closed** —— 服务端说不支持，就**说人话**说清为什么不支持；
 *    不许静默降级成「逐格写」（那会让用户以为保存成功了，其实写了一半）。
 *  · **筛选走服务端** —— 条件进 `GET /api/platform/objects/:id/records` 的 `filters`，
 *    不许只筛当前装填的那一页（那是「静默给错结果」，比功能缺失更坏）。
 *
 * 另外两条写保护（表格中心那边早有，这里对齐，别自己放宽）：
 *  · **关联列／明细列／数组与对象类型的列不可写** ——
 *    `coerceObjectValue` 只认 integer/decimal/boolean/date，其余原样当文本发出去，
 *    关联列的**显示名**会被当成值写进正式数据（静默写坏）。
 *  · **关联列显示 `_display` 里的名字** —— 服务端另给了一份显示值，
 *    只读原值的话界面上看到的是内部 ID，不是人认识的名字。
 */

import { coerceObjectValue } from './api';
import { validateAccessMap, type AccessMap } from './access-scope';
import type { PromotionColumnRule } from './promotion-rules-editor';
import {
  defaultTableAccess,
  validatePromotionScopes,
  type PromotionColumnScope,
} from './promotion-scope';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** 能力闸：能就用，不能就说人话。 */
export interface Gate {
  available: boolean;
  /** 给用户看的原因（中文，不含内部串）。 */
  reason: string;
}

/** 服务端 `GET /api/platform/objects` 里那一项的形状（只取这里用得上的键）。 */
export interface DbObjectMeta {
  id: string;
  title?: string;
  /** 原生（native）对象的**中文名**在 `name` 上（`title` 只有受管对象有）。 */
  name?: string;
  revision?: number;
  operations?: string[];
  fields?: Array<{ id: string; label?: string; type: string }>;
  input_schema?: { properties?: Record<string, { type?: string } | undefined> };
  export?: { version?: number; service?: string; available?: boolean; max_rows?: number };
  import?: {
    version?: number;
    service?: string;
    action?: string;
    available?: boolean;
    max_bytes?: number;
    max_rows?: number;
  };
  history?: { version?: number; service?: string; available?: boolean };
  lifecycle?: { version?: number; available?: boolean; scopes?: string[] };
  query?: { version: number; filterable_fields?: string[]; search_fields?: string[] };
  /**
   * 原生（native）数据集的**可筛选字段**。
   *
   * 受管对象走 `query.filterable_fields`；原生表走域声明的 `filter_fields`
   * （内核 `native_objects.query_records` 只认声明过的字段 ＋ `name`）。
   */
  filter_fields?: string[];
}

export interface DbGates {
  create: Gate;
  export: Gate;
  import: Gate;
  history: Gate;
  recycle: Gate;
  columnFilter: Gate;
  createTable: Gate;
}

const OPEN = (reason: string): Gate => ({ available: true, reason });
const SHUT = (reason: string): Gate => ({ available: false, reason });

export interface GateOptions {
  /**
   * **服务端给的真实能力**：这个账号能不能做「首次晋升」
   * （`GET /api/platform/actions` 里有 `files.promotion_define` 才算有）。
   *
   * 为什么不用前端角色猜：建表要走「晋升」那条路，而那条路是 **System Manager 专属**
   * ⇒ 前端角色猜错 ⇒ 按钮能点、点了被服务端拒 ⇒ 正好是「点了报不支持」那种坏体验。
   * ⇒ **闸从服务端能力清单读**。
   */
  canPromote?: boolean;
  /** 兜底：服务端没给能力清单时，用客户端看到的角色。 */
  isAdmin?: boolean;
}

/**
 * 这一张表**能按哪些列筛**。
 *
 * 受管对象：`query.filterable_fields`；
 * 原生表：域声明的 `filter_fields`（内核只认声明过的字段 ＋ `name`）。
 *
 * ⚠️ **再和「当前用户看得见的列」取交集**（fail-closed）：
 * 服务端筛不到时会回「没有筛选字段的读取权限」（403）⇒
 * 界面上不能先说「可以按列筛选」，点了才被拒 ⇒ 只留**读得到**的那些列。
 */
export function filterableFields(meta: DbObjectMeta): string[] {
  const declared = meta.query?.filterable_fields?.length ? meta.query.filterable_fields : (meta.filter_fields || []);
  const readable = new Set((meta.fields || []).map(field => field.id));
  if (!readable.size) return declared;
  return declared.filter(id => readable.has(id));
}

/**
 * 读服务端给的闸，得出八项能力各自**能不能用**，以及**不能的话说哪句人话**。
 *
 * 闸的来源全是服务端那份元数据（`export.available`／`import.available`／
 * `history.version`／`lifecycle.available`／`operations`）—— 前端不自己猜。
 */
export function readGates(meta: DbObjectMeta, options: GateOptions = {}): DbGates {
  const operations = meta.operations || [];
  const exportCap = meta.export;
  const importCap = meta.import;
  const historyCap = meta.history;
  const lifecycleCap = meta.lifecycle;

  const create: Gate = operations.includes('create')
    ? OPEN('可以新增记录')
    : SHUT('这张表没有新增记录的权限，请联系管理员开通');

  const exportGate: Gate = !exportCap
    ? SHUT('这张表没有开放导出')
    : exportCap.service !== 'platform.object.export'
      ? SHUT('这张表的导出服务未接入，当前不能导出')
      : exportCap.available !== true
        ? SHUT('当前账号没有这张表的导出权限，请联系管理员')
        : OPEN('可以导出这张表的全部有权记录');

  const importGate: Gate = !importCap
    ? SHUT('这张表没有开放导入')
    : importCap.service !== 'platform.object.import_preview' || importCap.action !== 'platform.object.import'
      ? SHUT('这张表的导入服务未接入，当前不能导入')
      : importCap.available !== true
        ? SHUT('当前账号没有这张表的导入权限，请联系管理员')
        : OPEN('可以导入 Excel 到这张表');

  const historyGate: Gate = !historyCap || historyCap.version !== 1 || historyCap.service !== 'platform.object.history'
    ? SHUT('这张表没有修改历史')
    : historyCap.available === false
      ? SHUT('当前账号看不到这张表的修改历史')
      : OPEN('可以查看每条记录的修改历史');

  const recycleGate: Gate = !lifecycleCap
    ? SHUT('这张表没有回收站（记录不走回收，删掉后不能在这里恢复）')
    : lifecycleCap.available !== true
      ? SHUT('这张表还没完成回收字段升级（记录不走回收，删掉后不能在这里恢复）')
      : !operations.includes('recycle') || !operations.includes('restore')
        ? SHUT('当前账号没有回收与恢复记录的权限')
        : OPEN('可以查看回收站并恢复记录');

  const filterable = filterableFields(meta);
  const columnFilter: Gate = filterable.length
    ? OPEN('可以按列筛选（服务端按整表算，不是只筛已加载的那几行）')
    : SHUT('这张表没有可用于筛选的字段');

  /* 建表要走「晋升」那条路（表文件 ＋ 每列晋升 ＋ 受管对象 ＋ 受管记录），
     而首次晋升是 **System Manager 专属** ⇒ 闸从服务端的能力清单读。
     客户端角色只当兜底（服务端没给能力清单时）。 */
  const canPromote = options.canPromote ?? !!options.isAdmin;
  const createTable: Gate = canPromote
    ? OPEN('可以新建业务表（表文件 ＋ 每一列晋升 ＋ 受管对象 ＋ 受管记录）')
    : SHUT('新建业务表要先做「首次晋升」，这一步只对管理员开放，请联系管理员');

  return { create, export: exportGate, import: importGate, history: historyGate, recycle: recycleGate, columnFilter, createTable };
}

/* —— 写保护 ——————————————————————————————————————————————— */

/** **不许写**的字段类型（对齐表格中心 `canEditColumn` 的口径）。 */
const NON_WRITABLE_FIELD_TYPES = new Set(['reference', 'detail']);
/** **不许写**的输入规则类型（明细行是数组；对象型同理）。 */
const NON_WRITABLE_SCHEMA_TYPES = new Set(['array', 'object']);

/**
 * 这一列能不能写。
 *
 * `field.type` 是字段类型（text／integer／reference／detail…），
 * `schemaType` 是服务端给的输入规则类型（string／integer／array／object…）。
 * 两者任一落在禁写清单里 ⇒ 不可写。
 */
export function isColumnWritable(field: { id: string; type: string }, schemaType?: string): boolean {
  if (NON_WRITABLE_FIELD_TYPES.has(field.type)) return false;
  if (schemaType && NON_WRITABLE_SCHEMA_TYPES.has(schemaType)) return false;
  return true;
}

/** 禁写列的人话说法（给提示用）。 */
export function describeNonWritable(fieldType: string): string {
  if (fieldType === 'reference') return '关联列';
  if (fieldType === 'detail') return '明细列';
  return '这一列';
}

/**
 * 一格该**显示**什么。
 *
 * 服务端对关联列另给了一份 `_display`（人认识的名字）⇒ 用它；
 * 没有显示值才退回原值。**不许把显示名当值写回去** —— 那由 `isColumnWritable` 挡。
 */
export function displayCellValue(row: Record<string, unknown>, fieldId: string): string {
  const display = row._display as Record<string, unknown> | undefined;
  if (display && display[fieldId] !== undefined && display[fieldId] !== null) {
    return String(display[fieldId]);
  }
  const value = row[fieldId];
  if (value === null || value === undefined) return '';
  return String(value);
}

/* —— HTTP 小工具 ————————————————————————————————————————————— */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function postJson<T>(fetcher: Fetcher, url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetcher(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    throw Error(payload?.error || payload?.message || `操作失败（HTTP ${response.status}）`);
  }
  return payload as T;
}

/** 动作回执裹在 `result` 里，服务回执是平的 —— 两种都收。 */
function unwrap(body: any): any {
  return body?.result ?? body ?? {};
}

/* —— 1. 新增记录 —————————————————————————————————————————————— */

export interface CreateRecordArgs {
  objectId: string;
  expectedRevision: number;
  values: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RecordResult {
  name: string;
  modified: string;
  revision: number;
}

export async function createRecord(fetcher: Fetcher, args: CreateRecordArgs, signal?: AbortSignal): Promise<RecordResult> {
  const body = await postJson<any>(fetcher, '/api/platform/actions/platform.object.create/execute', {
    payload: {
      object_id: args.objectId,
      expected_revision: args.expectedRevision,
      values: args.values,
    },
    confirmed: true,
    idempotency_key: args.idempotencyKey,
    source: 'user',
  }, signal);
  const result = unwrap(body);
  if (!result?.name) throw Error('新增记录的回执不完整，没拿到记录号');
  return {
    name: String(result.name),
    modified: String(result.modified ?? ''),
    revision: Number(result.revision ?? args.expectedRevision),
  };
}

/* —— 2. 导出 ———————————————————————————————————————————————— */

export interface ExportRecordsArgs {
  objectId: string;
  expectedRevision: number;
  filters?: Record<string, unknown>;
}

export interface ExportResult {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  /** 服务端给的**全表**条数（不是本页条数）。 */
  total: number;
}

export async function exportRecords(fetcher: Fetcher, args: ExportRecordsArgs, signal?: AbortSignal): Promise<ExportResult> {
  const body = await postJson<any>(fetcher, '/api/platform/services/platform.object.export/invoke', {
    payload: {
      object_id: args.objectId,
      expected_revision: args.expectedRevision,
      filters: args.filters ?? {},
    },
  }, signal);
  const result = unwrap(body);
  if (
    typeof result.content_base64 !== 'string' ||
    typeof result.filename !== 'string' ||
    !/\.xlsx$/i.test(result.filename) ||
    !Number.isInteger(result.total) ||
    result.total < 0
  ) {
    throw Error('导出回执不完整，未下载文件');
  }
  const binary = atob(result.content_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return {
    filename: result.filename,
    mime: result.mime_type || XLSX_MIME,
    bytes,
    total: result.total,
  };
}

/* —— 3. 修改历史 ————————————————————————————————————————————— */

export interface HistoryArgs {
  objectId: string;
  name: string;
  page?: number;
  pageLength?: number;
}

export interface HistoryResult {
  items: any[];
  total: number;
  page: number;
  page_length: number;
}

export async function readHistory(fetcher: Fetcher, args: HistoryArgs, signal?: AbortSignal): Promise<HistoryResult> {
  const body = await postJson<any>(fetcher, '/api/platform/services/platform.object.history/invoke', {
    payload: {
      object_id: args.objectId,
      name: args.name,
      page: args.page ?? 1,
      page_length: args.pageLength ?? 20,
    },
  }, signal);
  const result = unwrap(body);
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: Number(result.total ?? 0),
    page: Number(result.page ?? 1),
    page_length: Number(result.page_length ?? 0),
  };
}

/* —— 4. 回收站／恢复 ————————————————————————————————————————— */

export interface LifecycleArgs {
  objectId: string;
  name: string;
  expectedRevision: number;
  expectedModified: string;
  idempotencyKey: string;
}

export interface LifecycleResult {
  name: string;
  modified: string;
  state: string;
}

async function changeState(
  fetcher: Fetcher,
  action: 'recycle' | 'restore',
  args: LifecycleArgs,
  signal?: AbortSignal,
): Promise<LifecycleResult> {
  const body = await postJson<any>(fetcher, `/api/platform/actions/platform.object.${action}/execute`, {
    payload: {
      object_id: args.objectId,
      name: args.name,
      expected_revision: args.expectedRevision,
      expected_modified: args.expectedModified,
    },
    confirmed: true,
    idempotency_key: args.idempotencyKey,
    source: 'user',
  }, signal);
  const result = unwrap(body);
  if (!result?.name) throw Error(action === 'recycle' ? '回收的回执不完整' : '恢复的回执不完整');
  return {
    name: String(result.name),
    modified: String(result.modified ?? ''),
    state: String(result.state ?? ''),
  };
}

export async function recycleRecord(fetcher: Fetcher, args: LifecycleArgs, signal?: AbortSignal): Promise<LifecycleResult> {
  return changeState(fetcher, 'recycle', args, signal);
}

export async function restoreRecord(fetcher: Fetcher, args: LifecycleArgs, signal?: AbortSignal): Promise<LifecycleResult> {
  return changeState(fetcher, 'restore', args, signal);
}

/** 回收站清单：读的是**回收范围**（`$scope=trash`），不是普通记录。 */
export async function readTrashRecords(
  fetcher: Fetcher,
  objectId: string,
  options: { page?: number; pageLength?: number } = {},
  signal?: AbortSignal,
): Promise<{ rows: any[]; total: number }> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_length: String(options.pageLength ?? 100),
    filters: JSON.stringify({ $scope: 'trash' }),
  });
  const response = await fetcher(`/api/platform/objects/${encodeURIComponent(objectId)}/records?${query}`, {
    credentials: 'include',
    signal,
  });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw Error(body?.error || '回收站读取失败');
  return { rows: Array.isArray(body.rows) ? body.rows : [], total: Number(body.total || 0) };
}

/* —— 5. 导入 ———————————————————————————————————————————————— */

/** 导入预检的第 1／2／3 阶段都走这一个服务（载荷逐段变长）。 */
export async function previewImport(fetcher: Fetcher, payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const body = await postJson<any>(fetcher, '/api/platform/services/platform.object.import_preview/invoke', { payload }, signal);
  return unwrap(body);
}

/** 确认导入：走公共动作，带预检凭据（`preview_hash`）——服务端会核对，不对就拒。 */
export async function confirmImport(
  fetcher: Fetcher,
  payload: Record<string, unknown>,
  options: { idempotencyKey?: string } = {},
  signal?: AbortSignal,
): Promise<{ create: number; update: number; unchanged: number; revision?: number }> {
  const body = await postJson<any>(fetcher, '/api/platform/actions/platform.object.import/execute', {
    payload,
    confirmed: true,
    idempotency_key: options.idempotencyKey ?? `import-${Date.now().toString(36)}`,
    source: 'user',
  }, signal);
  const result = unwrap(body);
  return {
    create: Number(result.create ?? 0),
    update: Number(result.update ?? 0),
    unchanged: Number(result.unchanged ?? 0),
    revision: typeof result.revision === 'number' ? result.revision : undefined,
  };
}

/* —— 6. 批量粘贴 ————————————————————————————————————————————— */

export interface PasteCell {
  fieldId: string;
  text: string;
  /** 这一格在粘贴矩阵里的**列序**（回写改前的值时要用）。 */
  index?: number;
}

export interface PasteRow {
  /** 有行号＝改这条；没有＝新建一条。 */
  rowId: string | null;
  /** 改之前的记录版本（记录级并发闸）。 */
  modified?: string;
  cells: PasteCell[];
  /** 这一行在粘贴矩阵里的**行序**。 */
  index?: number;
}

export interface PastePlan {
  /** 要新建的行。 */
  creates: PasteRow[];
  /** 要改的行。 */
  updates: PasteRow[];
  /** 按粘贴顺序排好的全部写入行（新建与修改混在原顺序里）。 */
  rows: PasteRow[];
}

/**
 * 把「粘进来的每一行」分成两类：改已有行 / 新建行。
 *
 * · 改已有行：**空格子也留着**（空＝把那一格清空）；
 * · 新建行：整行都是空格的**不建**（建一条全空的记录没有意义，也没人要）。
 */
export function planPaste(rows: PasteRow[]): PastePlan {
  const creates: PasteRow[] = [];
  const updates: PasteRow[] = [];
  const ordered: PasteRow[] = [];
  (rows || []).forEach((row, rowIndex) => {
    const cells = (row.cells || [])
      .map((cell, cellIndex) => ({ ...cell, index: cellIndex }))
      .filter(cell => !!cell && typeof cell.fieldId === 'string' && cell.fieldId !== '');
    if (!cells.length) return;
    const target: PasteRow = { ...row, index: rowIndex, cells };
    if (row.rowId) {
      updates.push(target);
      ordered.push(target);
      return;
    }
    if (cells.every(cell => String(cell.text ?? '') === '')) return;
    creates.push(target);
    ordered.push(target);
  });
  return { creates, updates, rows: ordered };
}

export interface ApplyPasteArgs {
  objectId: string;
  /** 只认服务端定义来源；省略时保留原逐行路径。 */
  source?: string;
  expectedRevision: number;
  plan: PastePlan;
  /** 字段类型表（fieldId → {type, label, schemaType}），用来判只读并把文本转成类型化值。 */
  fields: Record<string, { type?: string; label?: string; schemaType?: string } | undefined>;
  idempotencyKey: string;
}

export interface PasteResult {
  created: number;
  updated: number;
  actionCount: number;
  idempotent: boolean;
  /** 写完之后拿到的记录号（按粘贴顺序）。 */
  names: string[];
}

/**
 * 受管对象的既有行走一次公共 update_many，字段规则、版本和审计仍由动作核验。
 * 原生对象或包含新建行的计划沿原逐行路径；批量动作失败不回退逐行。
 *
 * 只读列（关联列／明细列）**整包拒、零写** —— 与表格中心的口径一致。
 */
export async function applyPaste(fetcher: Fetcher, args: ApplyPasteArgs, signal?: AbortSignal): Promise<PasteResult> {
  const { objectId, expectedRevision, plan, fields, idempotencyKey } = args;
  const ordered = plan.rows || [...plan.updates, ...plan.creates];
  // 先整包体检：有一格不能写 ⇒ 一格都不写。
  for (const row of ordered) {
    for (const cell of row.cells) {
      const field = fields[cell.fieldId];
      const fieldType = String(field?.type ?? '');
      const schemaType = field?.schemaType;
      if (!isColumnWritable({ id: cell.fieldId, type: fieldType }, schemaType)) {
        const label = field?.label || cell.fieldId;
        throw Error(`「${label}」是${describeNonWritable(fieldType)}，不能写入；本次粘贴整包未生效`);
      }
    }
  }
  const names: string[] = [];
  let created = 0;
  let updated = 0;
  const prepared = ordered.map(row => {
    const values: Record<string, unknown> = {};
    for (const cell of row.cells) {
      const fieldType = String(fields[cell.fieldId]?.type ?? '');
      const text = String(cell.text ?? '');
      values[cell.fieldId] = text === '' ? null : coerceObjectValue(fieldType, text);
    }
    return { row, values };
  });
  if (args.source === 'managed' && prepared.length && prepared.every(({row}) => !!row.rowId)) {
    const records = prepared.map(({row,values}) => ({name:row.rowId!,expected_modified:row.modified ?? '',values}));
    const body = await postJson<any>(fetcher, '/api/platform/actions/platform.object.update_many/execute', {
      payload: {object_id:objectId,expected_revision:expectedRevision,records},
      confirmed:true,idempotency_key:idempotencyKey,source:'user',
    }, signal);
    const result = unwrap(body);
    // 记录顺序用于上层逐格回填与撤回；缺项、错对象或错行都不能按成功消费。
    if (result.object_id !== objectId || result.revision !== expectedRevision ||
        result.written !== records.length || result.record_version_checked !== true ||
        !Array.isArray(result.records) || result.records.length !== records.length ||
        result.records.some((name:unknown,index:number) => name !== records[index].name)) {
      throw Error('批量保存回执不完整或目标不一致，结果待核实；请沿用原操作重试');
    }
    return {created:0,updated:records.length,names:[...result.records],actionCount:1,idempotent:body?.idempotent===true};
  }
  for (const [index, {row,values}] of prepared.entries()) {
    if (row.rowId) {
      const body = await postJson<any>(fetcher, '/api/platform/actions/platform.object.update/execute', {
        payload: {
          object_id: objectId,
          name: row.rowId,
          expected_revision: expectedRevision,
          expected_modified: row.modified ?? '',
          values,
        },
        confirmed: true,
        idempotency_key: `${idempotencyKey}-u${index}`,
        source: 'user',
      }, signal);
      const result = unwrap(body);
      names.push(String(result.name ?? row.rowId));
      updated += 1;
    } else {
      const body = await postJson<any>(fetcher, '/api/platform/actions/platform.object.create/execute', {
        payload: { object_id: objectId, expected_revision: expectedRevision, values },
        confirmed: true,
        idempotency_key: `${idempotencyKey}-c${index}`,
        source: 'user',
      }, signal);
      const result = unwrap(body);
      if (!result?.name) throw Error('新增记录的回执不完整，没拿到记录号');
      names.push(String(result.name));
      created += 1;
    }
  }
  return { created, updated, names, actionCount:created+updated, idempotent:false };
}

/* —— 7. 按列筛选（服务端） ——————————————————————————————————— */

/**
 * 把某一列的筛选条件并进**服务端** filters。
 *
 * · 换一列筛选 ⇒ 新条件加进去，别的列的条件留着；
 * · 清除某一列 ⇒ 只去掉那一列；
 * · `$` 开头的键（`$search`／`$sort`／`$scope`）不是「某一列的条件」，原样透传。
 */
export function buildServerFilters(
  base: Record<string, unknown>,
  filter: { column: string; value: string | null } | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base || {}) };
  if (filter && filter.column) {
    if (filter.value === null || filter.value === undefined) delete out[filter.column];
    else out[filter.column] = filter.value;
  }
  return out;
}

export { coerceObjectValue };

/* —— 8. 建表（走「晋升」那条路） —————————————————————————————— */

/**
 * **新建业务表** ⇒ 走「晋升」那条路（内核口径 `shangshu_core/data_ownership.py`）：
 *
 *   **表文件（xlsx，在文件中心）→ 每一列都晋升成受管列 → 受管对象 ＋ 受管记录**。
 *
 * **不建 DocType** —— 受管对象的物理表归内核管（受字段 ACL 管、受版本闸管、审计进统一日志库），
 * 域拆了以后数据还能被接手。
 *
 * 三步都走**既有公开口**，不新造写 API：
 *  ① `files.create`（表名 ＋ 表头 ＋ 归属）⇒ 表文件编号；
 *  ② `files.promotion_definition`（只读）⇒ 结构版本（晋升要钉住「绑定那一刻」的结构）；
 *  ③ `files.promotion_define`（每一列 `promoted: true`）⇒ 受管对象 ＋ 受管记录。
 *
 * ⚠️ ③ 是 **System Manager 专属**（域声明里写死「首次晋升仅 FDE 受管工程入口」）
 * ⇒ 前端**先查服务端能力清单**（`GET /api/platform/actions` 里有没有这条），
 * 没有就把按钮**置灰并说清找谁**，不做一个「点了报不支持」的按钮。
 */

export interface CreateTableArgs {
  /** 表名（不带扩展名也行，`.xlsx` 自动补）。 */
  fileName: string;
  /** 表头（第一行的列名，按顺序）。 */
  headers: string[];
  /** 归属（建表必填）。 */
  attribution: { level: 'personal' | 'department'; department?: string };
  idempotencyKey: string;
  /**
   * 每一列的主体范围（**必填**，PKG-117-T01）。
   *
   * 口径：契约第 260 行「每次晋升一列必须写清楚该列的主体范围（全局/部门/个人；
   * 部门与个人要指到具体对象）⇒ 晋升入口必填」。
   * **缺一列就不许提交**（并说清是哪一列没填）—— 改之前这里是硬编码
   * `read_roles:['Desk User']`，等于没让人定。
   */
  columns?: PromotionColumnScope[];
  /**
   * **每一列的类型与规则**（PKG-126-T04 · 2026-10-27）。
   *
   * ⚠️ **不给就照旧**（那一列落「文字」、没有规则）—— 老调用方的行为一个字不变。
   * 给了才按声明走（`type` ＋ `rules`），服务端会照声明建受管字段。
   */
  columnRules?: PromotionColumnRule[];
  /** 整张表的主体范围（不给就按「全局」＝全员可读可写，与改之前的底座一致）。 */
  access?: AccessMap;
}

export interface CreateTableResult {
  /** 表文件编号（文件中心里的那张表）。 */
  fileId: string;
  /** 受管对象编号（业务表身份）。 */
  objectId: string;
  /** 这次升了几列。 */
  promotedColumns: number;
  /** 建了几条受管记录。 */
  managedRecords: number;
}

/**
 * 受管字段 id：必须是 `^[a-z][a-z0-9_]{0,47}$`，且不能叫 `name`／`modified`／`creation`
 * （内核给这三列留了固定尾注）。
 *
 * 表头是人写的（可能带空格、标点、中文）⇒ 从表头推一个**合法的** id，推不出来就用序号。
 */
export function promotionFieldId(header: string, index: number): string {
  const base = String(header || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const reserved = ['name', 'modified', 'creation'];
  if (base && /^[a-z]/.test(base) && !reserved.includes(base)) return base;
  return `col_${index + 1}`;
}

/**
 * 一组表头 ⇒ 一组**互不重复**的受管字段 id。
 *
 * 两个表头可能推出同一个 id（「客户名」和「客户-名」都变成 `customer`）⇒
 * 内核会拒「字段 ID 重复」⇒ 这里**先排重**（后面的加序号），不把错丢给服务端。
 */
export function promotionFieldIds(headers: string[]): string[] {
  const used = new Set<string>();
  return (headers || []).map((header, index) => {
    let id = promotionFieldId(header, index);
    while (used.has(id)) id = `col_${index + 1}_${used.size}`;
    used.add(id);
    return id;
  });
}

/**
 * 建表：表文件 ＋ 每列晋升 ＋ 受管对象 ＋ 受管记录。
 *
 * 失败**不留半成品**：表文件建成功但晋升失败时，回执里**把表文件编号说出来**
 * （人能接着找管理员补晋升），不吞掉。
 */
export async function createTableByPromotion(
  fetcher: Fetcher,
  args: CreateTableArgs,
  signal?: AbortSignal,
): Promise<CreateTableResult> {
  const name = String(args.fileName || '').trim();
  if (!name) throw Error('请填写表名');
  const headers = (args.headers || []).map(header => String(header || '').trim()).filter(Boolean);
  if (!headers.length) throw Error('至少要有一列：请填写表头');
  if (headers.length > 50) throw Error('一张表最多 50 列');

  // ⓪ 每一列的主体范围（**必填**）—— 先查，再动任何写。
  //    没指到具体对象（选了部门却没选部门、选了个人却没选人）也不许提交。
  const scopes = args.columns ?? [];
  validatePromotionScopes(scopes, headers);
  const tableAccess = args.access ?? defaultTableAccess();
  validateAccessMap(tableAccess, '整张表', '整张表');

  // ① 表文件（xlsx，进文件中心）
  const created = unwrap(
    await postJson<any>(fetcher, '/api/platform/actions/files.create/execute', {
      payload: {
        file_name: name.toLowerCase().endsWith('.xlsx') ? name : `${name}.xlsx`,
        directory: '/',
        attribution: {
          level: args.attribution.level,
          ...(args.attribution.level === 'department' && args.attribution.department
            ? { department: args.attribution.department }
            : {}),
        },
        headers,
      },
      confirmed: true,
      idempotency_key: `${args.idempotencyKey}-file`,
      source: 'user',
    }, signal),
  );
  const fileId = String(created?.file || created?.file_id || created?.id || created?.table_id || '');
  if (!fileId) throw Error('建表回执不完整，没拿到表文件编号');

  // ② 读表结构版本（晋升要钉住「绑定那一刻」的结构；表头改过就不许拿旧结构来绑）
  let structureVersion = 1;
  let definitionVersion = 1;
  try {
    const definition = unwrap(
      await postJson<any>(fetcher, '/api/platform/services/files.promotion_definition/invoke', {
        payload: { table: fileId },
      }, signal),
    );
    structureVersion = Number(definition?.structure_version ?? 1) || 1;
    definitionVersion = Number(definition?.definition_version ?? 1) || 1;
  } catch {
    // 读不到定义就按「刚建的文件」的结构版本 1 走；真对不上时服务端会拒（并说清原因）。
  }

  // ③ 每一列都晋升成受管列 ⇒ 受管对象 ＋ 受管记录
  //    ⚠️ 落库形状是**新模型**（读（筛）／写／下载 × 全局／部门／个人／无人）——
  //    旧三键（read_roles／write_roles／download_roles）不再产出（契约：不要留兼容函数）。
  const fields = promotionFieldIds(headers);
  /* —— **逐列的类型与规则**（PKG-126-T04 · 2026-10-27）——
     原来这里**一律 `type:'text'`** ⇒ 受管列天生是自由文本（日期列没日历、布尔列分不出未填／否、
     数值列不校验、枚举列给不出下拉）⇒ 现在按**人声明的**来。
     ⚠️ **没声明的列仍然落「文字」**（老调用方行为一个字不变）。 */
  const declared = new Map((args.columnRules || []).map(rule => [String(rule.header), rule]));
  const columns = headers.map((header, index) => {
    const rule = declared.get(header);
    const column: Record<string, unknown> = {
      header,
      field: fields[index],
      type: rule && rule.type ? rule.type : 'text',
      promoted: true,
      access: scopes.find(scope => scope.header === header)?.access ?? {},
    };
    /* 规则**只在声明了才带**（服务端没声明的键＝没有约束）。 */
    if (rule && rule.rules && Object.keys(rule.rules).length) column.rules = rule.rules;
    return column;
  });
  const promoted = unwrap(
    await postJson<any>(fetcher, '/api/platform/actions/files.promotion_define/execute', {
      payload: {
        table: fileId,
        expected_structure_version: structureVersion,
        definition: { definition_version: definitionVersion, columns, access: tableAccess },
      },
      confirmed: true,
      idempotency_key: `${args.idempotencyKey}-promote`,
      source: 'user',
    }, signal),
  );
  const lifecycle = promoted?.lifecycle || promoted?.result?.lifecycle || promoted || {};
  const objectId = String(lifecycle?.object_id || promoted?.object_id || '');
  if (!objectId) {
    throw Error(`表文件已建好（${fileId}），但晋升回执里没拿到受管对象编号；请让管理员补做这一步`);
  }
  return {
    fileId,
    objectId,
    promotedColumns: Number(lifecycle?.promoted ?? columns.length),
    managedRecords: Number(lifecycle?.managed_records ?? 0),
  };
}
