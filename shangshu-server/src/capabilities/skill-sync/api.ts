import express, { Router } from 'express';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushSkill, pullSkill, listSkills, getHistory, getSkillDiff, resolveConflict } from './service.ts';
import { createKey, listKeys, revokeKey } from './keys.ts';
import { SKILL_DIR } from './paths.ts';

// 把所有 skill 的最新 main 打成一个 tar.gz。用临时目录逐个 git archive 解出来再打单 tar
// (不能直接拼接 git archive 输出——每个带 end-of-archive 标记,标准 tar -xzf 只解第一个)。
async function streamSkillsTarGz(res: express.Response) {
  const skills = (await listSkills()).filter(s => s.head);
  const base = process.env._SS_SKILL_DIR || SKILL_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'ss-export-'));
  try {
    // 各 skill 的 git archive + tar extract 相互独立，并行执行（Promise.all）压低总耗时；
    // skill 数量通常几十以内，并发 spawn 可控。
    await Promise.all(skills.map((s) => new Promise<void>((resolve, reject) => {
      const out = join(tmp, s.name);
      mkdirSync(out, { recursive: true });
      const arc = spawn('git', ['--git-dir', join(base, `${s.name}.git`), 'archive', '--format=tar', 'main']);
      const ext = spawn('tar', ['-x', '-C', out]);
      arc.stdout.pipe(ext.stdin);
      arc.on('error', reject);
      ext.on('error', reject);
      ext.on('close', c => (c === 0 ? resolve() : reject(new Error(`extract failed: ${s.name}`))));
    })));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="shangshu-skills.tar.gz"');
    const pack = spawn('tar', ['-czf', '-', '-C', tmp, '.']);
    pack.stdout.pipe(res);
    pack.stderr.on('data', d => console.error('[skill-export]', d.toString().trim()));
    await new Promise<void>(done => pack.on('close', () => { res.end(); done(); }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 一键下载页(只读消费方):按钮 + 一条直接落到 ~/.claude/skills 的安装命令
function downloadPage(origin: string): string {
  const url = `${origin}/api/skills/export.tar.gz`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>尚书 · Skill 下载</title>
<style>
:root{--bg:#f7f6f1;--card:#fff;--ink:#1f2430;--mut:#6b7280;--ac:#1f7a4d;--bd:#e5e3da}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif}
.wrap{max-width:640px;margin:48px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 28px}
.btn{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;padding:14px 28px;border-radius:2px;font-size:16px;font-weight:600;transition:transform .15s}
.btn:hover{transform:translateY(-1px)}
.box{margin-top:28px;background:var(--card);border:1px solid var(--bd);border-radius:2px;padding:18px 20px}
.box h2{font-size:14px;margin:0 0 10px;color:var(--mut);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.cmd{display:flex;gap:10px;align-items:center;background:#f1efe7;border:1px solid var(--bd);border-radius:2px;padding:10px 12px;overflow:auto}
.cmd code{white-space:nowrap}
.copy{margin-left:auto;cursor:pointer;background:var(--card);border:1px solid var(--bd);border-radius:2px;padding:4px 10px;font-size:12px;color:var(--mut)}
.note{color:var(--mut);font-size:13px;margin-top:10px}
</style></head><body><div class="wrap">
<h1>尚书 · Skill 下载</h1>
<p class="sub">只读消费:一键下载全部 skill,解压到 <code>~/.claude/skills</code> 即生效。</p>
<a class="btn" href="/api/skills/export.tar.gz" download>⬇ 下载全部 Skill(tar.gz)</a>
<div class="box"><h2>一键安装(推荐 · 直接落到 ~/.claude/skills)</h2>
<div class="cmd"><code>curl -sL ${url} | tar -xz -C ~/.claude/skills</code><span class="copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);this.textContent='已复制'">复制</span></div>
<p class="note">或点上面按钮下载文件,再 <code>tar -xzf shangshu-skills.tar.gz -C ~/.claude/skills</code>。<br>目标目录 <code>~/.claude/skills</code> 是 Claude Code 自动识别的 skill 目录,装完重启 Claude Code 生效。</p>
</div></div></body></html>`;
}

export function skillSyncRouter(): Router {
  const r = Router();

  // push：body 是 git bundle（application/octet-stream,二进制 + 大体积）,路由级 raw 解析
  // （全局 express.json 不处理 octet-stream,故 body 流到这里仍是完整的,由本中间件读为 Buffer）
  r.post('/skills/:skill/push', express.raw({ type: 'application/octet-stream', limit: '300mb' }), async (req, res) => {
    try {
      const key = req.headers['x-shangshu-key'] as string;
      const parent = (req.query.parent as string) || '';
      const bundle = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
      const head = await pushSkill({ skill: req.params.skill, parent, bundle }, key);
      res.json({ ok: true, head });
    } catch (e: any) {
      if (e.message === 'INVALID_KEY') return res.status(401).json({ error: '密钥无效' });
      if (e.message === 'BEHIND') return res.status(409).json({ error: '版本落后，请先 pull' });
      res.status(400).json({ error: e.message });
    }
  });

  // pull：返回 git bundle 字节流（application/octet-stream）
  r.get('/skills/:skill/pull', async (req, res) => {
    try {
      const key = req.headers['x-shangshu-key'] as string | undefined;
      const bundle = await pullSkill(req.params.skill, key);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(bundle);
    } catch (e: any) {
      if (e.message === 'INVALID_KEY') return res.status(401).json({ error: '密钥无效' });
      res.status(400).json({ error: e.message });
    }
  });

  // list
  r.get('/skills', async (req, res) => {
    try {
      const key = req.headers['x-shangshu-key'] as string | undefined;
      res.json(await listSkills(key));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // status
  r.get('/skills/:skill/status', async (req, res) => {
    try {
      const key = req.headers['x-shangshu-key'] as string | undefined;
      const list = await listSkills(key);
      const skill = list.find(s => s.name === req.params.skill);
      if (!skill) return res.status(404).json({ error: 'skill 不存在' });
      res.json(skill);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // history
  r.get('/skills/:skill/history', async (req, res) => {
    try { res.json(await getHistory(req.params.skill)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // diff
  r.get('/skills/:skill/diff', async (req, res) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string };
      if (!from || !to) return res.status(400).json({ error: '缺少 from/to' });
      res.json(await getSkillDiff(req.params.skill, from, to));
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // conflict resolution (stub for multi-center)
  r.post('/skills/:skill/resolve', async (req, res) => {
    try {
      const key = req.headers['x-shangshu-key'] as string;
      await resolveConflict(req.params.skill, req.body.files, key);
      res.json({ ok: true });
    } catch (e: any) {
      if (e.message === 'NOT_IMPLEMENTED') return res.status(501).json({ error: '多中心合并尚未实现' });
      res.status(400).json({ error: e.message });
    }
  });

  // 一键下载页(公开,只读消费方)
  r.get('/skills/download', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const origin = `${proto}://${req.get('host')}`;
    res.type('html').send(downloadPage(origin));
  });

  // 全部 skill 的 tar.gz(公开)
  r.get('/skills/export.tar.gz', async (_req, res) => {
    try { await streamSkillsTarGz(res); }
    catch (e: any) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  return r;
}

export function skillKeyRouter(): Router {
  const r = Router();
  // 路径用根相对：挂载点为 /api/skill-keys（server.ts 处做 admin 校验），避免 /skill-keys/skill-keys 双层前缀

  r.get('/', (_req, res) => res.json(listKeys()));
  r.post('/', (req, res) => {
    const { name, role } = req.body;
    const raw = createKey(name, role);
    res.json({ ok: true, key: raw });
  });
  r.delete('/:id', (req, res) => {
    revokeKey(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
