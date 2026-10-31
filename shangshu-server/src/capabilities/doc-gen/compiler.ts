// doc-gen.compile 能力：模板 + 字段 → 编译后的 docx 文件
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Context } from '../../core/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');
const COMPILE_SCRIPT = join(SCRIPTS_DIR, 'compile_docs.py');

interface CompileInput {
  template_file_token: string;
  doc_type: string;
  fields: Record<string, any>;
}

interface CompileOutput {
  file_token: string;
  file_name: string;
}

export const docGenCompile: Capability<CompileInput, CompileOutput> = {
  id: 'doc-gen.compile',
  name: '文档编译',
  impl: 'script',

  async run(input, ctx) {
    // 1. 读取模板文件
    const template = await ctx.file.read(input.template_file_token);
    const templateBase64 = template.bytes.toString('base64');

    // 2. 调用 Python 脚本编译
    const payload = JSON.stringify({
      doc_type: input.doc_type,
      template_base64: templateBase64,
      fields: input.fields,
    });

    const stdout = execFileSync('python3', [COMPILE_SCRIPT], {
      input: payload,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });

    // 3. 解码 base64 docx
    const docxBuffer = Buffer.from(stdout.trim(), 'base64');

    // 4. 上传结果文件
    const fileName = `${input.doc_type || 'document'}.docx`;
    const { token } = await ctx.file.upload(fileName, docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    ctx.log(`⚡ 文档编译完成: ${fileName}`);
    return { file_token: token, file_name: fileName };
  },
};
