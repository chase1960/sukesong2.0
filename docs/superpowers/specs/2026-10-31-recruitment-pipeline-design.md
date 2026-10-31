# 招聘 Pipeline 后端设计

> 日期：2026-10-31  
> 分支：`dev`  
> 状态：开发设计草案，待书面评审后拆实施计划  
> 范围：岗位与 JD → 邮件/手工收集简历 → 解析与筛选 → 面试与评价 → Offer → 招聘域内入职闭环

## 1. 目标与已确认决策

第一期建设独立的 `shangshu_recruitment` Frappe App，让一条候选人岗位申请能够真实、可审计地走完整条招聘链。

已确认的产品决策：

1. 入职在招聘域内闭环：完成资料核对、入职审批和已入职归档；不对接外部 HR/HRMS，不建设薪酬、考勤能力。
2. 简历入口同时支持真实招聘邮箱自动收集和手工上传补录。
3. AI 用于 JD 草拟、简历结构化解析和筛选建议；AI 不直接发布 JD、淘汰候选人、作出录用决定或完成入职。
4. 后端优先，前端只消费现有平台通用对象、Action、提案、流程与服务契约，不在本设计中展开页面。
5. 当前平台继续采用一企业一部署，不扩展为多企业 SaaS。

### 1.1 第一期非目标

- 外部 HR 系统自动建档、薪酬、考勤、劳动合同签署。
- 候选人自助门户、招聘网站爬取、猎头批量简历包解析。
- 日历/ICS/视频会议联动；面试安排只提供域内记录、站内通知和邮件邀约。
- 自动识别 Offer 邮件回复；候选人接受或拒绝由招聘人员核实后登记。
- 招聘邮箱历史全量迁移；仅按现有邮件同步窗口增量处理。
- 自动淘汰或全自动录用。

## 2. 代码事实与设计约束

本设计基于导出快照的实际代码，而不是仅依据目标文档。

### 2.1 可复用能力

- `shangshu_orders` 是最小业务域模板：manifest、hooks、贡献注册、Action、权限和原生 DocType 写回方式均可复用其结构。
- `shangshu_finance` 提供“文件上传 → 抽取 → 人工确认 → 启动流程”的参照，以及跨域调用 `files.upload` 的幂等模式。
- `shangshu_mail` 已有真实 IMAP 拉取、邮件去重、附件进入文件中心、邮件发送和线程读取能力。
- `shangshu_files` 已有文件上传、附件绑定、版本读取、PDF 文字层/DOCX/文本抽取能力。
- `shangshu_core.public_api` 已暴露注册/执行 Action、AI 提案、人确认、流程、事件、通知、权限、过程日志等公共入口。
- Node BFF 的 `/api/platform/actions/:id/execute`、`/api/platform/services/:id/invoke` 及对象/提案/流程通用路由足以承载大部分招聘 API，无需新增一组公共硬编码路由。

### 2.2 必须正视的限制

1. 邮件域没有自动轮询；`mail.sync` 每次最多处理 20 封、从最近 100 封候选中选择，并有 45 秒预算。
2. 邮件服务商当前仅支持 QQ、163、网易企业邮箱北京/杭州四类配置；其他提供商不属于第一期承诺范围。
3. 招聘共享箱必须由人绑定为部门邮箱并授权，AI 不接触邮箱凭据。
4. `files.document_text` 不做 OCR；扫描件必须走 Node 侧 OCR/视觉解析。
5. 现有 OCR 提示词面向发票，招聘必须增加自己的简历解析 schema 和提示词，不能复用发票字段。
6. `files.content` 默认 1 MiB、硬上限 4 MiB。第一期自动解析只承诺不超过 4 MiB 的简历；更大的文件保留原件并转人工处理。
7. 平台无日历公共原语，不伪造“已同步日历”状态。
8. 所有业务 DocType 写入必须经过注册 Action 和域写标记，不能绕过全局写拦截。
9. Action 同版本定义不可漂移；输入、输出或语义变化必须升级版本。
10. manifest exports 与域贡献必须一致，跨域依赖必须同时正确声明在 manifest 和 `required_apps`。

## 3. 总体架构

```text
Web / API client
      │ 通用对象、Action、Service、Proposal、Process API
      ▼
shangshu-server（Node BFF）
      ├─ 会话、CSRF、通用平台代理
      ├─ JD/筛选所需 LLM 能力
      └─ 简历 OCR/结构化解析适配（无业务事实存储）
      ▼
shangshu_core.public_api
      ├─ 身份、权限、Action、提案、流程、事件、通知、审计
      ▼
shangshu_recruitment（新业务事实权威）
      ├─ 岗位/JD/筛选标准
      ├─ 收件 intake/候选人/简历/申请
      ├─ 筛选/面试/评价
      └─ Offer/入职
      │
      ├─ 公开调用 shangshu_mail：同步、读取、发送
      └─ 公开调用 shangshu_files：上传、绑定、文本读取
```

### 3.1 事实权威

| 数据 | 唯一权威 |
|---|---|
| 岗位、JD、筛选标准、intake、候选人、简历元数据与解析快照、申请、筛选结论、面试、评价、Offer、入职 | `shangshu_recruitment` |
| 原始邮件、邮件线程、邮箱同步状态、发信状态 | `shangshu_mail` |
| 简历原文件、文件版本、PDF/DOCX 文本层抽取结果 | `shangshu_files` |
| 流程实例、人工待办、Action 请求/提案、统一审计 | `shangshu_core` |
| AI 对话上下文 | Node 自有会话存储 |

Node 不保存上述招聘业务事实的第二份副本。扫描件 OCR 和 LLM 解析结果属于未核实的 `Resume` 解析快照，由招聘域 Action 写回；它们不是自动生效的筛选或录用决定。

### 3.2 新域目录与依赖

```text
frappe_apps/shangshu_recruitment/
  shangshu-plugin.yml
  shangshu_recruitment/
    hooks.py
    domain.py
    service.py
    intake.py
    extraction.py
    install.py
    api.py                    # 仅 BFF 必需的受管包装端点
    doctype/
    tests/
docs/domains/recruitment/AGENTS.md
scripts/domain-policies/recruitment.json
shangshu-server/src/domains/recruitment/  # 仅 AI/OCR 适配，无业务数据库
```

- manifest ID：`com.shangshu.recruitment`。
- 资源命名空间：`recruitment.*`。
- 文件路径：`/com.shangshu.recruitment/简历`。
- 必需依赖：`shangshu_core`、`shangshu_files`、`shangshu_mail`。
- 参考 orders 的注册结构，不依赖治理特例 `shangshu_flow`。
- 优先使用 BFF 通用路由；确需招聘 OCR/JD 专用适配时才修改共享挂载点，并将该公共变更单独评审。

## 4. 领域对象

以下为逻辑对象名；实际 DocType 统一使用 `Shangshu Recruitment ...` 前缀。所有记录带 `enterprise_id`，可变记录带 `revision`。

### 4.1 岗位与筛选标准

#### `Recruitment Job`

关键字段：

- `job_code`：企业内唯一岗位编号。
- `title`、`department`、`hiring_manager`、`headcount`。
- `requirements`、`location`、`employment_type`。
- `status`：`draft/open/closed`。
- `current_jd_revision`、`current_rubric_revision`。

岗位开放前必须至少有一个已发布 JD revision 和一个已发布 rubric revision。只有 `open` 岗位允许创建新申请；关闭岗位不删除历史申请。

#### `Recruitment JD Revision`

- `job`、`version_no`、`content`、`source`（`manual/ai_assisted`）。
- `status`：`draft/published/retired`。
- `model_name`、`model_version`、`published_by`、`published_at`。

已发布版本不可覆盖；任何修改创建新 revision。JD 发布与岗位开放是两个明确动作，避免修改草稿影响正在招聘的版本。

#### `Recruitment Screening Rubric`

- `job`、`version_no`、`required_criteria`、`preferred_criteria`、`weights`。
- `disallowed_criteria`、`status`、`published_by/at`。

筛选标准发布后不可变，筛选报告记录使用的 rubric revision。不得将性别、民族、婚育、宗教、照片等受保护或无关属性配置为筛选条件。

### 4.2 邮件 intake、候选人与简历

#### `Recruitment Intake`

一封含候选简历附件的邮件对应一条 intake，避免在岗位未知时伪造 Application。

- `source_mail_message`、`source_mail_account`、`sender_identity`。
- `candidate`、`status`：`received/needs_assignment/processing/converted/ignored/needs_manual/failed`。
- `matched_job`、`failure_code`、`received_at`。

邮件主题包含且仅包含一个 `[JOB:<job_code>]` 时可确定岗位；缺少编号、编号无效或包含多个不同岗位编号时进入 `needs_assignment`，由招聘人员执行 `intake.assign`。无关邮件不创建 intake，不标记原邮件已读。

#### `Recruitment Candidate`

- `display_name`、`primary_email`、`primary_phone`。
- `normalized_contact_key`：企业内候选人归一化匹配键，不写入日志或 AI 上下文。
- `source`、`retention_until`、`anonymized_at`。

优先按规范化邮箱匹配已有候选人；无邮箱时按电话匹配；两者均缺失则新建并进入人工查重。解析快照不直接覆盖候选人主数据，人工确认后通过 `candidate.save` 更新。

#### `Recruitment Resume`

- `candidate`、`intake`、`file_reference`、`file_sha256`。
- `source_type`：`mail/manual`。
- `parser_status`：`pending/processing/succeeded/needs_manual/failed`。
- `parsed_profile`、`parser_version`、`model_version`、`parse_error_code`。
- `is_primary`、`created_at`。

只保存文件引用，不复制文件字节。`parsed_profile` 包含教育、经历、技能、年限、证书、置信度和对应原文证据位置；它是带版本的未核实快照。

### 4.3 申请、筛选、面试与录用

#### `Recruitment Application`

- `job`、`candidate`、`primary_resume`、`process_instance`。
- `recruiter`、`source_intake`、`applied_at`。
- `outcome`：`active/hired/rejected/withdrawn`，只能由对应 Action 更新。

同一候选人同一岗位最多一条 `active` 申请。重复简历进入已有申请并生成复核事项，不启动第二个流程；历史申请已终止时允许创建新申请。

招聘阶段由绑定的流程实例投影，不提供可独立修改的 `stage` 字段。`outcome` 是业务终态投影，不由前端直接写入。

#### `Recruitment Screening Review`

- `application`、`resume`、`resume_revision`、`rubric_revision`。
- `ai_proposal`：可选；人工纯手动筛选时为空。
- `ai_recommendation`、`ai_reasons`、`ai_evidence`、`model_version`。
- `human_decision`、`human_reason`、`reviewer`、`reviewed_at`。

AI 建议和人工结论分列保存。人工可以采纳、修改或否决 AI 建议；最终结论必须包含理由。

#### `Recruitment Interview`

- `application`、`round_no`、`scheduled_start/end`、`timezone`。
- `mode`、`location_or_link`、`interviewers`。
- `status`：`scheduled/completed/cancelled`。
- `invite_mail_message`、`invite_status`、`scorecard_snapshot`。

支持多轮面试、改期和取消。邀请邮件失败不回滚已经有效的内部面试安排，但必须显式显示邀约失败。

#### `Recruitment Evaluation`

- `interview`、`interviewer`、`scores`、`overall_recommendation`。
- `comments`、`submitted_at`、`supersedes_evaluation`。

每个面试官每场面试只能有一份当前有效评价。提交后锁定；更正通过提交一份 superseding evaluation 完成，旧记录保留。

#### `Recruitment Offer`

- `application`、`version_no`、`compensation`、`benefits`、`proposed_start_date`。
- `status`：`draft/pending_approval/approved/sent/accepted/declined/expired/withdrawn`。
- `approved_by/at`、`sent_mail_message`、`response_recorded_by/at`。

薪资福利字段单独授权。修改已审批或已发送 Offer 必须创建新版本并重新审批。

#### `Recruitment Onboarding`

- `application`、`offer`、`checklist`、`joining_date`。
- `status`：`pending/in_progress/completed/cancelled`。
- `completed_by/at`。

完成条件：已接受 Offer、必办清单全部完成、办理人有权限且明确确认。Offer accepted 创建 Onboarding 时为 `pending`，首次保存办理清单后进入 `in_progress`。完成动作在同一受管事务内将申请投影为 `hired`；不创建外部 HR 员工账号。

## 5. 流程与状态

### 5.1 岗位/JD

```text
创建/编辑岗位草稿
  → AI 或人工形成 JD 草稿
  → 人工确认保存
  → 人工发布 JD revision
  → 开放岗位
```

JD 生成只产出 `jd.save` 提案；发布使用独立 `jd.publish`，防止“生成”与“发布”合成一次隐式写入。

### 5.2 招聘申请主流程

```text
intake 创建候选人/简历/申请
  → 启动 recruitment.application 流程（绑定不可变发布版本）
  → 简历解析 extract 节点
  → HR 筛选 human_task
      ├─ 不通过/撤回 → 终态并保留原因
      └─ 通过 → 面试轮子流程
                    ├─ 安排面试 → 发送邀约 → 独立提交评价 → 面试决策
                    ├─ 加面 → 下一轮面试轮子流程
                    ├─ 淘汰 → 终态
                    └─ 录用 → Offer 审批
                                  ├─ 退回修改 → 新 Offer revision
                                  └─ 批准并发送 → 人工登记接受/拒绝
                                                        └─ 接受 → 入职办理 → 完成
```

流程图只引用版本化 Action/条件，不引用前端函数。既有实例永久绑定发起时的流程版本。

### 5.3 解析失败不阻断人工链

解析节点只负责形成辅助材料：

- 成功后进入筛选待办。
- 可重试失败最多自动重试 3 次，仍失败则标记 `needs_manual` 并生成人工待办。
- 加密文件、不支持格式、超过 4 MiB、无可用文本等永久性失败直接转人工。
- HR 阅读原件后仍可人工筛选，不允许因 OCR/LLM 不可用而自动淘汰。

## 6. 关键数据流

### 6.1 真实邮箱收集

1. 管理员人工创建/绑定部门招聘邮箱，给 `Recruitment System User` 和招聘人员授予最小权限；凭据不进入招聘域或 AI 上下文。
2. 招聘域 `scheduler_events` 默认每 5 分钟触发一次 intake service，使用防重入锁，在专用系统用户上下文通过公共执行器调用 `mail.sync`。
3. 招聘域只读取已配置部门邮箱的新增 Received 邮件；无关邮件跳过，不改正文、已读状态或原邮件。
4. 邮件附件已由邮件域通过 `files.upload_attached` 进入文件中心。招聘域按邮件引用和附件哈希幂等创建 Intake、Candidate、Resume。
5. 主题含 `[JOB:<job_code>]` 且岗位开放时创建/复用 Application；否则进入人工分配。
6. Application 创建后启动流程；重复邮件或附件只返回已有记录，不重复建流程。

现有限制下的明确行为：每次调度按 `mail.sync` 的批量上限处理，不宣称历史全量；持续积压或同步窗口可能遗漏时记录同步异常并通知管理员扩容/人工同步，不能静默报告“收件箱已完整同步”。

### 6.2 手工补录

1. 请求必须提供候选人最小身份信息、文件、上传者和客户端 `request_id`；`job_id` 可选。
2. 通过 `files.upload` 保存原件，再调用 `application.intake`，来源标记为 `manual`。
3. 手工入口同样执行去重、权限、解析和流程逻辑，不创建旁路状态。
4. 提供有效开放岗位时直接创建/复用 Application；无岗位信息时先创建 Intake，由招聘人员分配，不允许写入“默认岗位”冒充真实申请。

### 6.3 简历解析与 AI 筛选

1. 数字 PDF/DOCX/文本优先使用 `files.document_text`；扫描件或无文字层文件进入 BFF OCR/视觉解析。
2. BFF 使用招聘专用结构化 schema；模型不可用或输出未通过 schema 校验时不得编造完整档案。
3. `resume.extraction.complete` 只保存未核实解析快照和模型/提示词版本，不直接推进筛选结论。
4. AI 按 Job 当前 rubric revision 生成逐项建议，每项结论必须引用解析快照中的证据；缺证据时输出“无法判断”。
5. AI 通过 `propose_registered_action('recruitment.screening.decide', ...)` 形成提案，HR 在确认/编辑后统一执行。
6. 受保护属性、姓名、照片、邮箱、电话不得成为评分特征；敏感联系方式默认不发送给模型。

### 6.4 面试与评价

1. `interview.schedule` 校验当前流程节点、申请终态、面试官分配和时间字段，然后创建面试记录及内部通知。
2. 邀约通过独立的 `mail.send` 动作发送，要求发信人对部门邮箱有 send 权限并人工确认。
3. 邮件状态为 Failed 时可人工重试；Unknown 时不自动重试，先人工核实，避免重复邀约。
4. 每位面试官只能读取被分配的必要材料并提交自己的评价。
5. 评价全部提交或招聘负责人按规则完成缺评处理后，才能执行面试轮次决策；缺评处理必须记录原因。

### 6.5 Offer 与入职

1. Offer 草稿经审批后发送；审批人、发信人可以是不同角色，服务端分别重新授权。
2. 招聘人员核实候选人回复后执行 `offer.response.record`，不接受 AI 猜测邮件语义作为接受凭据。
3. Offer accepted 后创建 Onboarding 和资料核对待办。
4. 必办项未完成、Offer 非 accepted 或申请已终止时，`onboarding.complete` 必须拒绝。
5. 完成入职只更新招聘域事实、流程与审计，不声称外部 HR 已建档。

## 7. Action、Service 与 API

所有 Action 初始版本为 `1.0.0`；变更 schema 或语义时按公共协议升级。

### 7.1 写 Action 清单

| 领域 | Action ID（均省略 `recruitment.` 前缀） |
|---|---|
| 岗位/JD | `job.save`、`job.open`、`job.close`、`jd.save`、`jd.publish` |
| 筛选标准 | `rubric.save`、`rubric.publish` |
| Intake | `intake.assign`、`intake.ignore`、`intake.retry`、`application.intake` |
| 候选人/简历 | `candidate.save`、`candidate.anonymize`、`resume.primary.select`、`resume.extraction.complete` |
| 筛选/申请 | `screening.decide`、`application.reject`、`application.withdraw` |
| 面试 | `interview.schedule`、`interview.reschedule`、`interview.cancel`、`interview.complete`、`interview.decide`、`evaluation.submit` |
| Offer | `offer.save`、`offer.submit`、`offer.approve`、`offer.return`、`offer.send`、`offer.response.record` |
| 入职 | `onboarding.checklist.save`、`onboarding.complete` |

- AI 可投影的写 Tool 只暴露必要子集；`screening.decide` 等 AI 写建议必须 `confirmation=required`。
- `application.intake` 是确定性系统动作，不暴露给 AI。
- `resume.extraction.complete` 是 `extract` 结果写回，不授予筛选/流程决策权限。
- `interview.decide` 记录本轮通过、加面或淘汰；存在缺评时必须同时提交缺评处理原因。
- 邮箱账号绑定、授权不通过招聘 AI Tool 执行。

### 7.2 查询服务

按实际需要注册版本化只读 Service：

- `recruitment.job.detail`
- `recruitment.application.detail`
- `recruitment.application.timeline`
- `recruitment.candidate.detail`
- `recruitment.interview.detail`
- `recruitment.onboarding.detail`
- `recruitment.dashboard.summary`

所有查询服务端重新应用企业、部门、岗位负责人、招聘负责人、面试官分配和字段级权限。Dashboard 只聚合调用者有权读取的记录。

### 7.3 BFF 使用原则

优先复用：

- 通用对象查询与受管记录接口。
- `/api/platform/actions/:id/execute`。
- `/api/platform/services/:id/invoke`。
- 通用提案审核、流程发起/待办/完成接口。

招聘专用 BFF 只承担 LLM/OCR 字节处理与结果适配，不建立 Node 招聘数据库，不自行判定权限，不直接写 Frappe 表。

## 8. 权限、隐私与审计

### 8.1 角色

| 角色 | 最小权限 |
|---|---|
| `Recruitment Admin` | 域配置、岗位、rubric、部门邮箱关联和权限管理；不因此获得所有 Offer 薪资明文 |
| `Recruiter` | 岗位/JD、intake、候选人、筛选、面试、Offer 草稿和入职协作 |
| `Hiring Manager` | 所负责岗位、JD/筛选确认、面试决策、Offer 审批范围内事项 |
| `Interviewer` | 仅被分配面试的必要简历材料和本人评价 |
| `Offer Approver` | 授权部门/金额范围内 Offer 审批 |
| `Onboarding Specialist` | 已接受 Offer 的入职清单与完成办理，无筛选评价读取权 |
| `Recruitment System User` | 指定邮箱同步/读取、intake、解析写回；无筛选、Offer、入职完成权限 |

候选人不是平台登录用户，不自动创建平台身份。

### 8.2 隐私规则

- 邮箱、电话、薪资、身份证件和入职资料按字段级权限控制。
- 日志、审计摘要、事件 payload 和 AI 上下文默认不包含完整联系方式、薪资明细、证件号和原始附件字节。
- 跨域事件只传稳定记录引用和必要非敏感摘要，消费者按自身权限重新读取。
- 候选人保留期限到期后通过 `candidate.anonymize` 匿名化；原审计仍保留必要的合法操作事实，不追加完整 PII。
- AI 筛选不采用受保护属性，不输出无原文证据的经历或结论。

### 8.3 审计

- 所有 Action 使用内核统一请求、确认、执行回执和审计。
- 流程阶段变化、人工分配、筛选决定、面试改期、Offer 审批/发送/回复和入职完成写过程记录。
- 域过程记录只使用 `write_process_record`、`declare_process_log_fields`、`query_process_records`。
- 不新建平行日志表，不 UPDATE/DELETE 统一日志。
- JD、评价和 Offer 的业务 revision 不是审计替代品，二者分别保留。

## 9. 幂等、并发与外部失败

### 9.1 幂等键

| 操作 | 幂等边界 |
|---|---|
| 邮件 intake | 邮箱账号 + 邮件稳定标识 |
| 邮件简历 | 邮件稳定标识 + 附件 SHA-256 |
| 手工 intake | 上传者 + 客户端 `request_id`；重放时校验候选人、岗位和文件哈希绑定一致 |
| 解析写回 | Resume + resume revision + parser version |
| 筛选 | Application + resume revision + rubric revision |
| 面试安排 | Application + round no；revision 只作为并发前置条件 |
| 评价提交 | Interview + interviewer + `submission_request_id`；更正评价使用新的 request ID 并引用被更正记录 |
| Offer 发送 | Offer + version no |
| 入职完成 | Onboarding 稳定 ID |

重放仍须通过域 `replay_guard`，确认当前 actor、记录归属和业务绑定一致后才返回原结果。

### 9.2 并发

- Job、Candidate、Application、Interview、Offer、Onboarding 等可变记录使用 `revision` 乐观锁。
- 旧 revision 请求返回稳定冲突错误，不覆盖他人修改。
- 已发布 JD/rubric、已提交评价、已发送 Offer 不原地修改，使用 revision/supersede 语义。
- 调度任务防重入；同一邮件/附件重复消费依赖 Action 幂等而不是内存锁。

### 9.3 外部失败策略

| 失败 | 行为 |
|---|---|
| IMAP 凭据/连接失败 | 不改变招聘记录；记录可重试同步异常并通知管理员，下个周期重试 |
| 邮件同步窗口积压 | 明确报告不完整同步，不显示假成功；管理员人工同步并检查邮箱 |
| 附件格式不支持、加密或超过 4 MiB | 原件保留，Resume 转 `needs_manual`，生成人工待办 |
| OCR/LLM 暂时不可用 | 有界重试 3 次后转人工，不自动淘汰 |
| AI 输出 schema 非法或证据不足 | 拒绝该提案，保留人工筛选入口 |
| 面试/Offer 邮件 Failed | 内部业务记录保留，人工确认后重试发送 |
| 邮件发送 Unknown | 不自动重发，人工核实邮件域状态 |
| Frappe/Action 执行失败 | 回滚到 Action savepoint，不留下半条申请或未审计状态推进 |

## 10. 稳定错误码

至少提供以下域错误码，响应包含中文说明、`retryable` 和 `trace_id`，程序判断不依赖异常文案：

- `RECRUITMENT_JOB_NOT_OPEN`
- `RECRUITMENT_INTAKE_JOB_REQUIRED`
- `RECRUITMENT_DUPLICATE_ACTIVE_APPLICATION`
- `RECRUITMENT_RESUME_NOT_PARSEABLE`
- `RECRUITMENT_PARSE_LIMIT_EXCEEDED`
- `RECRUITMENT_EXTRACTION_NOT_READY`
- `RECRUITMENT_RUBRIC_VERSION_MISMATCH`
- `RECRUITMENT_INVALID_STAGE_TRANSITION`
- `RECRUITMENT_INTERVIEWER_NOT_ASSIGNED`
- `RECRUITMENT_EVALUATION_ALREADY_SUBMITTED`
- `RECRUITMENT_EVALUATIONS_INCOMPLETE`
- `RECRUITMENT_OFFER_NOT_ACCEPTED`
- `RECRUITMENT_ONBOARDING_CHECKLIST_INCOMPLETE`
- `RECRUITMENT_REVISION_CONFLICT`
- `RECRUITMENT_PERMISSION_DENIED`
- `RECRUITMENT_MAILBOX_SYNC_INCOMPLETE`

## 11. 测试与门禁

### 11.1 域内单元/集成测试

1. **岗位/JD**：版本不可变、AI 只能提案、未发布 JD 或 rubric 不能开放岗位。
2. **邮件路由**：有效岗位编号、缺失/无效编号、无关邮件、多附件、重复邮件、历史终止后重新申请。
3. **去重与幂等**：邮箱/电话候选人匹配、重复附件、重复手工上传、Action 重放不重复建流程。
4. **解析链**：数字 PDF、DOCX、扫描件、空文本、加密文件、超 4 MiB、OCR 超时、模型非法 JSON、三次重试后转人工。
5. **筛选链**：rubric 版本快照、证据缺失、人工修改/否决 AI、禁止 AI 直接写结论、受保护属性不参与评分。
6. **面试链**：多轮、改期、取消、邀约失败/Unknown、缺评、superseding evaluation。
7. **Offer/入职**：审批退回、新版本重审、重复发送、接受/拒绝、清单不完整拒绝、完成入职幂等。
8. **权限**：Recruiter/Hiring Manager/Interviewer/Offer Approver/Onboarding/System User 的正常链与越权链；敏感字段和聚合查询同样校验。
9. **流程**：真实多角色办理、版本隔离、回放、失败补偿、重复完成人工任务。
10. **隐私与审计**：日志/事件/AI 上下文无完整 PII，审计不可变，匿名化不删除历史业务链。
11. **生命周期**：域停用保留数据；manifest/贡献一致；files/mail 跨域调用均声明依赖。

### 11.2 站点验收

使用隔离 Frappe 站点和专用测试邮箱，不连接生产招聘邮箱：

- `bench --site <test-site> migrate`
- `bench --site <test-site> run-tests --app shangshu_recruitment`
- 用真实 QQ/163/网易企业测试邮箱完成一次收信与附件落文件中心；OCR/LLM 失败另有可控故障注入测试。
- 不用 Administrator 串行探针代替多角色权限验收。

### 11.3 仓库门禁

新增 `scripts/domain-policies/recruitment.json`，并执行：

```bash
SHANGSHU_DOMAIN_POLICY=recruitment npm run check:domain
npm run check:platform-contract
npm run test:platform-contract
npm run test:domain-boundary
npm run check:style
npm run check:logs
npm --prefix shangshu-server run typecheck
```

基线测试应发现 `shangshu_recruitment/tests`，0 用例不得视为通过。已知基线问题单独标注：server typecheck 的 `llm.ts`/`pi-chat.ts` 既有错误、`check:docs` 导出缺文档 RED；不得把它们伪报为本功能通过。

## 12. 分阶段实施与验收

### 阶段 A：域骨架与岗位/JD

- 新 App、manifest、hooks、贡献、写拦截标记、权限和策略文件。
- Job、JD revision、rubric 及对应 Action。
- AI JD 提案 → 人确认 → 发布链。

### 阶段 B：Intake 与申请主线

- 部门邮箱人工配置、调度同步、手工上传。
- Intake、Candidate、Resume、Application、去重、岗位分配。
- Application 绑定不可变流程版本。

### 阶段 C：解析与筛选

- 数字文本抽取、扫描件 OCR、招聘解析 schema 和版本化快照。
- 失败转人工、rubric 筛选提案、人确认和审计。

### 阶段 D：面试、Offer、入职

- 多轮面试、通知、邮件邀约、独立评价。
- Offer revision/审批/发送/回复。
- 入职清单与完成闭环。

### 阶段 E：完整验收

一条端到端验收必须同时证明：

1. AI 生成 JD 后未自动发布，人工确认后岗位开放。
2. 真实测试邮件与手工上传都能生成正确申请；重复投递不产生重复流程。
3. 无岗位编号邮件进入人工分配；解析失败候选人仍可人工继续。
4. AI 筛选只形成提案，HR 可修改/否决；最终决定可追溯。
5. 至少两轮面试、两名面试官分别评价，越权读取/代评被拒绝。
6. Offer 经审批和发送，接受后才允许入职。
7. 入职清单完整后完成，Application 投影为 hired；重复完成返回原回执。
8. 全流程敏感字段、确认、幂等、流程版本和统一审计符合本设计。
9. 所有新增测试实际执行，门禁失败与既有失败分开报告。

## 13. 开发边界

- 招聘业务代码只 import `shangshu_core.public_api`。
- 跨域只调用 mail/files 公开 Action、Service 或事件，不直接读写其 DocType。
- 不修改 core、公共 BFF、部署或公共契约来“顺便”补招聘能力；确有阻断时单独提交 CORE-CANDIDATE。
- 不复制 `shangshu_flow`，不扩展旧 Node demo 双轨。
- 不修改已执行 migration，不修改已发布流程/Action 定义版本。
- 不以前端隐藏按钮代替服务端授权，不以文档或 mock 结果宣称真实链路已完成。
