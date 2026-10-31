// FileStore —— spec §5.4。文件存储的可换缝。
// local 实现：落本地目录；drive 实现：桩，包 lark-drive。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileStore } from './types.ts';

function makeLocal(dir: string): FileStore {
  return {
    async upload(name, bytes, mime) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const ext = extname(name) || '';
      const token = `${randomUUID()}${ext}`;
      writeFileSync(join(dir, token), bytes);
      return { token };
    },
    async read(token) {
      if (!token || token.includes('/') || token.includes('\\') || token === '.' || token === '..') throw new Error('非法文件 token');
      const bytes = readFileSync(join(dir, token));
      const ext = extname(token).slice(1).toLowerCase();
      const mime = ({
        pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
      } as Record<string, string>)[ext] || 'application/octet-stream';
      return { bytes, mime, name: token };
    },
  };
}

function makeDrive(_folderToken: string): FileStore {
  return {
    async upload() { throw new Error('drive FileStore 尚未实装。请把 file.provider 设为 local 演示；drive 实装见 spec §5.4。'); },
    async read() { throw new Error('drive FileStore 尚未实装。'); },
  };
}

export function createFileStore(cfg: { provider: string; local_dir: string; drive_folder_token: string }): FileStore {
  return cfg.provider === 'drive' ? makeDrive(cfg.drive_folder_token) : makeLocal(cfg.local_dir);
}
