import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';
import { SKILL_DIR, repoPath } from './paths.ts';
import type { CommitInfo, DiffEntry } from './types.ts';

function skillDir() { return process.env._SS_SKILL_DIR || SKILL_DIR; }
function pathFor(skill: string) { return repoPath(skill).replace(SKILL_DIR, skillDir()); }
// 统一临时路径命名（worktree / import / export 三处共用），便于排查跨端临时文件遗留。
function ssTmp(prefix: string, skill: string, ext = ''): string {
  return join(skillDir(), `.${prefix}-${skill}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

function git(skill: string): SimpleGit {
  return simpleGit(pathFor(skill));
}

async function withTempWorktree<T>(skill: string, fn: (tmpPath: string, g: SimpleGit) => Promise<T>): Promise<T> {
  const tmp = ssTmp('tmp', skill);
  mkdirSync(tmp, { recursive: true });
  const g = simpleGit(tmp);
  try {
    await g.clone(pathFor(skill), '.');
    // 显式钉死本地分支为 main：容器/老 git 默认分支可能是 master，
    // 否则提交落在 master 成为无父根提交，push 到 main 必 non-fast-forward。
    try {
      await g.checkout(['-B', 'main', 'origin/main']);
    } catch {
      // 空 repo（首次 init）origin/main 尚不存在，直接把 HEAD 指向 main
      await g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    return await fn(tmp, g);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function normalizePatch(patch: string): string {
  const lines = patch.split('\n');
  let inDiff = false;
  return lines
    .map(line => {
      if (!inDiff && /^ diff --git /.test(line)) {
        inDiff = true;
      }
      return inDiff && line.startsWith(' ') ? line.slice(1) : line;
    })
    .join('\n');
}

export async function initRepo(skill: string) {
  const p = pathFor(skill);
  mkdirSync(p, { recursive: true });
  await simpleGit().init(['--bare', p]);
  // bare repo HEAD 钉到 main（脱离对 git 默认分支的依赖）。
  // 不建空提交：首次 push 由客户端的「完整 bundle」创建 main，
  // 否则服务端空提交与客户端根提交无父子关系，fetch 必 non-fast-forward。
  await simpleGit(p).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const now = new Date().toISOString();
  return { name: skill, head: '', createdAt: now, updatedAt: now };
}

export async function getHead(skill: string): Promise<string> {
  try {
    const log = await git(skill).log(['-1', '--format=%H']);
    return log.latest?.hash || '';
  } catch { return ''; }
}

export async function applyPatch(skill: string, patch: string, author = 'shangshu') {
  await withTempWorktree(skill, async (tmp, g) => {
    await g.addConfig('user.email', `${author}@shangshu.local`);
    await g.addConfig('user.name', author);

    const patchFile = join(tmp, `.patch-${Date.now()}.txt`);
    const cleanPatch = normalizePatch(patch);
    writeFileSync(patchFile, cleanPatch);

    try {
      await g.raw(['am', patchFile]);
    } catch (err) {
      try { await g.raw(['am', '--abort']); } catch { /* ignore */ }
      await g.raw(['apply', patchFile]);
      await g.add('.');
      const subject = patch.match(/^Subject: (.*)$/m)?.[1]?.trim() || 'sync';
      await g.commit(subject, undefined, { '--author': `${author} <${author}@shangshu.local>` });
    } finally {
      rmSync(patchFile, { force: true });
    }

    await g.push('origin', 'HEAD:main');
  });
}

// 把客户端 bundle（新提交）fetch 进 bare repo 的 main。git 原生 packfile 传输：
// 二进制无损、大体积友好。FF-only——bundle 带 prerequisite(=parent)，服务端没有 parent
// 或服务端已领先都会被 git 拒绝（"Repository lacks these prerequisite commits" / non-fast-forward）。
export async function importBundle(skill: string, bundle: Buffer): Promise<string> {
  const p = pathFor(skill);
  const tmp = ssTmp('in', skill, '.bundle');
  writeFileSync(tmp, bundle);
  try {
    await simpleGit(p).raw(['fetch', tmp, 'main:refs/heads/main']);
    return await getHead(skill);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// 导出 bare repo 的 main 为 bundle（供客户端 pull）。
export async function exportBundle(skill: string): Promise<Buffer> {
  const p = pathFor(skill);
  const tmp = ssTmp('out', skill, '.bundle');
  try {
    await simpleGit(p).raw(['bundle', 'create', tmp, 'main']);
    return readFileSync(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function listCommits(skill: string): Promise<CommitInfo[]> {
  const raw = await git(skill).raw(['log', '--format=%H%x00%P%x00%s%x00%an%x00%aI']);
  if (!raw.trim()) return [];
  return raw.trim().split('\n').map(line => {
    const [hash, parent, message, author, date] = line.split('\0');
    return { hash, parent: parent || '', message, author, date };
  });
}

// 校验 git ref：堵住 option 注入。a/b 来自 HTTP query(/skills/:skill/diff?from=&to=)，
// 进入 git argv 前必须校验——否则 from=--output=/tmp/x 会被 git 当成选项，造成任意文件写。
// 允许 SHA、普通分支名（含 unicode）；拒绝 - 开头、.. 范围欺骗、: refspec、空格、^ ~ @{} 等修订指示符。
function assertGitRef(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
    throw new Error('非法 git ref（空或过长）');
  }
  if (ref.startsWith('-')) throw new Error(`非法 git ref（疑似选项注入）：${ref}`);
  if (/[\\\s~^:*?[\]]/.test(ref) || ref.includes('..') || ref.includes('@{')) {
    throw new Error(`非法 git ref（含特殊字符）：${ref}`);
  }
}

export async function getDiff(skill: string, a: string, b: string): Promise<DiffEntry[]> {
  assertGitRef(a);
  assertGitRef(b);
  const g = git(skill);
  const names = await g.raw(['diff', '--name-status', `${a}..${b}`]);
  if (!names.trim()) return [];
  const entries: DiffEntry[] = [];
  for (const line of names.trim().split('\n')) {
    const parts = line.split('\t');
    const code = parts[0];
    const path = parts[parts.length - 1]; // 重命名 R100 old new → 取新路径
    const mapped: DiffEntry['status'] = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    // 取该文件的完整 diff(上下文拉满=整文件),前端渲染成左右栏对照(改前|改后)
    const patch = await g.raw(['diff', '--unified=100000', '--no-color', a, b, '--', path]);
    entries.push({ path, status: mapped, patch });
  }
  return entries;
}
