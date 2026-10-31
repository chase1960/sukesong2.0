// 判据：**样式不许新增违反**（样式规则闸也得在跑批里盯着）。
//
// **测试通过 =** 跑 `node scripts/check-style-rules.mjs` ⇒
// ① 退出码 **0**（没有「新增违反」）；
// ② 报告里**检查项数 > 0**（不许「什么都没查」的绿）；
// ③ **新增违反 = 0 条**（已登记在基线里的存量违反允许存在，但要看得见数目）。
//
// **为什么要有这条**（2026-10-24 · PKG-084-T01）：
// 那个闸**不在跑批的 gates 组里** ⇒ 没人盯 ⇒
// 「全站页面长得一样」这件事**没有机器在守**（今天它自己跑是绿的：
// 103 条检查项、31 条**已登记的存量违反**、新增 0 条）。
// 退出码语义：0＝没有新增违反；1＝有新增违反；2＝用法/环境错。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('样式没有新增违反，且这次真的查了东西', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/check-style-rules.mjs'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  assert.equal(code, 0, 'check-style-rules 必须退出 0（现在退出码 ' + code + '）：\n' + out);
  const rules = out.match(/检查项\s+(\d+)\s+条/);
  assert.ok(rules, '报告里没有「检查项 N 条」：\n' + out);
  assert.ok(Number(rules[1]) > 0, '这次一条检查项都没查 ⇒ 「绿」不算数');
  const fresh = out.match(/其中新增\s+(\d+)\s+条/);
  assert.ok(fresh, '报告里没有「其中新增 N 条」：\n' + out);
  assert.equal(Number(fresh[1]), 0, '有新增违反（必须修）：\n' + out);
});
