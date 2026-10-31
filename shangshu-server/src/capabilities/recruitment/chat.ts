// 招聘域对话工具（HR 个人代理，P4）：查询只读能力 + 确认卡动作工具。
// 与进销存 chat-tools.ts 同一套约定：
//   - 查询类（kind:'query'）注册为 registry 只读能力，对话 harness 直跑，答的是真数据；
//   - 写操作类（kind:'confirm'）映射到 ActionContract（contracts.ts），挂确认卡等人确认，不直接执行。
// 红线：ActionContract 的 execute 在 resolveConfirmation 事务内运行，本文件不做任何 LLM/外部调用；
//       角色只用 admin/manager/staff（无 hr 角色）。
import { registerCapability } from '../../core/registry.ts';
import type { Capability } from '../../core/types.ts';
import { CHAT_TOOLS, type ChatToolDef } from '../../core/chat.ts';
import { listSkills } from './skills.ts';

// 与 router.ts / contracts.ts 同款表名（独立声明避免循环依赖）
const T = {
  jobs: 'recruitment_jobs',
  candidates: 'recruitment_candidates',
  inbox: 'recruitment_inbox',
  applications: 'recruitment_applications',
  interviews: 'recruitment_interviews',
} as const;

// —— 招聘总览（HR 第一问「招聘进展怎么样」）：岗位/申请/面试/收件箱统计 ——
const overviewQuery: Capability<any, any> = {
  id: 'recruitment.query.overview', name: '查询招聘总览', impl: 'script', effect: 'read', roles: ['admin', 'manager'],
  async run(_input, ctx) {
    const [jobs, apps, inbox, interviews] = await Promise.all([
      ctx.store.query('business', T.jobs),
      ctx.store.query('business', T.applications),
      ctx.store.query('business', T.inbox),
      ctx.store.query('business', T.interviews),
    ]);
    const by = (s: string) => apps.filter((a: any) => a.outcome === 'active' && a.stage === s).length;
    return {
      jobs_total: jobs.length, jobs_open: jobs.filter((j: any) => j.status === 'open').length,
      jobs_draft: jobs.filter((j: any) => j.status === 'draft').length,
      inbox_new: inbox.filter((m: any) => m.status === 'new').length,
      active_applications: apps.filter((a: any) => a.outcome === 'active').length,
      by_stage: { screening: by('screening'), interview: by('interview'), offer: by('offer'), onboarding: by('onboarding') },
      interviews_scheduled: interviews.filter((v: any) => v.status === 'scheduled').length,
      hired: apps.filter((a: any) => a.outcome === 'hired').length,
      rejected: apps.filter((a: any) => a.outcome === 'rejected').length,
      withdrawn: apps.filter((a: any) => a.outcome === 'withdrawn').length,
    };
  },
};

// —— 岗位列表：「现在有哪些岗位在招」「XX 岗位什么状态」——
const jobsQuery: Capability<any, any> = {
  id: 'recruitment.query.jobs', name: '查询招聘岗位', impl: 'script', effect: 'read', roles: ['admin', 'manager'],
  async run(input, ctx) {
    const rows = await ctx.store.query('business', T.jobs);
    const list = rows.filter((j: any) => {
      if (input.status && j.status !== input.status) return false;
      if (input.keyword && !String(j.title || '').includes(String(input.keyword)) && !String(j.code || '').includes(String(input.keyword))) return false;
      return true;
    });
    return {
      count: list.length,
      jobs: list.slice(0, 20).map((j: any) => ({
        code: j.code, title: j.title, department: j.department, headcount: j.headcount,
        status: j.status, has_jd: !!j.jd_published, created_at: j.created_at,
      })),
    };
  },
};

// —— 申请列表：「候选人在什么阶段」「张三的面试到哪一步了」——
// 拼候选人姓名/岗位，与看板 applicationView 同源同形（轻量版）。
const applicationsQuery: Capability<any, any> = {
  id: 'recruitment.query.applications', name: '查询候选人申请', impl: 'script', effect: 'read', roles: ['admin', 'manager'],
  async run(input, ctx) {
    const [apps, cands, jobs, interviews] = await Promise.all([
      ctx.store.query('business', T.applications),
      ctx.store.query('business', T.candidates),
      ctx.store.query('business', T.jobs),
      ctx.store.query('business', T.interviews),
    ]);
    const candOf = new Map(cands.map((c: any) => [c.id, c]));
    const jobOf = new Map(jobs.map((j: any) => [j.id, j]));
    const ivOf = new Map<string, any[]>();
    for (const v of interviews as any[]) {
      (ivOf.get(v.application_id) || ivOf.set(v.application_id, []).get(v.application_id)!).push(v);
    }
    const list = apps.filter((a: any) => {
      if (input.stage && a.stage !== input.stage) return false;
      if (input.outcome && a.outcome !== input.outcome) return false;
      if (input.candidate) {
        const c = candOf.get(a.candidate_id);
        if (!c || !String(c.name || '').includes(String(input.candidate))) return false;
      }
      return true;
    });
    return {
      count: list.length,
      applications: list.slice(0, 20).map((a: any) => {
        const c = candOf.get(a.candidate_id);
        const j = jobOf.get(a.job_id);
        const ivs = (ivOf.get(a.id) || []).sort((x: any, y: any) => x.round - y.round);
        return {
          candidate: c?.name || '', job: j ? `${j.code} ${j.title}` : '',
          stage: a.stage, outcome: a.outcome,
          ai_recommendation: a.ai_recommendation || '', ai_score: a.ai_score || 0,
          interviews: ivs.map((v: any) => ({ round: v.round, scheduled_at: v.scheduled_at, interviewer: v.interviewer, status: v.status })),
          decided_by: a.decided_by || '', created_at: a.created_at,
        };
      }),
    };
  },
};

// —— 偏好规则列表（学习环）：草稿与激活状态，「AI 学到了我哪些偏好」——
const skillsQuery: Capability<any, any> = {
  id: 'recruitment.query.skills', name: '查询招聘偏好规则', impl: 'script', effect: 'read', roles: ['admin', 'manager'],
  async run(input, ctx) {
    const rows = await listSkills(ctx.store, input.status ? String(input.status) : undefined);
    return {
      count: rows.length,
      skills: rows.slice(0, 20).map((s: any) => ({
        id: s.id, rule_type: s.rule_type, pattern: s.pattern, description: s.description,
        status: s.status, created_at: s.created_at,
      })),
      note: rows.some((s: any) => s.status === 'draft')
        ? '有草稿态规则待确认激活（可让对话提交 skill 激活确认卡）'
        : '草稿规则通过招聘页「提取偏好规则」生成，激活需人工确认',
    };
  },
};

// —— ChatToolDef：给 LLM 的工具目录（名字下划线风格，映射能力/契约 id）——
const RECRUITMENT_CHAT_TOOLS: ChatToolDef[] = [
  {
    name: 'recruitment_overview',
    capability: 'recruitment.query.overview',
    description: '查询招聘总览（真数据）：岗位数（在招/草稿）、收件箱新邮件、各阶段进行中申请数（筛选/面试/Offer/入职）、已安排面试数、录用/拒绝/放弃统计。问「招聘进展怎么样」「现在有多少人在面试」时用。',
    parameters: { type: 'object', properties: {} },
    kind: 'query',
  },
  {
    name: 'recruitment_jobs',
    capability: 'recruitment.query.jobs',
    description: '查询招聘岗位列表（真数据）：岗位编码/名称/部门/编制/状态（draft 草稿、open 在招、closed 关闭）/是否已发布 JD。问「现在有哪些岗位在招」「XX 岗位什么状态」时用。keyword 可按岗位名称或编码模糊查。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '岗位名称或编码关键词（可省略，如「后端」「JOB-2026-001」）' },
        status: { type: 'string', description: '岗位状态过滤：draft | open | closed（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'recruitment_applications',
    capability: 'recruitment.query.applications',
    description: '查询候选人申请进展（真数据）：候选人姓名、岗位、当前阶段（screening 筛选/interview 面试/offer/onboarding）、AI 筛选建议与评分、面试轮次安排、最终结果。问「候选人在什么阶段」「张三的面试到哪一步了」「有哪些人在筛选阶段」时用。',
    parameters: {
      type: 'object',
      properties: {
        candidate: { type: 'string', description: '候选人姓名（可省略，模糊匹配）' },
        stage: { type: 'string', description: '阶段过滤：screening | interview | offer | onboarding（可省略）' },
        outcome: { type: 'string', description: '结果过滤：active 进行中 | hired 已录用 | rejected 已拒绝 | withdrawn 已放弃（可省略）' },
      },
    },
    kind: 'query',
  },
  {
    name: 'recruitment_skills',
    capability: 'recruitment.query.skills',
    description: '查询招聘偏好规则（真数据）：从 HR 历史操作中确定性提取的偏好规则（JD 段落偏好/筛选经验门槛），含草稿与激活状态。问「AI 学到了我哪些偏好」「有哪些待确认的规则」时用。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '状态过滤：draft 草稿 | active 已激活 | dismissed 已忽略（可省略查全部）' },
      },
    },
    kind: 'query',
  },
  // —— 写操作：全部走 ActionContract 确认卡（contracts.ts），人确认后才执行 ——
  {
    name: 'recruitment_jd_publish',
    capability: 'recruitment.jd.publish',
    description: '生成并发布岗位 JD（写操作，需人确认）：AI 先生成 JD 草稿，确认卡上展示全文，人工确认后岗位转为在招（open）。问「帮我生成并发布 XX 岗位的 JD」时用。',
    parameters: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '岗位 code 或名称，如 JOB-2026-001 / 高级后端工程师' },
        requirements: { type: 'string', description: '任职要求补充（可选）' },
        highlights: { type: 'string', description: '亮点补充（可选）' },
      },
      required: ['job'],
    },
    kind: 'confirm',
  },
  {
    name: 'recruitment_interview_schedule',
    capability: 'recruitment.interview.schedule',
    description: '为候选人安排面试（写操作，需人确认）：仅在面试阶段的进行中申请可安排，轮次默认自动递增。问「给张三安排明天 10 点一面，面试官李四」时用。',
    parameters: {
      type: 'object',
      properties: {
        candidate: { type: 'string', description: '候选人姓名' },
        scheduled_at: { type: 'string', description: '面试时间，如 2026-11-01 10:00' },
        interviewer: { type: 'string', description: '面试官姓名' },
        round: { type: 'integer', description: '轮次（可选，默认自动递增）' },
      },
      required: ['candidate', 'scheduled_at', 'interviewer'],
    },
    kind: 'confirm',
  },
  {
    name: 'recruitment_skill_propose',
    capability: 'recruitment.skill.activate',
    description: '处理招聘偏好规则草稿（写操作，需人确认）：激活或忽略一条从 HR 历史操作中提取的偏好规则（先查 recruitment_skills 拿 skill_id）。问「激活这条偏好规则」「忽略这个建议」时用。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '偏好规则 id（recruitment_skills 查询结果里的 id）' },
        action: { type: 'string', description: '处理方式：activate 激活 | dismiss 忽略' },
      },
      required: ['skill_id', 'action'],
    },
    kind: 'confirm',
  },
];

export function registerRecruitmentChatTools(): void {
  registerCapability(overviewQuery);
  registerCapability(jobsQuery);
  registerCapability(applicationsQuery);
  registerCapability(skillsQuery);
  for (const t of RECRUITMENT_CHAT_TOOLS) CHAT_TOOLS.push(t);
}
