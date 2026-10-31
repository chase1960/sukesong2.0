// 发票受控可修正字段；状态、入账关联和审计字段不接受任意 PATCH。
import { validateSchema } from '../core/action-contracts.ts';
const text=['invoice_code','invoice_no','invoice_type','invoice_direction','seller_name','buyer_name','issued_at','check_code','customer_id','project_id','supplier','review_note'];
export function validateInvoicePatch(fields:Record<string,unknown>):Record<string,unknown> {
  validateSchema({type:'object',additionalProperties:false,properties:{
    ...Object.fromEntries(text.map(key=>[key,{type:'string'}])),
    amount_ex_tax:{type:'number'},tax_amount:{type:'number'},total_amount:{type:'number',exclusiveMinimum:0},
  }},fields);
  return fields;
}
