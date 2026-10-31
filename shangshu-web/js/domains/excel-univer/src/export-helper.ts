/** 导出复用正式权限/版本链；不能从画布或只读查询结果自行拼文件。 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface ExportCapabilities {
  available: boolean; canStructure: boolean; name: string; revision: number; file?: string; hasRelations?:boolean;
}
interface Options {
  fetcher?: Fetcher; signal?: AbortSignal; hasUnsaved?(): boolean; stillCurrent?(): boolean;
}
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function jsonRequest(url: string, options: Options, payload?: Record<string, unknown>): Promise<any> {
  const response = await (options.fetcher ?? fetch)(url, {
    credentials: 'include', signal: options.signal, cache: 'no-store',
    ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload }) } : {}),
  });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw Error(body?.error || body?.message || `读取导出信息失败（HTTP ${response.status}）`);
  return body?.result ?? body;
}
export async function readExportCapabilities(table: string, kind: 'xlsx' | 'db', options: Options = {}): Promise<ExportCapabilities> {
  // 未接入伴随文件的对象不伪装成完整表导出，也不在本批增加数据库导出入口。
  if (kind !== 'xlsx') return { available: false, canStructure: false, name: '表格', revision: 0 };
  if (kind === 'xlsx') {
    const result = await jsonRequest('/api/platform/services/files.versions/invoke', options, { file: table });
    const resource = result.file;
    if (resource?.name !== table || !Number.isInteger(resource.version)) throw Error('当前文件版本不可用，请刷新重试');
    const latest = result.current?.content_revision === resource.version
      ? result.current
      : result.versions?.find((version: any) => version.version_no === resource.version);
    if (!latest?.frappe_file) throw Error('当前文件版本不可用，未导出旧版本');
    return { available: resource.can_download === true && resource.status === 'Active',
      canStructure: resource.can_structure === true, name: resource.file_name || '表格.xlsx',
      revision: resource.version, file: latest.frappe_file,hasRelations:resource.has_table_relations===true };
  }
  throw Error('这张表暂不支持导出');
}
function assertReady(options: Options) {
  if (options.signal?.aborted || options.stillCurrent?.() === false) throw Error('表格已切换，未导出');
  if (options.hasUnsaved?.()) throw Error('还有未保存的修改，请保存或处理失败后再导出');
}
export async function exportCurrentTable(table: string, kind: 'xlsx' | 'db', options: Options = {}): Promise<{
  filename: string; mime: string; bytes: ArrayBuffer;
}> {
  assertReady(options);
  const capability = await readExportCapabilities(table, kind, options);
  assertReady(options);
  if (!capability.available) throw Error('当前账号没有这张表的导出权限');
  if(capability.hasRelations){
    const result=await jsonRequest('/api/platform/services/files.table_relation_export/invoke',options,{table});
    assertReady(options);
    if(result.snapshot!==true||typeof result.content_base64!=='string')throw Error('关联导出缺少有效快照');
    const binary=atob(result.content_base64),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return {filename:result.file_name||capability.name,mime:result.content_type||MIME,bytes:bytes.buffer};
  }
  if (kind === 'xlsx') {
    const query = new URLSearchParams({ ref: 'Shangshu File Center File', ref_name: table, file: capability.file! });
    const response = await (options.fetcher ?? fetch)('/api/platform/file-content?' + query, {
      credentials: 'include', signal: options.signal, cache: 'no-store',
    });
    if (!response.ok) throw Error(`下载失败（HTTP ${response.status}）`);
    const bytes = await response.arrayBuffer();
    assertReady(options);
    // 下载期间仍可能出现新的正式版本或撤权；旧文件不假称当前导出。
    const latest = await readExportCapabilities(table, kind, options);
    assertReady(options);
    if (!latest.available) throw Error('导出权限已变化，未下载');
    if (latest.revision !== capability.revision || latest.file !== capability.file) throw Error('文件已更新，请重新导出最新版本');
    return { filename: /\.xlsx$/i.test(latest.name) ? latest.name : latest.name + '.xlsx', mime: MIME, bytes };
  }
  throw Error('这张表暂不支持导出');
}
