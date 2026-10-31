# 尚书低代码流程设计器重构规范（实施中）

> **文档状态：ROADMAP（部分已实现；用于后续设计器验收）**
>
> **状态：用户已于 2026-09-01 批准直接实现。P0 第一阶段已经落地；未完成项仍按本文验收，不因有画布而提前宣称全部完成。**
>
> **适用分支：`fast`。** 不修改 `node`、`main`、冻结的 `demo/roadshow-0820`。
> **目标：** 把当前“流程拓扑查看器”重构为业务实施人员可以手动搭建、理解、测试和发布的低代码流程设计器，并保留 AI 以受控提案参与每一步设计。

当前已落地：Graph V2、节点新增/移动/拉线/复制/删除、撤销重做、结构化单条件与字段来源、角色/注册动作/AI 候选配置、草稿恢复、发布前校验和只读路径模拟。仍待继续：复合 AND/OR 条件、线上插入、逐节点输入输出调试、版本 diff、小地图，以及表单/数据/权限三个视图的完整编辑器。

## 1. P0 实施前事实与当前状态

P0 实施前，`#/flowdesign` 的“流程图”只具备：

- 按后端 `Process Definition.graph` 显示节点、分支、汇合与退回路径；
- 点击节点修改名称；
- 保存整份 graph 草稿、请求 AI 整图提案和发布版本。

P0 实施前不具备：

- 新增、删除、拖动、复制节点；
- 从端口拉线、删除连线或调整分支；
- 手动修改条件及查看条件数据来源；
- 修改节点类型、动作、角色、表单、字段映射和 AI 候选工具；
- 撤销/重做、草稿差异、路径模拟和逐节点测试。

上述缺口中的基础图编辑、结构化条件、资源配置、校验和只读模拟已在 P0 第一阶段补齐；当前状态以文首“当前已落地/仍待继续”为准。完整低代码设计器仍未完成，尤其不能把尚缺的复合条件、逐节点调试、版本差异和表单/数据/权限编辑器描述成已交付。

截图中的“有文字层 / 扫描件”来自种子里的内部条件：

```text
file.has_text_layer == true
file.has_text_layer == false
```

P0 已把这两个已知条件迁移为结构化字段来源；这段旧表达式继续保留用于说明迁移来源。未知条件如果不能证明对象、字段和生产节点，仍必须阻止发布。

## 2. 合格标准

一个合格的尚书低代码流程设计器必须让实施人员不写代码完成：

1. 从节点库拖入人工、动作、条件、AI、等待、子流程和结束节点；
2. 拖动节点、拉线、删除、复制、撤销和重做；
3. 点击节点配置办理人、表单、动作、输入输出、超时和异常；
4. 点击连线配置来源字段、运算符、比较值、优先级和默认分支；
5. 从对象、字段、ActionDef、ToolDef、角色和已发布子流程注册表选择资源；
6. 在发布前验证结构、权限、数据、工具安全和所有路径；
7. 用样例数据模拟通过、退回、重提和异常路径；
8. 保存草稿并发布不可变版本，旧实例继续绑定旧版本；
9. 让 AI 生成结构化变更提案，但人工可逐项审阅、应用、撤销和再编辑；
10. 所有运行端页面继续由同一份元数据生成。

### 2.1 成熟低代码平台对标（2026-09-01）

本规范不是从当前代码反推出来的功能清单，而是先对标成熟产品的共同能力，再结合尚书的元数据、企业权限、AI 工具治理和财务审计约束取舍。下表只参考官方公开的产品能力和交互，**不复制其代码、素材、品牌或受限许可组件**。

| 对标产品 | 官方资料体现的成熟能力 | 尚书采用 | 尚书不照搬 |
|---|---|---|---|
| Power Automate | 紧凑节点卡片+配置面板；动态内容和表达式选择器；撤销/重做、Flow Checker、草稿/发布、手动测试、静态模拟输出；缩放、适应、小地图、搜索与布局切换 | 作为主编辑器骨架：顶部命令栏、中央画布、按需属性面板、显式校验与测试 | 不照搬微软连接器体系和品牌布局；不向实施人员开放任意代码 |
| n8n | 可视化引用前序节点数据；输入/输出检查器；从运行历史加载数据回画布调试；按保存版或原始版重试；子流程、异常和多分支 | 作为“数据从哪来、本节点产生了什么”和执行调试的基准 | 不提供通用 Code、Execute Command、SQL、本地文件或无管治 HTTP 节点；安全审计必须覆盖危险工具 |
| NocoBase | 审批与通用人工节点分离；或签/会签/投票，并行/串行，通过/拒绝/退回；发起表单、待办卡片和记录快照；AI 结构化输出可进入人工审核 | 作为企业审批节点、运行端和 AI 结果确认的基准 | 不把其商业插件作为依赖；不把审批运行界面塞回设计器 |
| Joget | Process/Form/Datalist/Userview 分离建模；工具映射到插件；流程试跑；发起流程入口和 Inbox 作为发布后运行界面；表单/列表/页面分层权限 | 作为“设计器不等于业务办理页”和插件资源映射的基准 | 不恢复为多套孤立 Builder；五视图共享同一份尚书元数据 |

官方参考：

- [Power Automate 云流程设计器](https://learn.microsoft.com/en-us/power-automate/flows-designer)
- [Power Automate 条件编辑](https://learn.microsoft.com/en-us/power-automate/add-condition)
- [n8n 数据映射界面](https://docs.n8n.io/data/data-mapping/data-mapping-ui/)
- [n8n 执行历史与重试](https://docs.n8n.io/workflows/executions/all-executions/)
- [n8n 安全审计](https://docs.n8n.io/hosting/securing/security-audit/)
- [NocoBase 审批节点](https://docs.nocobase.com/workflow/nodes/approval)
- [NocoBase AI 节点结构化输出与审核](https://docs.nocobase.com/ai-employees/workflow/nodes/employee/configuration)
- [Joget Process Builder 与运行端接入](https://confluence.joget.org/community/display/KBv6/Designing%2Ba%2BProcess)

### 2.2 尚书功能优先级

| 级别 | 能力 | 判定 |
|---|---|---|
| P0：能称为低代码设计器 | 节点库，拖入/线上“+”插入，移动/连线/复制/删除，撤销/重做，节点和条件属性面板，动态数据选择器，草稿保存，结构校验，手动模拟 | 未全部完成前，只能叫“流程查看” |
| P1：可交付企业使用 | 表单/数据/权限联动，不可变发布版，执行历史与节点输入输出，超时/重试/异常，或签/会签/串并行，退回/撤回/重提，子流程，运行端待办 | 以真实财务链路验收，不以截图验收 |
| P2：规模化实施 | 模拟数据固定/回放，版本 diff，流程搜索/小地图，可复用流程片段，多人冲突处理，插件资源依赖分析，AI 逐项提案与测试生成 | 在 P0/P1 协议稳定后进入 |

所以本轮的交互基准不是“画出一张像流程图的图”，而是：**像 Power Automate 一样能配置，像 n8n 一样能追数据，像 NocoBase 一样能办审批，像 Joget 一样分清设计端和运行端，但所有能力都经过尚书注册表、权限、审计和 AI 确认闸门。**

## 3. 产品结构与页面布局

仍保留五个设计视图：

| 视图 | 必须可编辑的内容 |
|---|---|
| 流程图 | 节点、连线、条件、异常出口、节点位置 |
| 表单 | 发起表单、节点办理表单、字段分组、必填/只读/隐藏 |
| 数据流转 | 节点输入、输出、业务对象字段和写入闸门 |
| 办理权限 | 参与人规则、角色、记录范围、字段读写范围、委托/会签预留 |
| 发布测试 | 校验、模拟、版本差异、依赖冻结、发布记录 |

流程图视图采用以下紧凑布局：

```text
顶部：返回 / 流程名 / 撤销 / 重做 / 校验 / 模拟 / 保存草稿 / 发布
左侧：可折叠节点库
中部：可拖拽流程画布
右侧：选中节点或连线的属性面板
底部：按需展开的节点输入/输出、执行轨迹、校验结果和 AI 变更面板
```

规则：

- 默认只显示画布，不放说明段落；配置面板只在选中元素时出现；
- 节点卡只显示业务名称、类型、办理人/动作和异常状态；
- 条件文字显示业务摘要，内部路径进入属性面板的“高级信息”；
- 桌面优先完整编辑；390px 保证可查看、选中和改基础属性，复杂拉线允许提示使用桌面端；
- 不改尚书全局侧栏、顶栏、工作台、消息和任务风格。

## 4. 画布技术边界

Frappe core 继续作为对象、权限、流程运行和版本数据底座，但 Frappe Desk Workflow Builder 不作为产品前端，也不作为完整 AI 流程权威。

前端画布必须通过可替换的 `GraphCanvasAdapter` 接入。第一阶段可复用仓库已有 LogicFlow 作为**纯画布组件**，仅负责节点/连线、拖拽、缩放、框选和历史命令；它不是低代码平台，也不能拥有业务元数据。若实测其自定义端口、循环边或可访问性不达标，再在适配层后替换 Vue Flow，不改变后端协议。

画布适配器只允许输入和输出标准图操作：

```ts
type GraphCommand =
  | { type: "node.add"; node: ProcessNode }
  | { type: "node.move"; node_id: string; position: Position }
  | { type: "node.update"; node_id: string; patch: object }
  | { type: "node.remove"; node_id: string }
  | { type: "edge.add"; edge: ProcessEdge }
  | { type: "edge.update"; edge_id: string; patch: object }
  | { type: "edge.remove"; edge_id: string };
```

禁止把 LogicFlow/Vue Flow 私有 JSON 保存成公共流程定义。持久化与执行必须遵守现行服务端协议；第 5 节是设计目标草案，不能直接当作已支持的 API schema。

## 5. 图设计目标草案（不是当前运行 API schema）

下列结构包含 start/end 等设计层概念，不能直接作为模型输出或当前服务端入参。应通过现行服务端校验和公共 API 约定映射；新增节点类型需独立兼容设计。当前执行缺口见根目录 [当前进展](../../当前进展.md)，不能以本文草案覆盖已发布定义。

### 5.1 流程定义

```ts
interface ProcessGraphV2 {
  schema_version: 2;
  definition_id: string;            // 永久命名空间 ID
  business_object: ObjectRef;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  forms: ProcessForm[];
  mappings: DataMapping[];
  variables: ProcessVariable[];
  viewport?: { x: number; y: number; zoom: number };
}
```

### 5.2 节点公共字段

```ts
interface ProcessNode {
  id: string;                        // 定义内永久 ID，创建后不随名称变化
  type: "start" | "human_task" | "action" | "condition"
      | "ai_select" | "wait_event" | "subflow" | "end";
  title: string;
  description?: string;
  position: { x: number; y: number };
  input_mapping?: DataBinding[];
  output_mapping?: DataBinding[];
  error_policy?: ErrorPolicy;
  config: NodeConfig;
}
```

节点配置必须按类型受 schema 驱动：

| 类型 | 必填配置 |
|---|---|
| `human_task` | 办理人规则、办理表单、允许动作、字段读写权限、超时策略 |
| `action` | 固定 ActionDef ID + version、输入输出映射、确认策略显示 |
| `condition` | 输入数据范围、互斥/优先规则、默认出口 |
| `ai_select` | 候选 ToolDef ID + version、选择目标、输入范围、输出 schema |
| `wait_event` | 事件类型、相关键、超时、超时出口 |
| `subflow` | 已发布子流程版本、输入输出映射 |
| `end` | 终态、结果码、归档/通知规则 |

### 5.3 连线与条件

```ts
interface ProcessEdge {
  id: string;
  source: string;
  source_port: string;
  target: string;
  target_port: string;
  label?: string;
  priority: number;
  is_default?: boolean;
  condition?: ConditionRule;
}

type ConditionRule = ConditionGroup | ConditionClause;

interface ConditionGroup {
  kind: "group";
  combinator: "and" | "or";
  rules: ConditionRule[];
}

interface ConditionClause {
  kind: "clause";
  source: {
    scope: "process_input" | "business_object" | "node_output" | "context";
    object_id?: string;
    node_id?: string;
    field_path: string;
    field_label: string;
    data_type: "boolean" | "number" | "string" | "date" | "enum";
  };
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
      | "contains" | "in" | "is_empty" | "is_not_empty";
  value?: unknown;
  summary: string;
  advanced_expression?: string;      // 受限 DSL，不是任意 JS/Python
}
```

条件必须保存**来源、类型和中文标签**，不能只保存字符串表达式。复合条件使用可视化 `AND/OR` 分组，每组至少一条规则。运行时只执行白名单运算符或受限 DSL，禁止 `eval`、任意 Python、JavaScript 或 SQL。

## 6. 条件编辑器

点击连线后，右侧面板按顺序显示：

1. **从哪里判断**：流程输入、业务对象、某节点输出或系统上下文；
2. **选择字段**：中文字段名为主，下面显示对象/节点和内部路径；
3. **判断方式**：按字段类型过滤运算符；
4. **比较值**：布尔开关、数字、日期、枚举或字段引用；
5. **满足后去哪里**：目标节点；
6. **显示名称**：画布上的短标签；
7. **优先级 / 默认分支**：多分支时必填且只能有一个默认分支；
8. **高级表达式**：默认由结构化规则生成，手写时使用受限 DSL 并即时校验。

多条件通过“满足全部（AND）/满足任一（OR）”分组编辑；高级 DSL 只是为复杂实施预留，不能取代默认可视化编辑。

当前费用模板必须迁移为可解释数据：

```text
条件节点：判断文字层

分支 1
来源：票据抽取记录 → 是否包含文字层
内部路径：business_object.document_extraction.has_text_layer
判断：等于 是
画布标签：有文字层
目标：PDF 文字解析

分支 2
设为默认分支
画布标签：扫描件
目标：扫描票据识别
```

若系统无法证明 `has_text_layer` 由哪个对象/节点产生，发布检查必须报错“条件字段来源不完整”，不得继续用裸 `file.has_text_layer` 蒙混通过。

## 7. 节点库与节点配置

节点库只展示平台和已安装插件注册的类型：

- 人工办理；
- 条件分支；
- 系统动作；
- AI 选择工具；
- 等待事件；
- 子流程；
- 结束。

系统动作面板不允许手写 Python 方法或 URL，只能搜索 ActionDef。每项显示：

- 业务名称与插件来源；
- effect（读取、提案、写入、高风险、append-only）；
- 输入/输出 schema；
- 所需角色；
- 是否强制确认；
- 超时、重试、幂等策略与版本。

AI 节点只能多选 ToolDef 候选集合；高风险或 append-only 工具不得成为 AI 自动执行候选。人工节点的办理人支持角色、指定用户、发起人、上级、对象字段用户和后续插件规则；每条规则都必须能解释最终命中谁。

## 8. 手动编辑交互

### 8.1 基础操作

- 拖入节点自动生成稳定 ID；
- 连线中间和节点之后都有“+”插入点，不要求用户必须从左侧远距离拖拽；
- 从输出端口拉到输入端口创建连线；
- 条件节点每个出口对应一条分支规则；
- Delete 删除选中项，删除节点前列出受影响连线；
- Cmd/Ctrl+C、V 复制节点但生成新 ID；
- Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z 撤销/重做；
- 多选移动、框选、缩放、适应画布；
- 离开未保存草稿时明确提醒。

### 8.2 节点数据检查与调试

- 测试运行后，点击节点可切换“配置 / 输入 / 输出 / 日志”；
- 输入字段旁的“选择数据”只列出流程输入、业务对象和已可达前序节点输出；
- 选择数据后生成结构化 `DataBinding`，界面同时显示中文来源和内部路径；
- 可把脱敏模拟输出固定到节点，用于调试后续路径，但固定数据永远不随发布版进入生产。
- 可从历史测试运行加载输入到草稿画布重现，不允许从无权实例读取或把敏感原文送给 AI。

### 8.3 保存

- 所有编辑先进入本地 command stack；
- “保存草稿”提交完整规范化 graph + `expected_revision`；
- revision 冲突时展示服务端差异，不静默覆盖；
- 保存失败不清 dirty 状态；
- 刷新后节点位置、条件、配置和 viewport 必须恢复。

第一阶段沿用完整 graph PUT；多人协作出现后再升级 patch/OT，不在本轮伪造实时协作。

## 9. 数据、表单与权限联动

流程图不能成为孤立的图：

- 节点使用的字段必须来自“表单”或“数据流转”视图中的同一份元数据；
- 删除字段前列出被条件、映射和权限规则引用的位置；
- 修改字段类型后，所有不兼容条件和映射立即标红；
- 人工节点必须能看到完成动作所需字段，不能写未授权字段；
- 动作输出只有通过显式映射才能进入流程变量或业务对象；
- append-only 数据只能调用领域动作，不提供通用 update 映射。

## 10. AI 辅助设计接口

AI 不再返回无法解释的整图替换，而返回结构化命令提案：

```ts
interface ProcessDesignProposal {
  based_on_revision: number;
  summary: string;
  commands: GraphCommand[];
  affected_paths: string[];
  required_resources: ResourceRef[];
  risks: ValidationIssue[];
  tests: SimulationCase[];
}
```

交互流程：

1. 用户描述目标；
2. AI 读取当前 graph、对象字段、ActionDef、ToolDef、角色和校验结果；
3. AI 只能引用注册资源并返回 commands；
4. 页面按新增/修改/删除高亮每项差异；
5. 用户可逐项勾选、全部应用或放弃；
6. 应用进入同一撤销栈，不直接保存或发布；
7. 人工继续手改，随后跑同一校验和模拟；
8. 发布仍由有权限的人显式确认。

示例指令“报销金额达到 5000 元时增加总经理复核”必须生成：新增人工节点、增加金额条件分支、连接通过/退回路径、补角色资源和两条边界测试，不得直接写数据库。

## 11. 校验、模拟与发布

### 11.1 保存前即时校验

- ID 唯一、端口存在、边目标存在；
- 起点唯一、终态可达、进行中节点有出口；
- 条件来源存在、类型兼容、分支优先级唯一、默认分支唯一；
- 节点引用的字段、表单、ActionDef、ToolDef、角色和子流程存在；
- 数据映射类型兼容；
- 人工节点有办理人和最低字段权限；
- AI 候选非空且不越权；
- 自动重试不包含写入、高风险和 append-only 动作。

### 11.2 发布前服务端校验

除即时校验外，还必须检查：

- 所有依赖版本可冻结；
- 权限模拟无越权；
- 敏感字段不会进入 AI 上下文；
- 循环有退出条件，退回/重提不会形成自动死循环；
- 测试用例覆盖每个条件出口和异常出口；
- 真实试运行不写生产账本，财务动作进入事务回滚或隔离测试对象；
- 新版本与上一版本差异可审阅。

发布创建不可变 `Process Definition Version`；运行实例绑定 version、graph hash、ActionDef/ToolDef revision 和对象元数据 hash。

## 12. API 与权限边界

浏览器仍只调用 `/api/platform/*`：

| API | 用途 |
|---|---|
| `GET /process-definitions/:id` | 草稿、revision、已发布版本和资源摘要 |
| `PUT /process-definitions/:id` | 以 expected_revision 保存完整规范化 graph |
| `GET /process-designer/catalog` | 当前用户可见节点类型、对象、字段、动作、工具、角色、子流程 |
| `POST /process-definitions/:id/validate` | 服务端结构、权限、数据和安全校验 |
| `POST /process-definitions/:id/simulate` | 隔离模拟并返回逐节点轨迹 |
| `POST /process-definitions/:id/ai-proposals` | 生成结构化命令提案 |
| `POST /process-definitions/:id/publish` | 校验通过后创建不可变版本 |

只有 System Manager 或流程设计角色可读取设计器 catalog 和保存草稿；普通员工只能使用流程中心和实例接口。服务端重新校验全部图和资源引用，不能信任浏览器隐藏按钮。

## 13. 费用报销业务链验收

> 本节的费用链是首个真实可选领域的集成验收夹具，不是平台内核默认内容。财务域停用时，设计器和流程中心仍须正常工作，但不展示该模板、财务资源目录或新发起入口；已运行实例仍按冻结版本完成。当前不另造合同/用印或抽象“示例域”替代它。

只有以下全部通过，才能把页面重新称为“低代码流程设计器”：

### A. 从模板手动修改

1. 打开费用报销模板，点击“有文字层”连线，能看到字段来源、类型、运算符、值和目标；
2. 把分支标签改为“可直接读取”，保存刷新后仍保留；
3. 拖入“总经理复核”人工节点，配置角色；
4. 新建条件“报销单 → 金额 ≥ 5000 元”，分别连接财务复核和总经理复核；
5. 配置总经理通过、退回补充材料和重提路径；
6. 移动节点、撤销、重做、保存刷新均正确；
7. 删除仍被引用的节点时得到明确影响提示。

### B. 数据与权限

1. 金额字段来自费用报销对象，不是手写字符串；
2. 经理、总经理、财务和发起人的字段读写范围可见；
3. 员工无法把审批节点办理人改成自己，也无法调用设计器 API；
4. 系统动作和 AI 候选只能从注册表选择。

### C. 模拟与发布

1. `4999.99` 走经理 → 财务；
2. `5000.00` 走经理 → 总经理 → 财务；
3. PDF 有文字层和扫描件分别命中两个识别分支；
4. 经理或财务退回后进入补充材料，重提回到正确节点；
5. 发布 v2 后，新实例绑定 v2，已运行的 v1 实例不漂移；
6. 路径、权限、字段映射、AI 工具边界和 console 检查全部通过。

### D. AI 与手动编辑一致

1. AI 能生成“金额 ≥ 5000 增加总经理复核”的命令提案；
2. 页面显示每个节点、连线、条件和权限差异；
3. 未确认不修改草稿，应用后仍能手动调整；
4. 撤销 AI 提案能完整回到原图；
5. AI 不得引用未注册动作、工具、字段或角色。

## 14. 实施拆分与授权门槛

### 阶段 0：诚实标识

- 在完整编辑能力上线前，把当前入口和页面文案改为“流程查看”；
- 保留 AI 提案、保存和发布，但明确“仅名称可手动编辑”的限制。

### 阶段 1：协议与服务端

- Graph V2、ConditionRule、catalog、validate、simulate 契约；
- 迁移费用模板裸条件为有来源的结构化条件；
- 服务端规范化、revision 冲突和权限测试。

### 阶段 2：图形手动编辑

- GraphCanvasAdapter、节点库、拖放、拉线、删除、复制、撤销/重做；
- 节点与连线属性面板；
- 保存、刷新恢复和桌面/390px 检查。

### 阶段 3：五视图联动

- 表单、数据流转和办理权限从展示改为真实编辑；
- 引用影响分析和跨视图错误定位。

### 阶段 4：模拟、发布与 AI

- 隔离模拟、路径覆盖、版本差异和不可变发布；
- AI GraphCommand 提案、逐项应用、撤销和测试。

每一阶段完成后单独浏览器验收。未经用户批准，不跨阶段实施，不顺手改全局导航或其他页面。

## 15. 明确禁止

- 不把当前 DOM 拓扑图继续堆按钮冒充编辑器；
- 不保存画布库私有 JSON 为流程权威；
- 不允许条件只剩难以追溯的字符串表达式；
- 不向实施人员暴露任意 JS/Python/SQL；
- 不让插件覆盖其他插件节点、动作、工具或字段；
- 不让 AI 直接保存、发布或绕过确认；
- 不修改 Frappe core；
- 不改尚书全局产品壳；
- 不触碰冻结 demo。
