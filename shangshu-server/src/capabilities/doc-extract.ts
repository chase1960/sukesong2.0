// 单据抽取工具（M3）：按 DocType 抽取；内部级联 extract.text_rule → text_llm → vision，不再经 invoice.extract 黑箱。
import { registerCapability } from '../core/registry.ts';
import { cascadeDocExtract, registerExtractTools } from './extract-tools.ts';
import type { Capability } from '../core/types.ts';

const docExtract: Capability<
  { file_token: string; doctype?: string },
  Record<string, unknown>
> = {
  id: 'doc.extract',
  name: '按单据模板抽取',
  impl: 'external', effect: 'extract', roles: ['admin','finance','manager','staff','service'],
  async run(input, ctx) {
    return cascadeDocExtract(ctx, input);
  },
};

export function registerDocExtractTools(): void {
  registerExtractTools();
  registerCapability(docExtract);
}
