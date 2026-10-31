import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 MAIL-02 正文和表格阅读 —— 逐条钉住计划原文：
 「边框、列宽、行高、合并格、对齐、长文本、中文、金额日期、受管图片及引用表格可读；
   超宽能完整查看，安全隔离不破坏支持内容」
 冻结样本清单另列「表头色」。

 测试通过 = 下面全部成立：
 1. 边框、列宽、行高、对齐进得了阅读视图（不被净化剥掉）。
 2. 合并格（colspan/rowspan）可读、结构完整。
 3. 长文本、中文、金额日期可读不丢字。
 4. 受管内联图（cid:）与引用表格可读。
 5. 超宽表格能完整查看（横向可滚，不被裁掉半截）。
 6. 安全隔离不破坏支持内容：净化掉脚本/外链，但排版与表格照常。
 7. 表头色可读——含 Excel 写法（<style> 里定义 class 再引用）。
*/

const CID = 'logo-sample@shangshu.local';

function render(value: string, previewMap: Record<string, string> = {}) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const srcdoc = w.mailEditor.previewSrcdoc(w.mailEditor.safeFragment(value), previewMap);
  return {w, srcdoc, dispose: () => dom.window.close()};
}

it('边框/列宽/行高/对齐可读，不被净化剥掉', async () => {
  const t = render(
    '<table style="width:80%;border-collapse:collapse" border="1">' +
    '<tr>' +
    '<td style="width:200px;height:48px;border:1px solid #333;text-align:right;vertical-align:bottom">金额</td>' +
    '<td style="width:120px;height:48px;border:1px solid #333;text-align:center">日期</td>' +
    '</tr></table>');
  try {
    const s = t.srcdoc;
    assert.match(s, /width\s*:\s*200px/i, '列宽被剥掉');
    assert.match(s, /height\s*:\s*48px/i, '行高被剥掉');
    assert.match(s, /text-align\s*:\s*right/i, '水平对齐被剥掉');
    assert.match(s, /vertical-align\s*:\s*bottom/i, '垂直对齐被剥掉');
    assert.match(s, /border/i, '边框被剥掉');
  } finally { t.dispose(); }
});

it('合并格可读，colspan/rowspan 结构完整', async () => {
  const t = render(
    '<table border="1"><tr><td colspan="2">案件汇总</td><th>金额</th></tr>' +
    '<tr><td rowspan="2">A001</td><td>年费</td><td>150.00</td></tr>' +
    '<tr><td>滞纳金</td><td>0.00</td></tr></table>');
  try {
    assert.match(t.srcdoc, /colspan="2"/, '横向合并丢失');
    assert.match(t.srcdoc, /rowspan="2"/, '纵向合并丢失');
    assert.match(t.srcdoc, /案件汇总/);
    assert.match(t.srcdoc, /A001/);
  } finally { t.dispose(); }
});

it('长文本/中文/金额日期可读不丢字', async () => {
  const long = '这是一段很长的中文正文用来验证长文本不会被截断。'.repeat(20);
  const t = render(
    `<p>${long}</p><table><tr><td>收款金额</td><td>¥1,234,567.89</td></tr>` +
    '<tr><td>到期日</td><td>2026-10-24</td></tr></table>');
  try {
    assert.match(t.srcdoc, /收款金额/);
    assert.match(t.srcdoc, /1,234,567\.89/, '金额格式丢失');
    assert.match(t.srcdoc, /2026-10-24/, '日期丢失');
    assert.ok(t.srcdoc.includes('用来验证长文本不会被截断'), '长文本被截断');
  } finally { t.dispose(); }
});

it('受管内联图与引用表格可读', async () => {
  const previewMap = {[CID]: 'data:image/png;base64,AAAA'};
  const t = render(
    `<p>详见附图 <img src="cid:${CID}" alt="样例图"></p>` +
    '<table><tr><td>引用编号</td><td>202630123456.7</td></tr></table>', previewMap);
  try {
    assert.match(t.srcdoc, /data:image\/png/, '受管内联图没解析成可读预览');
    assert.match(t.srcdoc, /202630123456\.7/, '引用表格内容丢失');
  } finally { t.dispose(); }
});

it('超宽表格能完整查看，不被裁掉半截', async () => {
  const cols = Array.from({length: 30}, (_, i) => `<td style="width:120px">第${i + 1}列</td>`).join('');
  const t = render(`<table style="width:3600px;border-collapse:collapse"><tr>${cols}</tr></table>`);
  try {
    // 完整查看 = 内容全在 + 允许横向滚动，而不是 overflow:hidden 裁掉
    assert.match(t.srcdoc, /第1列/, '最左列被裁');
    assert.match(t.srcdoc, /第30列/, '最右列被裁');
    assert.doesNotMatch(t.srcdoc, /overflow\s*:\s*hidden/i, '超宽被裁切，不能完整查看');
  } finally { t.dispose(); }
});

it('安全隔离不破坏支持内容：脚本外链去掉，排版表格照常', async () => {
  const t = render(
    '<p onclick="steal()">正文段落</p>' +
    '<table style="width:100%;border-collapse:collapse"><tr><td colspan="2" style="background:#002060;color:#fff">表头</td></tr></table>' +
    '<script>steal()</script><img src="https://tracker.invalid/pixel">');
  try {
    const s = t.srcdoc;
    assert.doesNotMatch(s, /<script/i, '脚本没被去掉');
    assert.doesNotMatch(s, /onclick/i, '事件属性没被去掉');
    assert.doesNotMatch(s, /tracker\.invalid/, '外链图没被去掉');
    // 但支持的内容不能被误伤
    assert.match(s, /正文段落/);
    assert.match(s, /<table/, '表格被误伤');
    assert.match(s, /colspan="2"/, '合并格被误伤');
    assert.match(s, /background/i, '表头色被误伤');
  } finally { t.dispose(); }
});

it('表头色可读——含Excel写法（<style>定义class再引用）', async () => {
  // Excel/WPS 复制出来的表头色不在单元格上，而是 <style> 里定义 class，表格靠 class 引用
  const excelStyle =
    '<style>.xl65{background:#002060;color:#ffffff}</style>' +
    '<table><tr><td class="xl65">案件</td><td class="xl65">金额</td></tr>' +
    '<tr><td>A001</td><td>150.00</td></tr></table>';
  const t = render(excelStyle);
  try {
    // 颜色必须落到单元格上（内联），因为 <style> 不进沙箱预览
    assert.match(t.srcdoc, /background\s*:\s*#002060/i, 'Excel 表头色（class+style 写法）没保留');
  } finally { t.dispose(); }
});
