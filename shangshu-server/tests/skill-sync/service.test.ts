import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { createKey } from '../../src/capabilities/skill-sync/keys.ts';
import { pushSkill, pullSkill, listSkills, getHistory } from '../../src/capabilities/skill-sync/service.ts';

// 临时 repo 提交 files → main 的完整 bundle
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
  await g.add('.'); await g.commit('init');
  const bp = join(d, 'o.bundle');
  await g.raw(['bundle', 'create', bp, 'main']);
  return readFileSync(bp);
}

describe('service', { concurrency: false }, () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ss-service-test-'));
    process.env._SS_SKILL_DIR = root;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('push creates repo and pull returns a bundle', async () => {
    const up = createKey('u', 'upload');
    const bundle = await bundleOf([
      { path: 'a.md', content: 'hello' },
      { path: 'b.md', content: 'world' },
    ]);
    await pushSkill({ skill: 's1', parent: '', bundle }, up);

    const list = await listSkills();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 's1');
    assert.ok(list[0].head, 'head should be populated after push');

    const pulled = await pullSkill('s1');
    assert.ok(Buffer.isBuffer(pulled) && pulled.length > 0);
  });

  it('history returns commits', async () => {
    const up = createKey('u2', 'upload');
    const bundle = await bundleOf([{ path: 'x.md', content: 'x' }]);
    await pushSkill({ skill: 's2', parent: '', bundle }, up);
    const hist = await getHistory('s2');
    assert.ok(hist.length >= 1);
  });

  it('rejects push with invalid key', async () => {
    try {
      await pushSkill({ skill: 'x', parent: '', bundle: Buffer.alloc(0) }, 'bad-key');
      assert.fail('should throw');
    } catch (e: any) {
      assert.equal(e.message, 'INVALID_KEY');
    }
  });

  it('rejects push when behind (parent mismatch)', async () => {
    const up = createKey('u3', 'upload');
    const bundle = await bundleOf([{ path: 'x.md', content: 'x' }]);
    await pushSkill({ skill: 's3', parent: '', bundle }, up);
    try {
      await pushSkill({ skill: 's3', parent: 'not-the-current-head', bundle }, up);
      assert.fail('should throw');
    } catch (e: any) {
      assert.equal(e.message, 'BEHIND');
    }
  });
});
