/**
 * **公共壳那个「清单口」**——同一轮里只发一次请求。
 *
 * ⚠️ **为什么要有这个**（用户 2026-10-25 问：「为什么总是会把业务域重新加载一遍」）：
 *   这个域里有**好几处**都要「服务端那份对象清单」（开表分流、统一入口的清单、
 *   能力闸、表元数据）⇒ 改之前**各拉一遍** ⇒ 开一张业务表要把同一份清单读两三次。
 *   ⇒ 走公共壳的 `shangshuPlatformCatalog`（在途共用 ＋ 短时间复用 ＋ 失败不留）。
 *
 * ⚠️ **壳的那个口不在**（域脚本单独跑／判据环境）⇒ 照旧自己读。
 */

/**
 * 服务端那份对象清单（`GET /api/platform/objects`）。
 *
 * ⚠️ `search`：**在服务端筛**（2026-10-28 · PKG-132 · 审查报告 R11）——
 * 以前是**前端**把整份目录拉回去再筛（「业务表那侧没有搜索参数，只能在取回的清单里筛」）
 * ⇒ 搜索口径与分页/总数对不上。现在**服务端筛**。
 */
export async function platformObjectList(signal?: AbortSignal, opts: {
  search?: string;page?:number;pageLength?:number;summary?:boolean;attributionLevel?:string;
} = {}): Promise<any> {
  const term = (opts.search || '').trim();
  const shared = (globalThis as any).shangshuPlatformCatalog;
  if (shared && typeof shared.objects === 'function' && !term && !opts.page && !opts.attributionLevel) return await shared.objects();
  const params=new URLSearchParams();
  if(term)params.set('search',term);
  if(opts.page)params.set('page',String(opts.page));
  if(opts.pageLength)params.set('page_length',String(opts.pageLength));
  if(opts.summary)params.set('summary','1');
  if(opts.attributionLevel)params.set('attribution_level',opts.attributionLevel);
  const query=params.size?'?'+params:'';
  const response = await fetch(`/api/platform/objects${query}`, { credentials: 'include', signal });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw Error(body?.error || '读取数据表信息失败');
  if(opts.page&&(!Array.isArray(body.list)||!Number.isInteger(body.total)||body.total<0||body.list.length>(opts.pageLength||20)))
    throw Error('对象目录分页回执不完整');
  return body;
}

/** 表身份只由公共解析器确定；不存在、冲突、无权都不能改走另一种存储。 */
export async function platformTableResource(id:string,signal?:AbortSignal):Promise<'db'|'xlsx'> {
  const response=await fetch('/api/platform/table-resources/'+encodeURIComponent(id),{credentials:'include',signal});
  const body=await response.json();
  if(!response.ok||body?.ok===false)throw Object.assign(Error(body?.error||'表格身份读取失败'),{status:response.status,code:body?.code});
  if(body?.table!==id||!['db','xlsx'].includes(body.source))throw Error('表格身份回执与目标不一致');
  return body.source;
}

/** 服务端那份动作清单（`GET /api/platform/actions`）——闸从这儿读。 */
export async function platformActionList(signal?: AbortSignal): Promise<any> {
  const shared = (globalThis as any).shangshuPlatformCatalog;
  if (shared && typeof shared.actions === 'function') return await shared.actions();
  const response = await fetch('/api/platform/actions', { credentials: 'include', signal });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw Error(body?.error || '读取动作清单失败');
  return body;
}

/** 定点获取当前授权的对象定义；不缓存权限、不把失败当成另一种存储。 */
export async function platformObjectDefinition(id: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`/api/platform/objects/${encodeURIComponent(id)}`, {credentials:'include', signal});
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw Object.assign(Error(body?.error || '读取数据表信息失败'), {status:response.status,code:body?.code});
  if (!body?.object || body.object.id !== id) throw Error('返回的对象定义与目标不一致');
  return body.object;
}
