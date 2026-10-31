// 判据：**仓里每个守契约的闸，都必须在跑批里有人盯着**。
//
// **测试通过 =**
// ① `scripts/` 下每个 `check-*.mjs`／`verify-*.mjs` 闸都在下面的表里登记（漏一个就红）；
// ② 表里标着「跑仓库现状」的闸，各自有那份判据文件存在、且**真引用了那个闸**
//    （空壳文件不算数）；
// ③ 表里标着「只测规则逻辑」的闸，写明了**为什么本轮不接**（不许悄悄漏掉）。
//
// **为什么要有这条**（2026-10-24 · PKG-083-T01）：
// PKG-082 的教训 ——「那个契约闸长期红着，因为它**不在跑批里** ⇒ 没人盯」。
// 查下去发现同一类毛病不止一个：仓里 7 个闸，只有 3 个在跑批里跑仓库现状，
// **文档链接闸当时还红着 2 条**（没人知道）、**统一日志库闸没人跑**
// （规范里写着「机器检查器盯着」—— 事实是没有机器在跑它）。
// ⇒ 这条判据把「**闸不能悄悄没人盯**」钉住：以后新增一个闸而忘了登记，跑批就红。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(ROOT, 'scripts');
const TESTS = path.join(ROOT, 'scripts/tests');

/**
 * 仓里有哪些闸 —— **按文件名发现，不手写名单**：
 * 免得「新增一个闸却忘了登记」这件事自己把名单漏掉。
 */
function gatesOnDisk() {
  return readdirSync(SCRIPTS, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:check|verify)-.*\.mjs$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

/**
 * 每个闸现在有没有人盯着。
 * - mode 'repo'  ：有一份判据**跑它的仓库现状**（它红，跑批就红）
 * - mode 'logic' ：只有判据在**临时目录里跑它的副本**测规则逻辑，
 *                  仓库现状没人跑 ⇒ 必须写明为什么本轮不接
 */
const GATES = [
  {
    gate: 'check-platform-contract.mjs',
    mode: 'repo',
    test: 'check-platform-contract-compliance.test.mjs',
    why: '跨域只走公开口（PKG-082 钉进跑批）',
  },
  {
    gate: 'check-file-center-bypass.mjs',
    mode: 'repo',
    test: 'check-file-center-bypass.test.mjs',
    why: '所有进尚书的文件都得进文件中心（目标①）',
  },
  {
    gate: 'verify-kernel-baseline.mjs',
    mode: 'repo',
    test: 'verify-kernel-baseline.test.mjs',
    why: '内核基线快照对得上',
  },
  {
    gate: 'check-doc-links.mjs',
    mode: 'repo',
    test: 'check-doc-links.test.mjs',
    why: '文档里的本地链接都点得开（PKG-083 钉进跑批）',
  },
  {
    gate: 'check-log-tables.mjs',
    mode: 'repo',
    test: 'check-log-tables.test.mjs',
    why: '域不许另开日志表（PKG-083 钉进跑批）',
  },
  {
    gate: 'check-domain-boundary.mjs',
    mode: 'repo',
    test: 'check-domain-boundary-full-tree.test.mjs',
    why: '域不许越界（PKG-084 钉进跑批，并给闸加了「本域全量」口子 —— '
      + '差集口径在基线线上查到 0 个文件 ⇒ 绿但没看）',
  },
  {
    gate: 'check-style-rules.mjs',
    mode: 'repo',
    test: 'check-style-rules.test.mjs',
    why: '全站页面样式不许新增违反（PKG-084 钉进跑批）',
  },
  {
    gate: 'check-commit-policy-paths.mjs',
    mode: 'repo',
    test: 'check-commit-policy-paths.test.mjs',
    why: '提交时每个文件算哪一档都查得到 —— 公共壳一律内核、行业域一律专属（PKG-106 钉进跑批；'
      + '登记这件事是**基线第一遍红出来的**：新闸忘了登记 ⇒ 449 PASS / 1 FAIL，红的正是这条）',
  },
];

test('每个闸都在表里登记（新增闸忘了登记就红）', () => {
  const registered = new Set(GATES.map(entry => entry.gate));
  const missing = gatesOnDisk().filter(gate => !registered.has(gate));
  assert.deepEqual(missing, [], '这些闸没登记 —— 它们没人盯：\n' + missing.join('\n'));
});

test('登记的闸没有多余（表里写了却不存在 ⇒ 名单过期）', () => {
  const onDisk = new Set(gatesOnDisk());
  const stale = GATES.map(entry => entry.gate).filter(gate => !onDisk.has(gate));
  assert.deepEqual(stale, [], '表里这些闸在 scripts/ 下已经不存在：\n' + stale.join('\n'));
});

test('标「跑仓库现状」的闸，各有那份真跑它的判据', () => {
  for (const entry of GATES.filter(item => item.mode === 'repo')) {
    const file = path.join(TESTS, entry.test);
    assert.ok(existsSync(file), '闸 ' + entry.gate + ' 的判据文件不在：' + entry.test);
    const source = readFileSync(file, 'utf8');
    assert.ok(source.includes(entry.gate),
      '判据 ' + entry.test + ' 里没有真跑 ' + entry.gate + '（空壳不算数）');
  }
});

test('标「只测规则逻辑」的闸，都写明了为什么本轮不接', () => {
  for (const entry of GATES.filter(item => item.mode === 'logic')) {
    assert.ok(entry.why && entry.why.length > 10,
      '闸 ' + entry.gate + ' 没写明为什么不接');
    assert.ok(/待办|不许当它绿/.test(entry.why),
      '闸 ' + entry.gate + ' 的说明必须写明它是待办、不许当它绿了');
  }
});
