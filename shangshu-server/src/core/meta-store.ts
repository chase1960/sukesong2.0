// 不可变 revision + active 指针。发布在事务中校验乐观版本，失败不污染运行态。
import { randomUUID, createHash } from 'node:crypto';
import type { StateStore } from './types.ts';
import { atomic } from './storage/transaction.ts';
import { clearObjectTypes, registerObjectType, getPresetObjectTypes, listObjectSummaries, getObjectType, objectInputSchema } from './objects.ts';
import { clearDocTypes, registerDocType, getPresetDocTypes, listDocTypes } from './doctypes.ts';
import { clearWorkflowTemplates, registerWorkflowTemplate, listWorkflowTemplates, validateWorkflow, capabilityIdsOf } from './workflow-engine.ts';
import { getPresetWorkflows } from '../flows/presets.ts';
import { validateSchema, assertSchema } from './action-contracts.ts';
import { getCapability } from './registry.ts';
import { currentActor } from './actor.ts';
import { appendEvent } from './events.ts';
export type MetaKind = 'object' | 'doctype' | 'flow';
export interface MetaRegistryRow { id:string; kind:MetaKind; key:string; payload:string; version:number; updated_at:string }
/** 元数据唯一读形状：UI / HTTP / AI 工具共用。payload 是定义本体，version 是 registry 乐观锁。 */
export interface MetaRecord { kind:MetaKind; key:string; payload:any; version:number; updated_at:string }
function loadPayload(kind:MetaKind,payload:any):void {
  if (kind==='object') registerObjectType(payload);
  else if(kind==='doctype') registerDocType(payload);
  else if(kind==='flow') registerWorkflowTemplate(payload);
  else throw new Error('未知元数据类型');
}
export function assertValidMetadata(kind:MetaKind,key:string,payload:any):void {
  if (!payload || payload.id !== key || !/^[a-z][a-z0-9_.-]*$/.test(key)) throw new Error('元数据 id 与 key 不一致或非法');
  if (kind==='object') {
    if (!/^[a-z][a-z0-9_]*$/.test(payload.layer || '') || !/^[a-z][a-z0-9_]*$/.test(payload.table || '') || !Array.isArray(payload.fields) || !Array.isArray(payload.actions)) throw new Error('对象缺少存储、字段或动作契约');
    if (!Array.isArray(payload.sampleFields) || !payload.sampleFields.every((v:unknown)=>typeof v==='string') || typeof payload.name!=='string') throw new Error('对象缺少名称或 sampleFields');
    const existing=getObjectType(key);
    const builtin=getPresetObjectTypes().find(object=>object.id===key);
    if(builtin ? payload.layer!==builtin.layer || payload.table!==builtin.table : payload.layer!=='custom') throw new Error('配置对象只能使用 custom 层或原有受保护领域表');
    if(payload.readRoles && (!Array.isArray(payload.readRoles) || !payload.readRoles.every((r:string)=>['admin','finance','manager','staff','service'].includes(r)))) throw new Error('readRoles 非法');
    if(existing && (existing.layer!==payload.layer || existing.table!==payload.table)) throw new Error('对象物理存储变更必须离线迁移，不能通过发布切换数据源');
    const names = new Set();
    for(const f of payload.fields) {
      if(!/^[a-z][a-z0-9_]*$/.test(f.id) || ['id','expected_version','updated_at'].includes(f.id) || names.has(f.id) || !['text','number','datetime','select','attachment'].includes(f.type)) throw new Error('对象字段非法、保留或重复');
      if(f.options && (!Array.isArray(f.options) || !f.options.every((v:unknown)=>typeof v==='string'))) throw new Error('选项必须是字符串列表');
      names.add(f.id);
    }
    if(payload.rowOwnerField && (typeof payload.rowOwnerField!=='string' || !names.has(payload.rowOwnerField))) throw new Error('rowOwnerField 必须引用已声明字段');
    for(const a of payload.actions) {
      if(typeof a.id!=='string' || !a.id.startsWith(key+'.') || !Array.isArray(a.roles) || !a.roles.length || !a.roles.every((r:string)=>['admin','finance','manager','staff'].includes(r)) || a.confirm !== true) throw new Error('动作须声明同对象 namespace、roles 与强制确认');
      if(a.operation && payload.layer !== 'custom') throw new Error('配置动作不能写系统对象');
      if(payload.layer==='custom' && !a.operation) throw new Error('扩展对象动作必须声明受管 operation');
      if(a.inputSchema) assertSchema(a.inputSchema);
      if(a.operation && !['create','update'].includes(a.operation)) throw new Error('不支持的配置动作');
      if(a.transition && (!Array.isArray(a.transition.from) || typeof a.transition.to !== 'string')) throw new Error('状态迁移契约无效');
    }
    assertSchema(objectInputSchema(payload));
  } else if(kind==='doctype') {
    const object=getObjectType(payload.objectId);
    if(!object || !Array.isArray(payload.fieldMappings) || !payload.intakeFlowId) throw new Error('单据模板引用对象不存在或缺少映射/流程');
    for(const mapping of payload.fieldMappings) if(!object.fields.some(f=>f.id===mapping.target)) throw new Error(`映射目标字段不存在: ${mapping.target}`);
  } else if(kind==='flow') {
    validateWorkflow(payload);
    for(const id of capabilityIdsOf(payload)) {
      const cap=getCapability(id);
      if(!cap.effect || ['internal','orchestrate'].includes(cap.effect)) throw new Error(`能力不允许进入流程: ${id}`);
    }
  } else throw new Error('未知元数据类型');
}
const hash=(payload:unknown)=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export async function createMetadataDraft(store:StateStore,kind:MetaKind,key:string,payload:unknown):Promise<string> {
  assertValidMetadata(kind,key,payload);
  const [active]=await store.query('cognition','meta_registry',{kind,key});
  return store.insert('cognition','meta_drafts',{kind,key,payload,base_version:active?.version || 0,status:'draft',author:currentActor()?.id || 'system:metadata',created_at:new Date().toISOString()});
}
export async function publishMetadataDraft(store:StateStore,id:string,expectedVersion:number):Promise<number> {
  let published:any; let kind:MetaKind;
  const version=await atomic(store,async tx=>{
    const [draft]=await tx.query('cognition','meta_drafts',{id});
    if(!draft || draft.status !== 'draft') throw new Error('草稿不存在或已发布');
    kind=draft.kind;
    assertValidMetadata(kind,draft.key,draft.payload);
    const [active]=await tx.query('cognition','meta_registry',{kind,key:draft.key});
    if((active?.version || 0)!==expectedVersion || draft.base_version!==expectedVersion) throw new Error('元数据版本冲突，请重新读取后发布');
    const revision=expectedVersion+1;
    published={...draft.payload,revision};
    if(kind==='object') published.actions = published.actions.map((a:any)=>({...a,revision}));
    await tx.insert('cognition','meta_revisions',{id:`${kind}:${draft.key}:${revision}`,kind,key:draft.key,version:revision,payload:published,hash:hash(published),created_at:new Date().toISOString()});
    const row={kind,key:draft.key,payload:JSON.stringify(published),version:revision,updated_at:new Date().toISOString()};
    if(active) await tx.update('cognition','meta_registry',active.id,row); else await tx.insert('cognition','meta_registry',row);
    await tx.update('cognition','meta_drafts',id,{status:'published'});
    await appendEvent(tx,{capability:'metadata.publish',entity_type:kind,entity_id:draft.key,payload:{revision,hash:hash(published)},status:'confirmed',initiator:currentActor()?.id || 'system:metadata'});
    return revision;
  });
  loadPayload(kind!,published);
  return version;
}
export async function upsertMetaEntry(store:StateStore,kind:MetaKind,key:string,payload:unknown,expectedVersion?:number):Promise<void> {
  const [active]=await store.query('cognition','meta_registry',{kind,key});
  const draft=await createMetadataDraft(store,kind,key,payload);
  await publishMetadataDraft(store,draft,expectedVersion ?? active?.version ?? 0);
}
export async function rollbackMetadata(store:StateStore,kind:MetaKind,key:string,revision:number,expectedVersion:number):Promise<void> {
  const [old]=await store.query('cognition','meta_revisions',{id:`${kind}:${key}:${revision}`});
  if(!old || old.hash!==hash(old.payload)) throw new Error('历史版本不存在或校验失败');
  // 回滚也是一次新发布；历史 revision 永远不改写。
  await upsertMetaEntry(store,kind,key,old.payload,expectedVersion);
}
export async function bootstrapMetadata(store:StateStore):Promise<{seeded:boolean;counts:Record<MetaKind,number>}> {
  let rows=await store.query('cognition','meta_registry');
  const seeded=!rows.length;
  const presetEntries=[...getPresetObjectTypes().map(payload=>({kind:'object' as MetaKind,payload})),...getPresetDocTypes().map(payload=>({kind:'doctype' as MetaKind,payload})),...getPresetWorkflows().map(payload=>({kind:'flow' as MetaKind,payload}))];
  if(seeded) {
    await atomic(store,async tx=>{
      // 并发启动只允许第一个事务种子写入。
      if((await tx.query('cognition','meta_registry')).length) return;
      for(const e of presetEntries) {
        const payload={...e.payload,revision:1};
        await tx.insert('cognition','meta_registry',{id:`${e.kind}:${payload.id}`,kind:e.kind,key:payload.id,payload:JSON.stringify(payload),version:1,updated_at:new Date().toISOString()});
        await tx.insert('cognition','meta_revisions',{id:`${e.kind}:${payload.id}:1`,kind:e.kind,key:payload.id,version:1,payload,hash:hash(payload)});
      }
    });
    rows=await store.query('cognition','meta_registry');
  }
  // 先完整解析，再替换运行态；损坏配置不允许静默跳过。
  let parsed=rows.map(row=>({kind:row.kind as MetaKind,payload:JSON.parse(row.payload)}));
  if(parsed.some(row=>row.kind==='flow' && row.payload.id==='flow.invoice-intake' && row.payload.steps?.some((step:any)=>!step.inputMap))) throw new Error('旧收票流程缺少显式映射，请备份后运行 npm run migrate:metadata -- --apply；禁止静默覆盖旧配置');
  for(const row of rows) {
    const [revision]=await store.query('cognition','meta_revisions',{id:`${row.kind}:${row.key}:${row.version}`});
    if(!revision) throw new Error('元数据缺少不可变版本，请备份后显式执行 migrate:metadata');
    if(revision.hash!==hash(revision.payload) || revision.hash!==hash(JSON.parse(row.payload))) throw new Error(`元数据 active 与发布版本不一致: ${row.kind}/${row.key}`);
  }
  // 新增预置自动补种（2026-08-28）：健康库（完整性校验已通过）才补代码升级携带的新预置键，
  // 只增不改、绝不触碰已有配置（「禁止静默覆盖/显式迁移优先」语义不变）。事务内复查，双实例并发也只补一次。
  if(!seeded) {
    const have=new Set(rows.map(r=>`${r.kind}:${r.key}`));
    const missing=presetEntries.filter(e=>!have.has(`${e.kind}:${e.payload.id}`));
    if(missing.length) {
      await atomic(store,async tx=>{
        for(const e of missing) {
          if((await tx.query('cognition','meta_registry',{kind:e.kind,key:e.payload.id})).length) continue;
          const payload={...e.payload,revision:1};
          await tx.insert('cognition','meta_registry',{id:`${e.kind}:${payload.id}`,kind:e.kind,key:payload.id,payload:JSON.stringify(payload),version:1,updated_at:new Date().toISOString()});
          await tx.insert('cognition','meta_revisions',{id:`${e.kind}:${payload.id}:1`,kind:e.kind,key:payload.id,version:1,payload,hash:hash(payload)});
        }
      });
      rows=await store.query('cognition','meta_registry');
      // 补种后重算加载清单：否则新预置进了注册表、运行态仍用旧快照（「注册表有、运行时没有」的错位）
      parsed=rows.map(row=>({kind:row.kind as MetaKind,payload:JSON.parse(row.payload)}));
    }
  }
  clearObjectTypes();clearDocTypes();clearWorkflowTemplates();
  for(const kind of ['object','doctype','flow'] as MetaKind[]) for(const row of parsed.filter(r=>r.kind===kind)) loadPayload(kind,row.payload);
  return {seeded,counts:{object:listObjectSummaries().length,doctype:listDocTypes().length,flow:listWorkflowTemplates().length}};
}
export function listMetadataOverview() { return {objects:listObjectSummaries(),doctypes:listDocTypes(),flows:listWorkflowTemplates(),source:'cognition.meta_registry'}; }
export async function getMetaRecord(store:StateStore,kind:MetaKind,key:string):Promise<MetaRecord|null> {
  const [row]=await store.query('cognition','meta_registry',{kind,key});
  if(!row) return null;
  return {kind,key,payload:JSON.parse(row.payload),version:Number(row.version)||0,updated_at:String(row.updated_at||'')};
}
/** @deprecated 请用 getMetaRecord；仅返回 payload 本体，不含 version。 */
export async function getMetaEntry(store:StateStore,kind:MetaKind,key:string):Promise<unknown|null> {
  const rec=await getMetaRecord(store,kind,key);
  return rec ? rec.payload : null;
}
