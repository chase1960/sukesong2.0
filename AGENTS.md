# 银聆尚书（Shangshu）· 项目阅读指南

> **本文件是仓库第一入口**，写给后续接手的 AI agent 与新工程师：先读这里，再按第 8 节的路径深入。
> 仓库是 **2026-10-30 导出的脱敏快照**（单 commit、无历史、无内部文档目录），原仓库的根 `AGENTS.md` 在导出时被剥离，本文件即按原读序补回该槽位。
> 阅读纪律沿用项目自身要求：文档描述的是**目标与规则**，不代表已实现；一切以代码与机器契约为准。

---

## 0. 三十秒画像

**一句话**：AI 原生业务平台——企业在应用里办业务（表单/待办/流程），AI 只提案、人确认、统一执行、全程审计；工程师以"业务域"扩展而不改内核。

```
shangshu-web/          纯静态 vanilla JS 产品壳（工作台 SPA，无框架、无构建）
      │  同源 /api/* + cookie session（401 → login.html）
shangshu-server/       Node/TypeScript BFF（Express 4）：会话桥、AI/OCR、能力聚合、域资产注入
      │  Frappe upstream http://127.0.0.1:18000
      │  /api/method/shangshu_core.public_api.http.*
frappe_apps/
  shangshu_core/       平台内核（Frappe App）：身份/权限/对象/Action/Event/流程/审计
  其余 6 个 App        业务域（files/finance/mail/orders/warehouse）+ flow（独立特例）
      │  manifest(shangshu-plugin.yml) + hooks 向内核注册"贡献"
   MariaDB + Redis（Frappe 标准栈）｜ Node 侧另用 node:sqlite
```

| 部分 | 规模（导出时） | 形态 |
|---|---|---|
| frappe_apps/ | 7 个 App，约 478 个 .py / 7.8 万行 | Python · Frappe v15 |
| shangshu-server/ | src 113 个 TS / 1.64 万行；测试 275 文件 / 4.01 万行 | Node · Express 4 · tsx 直跑 |
| shangshu-web/ | 约 154 个 js / 4 万行 + excel-univer TS 源 1.9 万行 | 纯静态，无框架无构建 |
| scripts/ + ops/ + tools/ | 约 2.6 万行 | 质量门禁 + DevHost + Docker |
| docs/ | 17 篇 md，约 3100 行 | 规则与契约文档 |

技术栈版本锁定在 `ops/docker/versions.env`：Frappe 15.118.0 / Python 3.12.3 / MariaDB 10.11 / Node 22.13。

---

## 1. 先读：这是"导出快照"，不是完整仓库

1. **单 commit 无历史**：仅 "Initial platform development snapshot"。原团队工作流依赖分支（内核主干叫 **fast**，行业分支按域开发），快照里全部拍平。代码注释中的决策编号（`PKG-xxx-Txx`、`BASE967-xx`）只能 grep 代码找，查不到提交。
2. **域错配**：核心文档（如 `docs/guides/industry-engineer-start.md`）面向 **ip（知识产权）域**撰写，但导出实际携带的示例域是 **orders / warehouse**。读文档时把"ip"脑内替换为"你的业务域"。
3. **文档断链 30 处，`npm run check:docs` 当前 RED**：导出剥离了 `当前进展.md`、根 `AGENTS.md`（本文件已补回）、`docs/README.md`、`docs/guides/kernel-delivery.md`、`docs/plans/`、`docs/reports/`、`docs/legacy/`。这些是既知缺失，不是你弄坏的。
4. **`CLAUDE.md` 是为 Claude Code 自动加载新增的指针文件**，会给 check:docs 增加 1 条"根目录多文件"违规——属预期代价，可删。
5. **server typecheck 已知失败**（导出未修）：`shangshu-server/src/core/infra/llm.ts:24-31` 的 `LlmMessage.content: string | LlmContentPart[]` 联合类型 → `src/infra/pi-chat.ts:103` TS2322（决策编号 PKG-024-T01）。README 已自述此问题。
6. **`shangshu-server/node_modules` 是悬空软链**，指向原开发者机器 `/Users/xiaoyuyyyy/...`。clone 后必须先 `npm install` 才能跑任何 server 命令。
7. **文档叙述滞后于代码**：代码与机器契约的 API 版本已是 **1.20.0**（`frappe_apps/shangshu_core/shangshu_core/contracts.py:5`），而 `docs/guides/public-api-v1.md:498` 把 1.20.0 列为"候选"。以代码+JSON 契约为准。

---

## 2. 系统架构与事实权威

### 2.1 四层职责（改哪层、别改哪层）

| 层 | 职责 | 禁止事项 |
|---|---|---|
| shangshu-web | 产品界面、页面路由、渲染 | 不写业务规则；新域**不得**改 `index.html`/`js/app.js`（见 §5.9） |
| shangshu-server | 会话桥、AI/OCR、外部集成、接口聚合、给前端注入域资产 | 不成为业务事实的第二权威（无双写）；不直写 Frappe 业务数据 |
| shangshu_core | 身份、权限、对象、Action、Event、流程、审计——**唯一内核** | 平台核心不可停用；公共语义变更走 CORE-CANDIDATE 评审 |
| 业务域 App | 领域内对象/动作/页面/流程，经 manifest+hooks 贡献注册 | 只 import `shangshu_core.public_api`；跨域调用须声明依赖 |

### 2.2 事实权威表（谁说了算）

- 业务事实（单据、审批结果、财务记录）→ **Frappe/内核侧唯一权威**；Node 侧只读投影。
- 会话与 AI 对话上下文 → Node 侧（node:sqlite）。
- 原文件与处理结果 → file-center（Frappe 侧）。
- 审计与统一日志 → 内核 `Shangshu Unified Log` 单表，域扩展表挂靠。
- 同一业务事实**禁止双写**（Node 直写 + Frappe 各写一份）——有专门门禁 `scripts/check-file-center-bypass.mjs` 巡查。

### 2.3 两种运行模式（`ops/devhost-frappe/start.mjs`）

- **纯 Node 模式**：不存在 `.frappe-deploy/runtime.json` 时，只起 Node BFF（无数据库/内核，功能受限）。`start.mjs:6` 探测该文件。
- **完整平台模式**：存在 runtime.json 时依次拉起 mariadbd → redis-cache → redis-queue → bench socketio → **bench serve :18000** → bench schedule → bench worker，最后以 `SHANGSHU_PLATFORM_MODE=frappe`、`FRAPPE_UPSTREAM=http://127.0.0.1:18000` 启动 Node（`start.mjs:87-88`）。**fail-closed**：上游不通则拒绝启动，不降级假装可用。
- 完整模式要求 `PATH` 里有 `.frappe-deploy/bin` 下的 mariadbd/redis 可执行文件（原机器布局，快照未含二进制）。
- Docker 全栈：`ops/docker/`，6 个服务（mariadb、redis×2、frappe web :18002 + websocket :19002、node :3000、`mimo-egress` nginx 模型出口网关），源码只读挂载 `/srv/shangshu`。

---

## 3. 仓库地图

### 3.1 frappe_apps/ —— 内核 + 6 个域 App

| App | py 文件/行数 | DocTypes | 定位与依赖 |
|---|---|---|---|
| **shangshu_core** | 228 / 35,581 | 33 | 平台内核（见下方模块地图） |
| shangshu_files | 125 / 31,582 | 6 | 文件中心：原文件、OCR 结果、预览；required_apps 含 core |
| shangshu_mail | 39 / 5,781 | 4 | 邮件域；与 files 集成是**可选**依赖（域策略可关） |
| shangshu_finance | 40 / 2,631 | 9 | 财务域（发票、过账动作）；required_apps 含 files |
| shangshu_flow | 21 / 1,918 | 2 | ⚠️ 特例：**完全不 import core**，用原生 Frappe Workflow，hooks 接管 `/login`，DocType 无前缀——治理上已知的"例外分子"，改动前先读 §5 |
| shangshu_warehouse | 14 / 356 | 2 | 仓储域；依赖 core |
| shangshu_orders | 11 / 458 | 1 | 订单域；依赖 core+warehouse+finance（跨域调用的活例子） |

**内核模块地图**（都在 `frappe_apps/shangshu_core/shangshu_core/`）：

- `public_api/__init__.py` —— **业务代码唯一允许的 import 入口**（114 处 import 对 14 处私有 import，后者 13 处在 files 且惰性加载）。改公共面 = CORE-CANDIDATE。
- `public_api/http.py` —— Frappe whitelisted HTTP 端点，BFF 的上游。
- `identity.py` —— 平台身份：Frappe User ↔ 平台 UUID 绑定。
- `unified_log.py`（809 行）—— 统一日志：单一 `Shangshu Unified Log` 表，5 类 trace，域扩展表，追加式修正。
- `runtime.py` —— 流程运行时：`runtime.py:17` `NODE_TYPES = {human_task, action, ai_select, condition, wait_event, subflow}`；`runtime.py:503` `register_action` 动作注册。
- `domains.py` —— `domains.py:58` 经 `get_hooks("shangshu_domain_contributions")` 收集域贡献。
- `contracts.py` —— `contracts.py:5` `API_VERSION = "1.20.0"`；7 份机器契约见 §4。
- **全局写拦截**：hooks 里 `doc_events: {"*": {… guard_direct_write}}`，所有 DocType 直写都会被拦——业务写入必须走注册的 Action。

**注释文化**：决策编号（`PKG-xxx-Txx`）、绝对日期、`用户拍板` 标记。读懂一条规则时先 grep 相邻注释里的编号。

域内开发细则见 [docs/domains/orders/AGENTS.md](docs/domains/orders/AGENTS.md) 与 [docs/domains/warehouse/AGENTS.md](docs/domains/warehouse/AGENTS.md)。

### 3.2 shangshu-server/ —— Node/TS BFF

- **入口** `src/main.ts`（`npm start` = `tsx src/main.ts`）按固定顺序装配；Express 4。
- `src/adapters/web/server.ts`（2104 行）：静态托管 shangshu-web、`attachFrappeProxy`（`server.ts:106`）、**域资产注入**（`server.ts:177-228`，向 `index.html` 的 `<!-- domain-assets -->` 占位符注入各域 `domain-entry.json` 声明的脚本/样式）。
- `src/adapters/web/platform.ts`（1285 行，约 80 条 `/api/platform/*` 路由）：`frappeGet`/`frappePost` 转发到 `${FRAPPE_UPSTREAM}/api/method/shangshu_core.public_api.http.*`；CSRF 处理在 `platform.ts:234`，登录桥在 `platform.ts:462`。
- **AI 双引擎**：`src/core/chat.ts`（855 行，经典引擎）+ `src/infra/pi-chat.ts`（pi 引擎，基于 `@earendil-works/pi-agent-core`/`pi-ai` 1.1.0，`MAX_TURNS=10`、`MAX_TOOLS=40`）。
- `src/core/infra/llm.ts`：OpenAI 兼容客户端，默认本地 Ollama，`scripts/set-cloud-llm.py` 切云（DashScope）；SSRF 防护拦 `169.254.*`/`100.64.*`。
- **OCR**：`scripts/ocr_server.py`（FastAPI 子进程，:8001；后端可切 mock/dashscope/vllm/qwen-ocr）。
- **技能/能力**：`src/skills/`（invoice-collect、daily-brief、alerts-check 等）与 `src/capabilities/`（chat-tools、doc-gen、skill-sync、各域 tools）。
- **安全纪律**：`confirm.ts`（AI 提案确认卡）、`tool-result-bounds.ts`（工具结果截断防幻觉）、truthfulReply 缺能力如实报告。
- **存储**：`node:sqlite`（会话/对话，Node 侧事实）。
- ⚠️ `node_modules` 悬空软链 + typecheck 已知失败，见 §1.5/§1.6。`.superpowers/sdd/progress.md` 是 SDD 任务台账（Task 1-6 全部 complete）。

### 3.3 shangshu-web/ —— 纯静态产品壳

- **形态**：无框架、无构建。`index.html` 工作台 SPA，约 55 个 `<script>` 标签直接引入。
- **骨架**：`js/app.js`（1640 行：`api()` fetch 封装、hash 路由、`RENDER[]` 分发）→ `js/page-registry.js`（67 行页面注册）。会话用 cookie（`credentials: 'include'`），401 跳 `login.html`。聊天为 SSE（POST `api/chat`）。
- **大模块**：`js/review-center.js`（4355 行，最大）、`js/real-chat.js`（2777）、`js/mail-center.js`（2751）、`js/sheet-center.js`（1222，旧表格轨，**退役中**）。
- **表格双轨**：新轨 `js/domains/excel-univer/`（Univer Sheets，TypeScript+Vite 构建，产物 `excel-univer-entry.js` 约 11MB IIFE 惰性加载）。⚠️ **改 TS 源后必须重建产物并把 `excel-loader.js:16` 的 `?v=e21f11cd58` 换成新版本号**（注释里写明这是"产物第几版"），否则浏览器拿旧缓存。
- **域零侵入接入**：新业务域不改壳，只放 `js/domains/<域>/domain-entry.json`，由 server 注入（见 §3.2）。壳-域隔离有测试守卫：`js/tests/check-shell-no-domain-name.test.mjs`（壳代码不得出现域名）。
- vendor（logicflow/pdfjs/OGL）与 64MB 字体**只读**，勿动。前端测试：`node --test js/tests/`。

### 3.4 scripts/ + ops/ —— 质量门禁与运维

| 门禁/工具 | 作用 | 备注 |
|---|---|---|
| `scripts/check-doc-links.mjs` | 文档链接与目录纪律 | 当前 RED（30 项，导出剥离所致） |
| `scripts/check-domain-boundary.mjs` | 域边界策略审计 | 策略 JSON 在 `scripts/domain-policies/{mail,files}.json`；**退出码 1=禁止 / 2=需评审**；基线分支 `baseline/r967-20261021-integrated` |
| `scripts/check-platform-contract.mjs` | manifest 校验 + 检测 `PRIVATE_CORE_IMPORT`/`CROSS_DOMAIN_DOCTYPE_ACCESS` | docstring 做惰性遮蔽 |
| `scripts/check-style-rules.mjs` / `check-log-tables.mjs` | 样式纪律 / 日志单表纪律（禁新日志表） | |
| `scripts/verify-kernel-baseline.mjs` | 内核基线核验（K0-K4+RC3 已过） | **需真实站点** + `FRAPPE_DB_ROOT_USERNAME/PASSWORD` |
| `scripts/run-baseline-tests.mjs` | 8 组基线测试总入口 | **反假绿**：0 个文件被检查 ≠ 通过；NOT_RUN 与 FAIL 分开报 |
| `scripts/browser-*-2026102*.mjs` | 浏览器验收脚本（粘贴/评审等） | |
| `ops/devhost-frappe/start.mjs` | 开机总控（两种模式） | 见 §2.3 |
| `ops/docker/` + `versions.env` | 全栈容器 | 6 服务，版本锁定 |

### 3.5 shangshu-sync/ —— 技能同步 CLI

285 行 Node CLI，git-bundle 方式把 `~/.claude/skills/` 同步给团队成员；配置在 `~/.shangshu/sync-config.json`。与平台运行无关，是工程效率工具。

### 3.6 docs/ —— 规则与契约文档（17 篇）

| 类别 | 文件 |
|---|---|
| 架构 | [kernel-baseline](docs/architecture/kernel-baseline.md)（**最核心**：四层归属、九段协议、修改边界、事实权威冻结表）· [process-platform](docs/architecture/process-platform.md) · [domain-disable-and-file-center](docs/architecture/domain-disable-and-file-center.md) · [low-code-platform](docs/architecture/low-code-platform.md) · [plugin-and-product-architecture](docs/architecture/plugin-and-product-architecture.md) |
| 指南 | [public-api-v1](docs/guides/public-api-v1.md)（API 权威参考，倒序增量日志）· [industry-engineer-start](docs/guides/industry-engineer-start.md)（行业工程师入职）· [baseline-testing](docs/guides/baseline-testing.md) |
| 标准 | [frontend-design](docs/standards/frontend-design.md) · [visual-baseline](docs/standards/visual-baseline.md) · [workbench-extension-v1](docs/standards/workbench-extension-v1.md) · [unified-log-library](docs/standards/unified-log-library.md) · [workflow-designer](docs/standards/workflow-designer.md) |
| 模板/域 | [CORE-CANDIDATE 模板](docs/templates/CORE-CANDIDATE.md) · [docs/当前方向.md](docs/当前方向.md) · orders/warehouse 两份 AGENTS.md |

有效核心文档簇（互为犄角）：kernel-baseline ↔ industry-engineer-start ↔ public-api-v1 ↔ workbench-extension-v1 ↔ frontend-design ↔ visual-baseline ↔ process-platform。

---

## 4. 公共 API 与机器契约

**import 铁律**：业务代码只允许 `from shangshu_core.public_api import …`。私有模块 import 会被 `check-platform-contract` 抓（`PRIVATE_CORE_IMPORT`）。

机器契约（`frappe_apps/shangshu_core/shangshu_core/contracts/`，7 份，JSON 是最终仲裁）：

| 契约 | 版本 | 内容 |
|---|---|---|
| [platform-api-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/platform-api-v1.json) | api_version 1.20.0 | 平台 API 全量机器契约（scoped data access、partial/proposal-unit review、office integration、domain dependencies 等） |
| [unified-log-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/unified-log-v1.json) | 1.4.0 | 统一日志 |
| [file-center-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/file-center-v1.json) | 1.3.0 | 文件中心 |
| [review-center-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/review-center-v1.json) | 1.3.0 | 评审中心 |
| [device-channel-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/device-channel-v1.json) | 1.0.0 | 设备通道 |
| [loading-state-v1.json](frappe_apps/shangshu_core/shangshu_core/contracts/loading-state-v1.json) | 1.0 | 加载态 |
| [workbench-contribution-v1.schema.json](frappe_apps/shangshu_core/shangshu_core/contracts/workbench-contribution-v1.schema.json) | —（schema） | 工作台贡献 schema |

**版本规则**（kernel-baseline §协议）：SemVer；同 major 内只允许纯新增兼容；升级时做契约快照对比。`public-api-v1.md` 是人读的增量日志（倒序，最新在上），追历史变更去那里。

---

## 5. 红线（写代码前必读）

1. **只走公共入口**：业务 App 只 import `shangshu_core.public_api`；跨域调用必须先 `assert_declared_call` 声明依赖，manifest 的 `required_apps` 与实际依赖**逐字一致**。
2. **无双写**：同一业务事实只有一处权威（§2.2）；Node 侧不直写 Frappe 业务数据。
3. **AI 只提案**：AI 经 `propose_registered_action` 提案 → 人在确认卡上确认 → 统一执行入口落库。AI Tool 只是 Action 的受管投影；不存在第二条 AI 直写通道。
4. **高风险动作内核强制**：确认、幂等、审计三件套由内核兜底，不靠业务域自觉。
5. **审计不可变**：统一日志单表、只追加；修正=追加反向记录；禁止 UPDATE/DELETE；不许新建平行日志表（`check:logs` 巡查）。
6. **已执行的迁移不可修改**，只允许追加新迁移。
7. **平台核心不可停用**；业务域停用必须保留数据。
8. **公共语义变更走 CORE-CANDIDATE**：先提案（模板在 `docs/templates/CORE-CANDIDATE.md`）→ 进 fast 主干 → 行业分支合并审核。默认允许域内自由改；CORE-CANDIDATE 清单内的要评审；永久禁止清单见 kernel-baseline §8。
9. **前端壳-域隔离**：新域不碰 `index.html`/`app.js`，走 `domain-entry.json` + server 注入；壳代码不得出现域名（有测试）；sheet 新功能进 excel-univer，不改 `sheet-center.js` 旧轨。
10. **绕不过全局写拦截**：`doc_events "*"` 的 `guard_direct_write` 拦所有 DocType 直写，业务写入必须走注册 Action。

---

## 6. 环境与常用命令

```bash
# 0) clone 后第一件事（server 的 node_modules 是悬空软链）
npm install                # 根 postinstall 会转发安装 shangshu-server

# 1) 启动 / 开发
npm run dev                # = node ops/devhost-frappe/start.mjs（两种模式见 §2.3）
npm run seed               # 灌种子数据

# 2) 测试
npm run test:baseline      # 8 组基线测试（反假绿设计）
node --test shangshu-web/js/tests/            # 前端
npm --prefix shangshu-sync test               # sync CLI

# 3) 改代码后的门禁链（提交前跑齐）
npm run check:domain       # 域边界；默认 mail 策略，换域: SHANGSHU_DOMAIN_POLICY=files
npm run check:platform-contract
npm run test:platform-contract
npm run test:domain-boundary
npm run check:style && npm run check:logs
npm --prefix shangshu-server run typecheck    # ⚠️ 当前已知失败（§1.5），判断是否与你有关
npm run check:docs         # ⚠️ 当前 RED 30 项（§1.3），判断是否与你有关

# 4) 需要真实站点的核验
npm run verify:kernel-baseline    # 需 FRAPPE_DB_ROOT_USERNAME/PASSWORD

# 5) excel-univer 改 TS 源后
npm --prefix shangshu-web/js/domains/excel-univer run build
# 然后把 js/domains/excel-univer/excel-loader.js:16 的 ?v= 换成新值
```

LLM 默认本地 Ollama；切云模型用 `python3 shangshu-server/scripts/set-cloud-llm.py`；OCR 服务 `shangshu-server/scripts/ocr_server.py`（:8001）。

---

## 7. 已知坑点清单（编号引用，出错先对表）

| # | 坑 | 详情/处置 |
|---|---|---|
| 1 | node_modules 悬空软链 | `shangshu-server/node_modules` → 原开发者机器路径；**必须重装** |
| 2 | typecheck 已知失败 | `llm.ts:24-31` 联合类型 → `pi-chat.ts:103`（PKG-024-T01）；导出时未修 |
| 3 | check:docs RED 30 项 | 导出剥离文档所致（§1.3）；CLAUDE.md 再 +1；别试图"修好"它除非你打算重建全部缺失文档 |
| 4 | 域错配 | 文档写 ip 域，代码带 orders/warehouse（§1.2） |
| 5 | 文档版本滞后 | 代码/契约 1.20.0 vs 文档"候选"（§1.7） |
| 6 | excel-univer 是产物 | 改 TS 不重建+不 bump `?v=` = 白改（§3.3） |
| 7 | sheet 双轨 | `sheet-center.js` 旧轨退役中，别往里加功能 |
| 8 | flow 是特例 | 不 import core、原生 Workflow、接管 `/login`、DocType 无前缀（§3.1） |
| 9 | 无 git 历史 | 决策编号靠 grep 代码注释；分支模型（fast/行业分支）只剩文档描述 |
| 10 | 仓库体积异常 | 64MB 字体 + 11MB univer 产物 + vendor；这些是只读资产 |
| 11 | BFF 依赖本机服务 | Ollama（LLM）、:8001（OCR）不在则相关功能降级 |
| 12 | DevHost 完整模式要二进制 | 需要 `.frappe-deploy/bin` 的 mariadbd/redis；快照未含，跑不起完整模式属正常 |

---

## 8. 按任务的阅读路径

| 你要做什么 | 读这些（按序） |
|---|---|
| 了解产品与方向 | [README](README.md) → [项目总览](项目总览.md) → [长期路线](长期路线.md) → [docs/当前方向.md](docs/当前方向.md) |
| 理解架构与协议 | [kernel-baseline](docs/architecture/kernel-baseline.md) → [public-api-v1](docs/guides/public-api-v1.md) → §4 的 7 份 JSON 契约 → [unified-log-library](docs/standards/unified-log-library.md) |
| 开发一个业务域（后端） | [industry-engineer-start](docs/guides/industry-engineer-start.md) → [orders AGENTS](docs/domains/orders/AGENTS.md)（当模板看） → §5 红线 → §6 门禁链 |
| 改前端 | [frontend-design](docs/standards/frontend-design.md) → [visual-baseline](docs/standards/visual-baseline.md) → [workbench-extension-v1](docs/standards/workbench-extension-v1.md) → `js/app.js` + `js/page-registry.js` → 坑 #6/#7 |
| 改 AI/聊天/OCR | §3.2（chat.ts / pi-chat.ts / llm.ts / ocr_server.py）→ 坑 #2/#11 |
| 跑测试与核验 | [baseline-testing](docs/guides/baseline-testing.md) → §6 → `scripts/run-baseline-tests.mjs` |
| 动内核公共面 | [kernel-baseline §8 修改边界](docs/architecture/kernel-baseline.md) → [CORE-CANDIDATE 模板](docs/templates/CORE-CANDIDATE.md) → `public_api/__init__.py` |

---

## 9. 术语表

| 术语 | 含义 |
|---|---|
| **fast** | 内核主干分支名（"快"）；公共能力变更先进 fast，再向行业分支合并 |
| **行业分支 / 业务域** | 工程师在独立 App 内开发领域能力，经 manifest+hooks 接入 |
| **CORE-CANDIDATE** | 公共能力变更的评审申请（模板在 docs/templates/） |
| **FDE** | 原团队对行业/领域工程师的称呼（field/domain engineer） |
| **manifest** | `shangshu-plugin.yml`：域 App 的声明文件，`required_apps` 必须与实际依赖逐字一致 |
| **贡献（contribution）** | 域经 hooks 向内核注册的对象/动作/页面/工作台项（`get_hooks("shangshu_domain_contributions")`） |
| **BFF** | shangshu-server：为前端聚合接口、承载 AI/OCR 的 Node 中间层 |
| **统一日志** | 单一 `Shangshu Unified Log` 表 + 5 类 trace + 域扩展表，追加式 |
| **确认卡** | AI 提案的人类确认 UI，对应内核强制确认 |
| **数字员工** | 有持久职责/授权/工作记录的 AI 执行者（阶段 2 目标，待验证） |
| **反假绿** | 测试纪律：0 文件被检 ≠ 通过；NOT_RUN 与 FAIL 分开呈现 |
| **SDD** | spec-driven development；台账在 `shangshu-server/.superpowers/sdd/progress.md` |
| **DocType / bench** | Frappe 框架的 ORM 实体 / Frappe CLI 工具名 |

---

*本指南由外部 agent 于 2026-10-31 基于导出快照全量调研撰写；文中行号以当时快照为准。发现出入请以代码为准并更新本文件。*
