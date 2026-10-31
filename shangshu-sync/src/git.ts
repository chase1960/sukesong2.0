import simpleGit from 'simple-git';
import { existsSync } from 'node:fs';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 确保本地 skill 是 git repo,且分支钉死为 main(新老 git 默认分支可能不同,
// 已有提交就改名,无提交就设 HEAD)。服务端 bare repo 也用 main,保持一致。
export async function ensureGit(skillPath: string) {
  const g = simpleGit(skillPath);
  if (!existsSync(join(skillPath, '.git'))) {
    await g.init();
  }
  const st = await g.status().catch(() => null);
  if (st && st.current && st.current !== 'main') {
    await g.raw(['branch', '-m', st.current, 'main']).catch(() => {});
  } else if (!st || !st.current) {
    await g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => {});
  }
}

export async function stageAndCommit(skillPath: string, message: string, author = 'shangshu-sync') {
  const g = simpleGit(skillPath);
  await g.add('.');
  const status = await g.status();
  if (status.files.length === 0) return null;
  await g.commit(message, undefined, { '--author': `${author} <${author}@local>` });
  return (await g.log(['-1'])).latest?.hash || '';
}

function bundleTmp(prefix: string) {
  return join(tmpdir(), `ss-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
}

// 生成要推送的 git bundle。parent = 服务端当前 head('' = 首次 → 完整 bundle)。
// parent 不是本地 main 祖先(本地落后/分叉)→ 抛 BEHIND,调用方应先 pull。
// parent 之后无新提交 → 返回 null(无需推送)。
export async function createPushBundle(skillPath: string, parent: string): Promise<Buffer | null> {
  const g = simpleGit(skillPath);
  let range: string;
  if (!parent) {
    range = 'main';
  } else {
    try {
      await g.raw(['merge-base', '--is-ancestor', parent, 'main']);
    } catch {
      throw new Error('BEHIND');
    }
    const count = (await g.raw(['rev-list', '--count', `${parent}..main`])).trim();
    if (count === '0') return null;
    range = `${parent}..main`;
  }
  const tmp = bundleTmp('push');
  await g.raw(['bundle', 'create', tmp, range]);
  try {
    return await readFile(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

// 应用 pull 回来的 bundle:fetch 进 FETCH_HEAD,再 ff-only 合并(更新 main + 工作区)。
export async function applyPullBundle(skillPath: string, bundle: Buffer) {
  const tmp = bundleTmp('pull');
  await writeFile(tmp, bundle);
  const g = simpleGit(skillPath);
  try {
    await g.raw(['fetch', tmp, 'main']);
    await g.raw(['merge', '--ff-only', 'FETCH_HEAD']);
  } finally {
    await rm(tmp, { force: true });
  }
}
