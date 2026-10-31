// 招聘演示域种子：幂等，只补起点数据（source:'demo'），审计链完整（每条种子数据都补对应事件）。
// 剧本设计：演示现场从零建新岗位走全流程；同时预置 1 个已到面试阶段的申请，供「快进」演示中后段。
// 学习环种子（episodes / draft skill）独立幂等：老库升级后重启也会补上。
import type { Context } from '../../core/types.ts';
import { appendEvent } from '../../core/events.ts';

const DEMO_TAG = 'demo';

export async function seedRecruitmentDemo(ctx: Context): Promise<void> {
  const now = new Date().toISOString();
  const actor = { username: 'system', display_name: '演示种子' };

  // —— 第一部分：岗位/候选人/申请/收件箱（原有种子，按 jobs 表幂等）——
  const seeded = await ctx.store.query('business', 'recruitment_jobs', { source: DEMO_TAG });
  let jobId = '';
  let appId = '';
  if (seeded.length === 0) {
    // 1) 一个已发布的岗位（演示现场可另建新岗位）
    jobId = await ctx.store.insert('business', 'recruitment_jobs', {
      code: 'JOB-2026-001',
      title: '高级后端工程师',
      department: '平台研发部',
      headcount: 1,
      requirements: 'Node.js / TypeScript / 分布式存储，3 年以上经验',
      highlights: '核心业务线，技术氛围宽松，薪酬有竞争力',
      status: 'open',
      jd_draft: '',
      jd_published: [
        '# 高级后端工程师（平台研发部｜招 1 人）',
        '',
        '## 岗位职责',
        '- 负责核心业务模块的设计、开发与迭代',
        '- 与产品/测试协作，输出技术方案并保障交付质量',
        '- 参与代码评审与线上问题复盘',
        '',
        '## 任职要求',
        '- 3 年以上后端开发经验',
        '- Node.js / TypeScript / 分布式存储',
        '- 良好的沟通与文档习惯',
        '',
        '## 我们提供',
        '- 核心业务线，技术氛围宽松，薪酬有竞争力',
      ].join('\n'),
      source: DEMO_TAG,
      review_note: '演示数据',
      created_at: now,
      updated_at: now,
    });
    await appendEvent(ctx.store, {
      capability: 'recruitment.job.save', entity_type: 'recruitment.job', entity_id: jobId,
      payload: { code: 'JOB-2026-001', title: '高级后端工程师', status: 'draft', source: DEMO_TAG },
      initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
    });
    await appendEvent(ctx.store, {
      capability: 'recruitment.jd.publish', entity_type: 'recruitment.job', entity_id: jobId,
      payload: { code: 'JOB-2026-001', status: 'open' }, initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
    });

    // 2) 一位已到面试阶段的候选人（快进用）
    const candId = await ctx.store.insert('business', 'recruitment_candidates', {
      name: '周雨桐',
      email: 'zhouyutong@example.com',
      phone: '13800001111',
      education: '硕士 · 软件工程（华东师范大学）',
      experience_years: 6,
      skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Kubernetes'],
      summary: '6 年后端经验，主导过电商平台订单中台重构，稳定性治理经验丰富。',
      source: DEMO_TAG,
      review_note: '演示数据',
      created_at: now,
    });
    await appendEvent(ctx.store, {
      capability: 'recruitment.candidate.save', entity_type: 'recruitment.candidate', entity_id: candId,
      payload: { name: '周雨桐', source: DEMO_TAG }, initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
    });

    appId = await ctx.store.insert('business', 'recruitment_applications', {
      job_id: jobId,
      candidate_id: candId,
      stage: 'screening',
      outcome: 'active',
      ai_recommendation: '',
      ai_score: 0,
      ai_reasoning: '',
      ai_strengths: '[]',
      ai_concerns: '[]',
      ai_fallback: false,
      decided_by: '',
      decided_at: '',
      source: DEMO_TAG,
      review_note: '演示数据',
      created_at: now,
      updated_at: now,
    });
    await appendEvent(ctx.store, {
      capability: 'recruitment.application.intake', entity_type: 'recruitment.application', entity_id: appId,
      payload: { job_id: jobId, candidate_id: candId, stage: 'screening', source: DEMO_TAG },
      initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
    });

    // 3) 收件箱 2 封简历邮件（演示「收件箱解析 → 转申请」环节）
    const mails = [
      {
        mail_from: 'chenmohan@example.com',
        subject: '应聘高级后端工程师－陈默涵',
        resume_text: [
          '姓名：陈默涵',
          '邮箱：chenmohan@example.com',
          '电话：13900002222',
          '教育：本科 · 计算机科学与技术（华中科技大学，2017-2021）',
          '工作经历：',
          '2021-2024 某电商公司 后端工程师 —— 负责订单与库存服务，Node.js/TypeScript 技术栈，参与服务拆分，日订单峰值 50 万。',
          '2024-至今 某SaaS公司 高级后端工程师 —— 主导多租户数据隔离方案，PostgreSQL 分库分表，qps 提升 3 倍。',
          '技能：Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes',
          '自我评价：工程洁癖，喜欢把复杂问题拆小；业余维护一个开源 ORM 插件（star 800+）。',
        ].join('\n'),
      },
      {
        mail_from: 'linxiaoqian@example.com',
        subject: '投递贵司后端岗位－林小倩',
        resume_text: [
          '姓名：林小倩',
          '邮箱：linxiaoqian@example.com',
          '电话：13700003333',
          '教育：硕士 · 软件工程（中山大学，2019-2022）',
          '工作经历：',
          '2022-2025 某金融科技公司 后端工程师 —— 支付清结算系统，Java/Go 为主，近一年转 Node.js 网关开发。',
          '技能：Java, Go, Node.js, MySQL, Kafka',
          '自我评价：对高一致性场景有敬畏心；正在补 Kubernetes 实践。',
        ].join('\n'),
      },
    ];
    for (const m of mails) {
      const mailId = await ctx.store.insert('business', 'recruitment_inbox', {
        mail_from: m.mail_from,
        subject: m.subject,
        received_at: now,
        resume_text: m.resume_text,
        status: 'new',
        application_id: '',
        source: DEMO_TAG,
        review_note: '演示数据',
        created_at: now,
      });
      await appendEvent(ctx.store, {
        capability: 'recruitment.mailbox.receive', entity_type: 'recruitment.inbox', entity_id: mailId,
        payload: { mail_from: m.mail_from, subject: m.subject }, initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
      });
    }
  }

  // —— 第二部分：学习环演示数据（能力线二：episodes → 草稿 → 激活 → 注入 AI）——
  // 幂等：已有演示 episodes 即跳过（独立于岗位种子，老库升级也能补上）
  const seededEps = await ctx.store.query('business', 'recruitment_episodes', { source: DEMO_TAG });
  if (seededEps.length) return;
  // 老库（第一部分已种子过）时回查现成的 job/application 引用
  if (!jobId) {
    const [job] = await ctx.store.query('business', 'recruitment_jobs', { source: DEMO_TAG });
    jobId = job?.id || '';
    const [app] = await ctx.store.query('business', 'recruitment_applications', { job_id: jobId });
    appId = app?.id || '';
  }
  const insertEpisode = async (ep: Record<string, unknown>): Promise<string> =>
    ctx.store.insert('business', 'recruitment_episodes', { ...ep, source: DEMO_TAG, actor: 'system', created_at: now });

  // 4a) 两轮「AI 生成 JD → HR 删除『我们提供』段落」的修订证据（供现场演示 skills/extract 抽出 jd_style 草稿）
  const jdAiDraft = (variant: string) => [
    `# 高级后端工程师（平台研发部｜招 1 人）${variant}`,
    '',
    '## 岗位职责',
    '- 负责核心业务模块的设计、开发与迭代',
    '- 参与代码评审与线上问题复盘',
    '',
    '## 任职要求',
    '- 3 年以上后端开发经验',
    '- Node.js / TypeScript / 分布式存储',
    '',
    '## 我们提供',
    '- 核心业务线，技术氛围宽松，薪酬有竞争力',
  ].join('\n');
  const jdHumanFinal = (variant: string) => [
    `# 高级后端工程师（平台研发部｜招 1 人）${variant}`,
    '',
    '## 岗位职责',
    '- 负责核心业务模块的设计、开发与迭代',
    '- 参与代码评审与线上问题复盘',
    '',
    '## 任职要求',
    '- 3 年以上后端开发经验',
    '- Node.js / TypeScript / 分布式存储',
    '',
    '## 团队与成长',
    '- 直属导师 + 季度技术分享会',
    '- 参与开源社区，内部提案制',
  ].join('\n');
  for (const variant of ['（一稿）', '（二稿）']) {
    await insertEpisode({
      kind: 'jd_edit', job_id: jobId,
      ai_content: jdAiDraft(variant), human_content: jdHumanFinal(variant),
    });
  }

  // 4b) 三条筛选决定证据：AI 建议 advance，HR 两次否决低年限候选人（4 年、5 年），
  //     一次同意 6 年候选人（对照组，避免把整体收紧误读为偏好）。
  //     提取器取被拒者的最大经验年限为门槛 → maxExp = 5，产出「低于 5 年谨慎推进」草稿，
  //     与 4c) 预置草稿 pattern 完全一致（同 key 去重，现场跑 extract 不会重复出卡）
  const screeningEpIds: string[] = [];
  for (const c of [
    { name: '陈默涵', experience_years: 5, skills: ['Node.js', 'TypeScript', 'PostgreSQL'] },
    { name: '林小倩', experience_years: 4, skills: ['Java', 'Go', 'Node.js'] },
  ]) {
    screeningEpIds.push(await insertEpisode({
      kind: 'screening_decision', application_id: appId,
      ai_recommend: 'advance', human_decision: 'reject',
      candidate: JSON.stringify(c),
    }));
  }
  await insertEpisode({
    kind: 'screening_decision', application_id: appId,
    ai_recommend: 'advance', human_decision: 'advance',
    candidate: JSON.stringify({ name: '周雨桐', experience_years: 6, skills: ['Node.js', 'TypeScript', 'Kubernetes'] }),
  });

  // 4c) 一条 draft 状态偏好规则（演示「确认激活 → 影响下次 AI 建议」）。
  //     阈值与 extractSkillDrafts 的提取逻辑对齐（被拒者最大经验值），所以演示 skills/extract 时
  //     这条会被去重逻辑跳过，extract 只新抽出 JD 段落规则——两条路径互不干扰。
  const skillId = await ctx.store.insert('business', 'recruitment_skills', {
    rule_type: 'screening_preference',
    pattern: JSON.stringify({ min_experience_years: 5 }),
    description: 'HR 连续 2 次否决 AI 推进的经验 ≤5 年候选人（被拒者：陈默涵、林小倩），建议低于 5 年谨慎推进',
    evidence_ids: JSON.stringify(screeningEpIds),
    status: 'draft',
    owner: 'system', activated_by: '', activated_at: '',
    source: DEMO_TAG, review_note: '演示数据',
    created_at: now, updated_at: now,
  });
  await appendEvent(ctx.store, {
    capability: 'recruitment.skill.propose', entity_type: 'recruitment.skill', entity_id: skillId,
    payload: { rule_type: 'screening_preference', min_experience_years: 5, status: 'draft', source: DEMO_TAG },
    initiator: 'trigger', status: 'confirmed', reviewer: actor.username,
  });
}
