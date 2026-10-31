// 两个编排器共用真实回执校验；不通过追加提示词/模型重试替代执行事实。
export const NO_CONFIRMATION_REPLY = '尚未生成有效确认提案，业务数据未因本轮对话写入。请检查工具错误后重试。';
export function claimsConfirmation(text: string): boolean {
  return /已提交待确认|已提交确认卡|确认卡已生成|已生成确认卡|以下是[^，。！？\n]{0,16}确认卡|已[^，。！？\n]{0,24}(?:生成|提交|创建)[^，。！？\n]{0,16}(?:待确认|确认(?:卡|提案)|提案)|待确认.*生效/.test(text);
}
