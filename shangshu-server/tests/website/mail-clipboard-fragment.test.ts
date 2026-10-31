import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 FIX-08（A20）：把尚书 Excel 的表格区域复制进邮件正文，不能被剪贴板片段标记污染。

 用户原话：「会出现：StartFragment和end」——正文里冒出这两串字。

 根因（读代码定位，不是猜）：
   Excel/Word/浏览器原生复制把整张表放进 text/html，用 HTML 注释
   <!--StartFragment--> / <!--EndFragment--> 标出「真正被复制的那一段」。
   邮件编辑器的净化门 safeFragment 在序列化那一步写的是
   `node.outerHTML || node.textContent` —— 注释节点没有 outerHTML，
   按 DOM 规范 textContent 返回注释数据，于是 "StartFragment"/"EndFragment"
   被当成**普通文字**写进正文。服务端 sanitize_html 走 HTMLParser，
   注释本来就被丢掉；污染是在浏览器里就已经变成文字并被存库的。

 测试通过 = 下面全部成立：
 1. 片段标记不泄进正文：粘贴后编辑区里既没有 "StartFragment" 也没有 "EndFragment"。
 2. 片段边界被解析：只有标记之间那段（真正被复制的部分）进正文，标记外的前后文不进。
 3. 正常文本不被误删：正文里字面写着 "StartFragment" 这几个字的段落照旧保留
    （不许用全局字符串替换去处理）。
 4. 表格内容与基本样式保留：3×4 的文字/数字/空格/中文都在，框线还在。
 5. 一次粘贴算一步撤销。
 6. 恶意 HTML 仍过滤：script/事件属性/外链图片照旧不进正文。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mountEditor(html = '') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  let changed = '';
  const mounted = w.mailEditor.mountEditor(host, {value: html, onChange: v => { changed = v; }});
  return {w, editor: mounted.editor, getChanged: () => changed, dispose: () => dom.window.close()};
}

function paste(w: any, editor: any, html: string, plain = '') {
  const store: Record<string, string> = {};
  if (html) store['text/html'] = html;
  if (plain) store['text/plain'] = plain;
  const dt = {types: Object.keys(store), getData: (type: string) => store[type] ?? ''};
  const ev = new w.Event('paste', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'clipboardData', {value: dt});
  editor.dispatchEvent(ev);
  return ev;
}

/* 一份典型的 Excel 原生复制载荷：整张表 + 片段边界标记。 */
const excelClipboard = [
  '<html><head><meta charset="utf-8"></head><body>',
  '<p>标记外的前言，不该进正文</p>',
  '<!--StartFragment-->',
  '<table border="1" style="border-collapse:collapse">',
  '<tr><td style="border:1px solid #ccc;padding:4px 8px">姓名</td><td style="border:1px solid #ccc;padding:4px 8px">金额</td><td style="border:1px solid #ccc;padding:4px 8px">日期</td><td style="border:1px solid #ccc;padding:4px 8px">备注</td></tr>',
  '<tr><td style="border:1px solid #ccc;padding:4px 8px">张三</td><td style="border:1px solid #ccc;padding:4px 8px">1234.56</td><td style="border:1px solid #ccc;padding:4px 8px">2026-10-19</td><td style="border:1px solid #ccc;padding:4px 8px">含 空格</td></tr>',
  '<tr><td style="border:1px solid #ccc;padding:4px 8px">李四</td><td style="border:1px solid #ccc;padding:4px 8px">7.77</td><td style="border:1px solid #ccc;padding:4px 8px">2026-10-20</td><td style="border:1px solid #ccc;padding:4px 8px">中文备注</td></tr>',
  '</table>',
  '<!--EndFragment-->',
  '<p>标记外的后记，也不该进正文</p>',
  '</body></html>',
].join('');

// —— FIX-08 判据 1 + 2：片段标记不泄进正文，且只取边界之间那段 ——
it('FIX-08 片段标记不泄进正文：测试通过 = 正文没有 StartFragment/EndFragment，且只保留边界内内容', async () => {
  const t = mountEditor('<p>粘贴测试：</p>');
  try {
    const ev = paste(t.w, t.editor, excelClipboard);
    await tick();
    assert.equal(ev.defaultPrevented, true, '必须接管粘贴');
    const text = t.editor.textContent || '';
    assert.doesNotMatch(text, /StartFragment/, 'StartFragment 泄进正文了');
    assert.doesNotMatch(text, /EndFragment/, 'EndFragment 泄进正文了');
    assert.doesNotMatch(text, /标记外的前言/, '片段边界之外的内容不该进正文');
    assert.doesNotMatch(text, /标记外的后记/, '片段边界之外的内容不该进正文');
    assert.ok(t.editor.querySelector('table'), '表格没进编辑区');
  } finally { t.dispose(); }
});

// —— FIX-08 判据 4：表格内容与基本样式保留 ——
// 测试通过 = 3×4 的文字/数字/空格/中文都在，框线还在，内容可继续编辑。
it('FIX-08 表格内容与基本样式保留：测试通过 = 行列文字空格中文与框线都在', async () => {
  const t = mountEditor('<p>粘贴测试：</p>');
  try {
    paste(t.w, t.editor, excelClipboard);
    await tick();
    const table = t.editor.querySelector('table');
    assert.ok(table, '表格没进编辑区');
    assert.equal(table.querySelectorAll('tr').length, 3, '行数不对（表头 + 2 行数据）');
    assert.equal(table.querySelectorAll('tr')[0].querySelectorAll('td').length, 4, '列数不对');
    const text = t.editor.textContent || '';
    for (const cell of ['姓名', '金额', '日期', '备注', '张三', '1234.56', '2026-10-19', '含 空格', '李四', '7.77', '中文备注']) {
      assert.ok(text.includes(cell), `内容丢了：${cell}`);
    }
    const cellStyle = table.querySelector('td')?.getAttribute('style') || '';
    assert.match(cellStyle, /border/, '框线被剥掉了');
  } finally { t.dispose(); }
});

// —— FIX-08 判据 3：正常文本不被误删 ——
// 测试通过 = 正文里字面写着「StartFragment」的段落照旧保留（不许全局字符串替换）。
it('FIX-08 正文里字面写着 StartFragment 的正常文本不被误删', async () => {
  const t = mountEditor('<p>粘贴测试：</p>');
  try {
    paste(t.w, t.editor, '<p>我们讨论的是 StartFragment 这个词，别把它删了</p>');
    await tick();
    assert.match(t.editor.textContent || '', /StartFragment/, '正常正文里的同名字样被误删了');
  } finally { t.dispose(); }
});

// —— FIX-08 判据 5：一次粘贴算一步撤销 ——
it('FIX-08 一次粘贴算一步撤销：测试通过 = 撤一次就回到粘贴前', async () => {
  const t = mountEditor('<p>粘贴前</p>');
  try {
    paste(t.w, t.editor, excelClipboard);
    await tick();
    assert.match(t.editor.textContent || '', /姓名/, '没粘进去');
    t.editor.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true, cancelable: true}));
    await tick();
    const after = t.editor.textContent || '';
    assert.doesNotMatch(after, /姓名/, '撤一次之后粘贴的表格还在');
    assert.match(after, /粘贴前/, '撤一次之后连原来的内容也没了');
  } finally { t.dispose(); }
});

// —— FIX-08 判据 6：恶意 HTML 仍过滤 ——
// 测试通过 = script 节点不在、事件属性被剥掉、外链图片的 src 被摘掉，正文文字照旧保留
// （这次修复只动片段标记与注释节点，不能把净化门放松）。
it('FIX-08 恶意 HTML 仍过滤：测试通过 = script/事件属性/外链图片都不进正文', async () => {
  const t = mountEditor('<p>粘贴测试：</p>');
  try {
    paste(t.w, t.editor,
      '<!--StartFragment--><script>window.__pwned=1</script>' +
      '<p onclick="window.__clicked=1">带事件的段落</p>' +
      '<img src="https://evil.example/x.png">' +
      '<table><tr><td>正常格</td></tr></table><!--EndFragment-->');
    await tick();
    assert.equal(t.editor.querySelector('script'), null, 'script 没被剥掉');
    assert.equal(t.editor.querySelector('[onclick]'), null, '事件属性没被剥掉');
    assert.equal(t.editor.querySelector('img[src^="http"]'), null, '外链图片没被剥掉');
    assert.match(t.editor.textContent || '', /带事件的段落/, '正文文字不该被误删（要删的是事件属性不是文字）');
    assert.match(t.editor.textContent || '', /正常格/, '正常内容被误伤了');
  } finally { t.dispose(); }
});
