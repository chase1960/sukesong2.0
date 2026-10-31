export interface SyncKey {
  id: string;
  name: string;
  keyHash: string;
  role: 'upload' | 'download';
  createdAt: string;
}

export interface SkillRepoMeta {
  name: string;
  head: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommitInfo {
  hash: string;
  parent: string;
  message: string;
  author: string;
  date: string;
}

export interface PushInput {
  skill: string;
  parent: string;   // 服务端当前 head（'' = 首次推送），用于并发校验
  bundle: Buffer;   // git bundle（客户端新提交；二进制无损、packfile 压缩、可增量）
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  patch: string; // unified diff,前端按 +/- 行着色渲染(类 VSCode)
}

export interface ConflictFile {
  path: string;
  base?: string;
  ours?: string;
  theirs?: string;
}

export interface SkillSyncConfig {
  publicDownload: boolean;
  autoSyncAll: boolean;
  allowlist: string[];
  ignorePatterns: string[];
}
