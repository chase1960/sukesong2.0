// 招聘演示域 AI 环节：JD 生成 / 简历解析 / 筛选建议。
// 预录仅限显式隔离演示；正式模式失败即停止，不补造候选人事实。
// 预录内容与种子场景一致，保证断网时演示剧本仍可完整走完。
import { chatCompletionsStream, type LlmMessage } from '../../core/infra/llm.ts';
import { loadConfig } from '../../core/config.ts';

const AI_TIMEOUT = 45_000;

async function llmText(system: string, user: string): Promise<string> {
  const cfg = loadConfig().llm;
  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const result = await chatCompletionsStream(cfg, messages, [], () => {}, AbortSignal.timeout(AI_TIMEOUT));
  if (!result.text || !result.text.trim()) throw new Error('LLM 返回空文本');
  return result.text.trim();
}

// 容错 JSON 提取：模型偶尔回 ```json 包裹或前后缀说明。
function extractJson<T>(raw: string): T {
  const text = raw.replace(/```json|```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 未返回 JSON');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

// —— 候选结构（解析与筛选共用） ——
export interface ParsedCandidate {
  name: string;
  email: string;
  phone: string;
  education: string;
  experience_years: number;
  skills: string[];
  summary: string;
}

export interface JdInput {
  title: string;
  department: string;
  headcount: number;
  requirements: string;
  highlights: string;
  /** HR 确认的偏好规则（jd_style），序列化后注入 prompt；fallback 也会应用。 */
  preferences?: string[];
}

export async function aiGenerateJD(input: JdInput): Promise<{ jd: string; fallback: boolean }> {
  const prefs = (input.preferences || []).filter(Boolean);
  const prefSection = prefs.length
    ? `\n\n团队偏好（HR 确认的规则，必须遵守）：\n${prefs.map(p => `- ${p}`).join('\n')}`
    : '';
  try {
    const jd = await llmText(
      '你是资深 HR 专家，为中小团队撰写岗位 JD（职位描述）。输出 Markdown，包含：岗位名称、职责（4-6 条）、任职要求（4-6 条）、加分项、我们提供。中文，务实不浮夸，总长 300-500 字。' + prefSection,
      JSON.stringify(input),
    );
    return { jd: applyJdPreferences(jd, prefs), fallback: false };
  } catch {
    if (process.env.SHANGSHU_RECRUITMENT_DEMO !== '1' || process.env.SHANGSHU_PLATFORM_MODE === 'frappe' || process.env.NODE_ENV === 'production') throw new Error('RECRUITMENT_AI_UNAVAILABLE: AI 未完成，未保存推测事实，请人工处理或重试');
    return { jd: applyJdPreferences(prerecordedJD(input), prefs), fallback: true };
  }
}

/** 确定性偏好兜底：fallback JD 也按规则裁剪/补段（断网演示同样生效）。 */
function applyJdPreferences(jd: string, prefs: string[]): string {
  let text = jd;
  for (const p of prefs) {
    const remove = /JD 删除段落「(.+)」/.exec(p);
    if (remove) text = removeHeadingSection(text, remove[1]);
    const add = /JD 需包含段落「(.+)」/.exec(p);
    if (add && !text.includes(add[1])) text += `\n\n## ${add[1]}\n- （HR 确认的偏好段落，请补充具体内容）`;
  }
  return text;
}

function removeHeadingSection(md: string, heading: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line.trim())) skipping = line.replace(/^#{1,6}\s+/, '').trim() === heading;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function aiParseResume(resumeText: string): Promise<{ candidate: ParsedCandidate; fallback: boolean }> {
  try {
    const raw = await llmText(
      '你是 HR 助手，从简历文本中抽取结构化候选人信息。只依据原文，不臆造。只返回 JSON 对象：{"name","email","phone","education","experience_years","skills":["..."],"summary"}，summary 限 60 字内。缺信息用空字符串或 0。',
      `简历原文：\n${resumeText}`,
    );
    const c = extractJson<ParsedCandidate>(raw);
    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error('解析结果缺姓名');
    return {
      candidate: {
        name: String(c.name).slice(0, 50),
        email: String(c.email || '').slice(0, 100),
        phone: String(c.phone || '').slice(0, 30),
        education: String(c.education || '').slice(0, 100),
        experience_years: Number(c.experience_years) || 0,
        skills: Array.isArray(c.skills) ? c.skills.slice(0, 10).map(s => String(s).slice(0, 30)) : [],
        summary: String(c.summary || '').slice(0, 120),
      },
      fallback: false,
    };
  } catch {
    if (process.env.SHANGSHU_RECRUITMENT_DEMO !== '1' || process.env.SHANGSHU_PLATFORM_MODE === 'frappe' || process.env.NODE_ENV === 'production') throw new Error('RECRUITMENT_AI_UNAVAILABLE: AI 未完成，未保存推测事实，请人工处理或重试');
    return { candidate: prerecordedCandidate(resumeText), fallback: true };
  }
}

export interface ScreenInput {
  job: { title: string; requirements: string };
  candidate: ParsedCandidate;
  /** HR 确认的筛选偏好（如最低经验年限），注入 prompt 并影响 fallback 建议。 */
  preferences?: string[];
}

export interface ScreenResult {
  recommend: 'advance' | 'reject' | 'review';
  score: number;
  reasoning: string;
  strengths: string[];
  concerns: string[];
}

export async function aiScreenApplication(input: ScreenInput): Promise<{ result: ScreenResult; fallback: boolean }> {
  const prefs = (input.preferences || []).filter(Boolean);
  const prefSection = prefs.length
    ? `\n\n团队筛选偏好（HR 确认的规则，评估时必须遵守并在 reasoning 中点明依据）：\n${prefs.map(p => `- ${p}`).join('\n')}`
    : '';
  try {
    const raw = await llmText(
      '你是招聘筛选助手。依据岗位要求评估候选人，只给建议，不做决定。只返回 JSON：{"recommend":"advance|reject|review","score":0-100,"reasoning":"限80字","strengths":["最多3条"],"concerns":["最多3条"]}。' + prefSection,
      JSON.stringify(input),
    );
    const r = extractJson<ScreenResult>(raw);
    const recommend = ['advance', 'reject', 'review'].includes(r.recommend) ? r.recommend : 'review';
    return {
      result: {
        recommend: recommend as ScreenResult['recommend'],
        score: Math.max(0, Math.min(100, Number(r.score) || 50)),
        reasoning: String(r.reasoning || '').slice(0, 160),
        strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 3).map(s => String(s).slice(0, 60)) : [],
        concerns: Array.isArray(r.concerns) ? r.concerns.slice(0, 3).map(s => String(s).slice(0, 60)) : [],
      },
      fallback: false,
    };
  } catch {
    if (process.env.SHANGSHU_RECRUITMENT_DEMO !== '1' || process.env.SHANGSHU_PLATFORM_MODE === 'frappe' || process.env.NODE_ENV === 'production') throw new Error('RECRUITMENT_AI_UNAVAILABLE: AI 未完成，未保存推测事实，请人工处理或重试');
    return { result: prerecordedScreen(input, prefs), fallback: true };
  }
}

// —— 预录兜底（与种子场景一致） ——

function prerecordedJD(input: JdInput): string {
  return [
    `# ${input.title}（${input.department}｜招 ${input.headcount} 人）`,
    '',
    '## 岗位职责',
    '- 负责核心业务模块的设计、开发与迭代，保障交付质量',
    '- 与产品/测试协作，拆解需求并输出技术方案',
    '- 参与代码评审与线上问题复盘，持续改进工程质量',
    '- 沉淀通用能力，降低团队重复建设成本',
    '',
    '## 任职要求',
    '- 3 年以上相关开发经验，具备独立负责一个模块的能力',
    `- ${input.requirements || '熟悉主流技术栈，理解常见设计模式与工程实践'}`,
    '- 良好的沟通与文档习惯，能对齐跨角色预期',
    '',
    '## 加分项',
    '- 有完整从 0 到 1 的项目经历',
    '- 对 AI 工具链/自动化提效有实践',
    '',
    '## 我们提供',
    `- ${input.highlights || '有竞争力的薪酬、清晰的成长路径与宽松的技术氛围'}`,
    '- 与业务共同成长的舞台，贡献被直接看见',
  ].join('\n');
}

function prerecordedCandidate(resumeText: string): ParsedCandidate {
  const name = (resumeText.match(/姓名[:：\s]*([一-龥A-Za-z·]{2,10})/) || [])[1] || '候选人';
  const email = (resumeText.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || '';
  const phone = (resumeText.match(/1[3-9]\d{9}/) || [])[0] || '';
  return {
    name,
    email,
    phone,
    education: '本科 · 计算机相关专业',
    experience_years: 5,
    skills: ['Node.js', 'TypeScript', 'SQLite', 'REST API'],
    summary: '后端方向候选人，工程背景与岗位匹配度良好（预录解析结果）。',
  };
}

function prerecordedScreen(input: ScreenInput, prefs: string[] = []): ScreenResult {
  const hasSkill = input.candidate.skills.length > 0;
  // HR 确认的偏好（如最低经验年限）在 fallback 中同样生效——断网演示也能看到偏好影响建议。
  const minExp = prefs.map(p => Number(/低于\s*(\d+)\s*年/.exec(p)?.[1] || 0)).find(n => n > 0) || 0;
  const lowExp = minExp > 0 && input.candidate.experience_years < minExp;
  if (lowExp) {
    return {
      recommend: 'review',
      score: 48,
      reasoning: `候选人经验 ${input.candidate.experience_years} 年，低于团队偏好门槛 ${minExp} 年（HR 确认的规则），建议谨慎，倾向复核后拒绝（预录建议）`,
      strengths: [`技术栈包含 ${input.candidate.skills.slice(0, 2).join('、') || '相关方向'}`],
      concerns: [`经验 ${input.candidate.experience_years} 年 < 偏好门槛 ${minExp} 年（团队偏好）`, '项目规模与复杂度需面试验证'],
    };
  }
  return {
    recommend: hasSkill ? 'advance' : 'review',
    score: hasSkill ? 82 : 55,
    reasoning: '候选人的技术栈与岗位要求重合度较高，项目经历完整，建议进入面试进一步评估（预录建议）。',
    strengths: [
      `${input.candidate.experience_years} 年相关经验，达到岗位基线`,
      `技术栈包含 ${input.candidate.skills.slice(0, 3).join('、') || '相关方向'}`,
      '简历结构清晰，经历可追溯',
    ],
    concerns: ['项目规模与复杂度需面试验证', '跨团队协作案例暂未展开'],
  };
}
