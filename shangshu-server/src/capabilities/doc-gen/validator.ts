// doc-gen.validate 能力：跨文档字段校验
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Context } from '../../core/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');
const VALIDATE_SCRIPT = join(SCRIPTS_DIR, 'validate_fields.py');

interface ValidateInput {
  fields_by_doc: Record<string, Record<string, any>>;
}

interface ValidationResult {
  level: 'error' | 'warn';
  message: string;
  field?: string;
  doc_type?: string;
}

interface ValidateOutput {
  results: ValidationResult[];
}

export const docGenValidate: Capability<ValidateInput, ValidateOutput> = {
  id: 'doc-gen.validate',
  name: '字段校验',
  impl: 'script',

  async run(input, ctx) {
    // 1. 调用 Python 脚本校验
    const payload = JSON.stringify({ fields_by_doc: input.fields_by_doc });
    const stdout = execFileSync('python3', [VALIDATE_SCRIPT], {
      input: payload,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });

    // 2. 解析结果
    const result = JSON.parse(stdout.trim()) as ValidateOutput;
    ctx.log(`🔍 字段校验完成: ${result.results.length} 个问题`);
    return result;
  },
};
