import chokidar from 'chokidar';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { LocalConfig } from './config.ts';
import { SyncClient } from './client.ts';
import { ensureGit, stageAndCommit, createPushBundle, applyPullBundle } from './git.ts';

export async function watch(cfg: LocalConfig) {
  const client = new SyncClient(cfg);
  const watcher = chokidar.watch(cfg.skillsDir, {
    ignored: cfg.ignorePatterns,
    ignoreInitial: true,
    depth: 99,
    awaitWriteFinish: { stabilityThreshold: 500 },
  });

  const queue = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  watcher.on('change', (path: string) => queuePush(path));
  watcher.on('add', (path: string) => queuePush(path));
  watcher.on('unlink', (path: string) => queuePush(path));

  function queuePush(filePath: string) {
    const skill = relativeSkill(cfg.skillsDir, filePath);
    if (!skill) return;
    if (!cfg.autoSyncAll && !cfg.allowlist.includes(skill)) return;
    queue.add(skill);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  }

  async function flush() {
    for (const skill of queue) {
      try { await pushSkill(skill, cfg, client); }
      catch (e: any) { console.error(`[sync] ${skill} push failed:`, e.message); }
    }
    queue.clear();
  }

  console.log(`[watch] 监听 ${cfg.skillsDir}`);
}

function relativeSkill(skillsDir: string, filePath: string): string | null {
  const rel = filePath.replace(skillsDir + '/', '');
  if (!rel || rel.startsWith('.')) return null;
  const first = rel.split('/')[0];
  return first.replace(/\.md$/, '');
}

export async function pushSkill(skill: string, cfg: LocalConfig, client: SyncClient) {
  if (!cfg.uploadKey) throw new Error('未配置 uploadKey');
  const skillPath = join(cfg.skillsDir, skill);
  if (!existsSync(skillPath)) throw new Error(`skill 不存在: ${skillPath}`);
  await ensureGit(skillPath);
  await stageAndCommit(skillPath, `sync: ${new Date().toISOString()}`);
  const status = await client.status(skill).catch(() => null);
  if (!status) {
    // 拿不到服务端状态(网络/鉴权)时不推送：否则 parent='' 会构建完整 bundle，服务端必判 BEHIND 拒绝、徒增噪声。
    // 下次文件变更会重新获取 status，正常后即自愈。
    console.warn(`[push] ${skill} 无法获取服务端状态，跳过本次推送`);
    return;
  }
  const parent = status.head || '';
  const bundle = await createPushBundle(skillPath, parent); // 可能抛 BEHIND,或返回 null(无新提交)
  if (!bundle) { console.log(`[push] ${skill} 无新提交,跳过`); return; }
  const res = await client.push(skill, parent, bundle);
  console.log(`[push] ${skill} -> ${(res.head || '').slice(0, 7) || 'ok'}`);
}

export async function pullAll(cfg: LocalConfig) {
  const client = new SyncClient(cfg);
  const skills = await client.list();
  for (const s of skills) {
    const skillPath = join(cfg.skillsDir, s.name);
    if (!existsSync(skillPath)) mkdirSync(skillPath, { recursive: true });
    await ensureGit(skillPath);
    const bundle = await client.pull(s.name);
    await applyPullBundle(skillPath, bundle);
    console.log(`[pull] ${s.name}`);
  }
}
