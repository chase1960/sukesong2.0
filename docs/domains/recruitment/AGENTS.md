# 招聘域开发边界

仅负责岗位、JD 与筛选 rubric 的受管写入与不可变版本（设计阶段 A）。岗位/JD/筛选标准的业务事实唯一权威是本域三个 DocType（`Shangshu Recruitment Job/JD Revision/Screening Rubric`）；流程实例、提案与统一审计属于 `shangshu_core`。跨域只调用 `shangshu_core.public_api`，不导入 core 私有模块或其他业务 App，不直写其他域 DocType。

- 七个写 Action（统一入口 `shangshu_recruitment.service.execute`，初始版本 1.0.0，`effect=write`、`confirmation=required`）：`recruitment.job.save/open/close`、`recruitment.jd.save/publish`、`recruitment.rubric.save/publish`。所有写操作经注册 Action、人工确认、幂等与乐观锁，DocType 有 `recruitment_write` 写闸、禁止删除。
- 角色：`Recruitment Admin`（域配置与全链）、`Recruiter`（岗位/JD/rubric 写入）、`Hiring Manager`（仅所负责岗位读取）；权限按 enterprise 隔离，System Manager 不绕过企业隔离。安装时缺角色则创建。
- revision 规则：可变记录带乐观锁 `revision`，旧版本返回稳定码 `RECRUITMENT_REVISION_CONFLICT`；已发布 JD/rubric 不可覆盖（`RECRUITMENT_REVISION_IMMUTABLE`），修改必须新建 revision；岗位开放前必须同时存在已发布 JD 与 rubric（`RECRUITMENT_JD_OR_RUBRIC_NOT_PUBLISHED`），开放时固化 `current_jd_revision/current_rubric_revision`；rubric 命中受保护属性（性别/民族/婚育/宗教/照片/姓名/联系方式等）即 `RECRUITMENT_DISALLOWED_CRITERION`。
- AI 只能对 `recruitment.jd.save` 形成提案，人工确认后才落库；AI 不得调用 `recruitment.jd.publish` 或 `recruitment.job.open`。
- 阶段 B–E（邮件 intake、候选人/简历/OCR 解析、申请与筛选、面试、Offer、入职）均未实现：本域当前不含邮箱收件、简历解析、OCR 或任何完整招聘 pipeline 能力，不得以文档或 mock 冒充已交付。
- 站点测试（隔离站执行）：`bench --site <test-site> migrate`、`bench --site <test-site> run-tests --app shangshu_recruitment`；0 用例不得视为通过。当前快照无 bench 且缺 `.frappe-deploy/runtime.json`，站点测试 NOT_RUN，与静态门禁分开报告。
- 静态门禁：`python3 -m compileall -q frappe_apps/shangshu_recruitment && SHANGSHU_DOMAIN_POLICY=recruitment npm run check:domain`，另有平台契约、域边界、风格、日志检查；server typecheck 的 `llm.ts`/`pi-chat.ts` 既有错误与本域无关，单独标注。
