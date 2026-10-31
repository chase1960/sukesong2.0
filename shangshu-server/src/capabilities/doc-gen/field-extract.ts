// doc-gen.extract-fields 能力：从模板提取 {placeholder} 占位符
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Context } from '../../core/types.ts';
import type { FieldSchema, FieldDef } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');
const EXTRACT_SCRIPT = join(SCRIPTS_DIR, 'extract_fields.py');

interface ExtractFieldsInput {
  doc_type_id: string;
  template_file_token: string;
}

interface ExtractFieldsOutput {
  field_schema: FieldSchema;
}

export const docGenExtractFields: Capability<ExtractFieldsInput, ExtractFieldsOutput> = {
  id: 'doc-gen.extract-fields',
  name: '模板字段提取',
  impl: 'script',

  async run(input, ctx) {
    // 1. 读取模板文件
    const template = await ctx.file.read(input.template_file_token);
    const templateBase64 = template.bytes.toString('base64');

    // 2. 调用 Python 脚本提取占位符
    const payload = JSON.stringify({ template_base64: templateBase64 });
    const stdout = execFileSync('python3', [EXTRACT_SCRIPT], {
      input: payload,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });

    // 3. 解析占位符列表并映射为 FieldDef
    const result = JSON.parse(stdout.trim()) as { fields: string[] };
    const fields: FieldDef[] = result.fields.map((key) => ({
      key,
      label: key,
      type: 'text' as const,
    }));

    ctx.log(`📋 提取占位符: ${fields.length} 个`);
    return { field_schema: { fields } };
  },
};
