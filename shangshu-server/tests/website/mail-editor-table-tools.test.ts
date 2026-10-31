import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 FIX-23 正文工具条里的「表格操作」一整行 —— 2026-10-20 @browser-use 走查发现：

  写信窗正文上方那排按钮，实际占着**两行**（活站量：工具条总高 94px，
  其中「表格操作」那行 41px = **44%**）。那行里 7 个控件（增行/删行/增列/删列/
  合并/拆分 + 表格宽度下拉）在**正文里根本没有表格**时**全是禁用**的，
  外加一句「先将光标放入表格」—— 也就是说，用户看到的是一整行灰的、点不动的东西。

  根因：`.mail-editor-table-tools{flex-basis:100%}` 把它**强制换行独占一行**，
  无论此刻有没有表格。表格式编辑器（Word / Google Docs / Notion）的通行做法是
  **按需出现**：光标不在表格里就不占那一行。

  测试通过 = 下面全部成立：
  1. 正文里**没有表格**时，工具条里**不出现**「表格操作」那一组
     （不是「出现但禁用」，是**不占位**）—— 工具条不该被一行点不动的东西顶掉 41px。
  2. 正文里**有表格**、光标在表格里时，那一组**照旧出现**且按钮**可用**。
  3. 正文里**有表格**、但光标**不在**表格里时，那一组仍然出现（用户得看得见
     「表格操作」这个存在，才能把光标放进去）—— 只是按钮禁用。
  4. 「插入」组里的「表格」按钮**永远在**（插入表格这个能力不能被藏掉）。
  5. 上一条判据钉住的行为不许变：光标不在表格里时，增行按钮**禁用**、
     且 title 里说得清要先放光标。

  措辞不钉死 —— 钉的是「无表格时不占位 / 有表格时照旧」。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mount(html = '') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  const mounted = w.mailEditor.mountEditor(host, {value: html, onChange: () => {}});
  return {w, editor: mounted.editor, api: mounted, dispose: () => dom.window.close()};
}

/* 工具条里「表格操作」那一组。 */
function tableTools(t: ReturnType<typeof mount>): any {
  return t.w.document.querySelector('.mail-editor-table-tools');
}

/* 这一组**占不占位**（不是「在不在 DOM 里」）。
   真浏览器上它靠 display / hidden 决定要不要那一行；判据认这两种做法。 */
function takesSpace(group: any): boolean {
  if (!group) return false;
  if (group.hasAttribute('hidden')) return false;
  const style = group.ownerDocument.defaultView?.getComputedStyle?.(group);
  if (style && style.display === 'none') return false;
  return true;
}

/* 把光标放进某个单元格里。 */
function placeInCell(t: ReturnType<typeof mount>, cell: any) {
  const range = t.w.document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = t.w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  t.w.document.dispatchEvent(new t.w.Event('selectionchange'));
}

it('正文里没有表格时，工具条不出现「表格操作」那一组（不占位）', async () => {
  const t = mount('<p>正文</p>');
  try {
    const group = tableTools(t);
    assert.ok(group, '前置：工具条里该有「表格操作」这一组（隐藏，不是删掉）');
    assert.equal(takesSpace(group), false,
      '正文里根本没有表格，「表格操作」那 7 个控件却仍占着整整一行（活站量：41px，'
      + '占工具条 94px 的 44%）—— 全是点不动的灰按钮，白占地方');
  } finally { t.dispose(); }
});

it('正文里有表格、光标在表格里时，「表格操作」照旧出现且按钮可用', async () => {
  const t = mount('<p>正文</p><table><tr><td>A</td><td>B</td></tr></table>');
  try {
    const cell = t.editor.querySelector('td');
    placeInCell(t, cell);
    await tick();
    const group = tableTools(t);
    assert.ok(takesSpace(group), '光标已经在表格里，「表格操作」那组却没出现 —— 表格里的增删行列没法用');
    const add = group.querySelector('[data-editor-row-add]');
    assert.equal(add.disabled, false, '光标在表格里，增行按钮还是禁用的');
  } finally { t.dispose(); }
});

it('正文里有表格、光标不在表格里时，那一组仍然出现（用户要看得见它存在）', async () => {
  const t = mount('<p>正文</p><table><tr><td>A</td><td>B</td></tr></table>');
  try {
    const group = tableTools(t);
    assert.ok(takesSpace(group),
      '正文里有表格，「表格操作」那组却不见了 —— 用户看不到这个功能存在，'
      + '也不知道该把光标放进表格');
    const add = group.querySelector('[data-editor-row-add]');
    assert.equal(add.disabled, true, '光标不在表格里，增行按钮不该是可点的');
    assert.match(add.title || '', /光标|选择/,
      '按钮该说清要先做什么（把光标放进表格），而不是光秃秃一个禁用按钮');
  } finally { t.dispose(); }
});

it('「插入」组里的「表格」按钮永远在（插入表格这个能力不能被藏掉）', async () => {
  const t = mount('<p>正文</p>');
  try {
    const bar = t.w.document.querySelector('.mail-editor-toolbar');
    const tableBtn = bar.querySelector('[data-editor-table]');
    assert.ok(tableBtn, '「插入表格」按钮不见了 —— 没有表格就插不了表格');
    assert.equal(tableBtn.disabled, false, '「插入表格」按钮被禁用了');
  } finally { t.dispose(); }
});

it('插进一张表后，「表格操作」那组自己冒出来（不用关掉重开）', async () => {
  const t = mount('<p>正文</p>');
  try {
    const group = tableTools(t);
    assert.equal(takesSpace(group), false, '前置：还没有表格，那组该不占位');
    (t.w.document.querySelector('[data-editor-table]') as any).click();
    await tick();
    assert.ok(t.editor.querySelector('table'), '前置：「插入表格」按钮没插出表');
    assert.equal(takesSpace(group), true,
      '表已经插进正文了，「表格操作」那组却仍不占位 —— 用户没法增删行列');
  } finally { t.dispose(); }
});

it('上一条判据钉住的行为不许变：光标不在表格里时，增行按钮禁用且说清先放光标', async () => {
  const t = mount('<p>正文</p><table><tr><td>A</td><td>B</td></tr></table>');
  try {
    const bar = t.w.document.querySelector('.mail-editor-toolbar');
    const add = bar.querySelector('[data-editor-row-add]');
    assert.equal(add.disabled, true, '光标不在表格里，增行按钮不该可点');
    assert.match(add.title || '', /光标|选择/, '按钮 title 该说清要先做什么');
    assert.ok(add.getAttribute('aria-label'), '按钮该有 aria-label');
  } finally { t.dispose(); }
});
