import { readdir } from 'node:fs/promises';
import { initRepo, getHead, importBundle, exportBundle, listCommits, getDiff as gitDiff } from './git.ts';
import { validateKey } from './keys.ts';
import { SKILL_DIR } from './paths.ts';
import type { PushInput, CommitInfo, DiffEntry, ConflictFile } from './types.ts';

// push:parent 必须等于服务端当前 head(''=='' 允许首次),否则 BEHIND。
// 通过 git bundle 原生传输(二进制无损、packfile 压缩、可增量)。
export async function pushSkill(input: PushInput, key: string): Promise<string> {
  if (!validateKey(key, 'upload')) throw new Error('INVALID_KEY');
  const current = await getHead(input.skill);
  if (input.parent !== current) throw new Error('BEHIND');
  if (!current) await initRepo(input.skill);
  return importBundle(input.skill, input.bundle);
}

export async function pullSkill(skill: string, key?: string): Promise<Buffer> {
  if (key && !validateKey(key, 'download')) throw new Error('INVALID_KEY');
  return exportBundle(skill);
}

export async function listSkills(key?: string) {
  if (key && !validateKey(key, 'download')) throw new Error('INVALID_KEY');
  const dir = process.env._SS_SKILL_DIR || SKILL_DIR;
  const names: { name: string; head: string; updatedAt: string }[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.endsWith('.git')) {
        const skill = e.name.replace(/\.git$/, '');
        names.push({ name: skill, head: await getHead(skill), updatedAt: '' });
      }
    }
  } catch { /* empty dir */ }
  return names;
}

export async function getHistory(skill: string): Promise<CommitInfo[]> {
  return listCommits(skill);
}

export async function getSkillDiff(skill: string, a: string, b: string): Promise<DiffEntry[]> {
  return gitDiff(skill, a, b);
}

export async function resolveConflict(skill: string, files: ConflictFile[], key: string) {
  if (!validateKey(key, 'upload')) throw new Error('INVALID_KEY');
  throw new Error('NOT_IMPLEMENTED');
}
