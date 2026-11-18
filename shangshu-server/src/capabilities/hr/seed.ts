// HR 中台演示种子：幂等，只补 source:'demo' 的起点数据。
//
// 种子不是随便造几张表，而是把「一条完整链路」摆出来：
//   员工事实 → 覆盖度 → 能力差距 → 90 天计划 → 学习行为 → 知识卡片 → 复用采纳
//   招聘渠道 → 单位成本 → 降本建议 → 采纳 → 回测
//   动作 → 介入分级 → 确认卡 → 审计事件
// 这样打开页面就能看到"数据在流动"，而不是一堆空表。
import type { Context } from '../../core/types.ts';
import { HR_TABLES, listAll, nowIso } from './tables.ts';
import { appendEvent } from '../../core/events.ts';
import { decide, recordDecision } from './autonomy.ts';

const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const dateAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function seedHrDemo(ctx: Context): Promise<void> {
  const existing = await listAll(ctx.store, HR_TABLES.employees, { source: 'demo' });
  if (existing.length) return;
  const store = ctx.store;

  // —— 组织与编制 ——
  const units = [
    { dept: '研发中心', headcount_budget: 26, onboard: 22, cost_budget: 6200000 },
    { dept: '产品部', headcount_budget: 10, onboard: 8, cost_budget: 2400000 },
    { dept: '人力资源部', headcount_budget: 6, onboard: 5, cost_budget: 1200000 },
    { dept: '市场部', headcount_budget: 8, onboard: 7, cost_budget: 1800000 },
    { dept: '财务部', headcount_budget: 5, onboard: 4, cost_budget: 900000 },
  ];
  for (const u of units) {
    await store.insert('business', HR_TABLES.orgUnits, { ...u, created_at: nowIso() });
  }

  // —— 员工档案（能力标签刻意与岗位模型对齐，差距才算得出来） ——
  const employees: Array<Record<string, any>> = [
    {
      emp_no: 'E1001', name: '张伟', dept: '研发中心', title: '高级后端工程师', level: 'P7', manager: '郑凯',
      join_date: '2021-03-01', location: '苏州', education: '硕士 · 计算机科学',
      skills: [{ name: 'Java', level: 4 }, { name: '分布式', level: 4 }, { name: '数据库', level: 4 }, { name: '稳定性', level: 3 }, { name: '代码评审', level: 4 }, { name: '灰度发布', level: 4 }],
    },
    {
      emp_no: 'E1002', name: '李娜', dept: '研发中心', title: '前端工程师', level: 'P6', manager: '郑凯',
      join_date: '2022-07-11', location: '苏州', education: '本科 · 软件工程',
      skills: [{ name: 'TypeScript', level: 4 }, { name: 'React', level: 3 }, { name: '性能优化', level: 3 }, { name: '组件化', level: 3 }],
    },
    {
      emp_no: 'E1003', name: '王芳', dept: '产品部', title: '产品经理', level: 'P7', manager: '陈晨',
      join_date: '2020-09-14', location: '上海', education: '硕士 · 工业设计',
      skills: [{ name: '需求分析', level: 4 }, { name: '数据分析', level: 3 }, { name: '项目管理', level: 3 }, { name: '用户研究', level: 4 }],
    },
    {
      emp_no: 'E1004', name: '陈晨', dept: '产品部', title: '高级产品经理', level: 'P7', manager: '王芳',
      join_date: '2019-05-06', location: '上海', education: '本科 · 市场学',
      skills: [{ name: '需求分析', level: 4 }, { name: '数据分析', level: 2 }, { name: '项目管理', level: 4 }, { name: '用户研究', level: 3 }],
    },
    {
      emp_no: 'E1005', name: '赵敏', dept: '人力资源部', title: 'HRBP', level: 'P6', manager: '吴静',
      join_date: '2021-11-01', location: '苏州', education: '硕士 · 人力资源管理',
      skills: [{ name: '人才盘点', level: 3 }, { name: '组织诊断', level: 3 }, { name: '劳动关系', level: 3 }, { name: '数据分析', level: 2 }],
    },
    {
      emp_no: 'E1006', name: '刘洋', dept: '研发中心', title: '后端工程师', level: 'P5', manager: '张伟',
      join_date: '2024-02-19', location: '苏州', education: '本科 · 计算机科学',
      skills: [{ name: 'Java', level: 3 }, { name: '分布式', level: 2 }, { name: '数据库', level: 3 }, { name: '稳定性', level: 2 }],
    },
    {
      emp_no: 'E1007', name: '孙悦', dept: '市场部', title: '市场经理', level: 'P6', manager: '吴静',
      join_date: '2022-04-01', location: '上海', education: '本科 · 传播学',
      skills: [{ name: '品牌传播', level: 4 }, { name: '活动策划', level: 4 }, { name: '数据分析', level: 2 }],
    },
    {
      emp_no: 'E1008', name: '周杰', dept: '研发中心', title: '测试工程师', level: 'P5', manager: '郑凯',
      join_date: '2025-06-16', location: '苏州', education: '本科 · 软件工程',
      skills: [{ name: '自动化测试', level: 3 }, { name: '质量体系', level: 2 }],
    },
    {
      emp_no: 'E1009', name: '吴静', dept: '财务部', title: '财务主管', level: 'P7', manager: '',
      join_date: '2018-08-01', location: '苏州', education: '硕士 · 会计学',
      skills: [{ name: '成本控制', level: 4 }, { name: '预算管理', level: 4 }],
    },
    {
      emp_no: 'E1010', name: '郑凯', dept: '研发中心', title: '技术负责人', level: 'P8', manager: '',
      join_date: '2017-02-13', location: '苏州', education: '硕士 · 计算机科学',
      skills: [{ name: '架构设计', level: 5 }, { name: '团队管理', level: 4 }, { name: 'Java', level: 4 }, { name: '稳定性', level: 4 }],
    },
  ];
  const empIds: Record<string, string> = {};
  for (const e of employees) {
    const id = await store.insert('business', HR_TABLES.employees, {
      ...e, skills: j(e.skills), status: 'active', employment_type: '全职',
      source: 'demo', created_at: nowIso(), updated_at: nowIso(), created_by: 'seed',
    });
    empIds[e.emp_no] = id;
  }

  // —— 岗位能力模型 ——
  const models = [
    {
      job_family: '研发', title: '高级后端工程师',
      skills: [
        { name: 'Java', required_level: 4, weight: 1.2 },
        { name: '分布式', required_level: 4, weight: 1.2 },
        { name: '数据库', required_level: 4, weight: 1 },
        { name: '稳定性', required_level: 4, weight: 1.1 },
        { name: '代码评审', required_level: 3, weight: 0.8 },
        { name: '灰度发布', required_level: 3, weight: 0.9 },
      ],
    },
    {
      job_family: '研发', title: '前端工程师',
      skills: [
        { name: 'TypeScript', required_level: 4, weight: 1 },
        { name: 'React', required_level: 4, weight: 1.1 },
        { name: '性能优化', required_level: 4, weight: 1.1 },
        { name: '组件化', required_level: 3, weight: 0.9 },
      ],
    },
    {
      job_family: '产品', title: '产品经理',
      skills: [
        { name: '需求分析', required_level: 4, weight: 1.2 },
        { name: '数据分析', required_level: 4, weight: 1.2 },
        { name: '项目管理', required_level: 3, weight: 0.9 },
        { name: '用户研究', required_level: 3, weight: 0.8 },
      ],
    },
    {
      job_family: '人力资源', title: 'HRBP',
      skills: [
        { name: '人才盘点', required_level: 4, weight: 1.1 },
        { name: '组织诊断', required_level: 3, weight: 1 },
        { name: '劳动关系', required_level: 3, weight: 0.9 },
        { name: '数据分析', required_level: 3, weight: 0.9 },
      ],
    },
    {
      job_family: '研发', title: '测试工程师',
      skills: [
        { name: '自动化测试', required_level: 4, weight: 1.2 },
        { name: '质量体系', required_level: 3, weight: 1 },
        { name: '性能测试', required_level: 3, weight: 0.9 },
      ],
    },
  ];
  for (const m of models) {
    await store.insert('business', HR_TABLES.skillModels, {
      job_family: m.job_family, title: m.title, skills: j(m.skills), created_at: nowIso(),
    });
  }

  // —— 员工事实（含「情境/行动/结果」写法，便于知识抽取） ——
  const facts: Array<[string, string, string, string, string[], number, number, number]> = [
    ['E1001', 'project', '订单中心灰度发布体系落地', '情境：大促前每次全量发布都靠回滚兜底。行动：设计按租户分流的灰度通道，接入自动化卡点与一键回滚。结果：发布回滚率从 6% 降到 0.8%，大促期间零 P0。', ['灰度发布', '稳定性'], 3, 40, 2],
    ['E1001', 'performance', '2025 年度绩效 A', '情境：全年负责订单与支付两条核心链路。行动：主导 3 次架构治理，补齐压测基线。结果：核心接口 P99 从 180ms 降到 95ms。', ['稳定性', '数据库'], 2, 120, 3],
    ['E1001', 'knowledge', '输出《灰度发布检查清单》', '情境：团队新人重复踩发布坑。行动：把 12 次发布事故整理成 15 项检查清单。结果：被 4 个小组采用，新人独立发布周期从 3 周降到 1 周。', ['灰度发布', '知识管理'], 3, 60, 2],
    ['E1001', 'feedback', '跨部门协作反馈', '情境：与产品、测试共建大促保障机制。行动：每周主持风险对齐会。结果：跨部门升级工单下降 40%。', ['协作'], 2, 30, 3],
    ['E1002', 'project', '交易页首屏性能优化', '情境：首屏 2.8s，转化率被拖累。行动：拆包 + 图片降级 + 预渲染。结果：首屏 1.4s，转化率提升 3.1pp。', ['性能优化'], 2, 70, 2],
    ['E1002', 'skill_demo', '组件库 2.0 迁移', '情境：旧组件库样式分散。行动：统一设计令牌，迁移 38 个组件。结果：样式 bug 下降 60%。', ['组件化'], 1, 150, 1],
    ['E1003', 'project', '会员增长项目', '情境：新客次月留存只有 21%。行动：重构新手任务与权益分层。结果：次月留存提升到 32%。', ['增长', '用户研究'], 2, 90, 3],
    ['E1003', 'performance', '2025 年度绩效 A', '情境：负责会员与增长两条线。行动：建立周度漏斗复盘机制。结果：全年 GMV 贡献 +18%。', ['数据分析'], 2, 120, 3],
    ['E1004', 'project', 'B 端工作台改版', '情境：客户投诉操作路径长。行动：访谈 12 家客户，重排信息架构。结果：任务完成时长下降 35%。', ['用户研究'], 2, 100, 2],
    ['E1005', 'project', '研发中心人才盘点', '情境：晋升评审缺少证据。行动：设计九宫格 + 事实证据卡。结果：盘点覆盖 100%，争议复议下降一半。', ['人才盘点'], 2, 45, 3],
    ['E1005', 'feedback', '业务部门满意度', '情境：招聘与培养脱节。行动：把岗位能力模型接进面试评分表。结果：试用期不达标率从 15% 降到 7%。', ['组织诊断', '招聘'], 2, 55, 3],
    ['E1006', 'project', '支付对账任务重构', '情境：对账任务经常超时。行动：批处理改分片 + 幂等补偿。结果：耗时从 42 分钟降到 9 分钟。', ['数据库', '稳定性'], 1, 35, 2],
    ['E1006', 'training', '完成《分布式事务》课程', '情境：跨服务一致性理解不足。行动：完成 10 学时课程并输出笔记。结果：独立完成 2 个补偿方案评审。', ['分布式'], 1, 20, 2],
    ['E1007', 'project', '行业峰会整合营销', '情境：品牌声量下滑。行动：联合 3 家伙伴做内容矩阵。结果：线索量 +65%，单条线索成本下降 28%。', ['品牌传播'], 2, 80, 2],
    ['E1008', 'training', '自动化测试训练营', '情境：回归靠手工，版本节奏被卡。行动：完成 16 学时训练并落地 20 条用例。结果：回归时间从 2 天降到 4 小时。', ['自动化测试'], 1, 25, 2],
    ['E1010', 'performance', '研发效能体系', '情境：交付周期不可度量。行动：建立需求到上线的度量看板。结果：平均交付周期从 21 天降到 13 天。', ['团队管理', '稳定性'], 3, 110, 3],
  ];
  for (const [empNo, kind, title, summary, tags, strength, ago, verifiedAgo] of facts) {
    await store.insert('business', HR_TABLES.facts, {
      employee_id: empIds[empNo], kind, title, summary, occurred_at: dateAgo(ago),
      tags: j(tags), evidence_strength: strength, status: 'verified',
      verified_by: 'zhaomin', verified_at: daysAgo(verifiedAgo), source: 'demo', created_at: daysAgo(ago),
    });
  }

  // —— 培养计划（刘洋：分布式与稳定性差距） ——
  const planActions = [
    { id: 'A01', phase: '0-30 天', type: 'course', title: '分布式事务系统课（从 2 级到 3 级）', hours: 10, due_days: 30, gap_skill: '分布式' },
    { id: 'A02', phase: '31-60 天', type: 'mentor', title: '分布式导师带练（每周 1 次复盘）', hours: 8, due_days: 60, gap_skill: '分布式' },
    { id: 'A03', phase: '31-60 天', type: 'project', title: '在真实项目中承担分布式补偿方案设计并留证', hours: 16, due_days: 60, gap_skill: '稳定性' },
    { id: 'A04', phase: '61-90 天', type: 'knowledge', title: '沉淀《分布式事务实战要点》知识卡片', hours: 4, due_days: 90, gap_skill: '稳定性' },
  ];
  const planId = await store.insert('business', HR_TABLES.plans, {
    employee_id: empIds.E1006, target_role: '高级后端工程师', model_id: 'demo-model-backend',
    gaps: j([{ skill: '分布式', current: 2, required: 4, gap: 2, weight: 1.2, priority: 2.4 },
      { skill: '稳定性', current: 2, required: 4, gap: 2, weight: 1.1, priority: 2.2 }]),
    actions: j(planActions), hours: 38,
    baseline_skills: j([{ name: 'Java', level: 3 }, { name: '分布式', level: 2 }, { name: '数据库', level: 3 }, { name: '稳定性', level: 2 }]),
    status: 'active', owner: 'zhaomin', started_at: daysAgo(20), created_at: daysAgo(20), updated_at: daysAgo(20),
  });
  const learningEvents = [
    { plan_id: planId, action_id: 'A01', kind: 'course', hours: 10, score: 88, applied: false, kirkpatrick_level: 2, ago: 12 },
    { plan_id: planId, action_id: 'A02', kind: 'mentor', hours: 4, score: 0, applied: true, kirkpatrick_level: 3, ago: 5 },
  ];
  for (const e of learningEvents) {
    await store.insert('business', HR_TABLES.learningEvents, {
      employee_id: empIds.E1006, plan_id: e.plan_id, action_id: e.action_id, kind: e.kind,
      hours: e.hours, score: e.score, applied: e.applied, kirkpatrick_level: e.kirkpatrick_level,
      note: e.kind === 'mentor' ? '已在支付对账重构中应用分片与幂等补偿' : '课程结业',
      created_at: daysAgo(e.ago),
    });
  }

  // —— 知识卡片（已发布 3 条 + 草稿 2 条 + 复用记录） ——
  const knowledgeSeeds = [
    {
      title: '灰度发布：先分租户再分比例，回滚必须一键',
      domain: '稳定性', tags: ['灰度发布', '稳定性'], employee: 'E1001',
      situation: '大促前全量发布靠回滚兜底，一次 P0 事故损失约 2 小时交易。',
      action: '按租户先切 1% → 5% → 20% → 50%，每一档看错误率与 P99；接自动化卡点，异常自动回滚。',
      result: '回滚率 6% → 0.8%，大促零 P0。',
      rules: ['发布前确认回滚脚本可用，且已在预发验证', '每档灰度至少观察 30 分钟，只看错误率与 P99 两个指标', '跨团队发布必须提前一天对齐窗口'],
      status: 'published', version: 2, reuse: 4, adopted: 3, ago: 60,
    },
    {
      title: '首屏性能：先砍体积，再谈缓存',
      domain: '性能', tags: ['性能优化'], employee: 'E1002',
      situation: '交易页首屏 2.8s，转化率明显被拖累。',
      action: '拆包 + 图片降级 + 预渲染，先做体积治理再考虑 CDN 与缓存策略。',
      result: '首屏 1.4s，转化率 +3.1pp。',
      rules: ['先量体积构成，再决定拆哪块，避免拍脑袋优化', '图片降级要按网络类型分档，不要一刀切', '优化前后用同一批真机与同一网络条件复测'],
      status: 'published', version: 1, reuse: 2, adopted: 1, ago: 90,
    },
    {
      title: '人才盘点：没有事实证据的九宫格都是印象派',
      domain: '人才盘点', tags: ['人才盘点'], employee: 'E1005',
      situation: '晋升评审缺少证据，评委各凭印象。',
      action: '九宫格每个格子必须挂 2 条已核实事实（项目/绩效/反馈），否则留空并标注待补。',
      result: '盘点覆盖率 100%，争议复议下降一半。',
      rules: ['先核实事实，再做排序', '同一事实不能被两个维度重复计分', '盘点结论必须回给本人，附缺失证据清单'],
      status: 'published', version: 1, reuse: 3, adopted: 1, ago: 45,
    },
    {
      title: '试用期不达标：把岗位能力模型接进面试评分表',
      domain: '招聘', tags: ['组织诊断', '招聘'], employee: 'E1005',
      situation: '招聘标准与培养标准两张皮。',
      action: '面试评分表直接引用岗位模型的 5 项能力，逐项打分并留证据。',
      result: '试用期不达标率 15% → 7%。',
      rules: ['评分表项必须与岗位模型同名', '每项至少一条证据，否则记 0'],
      status: 'draft', version: 0, reuse: 0, adopted: 0, ago: 20,
    },
    {
      title: '自动化测试落地：先保回归，再谈覆盖率',
      domain: '质量', tags: ['自动化测试'], employee: 'E1008',
      situation: '回归靠手工，版本节奏被卡。',
      action: '先挑 20 条高频回归用例自动化，接入每次提测。',
      result: '回归 2 天 → 4 小时。',
      rules: ['先自动化高频路径，不要追覆盖率数字'],
      status: 'draft', version: 0, reuse: 0, adopted: 0, ago: 10,
    },
  ];
  const knowledgeIds: string[] = [];
  for (const k of knowledgeSeeds) {
    const id = await store.insert('business', HR_TABLES.knowledge, {
      title: k.title, domain: k.domain, situation: k.situation, action: k.action, result: k.result,
      reusable_rules: j(k.rules), tags: j(k.tags), source_employee_id: empIds[k.employee],
      source_fact_ids: j([]), status: k.status, version: k.version,
      review_by: k.status === 'published' ? 'zhaomin' : '',
      published_at: k.status === 'published' ? daysAgo(k.ago) : '',
      reuse_count: k.reuse, adopted_count: k.adopted, ai_generated: false, fallback: false,
      evidence_strength: 2, owner: 'seed', created_at: daysAgo(k.ago), updated_at: daysAgo(k.ago),
    });
    knowledgeIds.push(id);
    if (k.status === 'published') {
      await store.insert('business', HR_TABLES.knowledgeVersions, {
        knowledge_id: id, version: k.version, title: k.title, situation: k.situation,
        action: k.action, result: k.result, reusable_rules: j(k.rules), tags: j(k.tags),
        review_by: 'zhaomin', published_at: daysAgo(k.ago), created_at: daysAgo(k.ago),
      });
    }
  }
  const usages = [
    { idx: 0, context: '订单中心新版本发布前检查', adopted: true, ago: 30 },
    { idx: 0, context: '会员系统灰度方案评审', adopted: true, ago: 18 },
    { idx: 0, context: '大促前跨团队发布对齐', adopted: true, ago: 6 },
    { idx: 0, context: '测试环境发布规范讨论', adopted: false, ago: 4 },
    { idx: 1, context: 'App 首页改版性能目标制定', adopted: true, ago: 22 },
    { idx: 1, context: '小程序首屏优化', adopted: false, ago: 8 },
    { idx: 2, context: '研发中心 2026 春季晋升评审', adopted: true, ago: 12 },
    { idx: 2, context: '产品线人才盘点试点', adopted: false, ago: 5 },
    { idx: 2, context: 'HRBP 季度盘点培训', adopted: false, ago: 3 },
  ];
  for (const u of usages) {
    await store.insert('business', HR_TABLES.knowledgeUsages, {
      knowledge_id: knowledgeIds[u.idx], context: u.context, adopted: u.adopted,
      used_by: u.adopted ? 'zhaomin' : 'wangfang', created_at: daysAgo(u.ago),
    });
  }

  // —— 数字分身（张伟已授权，李娜未授权；授权都带边界与期限） ——
  const scopeWide = {
    topics: ['岗位职责', '项目经历', '技能与专长', '协作方式', '可提供的帮助'],
    denied: ['薪酬与奖金', '绩效评级细节', '他人评价', '离职或求职意向', '健康与婚育', '法律与医疗建议', '公司未公开信息'],
    data_policy: { salary: false, performance: 'summary_only', others_evaluation: false, personal: false },
  };
  const twinZhang = await store.insert('business', HR_TABLES.twins, {
    employee_id: empIds.E1001, display_name: '张伟的数字分身', status: 'active', level: 'L1',
    scope: j(scopeWide), authorized_by: 'zhangwei', authorized_at: daysAgo(30),
    expires_at: new Date(Date.now() + 150 * DAY).toISOString(), consent_channel: 'web-confirm',
    interaction_count: 6, last_active_at: daysAgo(2), created_at: daysAgo(30), updated_at: daysAgo(2),
  });
  const twinWang = await store.insert('business', HR_TABLES.twins, {
    employee_id: empIds.E1003, display_name: '王芳的数字分身', status: 'active', level: 'L1',
    scope: j(scopeWide), authorized_by: 'wangfang', authorized_at: daysAgo(12),
    expires_at: new Date(Date.now() + 168 * DAY).toISOString(), consent_channel: 'web-confirm',
    interaction_count: 3, last_active_at: daysAgo(1), created_at: daysAgo(12), updated_at: daysAgo(1),
  });

  const queries = [
    { twin: twinZhang, emp: 'E1001', q: '张伟负责过哪些和稳定性相关的项目？', refused: false, insufficient: false, topic: '', cites: ['fact:e1', 'fact:e2'], conf: 86, ago: 6 },
    { twin: twinZhang, emp: 'E1001', q: '灰度发布一般怎么分档？', refused: false, insufficient: false, topic: '', cites: ['fact:e1'], conf: 82, ago: 4 },
    { twin: twinZhang, emp: 'E1001', q: '张伟的绩效评级是多少？', refused: true, insufficient: false, topic: '绩效评级细节', cites: [], conf: 0, ago: 3 },
    { twin: twinZhang, emp: 'E1001', q: '他打算什么时候离职？', refused: true, insufficient: false, topic: '离职或求职意向', cites: [], conf: 0, ago: 2 },
    { twin: twinWang, emp: 'E1003', q: '王芳对新客留存的关键动作是什么？', refused: false, insufficient: false, topic: '', cites: ['fact:e7'], conf: 78, ago: 5 },
    { twin: twinWang, emp: 'E1003', q: '她带过几个实习生？', refused: false, insufficient: true, topic: '', cites: [], conf: 0, ago: 1 },
  ];
  for (const q of queries) {
    await store.insert('business', HR_TABLES.twinQueries, {
      employee_id: empIds[q.emp], twin_id: q.twin, question: q.q,
      refused: q.refused, refused_topic: q.topic, insufficient: q.insufficient,
      citations: j(q.cites), confidence: q.conf, asked_by: 'zhaomin', created_at: daysAgo(q.ago),
    });
  }

  // —— 招聘渠道与效能 ——
  const channels = [
    { name: '员工内推', type: '内部', spend: 24000, sourced: 42, screened: 26, interviewed: 16, offers: 8, hired: 7, quality_hires: 6, internal_hours: 36, status: 'active' },
    { name: '招聘网站 A', type: '外部平台', spend: 58000, sourced: 210, screened: 64, interviewed: 28, offers: 9, hired: 7, quality_hires: 3, internal_hours: 64, status: 'active' },
    { name: '猎头合作', type: '猎头', spend: 90000, sourced: 26, screened: 18, interviewed: 12, offers: 4, hired: 3, quality_hires: 3, internal_hours: 18, status: 'active' },
    { name: '校园招聘', type: '校园', spend: 32000, sourced: 150, screened: 58, interviewed: 30, offers: 10, hired: 8, quality_hires: 5, internal_hours: 52, status: 'active' },
    { name: '行业社群', type: '社群', spend: 12000, sourced: 34, screened: 16, interviewed: 10, offers: 4, hired: 4, quality_hires: 3, internal_hours: 12, status: 'active' },
  ];
  for (const c of channels) {
    await store.insert('business', HR_TABLES.channels, { ...c, created_at: nowIso(), updated_at: nowIso() });
  }

  await store.insert('business', HR_TABLES.snapshots, {
    kind: 'funnel',
    source: 'recruitment.query.applications',
    body: j({
      at: daysAgo(1),
      source: 'recruitment.query.applications',
      truncated: true,
      applications_seen: 20,
      applications_total: 41,
      stage: { screening: 9, interview: 6, offer: 3, onboarding: 2 },
      outcome: { hired: 2, rejected: 8, withdrawn: 2, active: 8 },
      ai_screened: 13,
      ai_screen_rate: 65,
      open_jobs: 4,
      jobs: [
        { code: 'JOB-2026-001', title: '高级后端工程师', dept: '研发中心', status: 'open' },
        { code: 'JOB-2026-002', title: '前端工程师', dept: '研发中心', status: 'open' },
        { code: 'JOB-2026-003', title: '产品经理', dept: '产品部', status: 'open' },
        { code: 'JOB-2026-004', title: 'HRBP', dept: '人力资源部', status: 'open' },
      ],
    }),
    truncated: 1, created_at: daysAgo(1),
  });

  // 一条待采纳、一条已采纳并回测：把降本闭环摆出来
  await store.insert('business', HR_TABLES.recommendations, {
    signature: 'budget_shift:招聘网站 A:cpa',
    kind: 'budget_shift',
    title: '把「招聘网站 A」的预算向高质量渠道迁移',
    rationale: '招聘网站 A 单人成本约 ¥10,000，是均值 ¥8,057 的 1.24 倍，且 90 天质量率仅 43%，明显低于内推的 86%。',
    evidence: j({ channel: '招聘网站 A', cpa: 10000, avg_cpa: 8057, quality_rate: 43, spend: 58000, hires: 7 }),
    expected_saving: 11000, status: 'proposed',
    baseline: j({ cost_per_hire: 8057, spend: 216000, hires: 19, at: daysAgo(7) }),
    measured: 'null', created_at: daysAgo(7), adopted_at: '',
  });
  await store.insert('business', HR_TABLES.recommendations, {
    signature: 'ai_screening:coverage',
    kind: 'ai_screening',
    title: '把 AI 预筛覆盖率从 65% 提到 90%',
    rationale: '仍有 35% 的申请靠人工过简历；按每次初筛 25 分钟计，补齐后每批约省 5.8 小时。',
    evidence: j({ ai_screen_rate: 65, applications: 20 }),
    expected_saving: 1276, status: 'measured',
    baseline: j({ cost_per_hire: 8600, spend: 216000, hires: 16, at: daysAgo(45) }),
    measured: j({
      before_cost_per_hire: 8600, after_cost_per_hire: 8057, delta: 543, delta_rate: 6.3,
      note: '按同口径重算，AI 抵扣后单个入职成本下降 6.3%', at: daysAgo(3), verdict: '达标',
    }),
    created_at: daysAgo(45), adopted_at: daysAgo(45),
  });

  // —— 人机介入：一条策略上调 + 历史决策台账 ——
  await store.insert('business', HR_TABLES.autonomyPolicies, {
    action_key: 'hr.fact.record', level: 'L3',
    reason: '本季度出现两次事实与绩效口径不一致，事实登记统一升到部门负责人确认',
    created_by: 'admin', created_at: daysAgo(15), updated_at: daysAgo(15),
  });
  const decisionSeeds: Array<[string, any, string, number]> = [
    ['hr.fact.record', { action_key: 'hr.fact.record', risk: 'low', sensitivity: ['performance'], confidence: 0.82 }, '张伟项目事实登记', 30],
    ['hr.twin.answer', { action_key: 'hr.twin.answer', confidence: 0.9 }, '王芳分身穿答', 20],
    ['hr.learning.plan.publish', { action_key: 'hr.learning.plan.publish', confidence: 0.8 }, '刘洋 90 天计划', 20],
    ['hr.twin.authorize', { action_key: 'hr.twin.authorize', risk: 'high', reversible: false, sensitivity: ['personal'] }, '王芳分身授权', 12],
    ['hr.recruit.budget.shift', { action_key: 'hr.recruit.budget.shift', blast_radius: 'company', confidence: 0.78 }, '渠道预算调整', 7],
    ['hr.offer.approve', { action_key: 'hr.offer.approve', risk: 'high', reversible: false, sensitivity: ['salary'] }, '高级后端 Offer 审批', 4],
  ];
  for (const [key, input, subject, ago] of decisionSeeds) {
    const decisionId = await recordDecision(store, decide(input), 'zhaomin', subject);
    await store.update('business', HR_TABLES.autonomyDecisions, String(decisionId), { created_at: daysAgo(ago) });
  }

  // —— 审计起点：中台自身的初始化事件 ——
  for (const [cap, entity, id] of [
    ['hr.employee.save', 'hr.employee', 'batch'],
    ['hr.fact.record', 'hr.employee_fact', 'batch'],
    ['hr.twin.authorize', 'hr.twin', String(twinZhang)],
    ['hr.knowledge.publish', 'hr.knowledge', String(knowledgeIds[0])],
  ] as const) {
    await appendEvent(store, {
      capability: cap, entity_type: entity, entity_id: id,
      payload: { seeded: true }, initiator: 'agent', status: 'confirmed', reviewer: 'seed',
    });
  }
}

