// 进销存/旧专用 CHAT_TOOLS（M5 折叠）：对话默认不暴露，API 清单仍可见。
import type { ChatToolDef } from './chat.ts';

export const LEGACY_CHAT_TOOLS: ChatToolDef[] = [{
    name: 'invoice_query',
    capability: 'invoice.query',
    description: '【旧·迁移期】查询发票库。新对话优先用 object_query(object=invoice)。可按状态或收件时间范围过滤。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '发票状态：待审/已入库/已拒绝/已入账（可省略）' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（按收件时间，可省略）' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'invoice_book',
    capability: 'invoice.book',
    description: '把一张「已入库」的发票入账（写操作，需人确认）。执行后 append 记账表并按方向生成台账：进项→应付（供应商=销方），出项→应收（挂审核页选定的客户）。参数优先用 invoice_id（界面上下文指向的发票最准），否则用 invoice_no。用户说「把这张发票入账/记账」时用它，不要用 ledger_post 手工凑一笔。',
    parameters: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: '发票记录 id（当前界面上下文的对象 id）' },
        invoice_no: { type: 'string', description: '发票号码（可从 invoice_query 查询）' },
      },
    },
    kind: 'confirm',
  },
  {
    name: 'invoice_approve',
    capability: 'invoice.approve',
    description: '审核入库一张「待审」发票（写操作，需人确认）：用户核对完识别字段说「这张票没问题/入库/审核通过」时用。执行后状态变「已入库」，之后才能用 invoice_book 入账。参数用 invoice_id 或 invoice_no。',
    parameters: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: '发票记录 id（当前界面上下文的对象 id）' },
        invoice_no: { type: 'string', description: '发票号码' },
      },
    },
    kind: 'confirm',
  },
  {
    name: 'invoice_reject',
    capability: 'invoice.reject',
    description: '拒绝一张发票（写操作，需人确认）：废票/假票/识别错误无法修正时用，状态改为「已拒绝」。只能拒「待审」或「已入库」的票；「已入账」的票不能拒（账已记，得用 ledger_reverse 红冲）。参数用 invoice_id 或 invoice_no。',
    parameters: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: '发票记录 id（当前界面上下文的对象 id）' },
        invoice_no: { type: 'string', description: '发票号码' },
      },
    },
    kind: 'confirm',
  },
  {
    name: 'invoice_detail',
    capability: 'invoice.detail',
    description: '查发票明细（真数据）：按发票号码精确查，或按公司名（销方/购方）模糊查，返回类型/方向/销方/购方/不含税/税额/价税合计/开票日期/状态。问「这张发票税额多少」「某某公司的票」时用。',
    parameters: {
      type: 'object',
      properties: {
        invoice_no: { type: 'string', description: '发票号码（精确，优先）' },
        keyword: { type: 'string', description: '公司名关键字（匹配销方或购方）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'cashflow_query',
    capability: 'cashflow.query',
    description: '查资金总览（真数据）：指定期间（默认本月）收了多少（出项）、付了多少（进项）、净额，以及当前应收未收/应付未付总额。问「这个月收付情况」「净进多少」「多少钱在外面」「经营现金流」时用。',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（可省略，默认本月 1 号）' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（可省略，默认今天）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'project_query',
    capability: 'project.query',
    description: '查询项目档案（真数据）：按名称模糊匹配，返回项目列表（名称/关联客户/状态）。记账挂项目前先确认项目是否存在时用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名关键字（可省略则返回全部）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'profit_query',
    capability: 'profit.query',
    description: '查毛利（真数据）：指定期间（默认本月）已确认/已完成订单的销售收入、成本、毛利和毛利率，附毛利 Top 产品。问「这个月赚了多少钱」「毛利多少」「哪些产品赚钱」时用。',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（可省略，默认本月 1 号）' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（可省略，默认今天）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'confirmation_query',
    capability: 'confirmation.query',
    description: '查待办审批（真数据）：当前挂起等待人工确认的确认卡列表（谁发起/什么操作/金额）。问「我有什么要批的」「有没有待确认」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'ledger_query',
    capability: 'ledger.query',
    description: '查询记账流水（真数据）。可按时间范围或对方单位过滤，返回笔数、金额合计、方向（进项/出项）分布和样例列表。问「记了哪些账」「花了多少钱」「和某公司往来」时用。',
    parameters: {
      type: 'object',
      properties: {
        counterparty: { type: 'string', description: '对方单位关键字（模糊匹配，可省略）' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（可省略）' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'ledger_post',
    capability: 'ledger.post',
    description: '记一笔账（写操作，需要你确认后由人审核执行）。只在用户明确要求记账/入账时调用。发票入账请用 invoice_book，不要用它重复记。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '摘要，如「采购五金材料」' },
        counterparty: { type: 'string', description: '对方单位' },
        total_amount: { type: 'number', description: '价税合计金额（元）' },
        direction: { type: 'string', enum: ['进项', '出项'], description: '进项=付款/收到发票，出项=收款/开出发票' },
        biz_date: { type: 'string', description: '业务日期 YYYY-MM-DD（可省略，默认今天）' },
        category: { type: 'string', enum: ['收入', '成本', '费用', '其他'], description: '收支类型（可省略）' },
        account_subject: { type: 'string', description: '会计科目，如「主营业务收入」「管理费用」（可省略）' },
        project_name: { type: 'string', description: '项目名称（可省略，可先用 project_query 确认）' },
      },
      required: ['summary', 'counterparty', 'total_amount'],
    },
    kind: 'confirm',
  },
  {
    name: 'ledger_reverse',
    capability: 'ledger.reverse',
    description: '红冲更正一笔记错的账（写操作，需人确认）。记账表 append-only，记错了不能改不能删，只能红冲：系统追加一条金额为负的冲销记录。参数 ledger_id 从 ledger_query 返回的样例里取（每条都有 id）。用户说「那笔记错了/冲掉/作废那笔账」时用。',
    parameters: {
      type: 'object',
      properties: {
        ledger_id: { type: 'string', description: '要红冲的记账记录 id（ledger_query 样例中的 id）' },
      },
      required: ['ledger_id'],
    },
    kind: 'confirm',
  },
  // —— AI 业务代理写操作（A1 2026-08-10）：全部走确认卡挂起，人确认后执行 ——
  {
    name: 'customer_create',
    capability: 'customer.create',
    description: '新建客户（写操作，需人确认）。参数：name（客户名称，必填）、contact（联系人）、phone、address。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '客户名称' },
        contact: { type: 'string', description: '联系人' },
        phone: { type: 'string', description: '电话' },
        address: { type: 'string', description: '地址' },
      },
      required: ['name'],
    },
    kind: 'confirm',
  },
  {
    name: 'product_create',
    capability: 'product.create',
    description: '新建产品（写操作，需人确认）。参数：sku（编码，必填）、name（名称，必填）、spec、unit、price（售价）、cost（成本）。',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU 编码' },
        name: { type: 'string', description: '产品名称' },
        spec: { type: 'string', description: '规格' },
        unit: { type: 'string', description: '单位' },
        price: { type: 'number', description: '售价（元）' },
        cost: { type: 'number', description: '成本（元）' },
      },
      required: ['sku', 'name'],
    },
    kind: 'confirm',
  },
  {
    name: 'order_create',
    capability: 'order.create',
    description: '创建销售订单草稿（写操作，需人确认）。参数：customer_name（客户名，必填）、items（明细数组：[{product_sku, qty}]，产品用 SKU 指定）、note。价格由系统按产品主档取，不需传。',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: '客户名称' },
        items: { type: 'array', items: { type: 'object', properties: { product_sku: { type: 'string', description: '产品 SKU' }, qty: { type: 'number', description: '数量' } } }, description: '产品明细' },
        note: { type: 'string', description: '备注' },
      },
      required: ['customer_name', 'items'],
    },
    kind: 'confirm',
  },
  {
    name: 'order_confirm',
    capability: 'order.confirm',
    description: '确认销售订单（写操作，需人确认）：草稿→已确认，并生成应收台账。参数：order_no（订单号）。',
    parameters: { type: 'object', properties: { order_no: { type: 'string', description: '订单号，如 SO-XXXX' } }, required: ['order_no'] },
    kind: 'confirm',
  },
  {
    name: 'post_create',
    capability: 'post.create',
    description: '发帖到帖子广场（写操作，需人确认）：老板派活/公开一条工作动态，员工可认领、可回复进度。参数：content（帖子正文，把要派的事写清楚，可含负责人名）、source（来源：手动/逾期预警/确认卡）。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '帖子正文，例如「让张一诺本周跟进蓝海制造 5 万元应收催收」' },
        source: { type: 'string', description: '来源：手动 | 逾期预警 | 确认卡' },
      },
      required: ['content'],
    },
    kind: 'confirm',
  },
  {
    name: 'order_ship',
    capability: 'order.ship',
    description: '发货出库（写操作，需人确认）：预校验库存 → 逐项出库 → 订单完成。参数：order_no（订单号，需已确认）。库存不足会执行失败。',
    parameters: { type: 'object', properties: { order_no: { type: 'string', description: '订单号' } }, required: ['order_no'] },
    kind: 'confirm',
  },
  {
    name: 'purchase_create',
    capability: 'purchase.create',
    description: '创建采购单草稿（写操作，需人确认）。参数：supplier（供应商，必填）、type（常规/外采/库存）、items（[{product_sku, qty}]）。价格按产品成本取。',
    parameters: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: '供应商名称' },
        type: { type: 'string', enum: ['常规', '外采', '库存'], description: '采购类型' },
        items: { type: 'array', items: { type: 'object', properties: { product_sku: { type: 'string' }, qty: { type: 'number' } } }, description: '产品明细' },
      },
      required: ['supplier', 'items'],
    },
    kind: 'confirm',
  },
  {
    name: 'purchase_receive',
    capability: 'purchase.receive',
    description: '采购收货入库（写操作，需人确认）：库存增加 + 生成应付台账。参数：purchase_no（采购单号，需已确认）。',
    parameters: { type: 'object', properties: { purchase_no: { type: 'string', description: '采购单号，如 PO-XXXX' } }, required: ['purchase_no'] },
    kind: 'confirm',
  },
  {
    name: 'receivable_pay',
    capability: 'receivable.pay',
    description: '登记客户回款（写操作，需人确认）：按客户名找到未结清应收登记金额，状态自动迁移（未收→部分→已收）。参数：customer_name、amount。若客户有多笔应收，按余额最大一笔登记。',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: '客户名称' },
        amount: { type: 'number', description: '回款金额（元）' },
      },
      required: ['customer_name', 'amount'],
    },
    kind: 'confirm',
  },
  {
    name: 'payable_pay',
    capability: 'payable.pay',
    description: '登记对外付款（写操作，需人确认）：按供应商找到未结清应付登记金额。参数：supplier、amount。',
    parameters: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: '供应商名称' },
        amount: { type: 'number', description: '付款金额（元）' },
      },
      required: ['supplier', 'amount'],
    },
    kind: 'confirm',
  },
  {
    name: 'receivable_query',
    capability: 'receivable.query',
    description: '查询应收台账（真数据）：按客户汇总应收/已收/未收余额，返回未收总额、客户排行和账龄分布（未逾期/逾期1-30/31-60/61-90/90+ 天）。问「谁欠我们钱最多」「还有多少钱没收回来」「某客户欠多少」「逾期账龄」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'order_query',
    capability: 'order.query',
    description: '查询销售订单（真数据）：可按状态（草稿/已确认/已完成/已取消）或客户名过滤，返回订单数、金额合计、状态分布。问「订单进度」「有多少订单」「某客户订单」时用。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '订单状态（可省略）' },
        customer_name: { type: 'string', description: '客户名关键字（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'inventory_query',
    capability: 'inventory.query',
    description: '查询库存（真数据）：返回 SKU 数量与每个产品的当前库存余量。问「库存还有多少」「某某还有货吗」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'payable_query',
    capability: 'payable.query',
    description: '查询应付台账（真数据）：按供应商汇总应付/已付/未付余额，返回未付总额与供应商排行。问「我们还欠供应商多少钱」「应付还有多少」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'audit_query',
    capability: 'event.audit',
    description: '查询事件链/责任链：返回某实体或能力的操作事件（发起人/确认人/状态/时间/hash）。问「这笔应收是谁发起的」「谁确认的」「订单 SO-XX 的操作记录」时用。参数 entity_type=receivable/order/purchase/customer/product/ledger，entity_id=记录 id；查询应收时也可用 customer_name（自动解析）。',
    parameters: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: '实体类型：receivable/order/purchase/customer/product/ledger' },
        entity_id: { type: 'string', description: '实体记录 id（可省略，用 customer_name 代替）' },
        customer_name: { type: 'string', description: '客户名（entity_type=receivable 时可用，自动解析）' },
        capability: { type: 'string', description: '按能力过滤，如 order.confirm（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'brief_query',
    capability: 'brief.query',
    description: '查询每日经营简报：返回最近生成的简报（订单/应收/应付/库存/毛利汇总）。问「今天的简报」「经营情况怎么样」时用。若未生成过，提示可运行「每日经营简报」定时任务。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'alert_query',
    capability: 'alert.query',
    description: '查询待处理提醒：应收逾期/库存预警等。问「有什么要处理的」「哪些应收逾期了」「有什么提醒」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'product_query',
    capability: 'product.query',
    description: '查询产品档案（真数据）：按 SKU 或名称模糊匹配，返回产品列表（SKU/名称/售价/成本）。下单/建采购前确认产品是否存在时用。',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU 关键字（可省略）' },
        name: { type: 'string', description: '产品名称关键字（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'customer_query',
    capability: 'customer.query',
    description: '查询客户档案（真数据）：按名称模糊匹配，返回客户列表（名称/联系人/电话）。下单/登记回款前确认客户是否存在时用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '客户名关键字（可省略则返回全部）' },
      },
    },
    kind: 'query',
  },

].map((t) => ({ ...t, surface: 'legacy' as const })) as ChatToolDef[];
