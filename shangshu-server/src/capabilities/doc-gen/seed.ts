// 银聆法律文书内置示例：启动时写入模板集 + 6 种文档类型
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../../core/types.ts';
import { DocGenService } from './service.ts';
import type { FieldSchema } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', '..', '..', 'data', 'templates', 'yinling');

// ── 模板元数据 ──────────────────────────────────────

interface TemplateMeta {
  doc_key: string;
  name: string;
  description: string;
  file: string;
  schema: FieldSchema;
}

const TEMPLATES: TemplateMeta[] = [
  {
    doc_key: 'requirements',
    name: '需求确认书',
    description: '项目需求范围、功能清单、验收标准、交付与排除、假设与风险',
    file: '需求确认书_template.docx',
    schema: {
      groups: [
        { key: 'meta', label: '元信息' },
        { key: 'overview', label: '项目概述' },
        { key: 'process', label: '业务流程' },
        { key: 'roles', label: '角色与权限' },
        { key: 'functional', label: '功能需求' },
        { key: 'docs', label: '核心单据' },
        { key: 'nfr', label: '非功能需求' },
        { key: 'delivery', label: '交付与排除' },
        { key: 'risk', label: '假设与风险' },
        { key: 'appendix', label: '附录' },
      ],
      fields: [
        { key: 'project_name', label: '项目名称', type: 'text', required: true, group: 'meta', placeholder: '外贸多工厂管理系统' },
        { key: 'doc_version', label: '文档版本', type: 'text', required: true, group: 'meta', placeholder: 'V1.2' },
        { key: 'issue_date', label: '发布日期', type: 'date', required: true, group: 'meta' },
        { key: 'doc_scope', label: '文档范围', type: 'textarea', required: true, group: 'meta', help_text: '一句话描述文档覆盖的业务范围' },
        { key: 'project_background', label: '项目背景', type: 'textarea', required: true, group: 'overview', help_text: '甲方现状和痛点' },
        { key: 'project_goals', label: '项目目标', type: 'textarea', required: true, group: 'overview', help_text: '每条以（一）开头' },
        { key: 'system_constraints', label: '系统约束', type: 'textarea', required: false, group: 'overview', help_text: '技术和业务约束' },
        { key: 'business_processes', label: '业务流程', type: 'textarea', required: true, group: 'process', help_text: '分阶段写：流程总览 → 各阶段详细流程' },
        { key: 'roles_and_permissions', label: '角色与权限', type: 'textarea', required: true, group: 'roles', help_text: '表格：| 编号 | 角色 | 类型 | 主要职责 |' },
        { key: 'permissions_principles', label: '权限原则', type: 'textarea', required: false, group: 'roles', help_text: '数据隔离和审批规则' },
        { key: 'functional_requirements', label: '功能需求', type: 'textarea', required: true, group: 'functional', help_text: '每条用 ### FR-xx 标题格式' },
        { key: 'terminology', label: '术语定义', type: 'textarea', required: false, group: 'docs', help_text: '表格：| 术语 | 定义 |' },
        { key: 'doc_dictionary', label: '单据字段字典', type: 'textarea', required: false, group: 'docs', help_text: '表格：| 单据名 | 关键字段 | 编号规则 |' },
        { key: 'nfr', label: '非功能需求', type: 'textarea', required: false, group: 'nfr', help_text: '表格：| NFR-xx | 类别 | 要求 |' },
        { key: 'delivery_form', label: '交付形态', type: 'text', required: true, group: 'delivery', placeholder: '浏览器访问的Web系统+部署上线+分角色培训+6个月质保' },
        { key: 'warranty_period', label: '质保月数', type: 'number', required: true, group: 'delivery', help_text: '合同引用此值', placeholder: '6' },
        { key: 'exclusions', label: '排除范围', type: 'textarea', required: false, group: 'delivery', help_text: '一期不做哪些功能' },
        { key: 'party_a_materials', label: '甲方需提供资料', type: 'textarea', required: false, group: 'delivery' },
        { key: 'extension', label: '扩展预留', type: 'textarea', required: false, group: 'delivery', help_text: '分期实施策略' },
        { key: 'assumptions_and_dependencies', label: '假设清单', type: 'textarea', required: false, group: 'risk', help_text: '表格：| A1 | 假设内容 | 若不成立的影响 |' },
        { key: 'external_dependencies', label: '外部依赖', type: 'textarea', required: false, group: 'risk' },
        { key: 'risk_and_change', label: '风险登记', type: 'textarea', required: false, group: 'risk', help_text: '表格：| 风险 | 概率 | 影响 | 缓解措施 |' },
        { key: 'appendix', label: '附录', type: 'textarea', required: false, group: 'appendix', help_text: '需求跟踪表+版本历史' },
      ],
    },
  },
  {
    doc_key: 'schedule',
    name: '排期表',
    description: '项目工期、里程碑、阶段确认、报价引用',
    file: '排期表_template.docx',
    schema: {
      groups: [
        { key: 'meta', label: '元信息' },
        { key: 'commercial', label: '商务' },
        { key: 'timeline', label: '工期' },
        { key: 'milestones', label: '里程碑' },
      ],
      fields: [
        { key: 'doc_version', label: '文档版本', type: 'text', required: true, group: 'meta', placeholder: 'V1.0' },
        { key: 'issue_date', label: '发布日期', type: 'date', required: true, group: 'meta' },
        { key: '第几版', label: '需求确认书版本', type: 'text', required: true, group: 'meta', help_text: '引用的需求确认书版本' },
        { key: 'quote_amount', label: '报价金额', type: 'text', required: true, group: 'commercial', placeholder: '人民币80000元（含税）' },
        { key: 'project_duration', label: '建设工期', type: 'text', required: true, group: 'timeline', placeholder: '30个工作日' },
        { key: 'delivery_form', label: '交付形态', type: 'text', required: true, group: 'timeline', help_text: '从需求确认书取' },
        { key: 'schedule', label: '工期天数', type: 'number', required: true, group: 'timeline', help_text: '合同引用此值', placeholder: '30' },
        { key: '补充', label: '排期补充', type: 'textarea', required: false, group: 'timeline', help_text: '补充假设' },
        { key: '其他', label: '其他约定', type: 'textarea', required: false, group: 'timeline' },
        { key: 'milestones', label: '里程碑', type: 'table', required: true, group: 'milestones', columns: ['周期', '里程碑名', '交付物', '甲方配合资料'] },
        { key: 'phase_confirmations', label: '阶段确认', type: 'table', required: true, group: 'milestones', columns: ['时间', '交付物', '甲方签名', '乙方签名'] },
      ],
    },
  },
  {
    doc_key: 'contract',
    name: '合同',
    description: '甲乙方信息、项目范围、金额、付款方式、交付、可选条款',
    file: '合同_template.docx',
    schema: {
      groups: [
        { key: 'parties', label: '甲乙方信息' },
        { key: 'project', label: '项目信息' },
        { key: 'amount', label: '金额' },
        { key: 'payment', label: '付款方式' },
        { key: 'delivery', label: '交付' },
        { key: 'optional', label: '可选条款' },
      ],
      fields: [
        { key: 'party_a_name', label: '甲方名称', type: 'text', required: true, group: 'parties', placeholder: '南京农业大学信息学院' },
        { key: 'party_a_address', label: '甲方地址', type: 'text', required: true, group: 'parties' },
        { key: 'party_a_contact', label: '甲方联系人', type: 'text', required: true, group: 'parties' },
        { key: 'party_a_email', label: '甲方邮箱', type: 'text', required: true, group: 'parties' },
        { key: 'party_b_contact', label: '乙方联系人', type: 'text', required: true, group: 'parties', placeholder: '江振宇' },
        { key: 'party_b_email', label: '乙方邮箱', type: 'text', required: true, group: 'parties' },
        { key: 'signing_place', label: '签订地点', type: 'text', required: true, group: 'parties' },
        { key: 'signing_date', label: '签订日期', type: 'text', required: true, group: 'parties', placeholder: '2026.07.23' },
        { key: 'project_name', label: '项目名称', type: 'text', required: true, group: 'project', help_text: '从需求确认书取' },
        { key: 'development_content', label: '开发内容', type: 'textarea', required: true, group: 'project', help_text: '从需求确认书功能范围取' },
        { key: 'schedule', label: '工期天数', type: 'number', required: true, group: 'project', help_text: '从排期表取' },
        { key: 'warranty_period', label: '质保月数', type: 'number', required: true, group: 'project', help_text: '从需求确认书取' },
        { key: 'unit_price', label: '单价', type: 'number', required: true, group: 'amount' },
        { key: 'quantity', label: '数量', type: 'number', required: true, group: 'amount', placeholder: '1' },
        { key: 'item_total', label: '小计', type: 'number', required: true, group: 'amount' },
        { key: 'total_amount', label: '合同总价（小写）', type: 'number', required: true, group: 'amount' },
        { key: 'total_amount_cn', label: '合同总价（大写）', type: 'text', required: true, group: 'amount', help_text: '中文大写金额' },
        { key: 'deposit_percent', label: '首期款比例', type: 'number', required: true, group: 'payment', placeholder: '30' },
        { key: 'deposit_amount', label: '首期款金额', type: 'number', required: true, group: 'payment' },
        { key: 'milestone_1', label: '中期款触发条件', type: 'text', required: true, group: 'payment', placeholder: 'UI设计确认' },
        { key: 'mid_percent', label: '中期款比例', type: 'number', required: true, group: 'payment', placeholder: '40' },
        { key: 'mid_amount', label: '中期款金额', type: 'number', required: true, group: 'payment' },
        { key: 'final_percent', label: '尾款比例', type: 'number', required: true, group: 'payment', placeholder: '30' },
        { key: 'final_amount', label: '尾款金额', type: 'number', required: true, group: 'payment' },
        { key: 'delivery_place', label: '交付地点', type: 'text', required: true, group: 'delivery', placeholder: '甲方指定地点' },
        { key: 'delivery_method', label: '交付方式', type: 'text', required: true, group: 'delivery', placeholder: '线上交付' },
        { key: 'additional_services', label: '增值服务条款', type: 'textarea', required: false, group: 'optional', help_text: '无内容填空字符串' },
        { key: 'breach_terms', label: '补充违约条款', type: 'textarea', required: false, group: 'optional' },
        { key: 'other_terms', label: '其他约定', type: 'textarea', required: false, group: 'optional' },
        { key: 'attachments', label: '合同附件', type: 'textarea', required: false, group: 'optional', help_text: '自带前导顿号，如"、《xxx》"' },
      ],
    },
  },
  {
    doc_key: 'collaboration',
    name: '项目协作约定',
    description: '甲乙方接口人、沟通机制、版本引用',
    file: '项目协作约定_template.docx',
    schema: {
      groups: [{ key: 'meta', label: '元信息' }],
      fields: [
        { key: 'doc_version', label: '文档版本', type: 'text', required: true, group: 'meta', placeholder: 'V1.0' },
        { key: 'issue_date', label: '发布日期', type: 'date', required: true, group: 'meta' },
        { key: '第几版', label: '需求确认书版本', type: 'text', required: true, group: 'meta', help_text: '引用需求确认书版本' },
        { key: 'A_name', label: '甲方接口人', type: 'text', required: true, group: 'meta', placeholder: '张老师' },
        { key: 'A_phone', label: '甲方联系电话', type: 'text', required: true, group: 'meta' },
      ],
    },
  },
  {
    doc_key: 'progress_report',
    name: '进度报告',
    description: '本周完成、下周计划、风险与阻塞、甲方待办、备注',
    file: '进度报告_template.docx',
    schema: {
      groups: [{ key: 'content', label: '报告内容' }],
      fields: [
        { key: 'report_date', label: '报告日期', type: 'date', required: true, group: 'content' },
        { key: '第几版', label: '需求确认书版本', type: 'text', required: true, group: 'content', help_text: '引用需求确认书版本' },
        { key: 'weekly_completed', label: '本周完成', type: 'textarea', required: true, group: 'content', help_text: '每条以（一）开头' },
        { key: 'next_week_plan', label: '下周计划', type: 'textarea', required: true, group: 'content' },
        { key: 'risks_and_blockers', label: '风险与阻塞', type: 'textarea', required: true, group: 'content' },
        { key: 'client_pending', label: '甲方待办', type: 'textarea', required: true, group: 'content' },
        { key: 'remarks', label: '备注', type: 'text', required: false, group: 'content', help_text: '允许填"无"' },
      ],
    },
  },
  {
    doc_key: 'receipt',
    name: '收据',
    description: '付款方、付款项目、金额、收款方式',
    file: '收据_template.docx',
    schema: {
      groups: [{ key: 'payment', label: '收款信息' }],
      fields: [
        { key: 'payer_name', label: '付款方名称', type: 'text', required: true, group: 'payment', placeholder: '南京农业大学信息学院' },
        { key: 'payment_item', label: '付款项目', type: 'text', required: true, group: 'payment', placeholder: '官网设计服务首期款' },
        { key: 'amount', label: '金额（小写）', type: 'number', required: true, group: 'payment' },
        { key: 'amount_cn', label: '金额（大写）', type: 'text', required: true, group: 'payment', help_text: '中文大写金额' },
        { key: 'payment_method', label: '收款方式', type: 'text', required: true, group: 'payment', placeholder: '银行转账' },
        { key: 'receipt_date', label: '收款日期', type: 'date', required: true, group: 'payment' },
      ],
    },
  },
];

// ── 种子函数 ──────────────────────────────────────

export async function seedYinlingTemplates(ctx: Context): Promise<void> {
  const svc = new DocGenService(ctx);

  // 幂等：已存在则跳过
  const existing = await svc.listTemplateSets();
  if (existing.some((s) => s.name === '银聆法律文书')) {
    ctx.log('[seed] 银聆法律文书模板集已存在，跳过');
    return;
  }

  ctx.log('[seed] 创建银聆法律文书模板集...');

  const templateSet = await svc.createTemplateSet({
    name: '银聆法律文书',
    description: '银聆项目全套法律与协作文书模板（需求确认书、排期表、合同、协作约定、进度报告、收据）',
    status: 'active',
    created_by: 'system',
  });

  for (const tpl of TEMPLATES) {
    const filePath = join(TEMPLATE_DIR, tpl.file);
    const bytes = readFileSync(filePath);
    const { token } = await ctx.file.upload(tpl.file, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    await svc.createDocumentType({
      template_set_id: templateSet.id,
      doc_key: tpl.doc_key,
      name: tpl.name,
      description: tpl.description,
      template_file_token: token,
      field_schema: tpl.schema,
    });

    ctx.log(`[seed]   + ${tpl.name} (${tpl.doc_key})`);
  }

  ctx.log(`[seed] 银聆法律文书模板集创建完成，共 ${TEMPLATES.length} 种文档类型`);
}
