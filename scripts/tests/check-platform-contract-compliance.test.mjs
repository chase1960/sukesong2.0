// 判据：**仓里一处跨域私有违规都不许有**。
//
// **测试通过 =** 跑 `node scripts/check-platform-contract.mjs` ⇒ 退出码 0、
// 且输出里没有「未通过：N 项」（N > 0）。
//
// **为什么要有这条**（2026-10-24 · PKG-082-T01）：
// 那道闸 `check-platform-contract.mjs` **长期红着** —— 查实：
// `46068869b`（合 fast 那次）时 **1 项** ⇒ `adfea4a03` 之后 **5 项** ⇒ 今天仍 **5 项**；
// 而它**不在跑批的 gates 组里**（那组跑的是 `scripts/tests/*.test.mjs` 这些判据本身）⇒
// **没人盯它** ⇒ 「跨域只走公开口」这句话**没有机器在守**。
// ⇒ 这条判据把它**钉进跑批**：它红，跑批就红。
//
// **不豁免任何一类**：测试文件、生产代码，一视同仁 ——
// （真要豁免某类，那是**契约口径**，归内核拍，不在判据里偷偷放过。）
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('仓里没有跨域私有违规（PRIVATE_CORE_IMPORT／PRIVATE_CORE_DOCTYPE_ACCESS 等一律不许有）', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/check-platform-contract.mjs'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  assert.equal(code, 0, 'check-platform-contract 必须退出 0（现在退出码 ' + code + '）：\n' + out);
  assert.ok(!/未通过：\s*[1-9]/.test(out), '闸报出了未通过项：\n' + out);
});
