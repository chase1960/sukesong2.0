// 业务数据交换：预览持久化、明确期初边界、确认时复验、同事务整批落库。
import {createHash} from 'node:crypto';
import type {StateStore} from '../core/types.ts';
import {registerActionContract} from '../core/action-contracts.ts';
import {minor,validDate} from './finance-domain.ts';
export const importColumns:Record<string,string[]>={
  customers:['external_key','name','kind','phone'],
  receivables:['external_key','party_key','amount','settled','as_of','due_date'],
  payables:['external_key','party_key','amount','settled','as_of','due_date'],
};
export function parseCSV(text:string):string[][] {
  if(Buffer.byteLength(text)>1024*1024) throw new Error('CSV 不得超过 1MB');
  text=text.replace(/^\uFEFF/,'');
  const rows:string[][]=[];let row:string[]=[],value='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {if(c==='"') {if(text[i+1]==='"') {value+='"';i++;}else {quoted=false;closed=true;}}else value+=c;continue;}
    if(c==='"') {if(value || closed) throw new Error('CSV 引号格式错误');quoted=true;}
    else if(c===',' || c==='\n' || c==='\r') {
      row.push(value);value='';closed=false;
      if(c!==',') {if(c==='\r' && text[i+1]==='\n') i++;if(row.some(v=>v!=='')) rows.push(row);row=[];}
    } else {if(closed) throw new Error('CSV 引号后只能为分隔符');value+=c;}
  }
  if(quoted) throw new Error('CSV 引号未闭合');
  if(value || row.length || closed) {row.push(value);rows.push(row);}
  if(rows.length>1001) throw new Error('单次最多导入 1000 行');return rows;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function validateRows(store:StateStore,kind:string,rows:Record<string,string>[]) {
  const existing=await store.query('business',kind),parties=await store.query('business','customers');
  const keys=new Set<string>(),names=new Set<string>();const errors:string[]=[];const records:any[]=[];
  for(const [index,row] of rows.entries()) try {
    if(!row.external_key || row.external_key.length>120) throw new Error('external_key 必填，最多 120 字');
    if(keys.has(row.external_key) || existing.some(r=>r.external_key===row.external_key)) throw new Error('外部编号重复或已导入');
    keys.add(row.external_key);
    if(kind==='customers') {
      if(!row.name || row.name.length>200) throw new Error('名称必填，最多 200 字');
      if(!['客户','供应商','往来单位'].includes(row.kind)) throw new Error('kind 应为客户 / 供应商 / 往来单位');
      if(names.has(row.name) || existing.some(r=>r.name===row.name)) throw new Error('同名往来单位需人工合并，不能重复导入');
      names.add(row.name);records.push({...row,status:'合作中'});
    } else {
      const matches=parties.filter(p=>p.external_key===row.party_key);
      if(matches.length!==1) throw new Error('party_key 未唯一匹配已导入的往来单位');
      const amount=minor(row.amount),settled=minor(row.settled || 0);
      if(amount<=0 || settled<0 || settled>amount) throw new Error('金额必须为正且期初已结金额在 0 与金额之间');
      if(!row.as_of) throw new Error('as_of 期初日期必填');
      const as_of=validDate(row.as_of),due_date=row.due_date?validDate(row.due_date):'';
      const recv=kind==='receivables';
      records.push({external_key:row.external_key,source:'期初导入',as_of,due_date,amount:amount/100,opening_settled:settled/100,
        [recv?'received':'paid']:settled/100,...(recv?{customer_id:matches[0].id,customer_name:matches[0].name}:{supplier_id:matches[0].id,supplier:matches[0].name}),
        status:settled===amount?(recv?'已收':'已付'):settled>0?(recv?'部分已收':'部分已付'):(recv?'未收':'未付')});
    }
  } catch(error) {errors.push(`第 ${index+2} 行：${(error as Error).message}`);}
  return {records,errors};
}
export async function previewImport(store:StateStore,kind:string,csv:string,actor:string) {
  const columns=Object.hasOwn(importColumns,kind)?importColumns[kind]:null;if(!columns) throw new Error('不支持的导入类型');
  const [header,...values]=parseCSV(csv);
  if(!header || header.join(',')!==columns.join(',')) throw new Error(`列名及顺序应为：${columns.join(',')}`);
  if(!values.length) throw new Error('没有数据行');
  const rows=values.map((cells,i)=>{if(cells.length!==columns.length) throw new Error(`第 ${i+2} 行列数错误`);return Object.fromEntries(columns.map((key,j)=>[key,cells[j].trim()]));});
  const result=await validateRows(store,kind,rows);
  if(result.errors.length) return {ok:false,...result,records:undefined};
  const hash=digest({kind,rows}),id=await store.insert('execution','import_previews',{kind,rows,hash,actor,status:'preview',created_at:new Date().toISOString()});
  return {ok:true,id,hash,count:rows.length,sample:result.records.slice(0,10),notice:'期初累计不生成实际收付款流水；整批确认后导入。'};
}
export function registerBusinessTransfer():void {
  registerActionContract({id:'data.import',revision:1,roles:['admin','finance'],confirmation:'human',inputSchema:{type:'object',additionalProperties:false,required:['preview_id'],properties:{preview_id:{type:'string',minLength:1}}},
    execute:async(payload,ctx)=>{
      const [preview]=await ctx.store.query('execution','import_previews',{id:payload.preview_id});
      if(!preview || preview.actor!==ctx.actor.id) throw new Error('导入预览不存在或不属于当前账号');
      if(preview.status==='applied') return preview.id;
      if(Date.now()-Date.parse(preview.created_at)>86400000) throw new Error('预览超过 24 小时，请重新上传');
      if(digest({kind:preview.kind,rows:preview.rows})!==preview.hash) throw new Error('预览数据校验失败');
      const {records,errors}=await validateRows(ctx.store,preview.kind,preview.rows);
      if(errors.length) throw new Error(errors.join('\n'));
      for(const record of records) await ctx.store.insert('business',preview.kind,{...record,import_batch:preview.id,created_at:new Date().toISOString()});
      await ctx.store.update('execution','import_previews',preview.id,{status:'applied',execution_id:ctx.executionId,applied_at:new Date().toISOString()});return preview.id;
    }},{replace:true});
}
export const exportColumns:Record<string,string[]>={...importColumns,
  receivables:['id','external_key','customer_name','amount','received','opening_settled','as_of','due_date','status'],
  payables:['id','external_key','supplier','amount','paid','opening_settled','as_of','due_date','status'],
  ledger:['id','biz_date','direction','counterparty','total_amount','summary','reverses_entry_id'],
  cash_movements:['id','occurred_on','direction','counterparty','amount_minor','account','note','reversal_of'],
};
export function encodeCSV(rows:any[],columns:string[]):string {
  const cell=(value:any)=>{let s=String(value??'');if(typeof value!=='number' && /^[\s]*[=+@-]/.test(s)) s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\uFEFF'+[columns,...rows.map(row=>columns.map(c=>row[c]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
