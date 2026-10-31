// 判据：**四个域的边界闸都拿同一把尺子量**（尺子＝当前基线线）。
//
// **为什么要有这条**：域边界闸（`scripts/check-domain-boundary.mjs`）是**按差集**算的 ——
//   `git diff <base>...HEAD` ⇒ 它量的是「**从 base 起到 HEAD，这批改动里哪些路径越界了**」。
//   ⇒ **base 停在老基线上，那个闸量的就不是「这个域自己的改动」，而是「这段时间所有人的改动」**
//   ⇒ **别域的历史全被算成它的越界**（实测：files 报 53 禁止／1817 需审核、
//   device-client 117／443、mail 38／490 —— 逐条核过，**全是别域的文件**）⇒
//   **400 多条噪声会把真正的新越界淹没** ⇒ **那个闸等于没在守**。
//
// ⚠️ **同一类毛病的前科**（`执行计划.md` 的 PKG-040-T01 行）：
//   `example-domain` 策略的 `base_branch` 指向**已改名的 ref**（`baseline/r967-20261019-integrated`）
//   ⇒ **example 域的边界检查自改名那天起就没真跑过**；那轮把它修成了当前基线。
//   本条是**把同一类毛病在剩下三个域上一起收掉**。
//
// **测试通过 =**（一句话）
// 「四个域策略的 `base_branch`：**都解析得出**（不是死 ref）＋ **都指向仓库里那条基线线**
//   （`baseline/*` 里的那一条）⇒ **闸量的是「这个域相对基线的改动」，
//   不是「这段时间所有人的改动」」。

import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_DIR = path.join(ROOT, 'scripts/domain-policies');

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const policies = fs.readdirSync(POLICY_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => ({
    name,
    policy: JSON.parse(fs.readFileSync(path.join(POLICY_DIR, name), 'utf8')),
  }));

it('① 四个域策略都在（少一个域 ⇒ 那个域的边界没人守）', () => {
  assert.ok(policies.length >= 4,
    '域策略只有 ' + policies.length + ' 份：' + policies.map(p => p.name).join('、'));
});

it('② 每个域策略的 `base_branch` **都解析得出**（指向死 ref ⇒ 那个闸根本没真跑过）', () => {
  for (const { name, policy } of policies) {
    const base = policy.base_branch;
    assert.ok(base, name + ' 没写 `base_branch` ⇒ 闸不知道从哪儿开始算');
    let resolved = null;
    try {
      resolved = git(['rev-parse', '--verify', '--quiet', base + '^{commit}']).trim();
    } catch {
      resolved = null;
    }
    assert.ok(resolved,
      name + ' 的 `base_branch`＝「' + base + '」**解析不出**（死 ref）⇒ '
      + '这个域的边界检查**从来没真跑过**（PKG-040 在 example-domain 上修过同一个毛病）');
  }
});

it('③ 四个域策略的 `base_branch` **都指向仓库里那条基线线**（老基线 ⇒ 报的是别域历史，不是本域越界）', () => {
  const branches = git(['branch', '--list', 'baseline/*'])
    .split('\n').map(line => line.trim().replace(/^\*\s+/, '').replace(/^\+\s+/, '')).filter(Boolean);
  assert.equal(branches.length, 1,
    '仓库里那条基线线不唯一（' + branches.join('、') + '）⇒ 判据说不清「当前基线」是哪一条');
  const tip = git(['rev-parse', branches[0]]).trim();
  for (const { name, policy } of policies) {
    const resolved = git(['rev-parse', '--verify', '--quiet', policy.base_branch + '^{commit}']).trim();
    assert.equal(resolved, tip,
      name + ' 的 `base_branch`＝「' + policy.base_branch + '」**不是当前基线线**（' + branches[0]
      + '）⇒ 那个闸量的不是「这个域自己的改动」，而是「这段时间所有人的改动」'
      + ' ⇒ **别域的历史被算成它的越界**（噪声淹没真越界）');
  }
});
