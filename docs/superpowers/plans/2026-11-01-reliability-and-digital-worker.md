# 可靠执行与数字员工：阶段计划

日期：2026-11-01
分支：`codex/hr-evidence-workflow`

## 目标

把尚书当前最重要的通用缺口收敛为两个可复验结果：

1. 新流程能够在已有权限、能力效果、事务和审计约束下可靠运行、等待、恢复和交接。
2. 一个数字员工拥有持久职责、明确能力白名单、可重复派发的流程和失败后交给人的路径。

数字员工是现有流程平台的责任投影，不另造一套任务、Action 或审计系统。

## 已实现范围

- `cognition.worker_profiles` 保存职责、流程绑定、能力白名单、负责人和状态。
- `execution.worker_runs` 保存运行投影，真实步骤仍在 `execution.flow_runs`。
- 创建配置时验证已发布流程、完整能力白名单、能力效果和写入/提案前置人工审批。
- 管理员创建配置；可信人工派发；运行状态可查询、暂停、交接和恢复。
- 流程记录保存派发者作为 `initiator`；交接修改可信流程 actor，不修改流程快照或业务输入。
- 事件统一写入 `execution.events`，通过现有追加式事件链审计。
- 测试覆盖管理员权限、非法配置、能力白名单、无审批写流程、完成派发、暂停交接恢复和非人工交接拒绝。

## 明确不做

- 不重写静态前端，不把新域继续堆进 `index.html` 或 `js/app.js`。
- 不大规模重构 Frappe，不虚构站点或生产部署已通过。
- 不新增平行 Action、任务、事实库或审计表。
- 不给 AI 自主授予权限，不绕过人工确认执行高风险写入。
- 不在没有真实业务能力和运行证据时预置“万能数字员工”或宣传自动化完成。
- 不把 Node demo、单元测试或计划文档当成招聘生产事实源。

## 验收指标

- 配置校验：非法 worker id、未发布流程、能力缺失、未注册能力和无前置审批的写入流程均明确拒绝。
- 执行一致性：派发后 `worker_runs.flow_run_id` 必须指向同一条 `flow_runs`；完成、等待和失败状态可从流程事实同步。
- 权限边界：只有管理员配置；运行负责人或管理员操作；交接对象必须是可信人工 actor；交接后原负责人不能恢复。
- 可接管性：等待中的运行可以暂停、交接，接手人可以恢复并完成原流程；流程快照、输入和原有审批轨迹保持不变。
- 审计完整性：配置、派发、交接事件进入既有 `execution.events`，不写第二套日志。
- 工程门禁：TypeScript、数字员工测试、招聘回归、平台契约、域边界和 `git diff --check` 均以命令输出为准。

## 真实环境边界

当前没有 `.frappe-deploy/runtime.json`，因此 Frappe 真实站点测试为 `NOT_RUN`。本阶段的 Node/SQLite 证据只证明内核闭环；Frappe 站点、浏览器、生产数据、外部邮箱和模型服务需要独立环境与人工验收。

## 验证命令

```powershell
$node='C:\Users\樊嵘\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node 'shangshu-server/node_modules/typescript/bin/tsc' -p shangshu-server/tsconfig.json --noEmit
Push-Location shangshu-server
& $node --import tsx --test --test-concurrency=1 --test-timeout=30000 tests/core/worker-runtime.test.ts
& $node --import tsx --test --test-concurrency=1 --test-timeout=30000 tests/core/recruitment-evidence.test.ts
Pop-Location
node scripts/check-platform-contract.mjs
node --test scripts/tests/check-platform-contract.test.mjs
foreach ($domain in @('files','mail','recruitment')) { node scripts/check-domain-boundary.mjs --policy scripts/domain-policies/$domain.json --base HEAD --full-tree }
git diff --check
```
