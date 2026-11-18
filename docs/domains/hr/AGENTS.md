# HR 中台域开发边界

纯 Node 演示赛道（`shangshu-server/src/capabilities/hr/` + `shangshu-web/js/domains/hr/`）。定位不是"人事档案系统"，而是**员工数据资产层**：把散落在项目、绩效、培训、复盘里的员工事实变成可核实、可引用、可授权的企业资产，并在其上提供数字分身、能力培养、经验沉淀、招聘单位经济与人机分级。

## 只负责什么

- 员工事实与画像：`hr_employees / hr_employee_facts`（一条事实一个来源、一个强度、一个核实人）。
- 数字分身：`hr_twins / hr_twin_queries`（授权范围、期限、边界声明、每次问答留痕）。
- 能力与培养：`hr_skill_models / hr_learning_plans / hr_learning_events`（岗位能力模型、90 天计划、柯氏四级）。
- 经验沉淀：`hr_knowledge / hr_knowledge_versions / hr_knowledge_usages`（SRO 结构、版本化、复用与采纳）。
- 招聘单位经济：`hr_recruit_channels / hr_recruit_snapshots / hr_recruit_recommendations`（渠道成本、漏斗、建议与回测）。
- 人机分级：`hr_autonomy_policies / hr_autonomy_decisions`（动作 → L0–L4、硬护栏、决策台账）。
- 组织编制：`hr_org_units`（部门、编制、在岗）。

## 不负责什么

- 不直读招聘域业务表。跨域取数只调用已注册公共能力：`recruitment.query.applications`、`recruitment.query.jobs`（以及 `recruitment.query.overview / skills`）。能力未注册时返回 `null` 并降级，`efficiency.ts` 的 `tryCapability()` 就是为此存在——**不要**改成直接 import 招聘域私有模块。
- 不写 `execution/events` 以外的审计结构，不改 `core/`：写操作一律走 `registerActionContract` + `requestConfirmation` + `resolveConfirmation`。
- 不做"把员工私聊/邮件正文喂给模型"式的分身。分身只从**已核实事实 + 已发布知识 + 能力标签**检索作答。
- 不做知识正文自动改写。自进化只产生"建议"（promote / revise / archive），人确认后才生成新版本，旧版本永不覆盖。

## 写操作契约（10 个，全部 `confirmation:'human'`）

| 契约 id | 级别 | 确认的是什么 |
|---|---|---|
| `hr.employee.save` | L2 | 建档/字段级更新，不整条替换 |
| `hr.fact.record` | L2 | 一条事实；确认人即背书人（落库即 `verified`） |
| `hr.fact.verify` | L2 | AI 起草、人工核实 |
| `hr.twin.authorize` | L4 | 个人数据边界的让渡（范围 + 期限 + 数据策略） |
| `hr.learning.plan.publish` | L3 | 90 天整包计划（动作、学时、产出） |
| `hr.learning.event` | L2 | 一次学习行为（学时、柯氏层级、是否应用） |
| `hr.knowledge.publish` | L2 | 发布即生成新版本，不覆盖历史 |
| `hr.knowledge.usage` | L2 | 一次复用（场景 + 是否采纳） |
| `hr.recruit.budget.shift` | L3 | 渠道预算迁移（金额不得超过该渠道现有预算） |
| `hr.autonomy.set` | L4 | 分级策略；仅 admin，且只能抬高门槛 |

**契约 schema 校验的是 payload，不是 resolve 入参**（`core/confirm.ts` 在挂卡和确认两处都 `checkAction(contract, actor, payload)`）。所以 `inputSchema` 必须容纳 resolve 富化出来的字段（`employee_id / employee_name / autonomy / mode / expires_at / existing_twin_id / gaps / actions / baseline_skills / hours(数字) / version / title / situation / existing`）。新增契约时先想清楚确认卡上要给人看什么，再写 schema。

## REST 与聊天

- 页面：`/api/hr/*`（`router.ts`）。写操作统一 `settle()` 单跳：resolve → requestConfirmation → resolveConfirmation；角色 `['admin','manager']`。
- 聊天：`chat.ts` 注册 10 个查询能力（`hr.query.*`、`hr.twin.ask`）与 11 个 `ChatToolDef`；跨域读取仍走公共能力。
- 两个都不做"直写"。页面按钮 = 人在确认卡上点了同意，不是绕过确认。

## 前端接入约定（与招聘域一致，勿另起一套）

- 脚本形态：IIFE `(function(global){...})(window)`。
- 注册：`global.shangshuRegisterPages(['hr'], {owner:'com.shangshu.hr', name:'HR 中台', status:'implemented', platform:true, roles})` + `global.shangshuRegisterNav([{id:'hr', name:'HR 中台', ico:'layers', sec:'业务', roles}])`。同 id 跨 owner 注册会被整批拒绝。
- 渲染：`RENDER.hr = async (page) => {...}`。`RENDER` 是 `js/app.js` 里的全局词法 `const`（不是 `window.RENDER`），域脚本直接赋值即可。
- 重挂载：`host.dataset.hrWired` 防重复绑事件；`state.mounted` 防重挂载清空页内状态（换页再回来、AI 导航、生命周期事件都会触发）。
- 样式：`css/domains/hr/hr.css`，只复用 `:root` 令牌（`--sans/--fg/--card/--line/--green/--blue/--amber/--red/--tag/--r...`），不新增令牌；入口 `js/domains/hr/domain-entry.json`（`order: 55`）。

## 验证（改完必须跑）

```
cd shangshu-server
npx tsc --noEmit 2>&1 | Select-String "capabilities/hr"   # 期望 0 行；core 既有错误（chat/config/pi-chat）与本域无关
npm start                                                  # 默认 :3000，可 PORT=3100
```

冒烟顺序（全部应 200，质量率不应出现 `NaN`）：

```
POST /api/login {"username":"admin","password":"admin"}
GET  /api/hr/overview | /employees | /twins | /learning/plans | /knowledge | /recruiting/efficiency | /autonomy
POST /api/hr/learning/plans {"employee":"王芳"}
POST /api/hr/employees/张伟/facts {...}
POST /api/hr/twins/authorize {"employee":"陈晨","expires_days":90}
POST /api/hr/knowledge/capture | /knowledge/:id/publish | /knowledge/:id/usage
POST /api/hr/recruiting/sync | /recommendations/generate | /:id/adopt | /:id/measure
POST /api/hr/autonomy/decide | /autonomy/set
POST /api/hr/twins/张伟/ask   # 薪酬/绩效类问题必须拒答并转本人
```

前端：`node --check shangshu-web/js/domains/hr/hr.js`；条件允许时用 jsdom 或浏览器打开 `/index.html`，逐个点七个 Tab，确认无空白页、无 4xx。

## 已知边界

- 演示数据由 `seed.ts` 幂等写入（按 `source:'demo'` 判断），不连接真实 HRIS。
- 招聘单位经济依赖招聘域种子（渠道 spend/hired/quality_hires）；没有真实 90 天试用期结果时，质量率口径会显得偏乐观，页面上标了"同企业内相对比较"。
- 分身是确定性检索 + 模板拼装，不是自由生成；答不了会转本人，这是设计选择不是缺陷。
- 未做：组织架构图、薪酬带宽、考勤排班、电子签、员工自助端、i18n。
