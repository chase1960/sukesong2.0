# HR Personal Agent 实施计划（黑客松演示）

日期：2026-10-31 · 分支：dev · 赛道：纯 Node 演示（不依赖 Frappe/MariaDB）

## 目标

两条能力线，全部在尚书系统内真实闭环：

1. **对话执行动作**：HR 在聊天里让 Agent 「生成 JD 并发布」「安排面试」——AI 提案走 ActionContract 确认卡，人同意后在同一事务内落库 + appendEvent 审计，业务页面可核对结果。
2. **Skill 学习闭环**：观察 HR 对 AI JD 草稿的修订（diff）+ 面试/筛选决定，确定性规则提取「偏好草稿」，走确认卡激活后真正影响下一次 `aiScreenApplication`（注入 prompt 偏好段）与 JD 生成的偏好注入。

铁律：AI 只提案，人确认；对外表述用「HR 确认的偏好规则」，不称自主进化。

## 已确认决策

- a) Skill 激活走正式 ActionContract 确认卡（不绕过统一执行/快照校验）
- b) 面试偏好真正注入 `aiScreenApplication` prompt，运行时生效
- c) 规则提取纯确定性逻辑（不引入 LLM 调用）

## 前置阻塞修复

### F1. 纯 Node 模式确认卡无法确认（`shangshu-web/js/real-chat.js:1588`）
「同意」按钮硬编码请求 `api/platform/action-proposals/:id/resolve`，该路由只在 Frappe 模式挂载。改为：按页面运行模式选择端点——纯 Node 下走 `POST /api/confirmations/:id`（server.ts:884 已存在，返回 `{ok:true}`，注意前端回执校验 `r.id/r.status` 需要适配该响应形状，或后端补齐字段）。同文件 1102/1315/1322/1328/1333 处的 Frappe 端点在纯 Node 下同样不可用，确认卡渲染需走 `/api/confirmations` 列表数据（列表已 enrich）。

### F2. 招聘 AI 提案事件卡死确认列表（router.ts）
`recruitment.jd.ai` / `resume.parse` / `screening.propose` 等事件以 `status:'proposed'` 写入但从未 resolve，且未注册 ActionContract。`/api/confirmations` 列表 admin 能看到它们，点「同意」→ `getActionContract` 抛错 500。处理：给这些 AI 提案事件 payload 加自闭环标记（`_resolves: <自身id>`，listPendingConfirmations 的 filter 已按该字段排除），或补齐 payload 后统一改用 requestConfirmation。新写的 contracts 全部走正规链路，杜绝此类事件。

## 能力线一：对话执行动作

### 新文件 `src/capabilities/recruitment/contracts.ts`
注册 ActionContract（复用 `registerActionContract`，roles 复用现有角色集合，无 'hr' 角色）：

| id | 说明 | resolve | execute |
|---|---|---|---|
| `recruitment.job.create` | AI 起草岗位（含 AI 生成 JD 草稿） | 校验 title/department 等输入 | insert recruitment_jobs（status draft，含 AI JD 草稿），返回 id |
| `recruitment.jd.publish` | 发布 JD | 按 code/title 查 job，快照 status/jd_draft | 校验 draft 态 + JD 非空 → jd_published/status open |
| `recruitment.interview.schedule` | 安排面试 | 按候选人姓名/job code 解析 application，校验 interview 阶段 | insert recruitment_interviews（round 递增） |
| `recruitment.skill.activate` | 激活偏好规则（能力线二） | 见下 | 见下 |

每个契约带 `snapshot`（状态快照防确认期间数据漂移）、`inputSchema`（Ajv）。
事件 payload 保存完整业务内容（jd 全文、面试时间/面试官），不再只存 length——审计密度是 Skill 提取的数据源。

### `src/capabilities/recruitment/chat.ts`（新）
- 注册 4-6 个查询型 capability：`recruitment.query.overview/jobs/applications/skills`（封装现有 router 查询逻辑为可复用函数，router 与 chat 共用同一份，避免双写逻辑）。
- 向 `CHAT_TOOLS`（core/chat.ts 可变导出数组）push：
  - `recruitment_overview / recruitment_jobs / recruitment_applications`（kind: query）
  - `jd_publish`（capability `recruitment.jd.publish`，kind: confirm）
  - `interview_schedule`（capability `recruitment.interview.schedule`，kind: confirm，参数用业务名：候选人名/岗位 code/时间/面试官）
  - `skill_propose`（触发从 episodes 提取 skill 草稿，kind: confirm → capability `recruitment.skill.extract`，见能力线二）
- confirm 型自动享受 executeTool 的现有 dedup/挂起/审计链路。

### `src/capabilities/recruitment/router.ts` 改造
- 保留现有 REST 路由（页面操作路径不动，演示稳定）。
- 抽出共享业务函数（publishJD / scheduleInterview 等）供 ActionContract execute 调用，保证「页面点」和「聊天确认」走同一执行逻辑与同一审计格式。
- 现有 AI 端点的 proposed 事件补 payload 内容（ai-jd 存 jd 全文）。

## 能力线二：Skill 学习闭环

### 数据模型（business 层新表，复用通用 records，无需 DDL）
- `recruitment_episodes`：操作证据快照。关键字段：`kind`（'jd_edit' | 'screening_decision' | 'interview_feedback'）、`job_id`、`ai_content`（AI 原稿）、`human_content`（HR 终稿）、`diff`（确定性 diff 摘要）、`actor`、`created_at`。
- `recruitment_skills`：偏好规则。字段：`rule_type`（'jd_style' | 'screening_preference' | 'interview_preference'）、`pattern`（确定性提取的结构化规则，如「HR 3 次删除'我们提供'薪资段」「HR 连续 2 次 reject 经验<5 年」）、`evidence_ids`（支撑 episode 引用）、`status`（draft/active/dismissed）、`owner`（HR 用户 id）、`version`。
- `recruitment_skill_feedback`：使用反馈（哪次 AI 建议应用了哪条 skill、HR 是否再次修改）。

### 采集点（router.ts）
- `POST /jobs/:id/jd`（HR 修订草稿）：生成 episode（ai_content 取 jd_draft 前值，human_content 取新值，行内 diff）。
- `applications/:id/decide`（HR 筛选决定 vs AI 建议）：episode 记录 AI recommend vs HR decision。
- `interviews/:id/evaluate`：评价与面试官偏好。
- `POST /api/recruitment/skills/extract`：触发确定性提取（见下），产生 skill 草稿 + `requestConfirmation('recruitment.skill.activate')` 挂确认卡。

### 提取器 `src/capabilities/recruitment/skills.ts`（新，纯确定性）
规则（无 LLM）：
- JD diff 统计：对同一 job 多次 episode，统计被 HR 保留/删除的段落与句式（如每次都删掉某模板段 → 规则「JD 不含 X」；每次都新增某段 → 「JD 需含 Y」）。阈值 ≥2 次重复才成候选。
- 筛选偏好：HR 对 AI 'advance' 连续 N 次（≥2）改为 'reject' 且候选人经验低于阈值 → 规则「经验 < X 年建议 reject」；反向同理。
- 面试偏好： interviewer 选择频次、评价关键词偏好。
输出 rule_type + pattern + evidence_ids，写入 `recruitment_skills`（status draft），并走 `recruitment.skill.activate` 确认卡。

### 激活与生效
- `recruitment.skill.activate` contract：execute 把 skill 置 active（CAS `_version`），事件留痕。
- **生效点 1（决策 b）**：`aiScreenApplication` 增加可选参数 `preferences: string[]`——router 的 `ai-screen` 端点先查该 HR（owner）的 active skills，把 pattern 序列化为偏好段拼进 system prompt（如「注意：本团队偏好经验≥5 年，低于此建议谨慎 advance」）。fallback 预录逻辑同样吃偏好（prerecordedScreen 里按 pattern 调整 recommend/score），保证断网演示也生效。
- **生效点 2**：`aiGenerateJD` 同样注入 active 的 jd_style 规则（prompt 偏好段）。
- 反馈闭环：下次 HR 仍修改 AI 输出 → 新 episode → feedback 记录「skill 未阻止再修改」→ 提取器可标记该 skill 需复核（演示口径：持续迭代而非一次性训练）。

### 前端
- `shangshu-web/js/domains/recruitment/recruitment.js`：招聘页加「Agent 学习」区块：episodes 列表、skill 草稿/激活状态、证据引用（点开看 diff）。数据来自新 REST 端点 `GET /api/recruitment/skills`、`GET /api/recruitment/episodes`。
- 聊天侧新增一个演示话术入口（skill_propose 工具 + 确认卡），不新做页面。

## 文件改动清单

| 文件 | 动作 | 规模 |
|---|---|---|
| shangshu-web/js/real-chat.js | F1 确认卡端点按模式切换 | 小（~40 行） |
| src/capabilities/recruitment/contracts.ts | 新建：4 个 ActionContract | 中（~250 行） |
| src/capabilities/recruitment/chat.ts | 新建：查询能力 + ChatToolDef 注册 | 中（~200 行） |
| src/capabilities/recruitment/skills.ts | 新建：episode 采集、确定性提取、注入生效 | 大（~350 行） |
| src/capabilities/recruitment/router.ts | 重构共享函数、采集点、skills REST 端点 | 中（~200 行增量） |
| src/capabilities/recruitment/ai.ts | preferences 参数 + prompt 注入 + fallback 适配 | 小（~60 行） |
| src/capabilities/recruitment/register.ts | 注册新模块 | 小 |
| shangshu-web/js/domains/recruitment/recruitment.js | Agent 学习区块 UI | 中（~150 行） |
| seed.ts | 演示种子：预置 2-3 条 episodes + 1 条 skill 草稿 | 小 |

## 工作量估算（净编码时间）

| 模块 | 估算 |
|---|---|
| F1 确认卡修复 | 1-1.5h |
| 能力线一（contracts + chat 工具 + router 重构） | 4-5h |
| 能力线二（episodes/提取/激活/生效注入） | 4-5h |
| 前端学习区块 + 联调 | 2-3h |
| 种子 + 端到端演示彩排 | 1-2h |
| **合计** | **12-16h** |

## 演示剧本（验收标准）

1. 聊天：「帮我给『高级后端工程师』岗位生成并发布 JD」→ Agent 调 jd_publish → 确认卡出现 → HR 同意 → 招聘页岗位变 open，事件链新增 confirmed 记录（含 JD 全文 hash）。
2. 聊天：「给张三安排明天 10 点一面，面试官李四」→ interview_schedule 确认卡 → 同意 → 面试列表新增记录。
3. 页面操作：HR 两次修改 AI 筛选建议（把 advance 改 reject，理由经验不足）→ 点「提取偏好」→ 确认卡「建议规则：经验<5 年倾向 reject」→ 激活。
4. 新候选人（经验 3 年）进入筛选 → AI 建议自动带偏好影响（reasoning 提及偏好依据，结果倾向 review/reject）→ 招聘页「Agent 学习」区块可见该 skill 的生效记录与证据链。
5. 断网降级：全程 LLM 失败走 fallback，剧本 1-4 仍可走完（fallback flag 展示）。

## 风险与边界

- 无 'hr' 角色：Skill owner 归属用 business 层 owner 字段 + 现有角色（admin/manager）授权，不改 actor.ts（改了会动全局权限，超出黑客松范围）。
- 现有 recruitment REST 直写路径保留，仅抽共享函数，不动状态机，避免破坏已可用演示。
- 确认卡端点响应形状差异（/api/confirmations 返回 {ok} vs Frappe 返回 {id,status}）：前端适配时保守处理，识别不了就回读事件链核实（现有代码已有该模式）。
- domain 边界：改动全部在 recruitment capability 目录 + 前端 recruitment 域 + real-chat.js 一处模式判断，不越界。
