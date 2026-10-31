// 判据：**两个界面不许都叫「表格」** —— 侧栏那一栏叫「表格」，数据页里那个叫「数据表」。
//
// **测试通过 =**（一句话）
// 「侧栏『工作』分区里那一项**还叫『表格』**（它就是 Excel 工作面，客户最熟的词不动）；
//   **数据页里那个旧表格界面的标题叫『数据表』**（两种打开方式都一样）——
//   ⇒ **用户说『表格』时只有一个东西可指**。」
//
// **改之前**：两个界面都显示「表格」⇒ 客户说「表格」时，说的到底是侧栏那个（Excel 工作面）
//   还是数据页里那个（一行一条＋详情弹窗＋分页）？**分不清**。
// **改之后**：侧栏那栏＝「表格」；数据页里那个＝「数据表」。
// **怎么看**：浏览器打开 `http://127.0.0.1:3850/` ⇒ 左侧「工作」分区里那一项写着「表格」；
//   再从「数据」页打开一张业务表 ⇒ 那个界面的标题写着「**数据表**」（不是「表格」）。
//
// ⚠️ **为什么只改一个**：客户最熟的是「表格」（侧栏那一栏，天天用，而且是**唯一留下来**的那个）；
//   要退役的是数据页里那个 ⇒ **让它改口**，别让客户改口。
//   （2026-10-25 用户拍板：「『表格』给侧栏那栏；要退役的那套统一叫『数据表』」。）
//
// ⚠️ **判据怎么跑的**：**读源码**断**用户看得见的文案**（不是断变量名、不是断注释）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);

const sheetCenter = fs.readFileSync(new URL('shangshu-web/js/sheet-center.js', ROOT), 'utf8');
const excelLoader = fs.readFileSync(new URL('shangshu-web/js/domains/excel-univer/excel-loader.js', ROOT), 'utf8');

/** 抽出模板里那一行 `<h1>…</h1>`（本判据只断**标题**那一行）。 */
function headingLine(source) {
  const line = source.split('\n').find(item => item.includes('<h1>'));
  return line || '';
}

test('① **侧栏那一栏还叫「表格」**（Excel 工作面，客户最熟的词不动）', () => {
  assert.match(excelLoader, /name\s*:\s*'表格'/,
    '侧栏「表格」那一项的导航名被改了（客户最熟的就是这个词）');
  assert.match(excelLoader, /id\s*:\s*'excel'\s*,\s*name\s*:\s*'表格'/,
    '侧栏导航登记（id excel）那一项不叫「表格」了');
});

test('② **数据页里那个旧表格界面的标题叫「数据表」**（两种打开方式都一样）', () => {
  const line = headingLine(sheetCenter);
  assert.ok(line, 'sheet-center.js 里找不到标题那一行（<h1>）');
  assert.match(line, /<h1>\s*数据表\s*<\/h1>/,
    '那个界面的标题不是「数据表」：' + line.trim());
  assert.doesNotMatch(line, /表格/,
    '那个界面的标题里还有「表格」两个字（跟侧栏那栏撞车）：' + line.trim());
});

test('③ **两个界面的名字不撞车**（一处「表格」、一处「数据表」）', () => {
  const heading = headingLine(sheetCenter);
  assert.ok(!/表格/.test(heading), '数据页那个界面的标题里还有「表格」');
  assert.match(excelLoader, /name\s*:\s*'表格'/, '侧栏那一栏不叫「表格」了');
});
