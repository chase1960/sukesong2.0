import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { initRepo, getHead, importBundle, exportBundle, listCommits } from '../../src/capabilities/skill-sync/git.ts';

describe('git wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'ss-git-test-'));
  const skillName = 'demo';
  before(() => { process.env._SS_SKILL_DIR = root; });
  after(() => { rmSync(root, { recursive: true, force: true }); delete process.env._SS_SKILL_DIR; });

  // 把 files 提交到一个临时 repo，产出 main 的完整 bundle（git 原生 packfile，二进制安全）
  async function bundleOf(files: { path: string; content: string }[]): Promise<Buffer> {
    const d = mkdtempSync(join(tmpdir(), 'ss-src-'));
    const g = simpleGit(d);
    await g.init();
    await g.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await g.addConfig('user.email', 't@t'); await g.addConfig('user.name', 't');
    for (const f of files) {
      const segs = f.path.split('/').slice(0, -1);
      if (segs.length) mkdirSync(join(d, ...segs), { recursive: true });
      writeFileSync(join(d, f.path), f.content);
    }
    await g.add('.'); await g.commit('c');
    const bp = join(d, 'o.bundle');
    await g.raw(['bundle', 'create', bp, 'main']);
    return readFileSync(bp);
  }

  it('initRepo creates bare repo with main HEAD and no commits', async () => {
    await initRepo(skillName);
    assert.equal(await getHead(skillName), '');
  });

  it('importBundle fast-forwards main; exportBundle round-trips files', async () => {
    const bundle = await bundleOf([
      { path: 'a.md', content: 'hello' },
      { path: 'sub/b.md', content: 'world' },
    ]);
    const head = await importBundle(skillName, bundle);
    assert.ok(head, 'importBundle should return a head');

    const out = await exportBundle(skillName);
    assert.ok(Buffer.isBuffer(out) && out.length > 0);

    // 把导出的 bundle fetch 进新 repo，验证文件内容
    const d = mkdtempSync(join(tmpdir(), 'ss-dest-'));
    const g = simpleGit(d); await g.init();
    const bp = join(d, 'i.bundle'); writeFileSync(bp, out);
    await g.raw(['fetch', bp, 'main']);
    await g.raw(['checkout', 'FETCH_HEAD']);
    assert.equal(readFileSync(join(d, 'a.md'), 'utf-8'), 'hello');
    assert.equal(readFileSync(join(d, 'sub/b.md'), 'utf-8'), 'world');
  });

  it('listCommits returns history', async () => {
    const commits = await listCommits(skillName);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].message, 'c');
  });
});
