// 预置办事流程（小微收票等）；M4 演进为可编辑持久化配置。
// 2026-08-28 新增图流程（graph 节点+边）：费用报销双审演示。
import { registerWorkflowTemplate, type WorkflowTemplate } from '../core/workflow-engine.ts';

export function getPresetWorkflows(): WorkflowTemplate[] {
  return [{
    id: 'flow.invoice-intake',
    name: '收票入库',
    description: '上传/邮件附件 → 按路径逐步抽取（text-rule → text-llm → vision）→ 待审入库',
    doctype: 'invoice_cn_vat',
    revision: 2,
    inputSchema: { type:'object', properties:{file_token:{type:'string'},item:{type:'object'}}, required:['file_token','item'] },
    resultMap: {status:'$steps.file.status',invoice_id:'$steps.file.invoice_id',fields:{$coalesce:['steps.extract_text_rule.fields','steps.extract_text_llm.fields','steps.extract_vision.fields']},extraction_path:{$coalesce:['steps.extract_text_rule.extraction_path','steps.extract_text_llm.extraction_path','steps.extract_vision.extraction_path']}},
    steps: [
      {
        id: 'extract_text_rule',
        inputMap: {file_token:'$input.file_token',doctype:'$input.doctype'},
        name: 'PDF 文字层解析',
        capability: 'extract.text_rule',
        strategy: 'fixed',
        optional: true,
        note: '数电发票 PDF 文字层；无匹配则继续下一步',
      },
      {
        when: {missing:['steps.extract_text_rule']},
        id: 'extract_text_llm',
        inputMap: {file_token:'$input.file_token',doctype:'$input.doctype'},
        name: '文字层模型结构化',
        capability: 'extract.text_llm',
        strategy: 'fixed',
        optional: true,
        note: '有文字层但版式规则未命中时',
      },
      {
        when: {missing:['steps.extract_text_rule','steps.extract_text_llm']},
        id: 'extract_vision',
        inputMap: {file_token:'$input.file_token',doctype:'$input.doctype'},
        name: '多模态看图',
        capability: 'extract.vision',
        strategy: 'fixed',
        optional: true,
        note: '扫描件/照片兜底',
      },
      {
        id: 'file',
        inputMap: {item:'$input.item',extract:{$coalesce:['steps.extract_text_rule','steps.extract_text_llm','steps.extract_vision']},skip_auto_book:true},
        name: '去重待审入库',
        capability: 'invoice.file',
        strategy: 'fixed',
        note: '写入 business.invoices 待审；入库/入账经确认卡',
      },
    ],
  }, {
    // 图流程演示（2026-08-28）：双审（财务→老板）+ 拒绝/超时路径 + 通过后起草入账提案（仍走确认卡）
    id: 'flow.expense-approval',
    name: '费用报销审批',
    description: '提交 → 财务审 → 老板终审（串行两次）；通过自动起草入账提案（确认卡）；拒绝/超时走驳回终点',
    revision: 1,
    inputSchema: { type:'object', properties:{ summary:{type:'string',minLength:1,title:'事由'}, amount:{type:'number',exclusiveMinimum:0,title:'金额'}, direction:{type:'string',enum:['进项','出项'],title:'方向'}, counterparty:{type:'string',title:'收款/付款对象'} }, required:['summary','amount','direction'] },
    steps: [],
    graph: {
      start: 'submit',
      nodes: [
        { id:'submit', kind:'capability', name:'记录申请', capability:'flow.note', inputMap:{ note:'$input.summary' }, ui:{x:60,y:150} },
        { id:'fin_review', kind:'approval', name:'财务审核', approval:{ roles:['finance'], mode:'serial', timeout_hours:48 }, ui:{x:270,y:150} },
        { id:'boss_review', kind:'approval', name:'老板终审', approval:{ roles:['admin'], mode:'serial', timeout_hours:48 }, ui:{x:480,y:150} },
        { id:'draft_post', kind:'capability', name:'起草入账提案', capability:'object.propose', inputMap:{ object:'ledger', action:'ledger.post', data:{ summary:'$input.summary', total_amount:'$input.amount', direction:'$input.direction', counterparty:{$coalesce:['$input.counterparty','内部报销']} } }, ui:{x:690,y:80} },
        { id:'finish_ok', kind:'capability', name:'通过归档', capability:'flow.note', inputMap:{ note:'报销通过；入账提案已生成待确认' }, ui:{x:900,y:80} },
        { id:'rejected_end', kind:'capability', name:'驳回归档', capability:'flow.note', inputMap:{ note:'报销被拒绝或超时' }, ui:{x:690,y:260} },
      ],
      edges: [
        { from:'submit', to:'fin_review' },
        { from:'fin_review', to:'boss_review', kind:'success' },
        { from:'fin_review', to:'rejected_end', kind:'rejected', label:'拒绝' },
        { from:'fin_review', to:'rejected_end', kind:'timeout', label:'超时' },
        { from:'boss_review', to:'draft_post', kind:'success' },
        { from:'boss_review', to:'rejected_end', kind:'rejected', label:'拒绝' },
        { from:'boss_review', to:'rejected_end', kind:'timeout', label:'超时' },
        { from:'draft_post', to:'finish_ok' },
      ],
    },
  }, {
    // 项目管理域样例（2026-08-29）：验证「发布 → 发起 → 审批 → 完成」最小闭环。
    // 写任务状态仍走 object.propose 确认卡；本流程只编排验收节奏，不直写业务表。
    id: 'flow.task-acceptance',
    name: '任务验收',
    description: '提交验收 → 经理审；通过归档，拒绝/超时退回。可在画布上改节点后重新发布。',
    revision: 1,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, title: '任务' },
        result: { type: 'string', title: '验收说明' },
      },
      required: ['title'],
    },
    steps: [],
    graph: {
      start: 'submit',
      nodes: [
        { id: 'submit', kind: 'capability', name: '提交验收', capability: 'flow.note', inputMap: { note: '$input.title' }, ui: { x: 60, y: 140 } },
        { id: 'mgr_review', kind: 'approval', name: '经理验收', approval: { roles: ['manager'], mode: 'any', timeout_hours: 72 }, ui: { x: 280, y: 140 } },
        { id: 'finish_ok', kind: 'capability', name: '验收通过', capability: 'flow.note', inputMap: { note: '任务验收通过' }, ui: { x: 520, y: 80 } },
        { id: 'rejected_end', kind: 'capability', name: '退回修改', capability: 'flow.note', inputMap: { note: '验收未通过，退回修改' }, ui: { x: 520, y: 220 } },
      ],
      edges: [
        { from: 'submit', to: 'mgr_review' },
        { from: 'mgr_review', to: 'finish_ok', kind: 'success' },
        { from: 'mgr_review', to: 'rejected_end', kind: 'rejected', label: '退回' },
        { from: 'mgr_review', to: 'rejected_end', kind: 'timeout', label: '超时' },
      ],
    },
  }];
}

export function registerPresetWorkflows(): void {
  for (const t of getPresetWorkflows()) registerWorkflowTemplate(t);
}
