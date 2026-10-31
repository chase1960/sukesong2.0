// 链路图谱注册表：设计态「链路 → 事件/页面/投影」的单一说明源。
// 维护规则：新增 capability 或改页面编排时，同 PR 更新本文件；/api/flows 只读暴露给前端图谱。
// 运行态（近 7 天 confirmed 次数等）由 server 路由 merge execution.events，不在此硬编码。

export type FlowNodeType = 'page' | 'capability' | 'entity' | 'actor';
export type FlowEdgeKind = 'flow' | 'trigger' | 'project' | 'navigate' | 'query';

export interface FlowStepDef {
  /** 步骤节点 id（图谱内唯一） */
  id: string;
  label: string;
  /** 对应 execution.events capability；页面直操作用 page: 前缀 */
  ref?: string;
  kind: 'event' | 'page_action' | 'query' | 'navigate';
  pages?: string[];
  projects?: string[];
  confirm?: boolean;
  initiators?: string[];
  note?: string;
}

export type FlowDomainId = 'finance' | 'sales' | 'supply' | 'collab';

export interface FlowDef {
  id: string;
  name: string;
  domain: FlowDomainId;
  desc: string;
  color: string;
  steps: FlowStepDef[];
}

/** 侧栏分区 ↔ 链路域；图谱一次只展示一个分区总览。 */
export const FLOW_DOMAINS: Record<FlowDomainId, { name: string; desc: string; pages: string[] }> = {
  finance: {
    name: '财务',
    desc: '发票审核 · 记账 · 应收应付 · AI 协作',
    pages: ['review', 'accounting', 'payables', 'chat'],
  },
  sales: {
    name: '销售',
    desc: '报价订单 · 发货回款 · 应收台账',
    pages: ['orders', 'delivery', 'payables', 'chat'],
  },
  supply: {
    name: '供应链',
    desc: '采购 · 库存 · 应付付款',
    pages: ['purchase', 'inventory', 'payables', 'chat'],
  },
  collab: {
    name: '协作',
    desc: '消息 · 工作台 · 跨域协作（规划中）',
    pages: ['im', 'dash', 'chat'],
  },
};

export const PAGE_LABELS: Record<string, string> = {
  review: '发票审核',
  accounting: '记账',
  payables: '应收应付',
  chat: '尚书 AI',
  orders: '报价与订单',
  delivery: '发货与回款',
  purchase: '采购',
  inventory: '库存',
  customers: '客户',
  dash: '工作台',
  im: '消息',
  config: '系统配置',
};

/** 已落地主链路（设计态）；mock 页不入库。 */
export const FLOW_REGISTRY: FlowDef[] = [
  {
    id: 'invoice_inbound',
    name: '进项发票闭环',
    domain: 'finance',
    desc: '收票 → OCR 待审 → 人工入库 → AI/人工入账 → 记账表 + 应付台账',
    color: '#10B981',
    steps: [
      { id: 's-ingest', label: '收票入库', ref: 'invoice.ingest', kind: 'event', initiators: ['trigger', 'user'], pages: ['review', 'chat'], note: '邮件/上传/对话窗上传 → 待审' },
      { id: 's-approve', label: '审核入库', ref: 'invoice.approve', kind: 'event', confirm: true, initiators: ['user', 'agent'], pages: ['review', 'chat'], note: '待审 → 已入库（对话内确认卡，防线不省）' },
      { id: 's-review', label: '人工审核入库', kind: 'page_action', pages: ['review'], note: 'PATCH 发票 → 已入库' },
      { id: 's-reject', label: '拒绝发票', ref: 'invoice.reject', kind: 'event', confirm: true, initiators: ['user', 'agent'], pages: ['review', 'chat'], note: '废票/识别不可修正 → 已拒绝（分支，不入账）' },
      { id: 's-book', label: '发票入账', ref: 'invoice.book', kind: 'event', confirm: true, initiators: ['user', 'agent', 'trigger'], pages: ['review', 'chat'], projects: ['ledger', 'payable'], note: '确认卡 → append 记账 + 生成应付' },
      { id: 'p-ledger', label: '记账流水', kind: 'navigate', pages: ['accounting'], note: '入账后查看 append-only 流水' },
      { id: 'p-payable', label: '应付台账', kind: 'navigate', pages: ['payables'], note: '进项发票挂供应商应付' },
    ],
  },
  {
    id: 'order_to_cash',
    name: '订单 → 应收 → 回款',
    domain: 'sales',
    desc: '建单 → 确认 → 发货出库 → 应收生成 → 登记回款',
    color: '#2563EB',
    steps: [
      { id: 's-order-create', label: '创建订单', ref: 'order.create', kind: 'event', confirm: true, initiators: ['agent', 'user'], pages: ['orders', 'chat'] },
      { id: 's-order-confirm', label: '确认订单', ref: 'order.confirm', kind: 'event', confirm: true, pages: ['orders'], projects: ['receivable'] },
      { id: 's-order-ship', label: '发货出库', ref: 'order.ship', kind: 'event', confirm: true, pages: ['delivery'], projects: ['inventory'] },
      { id: 'p-recv', label: '应收台账', kind: 'navigate', pages: ['payables'] },
      { id: 's-recv-pay', label: '登记回款', ref: 'receivable.pay', kind: 'event', confirm: true, pages: ['payables', 'chat'] },
    ],
  },
  {
    id: 'procure_to_pay',
    name: '采购 → 应付 → 付款',
    domain: 'supply',
    desc: '采购单 → 确认 → 收货入库 → 应付 → 登记付款',
    color: '#C77A0A',
    steps: [
      { id: 's-po-create', label: '创建采购单', ref: 'purchase.create', kind: 'event', confirm: true, pages: ['purchase', 'chat'] },
      { id: 's-po-confirm', label: '确认采购', ref: 'purchase.confirm', kind: 'event', confirm: true, pages: ['purchase'] },
      { id: 's-po-recv', label: '采购收货', ref: 'purchase.receive', kind: 'event', confirm: true, pages: ['purchase', 'inventory'], projects: ['inventory', 'payable'] },
      { id: 'p-pay', label: '应付台账', kind: 'navigate', pages: ['payables'] },
      { id: 's-payable-pay', label: '登记付款', ref: 'payable.pay', kind: 'event', confirm: true, pages: ['payables', 'chat'] },
    ],
  },
  {
    id: 'manual_ledger',
    name: '人工记一笔',
    domain: 'finance',
    desc: '记账页 / AI 发起 → 确认卡 → 记账表 append',
    color: '#64748B',
    steps: [
      { id: 's-ledger-post', label: '记一笔账', ref: 'ledger.post', kind: 'event', confirm: true, initiators: ['user', 'agent'], pages: ['accounting', 'chat'], projects: ['ledger'] },
      { id: 's-ledger-reverse', label: '红冲更正', ref: 'ledger.reverse', kind: 'event', confirm: true, initiators: ['user', 'agent'], pages: ['accounting', 'chat'], projects: ['ledger'], note: '记错不改不删（append-only），追加负金额冲销' },
      { id: 's-cashflow', label: '资金总览', ref: 'cashflow.query', kind: 'query', initiators: ['agent'], pages: ['chat'], note: '期间收/付/净 + 应收未收/应付未付' },
      { id: 'p-flow', label: '记账流水', kind: 'navigate', pages: ['accounting'] },
    ],
  },
  {
    id: 'outbound_invoice',
    name: '出项发票 → 应收',
    domain: 'finance',
    desc: '开出销项票 → 挂客户 → 入账 → 应收台账',
    color: '#34D399',
    steps: [
      { id: 's-out-review', label: '审核 + 挂客户', kind: 'page_action', pages: ['review'], note: '出项须选客户' },
      { id: 's-out-book', label: '发票入账', ref: 'invoice.book', kind: 'event', confirm: true, pages: ['review', 'chat'], projects: ['ledger', 'receivable'] },
      { id: 'p-recv2', label: '应收台账', kind: 'navigate', pages: ['payables'] },
    ],
  },
];

export interface FlowGraphNode {
  id: string;
  type: FlowNodeType;
  label: string;
  module?: string;
  capability?: string;
  confirm?: boolean;
  flowIds: string[];
}

export interface FlowGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: FlowEdgeKind;
  flowId: string;
  label?: string;
}

export interface FlowGraph {
  flows: FlowDef[];
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  pageLabels: Record<string, string>;
}

function nodeIdForStep(step: FlowStepDef): string {
  if (step.ref) return step.ref.startsWith('page:') ? step.ref : `cap:${step.ref}`;
  if (step.kind === 'page_action' && step.pages?.[0]) return `page:${step.pages[0]}:${step.id}`;
  if (step.kind === 'navigate' && step.pages?.[0]) return `page:${step.pages[0]}`;
  return `step:${step.id}`;
}

function ensurePageNode(nodes: Map<string, FlowGraphNode>, mod: string, flowId: string) {
  const id = `page:${mod}`;
  const ex = nodes.get(id);
  if (ex) { if (!ex.flowIds.includes(flowId)) ex.flowIds.push(flowId); return id; }
  nodes.set(id, { id, type: 'page', label: PAGE_LABELS[mod] || mod, module: mod, flowIds: [flowId] });
  return id;
}

function ensureCapNode(nodes: Map<string, FlowGraphNode>, cap: string, label: string, confirm: boolean | undefined, flowId: string) {
  const id = `cap:${cap}`;
  const ex = nodes.get(id);
  if (ex) { if (!ex.flowIds.includes(flowId)) ex.flowIds.push(flowId); return id; }
  nodes.set(id, { id, type: 'capability', label, capability: cap, confirm: !!confirm, flowIds: [flowId] });
  return id;
}

function ensureEntityNode(nodes: Map<string, FlowGraphNode>, entity: string, flowId: string) {
  const id = `ent:${entity}`;
  const labels: Record<string, string> = { ledger: '记账表', payable: '应付', receivable: '应收', inventory: '库存' };
  const ex = nodes.get(id);
  if (ex) { if (!ex.flowIds.includes(flowId)) ex.flowIds.push(flowId); return id; }
  nodes.set(id, { id, type: 'entity', label: labels[entity] || entity, flowIds: [flowId] });
  return id;
}

/** 把注册表展开成图谱节点/边（设计态）。 */
export function buildFlowGraph(): FlowGraph {
  const nodes = new Map<string, FlowGraphNode>();
  const edges: FlowGraphEdge[] = [];

  for (const flow of FLOW_REGISTRY) {
    let prevStepId: string | null = null;
    for (const step of flow.steps) {
      let stepNodeId = nodeIdForStep(step);

      if (step.ref && !step.ref.startsWith('page:')) {
        stepNodeId = ensureCapNode(nodes, step.ref, step.label, step.confirm, flow.id);
      } else if (step.kind === 'page_action') {
        const pg = step.pages?.[0];
        if (pg) stepNodeId = ensurePageNode(nodes, pg, flow.id);
        else stepNodeId = `step:${step.id}`;
        if (!nodes.has(stepNodeId)) {
          nodes.set(stepNodeId, { id: stepNodeId, type: 'page', label: step.label, module: pg, flowIds: [flow.id] });
        }
      } else if (step.kind === 'navigate' && step.pages?.[0]) {
        stepNodeId = ensurePageNode(nodes, step.pages[0], flow.id);
      } else {
        nodes.set(stepNodeId, { id: stepNodeId, type: 'capability', label: step.label, flowIds: [flow.id] });
      }

      for (const pg of step.pages || []) ensurePageNode(nodes, pg, flow.id);
      for (const proj of step.projects || []) {
        const entId = ensureEntityNode(nodes, proj, flow.id);
        edges.push({
          id: `${flow.id}:${stepNodeId}->${entId}`,
          from: stepNodeId, to: entId, kind: 'project', flowId: flow.id, label: '投影',
        });
      }

      if (prevStepId) {
        edges.push({
          id: `${flow.id}:flow:${prevStepId}->${stepNodeId}`,
          from: prevStepId, to: stepNodeId, kind: 'flow', flowId: flow.id,
        });
      }

      for (const pg of step.pages || []) {
        const pgId = `page:${pg}`;
        if (step.ref && step.kind === 'event') {
          edges.push({
            id: `${flow.id}:tr:${pgId}->${stepNodeId}`,
            from: pgId, to: stepNodeId, kind: 'trigger', flowId: flow.id, label: '触发',
          });
        }
        if (step.kind === 'navigate') {
          edges.push({
            id: `${flow.id}:nav:${stepNodeId}->${pgId}`,
            from: stepNodeId, to: pgId, kind: 'navigate', flowId: flow.id, label: '跳转',
          });
        }
      }

      prevStepId = stepNodeId;
    }
  }

  return { flows: FLOW_REGISTRY, nodes: [...nodes.values()], edges, pageLabels: PAGE_LABELS };
}
