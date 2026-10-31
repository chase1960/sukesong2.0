// 判据：**文档里的本地链接都得点得开**。
//
// **测试通过 =** 跑 `node scripts/check-doc-links.mjs` ⇒ 退出码 0、
// 且输出里没有「文档检查失败（N 项）」（N > 0）。
//
// **为什么要有这条**（2026-10-24 · PKG-083-T01）：
// 那道闸 **不在跑批的 gates 组里**（那组跑的是 `scripts/tests/*.test.mjs` 这些判据本身）
// ⇒ **没人盯它** ⇒ 文档里的链接坏了没人知道。
// 实测当场抓到：它**红着 2 条** —— `docs/standards/unified-log-library.md` 里
// 两条指向契约与检查器的链接写成了 `../…`（从 `docs/standards/` 出发只到 `docs/`）
// ⇒ 点不开。
// ⇒ 这条判据把它**钉进跑批**：它红，跑批就红。
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('每份 Markdown 的本地链接都点得开', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/check-doc-links.mjs'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  assert.equal(code, 0, 'check-doc-links 必须退出 0（现在退出码 ' + code + '）：\n' + out);
  assert.ok(!/文档检查失败（\s*[1-9]/.test(out), '闸报出了坏链接：\n' + out);
});
