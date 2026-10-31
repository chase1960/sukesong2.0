// 判据：**域边界闸在基线线上也得有料** —— 不许「查了 0 个文件」的假绿。
//
// **测试通过 =** 四个域的策略各跑一次「本域全量」⇒
// ① 退出码 **0**（本域没有禁止项，也没有需内核审核项）；
// ② 报告里**扫过的文件数 > 0**（`检查 N 个变更文件`）——
//    「查了 0 个文件」的绿**不算通过**：那是「没看」，不是「守住」；
// ③ 差集口径（不带 --full-tree）一旦查到 **0 个文件**，报告里必须**明说没查东西**
//    （不许把「没看」印成「通过」）。
//
// **为什么要有这条**（2026-10-24 · PKG-084-T01）：
// 那个闸按**差集**算（`git diff <尺子>...HEAD`）⇒ 在**基线线上**（当前分支就是尺子）
// 它查到的是 **0 个文件** ⇒ 「绿」但**什么都没查** ——
// 「域不许越界」这句话，在基线上**没有机器在守**。
// ⇒ 给它加「本域全量」的口子（`--full-tree`）：本域目录里的每个文件都过一遍内容规则。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICIES = readdirSync(path.join(ROOT, 'scripts/domain-policies'))
  .filter(name => name.endsWith('.json'))
  .map(name => name.replace(/\.json$/, ''))
  .sort();

function runGate(policy, extraArgs = []) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node',
      ['scripts/check-domain-boundary.mjs', '--policy', `scripts/domain-policies/${policy}.json`, ...extraArgs],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  return { code, out };
}

test('四个域的策略都发现了（不许悄悄少一个域）', () => {
  assert.deepEqual(POLICIES, ['files', 'device-client', 'example-domain', 'mail']);
});

for (const policy of POLICIES) {
  test(`${policy}：本域全量查一遍 ⇒ 退出码 0 ＋ 真的查了东西`, () => {
    const { code, out } = runGate(policy, ['--full-tree']);
    assert.equal(code, 0,
      `${policy} 的本域全量必须退出 0（现在退出码 ${code}；退出码 1＝有禁止项，2＝有需内核审核项）：\n` + out);
    assert.match(out, /本域全量/, '报告必须写明这次是「本域全量」：\n' + out);
    const scanned = out.match(/检查\s+(\d+)\s+个变更文件/);
    assert.ok(scanned, '报告里没有「检查 N 个变更文件」：\n' + out);
    assert.ok(Number(scanned[1]) > 0,
      `${policy} 这次查了 0 个文件 ⇒ 「绿」但没看，不算通过（请用 --full-tree）`);
  });
}

test('差集口径查到 0 个文件时，报告必须明说「什么都没查」', () => {
  for (const policy of POLICIES) {
    const { out } = runGate(policy);
    const scanned = out.match(/检查\s+(\d+)\s+个变更文件/);
    const count = scanned ? Number(scanned[1]) : 0;
    if (count === 0) {
      assert.match(out, /查了 0 个文件|什么都没查/,
        `${policy} 这次查了 0 个文件，报告却没明说没查东西：\n` + out);
    }
  }
});
