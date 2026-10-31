# 银聆尚书黑客松项目

私有开发协作仓库，基于 2026-10-30 开发源码导出。保留通用内核、表格、文件、邮件、财务等业务扩展以及统一日志能力。

## 结构

- `frappe_apps/`：Frappe 内核与可选业务域。
- `shangshu-server/`：Node / TypeScript BFF、AI 与外部集成。
- `shangshu-web/`：静态前端与表格编辑器。
- `scripts/`：契约检查和测试。
- `ops/`：本地容器与运行工具。
- `docs/`：架构、公共 API 与工程规范。

## 开始研发

先阅读 `docs/architecture/kernel-baseline.md`、`docs/guides/public-api-v1.md` 和 `docs/guides/kernel-delivery.md`。业务扩展通过公共 Action / Service / Event 接入，复用身份、权限、确认、版本、幂等与审计。

安装：`npm install`。启动：`npm run dev`。完整平台需要按 ops 指南准备 Frappe、MariaDB 和 Redis；仅启动 Node 不等于完整平台就绪。

## 统一日志与经验沉淀

统一日志记录操作事实，正式业务值仍以受管记录为准。入口实现位于 `frappe_apps/shangshu_core/shangshu_core/unified_log.py`，机器契约位于同级 `contracts/unified-log-v1.json`。使用公共审计查询能力按当前身份授权读取，不直接查询数据库绕过权限。日志纠错通过追加事件完成。

经验沉淀是待研发方向：授权事实检索 → 有证据引用的经验候选 → 人工审核 → 版本化经验 → 相似场景建议。经验不得自行改变业务事实或扩大访问范围。

## 版本与验证边界

本仓库是移除特定行业扩展和客户资料后的独立源码快照，不包含原 Git 历史、客户业务数据、运行库或凭据。旧部署记录与客户验收证据不随导出携带。

会话证据关联包含开发候选能力，尚未完成主线合入、部署及人工验收；并发、日志及大表性能也保留未完成验证边界。导出后须在独立测试环境重新验证，不宣称生产可用。

## 本次导出检查

公共 manifest / API 契约检查通过；统一日志检查 0 违反；Python 语法检查通过。服务端类型检查未通过，报错与原始开发副本完全一致，涉及 AI 消息 content 联合类型，未在导出中修复。未执行完整实库、浏览器或部署验收。
