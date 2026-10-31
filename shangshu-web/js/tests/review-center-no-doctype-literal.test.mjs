// 判据：公共审核中心壳**不许硬写别的域的 DocType 名**。
//
// **测试通过 =**（一句话）
// 「公共壳（`js/review-center.js`）里**没有出现任何别的域的 DocType 名**
//   （如 'Shangshu File Center File'）—— 原件地址一律用
//   **声明给的**或**文件中心读口回的**受管引用三元组（ref_doctype / ref_name / file），
//   壳**自己不猜是哪张表**。」
//
// ⚠️ **为什么要有这条**（2026-10-23 实踩）：
//   壳里原来写着 `const FILE_CENTER_DOCTYPE = 'Shangshu File Center File';`
//   当「声明只给了一个文件编号、读口又没回三元组」时的**兜底** ——
//   那是**公共壳去猜某个域的内部表名**（跨域耦合）。
//   域边界那道闸（`scripts/check-domain-boundary.mjs` ＋ `scripts/domain-policies/example-domain.json`
//   的内容规则「example 域不得直接读写其他业务域 DocType」）会因此报红 ——
//   而且报得对：这句话让公共壳跟一个域的表名绑死了。
//   ⇒ 现在壳里**一个域的表名都不写**：三元组要么声明给，要么读口给；
//     两者都没有 ⇒ 这一件**读不出来**（`failed`）⇒ 那一组不许确认
//     （「没有地址」≠「打不开」：前者只说明，后者必须拦住那一组）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/* 别的域的 DocType 名 —— 与域边界那道闸用的同一张单子（`Shangshu <X>` 那一族）。 */
const OTHER_DOMAIN_DOCTYPES = [
  'Finance', 'Expense', 'Invoice', 'Payable', 'Ledger', 'Cash', 'Posting',
  'Funding', 'Document Extraction', 'File', 'Mail', 'Order', 'Stock',
];

const shell = fs.readFileSync(new URL('../review-center.js', import.meta.url), 'utf8');

test('① 公共壳里**没有别的域的 DocType 名**（壳不猜是哪张表）', () => {
  const hits = [];
  for (const name of OTHER_DOMAIN_DOCTYPES) {
    const pattern = new RegExp('[\'"]Shangshu ' + name + '[^\'"]*[\'"]', 'g');
    for (const match of shell.matchAll(pattern)) hits.push(match[0]);
  }
  assert.deepEqual(hits, [],
    '公共壳里写死了别的域的 DocType 名：' + hits.join('、')
    + ' ⇒ 公共壳跟某个域的表名绑死了（域边界那道闸会报红，而且报得对）'
    + ' ⇒ 原件地址只用**声明给的**或**文件中心读口回的**三元组。');
});

test('② 拼原件地址时用的是**三元组里的 ref_doctype**（读口回什么就用什么）', () => {
  /* 壳拼地址的地方只有一处 —— `fileContentUrl`。它必须取 `reference.ref_doctype`。 */
  const fn = shell.match(/function fileContentUrl\([\s\S]*?\n {2}\}/);
  assert.ok(fn, '壳里找不到 `fileContentUrl` 这个拼地址的函数');
  assert.match(fn[0], /reference\.ref_doctype/,
    '`fileContentUrl` 没有用 `reference.ref_doctype` ⇒ 没有三元组也照样去读');
  assert.ok(!/Shangshu\s+[A-Z]/.test(fn[0]),
    '`fileContentUrl` 里又写死了表名');
});
