// 判据：**域不许另开日志表**（整个平台只有一张统一日志表）。
//
// **测试通过 =** 跑 `node scripts/check-log-tables.mjs` ⇒ 退出码 0、
// 且输出里没有「违反 N 条」（N > 0）。
//
// **为什么要有这条**（2026-10-24 · PKG-083-T01）：
// 那道闸 **不在跑批的 gates 组里** ⇒ **没人盯它** ⇒ 哪天哪个域自己开了一张日志表，
// 没人会发现（规范里写着「机器检查器盯着」—— 事实是**没有机器在跑它**）。
// 判「什么算日志表」的规则**从内核契约取**（`unified-log-v1.json`），
// 检查器里不另写一套 ⇒ 契约改了，这条自动跟着变。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('没有域另开日志表', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/check-log-tables.mjs'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  assert.equal(code, 0, 'check-log-tables 必须退出 0（现在退出码 ' + code + '）：\n' + out);
  assert.ok(!/违反\s*[1-9]\s*条/.test(out), '闸报出了违反项：\n' + out);
});
