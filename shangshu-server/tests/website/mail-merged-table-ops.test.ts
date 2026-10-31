import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 N2-C2 复杂合并表的结构操作 —— 计划原文：
 「rowspan=3、colspan=2和组合样本，插删行列按视觉位置处理；拆分补到正确行列；
   合并按真实矩形选区，非法选区拒绝且原表不变。复用基础按钮，不把DOM第几个cells当视觉列；
   保存重开结构一致」

 反向检查表钉的那条：「简单 2×2 按钮通过，却把合并表删错格」——
  所以这里用**跨 3 行 2 列**的样本，按**视觉坐标**独立写预期，不看 DOM 下标。

 测试通过 = 下面全部成立：
 1. 删「第 2 视觉列」删掉的确实是那一列：跨列的表头只减 colspan、不整格消失，
    跨 3 行的 rowspan 格原样保留，邻格位置正确。
 2. 在视觉列后增列：新列落到视觉位置上，rowspan/colspan 都不被拉坏，表仍是矩形。
 3. 拆分 rowspan=3 的格：补出的格子落在**正确的行列**，表重新填满成矩形。
 4. 合并 2×2 矩形：变成 colspan=2 rowspan=2 一块。
    —— 用**真实拖拽**（按下 a、松开 e）触发，不是伪造一个 Range。
    DOM Range 表达不了非连续格子集合：从 a 拖到 e 会把中间的 c 一起圈进 range，
    包围盒从 2×2 变成 2×3，所以产品侧按「按下格/松开格」两角算矩形。
 5. 非法选区（非矩形）点合并 → **拒绝**，原表 innerHTML 一字不变。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mountEditor(html = '') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  const mounted = w.mailEditor.mountEditor(host, {value: html, onChange: () => {}});
  return {w, editor: mounted.editor, api: mounted, dispose: () => dom.window.close()};
}

/* 跨 3 行 2 列的组合样本：
   视觉网格 4 行 × 3 列
     行0: [表头(colspan2)] [列3]
     行1: [A001(rowspan3)] [r2c2] [r2c3]
     行2: [  A001 续    ] [r3c2] [r3c3]
     行3: [  A001 续    ] [r4c2] [r4c3] */
const COMBINED =
  '<table>' +
  '<tr><td colspan="2">表头</td><td>列3</td></tr>' +
  '<tr><td rowspan="3">A001</td><td>r2c2</td><td>r2c3</td></tr>' +
  '<tr><td>r3c2</td><td>r3c3</td></tr>' +
  '<tr><td>r4c2</td><td>r4c3</td></tr>' +
  '</table>';

/** 把表格展开成视觉网格：grid[r][c] = 起始格节点 或 'SPAN'（被某格的跨行/跨列占住）。 */
function visualGrid(table: any) {
  const grid: any[] = [];
  const rows = [...table.querySelectorAll('tr')];
  rows.forEach((tr: any, r: number) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const cell of tr.children) {
      if (!/^(TD|TH)$/.test(cell.tagName)) continue;
      while (grid[r][c] !== undefined) c++;
      const cs = Number(cell.getAttribute('colspan')) || 1;
      const rs = Number(cell.getAttribute('rowspan')) || 1;
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          const rr = r + dr;
          grid[rr] = grid[rr] || [];
          grid[rr][c + dc] = (dr === 0 && dc === 0) ? cell : 'SPAN';
        }
      }
      c += cs;
    }
  });
  return grid;
}

function place(t: any, cell: any) {
  const range = t.w.document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = t.w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

it('删「第 2 视觉列」删的确实是那一列，跨列表头只减 colspan，跨行格不动', async () => {
  const t = mountEditor(COMBINED);
  try {
    const table = t.editor.querySelector('table');
    const grid = visualGrid(table);
    assert.equal(grid.length, 4, '前置：应有 4 个视觉行');
    assert.equal(Math.max(...grid.map((r: any[]) => r.length)), 3, '前置：应有 3 个视觉列');

    // 光标放进「第 2 视觉列」的一个格子里
    const target = grid[1][1];           // r2c2
    place(t, target);
    t.api.deleteColumn();
    await tick();

    const after = t.editor.querySelector('table');
    const g2 = visualGrid(after);
    // 视觉列数：3 → 2
    const colsAfter = Math.max(...g2.map((r: any[]) => r.length));
    assert.equal(colsAfter, 2, `删第 2 视觉列后应剩 2 列，实际 ${colsAfter}`);
    // 跨 3 行的 A001 必须原样保留
    const text = after.textContent;
    assert.match(text, /A001/, '跨行格被删掉了');
    assert.equal(after.querySelectorAll('[rowspan="3"]').length, 1, 'A001 的 rowspan=3 被弄丢了');
    // 跨列表头：colspan 2 → 1
    const header = after.querySelector('td');
    assert.equal(Number(header.getAttribute('colspan') || '1'), 1,
        `跨列表头应只减 colspan 到 1，实际 ${header.getAttribute('colspan')}`);
    assert.match(header.textContent, /表头/, '表头整格被删掉了（应该只减 colspan）');
    // 第 2 视觉列的内容没了，第 3 列的还在
    assert.doesNotMatch(text, /r2c2/, '第 2 视觉列的内容没删掉');
    assert.doesNotMatch(text, /r3c2/, '第 2 视觉列的内容没删掉');
    assert.match(text, /r2c3/, '第 3 视觉列被误删了');
    assert.match(text, /列3/, '第 3 视觉列被误删了');
    // 表仍是矩形
    for (const row of g2) assert.equal(row.length, 2, `删列后表格不矩形：${JSON.stringify(row.map((c: any) => (c === 'SPAN' ? 'S' : c.textContent)))}`);
  } finally { t.dispose(); }
});

it('在视觉列后增列：新列落到视觉位置，rowspan/colspan 不被拉坏', async () => {
  const t = mountEditor(COMBINED);
  try {
    const table = t.editor.querySelector('table');
    const grid = visualGrid(table);
    place(t, grid[1][1]);        // r2c2 = 第 2 视觉列
    t.api.insertColumn();        // 在它右侧增列
    await tick();

    const after = t.editor.querySelector('table');
    const g2 = visualGrid(after);
    assert.equal(Math.max(...g2.map((r: any[]) => r.length)), 4,
        `增列后应有 4 个视觉列，实际 ${Math.max(...g2.map((r: any[]) => r.length))}`);
    assert.equal(after.querySelectorAll('[rowspan="3"]').length, 1, '增列把 rowspan=3 弄丢了');
    // 表头原本跨 2 列，插入的列落在它跨的区间外/内都行，但它必须还是完整的「表头」
    assert.match(after.textContent, /表头/, '表头被增列弄丢了');
    assert.match(after.textContent, /A001/, '跨行格被增列弄丢了');
    assert.match(after.textContent, /r2c3/, '原第 3 列被增列弄丢了');
    // 矩形：每个视觉行等宽
    for (const row of g2) assert.equal(row.length, 4, `增列后表格不矩形：${JSON.stringify(row.map((c: any) => (c === 'SPAN' ? 'S' : c.textContent)))}`);
  } finally { t.dispose(); }
});

it('拆分 rowspan=3 的格：补出的格子落在正确的行列，表重新填满', async () => {
  const t = mountEditor(COMBINED);
  try {
    const table = t.editor.querySelector('table');
    const grid = visualGrid(table);
    const big = grid[1][0];      // A001，rowspan=3
    place(t, big);
    t.api.splitCell();
    await tick();

    const after = t.editor.querySelector('table');
    assert.equal(after.querySelectorAll('[rowspan]').length, 0, '拆分后还留着 rowspan');
    const g2 = visualGrid(after);
    // 拆完必须是完整的 4×3 矩形
    assert.equal(g2.length, 4, `拆分后应 4 行，实际 ${g2.length}`);
    for (const row of g2) {
      assert.equal(row.length, 3, `拆分后表格不矩形：${JSON.stringify(row.map((c: any) => (c === 'SPAN' ? 'S' : c.textContent)))}`);
    }
    // 拆出来的格子位置要对：第 1 视觉列现在每行各有一格
    assert.equal(g2[1][0].textContent.trim(), 'A001', '原内容没留在拆出的首格');
    // 其余行第 1 列必须是新补的空格，不能跑到行尾去
    for (const r of [2, 3]) {
      const cell = g2[r][0];
      assert.notEqual(cell.textContent.trim(), `r${r + 1}c2`, `拆出的格子插错位置，第 ${r} 行第 1 列不是新格`);
    }
  } finally { t.dispose(); }
});

it('合并 2×2 矩形 → colspan=2 rowspan=2 一块', async () => {
  const t = mountEditor(
    '<table><tr><td>a</td><td>b</td><td>c</td></tr>' +
    '<tr><td>d</td><td>e</td><td>f</td></tr></table>'
  );
  try {
    const table = t.editor.querySelector('table');
    const grid = visualGrid(table);
    const a = grid[0][0], b = grid[0][1], d = grid[1][0], e = grid[1][1];

    /* 从 a 拖到 e：真实鼠标拖拽（mousedown 在 a、mouseup 在 e）。
       这正是用户「拖选四个格点合并」的动作 —— 2×2 = a,b,d,e。 */
    a.dispatchEvent(new t.w.MouseEvent('mousedown', {bubbles: true, cancelable: true}));
    e.dispatchEvent(new t.w.MouseEvent('mouseup', {bubbles: true, cancelable: true}));

    t.api.mergeCells();
    await tick();

    const after = t.editor.querySelector('table');
    const merged = after.querySelector('[colspan="2"][rowspan="2"]');
    assert.ok(merged, '合并 2×2 没变成 colspan=2 rowspan=2');
    assert.match(merged.textContent, /a/, '合并丢了内容');
    assert.match(merged.textContent, /e/, '合并丢了内容');
    const g2 = visualGrid(after);
    for (const row of g2) assert.equal(row.length, 3, '合并后表格不矩形');
  } finally { t.dispose(); }
});

it('非法选区（非矩形）点合并 → 拒绝，原表 innerHTML 一字不变', async () => {
  const t = mountEditor(
    '<table><tr><td>a</td><td>b</td><td>c</td></tr>' +
    '<tr><td>d</td><td>e</td><td>f</td></tr>' +
    '<tr><td>g</td><td>h</td><td>i</td></tr></table>'
  );
  try {
    const table = t.editor.querySelector('table');
    const grid = visualGrid(table);
    const beforeHtml = table.innerHTML;

    /* 选中 b(0,1) 和 d(1,0) 这**两格**（对角）。
       它俩的包围盒是 2×2（还要算上 a 和 e），但选中集合只有 2 格 → 不是实心矩形。
       真实 UI 里这种选区来自「按住 Ctrl 两次单点」这类非拖拽选法，产品必须拒绝。 */
    const ok = t.api.mergeCellList([grid[0][1], grid[1][0]]);
    await tick();

    assert.equal(ok, false, '非矩形选区竟然合并成功了');
    assert.match(t.editor.textContent, /a/, '拒绝合并时把内容弄丢了');
    assert.match(t.editor.textContent, /f/, '拒绝合并时把内容弄丢了');
    assert.equal(t.editor.querySelector('table').innerHTML, beforeHtml,
        '非矩形选区合并被拒后原表却变了');
  } finally { t.dispose(); }
});

it('外部格伸进包围盒 → 非法，拒绝且原表一字不变', async () => {
  /* P 的起点在第 0 行，却跨到第 1 行。若只按「包围盒里每个格子都有归属」放行，
     就会把 P 一起并进来并丢掉它的行跨度。正确判法：归属格的起点必须在包围盒内。 */
  const t = mountEditor(
    '<table><tr><td rowspan="2">P</td><td>Q</td></tr>' +
    '<tr><td>R</td></tr>' +
    '<tr><td>S</td><td>T</td></tr></table>'
  );
  try {
    const table = t.editor.querySelector('table');
    const beforeHtml = table.innerHTML;
    // 选 S(2,0) 和 Q(0,1) —— 包围盒是 3×2，但 P(起点 0,0) 跨进来占住 (1,0)
    // 用显式集合只点这两格，判为非实心
    const grid = visualGrid(table);
    const ok = t.api.mergeCellList([grid[2][0], grid[0][1]]);
    await tick();
    assert.equal(ok, false, '外部格跨进包围盒却合并成功了');
    assert.equal(t.editor.querySelector('table').innerHTML, beforeHtml, '拒绝后原表变了');
  } finally { t.dispose(); }
});

it('保存重开结构一致（合并信息写进正文，不被剥掉）', async () => {
  let savedHtml = '';
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  const mounted = w.mailEditor.mountEditor(host, {
    value: COMBINED,
    onChange: (html: string) => { savedHtml = html; },
  });
  try {
    const table = mounted.editor.querySelector('table');
    const grid = visualGrid(table);
    place({w}, grid[1][0]);
    mounted.deleteRow();               // 删掉 A001 所在的视觉行
    await tick();
    assert.match(savedHtml, /colspan="2"|colspan=2/, '保存载荷里的合并信息被剥掉了');

    // 用保存下来的 HTML 重开
    const host2 = w.document.querySelector('#host');
    const again = w.mailEditor.mountEditor(host2, {value: savedHtml, onChange: () => {}});
    const t2 = again.editor.querySelector('table');
    assert.ok(t2, '重开后表格丢了');
    assert.match(t2.innerHTML, /colspan="2"|colspan=2/, '重开后横向合并丢了');
    const g3 = visualGrid(t2);
    assert.equal(g3.length, 3, `重开后行数不对：${g3.length}`);
  } finally { dom.window.close(); }
});
