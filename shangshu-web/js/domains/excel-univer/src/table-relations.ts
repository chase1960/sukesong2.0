import {ApiError,newIdempotencyKey} from './api';

export interface RelationDefinition {
 table?:string; header:string; target_table?:string; target_header?:string; revision:number;status?:'unavailable';
}
export interface RelationValue {
 row_id:string; header:string; status:'linked'|'empty'|'unavailable'; value?:unknown;
 target?:{table:string;row_id:string;header:string}; direct_target?:{table:string;row_id:string;header:string}; source_version?:string; relation_revision?:number;
}
export interface RelationSnapshot {table:string;definitions:RelationDefinition[];values:RelationValue[]}

async function invoke<T>(kind:'actions'|'services',name:string,payload:unknown,key?:string):Promise<T>{
 const response=await fetch(`/api/platform/${kind}/${name}/${kind==='actions'?'execute':'invoke'}`,{
  method:'POST',credentials:'include',headers:{'content-type':'application/json'},
  body:JSON.stringify(kind==='actions'?{payload,confirmed:true,idempotency_key:key,source:'user'}:{payload}),
 });
 let body:any;try{body=await response.json();}catch{throw new ApiError(response.status,'invalid_receipt','服务未返回有效回执，请刷新核对后再操作');}
 if(!response.ok||body?.ok===false||body?.receipt?.status==='failed')
  throw new ApiError(response.status,body?.code||'relation_failed',body?.error||body?.message||body?.receipt?.failure_reason||'关联操作失败');
 const result=body?.result??body?.receipt?.result??(kind==='services'&&body?.ok===true?body:undefined);
 if(result===undefined)throw new ApiError(response.status,'missing_receipt','关联回执缺少结果，请刷新核对');
 if(result?.applied===false||result?.fatal===true)throw new ApiError(response.status,'not_applied',result.error||result.message||'关联操作未生效，请核对后重试');
 return result as T;
}

export function readRelations(table:string,rowIds?:string[]):Promise<RelationSnapshot>{
 return invoke('services','files.table_relation_read',{table,...(rowIds?{row_ids:rowIds}:{})});
}
// The caller retains this command on an uncertain response. Retry sends the same
// immutable payload and key; refreshing a revision must create a new command.
export function relationCommand<T>(name:'define'|'set'|'remove',payload:Record<string,unknown>){
 const frozen=JSON.parse(JSON.stringify(payload));const key=newIdempotencyKey();
 return {key,execute:()=>invoke<T>('actions',`files.table_relation_${name}`,frozen,key)};
}

/**
 * 关联目标的候选项。
 *
 * FIX-17（2026-10-19 实测）：以前下拉里把业务对象（现存库存/订单/发票/我的邮件…）
 * 也列成目标表，用户一点就撞上英文内部权限错误
 * 「does not have doctype access via role permission」。
 * 业务对象既没有关联目标工作簿，也不是 Excel 表 —— **不能当关联目标**，
 * 所以这里只留 Excel 表格（xlsx）。
 */
export function relationTargetChoices(entries:Array<{key:string;title:string;kind:string}>):Array<{id:string;label:string}>{
  return entries.filter(entry=>entry.kind==='xlsx').map(entry=>({id:entry.key,label:entry.title}));
}

/**
 * 把服务端错误翻成人能懂的中文。
 * 内部英文错误（权限/工作簿未配置）不许外露给用户；
 * 已经是中文的提示原样保留。
 */
export function relationErrorText(message:unknown):string{
  const text=String((message as Error)?.message??message??'').trim();
  if(!text)return '操作没有完成，请重试';
  if(/does not have doctype access via role permission/i.test(text))return '你没有读这张表的权限，换一张你有权的表再试';
  if(/has no permission to access|not permitted|PermissionError/i.test(text))return '当前身份没有这张表的权限';
  if(/Target workbook is not configured/i.test(text))return '这张表还没有配置关联目标工作簿，请先配置后再关联';
  if(/not found|DoesNotExist/i.test(text))return '找不到这张表，可能已被删除或改名';
  return text;
}
