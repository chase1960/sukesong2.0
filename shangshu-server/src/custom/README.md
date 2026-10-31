# 定制层（custom/）

按客户/按需插上来的模块放这里。**每个模块一个目录，只能通过 `register*` 接入内核，绝不改 `core/`。**

一个自洽定制模块的形态（开发约定 §13）：

```
custom/<模块>/
├─ backend/        # 可能是"一个完整的软件"（邮箱脚本、爬虫…）
├─ page/           # 可选页面
└─ register.ts     # 唯一对外契约：registerCapability / registerTrigger / registerRoute
```

提升路径：FDE 发现痛点 → 做定制模块交付（不动内核）→ 多客户验证有用 → 提升进 `capabilities/`/`skills/` 变通用能力 → 最终进 Skill 市场。

> 当前为空。第一个候选：把"发票收集"在特定客户的特殊规则（如某供应商发票需双人审）做成定制模块挂在这里。
