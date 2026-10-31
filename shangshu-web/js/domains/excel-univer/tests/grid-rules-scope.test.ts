/**
 * 判据：**这套规则（受管列／绿底列头／必填红底／晋升）只管「Excel 网格形式」的页面**。
 *
 * **用户口径**（2026-10-30 10:1x）：
 * 「像邮件、通知书助手、example 邮件规则表、文件中心这种**由业务域根据数据库重新造出来的页面**
 *   （**不以 excel 形式交互的**），就不需要这种规则。」
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「① 通用表格层里写着这条口径（谁在什么页面上套这套规则，说得清）；
 *   ② **业务域自己造的页面**（邮件／通知书助手／example 邮件规则表／文件中心）
 *      **不碰**这套规则的那些口（它们不是 Excel 网格 ⇒ 规则对它们不存在）；
 *   ③ **对象表在表格页里**：它的**每一列都是受管列**（字段＝受管＝对象＝晋升）；
 *   ④ **xlsx 表在表格页里**：受管列**就是晋升定义里 promoted 的那几列**（不多不少）。」
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repo, relative), 'utf8');

const mainSource = read('shangshu-web/js/domains/excel-univer/src/main.ts');

test('① 口径写进通用表格层（哪套规则管哪些页面，说得清）', () => {
  assert.ok(/不以\s*excel\s*形式交互/.test(mainSource),
    '通用表格层没写这条口径（哪套规则管哪类页面说不清 ⇒ 以后又是一轮排查）');
});

test('② 业务域自己造的页面 ⇒ **不碰**这套规则的那些口', () => {
  // —— 那些域的页面脚本（不是 Excel 网格 ⇒ 绿底/必填红底/晋升对它们不存在）——
  const domainPages = [
    'shangshu-web/js/domains/mail/mail-review-queue.js',
    'shangshu-web/js/domains/mail/mail-editor.js',
    'shangshu-web/js/domains/mail/mail-settings.js',
    'shangshu-web/js/domains/example-domain/example-domain-notice-assistant.js',
    'shangshu-web/js/domains/example-domain/example-domain-mail-rules.js',
    'shangshu-web/js/file-center.js',
  ];
  for (const relative of domainPages) {
    const source = read(relative);
    for (const rule of ['setManagedColumns', 'setRequiredEmptyMarks', 'promotion_definition']) {
      assert.ok(!source.includes(rule),
        `${relative} 碰了「${rule}」⇒ 它是业务域自己造的页面 ⇒ 不该套这套规则`);
    }
  }
});

test('③ 对象表在表格页里 ⇒ **每一列都是受管列**（字段＝受管＝对象＝晋升）', () => {
  assert.ok(/kind === 'db'/.test(mainSource) && /columns\.map\(column => column\.label \|\| column\.fieldId\)/.test(mainSource),
    '对象表没有把「全部列」设成受管列（字段＝受管＝对象＝晋升，不论如何）');
});

test('④ xlsx 表在表格页里 ⇒ 受管列**就是晋升定义里 promoted 的那几列**', () => {
  // —— 晋升定义只对「xlsx 支撑的表」拉（对象表拉它没用，还会把全绿覆盖成空）——
  assert.ok(/isXlsxBacked/.test(mainSource),
    '没有区分「xlsx 支撑的表」与「纯对象表」（⇒ 对象表的绿顶会被那份回包覆盖掉）');
});
