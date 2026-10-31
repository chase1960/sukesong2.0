# CORE-CANDIDATE：LLM 通道新增 OpenAI 兼容中转来源

> 黑客松演示赛道（2026-10-31）。演示域 `com.shangshu.recruitment` 需要一条可直连的 OpenAI 兼容端点做
> JD 生成 / 简历解析 / 筛选建议；现有 provider 只有 ollama / dashscope / deepseek，无法指向该中转服务。

## 真实阻断

- 行业域/业务链：招聘演示流水线（岗位 → JD → 简历 → 筛选 → 面试 → Offer → 入职）。
- 当前 public API 为什么无法完成：`RuntimeConfig.llm.provider` 与 `LlmSource.provider` 是封闭联合类型，
  不含 `openai`；把中转服务写成 `deepseek` 会走错鉴权/路径分支。
- 为什么不能在领域内解决：LLM 客户端只接受核心配置类型，域内自建 HTTP 客户端会绕开统一的模型来源与脱敏规则。

## 最小公共语义

- 拟新增/修改的 public API：`provider` 联合类型各加一个 `'openai'`（OpenAI 兼容 `/chat/completions` 流式协议）。
- 输入、输出、权限、确认、幂等、审计、错误：不改协议形状；沿用现有 `chatCompletionsStream` 的
  超时/中止/错误语义。模型来源仍是服务器侧配置，接口只回脱敏值。
- 资源 owner 与命名空间：无新增资源；配置归核心 `core/config.ts`。

## 兼容与迁移

- platform_api 版本影响：无（BFF 配置层，不涉及 Frappe public_api）。
- 旧调用/旧实例是否继续运行：是；`ollama` / `dashscope` / `deepseek` 分支不变。
- 数据迁移或新增 patch：无；`runtime_config.json` 缺省时回落到 `DEFAULT_CONFIG`。
- 回滚/恢复方案：删除新增来源或改回原 provider 即可，无落库结构变化。

## 明确不做

- 不放入 core 的行业逻辑：招聘状态机、AI 提示词、演示种子全部留在 `shangshu-server/src/capabilities/recruitment/`。
- 不修改的公共前端/BFF/身份边界：不改 `shangshu_core`、不改身份与审计链路。

## 验证

- core 单测：无新增内核测试（改动仅类型联合与默认配置）。
- finance 回归：未触碰财务路径。
- 真实行业链：招聘演示域真 LLM 三环节已实测（`fallback:false`）；不可达时自动落预录（`fallback:true`）。
- 四组合/升级恢复影响：无结构变更。
- 契约与领域边界门禁：`check:platform-contract` 通过；`check:domain`→exit 2（需评审，非禁止）。

## 合并顺序

`CORE-CANDIDATE → 审核/测试 → 普通 merge 到 industry/<domain>`
