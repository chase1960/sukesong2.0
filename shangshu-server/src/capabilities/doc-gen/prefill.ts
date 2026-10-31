// doc-gen.prefill 能力：基于关键词规则预填字段
import type { Capability, Context } from '../../core/types.ts';

interface PrefillInput {
  doc_type_id: string;
  description: string;
}

interface PrefillOutput {
  fields: Record<string, any>;
}

// 预填规则：正则 → 字段 key
const PREFILL_RULES: Array<{ pattern: RegExp; field: string; group?: number }> = [
  { pattern: /项目[是为：:]([^，。,]+)/, field: 'project_name', group: 1 },
  { pattern: /总价[是为：:](\d+)/, field: 'total_amount', group: 1 },
  { pattern: /(\d+)[ ]?天工期/, field: 'schedule', group: 1 },
];

export const docGenPrefill: Capability<PrefillInput, PrefillOutput> = {
  id: 'doc-gen.prefill',
  name: '字段预填',
  impl: 'script',

  async run(input, ctx) {
    const fields: Record<string, any> = {};
    const desc = input.description;

    for (const rule of PREFILL_RULES) {
      const match = desc.match(rule.pattern);
      if (match && rule.group) {
        fields[rule.field] = match[rule.group].trim();
      }
    }

    ctx.log(`✨ 预填字段: ${Object.keys(fields).length} 个`);
    return { fields };
  },
};
