// doc-gen 能力注册入口
import { registerCapability, registerRoute } from '../../core/registry.ts';
import { docGenCompile } from './compiler.ts';
import { docGenValidate } from './validator.ts';
import { docGenExtractFields } from './field-extract.ts';
import { docGenPrefill } from './prefill.ts';
import { docGenRouter } from './api.ts';
import { buildContext } from '../../core/context.ts';
import type { ExternalServices } from '../../core/types.ts';

export function registerDocGen(external?: ExternalServices) {
  registerCapability(docGenCompile);
  registerCapability(docGenValidate);
  registerCapability(docGenExtractFields);
  registerCapability(docGenPrefill);

  registerRoute('/api/doc-gen', docGenRouter(() => buildContext(() => {}, { external })));
}
