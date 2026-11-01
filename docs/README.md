# 文档入口

尚书的文档按“产品事实 → 架构契约 → 开发指南 → 设计标准 → 阶段计划”组织。目标、候选方案和已交付能力分开记录；以 [当前进展](../当前进展.md) 作为本地验证状态的入口。

- [项目总览](../项目总览.md)：产品边界、用户路径与不可变原则。
- [长期路线](../长期路线.md)：阶段目标、验收方式和不做事项。
- [当前进展](../当前进展.md)：当前分支、已完成能力、验证证据和未完成边界。
- [内核基线](architecture/kernel-baseline.md)：身份、权限、Action、流程、审计和公共 API 的约束。
- [流程平台](architecture/process-platform.md)：应用、对象、动作、流程与待办的关系。
- [公共 API v1](guides/public-api-v1.md)：跨域可依赖的公共语义与版本边界。
- [工作流设计器标准](standards/workflow-designer.md)：流程编辑和运行时的产品约束。
- [可靠执行与数字员工计划](superpowers/plans/2026-11-01-reliability-and-digital-worker.md)：本阶段范围、验收指标和明确不做事项。

真实 Frappe 站点、浏览器、生产和外部模型验证必须另行提供运行环境与证据；本地 Node/SQLite 测试不能替代这些验证。
