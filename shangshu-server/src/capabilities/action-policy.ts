// 预置领域动作的授权与参数契约。各入口不能另设财务动作名单。
const finance = ['admin', 'finance'];
const business = ['admin', 'finance', 'manager'];
const all = [...business, 'staff'];
const str = { type: 'string', minLength: 1 };
const money = { type: 'number', exclusiveMinimum: 0, maximum: 90071992547409, multipleOf: 0.01 };
const taskFields = {
  title:{...str,title:'任务内容'}, assignee_id:{type:'string',title:'负责人账号'},
  priority:{type:'string',title:'优先级',enum:['高','中','低']}, project:{type:'string',title:'项目'},
  start_date:{type:'string',title:'开始日期'}, end_date:{type:'string',title:'截止日期'},
  status:{type:'string',title:'状态',enum:['待办','进行中','待验收','已完成','已取消']},
  pct:{type:'number',title:'进度',minimum:0,maximum:100}, result:{type:'string',title:'完成结果'},
};
const contracts: Record<string, { roles: string[]; properties?: Record<string, any>; required?: string[] }> = {
  'task.create': {roles:business,properties:taskFields,required:['title']},
  'task.update': {roles:all,properties:{id:str,expected_version:{type:'integer',minimum:1},...taskFields},required:['id']},
  'post.create': {roles:business,properties:{content:str},required:['content']},
  'post.claim': {roles:all,properties:{id:str},required:['id']},
  // 表格中心行内编辑（2026-08-28）：改任务帖内容/认领人/状态；帖子是「事」不是「账」，允许改
  'post.update': {roles:business,properties:{id:str,content:{...str,title:'任务内容'},assignee:{type:'string',title:'认领人'},status:{type:'string',title:'状态',enum:['待认领','已认领','已完成']}},required:['id']},
  'invoice.unbook': {roles:finance,properties:{invoice_id:str,reason:{...str,title:'纠错原因'}},required:['invoice_id','reason']},
  'cash.record': {roles:finance,properties:{direction:{type:'string',title:'收付方向',enum:['收款','付款']},amount:{...money,title:'金额（元）'},counterparty:{...str,title:'交易对方'},occurred_on:{type:'string',title:'收付款日期',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},account:{type:'string',title:'账户'},note:{type:'string',title:'说明'}},required:['direction','amount','counterparty','occurred_on']},
  'cash.reverse': {roles:finance,properties:{movement_id:str,reason:{...str,title:'纠错原因'}},required:['movement_id','reason']},
  'invoice.edit': { roles: finance, properties: { invoice_id: str, fields: {type:'object'} }, required: ['invoice_id','fields'] },
  'invoice.book': { roles: finance, properties: { invoice_id: str }, required: ['invoice_id'] },
  'invoice.approve': { roles: finance, properties: { invoice_id: str }, required: ['invoice_id'] },
  'invoice.reject': { roles: finance, properties: { invoice_id: str }, required: ['invoice_id'] },
  'ledger.post': { roles: finance, properties: { total_amount: money, direction: { enum: ['进项','出项'] } }, required: ['total_amount'] },
  'ledger.reverse': { roles: finance, properties: { ledger_id: str }, required: ['ledger_id'] },
  'receivable.pay': { roles: business, properties: { receivable_id: str, amount: money }, required: ['receivable_id','amount'] },
  'payable.pay': { roles: business, properties: { payable_id: str, amount: money }, required: ['payable_id','amount'] },
};
export function actionOptions(id: string) {
  const c = contracts[id] || { roles: /^(post|task|im|customer|product)\./.test(id) ? all : business };
  return { revision:3, roles: c.roles, inputSchema: { type: 'object', properties: c.properties || {}, required: c.required || [] } };
}
