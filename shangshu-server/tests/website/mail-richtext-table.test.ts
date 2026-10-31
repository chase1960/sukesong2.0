import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 MAIL-03 富文本和表格编辑 —— 逐条钉住计划原文：
 「字体/字号/颜色/列表/链接，插表、增删行列、单元格修改、合并拆分、宽度及基础格式；
   选区/光标/中文输入正常；正文表不套用Excel的唯一表头/行ID限制」

 测试通过 = 下面全部成立：
 1. 工具栏具备：字体、字号、文字颜色、列表、链接、插入表格。
 2. 插入表格能产生表格；增/删行、增/删列可用。
 3. 单元格修改可用（改值），合并单元格、拆分单元格可用。
 4. 表格宽度可调。
 5. 正文表不套 Excel 的「唯一表头 / 行ID」限制：允许两表同结构、允许多行表头、允许空表头。
 6. 光标落点与中文输入正常（改单元格值不丢结构）。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mount(html = '') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  let changed = '';
  const mounted = w.mailEditor.mountEditor(host, {
    value: html,
    onChange: v => { changed = v; },
  });
  return {
    w, editor: mounted.editor, api: mounted, getChanged: () => changed,
    dispose: () => dom.window.close(),
  };
}

it('工具栏具备字体/字号/颜色/列表/链接/插表', async () => {
  const t = mount('<p>正文</p>');
  try {
    const toolbar = t.w.document.querySelector('[role="toolbar"], .mail-editor-toolbar');
    assert.ok(toolbar, '缺工具栏');
    assert.ok(toolbar.querySelector('[data-cmd="fontName"]'), '缺字体');
    assert.ok(toolbar.querySelector('[data-cmd="fontSize"]'), '缺字号');
    assert.ok(toolbar.querySelector('[data-editor-color]'), '缺文字颜色');
    assert.ok(toolbar.querySelector('[data-command="insertUnorderedList"]'), '缺列表');
    assert.ok(toolbar.querySelector('[data-editor-link]'), '缺链接');
    assert.ok(toolbar.querySelector('[data-editor-table]'), '缺插入表格');
  } finally { t.dispose(); }
});

it('插入表格产生表格，增删行列可用', async () => {
  const t = mount('<p>正文</p>');
  try {
    const api = t.api;
    assert.equal(typeof api.insertTable, 'function', '缺插表能力');
    assert.equal(typeof api.insertRow, 'function', '缺增行');
    assert.equal(typeof api.deleteRow, 'function', '缺删行');
    assert.equal(typeof api.insertColumn, 'function', '缺增列');
    assert.equal(typeof api.deleteColumn, 'function', '缺删列');

    api.insertTable(2, 2);
    await tick();
    const table = t.editor.querySelector('table');
    assert.ok(table, '插表后没有表格');
    assert.equal(table.querySelectorAll('tr').length, 2, '插表行数不对');
    assert.equal(table.querySelectorAll('td').length, 4, '插表单元格数不对');

    api.insertRow();
    await tick();
    assert.equal(t.editor.querySelectorAll('table tr').length, 3, '增行没生效');

    api.deleteRow();
    await tick();
    assert.equal(t.editor.querySelectorAll('table tr').length, 2, '删行没生效');

    api.insertColumn();
    await tick();
    assert.equal(t.editor.querySelector('table tr').querySelectorAll('td').length, 3, '增列没生效');

    api.deleteColumn();
    await tick();
    assert.equal(t.editor.querySelector('table tr').querySelectorAll('td').length, 2, '删列没生效');
  } finally { t.dispose(); }
});

it('单元格修改、合并拆分、宽度可调', async () => {
  const t = mount('<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>');
  try {
    const api = t.api;
    // 单元格修改
    const cells = t.editor.querySelectorAll('td');
    cells[0].textContent = '改过的甲';
    t.editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    assert.match(t.editor.textContent, /改过的甲/, '单元格修改没生效');

    // 合并：把前两个单元格合并成 colspan=2
    assert.equal(typeof api.mergeCells, 'function', '缺合并单元格');
    api.mergeCells(0, 1);
    await tick();
    assert.ok(t.editor.querySelector('td[colspan="2"]'), '合并没产生 colspan');

    // 拆分：把合并的拆回去
    assert.equal(typeof api.splitCell, 'function', '缺拆分单元格');
    const merged = t.editor.querySelector('td[colspan="2"]');
    api.splitCell(merged);
    await tick();
    assert.equal(t.editor.querySelector('td[colspan="2"]'), null, '拆分没还原 colspan');

    // 宽度
    assert.equal(typeof api.setTableWidth, 'function', '缺表格宽度');
    api.setTableWidth('60%');
    await tick();
    const table = t.editor.querySelector('table');
    assert.match(table.getAttribute('style') || '', /width\s*:\s*60%/, '宽度没生效');
  } finally { t.dispose(); }
});

it('正文表不套Excel唯一表头/行ID限制：两表同结构、多行表头、空表头都允许', async () => {
  // Excel 数据表要求唯一表头+行ID；正文邮件表不该有这个限制
  const t = mount(
    '<table><tr><td>金额</td><td>金额</td></tr><tr><td>150</td><td>220</td></tr></table>' +
    '<table><tr><td>金额</td><td>金额</td></tr><tr><td>1</td><td>2</td></tr></table>'
  );
  try {
    assert.equal(t.editor.querySelectorAll('table').length, 2, '两张同结构表不能共存（被Excel限制卡住）');
    // 重复表头文字必须能保留
    const headerTexts = [...t.editor.querySelectorAll('table:first-of-type td')]
      .slice(0, 2).map(td => td.textContent);
    assert.deepEqual(headerTexts, ['金额', '金额'], '重复表头被强制唯一了');

    // 多行表头
    const t2 = mount('<table><tr><td colspan="2">总头</td></tr><tr><td>子头A</td><td>子头B</td></tr></table>');
    try {
      assert.ok(t2.editor.querySelector('[colspan="2"]'), '多行表头的合并被剥掉');
    } finally { t2.dispose(); }
  } finally { t.dispose(); }
});

it('中文输入与光标正常，改值不丢结构', async () => {
  const t = mount('<table><tr><td colspan="2">案件汇总</td></tr><tr><td>A001</td><td>150.00</td></tr></table>');
  try {
    const cell = t.editor.querySelectorAll('td')[1];
    cell.textContent = '年费已核对';
    t.editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    assert.match(t.editor.textContent, /年费已核对/, '中文输入丢了');
    assert.ok(t.editor.querySelector('[colspan="2"]'), '改值时合并结构被破坏');
  } finally { t.dispose(); }
});

/* 用户实测反馈：点「插表」「+行」都没反应。根因是工具栏节点被搬进 wrap 后，
   事件还绑在搬空的原 div 上，16 个按钮全是死的。前面的测试走的是 api.xxx()
   返回接口，所以没抓到——必须点真实按钮才抓得住。 */
it('点工具栏按钮真的生效（不是只有API能用）', async () => {
  const t = mount('<p>正文</p>');
  try {
    const bar = t.w.document.querySelector('[role="toolbar"], .mail-editor-toolbar');
    assert.ok(bar, '缺工具栏');
    const byTitle = (title: string) => [...bar.querySelectorAll('button')].find((b: any) => b.title === title);
    const clickBtn = async (title: string) => {
      // 新工具栏按实际光标启用结构操作；像员工一样先选目标格，不靠旧版任意表兜底。
      if (title !== '插入表格') {
        const cell=t.editor.querySelector('td,th');
        assert.ok(cell,'结构操作必须有目标单元格');
        const range=t.w.document.createRange();range.selectNodeContents(cell);range.collapse(true);
        const selection=t.w.getSelection();selection.removeAllRanges();selection.addRange(range);
        t.w.document.dispatchEvent(new t.w.Event('selectionchange'));
      }
      const b = byTitle(title);
      assert.ok(b, `找不到按钮「${title}」`);
      b.click();
      await tick();
    };

    await clickBtn('插入表格');
    assert.ok(t.editor.querySelector('table'), '点「插表」按钮没生效');

    await clickBtn('在下方增行');
    assert.equal(t.editor.querySelectorAll('table tr').length, 3, '点「+行」按钮没生效');

    await clickBtn('删本行');
    assert.equal(t.editor.querySelectorAll('table tr').length, 2, '点「−行」按钮没生效');

    await clickBtn('在右侧增列');
    assert.equal(t.editor.querySelector('table tr')!.querySelectorAll('td').length, 3, '点「+列」按钮没生效');

    await clickBtn('删本列');
    assert.equal(t.editor.querySelector('table tr')!.querySelectorAll('td').length, 2, '点「−列」按钮没生效');

    await clickBtn('合并选中的两个单元格');
    assert.ok(t.editor.querySelector('td[colspan="2"]'), '点「合并」按钮没生效');

    await clickBtn('拆分单元格');
    assert.equal(t.editor.querySelector('td[colspan="2"]'), null, '点「拆分」按钮没生效');
  } finally { t.dispose(); }
});

it('工具栏按字体文字段落插入和表格分组，表格上下文未选中时不操作第一张表',()=>{
 const t=mount('<p>开头</p><table><tr><td>A</td><td>B</td></tr></table>');try{
  const bar=t.w.document.querySelector('.mail-editor-toolbar');
  for(const name of ['字体','文字样式','段落','插入','表格操作'])assert.ok(bar.querySelector(`[role="group"][aria-label="${name}"]`),'缺少'+name+'分组');
  const add=bar.querySelector('[data-editor-row-add]');assert.equal(add.disabled,true);assert.match(add.title,/光标|选择/);assert.ok(add.getAttribute('aria-label'));assert.ok(add.querySelector('svg'));
  add.click();assert.equal(t.editor.querySelectorAll('tr').length,1);
  const td=t.editor.querySelector('td');const range=t.w.document.createRange();range.selectNodeContents(td);range.collapse(false);const sel=t.w.getSelection();sel.removeAllRanges();sel.addRange(range);t.w.document.dispatchEvent(new t.w.Event('selectionchange'));
  assert.equal(add.disabled,false);add.click();assert.equal(t.editor.querySelectorAll('tr').length,2);
 }finally{t.dispose();}
});
