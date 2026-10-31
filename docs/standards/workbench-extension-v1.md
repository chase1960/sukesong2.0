# 工作台组件与布局扩展协议 v1

> **文档状态：CURRENT（现行工作台扩展协议）**
>
> **状态：当前权威规范。** 本文约束所有内置业务域、行业分支和未来可信插件如何向尚书工作台贡献内容。与历史页面设计文档冲突时，以本文、`shangshu_core` 机器契约和根 `AGENTS.md` 为准。

## 1. 先讲清当前能力

当前 `workbench_api` 为 `1.0.0`，只支持由已安装、已启用领域提供的 `metric` 指标卡。插件可以声明默认卡片并按当前用户权限返回实时数值，公共前端统一渲染。

当前**没有**企业级工作台布局编辑器，也没有拖放、宽度、分组、角色布局覆盖或用户个性化。机器契约中的 `layout_mode` 明确为 `plugin_defaults_only`。不得把“领域默认卡片注册”描述成“工作台已经可编辑”。

后续布局能力必须以独立 CORE-CANDIDATE 增加通用 `Workbench Layout` 元数据，实现“平台基础组件 + 插件默认组件 + 企业覆盖 + 角色/用户可见性”；不得由某个行业分支直接修改公共工作台实现。

## 2. 三层所有权

| 层 | 所有者 | 可以做什么 | 不可以做什么 |
|---|---|---|---|
| 平台工作台壳 | `shangshu_core` + `shangshu-web` | 公共布局、安全渲染、统一 API、平台协作入口 | 保存财务/IP 等行业卡片清单 |
| 插件默认组件 | 业务 App | 声明卡片 ID、标题、类型、目标路由和数据提供器 | 修改公共前端、冒充其他领域、返回未声明卡片 |
| 企业布局覆盖 | 平台元数据（待实现） | 显隐、排序、尺寸、分组、角色/用户覆盖 | 改写插件业务查询、绕过权限 |

平台核心 `com.shangshu.core` 是系统组件，不是可选业务应用，永远启用；任何 UI、HTTP 或 Python 调用都不得停用它。

## 3. Agent 修改边界

行业 Agent 增加工作台卡片时，默认只修改自己的领域目录：

- `frappe_apps/<app>/<app>/hooks.py`
- `frappe_apps/<app>/<app>/domain.py` 或该领域自己的贡献模块
- `frappe_apps/<app>/shangshu-plugin.yml`
- 该领域测试和 `docs/domains/<domain>/**`

禁止直接修改：

- `frappe_apps/shangshu_core/**`
- `shangshu-server/src/adapters/web/platform.ts`
- `shangshu-web/js/real-dashboard.js`
- 全局侧栏、产品壳、身份权限和部署文件

如果 v1 的 `metric` 无法表达真实需求，停止实现，按 `docs/templates/CORE-CANDIDATE.md` 提交通用能力申请。禁止增加行业专用 `if domain == ...`、复制聚合器或把自定义 HTML/脚本塞进卡片字段。

## 4. 注册方式

### 4.1 Manifest 所有权

`shangshu-plugin.yml` 必须声明卡片 ID：

```yaml
exports:
  workbench:
    - example.pending_items
```

同一 ID 只能由一个 manifest 拥有；平台契约检查会阻断冲突。ID 必须命名空间化，推荐 `<domain>.<meaning>`，例如 `finance.open_payables`、`ip.pending_deadlines`。

### 4.2 Frappe Hook

```python
shangshu_domain_contributions = ["example_app.domain.get_contribution"]
```

贡献对象只有在声明工作台组件时才增加以下字段：

```python
{
    "id": "com.shangshu.example",
    "owner_app": "example_app",
    "workbench_api": "1.0.0",
    "workbench": [
        {
            "id": "example.pending_items",
            "title": "待处理事项",
            "kind": "metric",
            "route": "objects",
            "dataset": "example.item",
            "roles": ["Example User"],
        }
    ],
    "workbench_provider": "example_app.domain.workbench_cards",
}
```

提供器必须位于 `owner_app` Python 命名空间内。声明与提供器必须同时存在；没有卡片时三项均省略，不得注册返回空壳的私有提供器。

## 5. v1 声明契约

机器 schema：`frappe_apps/shangshu_core/shangshu_core/contracts/workbench-contribution-v1.schema.json`。

| 字段 | 必填 | 约束 |
|---|---:|---|
| `id` | 是 | 命名空间 ID；领域内及平台全局唯一 |
| `title` | 是 | 1–80 字符，面向业务用户 |
| `kind` | 是 | v1 只能是 `metric` |
| `route` | 是 | 尚书产品壳内的稳定路由 ID，不能是外链或任意脚本 |
| `dataset` | 否 | 必须是同一领域已经声明的数据集 |
| `roles` | 否 | Frappe 角色字符串数组；平台在返回前再次裁剪 |

声明中禁止放 `value`、SQL、handler、HTML、CSS、JavaScript、密钥或用户数据。结构属于插件默认定义，运行值由提供器产生。

## 6. 数据提供器契约

提供器无参数，在当前 Frappe session、企业和用户权限上下文中执行，返回数组。每项至少包含已声明的 `id` 和字符串/数字 `value`：

```python
def workbench_cards():
    count = frappe.get_list("Example Item", filters={"status": "Open"}, pluck="name")
    return [{
        "id": "example.pending_items",
        "value": len(count),
        "unit": "项",
        "description": "等待当前用户处理",
    }]
```

规则：

1. 必须使用 Frappe 权限感知查询；禁止 `ignore_permissions=True`、裸 SQL 或跨企业统计。
2. 可以不返回当前用户不可见或没有数据的已声明卡片，但不能返回未声明 ID。
3. 不能改写声明中的 `title`、`kind`、`route`、`dataset`，不能传入其他 `domain_id`。
4. `value` 只能是字符串或数字；`unit` 最长 16 字符，`description` 最长 200 字符。
5. 提供器只读，不创建单据、不调用写 Action、不发送消息、不改变缓存外业务事实。
6. 异常必须让统一 API 返回失败；禁止用伪造的 `0` 掩盖权限、数据库或依赖故障。

## 7. 启停、升级和未来卸载

- 安装：领域注册成功后，已启用领域的卡片自动进入工作台。
- 停用：业务域卡片立即从投影中消失；不删除业务数据和审计。
- 重新启用：相同 ID 恢复；不得生成随机新 ID。
- 升级：可以新增卡片或可选字段；删除/重命名卡片必须先经过弃用周期和迁移说明。
- 卸载：当前只支持可信 Frappe App 的 `retain_data`；完整卸载与布局孤儿治理尚未实现，不得宣称已经完成。
- 平台核心：禁止停用，不进入普通业务域启停生命周期。

## 8. AI 修改边界

AI 可以：

- 生成工作台布局或组件配置提案；
- 解释某张卡片的数据来源和当前权限；
- 在人工确认后修改未来的企业布局元数据。

AI 不可以：

- 直接修改插件默认声明；
- 通过卡片提供器执行写操作；
- 为绕过 v1 限制修改公共前端；
- 把无权限数据汇总成指标；
- 自动发布、启停业务域或停用平台核心。

## 9. 提交与验收门禁

领域提交至少运行：

```bash
npm run check:platform-contract
npm run test:platform-contract
npm run test:domain-boundary
bench --site <test-site> run-tests --app <domain-app>
bench --site <test-site> run-tests --app shangshu_core
```

必须覆盖：合法注册、重复 ID、未声明返回、跨领域伪装、角色裁剪、停用后消失、重新启用恢复、提供器异常和空数据。涉及公共组件类型、布局模型或渲染器时必须走 CORE-CANDIDATE，并在 `fast` 通过四组合门禁后再合回行业分支。

## 10. Agent 开工检查清单

1. 当前是否在 `industry/*` 或 `feature/<domain>-*`？
2. 是否只修改本领域 allowlist 路径？
3. manifest、贡献声明和提供器 ID 是否一致且命名空间化？
4. 需求是否能由 v1 `metric` 表达？不能则停止并提 CORE-CANDIDATE。
5. 查询是否天然受当前用户与企业权限约束？
6. 是否没有修改公共前端/BFF/core？
7. 是否添加领域测试并运行全部门禁？

任一项不能回答“是”，不得提交。
