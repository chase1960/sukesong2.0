/**
 * 平台记录接口的小封装。
 *
 * 只用既有公共动作与只读查询，不另建业务数据、不新增动作：
 *   读  GET  /api/platform/objects/:id/records?page=&page_length=&filters=
 *   读  GET  /api/platform/objects/:id/records/:name
 *   写  POST /api/platform/actions/platform.object.update/execute
 *   回执 GET /api/platform/action-requests/:key
 */
import {platformObjectDefinition} from './platform-catalog';

export interface RecordRow {
  name: string;
  modified: string;
  [fieldId: string]: unknown;
}

export interface ObjectField {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  deprecated?: boolean;
  read_roles?: string[];
  write_roles?: string[];
}

export interface ObjectInfo {
  /** 公共定义明确声明的来源；不能由 revision 或对象编号推断。 */
  source?: string;
  operations?:string[];
  companion?:{object_id:string;file_id:string;definition_revision:number;field_columns:Array<{field_id:string;header:string;type:string}>}|null;
  name?: string;
  attribution?: {level?:string;department_title?:string;owner_user?:string};
  modified?: string;
  can_edit?: boolean;
  can_structure?: boolean;
  can_download?: boolean;
  can_share?: boolean;
  my_access?: {write?:boolean;structure?:boolean;download?:boolean};
  id: string;
  title: string;
  revision: number;
  fields: ObjectField[];
  /** 服务端按「当前用户可写字段」建的输入规则；properties 的键即可写字段名单。 */
  input_schema?: { properties?: Record<string, unknown> };
  /**
   * 原生（native）对象的**可筛选字段**（域声明的 `filter_fields`）。
   * 受管对象没有这个键（它们走 `query.filterable_fields`）。
   */
  filter_fields?: string[];
}

export interface PageResult {
  object: ObjectInfo;
  rows: RecordRow[];
  total: number;
  page: number;
  page_length: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || (body && body.ok === false)) {
    throw new ApiError(response.status, body?.code || String(response.status), body?.error || body?.message || `请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}

/** 一次记录读取。filters 里的 $search/$sort/$direction/$scope 是查询层保留键。 */
export function fetchRecords(
  objectId: string,
  params: { page?: number; pageLength?: number; filters?: Record<string, unknown>;
    fields?: string[]; readScope?: {mode:'query';purpose:'interactive';fields?:string[]}; includeDefinition?:boolean } = {},
  signal?: AbortSignal,
): Promise<PageResult> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    page_length: String(params.pageLength ?? 100),
  });
  if (params.filters && Object.keys(params.filters).length) {
    query.set('filters', JSON.stringify(params.filters));
  }
  if (params.fields) query.set('fields',JSON.stringify(params.fields));
  if (params.readScope) query.set('read_scope',JSON.stringify(params.readScope));
  if (params.includeDefinition === false) query.set('include_definition','0');
  return request<PageResult>(`/api/platform/objects/${encodeURIComponent(objectId)}/records?${query}`, { signal });
}

export function fetchRecord(objectId: string, name: string, signal?: AbortSignal): Promise<{ record: RecordRow }> {
  return request<{ record: RecordRow }>(
    `/api/platform/objects/${encodeURIComponent(objectId)}/records/${encodeURIComponent(name)}`,
    { signal },
  );
}

export interface UpdateArgs {
  objectId: string;
  name: string;
  expectedRevision: number;
  expectedModified: string;
  values: Record<string, unknown>;
  idempotencyKey: string;
}

export interface UpdateResult {
  ok: boolean;
  idempotent?: boolean;
  result?: { name?: string; modified?: string; revision?: number };
  [k: string]: unknown;
}

/** 单次保存。幂等键由调用方持有：回执丢失时用同一个键重试，服务端只落一次写。 */
export function updateRecord(args: UpdateArgs, signal?: AbortSignal): Promise<UpdateResult> {
  return request<UpdateResult>('/api/platform/actions/platform.object.update/execute', {
    method: 'POST',
    body: JSON.stringify({
      payload: {
        object_id: args.objectId,
        name: args.name,
        expected_revision: args.expectedRevision,
        expected_modified: args.expectedModified,
        values: args.values,
      },
      confirmed: true,
      idempotency_key: args.idempotencyKey,
      source: 'user',
    }),
    signal,
  });
}

export interface ReceiptStatus {
  ok: boolean;
  status: string;
  action_id?: string;
  audit?: string;
  replay_available?: boolean;
  failure_reason?: string;
}

/** 幂等键回执：断网/回执丢失后问“那一笔到底成没成”。 */
export function fetchReceipt(idempotencyKey: string, signal?: AbortSignal): Promise<ReceiptStatus> {
  return request<ReceiptStatus>(`/api/platform/action-requests/${encodeURIComponent(idempotencyKey)}`, { signal });
}

export function newIdempotencyKey(): string {
  return 'b1-cell-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Shared scalar conversion for normal object tables and companion source columns. */
export function coerceObjectValue(type:string|undefined,text:string):string|number|boolean|null{
 if(type==='integer'||type==='decimal'){
  if(text.trim()==='')return null;
  const value=Number(text);
  if(!Number.isFinite(value)||(type==='integer'&&!Number.isSafeInteger(value)))throw Error(type==='integer'?'该字段须填写安全范围内的整数':'该字段须填写数字');
  return value;
 }
 if(type==='boolean'){
  const value=text.trim().toLowerCase();if(value==='true'||value==='1')return true;if(value==='false'||value==='0')return false;
  if(value==='')return null;throw Error('布尔字段请填写 true/false 或 1/0');
 }
 if(type==='date'){
  const value=text.trim();if(!value)return '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('日期须为有效的 YYYY-MM-DD');
  return value;
 }
 return text;
}
export async function fetchObjectInfo(id:string,signal?:AbortSignal):Promise<ObjectInfo>{
 return await platformObjectDefinition(id,signal) as ObjectInfo;
}
