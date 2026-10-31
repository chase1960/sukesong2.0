# CORE-CANDIDATE：<能力名称>

## 真实阻断

- 行业域/业务链：
- 当前 public API 为什么无法完成：
- 为什么不能在领域内解决：

## 最小公共语义

- 拟新增/修改的 public API：
- 输入、输出、权限、确认、幂等、审计、错误：
- 资源 owner 与命名空间：

## 兼容与迁移

- platform_api 版本影响：
- 旧调用/旧实例是否继续运行：
- 数据迁移或新增 patch：
- 回滚/恢复方案：

## 明确不做

- 不放入 core 的行业逻辑：
- 不修改的公共前端/BFF/身份边界：

## 验证

- core 单测：
- finance 回归：
- 真实行业链：
- 四组合/升级恢复影响：
- 契约与领域边界门禁：

## 合并顺序

`CORE-CANDIDATE → fast 审核/测试 → 普通 merge 到 industry/<domain>`

禁止在行业分支先提交 core 改动、扩大 allowlist 或复制私有实现后再补手续。
