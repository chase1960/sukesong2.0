# 银聆尚书（Shangshu）· Claude Code 入口

> 完整阅读指南在 **[AGENTS.md](AGENTS.md)**（仓库第一入口：架构、子系统地图、契约、红线、坑点、阅读路径）。本文件只放每次会话都需要的东西。

**这是什么**：AI 原生业务平台的导出快照（2026-10-30，单 commit 无历史）。四层：`shangshu-web`（纯静态壳）→ `shangshu-server`（Node/TS BFF，AI/OCR/聚合）→ `frappe_apps/shangshu_core`（Frappe 内核：身份/权限/对象/Action/流程/审计）→ 6 个业务域 App。技术栈锁定见 `ops/docker/versions.env`。

**先跑**（先阅读 [`docs/README.md`](docs/README.md) 和 [`当前进展.md`](当前进展.md)；依赖已由当前工作区提供，仍可按需重新安装）：
```bash
npm install && npm run dev        # 启动；.frappe-deploy/runtime.json 决定纯 Node / 完整 Frappe 模式
npm run test:baseline             # 8 组基线测试（反假绿）
```

**红线**：业务代码只 import `shangshu_core.public_api`｜同一业务事实无双写｜AI 只提案、人确认、统一执行、审计不可变｜公共语义变更走 CORE-CANDIDATE（docs/templates/）｜前端新域不碰 index.html/app.js，走 domain-entry.json｜excel-univer 改 TS 后必须重建产物并 bump `?v=`。

**当前事实与边界**：server typecheck 已在当前开发分支通过；`check:docs` 仍可能因导出剥离的历史文档而 RED；真实 Frappe 站点测试在缺少 `.frappe-deploy/runtime.json` 时记为 NOT_RUN。文档中的历史快照问题不要改写成当前代码事实。完整坑点表见 AGENTS.md §7。

**改代码后的门禁链**：`check:domain`（退出码 1=禁止/2=需评审）→ `check:platform-contract` → `test:platform-contract` → `test:domain-boundary` → server typecheck。
