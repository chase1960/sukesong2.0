# `shangshu_core.public_api` v1 开发参考


### 日常填表 Harness：值与输入约束（2026-10-29，工作区增量，未部署后端至3850）

模型统一用 `platform_resource_read(operation=table, table, headers?, row_ids?, search?, page?, page_length?)` 读取实际位置、值和 `read_ref`，再用 `platform_action_call(read_ref, changes=[{row_id,header,value}])` 提交一张待确认提案。日常定义/目录/行投影不返回物理存储、DocType、写路由或版本参数；专业业务动作及管理员设计接口保留自己的契约。废弃的重复日常值写入口从模型工具、搜索与schema目录一起移除，不在写失败后换后端重试。

每列只提供 `options / allow_custom / nullable`。`options=null`表示没有固定选项，布尔值仍为true/false；长选项用 `operation=field_options` 按原read_ref、单字段搜索/分页，当前按实际值搜索，标签只显示。自由列仅在真实范围读取证明存在后给出自由输入约束；缺失的受管声明、隐藏字段和未知类型明确报错，不降级自由填写。引用/明细等复杂字段使用原专业动作。

Harness在本桥内最多保留16份、15分钟的原读取上下文；换轮、关闭、超时须重读。上下文只存本次范围与原版本，不是第二份业务事实。单次最多50行、64列、2000格，读取值/提交载荷UTF-8各限1MiB，超额明确拒绝，不静默截断。旧ref不被后续新读取更新；候选保存后沿提案保留原版本，确认继续检查当前权限、原规则和并发冲突。

新增注册只读服务（沿现有 `service_read` / BFF services invoke，不新增HTTP方法或Python public_api导出）：

| Service | 输入及边界 | 返回 |
| --- | --- | --- |
| `platform.object.input_constraints` | `object_id, fields`；1–64个唯一字段，单字段选项搜索/分页每页≤50；实际字段可读性与标量类型检查 | `fields[field_id]`三项约束 |
| `files.sheet_input_constraints` | `table, headers`；1–64表头；只读定义，不打开工作簿或扫描值；只返回已核实晋升映射 | `columns[header]`三项约束 |
| `platform.object.values_read` | `object_id, names, fields`；1–50已知受管行、1–64字段；一次原get_records定点批读，原生对象暂不支持 | `rows`，供可信Harness/确认UI内部使用原modified，模型结果另投影 |
| `platform.action_proposal.values` | 仅`proposal_id`；仅update_many/companion_write；当前私人提案/动作/行列/绑定授权重核；≤50行、64列、2000格、1MiB | `{id,capability,payload}`原始候选差量及原版本，不替换为当前版本；不加入模型详情服务目录 |

受管普通值走原 `platform.object.update_many`，文件范围走原 `files.sheet_cells_write`，伴随表走原 `platform.object.companion_write`。伴随绑定指纹为原字符串，模型修订仍用原数字；目标行含普通格也必须携原源行CAS。原生对象仅支持一行，不能把多行拆成N次保存冒充原子包。专业邮件/UC动作不改为通用填格。

update_many和companion_write新增共用整包确认UI：显示表名、每格位置/字段、原值→新值，25格/页只在本地换DOM，完整包仍一次确认。预览按原版本检查、确认后独立定点读回；刷新时显式恢复原候选，默认get/list不扩大。它们不新增逐项保存；文件原有逐项审核继续保留，首次保存不能偷取新版本，部分采用后只延续核心已核实的剩余基线。

审计由服务端从read_ref解析真实action_id，经典/Pi共用原requestId及可信上下文；不信模型自报解析动作。写规则可在提案阶段返回error，确认仍执行原最终校验，不能把前置检查当写入授权。当前增量无DDL、无新增日志事实表、无新写保存器；配套加载core/files/Node/静态脚本后才可作同版验收。见[本轮验证与未验边界](../reports/2026-10/harness-values-20261029.md)。

### API1.18 事务失败传播（2026-10-28，独立候选）

可信Python适配器在将异常转为pending／部分结果之前调用`raise_if_transaction_failed(error)`；普通非数据库错误返回，已识别的数据库死锁、锁超时、失联或已失效事务抛出原始错误。`assert_transaction_healthy()`保护后续成功路径。两者不是用户可调用的免检写口，不增加权限或锁服务。

失效状态绑定当前DB实例，父调用catch后仍拒绝commit，且在Frappe清理rollback回调之前拒绝。只有完整rollback及全部资源恢复回调成功才解除；保存点不解除，资源恢复失败持续阻断。本期DB锁超时也要求结束整个外事务，不保证保留此前成功的A；普通业务／文件包失败继续原检查点语义。失联尤其不能承诺“肯定未提交”，不新增自动重试或新幂等键。

core/files须配套0.18、API1.18，动作输入定义未变的不擅自升级动作版本。本批无新增DocType/DDL；前置0.17的目标索引迁移仍须完成。见[独立审查与实测](../reports/2026-10/write-zone-review-20261028.md)。zone缩锁尚未交付。

### API1.17 一动作一日志（2026-10-28，独立候选）

资源可显式声明 `transaction=atomic_package`、`transaction_versions`与`package_actions`。公共执行器收纳该根动作允许的子动作证据，只产生一条成功action日志，子回执指根；各子调用继续授权/确认/版本/请求绑定检查。完整明细唯一保存在 `detail.package.steps[].record_changes`。`Shangshu Log Target`是无值查询索引，不另算日志；按目标读取不暴露同包其他目标。

`register_package_rollback(callback,key=None)`仅供可信资源适配器在改变外部资源前登记包检查点，包外或同key已登记返回False；失败逆序恢复，不替代整个事务的after_commit/after_rollback。包内禁止DDL/独立迁移、未声明子动作或自行另记action成功日志。旧成功请求守卫重放；旧包动作版本不得开始新写。失败沿原Action Request回执，未新增失败Unified Log口径。

已接入update_many、managed companion及五个日常sheet写/撤回动作，版本详见[报告](../reports/2026-10/action-package-performance-20261028.md)。native companion和其他独立编排不自动变成一个包。core/files0.17与API1.17必须配套迁移新目标索引；历史singleton日志保留读兼容。


### API1.16 公共按需数据访问（2026-10-28，本地候选）

对象记录查询新增可选`fields`、`read_scope`和`include_definition`；HTTP沿原`objects/:id/records`，数组和范围以JSON编码。`fields=[]`仅身份/版本，省略字段表示当前可读列；只返回目标字段，权限和规则依赖不额外公开。数据分页可用`include_definition=0`避免每页构造定义，单对象定义仍走原`GET objects/:id`。

范围为`rows/query/all`，行身份仍使用原`names/row_ids`，查询仍使用原`filters/page/page_length`，不复制第二套条件。受管正式值读取必须限定行；工程全量须显式声明`export/migration/analysis/recovery`，继续按绑定、权限和软删除范围查询。空行数组不扩大成第一页，失败不回旧JSON或XLSX值。

`objects?page=N&page_length=20&summary=1`返回`list/total/page/page_length`，支持原搜索及归属筛选；权限/筛选先于分页，完整公开定义仅为本页装配。候选元数据扫描与数据库物理扫描不能混为一谈。无page的完整定义目录保留给配置消费者，不用于日常表格目录。

`resolve_table_resource(resource_id)`及`GET table-resources/:id`按完整身份定位表格；文件类型由已安装适配器核验，不扫描对象目录，不根据ID长相猜，也不在拒权后换存储尝试。

`managed_object_definitions(ids)`提供与原单条正式定义相同用途的批量元数据口，非HTTP，仅供原权限/能力判定；域不私读内核模型表。实际值读取仍走授权记录入口。

`read_registered_service`及`GET services/:id/invoke?payload=<JSON>`只接受注册`effect=read`的服务，再复用原调度器。客户端取消贯通BFF读请求；写服务和动作保留POST及原回执，不能失败后换协议重试。

写入沿同一公共Action提交目标patch、批量保留各行版本和完整审计；xlsx派生值只同步变化位置、保留格式。Frappe原生钩子可能需要读取/保存完整目标行，本增量不另造ORM或跳过规则。查询取消不承诺终止已在执行的SQL。

本批core0.16/API1.16与files0.16配套加载；`files.sheet_range_read`因可选headers输入升1.2.0，旧动作版本保留。无需重建业务模型或搬历史数据，调用方迁移清单与真实验证见[执行计划](../plans/2026-10-28-scoped-data-access-CORE-CANDIDATE.md)。本地候选不代表fast已发布。


### API1.16 调用方接线补齐（2026-10-28，独立候选）

- `platform.object.query@1.2.0` 声明并转发 `fields/read_scope/include_definition`，Assistant 与自动化不再被动作旧 schema 挡住。查询动作只接受 `read_scope.mode=query`；其筛选/分页仍在原参数里。旧 `1.1.0` 定义保留；必须重新登记新动作定义后客户端才可使用三参。省略 `object_id` 沿原行为报对象未注册，不把它当目录读口。
- `GET applications?summary=1` 只返回全部可访问入口的显示元数据，不装配字段、流程或资源计数。应用角色、企业、发布版本与依赖仍核验；详情用原 `GET applications/:id`。`design=1` 优先使用原完整设计目录。摘要是导航契约，不可当完整应用定义。
- Harness `platform_action_schema` 不带 ID 时返回最多 10 条摘要及 `total/page/page_length/has_more`；按 ID 仍返回完整 schema。工具搜索索引仅在本次聊天桥内复用，不能跨人复用授权；实际调用仍进公共执行器。`platform_resource_read` 的对象目录消费公共分页摘要，已知对象定义/记录分别精确读取，只读服务走已注册 `effect=read` 的公共 GET。
- 公共 `platform.object.update_many` 自己承担批末投影通知合并。内层批次成功不提前发布，外层成功统一通知；内层失败恢复进入时的变更队列，整批失败不通知。返回实际 `managed_change`，不能固定报空成功。动作输出原 schema 为开放对象，修复不改变其版本。

### 定点对象定义读取（2026-10-27，本地候选，未部署）

- `GET /api/platform/objects/:id` → `public_api.http.object_definition(object_id)` → 既有 `public_api.get_object_definition`。仅需精确对象 ID，不扫描对象目录，不读取记录。Frappe HTTP 只允许已登录会话的 GET；身份、领域启停和定义可读性沿原公共函数检查，不新建授权规则。
- 返回 `{ok:true, object:{id, fields, operations, input_schema, companion, ...}}`；`companion` 沿原定义返回已核实绑定或空值，字段及能力仍由服务端决定。权限拒绝／不存在／服务失败照原错误传播，不尝试 xlsx 或其它对象。
- Excel 已知入口携带 `table_source=db|xlsx`，仅决定请求路由，不授予任何权限。普通 xlsx 直接读取目标；数据库对象读取单对象定义后按真实 companion 分流。当前表复用本次定义，不做跨请求长期权限缓存。无来源旧链接暂保留一次目录精确识别，成功后 URL 补来源；未新建跨域资源推断器。

> **文档状态：GUIDE（现行 public API v1 参考）**

> 2026-10-20：协议1.11.0/core0.10已选择性发布主站3426af85。历史日期段的版本不覆盖此结论，实页/未验范围见固定交接。

## 唯一入口

### 动作发生时的组织快照（2026-10-19）

`current_actor_organization_snapshot()` 仅返回当前认证用户及其直接任职部门的 `{id,title}` 列表，不接受代查用户参数、不扩大日志读权。动作需将结果随既有审计保存；历史查询读取保存结果，不能用当前任职覆盖旧部门。`query_action_fact_audits` 的固定投影新增 `result_summary_json` 供事实查询读取原快照。旧记录缺少快照时返回未知，不回填推测历史。
### 1.11 原提案逐项审核（2026-10-20，已发布主内测站）

- `get_action_proposal_review(proposal_id)`只读当前目标、原值、建议值、已采用值及`review_revision`；`accept_action_proposal_units(proposal_id,units,edited_value,review_revision,op_id)`采用选定项，`units=None`表示全部待审项。最多100项，编辑值按unit_id映射，类型仍由原Action校验。
- Action可选声明本owner App的`review_handler`（describe/prepare），不向工具或页面泄露回调。领域只描述／组装自己的原记录，核心继续管理原私人提案、角色／租约／启停、确认、原子savepoint、幂等与审计；不创建第二套正式值。
- 首次要求原版本一致；部分采用后只允许待审位置仍等于原预览基线，拒绝陈旧覆盖。逐项已保存是事实，拒绝剩余项不回滚已保存事实。人工改值与采用人／时间／原动作审计保存在同一提案`review_state_json`，不冒领模型原稿。
- 同一op_id仅可重试同一选择与改值，重放前仍复核当前权限；未知回执不能换编号或放弃后另发。旧整单确认在无部分采用时不变，已有部分采用时只完成剩余项，不覆盖人工采用值。
- BFF新增`GET /api/platform/action-proposals/:id/review`与`POST .../:id/accept`，均private/no-store；仅发起人可用，管理员不能代看私人建议。文件和草稿共用原右侧确认卡；新草稿、发信仍沿原整单确认。本批不自动发送邮件。
- API1.11/core0.10；files0.8与mail0.5提高最低依赖。升级新增提案可选LongText字段，须两次migrate；回退须保留逐项兼容核心或先拒绝剩余待审提案并停用新入口，不能让旧核心重放整包覆盖已采用值。

### 1.10 办公接入（2026-10-14，已发布主内测站）

- `public_api.organization` 为显式公共子模块：资源归属读写判定、部门元数据及受管动作内的首次归属登记；不暴露私有模块整体。存量无归属文件保持原目录权限，不自动转部门或授权。首次登记必须在当前 owner 的受管写 Action 内针对已保存、可读的原生对象。
- `query_domain_action_audits(action_id,filters=None,scope='self')` 只供所属域执行上下文读取自身动作摘要，员工强制本人、all 仅系统管理员，最多500条；不是通用 SQL 或跨域审计读取口。
- 提案可选改值继续走原确认口；原始与采用值完整留痕。单格沿原类型值；领域声明 `proposal_editable_fields` 后可接受 `{type:'fields',value:{...}}`，邮件仅主题/正文可人工改，不可换目标、版本、附件或邮箱。重放可由本域只读守卫复核当前权限，单参旧守卫兼容。
- Agent 提案列表及裁决绑定发起人（含管理员），不是同角色公海；跨人业务审批仍走流程任务。文件按表提案服务还需当前文件读权。
- executor 失败只回滚自身 savepoint，不释放调用方域锁或撤销外层有效写入。HTTP 顶层失败可另行保存回执；数据库回滚不能撤销外部邮件等副作用。
- 版本 API1.10/core0.9；发布与实页证据边界见[当日计划](../plans/2026-10-14-office-integration-CORE-CANDIDATE.md)，真实外部邮件和完整Office不在本批验收内。

2026-10-10 文件域0.4.1提供`files.cells`（固定文件/版本、有界范围或变更预览，只读）和`files.edit_cells`（最多100格、必带expected_version/expected_modified、人工确认后原文件新版本）；自由表格仍是文件，不自动变为业务对象。Pi与原Agent共同消费授权Service/Action目录，不能直接写库、解确认卡或读取任意磁盘。此为领域贡献，不新增公共API方法，public_api仍为1.9.0。

### 1.8 原记录助手撤销与工作提醒（2026-10-05，本地候选，未部署）

- `reference_execution(operation, execution_id=None, object_id=None, name=None)`：begin/check/end；仅注册原生对象、明确声明`execution_actor_field`的记录可开始。每次锁定读复核本域准入、当前来源读权、字段负责人、期限和可选`execution_guard(doc,user)`；守卫必须属于owner_app且只读。租约30分钟、本人最多8个活跃租约，原记录/Identity锁保障并发；关闭不删除历史。
- 原`propose_registered_action`和`execute_registered_action`增加末尾可选`execution_id`；旧调用不变。原提案保存租约引用，确认仍核对当前身份/来源/负责人；模型结束后的提案可在原30分钟期限内确认，转交撤销后不允许旧提案执行。原Harness只接原AbortController，BFF每2秒及工具前/原件读取后复核，网络失败停止；不新增助手队列。记录级工具不借用未绑定租约的Node协作确认，普通聊天保留原兼容工具。
- `update_reference_work(object_id,name,previous_user=None,recipient_user=None,event_key=None,title='',reason='')`只供**同owner原公共审计写Action**内部组合。原服务/域上下文本身不授予写权，没有对外代发/撤销他人的HTTP写口。来源须当前可读且可写；保存新负责人后原写权已撤回，或转交者非旧负责人时，对象须显式本域`work_update_guard(doc,user,action_pin)`受权该原动作，不能用外域回调或扩大通用写权限。行业先保存新负责人，再在同事务组合撤销旧租约/其他未执行提案、关闭旧提醒及通知新接收人；原执行器正在确认的本张提案不自我撤销，仍正常审计完成。新接收人须启用且当前可读。去重键含来源/接收人/事件，内容变更拒绝；失败沿原Action整体回滚，只有一份核心通知事实，不含私信/文件副本。
- `reference_notifications(page=1,page_length=30)`只投影本人Pending且来源当前可读的提醒（页长最多100，未关闭总量超1000明确拒绝而不截断）；停域或来源撤权不借提醒泄露业务内容。BFF只读`GET /api/platform/work-notifications`，办理仍回原来源Action；当前公共批没有独立通知页面或行业交接规则。
- 新DocType `Shangshu Reference Execution`/`Shangshu Reference Notification`及原Action Proposal可选Link需标准migrate；版本API1.8/core0.4。当前只完成公共基础及隔离回归，不以它声称IP完整交接、真实模型失权或公网已验。升级/回退见[交付手册](kernel-delivery.md)。

### 1.7 可选领域集成（2026-10-05，本地候选，未部署）

manifest 新增 `optional_dependencies`，如 `com.shangshu.mail@">=0.2 <1.0"`。格式与原强依赖相同；缺失、不兼容或停用仅使集成不可用，不阻断来源域安装/启用，也不形成目标域的领域依赖停用阻断。核心必须强依赖；重复、强弱重叠及非法版本规则拒绝。可选依赖不进入 Frappe `required_apps`，强依赖循环/版本门禁不变。

跨域可选调用仍复核安装版本，且经过目标身份权限、健康与域执行屏障；不能调用已完全停用目标，不能静默假成功。已有应用引用、流程、事件及生命周期服务阻断保持。原管理员 lifecycle.requirements 增量包含 `optional/available`；旧字段不删、不增加写接口或表。行业使用此字段需声明 API >=1.7、core >=0.3，并明确不可用时的交互；不得把真实业务前置改成可选来绕门禁。详见[本批执行范围](../plans/2026-10-05-optional-domain-dependencies-CORE-CANDIDATE.md)。

### 1.6 域执行生命周期与受管对象能力（已部署，2026-09-23）

以下9/22增量段落记录当时实现状态，其中“本地未发布/尚未上线”已由9/23授权整批升级覆盖；当前部署及恢复边界以固定交接为准。导入已接并可区分历史来源，员工导出仍未开放。

2026-09-22 受管普通记录回收增量（本地未发布）：`platform.object.recycle/restore` 走原 Action 执行入口，输入 `object_id/name/expected_revision/expected_modified`，确认、幂等、执行审计与记录变更同事务；输出原 `name/modified/revision` 及 `state=active|trash`。不删除物理行、不复制回收表，明细与原值保留；没有彻底删除或自动清除。对象声明 `lifecycle.version=1/available/scopes/auto_purge`，`operations` 按当前权限包含 recycle/restore；旧内核/未迁移旧表不得假定可用。对象 `access.recycle_roles` 可选、默认空；非 System Manager 必须同时满足读、写、显式回收角色及原 `record_scope`，既有员工写权不自动扩展。设计器“数据权限”可配置，须原预检查/迁移/发布链生效。

原记录查询增加 `$scope=active|trash`（默认 active），回收列表沿用字段与归属授权且额外检查回收权限，返回 `_lifecycle.state/recycled_at/recycled_by`（回收人显示姓名）。原详情/更新/关联选择拒绝回收行；历史 Service 可在同等回收权限下读取，新增 recycle/restore 操作条目而不伪造字段差异。存在在用主记录/明细引用时拒绝回收；恢复需关联目标在用且符合当前数据规则。写入按应用→模型统一加锁，引用检查用当前读，不用旧事务快照绕过关联限制。跨应用随意 Link 原本不受支持，不新增跨域级联删除。

升级必须在独立迁移中补齐已有受管根 DocType 的三个内部 `ss_recycled*` 字段，再同步新动作；新表与后续字段变更使用同一物理投影。普通动作不做 DDL，升级不改旧业务值/归属/modified。仍属尚未上线的 API 1.6 批次，不能把本地整个 core 覆盖到公网 API 1.5。回收功能投入使用后也不能简单回退到不识别回收状态的旧适配器，否则旧查询会重新显示回收行；须兼容回退补丁或经确认的数据恢复方案。

2026-09-22 记录历史增量：`platform.object.history` 只读 Service 接受 `object_id`、`name`、可选 `page/page_length`（默认 20，最多 50）。复用记录读权限，返回 `items/total/page/page_length/notice`；每项含执行者姓名、时间、create/update 及当前权限内字段 before/after。不可读字段名和值均不返回，明细按当前子字段权限投影，关联显示当前可访问目标的标签而非内部 ID（标签不是历史快照）。首次接入前未保存的前后值不能还原。记录动作通过内部 context 交付变更，公共执行器在原唯一 `Shangshu Action Execution Audit` 同事务保存可选 `record_changes_json` 和对象引用；不增加历史表，幂等重试不重复，失败回滚不产生成功历史。原审计不可变规则继续有效。上线顺序必须先迁移审计可选字段/引用索引并同步服务贡献，再启用新代码；不得只替换前端。对象声明 `history.version=1/service` 后才显示入口；导入尚未接入，不能称已区分未实现的导入来源。

2026-09-22 XLSX 导出增量（本地未发布）：通过既有 Service 调度调用 `platform.object.export`，参数 `object_id`、`expected_revision`、可选 `filters`（同受管查询）。返回 `filename`、`mime_type`、`content_base64`、`total`、`revision`；无新 HTTP 路由。对象 `export.version=1/available/service/format/max_rows` 声明可用性，旧内核不得假定支持。首批仅 System Manager；复用记录/字段授权，只导出正式值，含所有授权列而不受个人视图隐藏影响。关联列显示已授权标签，不泄露内部 ID；明细列暂拒绝。5000 行/50 万单元格/20MB 内容及文件保护、XLSX 单元格超长/非法字符明确拒绝，不静默截断。字符串强制文本，防公式执行；日期保留类型，大于 15 位整数按文本保精度。修改贡献后须走既有注册同步，不能只替换前端。未实现导入或员工导出权限卡。

2026-09-22 受管对象查询增量（本地未发布）：原 `query_object_records` / 对象记录 HTTP 入口不变。受管对象 `filters` 兼容原逻辑字段精确值，并增加保留键 `$search`（最多 200 字、短文本/长文本/选项的字面包含，`%` / `_` 不扩成通配符）、`$sort`（可读标量逻辑字段）、`$direction`（`asc` / `desc`）。对象定义新增 `query.version=1`、`search_fields`、`sort_fields`、`search_max_length`，全部按当前字段权限投影；旧内核未声明时客户端不能发送或宣称新能力。隐藏字段和明细/关联目标不参与关键词搜索，字段/归属权限先于计数与分页；同值排序以记录 name 稳定补序。未指定新键时原精确查询与默认 modified 倒序保持兼容；代码域对象不受本增量改变。没有新 BFF 路由、任意 SQL 或新的数据权威。

- `domain_execution(domain_id, allow_disabled=False)` 是现有领域兼容入口/后台任务的统一上下文，也可作装饰器；Action、Service、对象/数据集、事件消费者与已接入流程入口由内核自动进入，不要逐个业务函数复制守卫。包装不授予任何角色权限，跨域依赖检查照常执行。
- `set_domain_enabled(domain_id, enabled, reason, stop_mode='drain')` 保留旧三参数语义。`complete` 获取域事务排他屏障后检查依赖、在途流程、未完成事件及领域生命周期服务，再设置 `execution_stopped`；有阻断则不改变状态。重新启用清除此标记。核心不能停用。
- `enabled=false, execution_stopped=false` 是“停止新业务”，允许已声明旧续办；`execution_stopped=true` 是“完全停用”，续办参数也不能绕过。管理页面明确使用 complete，不新开 HTTP 路由。数据和核心审计保留，不卸载表或删除文件。
- 执行使用 MariaDB 域行共享锁，外层请求/任务提交或回滚释放；停用等待已在途事务完成。handler 不得自行 commit、整事务 rollback、DDL 或开启脱离上下文的线程。commit 有运行时拒绝；其他违规由受信开发边界和审查约束，不是恶意插件沙箱。外部已提交副作用不能回滚，需幂等/对账。
- 生命周期服务只读、限管理角色，查询可变阻断状态必须锁定读当前值，不能使用停用等待前的普通事务快照。注册 provider 仅安装/迁移/显式注册调用；目录读已登记快照。修改贡献后必须重新注册，不依赖 GET 隐式刷新。
- 数据仍各归其 App/DocType，共享数据库并不等于共享业务所有权。基础消息/任务附件没有迁入可选域；本增量没有实现企业文件中心或统一附件接口。

### 1.5 账号生命周期（2026-09-17，内核身份职责）

2026-09-22 事务兼容修复：停用与重置密码沿用同一 Action；Frappe 框架清会话会自行提交，因此通过既有 `after_commit` 回调在身份/密码及动作审计提交后执行，事务回滚自动取消。不得关闭域执行事务守卫或在 handler 内提交。已覆盖存在真实会话的停用/重置、数据库与缓存撤销、回滚不误踢；本地验证，尚未部署公网。

#### 多角色与部门补齐（2026-09-17）

**费用审批人可指定增量：** `platform.identity.role@1.2.0` 可选提交 `business_roles`（完整目标集合），仅接受当前启用领域在既有角色贡献中显式声明 `assignable: true`、且不属于平台管理映射的真实 Frappe Role。省略此字段保持原业务角色；提交空数组撤销当前可分配业务角色。现行 finance 仅把 `Expense Approver` 声明为可单独指定，`Finance Approver`/`Cashier` 仍由平台财务角色管理。账号页从既有贡献目录读取选项，提交仍走原 `platform.identity.role` 确认动作、幂等和审计，不新增身份表或 HTTP 写口；不自动把协作管理提升为费用审批。领域停用时原授予保留但不可新授，角色使用受原领域启停及流程权限约束。

**用户最新决定：部门可选，不是基础协作前提。** `create@1.3.0` / `group@1.2.0` 增加 `related` 任务范围：只管理本人负责/发起的任务；具有派单角色时可选择在职同事，不能因此读改对方其他任务。账号页新建默认显式提交 related，部门收进选填。旧 department/company 值和省略 scope 的行为保持兼容，不批量改变已有权限；全公司范围仍需单独授权。jzy 保持 manager+finance，不因无部门增加系统管理权限。下面 department 默认说明为旧客户端兼容行为，不是新页面默认。

- `platform.identity.create@1.2.0`、`platform.identity.role@1.1.0` 接受 `roles` 数组；旧 `role` 单值仍兼容，两者不能同时传入。拒绝空、未知和重复角色；角色变更保留非平台管理的 Frappe 角色。清单新增 `platform_roles`（完整组合），BFF 的 `platform_role` 仅是旧协作接口的单值兼容投影。管理兼财务不自动授予系统管理员。
- `platform.identity.group@1.1.0` 同时接受部门 `collaboration_group` 与独立任务范围 `collaboration_scope`（`department` / `company`）。省略范围保持原值；新身份默认 `department`。不增加 HTTP 写入口、不新建角色事实表。
- **平台权限收紧，部署必须同步 schema 与 BFF**：部门为空不再等于全公司；默认仅本人，有部门则为本部门。只有显式 `company` 或系统管理员可跨部门管理任务。旧纯 Node 兼容模式维持原规则。范围不额外赋予派单能力，也不修改消息成员权限或财务权限。旧无部门管理账号升级后可能收窄，应逐人确认，不自动授予全公司。
- 升级先同步 `Shangshu Identity` 的新增字段并注册动作，再启用新 BFF/页面；回退代码保留新增字段与旧动作版本，不删身份或历史。账号页允许多选角色、分别保存部门和范围；开发部门不等于系统管理员。既有协作键保持不可变。

- 平台模式的身份权威是 Frappe `User` + `Shangshu Identity`。此前产品壳的账号页在平台模式返回 410（`/api/users/*` 写的是 Node 兼容用户表），Frappe Desk 未对外暴露，`public_api` 也没有任何账号写入方法——结果是管理员**无处发放账号**。本增量补齐该入口。
- 新增只读 `list_identities()`（HTTP `public_api.http.identity_list`，BFF `GET /api/platform/identities`）：System Manager 可读账号、Frappe 角色、能力、协作分组、启停与最近登录；不返回密码、密钥或会话。返回的能力来自既有 `role_capabilities` 投影，平台角色标签由 BFF 单点映射（`platformRoleOf`，与登录会话共用）。
- 新增基础附件契约下载口 `file_content(ref_doctype, ref_name, file)`（HTTP `public_api.http.file_content`，BFF `GET /api/platform/file-content?ref=&ref_name=&file=` 同源流式转发，2026-09-22 随文件中心域真实链）：会话用户对业务记录有读权限且文件确实挂在该记录上才返回内容字节；不绕过记录级权限，不暴露未挂载的自由文件。
- 9/23 本地安全修订（未部署）：已挂载私有附件的 Frappe 直链与公共下载共用来源授权，不能按二进制上传人绕过来源撤权；已注册来源先进入所属域执行边界，再读取业务权限。未挂载附件及公开静态文件保留 Frappe 原行为，Node 兼容附件不变。无新 HTTP/schema；升级需加载 core 的 File 控制器 hook、清缓存并重启验证，目录 ACL 启用后不得只回退该修复。公网 API 1.5 仍须单独兼容核对，不能整份覆盖本地 http.py。
- 9/23 本地附件引用增量（未部署，随未发布的 1.6 批次）：Python 公共 `bind_record_attachments(doctype, name, files)` / `get_record_attachments(doctype, name, files)`，`files` 为最多20个 Frappe 私有 File ID，返回 `{file,name,size}` 列表。绑定仅可在所属领域的公共 Action 内对本域已保存、当前用户可读的记录执行；目标域自行负责业务写权限、版本与附件选择，外层执行器统一确认/审计/事务。core 代理来源授权读取，仍进入来源启停屏障，不允许借此执行来源域写操作；不要求两业务域直接依赖。首绑要求来源在线且当前有权访问，已有绑定独立按目标记录权限读取，不随原件换版或源域停用变更。复用 Frappe `create_attachment_copy` 建引用，不复制字节；相同目标/文件URL/文件名复用挂载。读取只能投影当前记录的挂载，不返回磁盘路径。移除草稿选择不物理清除挂载或原件，保留与彻底清理另行收口；这不是已完成的发送快照或来信归档功能。
  - 绑定结果增量包含 `source_files`（对应本次输入的File ID列表），便于调用域建立来源→独立挂载回执映射，合并重复引用；读取投影不额外暴露来源。邮件域的显示名/版号备注保存在本域可选展示字段，不进入core、不作为权限或原件定位依据。
- 新增四个确认写 Action：`platform.identity.create`（邮箱、姓名、平台角色、初始密码 ≥8 位、可选分组）、`platform.identity.status`（启停，停用同时关闭身份状态并撤销会话）、`platform.identity.group`、`platform.identity.role`、`platform.identity.password`（重置并撤销会话）。均复用既有确认、幂等与执行审计，**不新增 HTTP 写路由**：人工与前端统一走 `/api/platform/actions/<id>/execute`。
- 平台角色词汇固定为 `admin/manager/finance/staff`，在内核集中映射到 Frappe 角色；改角色只增删平台管理的角色集合，不触碰为其他目的单独授予的角色。新增内核角色 `Collaboration Manager`（能力 `collaboration_manage`），使"能管协作任务"不再借用财务域的 `Expense Approver`。
- 护栏：内置 `Administrator` 与本人账号不可停用/改角色；至少保留一个启用的系统管理员（含内置）；邮箱重复、非法分组、短口令拒绝。**身份不可删除**，停用是终态，历史与审计保留。
- 这些动作**刻意不进入 `tools`**：身份管理是高权限管理面，不向 AI 投影；人工在账号管理页执行。兼容性：纯新增，major 不变，`api_version` 1.4.0 → 1.5.0。

### 字段校验子集（2026-09-10 工作树，未部署）

动作/通用表单服务端继续共用 `_validate_schema`：执行 type（含联合类型）、required、properties、additionalProperties、items、enum；新增 minimum/maximum/exclusiveMinimum/exclusiveMaximum、minLength/maxLength、minItems/maxItems/uniqueItems、date 格式与简单 pattern。未知规则拒绝，不默默忽略；这是现有已声明约束的补执行，上线前须检查历史载荷兼容。

2026-09-11：值校验已抽到内部 `schema_validation.py`，Action、事件及办理表单使用同一实现；事件敏感字段拒绝策略保留。事件原先未执行的 enum/范围/未知类型现在会拒绝非法值；这属于已声明约束补执行，不能当成完全无行为变化。仓内 core 事件与财务回归通过，行业/外部事件的声明与存量载荷仍须在部署前检查，不能凭本轮测试自动发布。

pattern 最长 256 字符、输入最长 4096，不支持分组、分支、反向引用，最多一处可变重复；日期需有效 YYYY-MM-DD。uniqueItems 最多 1000 项，布尔与数字区分，数值 1 与 1.0 等价。title/description/default/enumNames/multiline/suggestions 只作展示注解。尚未实现完整 JSON Schema 或所有格式；受管建模发布时的完整 schema 静态校验仍待补充。

业务 App 的 Python 代码只能从以下入口导入内核能力：

```python
from shangshu_core.public_api import execute_registered_action, publish_event, start_process
```

`shangshu_core.runtime`、`domains`、`actions`、`identity`、`database` 等均为私有实现。即使当前可导入，也不构成兼容承诺。

机器契约是`frappe_apps/shangshu_core/shangshu_core/contracts/platform-api-v1.json`，当前公共版本1.11.0/core0.10.0，兼容范围`>=1.0 <2.0`；部署和未验状态看本页顶部。同major只允许向后兼容新增；删除、重命名、权限收窄或运行语义破坏必须升major。废弃接口至少保留一个已发布minor周期。

## 1.4 受管数据链（已随 API1.6 部署，2026-09-23）

- 保留 1.3 的 prepare/get；增加 `execute_object_change(change_id, confirmed=False)` 和 `cancel_object_change(change_id)`。BFF 为既有 object-changes 路径下的 POST execute/cancel。仅当前企业设计管理员；没有新迁移任务表。
- DDL 命令必须在**独立请求、无待提交业务写入**时调用，不可嵌入普通 Action 事务。先持久化 Running，再幂等建表/补列，核对后更新 active_revision；失败保持旧生效指针，用同一计划恢复。只允许取消 Planned；Running/Failed 不得丢弃后另开计划。取消不删数据；危险删字段/改类型阻断，使用弃用或另行迁移。
- 对象字段唯一驱动物理映射、输入 schema 和值校验。权限为对象读写角色 + own/all 记录范围，字段可额外收窄；默认 Desk User 且只读写本人记录。System Manager 为设计/管理特权，不用于员工隔离验收。
- 记录读取复用 get_object_definition/get_object_record/query_object_records 和数据集入口；新增 `platform.object.create/update` 通用受管 Action/Tool，必须确认、幂等并审计，不按表新增工具或 CRUD 路由。更新同时校验 expected_revision/expected_modified；财务账本不经过这些普通记录动作。
- 明细随主记录保存，不独立发接口。返回的 `_row_id` 是行身份，不是业务字段；修改时保留它，服务器校验行归属/重复，保留无权编辑字段。含不可编辑字段的原有行不可整体移除；新增行不能伪造隐藏值。
- 关联和明细当前限同一应用生效对象。明细参与主表输入结构，其修订在计划中固定；明细结构变化后须重新检查主表并发布，不静默套用新结构。普通关联只保存记录身份，目标增添字段不改变主表输入，不要求无谓重建，但每次读写仍校验目标权限。尚不是多套物理 schema 并行运行。关联选择复用原记录查询分页及精确名称筛选。
- 升级需 migrate Object Model / Schema Change，刷新 hooks 缓存并重启服务；只更新静态页面不算升级。SSM 物理表不开放原生直接写入，新增 validate/on_trash 防绕行钩子；前后端、公共协议与静态资源版本须一起更新。生产仍需独立备份/恢复和目标环境验证，本轮未执行公网变更。

## 1.3 应用草稿与发布基础（历史增量，已随 API1.6 部署）

### B 本地增量（2026-09-15，随原应用修订发布）

- 没有新增 HTTP 路由、公开 Python 函数或 DocType。原应用 definition 可附 `pages/workflows/overview`；旧定义省略时保持原行为。表单字段类型来自受管对象，不接受任意 DocType、HTML 或脚本。页面/审批的精确支持范围见[精简路线 B](../plans/2026-09-10-low-code-refactor-audit.md#103-包-b同一应用内申请审批与总览)。
- `pages` 的 `fields/list_fields/columns` 控制有限显示；内容版本与字段策略随 Application Revision 冻结。`workflows` 引用本应用表单，编译为既有 Process Version；应用发布事务失败不得留下部分版本。已运行实例固定旧图，新发起须与应用当前发布修订一致。
- 原 `get_application` 仅在开启 overview 的详情请求附权限化表记录数与最近待办；目录不查询统计、普通员工不获得设计诊断。原发起/办理返回字段顺序、布局与关联选择引用；字段权限递归到明细，回放原始材料不绕过权限。
- 动作节点 `input_mapping` 支持 `{field:流程字段}` 或 `{value:固定值}`，`output_mapping` 为 `{变量名:{field:结果字段,type:类型}}`；不覆盖申请字段。自动执行仅允许无需确认的只读/抽取动作；人工动作仍显式确认。输出声明在运行时校验，失败回滚本次推进；外部读取服务的调用本身不可由数据库撤销。不提供任意代码映射和未经验证的写动作自动化。
- 申请材料不是业务表记录，审批通过也不等于已写入业务域。业务写入仍须明确公共动作。原图级 `mappings` 仍需领域适配；本增量只支持上述动作节点映射，不能据此发布任意等待、子流程或会签。

- 2026-09-11 精简：既有 `get_application_definition` 附 `design_context.domains/release`，与角色选项一起供管理员编辑使用；内部复用发布诊断，不新增路由。原 `get_application_release_status` 保留兼容。员工目录不返回设计上下文。前后端须配套更新；新编辑页遇到缺少上下文的旧服务明确报版本不匹配，不静默拼回多接口。
- 2026-09-15 B 开工增量：既有 `design_context.models[].capabilities` 投影生效版本、字段/声明角色、记录范围与当前登录管理员的真实可用操作；不模拟任意员工。未建表、明细独立操作或不可访问状态明确不可用。受管对象不支持删除，迁移中/失败时不再声明可新建修改。该只读增量不新增接口、数据库表或权限权威。

- 当前精简包新增 `design_context.resource_options`（kind/resource_id/owner_domain/version/label/domain/enabled），前端不再解析 domains；旧 domains 字段保留兼容。既有 HTTP applications 的 `design=1` 返回代码应用与受管草稿统一目录，受管项是标题/来源/状态/计数摘要，草稿从详情读取；此前新设计客户端须配套更新。Python `application_catalog` 新增可选 `design=False`，原两参数和员工目录行为不变。没有新增公共方法或 BFF 路由。
- `save_application_draft` 校验权限、修订及引用后，定义与依赖摘要均相同则返回原修订，不新增历史；依赖声明变化仍产生修订。失效引用只有显式从草稿删除后才能保存，已发布版本不随草稿解绑而改变。

- 受管对象前置：`prepare_object_change(application_id, definition, idempotency_key, object_id=None, expected_revision=0)` 保存计划，`get_object_change(change_id)` 读取。仅当前企业设计管理员；新对象由服务端分配 ID 和物理映射，重复内容复用请求，异内容拒绝，未处理计划阻止覆盖。1.3 仅准备；执行能力见上方 1.4。Object Model/Schema Change 两表需迁移。关联目标暂限同应用已生效对象。

- `set_application_enabled(application_id, enabled, reason, expected_revision)` 仅用于已发布受管应用，保留数据和历史；恢复前复查依赖。启停追加 Release 操作记录。领域停用若仍被已发布受管应用引用则拒绝；这不替代在途实例能力租约或完整升级影响分析。新增发布操作/原因字段需迁移。

- `get_application_definition` 附 `role_options`（有效角色 ID/中文标签），仅设计管理员可读；应用允许角色不得为停用、未知或 Guest/All。该配置只控制入口，不修改用户角色或记录权限。

- `get_application_release_status(application_id)` 返回当前企业应用发布记录与依赖诊断，仅设计管理员可查；发布记录不可覆盖。新增 Application Release 表必须迁移；发布指针与审计一起回滚，同修订重复发布不重复记记录。

- 新增 `create_application_definition(title, idempotency_key)`、`list_application_definitions()`、`get_application_definition(application_id)`、`save_application_draft(application_id, definition, expected_revision)`。仅当前企业的 System Manager 可使用；新建应用不创建业务表、不安装代码域。
- 草稿 schema 1 包含 title、description、allowed_roles、bindings。资源引用显式声明 kind、resource_id、owner_domain、version；当前 version 精确匹配来源域版本，不是完整版本范围求解器。每次保存检查旧修订号并追加不可变历史。
- `publish_application_definition(application_id, expected_revision)` 冻结到已有修订，发布后进入 application_catalog；草稿修改不改变员工视图。目录核对依赖版本、声明和启用状态，失配时不展示。该段记录 1.3 基线；后续建模与依赖校验进展见上方 1.4，页面布局编辑仍属后续批次。新增两个应用 DocType 及发布指针必须先迁移，只在隔离库验证。

### 9/23 受管普通表 XLSX 导入（页面已接并部署）

- `platform.object.import_preview` 为管理员只读 Service，参数 `object_id/expected_revision/filename/content_base64`；未选 `sheet` 返回工作表，选定后按 `header_row`（默认 1）返回列号/表头与样本。`mapping` 为逻辑字段 ID 到 1 起始源列号，提供 `match_field` 后返回逐行新增/更新/不变、前后差异、行列错误及 `preview_hash`。取消预检不写业务数据。
- `platform.object.import` 是管理员确认 Action/同名 Tool，增加必须的 `sheet/mapping/match_field/preview_hash`，复用原幂等入口。应用写锁之后当前读重算计划，指纹不符要求重新核对；内部组合原 create/update，任一行或审计失败全部回滚。逐行审计来源来自内部标记，客户端 `source` 不生效；历史只读结果增量附 `source=record|import`。
- 匹配列支持文本、整数、日期、选项；必须映射且非空，文件内重复、目标非唯一、回收记录占用均拒绝。匹配是本次导入选择，不自动给模型设置唯一键；已有表的全局唯一约束与恢复冲突不能由此冒称完成。
- `import_preview` 可选 `inspect_only:true` 仅检查源文件/表头，不要求对象、不接受映射或目标修订，仍仅管理员可调用。页面将表头交给原字段设计器；确认建表后才进入原记录导入预检/确认。取消建表前零DDL，建表后取消导入保留空表，不自动发布或扩大权限。
- 仅普通标量表，10MB XLSX、解压 50MB、500 行/100 列、5000 行目标匹配保护；不绕过原 BFF 20MB JSON 上限。拒绝公式、合并、关联/明细、旧 XLS，超限不截断。源文件不自动保存，数据行不依赖源文件存在。没有新增 HTTP 路由；既有表和新建表导入已在本地实页验证，公网与最终容量尚未验收。

### 9/23 基础附件正文预览（已部署并实测 DOCX 正文）

- 只读 Service `platform.file.preview(ref_doctype, ref_name, file)` 复用公共挂载投影及当前记录权限，已停用来源不能读取；邮件绑定后的引用按邮件自身授权，不依赖原文件中心启用。只支持 DOCX 文本段落/普通表格，返回结构化文本和排版限制，不返回可执行 HTML。
- 保护：20MB输入、ZIP解压50MB/1000项、正文XML20MB/10万节点、20万字符/3000块/1万单元格；拒绝宏、DTD/实体，超限明确报错。嵌入图片、对象与特殊排版不渲染，须下载原件查看。没有新增HTTP、缓存副本或解析状态表。

## S0 升级注意（历史增量，已随 API1.6 部署）

- 1.2 新增只读 `get_action_request_status(idempotency_key)`，HTTP 为 `public_api.http.action_request_status`。只允许有效原执行身份及动作角色读取，旧业务引用重查记录权限；不返回载荷、密文或完整执行结果。`legacy=true/replay_available=false` 表示只能核对原业务，不能换键重做。
- Action Request 新表必须先 migrate，备份包含原站点 encryption_key。只有旧审计而无完整请求指纹的执行不自动重放，原 `get_action_receipt` 查询保留；上线前需逐一验证旧调用方的恢复路径。
- **HTTP 原始发起接口是破坏性安全退役，不是假装 1.x 无影响升级**：`public_api.http.process_start`、`api.start_process_instance` 保留方法名与明确迁移错误，但不再创建实例；改用 HTTP **2.0** `public_api.http_v2.process_start(definition_id, values, idempotency_key, confirmed)`。新接口不接受任意 business_doctype/name，业务关联经领域受管动作建立。
- 当前 BFF 使用的 `public_api.http.process_launch` 不变；Python `public_api.start_process` 仍保留给可信领域运行器，财务调用不变。两个原始 HTTP 口没有仓内产品调用方，但外部调用方仍须部署前核对。因原口绕过授权和确认，不保留可继续写入的脆弱宽限期；本项为专项授权下的安全例外，不能推广为普通接口随意删除规则。

## 1.1 新增接口与真实边界

- `list_collaboration_people`：当前企业内启用的 System User 和 Active Identity。`identity_id`是平台稳定身份；API1.9兼容增加`user_name`作为原生Frappe User引用。旧`username`仍是协作键，不得当成邮件地址或Frappe用户名。`collaboration_key` 是兼容任务/消息的稳定引用：存量身份保留旧键，新身份采用 UUID，用户改名不改键。禁止再从 Node 用户表推断平台人员或降级认证。目录不是写授权，使用时仍核对当前身份/企业/角色和来源权限；无新写接口或身份创建。
- `get_process_launch_context`、`launch_process`、`get_process_task`、`complete_process_task`：通用发起与办理入口。写操作需要确认与幂等键；相同键不能删改输入。节点按实例固定版本推进，办理权限由服务端判定。
- `publish_portal_definition`：设计器发布入口，校验通用办理器是否支持。当前通用支持人工节点、已注册动作和基于 `process_input` 的结构化条件；未接领域适配的 AI 选择、等待事件、子流程、映射和旧式表单不能冒充通用可运行。底层 `publish_definition` 保留给已有可信运行集成，不等于自动具备通用 UI。
- `get_object_record`：按对象、单据和字段权限读取详情、关联流程及显式贡献的记录动作。不是任意 DocType 编辑接口；账本不因此开放修改。
- `get_action_receipt`、`record_action_receipt`、`list_reference_audits`：供现有领域操作迁出核心审计表直写；不是新的浏览器写入口，也不能替代业务动作本身的校验。新业务优先使用 `execute_registered_action`。
- `check_registered_manifests`：在已安装站点校验 manifest 与实际贡献资源。需测试/部署流程显式调用；不宣称已自动成为生产拦截器。

历史财务 HTTP/OCR 适配当前归入 Node `src/domains/finance/web.ts`，前端办理适配归入 `js/domains/finance-process.js`。领域旧 HTTP 端点仍是迁移例外，不能作为新行业接入模式；尚未完成通用附件协议与所有领域端点退役。任务/消息继续保留明确的 Node 存储兼容边界，AI 写操作进入确认卡，不双写 Frappe 同一事实。

升级必须先备份，再迁移新增 Identity、Process Instance、Node Execution 字段并执行身份键幂等补齐，随后更新 BFF 和前端缓存。不能只覆盖前端或单独启动依赖新字段的 BFF。历史在途财务实例仍须在脱敏快照上验证后上线；不能用新模板全链通过代替历史兼容验收。

## 能力分组

2026-09-15 C 首批修复（仅本地）：同步事件投递为每个消费者建立数据库 savepoint，消费者异常只回滚自身数据库写入，保留其他成功投递与失败记录；人工重试不重复调用已成功订阅。handler 不得自行提交事务，文件、外部 API 及事务回调不属于数据库 savepoint 的撤销保证，仍需目标幂等/显式对账。这不是完整可靠队列交付；并发投递、重启扫描、依赖冻结及跨域业务链仍待 C 后续验证。

| 分组 | 主要入口 | 业务域用途 |
|---|---|---|
| 领域 | `ensure_registered_domains`、`platform_contributions`、`assert_domain_enabled` | 注册、启停与投影应用/对象/流程/工具 |
| 身份权限 | `get_request_context`、`require_roles`、`require_capability` | 使用不可变 Identity、企业、角色、能力与 trace |
| 对象 | `list_object_definitions`、`get_object_definition`、`query_object_records` | 通过元数据读取业务对象，不复制通用查询层 |
| Action | `register_action`、`execute_registered_action`、`propose_registered_action`、`resolve_action_proposal` | 版本化执行、确认卡、幂等和审计 |
| Event | `publish_event`、`retry_event_delivery` | at-least-once 事件、幂等与失败恢复 |
| Service | `invoke_domain_service` | 跨域只调用显式公开服务 |

Service 可声明 `input_schema` / `output_schema`，执行时复用 Action 值校验子集：输入不合规不调用 handler，输出不合规拒绝结果并回滚该次服务内的数据库写入，不回滚调用方此前的有效写入。旧服务未声明 schema 时保持原返回兼容，不表示已验证其数据契约。handler 禁止自行 commit、DDL 或用服务绕过写 Action 的确认/幂等；数据库回滚不能撤销外部请求，外部副作用仍须目标幂等或对账处理。已有权限与领域启用检查先于参数校验执行。
| Process | `register_domain_process_definition`、`publish_definition`、`start_process`、节点执行 API | 稳定命名空间、不可变发布版本与实例运行 |
| 不可变事实 | `ImmutableDocument`、`ensure_immutable_triggers` | 审计、账本等 append-only 数据 |

## 领域贡献与所有权

每个 App 通过 hooks 返回一个贡献对象，并以 `shangshu-plugin.yml` 声明版本、依赖和导出资源。所有 ID 必须命名空间化；对象、动作、工具、服务、流程和页面只能由一个领域拥有，重复 owner 由契约门禁阻断。

应用既有 `home` 可引用正式页面注册表的页面ID；前端只解析当前角色可进入的注册页面，否则保持原数据集/总览落点，不解释任意URL或脚本。侧栏已有该工作面快捷入口时不重复列应用项；应用总览和原应用ID仍保留并进入同一工作面。没有快捷入口时继续显示应用。不按业务名称或测试名称隐藏，不改变后端域状态/记录权限；修改贡献后须显式重新注册。

稳定流程注册必须先有已安装且启用的领域贡献，定义 ID 必须位于 owner 的命名空间内。`register_domain_process_definition` 只在首次安装创建，不覆盖管理员已编辑的草稿。

### 工作台贡献

工作台使用独立 `workbench_api 1.0.0` 和机器 schema。业务 App 只能贡献已声明的默认 `metric` 卡片；数据 provider 必须位于 `owner_app` 命名空间、按当前用户权限只读查询，不能返回未声明 ID、改写路由或冒充其他领域。manifest 同时声明 `exports.workbench` 所有权。

当前布局能力是 `plugin_defaults_only`，还没有企业/角色/用户布局编辑器。完整契约、模板、生命周期和 Agent 禁改路径见 [`2026-09-02-工作台组件与布局扩展协议-v1.md`](../standards/workbench-extension-v1.md)。

`com.shangshu.core` 是受保护系统组件，只参与版本、健康和公共资源登记，不进入业务域启停生命周期。

## AI 写入规则

AI 不获得第二套业务写接口。可写工具与 Action 使用同一 ID；AI 先调用 `propose_registered_action` 生成提案，用户确认后由 `resolve_action_proposal` 进入统一执行面。高风险、append-only 或要求确认的 Action 不能通过直接 handler、BFF 私有路由或数据库写入绕开确认。

### 逐项受管审核（2026-10-15，本地 QA 候选）

本增量已在本地 QA3800 验证，不代表远端环境已经升级。只有可信原领域在 Action 贡献中显式声明私有 `review_handler` 的动作可以逐项接受；当前是 `mail.save_draft`、`files.sheet_cell_write`、`files.sheet_cells_write`。其他动作继续使用原完整确认。领域定义审核单位和原动作参数，核心独占提案状态、并发锁、幂等及审计；领域不得直接写 `Shangshu Action Proposal`。

- `get_action_proposal_review(proposal_id)`／`GET /api/platform/action-proposals/:id/review`：按当前角色及原资源、已绑定实际资源权限返回 descriptor。包含 `id/capability/created_via/status/review_revision/target/units/remaining/accepted_count`；每项有 `unit_id/value/current_value/status`。`created_via` 来自原提案，不能用候选 `payload.source` 猜来源。读取不创建草稿、不改正式值、不落表格行元数据。
- `accept_action_proposal_units(proposal_id, op_id, expected_review_revision, units=None, edited_value=None)`／`POST .../:id/accept`：请求 `{op_id, expected_review_revision, units?, edited_value?}`；省略 `units` 表示剩余全部。`edited_value` 是选中 `unit_id → 原候选形状的值` 映射（邮件原始字符串或数组、Excel 原 typed value），不是旧 resolve 的 type/value 字段包装。不能编辑单位身份、目标、版本或操作键。单批最多 20000 项，并继续受原 Action schema 限制。
- 一次接受先整批检查并锁定原资源，再调用一次原注册 Action；正式数据和审核状态在同一外层事务保存。首次确认仍核原提案记录版本，不能偷偷重基；后续待审位置被他人改动则拒绝。已接受后又被人改过的值不会被“确认剩余”覆盖。部分接受仍为 `proposed`，仅剩余数为零才 `confirmed`。
- 同 `op_id`、同选中项和改稿重试先复核当前权限，再恢复首次动作回执，不能产生新草稿或新版本；改变同键载荷拒绝。回执中的正式动作 `result` 来自首次执行，descriptor 是当前审核状态。未知结果保留候选和原键。旧 `resolve confirmed` 对上述待审／部分接受动作也只处理剩余；其他动作、历史完整确认回执保持原流。
- `resolve rejected` 只丢弃剩余，已保存部分及其审计保留；当前行列已失效也可在仍有当前写权限时拒绝，不伪造正式值：该终态可返回 `current_values_unavailable:true/units:[]`。未接受过任何项的已拒绝提案重试可能沿用旧 `status/idempotent` 回包，不应把它假定为待审 descriptor。裁决成功仍以真实状态与原资源读回为准。
- 邮件正文是整块单位，连带格式、内联资源和引用；附件连带标签。新草稿显示候选时零建稿，第一次接受才创建并绑定实际 `mail`；后续只保存选中项。新共享邮箱候选不能暗中随主题接受，descriptor 有组合依赖说明，须与至少一项非空内容同批确认；空草稿仍由原动作拒绝。
- `assert_no_pending_proposal_reviews(target)` 仅供原领域在已获权的发送 Action 内以真实资源调用；它没有对外发现接口，发现待审即拒绝。邮件已接入，在读取传输凭据前阻止含未决建议的草稿发送；接受建议只保存草稿，不外发。
- Excel 单位使用实际稳定 `row_id` 和当前 `header`，客户端只使用 descriptor 给的 `unit_id`，不推导或猜坐标。仍由原表格 Action 写入真实 XLSX；本增量不实现跨存储晋升、正文表格逐格审核或任意动作的自动拆分。

升级顺序：先为 `Shangshu Action Proposal` reload DocType，新增可选 `review_state_json`；同步核心和原领域 hook，运行 `ensure_registered_domains` 并提交，再重启实际 QA 进程／更新 BFF 与前端。没有历史值转换。私有 hook 路径、操作回执和原始审核状态不进入公共贡献投影。机器可读条款见 `contracts/platform-api-v1.json` 的 `partial_action_review`。

## HTTP/BFF 边界

浏览器和 Node BFF 只调用 `shangshu_core.public_api.http` 的白名单适配。新增领域资源依靠贡献与通用 action/service/process 路由出现，不应修改公共 BFF 去增加 `if domain == ...` 分支。平台模式身份必须来自 Frappe + `Shangshu Identity`，不能静默回退 Node 旧账号。

### 固定原件的记录字段候选（9/23）

- BFF `POST /api/platform/objects/:id/records/:name/file-suggestions` 为只读模型编排；唯一请求内容为 `source: {ref_doctype,ref_name,file}`。通过公共记录详情和附件读取校验当前会话，不接收客户端正文、模型地址或字段定义。模型配置复用 Node 原配置，不复制进 Frappe 或业务域。
- 仅受管对象可写标量字段；向模型提供所选原件正文和字段定义，不发送当前记录值或其他记录。TXT/MD/CSV 按 UTF-8 读取，DOCX 复用公共正文预览；PDF/PNG/JPEG 复用已配置 OCR 的原文，不使用财务字段或 mock。20MB/20000字/100字段上限明确拒绝，不截断。
- 返回 `source/expected_revision/expected_modified/candidates`；每项 `field/value/evidence` 经过原字段 schema 和连续原文片段检查。生成后复核权限与版本；无权403、输入/提取失败422，不能因此写正式值或持久化第二份候选库。
- 人工采用、修改或保留后，仍由既有 `files.review` 确认动作检查版本并原子保存。候选不是正确性保证，原文依据不等于语义匹配正确；模型不可用时保留手工草稿，人工审核独立可用。

## 错误与上下文

稳定上下文字段：`identity_id`、`enterprise_id`、`user_name`、`roles`、`capabilities`、`trace_id`。错误对外保持 `code`、`message`、`retryable`、`trace_id`；不要把 Python traceback、数据库异常或凭据返回给业务页面。

## 提交前门禁

### 集合与记录动作的通用 UI 投影（兼容增量）

- 代码数据集可声明 `collection_actions: [action_id]`；原数据集查询响应附带 `actions`，仅投影本域已注册、当前角色可执行的动作及其原 schema。用于直接新建/登记，不新建写接口、不以空流程中转。未声明时为空；旧客户端可忽略。
- 记录 `record_actions` 的 `hidden: [parameter]` 只从原 `bindings` 且有字段读取权限的值中选取，供编号/修订等参数自动携带。它只是表单显示规则，不是安全边界；提交仍由 Action 校验身份、状态、版本和载荷。
- `record_actions` 可用 `when_actor: {field: "applicant", relation: "self" | "other"}` 按当前 Frappe 用户与记录字段的相等关系隐藏不适用入口；仅管显示，不授予权限，Action 必须再次校验。
- 对象字段 `value_labels` 供列表/详情显示枚举中文名，不改变存储值。通用 UI 必须复用 schema 表单、确认、幂等键及失败保留输入；不得为领域复制一套 CRUD。
- 更新贡献须按标准迁移登记；既有受管应用冻结了声明摘要时需要显式检查后重发，不能静默刷新依赖。旧已发布流程仍保留，入口精简不删除在途实例。

```bash
npm run check:platform-contract
npm run test:platform-contract
npm run test:domain-boundary
npm --prefix shangshu-server run typecheck
```

行业分支还必须运行该领域策略检查与 Frappe App 测试。缺少公共能力时停止业务实现，按 CORE-CANDIDATE 单独提交到 `fast`，审核后再合入行业分支。

## C 增量：可靠跨域办理（2026-09-15）

- 域通过 manifest 声明依赖；版本、缺失与循环在迁移时检查。Action/Service 调用期间携带调用域，跨域调用必须声明目标依赖。此约束不是 Python 沙箱，不能把私有导入/裸 SQL 当合规路径。
- Service 可声明 `input_schema/output_schema`，共用 schema 校验与 savepoint；输出无效撤销本次服务写入，不撤销调用方之前的有效写入。旧无 schema 服务保持兼容，不宣称已具备强类型保证。
- `domains?include_disabled=1` 仅管理员可读，附 `lifecycle`：依赖要求/安装版本、已绑定应用、在途实例、未完成事件、停用阻断。启停执行共用预检，服务端最终复核。业务域可声明本域只读 `lifecycle_service`，返回 `blockers: string[]`；不另存运行事实。财务原费用流程显式声明可停用后续办，新增订单/拨款未完成则阻止停用。
- 写 Action 与领域启停共用生命周期锁，并用当前锁定读复查启用状态。当前单企业基线以串行化相关写入换取正确性，不承诺高吞吐并发；业务 handler 不得自行 commit。
- 事件 `delivery: after_commit` 将原 Event Envelope 和消费者快照随业务事务提交；不另建 Outbox，也不在发布函数内提交。原同步消费者保留库内事务语义。每消费者 savepoint，成功消费者不重跑；无消费者直接完成，之后新增订阅不追补旧事件。
- 调度器扫描已提交的 Published/Failed/Partial，间隔至少 60 秒、每轮最多处理 100 个信封、失败消费者自动尝试最多 5 次。人工重试仍用既有接口，保留原发布身份/企业，记录 `requested_by` 与尝试结果。原身份停用或企业改变则拒绝，不能提升为管理员执行。
- 外部消费者必须把稳定 `delivery_key` 传给支持幂等的目标。目标成功但响应丢失时同键重试；不支持幂等或结果不明时先对账再人工处理，禁止宣称 exactly-once 或自动补偿银行支付。
- `platform_contributions(include_work=True)`（HTTP `contributions?include_work=1`）可选附只读 `work_items/work_errors`。域通过 `purpose: work_items, effect: read` 的 Service 返回 `items`，每项 `dataset/name/title/step`；数据集必须归贡献域且属于当前可见应用，最多 100 项/服务。角色与记录权限在 provider 查询时执行；失败显式返回来源错误。它是快捷待办窗口而非全量业务目录，全量仍进入来源应用，不建第二 WorkItem 表。
- 全部待办合并流程、兼容任务和上述业务事项，办理回原流程/任务/记录 Action；不从聚合页直写状态。新增能力沿用原接口及组件，管理员诊断不向员工开放。

## D 增量：应用配置与定义交付（2026-09-16，本地候选）

- `platform.application.inspect` 为 System Manager 只读 Action/Tool，直接复用人工设计页的 `get_application_definition`，返回当前草稿、修订、模型和可用资源。AI 先读取再 configure，不能凭旧对话猜修订；对话确认事件保留服务端实时 preview，不另造 AI 配置权威。
- `platform.application.configure` 是 System Manager 的确认写 Action/同名 Tool，复用 `save_application_draft`。参数为 `application_id/expected_revision/definition`，可附预检返回的 `dependency_hash`；缺确认、修订过期、依赖指纹变化或越权均拒绝。人工、AI 共用校验、幂等和审计；不发布、不执行 DDL、不写业务记录。原草稿保存接口保留给旧客户端。
- `platform.application.delivery` 为 System Manager 只读 Service，`operation` 为 `export/change_preview/import_preview`。从既有定义实时投影，不维护第二配置表。`change_preview` 返回当前修订和差异；AI 提案读回同一投影，失效提案明确 blocked；服务端执行仍最终校验。
- 包格式 `shangshu.application/1`，顶层仅 `format/definition/models/dependencies`。含受管逻辑字段、页面、审批配置及代码域依赖锁；不含凭据、业务记录、物理表名或领域代码。自定义代码域需另行安装匹配版本；包不是完整站点备份。
- 导入仅克隆到新建空受管应用，不覆盖已配置/发布应用。关联与明细目标必须随包完整提供，同应用内按依赖顺序重映射；暂不支持循环模型关联。100 个模型、1MB 包上限。预检不建表；确认后客户端按原对象 `prepare/execute` 独立请求逐步建表，再调用 configure 保存草稿，发布仍单独操作。
- 相同包、目标应用和操作者复用幂等键，可恢复未完成步骤；换包/改动目标对象/取消原迁移后不得假装续跑，须处理原计划或另建空应用。已经提交但响应丢失时先查应用修订/动作回执，不用新幂等键重建。定义导入不自动搬移/合并业务数据，不保证任意第三方包可执行。


### QA候选：当前可变文件与附件快照（CORE-CANDIDATE，2026-10-15）

当前文件内容、动作日志和完整历史快照是不同对象。普通格值、格式和加列/加行更新同一工作File；内容修订用于并发检查，不增加完整文件历史。旧文件首次编辑可隔离一个私有工作File，避免修改历史或Frappe去重共享路径；之后File与路径保持不变。`WorkingFileTransaction` 是公共存储能力，业务App不导入core私有模块：临时恢复日志与DB提交/回滚回调配合，崩溃后按已提交摘要恢复；临时前镜像不是用户可见历史。

邮件引用当前表格时，绑定接口冻结独立、不可变且归该邮件的附件；不会新增文件中心/Excel资源或来源历史版本。现有 `files.versions` 的 `current` 表示当前工作内容，`versions` 保留既有历史，不可用历史数量推算最新内容修订。协议中的 `content_version` 名字保留兼容，其语义是当前内容修订。

文件域 `files.sheet_input_write` 统一普通单格坐标写入（已有区和自动扩展），与 `sheet_paste_apply` 共享私有原子写入实现，日志区分操作身份；扩展回执带同一事务的正式页面。该接口不是新增Assistant工具；原位审核沿原已注册 `sheet_cell_write/sheet_cells_write` 与逐项审核协议。以上仅3800候选，不能宣称fast已包含。

### 审核确认的只读可执行预检（2026-10-15，CORE-CANDIDATE）

`GET /api/platform/action-proposals/:id/review` 在原响应上追加：

- `can_accept: boolean`：当前身份是否可确认仍待审的项。读取权不代表修改权；检查沿原动作的 resolve 授权、原始版本、剩余项基线和工作簿可写状态。已确认部分不重复检查为待审项，不因第一次确认改变了初始版本而阻止剩余项。
- `accept_unavailable_reason: string`：不可确认的简明原因；权限不足不返回隐藏资源详情。可确认时为空。

预检不执行动作、不创建日志、不更新提案、不锁记录。提交仍重新校验权限、版本与审核修订号；预检不是授权凭证。前端未取得明确 `can_accept=true` 时禁用“全部确认”，读取失败可点“重新核对”。拒绝继续走原有后端裁决授权，不能用 `can_accept` 代替拒绝权限。现有提案没有独立时间失效字段，旧内容失效沿版本/基线检查，终态沿 status 判断。

同一只读响应追加 `can_reject` 与 `reject_unavailable_reason`：单独调用既有 `resolve + decision=rejected` 守卫判断，不能从可读/可写推断。原目录已授权的 `reject_only` 恢复路径保留，允许有权发起人放弃已失效目标；普通原卡在预检前禁用拒绝按钮，明确无权时保持禁用。


### 1.10 领域读取与内容权限接入（2026-10-19）

文件和邮件应用只通过 `public_api` 调用身份别名/部门键解析、内容闸注册、附件目标映射与权限检查。身份解析不授予资源权限；部门名称只在本企业启用部门中唯一匹配。`query_action_fact_audits` 固定返回字段和 500 行上限，服务端重新强制本人/管理员范围。`get_proposal_validation_snapshot` 先通过提案当前可见性再返回领域重验所需的快照，不是公开 HTTP 全文旁路。

既有 `action_proposal_summary`、`action_proposal_units` 的 HTTP 与 Python 入口使用同一实现。按 ID 读提案与列表共用审核资格及当前目标读取判定，发起人历史资格不能抵消目标撤权。本次没有新增员工日志页面，也没有新增首次晋升前端。


### 提案创建时定义快照（本地候选，2026-10-19）

可信领域可在 Action 贡献声明私有 `proposal_snapshot` 回调，签名为
`(action_id, payload, purpose, snapshot=None)`。`capture` 从服务端当前定义采集；
`inspect` 只读判断是否仍可接受；`validate` 锁目标并比较，锁保持至原受管动作完成。
回调路径不出现在公开贡献中，不是新增客户端工具或业务写口。

内核把创建时快照独立存入 `Shangshu Action Proposal.definition_snapshot_json`，
不修改业务载荷、请求指纹或候选值。新提案由服务端采集，同键重试不重新绑定当前定义。
整体确认与逐项接受在任何新写入前重新检查；已成功操作的同键回执恢复仍走当前权限重验，
不执行新的写入。字段规则仍由原动作后端最终校验，快照不替代权限或规则。

已声明该回调的动作，其历史无快照提案仍可查看、按原权限拒绝，但不能按新定义接受；
必须重新提议。其他领域未声明回调时不改变旧行为。迁移必须先重载提案 DocType、
再更新注册贡献和重启代码；禁止以当前定义回填旧提案，避免伪造创建时依据。
本地定向测试不代表部署或完整验收通过。


### 候选字段读投影（本地候选，2026-10-19）

`proposal_projection` 是可信领域私有回调，返回当前身份可读取的候选载荷和审核项范围。
提案原始存储不变；公开payload、summary、original、edited、字节数、units和计数在响应前投影。
全部不可读的候选不进入列表/计数，按ID读取拒绝；混合单元格候选保留可读项。
逐项确认和“全部确认”仅作用于当前可读单位，描述返回 `review_scope=currently_readable`；
内部完整unit集合保证不可读的剩余项不会被误标成Confirmed。不可读项ID也不能直接提交确认。
原始操作回执可能包含后来隐藏的值，字段投影的逐项响应不返回该旧result全文。
无法拆为独立审核项的动作不把过滤后的载荷当原动作执行；含不可读字段的坐标矩阵整体拒绝，
提示重新按可访问范围提议，不能移除中间列后悄悄移动写入目标。
升级需要刷新领域注册回调，局部自动测试不代替普通账号的真实API/浏览器验收。

### 动作的完整记录前置条件（本地候选，2026-10-19）

Action 贡献可声明私有 `execution_guard`，签名 `(action_id, payload, context) -> True`。
该回调必须属于动作的 `owner_app`，在公共鉴权、版本及幂等检查后、实际 handler 前执行；
抛错或返回非 True 都拒绝执行。无声明的普通编辑动作保持原行为。此 Action 回调与对象
原助手租约的同名回调分属不同资源，不能交换签名。

需要完整表格行的领域守卫调用公共服务，不导入文件域私有代码：

```python
from shangshu_core.public_api import invoke_domain_service

def ready_guard(action_id, payload, context):
    invoke_domain_service('files.row_require_ready', {
        'table': payload['table'], 'row_id': payload['row_id'],
    })
    return True
```

消费者 manifest 需声明文件域依赖，仍受公共域调用屏障及当前权限约束。
服务锁定当前资源、核读取权限及字段可读范围，按当前正式值和当前字段规则动态判断；
不是信任历史 `ready` 标记。返回就绪、内容/结构版本与定义指纹，不返回字段值。
锁保持至原动作外层事务结束。普通备注可保存为草稿，不被此办理前置条件拦截；
依赖完整记录的动作才声明守卫。重复幂等成功请求不重新办理；如需保护旧结果读取，
继续声明既有 `replay_guard`，不能用重新办理前置条件改写历史回执。

### 组织日志消费（2026-10-19 用户明确批准，本地候选）

老板读取本企业、负责人读取当前管理部门及下属部门日志；普通员工保留本人事实/回执。
独立 `audit_access` 按有效身份/当前企业/真实组织任命判断，资源共享或manager角色名不授日志权。
`query_action_audits(filters=None,page=1,page_length=50)` 返回既有所有动作审计的受控分页，
HTTP为 `public_api.http.action_audits`。过滤只支持actor_user/action_id/status/executor_source/name/idempotency_key精确值，数量与行用同一授权条件；每页最多200。
返回现存输入输出摘要和记录变更，不将摘要假称完整快照，也不重新解释历史值。
`authorize_audit_actor(user)` / `public_api.http.audit_actor` 给获权单一员工的可信身份与协作键，
供其他存储的日志证据读取再次校验归属。不能单凭客户端conversation_id或相近时间推断触发对话。
当前无可信关联的事件返回conversation_evidence=not_linked；此缺口不伪造成已有对话证据。

审计读取提案决定使用 `get_audit_proposal(user,proposal_id)` / HTTP `audit_proposal`，
先日志授权再校验提案所属员工和企业。仅返回状态/批准人/时间/真实回执及已接受项元数据，
不返回候选值或授予确认权。accepted/receipts各上限200并明确truncated；不冒充普通审核接口。

### 审计追溯恢复（2026-10-19）

`get_audit_trace(user, operation_id=None, request_id=None)` / `GET http.audit_trace` 是独立日志权限下的只读精确查询。两种编号必须择一：`operation_id` 是真实 Action Execution Audit 文档名，**不接受表格客户端 op_id**；`request_id` 是已持久化幂等键。先授权目标员工，再限定当前企业和不可变身份。请求可找到尚未执行的提案；审计可通过真实整条/逐项提案引用反查原请求。部分审核须交叉验证提案实际 accepted 回执，不能只信确认文本。

响应为 `{status:'linked', scope:'audit_only', can_confirm:false, actor_user, request_id, action_id, proposal_id, operation_id}`（后两个允许 null），未知为 `{status:'not_linked', scope:'audit_only', can_confirm:false}`。不返回候选值，不执行/重试动作，不授予审核权。Node 必须另外匹配本地不可变请求日志的 actor、request_id、action_id 后才恢复来源链接；随机键或 executor_source 本身不证明来源对话。

### 原对象伴随表（UI028，2026-10-19）

FDE动作 `platform.object.companion_bind`（System Manager、确认）接收 `object_id,file_id,field_columns`。原生native_table及受管标量主记录仍在原DocType；登记只保存企业/对象/工作文件及声明列映射。一个企业内一个对象只绑定一个工作文件，一个文件不可同时绑定多对象。原对象定义和目录返回 `companion` 元数据，files目录通过内部 `list_object_companion_files()` 排除伴随文件避免重复入口。

领域仅调用 `get_object_companion`、`get_file_companion`、`authorize_companion_cells`：授权函数返回当前允许的原record IDs和原field IDs，不授予文件权限，不修改原字段。普通列写须另外有文件write；原record不可读则不能在其行写备注。原字段写继续走原域Action。

core注册on_update钩子按已登记source_doctype/企业精确同步，使用当前源值及modified，不扫描所有对象、不按历史事件值重放；固定source→登记→file锁序，同事务失败即回滚。provider只能由files hooks固定声明，server-only投影scope退出恢复。初始绑定锁当前企业原记录并限制一万行，超过明确拒绝而非截断。原对象定义指纹改变拒绝后续使用，待FDE核验。删除处置、复杂reference/detail对象和大于一万行分段初始化仍为未交付边界；原字段db.set_value/SQL绕Document.save的写入不声称已被on_update覆盖。

### 归属移交 2.2.0（UI104）

`platform.org.resource_assign` 复用原动作；先 `dry_run:true` 取得 `expected_modified` 与权限影响，再确认携同版本。已归属资源只认当前owner_user或获权管理范围负责人/管理员；doc.owner为历史创建人，不保留永久控制权。个人owner_user为所有人，部门owner_user为当前管理人（不改变部门所有权和默认组织读范围）。部门移交必须明确owner_user，可用空字符串清空，不能省略后猜测。目标主体须有效同企业，负责人不能越管理范围。明确分享独立保留。

文件元数据新增can_assign，归属动作不得复用can_share/can_edit。成功原动作审计record_change保存归属before/after和版本。无版本、过期版本以及旧创建者夺回请求明确拒绝。

### 流程动作来源快照（UI038，本地候选）

Python driver可使用 `with process_node_provenance(execution, token):` 包裹既有 `execute_registered_action` 或 `propose_registered_action`。仅校验已存在的当前实例/节点/令牌与企业，不授予动作权；原动作角色、schema、确认及重放守卫保持。流程动作版本沿实例dependency_snapshot固定，不追随新注册版本；AI选择节点仍仅可执行原声明read/extract候选，不能因此写入。

提案/审计保存可空 `source_snapshot_json`，实例保存可空 `origin_snapshot_json`；人工确认与逐项确认继承原提案快照。公开 `source_provenance` 只读投影含流程定义版本、实例、节点执行、动作版本及已完成LLM节点参与记录，不含候选/节点输入输出。每次读取重新核现有流程可见权限；不可见返回unavailable，旧无快照返回not_linked。reference_execution仍为记录Assistant租约。

公开source仍兼容标签，不能制造可信流程证明。Assistant发起证明必须由Node用不可变tool_request journal及core audit_trace/日志授权匹配实际origin request/action/proposal；无匹配保持未核实，不伪造旧历史。LLM参与记录只说明实际节点选择记录存在，不证明候选内容由模型生成。

升级须先重载Proposal、Action Execution Audit、Process Instance三个DocType并迁移，再加载core/Node前端同版；不回填历史来源。`process_node_provenance`是Python上下文，无新增HTTP写口。


### 2026-10-28 只读服务长载荷

`public_api.http.service_read` 同时支持 GET/POST，均调用同一个 `read_registered_service`，effect=read、身份、生命周期及schema检查不变。POST仍需有效CSRF。BFF/Harness在编码后的上游URL超过3000字节时预选POST同一端点；短请求维持GET。权限拒绝、校验失败或取消不得换传输重试；不为长读取加载完整contributions目录。

### API 1.20.0 候选：会话关联与用户消息窗口

`issue_conversation` 为当前身份／企业签发24小时凭据；原HTTP `action_execute/action_propose` 兼容接受 `conversation_credential`。每轮工具运行复用一次签发；确认从原提案恢复标识，日志随原事务写入，不复制聊天正文。`query_action_audits` 新增 `conversation_key` 精确筛选，旧行仍为 `not_linked`。

`query_conversation_context(conversation_key, log_no, before=4, after=4)` 在原独立日志权限内返回同组动作窗口（每侧最多20）。BFF `GET /api/platform/audits/conversation-context` 再从服务器锚点沿原请求链读取 `user_message_window`：当前消息及前后各4条用户消息和对应内部调用。缺可信轮次／原聊天已删除即不可用；键不参与授权。窗口带读取时间及明确的超限标记。详见[本候选](../plans/2026-10-30-conversation-context-CORE-CANDIDATE.md)，未合入现有运行基线。
