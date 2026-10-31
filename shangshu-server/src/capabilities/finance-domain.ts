// 财务领域：入账、债权债务、实际收付款是不同事实，不用发票金额冒充现金流。
import type {StateStore} from '../core/types.ts';
import type {ActionExecutionContext} from '../core/action-contracts.ts';

export function businessDate(date=new Date()):string {return new Intl.DateTimeFormat('sv-SE',{timeZone:process.env.SS_TIMEZONE || 'Asia/Shanghai'}).format(date);}
export function validDate(value:unknown):string {
  const s=String(value || businessDate());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10)!==s) throw new Error('业务日期无效，需 YYYY-MM-DD');
  return s;
}
export function minor(value:unknown):number {
  const n=Number(value), cents=Math.round(n*100);
  if(!Number.isFinite(n) || !Number.isSafeInteger(cents) || Math.abs(n*100-cents)>0.00001) throw new Error('金额必须为有效的两位小数');
  return cents;
}
export async function cashSummary(store:StateStore,input:Record<string,any>={}) {
  const today=businessDate(),from=validDate(input.date_from || today.slice(0,7)+'-01'),to=validDate(input.date_to || today);
  if(from>to) throw new Error('开始日期不能晚于结束日期');
  const [movements,receivables,payables]=await Promise.all([store.query('business','cash_movements'),store.query('business','receivables'),store.query('business','payables')]);
  const list=movements.filter(row=>{const date=String(row.occurred_on || row.created_at || '').slice(0,10);return date>=from && date<=to;});
  let received=0,paid=0;
  for(const row of list) {
    const direction=row.direction || (row.entity_type==='receivable'?'收款':row.entity_type==='payable'?'付款':'');
    if(direction==='收款') received+=Number(row.amount_minor);else if(direction==='付款') paid+=Number(row.amount_minor);
  }
  const warnings:string[]=[];
  const settledByBill=new Map<string,number>();
  for(const m of movements) {const key=m.entity_type+':'+m.entity_id;settledByBill.set(key,(settledByBill.get(key) || 0)+Number(m.amount_minor));}
  for(const [type,rows,field] of [['receivable',receivables,'received'],['payable',payables,'paid']] as const) {
    if(rows.some(row=>minor(row[field] || 0)!==minor(row.opening_settled || 0)+(settledByBill.get(type+':'+row.id) || 0))) warnings.push(`${type==='receivable'?'应收':'应付'}存在历史累计值未匹配流水，不能推定其到账日期；请核对期初数据`);
  }
  return {period:{from,to},received:received/100,paid:paid/100,net:(received-paid)/100,
    unreceived:receivables.reduce((s,r)=>s+minor(r.amount || 0)-minor(r.received || 0),0)/100,
    unpaid:payables.reduce((s,r)=>s+minor(r.amount || 0)-minor(r.paid || 0),0)/100,
    entry_count:list.length,basis:'cash_movements',warnings};
}

export async function registerPayment(type:'receivable'|'payable',payload:Record<string,any>,ctx:ActionExecutionContext):Promise<void> {
  const table=type==='receivable'?'receivables':'payables',field=type==='receivable'?'received':'paid';
  const id=String(payload[`${type}_id`] || '');
  const [bill]=await ctx.store.query('business',table,{id});
  if(!bill || bill.status==='已撤销') throw new Error('台账不存在或已撤销');
  const amount=minor(payload.amount),settled=minor(bill[field] || 0),total=minor(bill.amount);
  if(amount<=0 || amount>total-settled) throw new Error(`收付款金额超出余额或无效（剩余 ${(total-settled)/100}）`);
  await ctx.store.insert('business','cash_movements',{id:ctx.executionId,execution_id:ctx.executionId,entity_type:type,entity_id:id,
    direction:type==='receivable'?'收款':'付款',counterparty:bill.customer_name || bill.supplier || '',amount_minor:amount,
    balance_before_minor:settled,occurred_on:validDate(payload.occurred_on),account:String(payload.account || ''),note:String(payload.note || ''),created_at:new Date().toISOString(),actor:ctx.actor.id});
  const value=(settled+amount)/100;
  await ctx.store.update('business',table,id,{[field]:value,status:settled+amount===total?(type==='receivable'?'已收':'已付'):(type==='receivable'?'部分已收':'部分已付')});
}

export async function reversePayment(payload:Record<string,any>,ctx:ActionExecutionContext):Promise<string> {
  const [original]=await ctx.store.query('business','cash_movements',{id:String(payload.movement_id)});
  if(!original || original.amount_minor<=0 || original.reversal_of) throw new Error('仅正向收付款登记可冲回');
  if((await ctx.store.query('business','cash_movements',{reversal_of:original.id})).length) throw new Error('该收付款已冲回');
  if(!String(payload.reason || '').trim()) throw new Error('冲回必须说明登记错误原因；实际退款应另行登记');
  if(['receivable','payable'].includes(original.entity_type)) {
    const type=original.entity_type,table=type==='receivable'?'receivables':'payables',field=type==='receivable'?'received':'paid';
    const [bill]=await ctx.store.query('business',table,{id:original.entity_id});
    if(!bill || minor(bill[field] || 0)<original.amount_minor) throw new Error('累计金额与流水不一致，不能冲回');
    const amount=minor(bill[field])-original.amount_minor;
    await ctx.store.update('business',table,bill.id,{[field]:amount/100,status:amount===0?(type==='receivable'?'未收':'未付'):(type==='receivable'?'部分已收':'部分已付')});
  }
  return ctx.store.insert('business','cash_movements',{id:ctx.executionId,execution_id:ctx.executionId,entity_type:original.entity_type,entity_id:original.entity_id,
    direction:original.direction || (original.entity_type==='receivable'?'收款':'付款'),counterparty:original.counterparty || '',amount_minor:-original.amount_minor,
    reversal_of:original.id,occurred_on:original.occurred_on || String(original.created_at).slice(0,10),account:original.account || '',note:payload.reason,created_at:new Date().toISOString(),actor:ctx.actor.id});
}

export async function reverseLedger(payload:Record<string,any>,ctx:ActionExecutionContext):Promise<string> {
  const [rec]=await ctx.store.query('business','ledger',{id:String(payload.ledger_id)});
  if(!rec || !(Number(rec.total_amount)>0)) throw new Error('仅正金额原记录可红冲');
  const all=await ctx.store.query('business','ledger');
  if(all.some(row=>row.reverses_entry_id===rec.id || String(row.note || '').includes(`红冲原记录 ${rec.id}`))) throw new Error('该记录已被红冲过');
  const invoices=await ctx.store.query('business','invoices',{ledger_record_id:rec.id});
  if(rec.invoice_id && !invoices.length) throw new Error('发票关联状态不一致，需先核对');
  for(const invoice of invoices) {
    for(const [table,field] of [['receivables','received'],['payables','paid']]) {
      for(const bill of await ctx.store.query('business',table,{invoice_id:invoice.id})) {
        if(bill.status==='已撤销') continue;
        if(Number(bill[field])!==0 || bill.order_id || bill.purchase_id) throw new Error('关联台账已有收付款或订单关联，请先核对并冲回错误登记；实际退款不能用撤回入账代替');
        await ctx.store.update('business',table,bill.id,{original_amount:bill.amount,amount:0,status:'已撤销',reversed_by:ctx.executionId});
      }
    }
    await ctx.store.update('business','invoices',invoice.id,{status:'已入库',ledger_record_id:null,booking_cycle:Number(invoice.booking_cycle || 0)+1,last_reversal_id:ctx.executionId});
  }
  return ctx.store.insert('business','ledger',{...Object.fromEntries(['direction','counterparty','category','account_subject','project_id'].map(key=>[key,rec[key] || ''])),
    source_key:`reversal:${rec.id}`,execution_id:ctx.executionId,reverses_entry_id:rec.id,invoice_id:rec.invoice_id || '',
    summary:`红冲：${rec.summary || ''}`,posted_at:new Date().toISOString(),biz_date:businessDate(),
    amount_ex_tax:-Math.abs(Number(rec.amount_ex_tax) || 0),tax_amount:-Math.abs(Number(rec.tax_amount) || 0),total_amount:-Number(rec.total_amount),maker:ctx.actor.id,note:`红冲原记录 ${rec.id}；${payload.reason || '账务纠错'}`});
}
