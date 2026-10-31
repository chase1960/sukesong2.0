# 行业工程师开工清单

> **文档状态：GUIDE（现行行业开发操作入口）**
>
> 适用对象：在 `industry/ip-fde` 或其 `feature/ip-*` 分支开发知识产权 FDE 的工程师与 AI Agent。本文是开工操作入口；架构事实以根 `AGENTS.md`、领域 `docs/domains/ip/AGENTS.md`、`public_api v1` 文档和机器门禁为准。

## 1. 先确认你拿到的是正确分支

```bash
git fetch origin
git switch industry/ip-fde
git pull --ff-only origin industry/ip-fde
git switch -c feature/ip-<short-name>
```

禁止从 `main`、`node`、`demo/*` 或 `fast` 直接开发知识产权业务。`fast` 是内核线；`industry/ip-fde` 是行业集成线；日常功能进入 `feature/ip-*` 后再合入行业线。

开工前按顺序阅读：

1. 根 [`AGENTS.md`](../../AGENTS.md)。
2. [`当前方向.md`](../当前方向.md)。
3. 本文。
4. 行业分支中的 `docs/domains/ip/AGENTS.md`、`MERGE_POLICY.md` 和 `README.md`。
5. [`2026-09-02-public-api-v1-reference.md`](./public-api-v1.md)。
6. 涉及工作台卡片时再读 [`2026-09-02-工作台组件与布局扩展协议-v1.md`](../standards/workbench-extension-v1.md)。

## 2. 代码所有权与物理边界

| 区域 | 所有者 | 行业功能能否直接修改 |
|---|---|---|
| `frappe_apps/shangshu_core/**` | 平台内核 | **不能**；缺能力提 CORE-CANDIDATE |
| `frappe_apps/shangshu_ip/**` | 知识产权域 | **可以**；对象、动作、流程、权限、迁移和领域服务的主目录 |
| `shangshu-server/src/domains/ip/**` | IP 的 BFF/外部适配 | **可以**；不能成为第二业务事实库 |
| `shangshu-web/js/domains/ip/**`、`css/domains/ip/**` | IP 前端贡献 | **可以**；只能挂入公共插槽，不能复制产品壳 |
| `docs/domains/ip/**` | IP 规范与证据 | **可以**；策略文件和历史迁移只能追加，不能绕过检查 |
| `frappe_apps/shangshu_finance/**` | 财务域 | **禁止**；跨域调用公开 Action/Service/Event |
| `frappe_apps/shangshu_flow/**` | 历史兼容 App | **禁止复制或依赖内部实现** |
| `shangshu-server/src/adapters/**`、`src/core/**` | 公共 BFF/兼容层 | **不能随行业功能一起改** |
| `shangshu-web/js/app.js`、`css/platform.css` | 全局产品壳 | **不能随行业功能一起改** |
| `ops/**` | 公共部署 | **不能随行业功能一起改** |

`shangshu_finance` 是首个真实可选业务域，不属于内核，也不是 IP 域可复制的公共实现。`shangshu_flow` 只承担历史兼容，不是新业务 App 模板。

## 3. 正常需求应该落在哪里

- 业务记录与字段：IP App 自有 DocType，资源 ID 使用 `ip.*` 或 `com.shangshu.ip.*`。
- 业务不变量：IP 领域服务；不放进页面脚本，不写入 core。
- 写操作：注册版本化 Action；声明权限、确认、幂等、审计和错误。
- AI 能力：把受管 Action 投影为 Tool；AI 只产提案，确认后由 Action 写入。
- 流程：通过 `shangshu_core.public_api` 注册/发布，实例绑定不可变版本。
- 页面与工作台：只提交领域贡献；不得为了出现一个入口而修改全局导航或公共聚合器。
- OCR、模型或外部系统：实现放 IP 外部适配目录，通过公共 Action/Tool 调用；结果回写仍走领域服务和内核执行面。

新平台业务事实以 Frappe + `shangshu_core`/业务 App 为权威。Node 只做 BFF、AI/OCR/外部适配和明确的旧能力兼容；同一事实禁止在 Node StateStore 与 Frappe 双写。

## 4. 唯一允许依赖的内核入口

Python 业务代码只允许从下列入口导入：

```python
from shangshu_core.public_api import ...
```

禁止导入 `shangshu_core.runtime`、`domains`、`identity`、`database`、`immutable` 等私有模块。缺少公开能力不是绕过边界的理由，而是 CORE-CANDIDATE 的触发条件。

## 5. 什么情况必须立即停下

出现任一情况，停止当前行业提交，不要先写临时绕过：

- 必须修改 core、公共身份权限、流程运行时、公共 BFF、全局产品壳或部署代码才能继续。
- 想导入 core 私有函数、直接读写其他域 DocType，或复制 finance/flow 实现。
- 想扩大 `config/domain-policy.ip.json` allowlist、关闭检查或修改领域 Agent 规则。
- 计划提供给财务、文件、合同等其他领域复用的公共能力。
- 需要破坏 `platform_api 1.x`、修改已发布流程版本或改写已执行迁移。

此时复制 [`templates/CORE-CANDIDATE.md`](../templates/CORE-CANDIDATE.md)，把真实阻断、最小公共语义、兼容迁移和测试写清楚。公共改动先在 `fast` 独立审核、测试和提交，再普通 merge 回行业分支；行业业务提交不得夹带公共改动。

## 6. 每次提交的机器门禁

在 `feature/ip-*` 根目录运行：

```bash
npm run test:domain-boundary
npm run check:domain:ip
npm run check:platform-contract
npm run test:platform-contract
npm --prefix shangshu-server run typecheck
```

涉及 DocType、权限、流程、Action 或 migration 时，还必须在安装了 `shangshu_ip` 的隔离站运行：

```bash
bench --site <test-site> migrate
bench --site <test-site> run-tests --app shangshu_ip
```

边界检查返回非零即停止：`forbidden` 不能合并；`review` 必须拆为 CORE-CANDIDATE。不得通过改策略文件、改基线分支或在同一提交里“顺便修 core”把检查变绿。

## 7. 功能完成定义

一个行业功能只有同时满足下列条件才可提交审核：

- 业务对象、动作、流程、权限和 AI Tool 的 owner/命名空间明确。
- 服务端重新授权；前端隐藏按钮不作为权限。
- 写入有确认、幂等和审计；敏感字段不进日志或 AI 明文上下文。
- 只写本域事实；跨域只走公开契约。
- 新 migration 追加且可重复执行；不修改已发布 patch/流程版本。
- 有正常链、拒绝链、越权链和升级/重复执行测试。
- 上述机器门禁与 IP App 测试通过。
- `docs/domains/ip/**` 记录新资源、真实限制和验证证据。

## 8. 内核更新与合并方向

```text
feature/ip-* → industry/ip-fde
fast → industry/ip-fde
CORE-CANDIDATE → fast → industry/ip-fde
```

共享行业分支只做普通 merge，不 rebase、不改写历史；行业功能不得整体反向合入 `fast`。合并 `fast` 后优先解决公共协议/领域规则冲突，并重跑平台契约、领域边界和受影响业务链。

## 9. 当前真实边界

当前基线已经支持行业工程师按 Frappe App 形态开发并在未来转成正式插件，而不用搬对象、动作、流程、权限或业务服务。尚未完成的是动态插件市场、签名、远程安装、完整卸载、完整页面/表单低代码设计器和多企业运行；这些不是本轮 IP 开发需要自行补进业务域的内容。

开始第一项业务功能前，先以行业分支现有“商标申请立案”链跑通环境和测试；它是边界验证夹具，不代表完整 FDE 产品范围。
