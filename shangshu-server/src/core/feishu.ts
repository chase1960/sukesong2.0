// 飞书 OpenAPI 客户端：用 app_id + app_secret 换 tenant_access_token，直接 HTTP 调 bitable v1。
// 替代原先 shelling out 到 lark-cli 二进制——lark-cli 在容器里没装、user token 会过期，不可部署。
// 只实装 server 用到的 record list / create / update；附件上传等暂仍由运维侧 lark-cli 处理。
// 凭证来自 RuntimeConfig.feishu.{app_id, app_secret, bitable_app_token}（env/config 注入）。
import type { RuntimeConfig } from './types.ts';

const OPEN_BASE = 'https://open.feishu.cn';
type FeishuCreds = Pick<RuntimeConfig['feishu'], 'app_id' | 'app_secret' | 'bitable_app_token'>;

// tenant_access_token 缓存（飞书默认 2h 过期；提前 60s 刷新，避免临界过期）。
let tokenCache: { token: string; exp: number } | null = null;

async function getTenantAccessToken(fs: FeishuCreds): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp - 60_000 > now) return tokenCache.token;
  if (!fs.app_id || !fs.app_secret) {
    throw new Error('feishu.app_id / app_secret 未配置（无法获取 tenant_access_token）');
  }
  const r = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: fs.app_id, app_secret: fs.app_secret }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.code !== 0) {
    // 不把飞书 code/msg 回传给 HTTP 客户端(避免泄露凭证探测信息)，详细落服务端日志
    console.error(`[feishu] tenant_access_token 获取失败: code=${d.code} msg=${d.msg}`);
    throw new Error('飞书 tenant_access_token 获取失败（详见服务端日志）');
  }
  tokenCache = { token: d.tenant_access_token, exp: now + (d.expire || 7200) * 1000 };
  return tokenCache.token;
}

async function bitable<T = any>(fs: FeishuCreds, method: string, path: string, body?: any): Promise<T> {
  const token = await getTenantAccessToken(fs);
  const url = `${OPEN_BASE}/open-apis/bitable/v1/apps/${fs.bitable_app_token}${path}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  // 先读 text 再安全 parse：飞书偶发返回非 JSON（限流页/5xx）时给可诊断错误，而非 opaque JSON.parse 崩溃。
  const text = await r.text();
  let d: any;
  try { d = JSON.parse(text); }
  catch {
    // 上游原始响应体可能含反射的路径/token 残片，不回传客户端；HTTP status 保留供诊断
    console.error(`[feishu] bitable ${method} ${path} 返回非 JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);
    throw new Error(`飞书 bitable 请求失败（HTTP ${r.status}，响应非 JSON）`);
  }
  if (d.code !== 0) {
    console.error(`[feishu] bitable ${method} ${path} 失败: code=${d.code} msg=${d.msg}`);
    throw new Error('飞书 bitable 请求失败（详见服务端日志）');
  }
  return d.data as T;
}

type ListPage = { items?: any[]; records?: any[]; has_more?: boolean; page_token?: string; next?: { page_token?: string; has_more?: boolean } };

// 列记录：分页取全量（page_size=500 + page_token 翻页）。早期只取一页 500 条，表超过 500 行后
// query 的内存过滤会漏掉老记录 → 发票去重失效、插入重复行。上限 20 页(1万条)防失控。
// R0：opts.sort 下沉为云端 sort（JSON 数组参数）；opts.limit 限制 page_size 与翻页——「取最新 N 条」
//     不再全表拉取（如链尾 hydrate、最近事件流）。
export async function listRecords(
  fs: FeishuCreds, tableId: string,
  opts?: { sort?: Array<{ field_name: string; desc?: boolean }>; limit?: number },
): Promise<{ record_id: string; fields: Record<string, any> }[]> {
  const all: { record_id: string; fields: Record<string, any> }[] = [];
  let pageToken: string | undefined = undefined;
  const pageSize = opts?.limit ? Math.min(opts.limit, 500) : 500;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 10000) throw new Error('分页超过安全上限，拒绝返回不完整数据');
    let qs: string = `page_size=${pageSize}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    if (opts?.sort?.length) qs += `&sort=${encodeURIComponent(JSON.stringify(opts.sort))}`;
    const data: ListPage = await bitable<ListPage>(fs, 'GET', `/tables/${tableId}/records?${qs}`);
    // v1 list 用 items；个别版本/包装返回 records —— 两者都兜底。
    const list = data.items || data.records || [];
    for (const it of list) all.push({ record_id: it.record_id, fields: it.fields || {} });
    const hasMore = data.has_more ?? data.next?.has_more ?? false;
    pageToken = data.page_token ?? data.next?.page_token ?? undefined;
    if (opts?.limit && all.length >= opts.limit) break;
    if (!hasMore) break;
    if (!pageToken || seen.has(pageToken)) throw new Error('记录分页游标缺失或循环，拒绝返回不完整数据');
    seen.add(pageToken);
  }
  return all;
}

// 批量建记录：fieldsList = [{列名:值}, ...]。返回新建 record_id 列表。
export async function createRecords(fs: FeishuCreds, tableId: string, fieldsList: Record<string, any>[]): Promise<string[]> {
  const data = await bitable<{ records?: { record_id: string }[] }>(fs, 'POST', `/tables/${tableId}/records/batch_create`, { records: fieldsList.map((f) => ({ fields: f })) });
  return (data.records || []).map((r) => r.record_id);
}

// 批量更新：patches = [{record_id, fields:{列名:值}}]。返回受影响 record_id。
export async function updateRecords(fs: FeishuCreds, tableId: string, patches: { record_id: string; fields: Record<string, any> }[]): Promise<string[]> {
  const data = await bitable<{ records?: { record_id: string }[] }>(fs, 'POST', `/tables/${tableId}/records/batch_update`, { records: patches });
  return (data.records || []).map((r) => r.record_id);
}

// 下载飞书云空间文件（bitable 附件字段的 file_token），供发票原图预览。
// 返回 bytes + 真实 Content-Type + 文件名（drive 接口返回 Content-Disposition 带原名）。
export async function downloadMedia(fs: FeishuCreds, fileToken: string): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const token = await getTenantAccessToken(fs);
  const url = `${OPEN_BASE}/open-apis/drive/v1/medias/${fileToken}/download`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(`[feishu] media 下载失败: HTTP ${r.status} ${text.slice(0, 200)}`);
    throw new Error(`飞书文件下载失败（HTTP ${r.status}）`);
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const cd = r.headers.get('content-disposition') || '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || fileToken;
  return { bytes, mime, name };
}

// 上传文件到飞书云空间（parent=bitable），返回 file_token，再挂到记录附件字段。
// upload_all 限制 20MB，发票 PDF 远低于此。权限走 tenant（bot），替代原先 lark-cli。
export async function uploadMedia(fs: FeishuCreds, filename: string, bytes: Buffer, mime: string): Promise<string> {
  const token = await getTenantAccessToken(fs);
  const form = new FormData();
  form.append('file_name', filename);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', fs.bitable_app_token);
  form.append('size', String(bytes.length));
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  const r = await fetch(`${OPEN_BASE}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let d: any;
  try { d = JSON.parse(text); }
  catch { throw new Error(`飞书媒体上传失败（HTTP ${r.status}）`); }
  if (d.code !== 0) {
    console.error(`[feishu] upload_all 失败: code=${d.code} msg=${d.msg}`);
    throw new Error('飞书媒体上传失败（详见服务端日志）');
  }
  return d.data.file_token;
}

// —— 表管理（多表地基：自动建表用）——
export interface BitableTableMeta { table_id: string; name: string }

export async function listTables(fs: FeishuCreds): Promise<BitableTableMeta[]> {
  const all: BitableTableMeta[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if(page>=10000) throw new Error('表分页超过安全上限');
    const qs = `page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await bitable<{ items?: BitableTableMeta[]; has_more?: boolean; page_token?: string }>(fs, 'GET', `/tables?${qs}`);
    all.push(...(data.items || []));
    if (!data.has_more) break;
    if (!data.page_token || seen.has(data.page_token)) throw new Error('表分页游标缺失或循环');
    pageToken = data.page_token;
    seen.add(pageToken);
  }
  return all;
}

export interface FieldSpec { field_name: string; type: number; options?: string[] }

// 建表。type：1 文本 / 2 数字 / 3 单选 / 5 日期。select 需 options。返回 table_id。
export async function createTable(fs: FeishuCreds, name: string, fields: FieldSpec[]): Promise<string> {
  const body = {
    table: {
      name,
      default_view_name: '默认视图',
      fields: fields.map((f) => ({
        field_name: f.field_name,
        type: f.type,
        ...(f.type === 3 && f.options ? { property: { options: f.options.map((n) => ({ name: n })) } } : {}),
        ...(f.type === 5 ? { property: { date_formatter: 'yyyy-MM-dd HH:mm', auto_fill: false } } : {}),
      })),
    },
  };
  const data = await bitable<{ table_id: string }>(fs, 'POST', '/tables', body);
  return data.table_id;
}

// —— 字段管理（R1 2026-08-14）：既有表加列——registerTable 更新 spec 后，已有 bitable 表自动补缺列 ——
export async function listFields(fs: FeishuCreds, tableId: string): Promise<{ field_name: string; type: number }[]> {
  const data = await bitable<{ items?: { field_name: string; type: number }[] }>(fs, 'GET', `/tables/${tableId}/fields?page_size=200`);
  return data.items || [];
}

// 给已有表加字段（type：1 文本 / 3 单选，与 createTable 的 ftype 对齐）
export async function createField(fs: FeishuCreds, tableId: string, f: FieldSpec): Promise<void> {
  const body: any = { field_name: f.field_name, type: f.type };
  if (f.type === 3 && f.options) body.property = { options: f.options.map((n) => ({ name: n })) };
  await bitable(fs, 'POST', `/tables/${tableId}/fields`, body);
}
