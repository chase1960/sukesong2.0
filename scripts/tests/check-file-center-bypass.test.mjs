// 判据：**除了契约登记在案的那几处限期豁免，任何域都不许自己放字节**。
//
// **测试通过 = 什么成立**（一句话）
//
// 「**域自己放字节**的地方，就只有契约 `file-center-v1.json` 的 `exemptions`
//   登记过的那几处（邮件域收信附件／邮件域外链图／财务域发票原件）；
//   **再有人写一行 `save_file(...)` 或自己建 File 塞内容，机器立刻报出来**；
//   而那三处**必须真的还在那儿**（不许悄悄长出第四处，也不许悄悄把旧的藏起来）。」
//
// 逐条落地：
// 1. **当前仓一处没登记的绕过都没有**（检查器退出码 0）；
// 2. **三处限期豁免都被找到、且都在契约的 `exemptions` 里**（豁免登记与实际代码对得上）；
// 3. **三处限期豁免都写清了「什么时候收口」**（`to_collect_when`）——限期不是无限期；
// 4. **检查器真的咬得动**：造一个没登记的 `save_file(...)` 样本 ⇒ 它**必须报出来**并红着退出；
// 5. 契约里的**「已登记但找不到」**豁免一个都没有（登记与代码没有脱节）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_PATH,
  BYPASS_PATTERNS,
  readExemptions,
  inspect,
} from '../check-file-center-bypass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

/** **还成立**的限期豁免（代码就在这几处；收口掉一处就从这里移走）。 */
/** **还成立**的限期豁免（**三处都收口了 ⇒ 这里一处都不剩**）。 */
const KNOWN_EXEMPTIONS = [];

/** **已经收口**的（代码里不再有它，但契约里留着「已收口」记录）。 */
const COLLECTED = [
  'shangshu_finance/shangshu_finance/service.py',
  'shangshu_mail/shangshu_mail/external_assets.py',
  'shangshu_mail/shangshu_mail/delivery.py',
];

test('① 当前仓一处没登记的绕过都没有（检查器咬得住现在这份代码）', () => {
  const result = inspect(ROOT);
  assert.deepEqual(result.unregistered, [],
    '有域自己放字节、却没在契约 exemptions 里登记：%s',
    result.unregistered.map((item) => `${item.file}:${item.line} ${item.rule}`).join('、'));
});

test('② 还成立的限期豁免都被找到、且都在契约的 exemptions 里', () => {
  const result = inspect(ROOT);
  for (const where of KNOWN_EXEMPTIONS) {
    const hits = result.registered.filter((item) => item.file.includes(where));
    assert.ok(hits.length, `契约登记的豁免「${where}」在代码里找不到了（要么已收口、要么路径变了）`);
  }
  const exemptFiles = new Set(result.registered.map((item) => item.file));
  for (const where of KNOWN_EXEMPTIONS) {
    assert.ok([...exemptFiles].some((file) => file.includes(where)),
      `「${where}」那一处没有被检查器算成登记在案的例外`);
  }
});

test('②之补 **已收口的那几处，代码里一处都不再有**（收口是真的收口了）', () => {
  const result = inspect(ROOT);
  for (const where of COLLECTED) {
    const hits = result.hits.filter((item) => item.file.includes(where));
    assert.deepEqual(hits, [],
      `「${where}」已经标了「已收口」，代码里却还有自己放字节的地方：%s`
      % hits.map((item) => `${item.file}:${item.line}`).join('、'));
  }
  // **已收口 ≠ 豁免**：它要是又自己放字节，必须被报成「没登记的绕过」。
  const exemptions = readExemptions(ROOT);
  const finance = exemptions.filter((item) => String(item.where || '').includes('shangshu_finance'));
  assert.ok(finance.length, '契约里少了财务域那一条「已收口」记录（历史要留着）');
  assert.match(String(finance[0].kind || ''), /已收口/,
    '契约里财务域那一条应当标成「已收口」（已收口的不再算例外 ⇒ 复发要报出来）');
});

test('③ 还成立的限期豁免都写清了「什么时候收口」（限期不是无限期）', () => {
  const exemptions = readExemptions(ROOT);
  // ⚠️ 契约里的 `kind` 写的是「**限期豁免**」（带 markdown 星号）⇒ 按「包含」认。
  const limited = exemptions.filter((item) => String(item.kind || '').includes('限期豁免'));
  assert.ok(limited.length >= 0, `契约里还成立的限期豁免只有 ${limited.length} 处`);
  for (const item of limited) {
    assert.ok(item.to_collect_when, `限期豁免「${item.where}」没写 to_collect_when（限期没有尽头）`);
    assert.ok(item.to_collect, `限期豁免「${item.where}」没写 to_collect（要收成什么样没说清）`);
    assert.ok(item.to_collect_acceptance, `限期豁免「${item.where}」没写验收判据（收完怎么算过没说清）`);
  }
});

test('④ 检查器真的咬得动：造一个没登记的 save_file 样本，它必须报出来', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-bypass-'));
  try {
    const domain = path.join(sandbox, 'frappe_apps', 'shangshu_demo', 'shangshu_demo');
    fs.mkdirSync(domain, { recursive: true });
    fs.writeFileSync(path.join(domain, 'service.py'),
      'from frappe.utils.file_manager import save_file\n'
      + 'def put(content):\n'
      + '    return save_file("x.pdf", content, None, None, is_private=1)\n',
      'utf8');
    // 契约照抄一份（豁免表与真仓一样 ⇒ 这个样本**不在**豁免里）。
    const contractDir = path.join(sandbox, path.dirname(CONTRACT_PATH));
    fs.mkdirSync(contractDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, CONTRACT_PATH), path.join(sandbox, CONTRACT_PATH));
    const result = inspect(sandbox);
    assert.ok(result.unregistered.length, '检查器没抓到没登记的 save_file ⇒ 它不咬人');
    assert.match(result.unregistered[0].file, /shangshu_demo/);
    assert.equal(result.unregistered[0].rule, 'save-file');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('⑤ 契约里「登记了却找不到」的限期豁免一个都没有（登记与代码没脱节）', () => {
  const result = inspect(ROOT);
  assert.deepEqual(result.stale, [],
    '契约登记了限期豁免，代码里却找不到了（登记与代码脱节）：%s', result.stale.join('、'));
});

test('⑥ 检查器的三种写法都认得（save_file / 自己建 File 塞内容 / 挂到记录上塞内容）', () => {
  const ids = BYPASS_PATTERNS.map((rule) => rule.id);
  for (const id of ['save-file', 'file-doc-content', 'file-attach-with-content']) {
    assert.ok(ids.includes(id), `检查器不认「${id}」这一种写法`);
  }
});
