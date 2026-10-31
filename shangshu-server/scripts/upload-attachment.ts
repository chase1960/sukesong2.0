// 独立命令行：把发票附件上传到飞书记录的「发票文件」字段（供 Windows 上手动跑/排查）。
// 用法：
//   tsx scripts/upload-attachment.ts <record_id>                 # 用该记录已有的本地附件映射上传
//   tsx scripts/upload-attachment.ts <record_id> <本地文件路径>   # 指定文件：先存本地再上传到该记录
import { loadConfig } from '../src/core/config.ts';
import { uploadAttachmentToRecord, attachLocal } from '../src/core/attachments.ts';
import { createFileStore } from '../src/core/files.ts';
import { readFileSync } from 'node:fs';

async function main() {
  const [recordId, filePath] = process.argv.slice(2);
  if (!recordId) {
    console.error('用法: tsx scripts/upload-attachment.ts <record_id> [本地文件路径]');
    console.error('  不给文件路径：用记录已有的本地附件映射上传到「发票文件」。');
    console.error('  给文件路径：先存本地 FileStore、关联记录，再上传到「发票文件」。');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (filePath) {
    const bytes = readFileSync(filePath);
    const name = filePath.split(/[/\\]/).pop() || 'attachment';
    const { token } = await createFileStore(cfg.file).upload(name, bytes, '');
    attachLocal(recordId, { token, filename: name, mime: '' });
    console.log(`已存本地附件 token=${token}，关联记录 ${recordId}`);
  }
  const r = await uploadAttachmentToRecord(recordId, cfg);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.uploaded ? 0 : 2);
}
main();
