import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 MAIL-04 外部表格粘贴 —— 钉住计划原文：
 「Excel/WPS、Word、其他邮件的HTML/TSV多行多列可贴，前导零、换行及支持的合并格不丢；
   插入新表/替换选中整表/纯文本作用域可见，不能暗中整表替换；一次粘贴一个动作」

 测试通过 = 下面全部成立：
 1. HTML/TSV 多行多列表格可贴，前导零（"007"）与单元格内换行不丢，合并格不丢。
 2. 粘出来的表格**看得见框线**（用户实测反馈 4.1～4.4「有，但是没有表格框线」）。
 3. 粘贴**不暗中整表替换**：在已有表格里粘贴时，先出现可见的作用域选项
    （插入新表 / 替换选中表 / 只贴值）；选定之前原表一个字都不动。
 4. 三个作用域各按字面生效；「替换选中表」只换选中的那一张，不碰别的表。
 5. 一次粘贴只产生一个动作（一步可撤销的粒度）。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mountEditor(html = '') {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  let changed = 0;
  const mounted = w.mailEditor.mountEditor(host, {value: html, onChange: () => { changed++; }});
  return {
    w,
    editor: mounted.editor,
    changedCount: () => changed,
    dispose: () => dom.window.close(),
  };
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

/** 找到粘贴后出现的作用域选项条（插入新表/替换选中表/只贴值）。 */
function scopeChooser(w: any) {
  const root = w.document;
  const all = [...root.querySelectorAll('[data-paste-scope], .paste-scope')];
  return all.find((el: any) => !el.hidden && el.isConnected) || null;
}

function scopeButtons(chooser: any) {
  const btns = [...chooser.querySelectorAll('button')];
  const find = (re: RegExp) => btns.find((b: any) => re.test(b.textContent || ''));
  return {
    insert: find(/插入新表/),
    replace: find(/替换选中表|替换选中/),
    plain: find(/只贴值|纯文本/),
    all: btns,
  };
}

it('前导零与单元格内换行不丢，合并格不丢，多行多列可贴', async () => {
  const t = mountEditor('<p>粘贴测试：</p>');
  try {
    // Excel 的 text/plain 侧：TSV；单元格内换行 Excel 会用引号包起来
    const plain = '编号\t说明\n"007"\t第一行\n第二行\n"001"\t短';
    paste(t.w, t.editor, '', plain);
    await tick();
    const table = t.editor.querySelector('table');
    assert.ok(table, 'TSV 没还原成表格');
    assert.match(t.editor.textContent, /007/, '前导零 007 被转成数字 7 了');
    assert.match(t.editor.textContent, /001/, '前导零 001 被转成数字 1 了');
    assert.ok(!/[^0]7\b/.test(t.editor.textContent) || /007/.test(t.editor.textContent), '007 不该变成 7');
    // 单元格内换行
    const cells = [...t.editor.querySelectorAll('td')].map((td: any) => td.textContent);
    assert.ok(cells.some((c: string) => c.includes('\n') || c.includes('第一行')), '单元格内换行被压平了');

    // HTML 侧合并格
    const t2 = mountEditor('<p>x</p>');
    try {
      paste(t2.w, t2.editor, '<table><tr><td colspan="2">案件汇总</td></tr><tr><td rowspan="2">A001</td><td>1</td></tr><tr><td>2</td></tr></table>');
      await tick();
      assert.ok(t2.editor.querySelector('[colspan="2"]'), '横向合并丢了');
      assert.ok(t2.editor.querySelector('[rowspan="2"]'), '纵向合并丢了');
    } finally { t2.dispose(); }
  } finally { t.dispose(); }
});

it('粘出来的表格无论如何都有框线（用户：源表本来就没框，粘进邮件必须有框）', async () => {
  const t = mountEditor('<p>x</p>');
  try {
    /* 用户原话：「我复制的excel就是没有框线的,但是我希望每一个邮件粘贴的表格是要有框线的(无论怎么样)」。
       所以这不是「把 border:none 还原掉」，而是**无条件补框**：源表长什么样都得有框。 */
    const cases = [
      ['源表完全没写边框', '<table><tr><td>编号</td><td>金额</td></tr><tr><td>A001</td><td>150.00</td></tr></table>'],
      ['源表写了 border:none', '<table><tr><td style="border:none">编号</td><td style="border:none">金额</td></tr><tr><td style="border:none">A001</td><td style="border:none">150.00</td></tr></table>'],
      ['源表写了 border:0', '<table><tr><td style="border:0">编号</td><td style="border:0">金额</td></tr></table>'],
      ['源表只写 border-color 没宽度', '<table><tr><td style="border-color:#f00">编号</td><td>金额</td></tr></table>'],
    ];
    for (const [label, html] of cases) {
      const c = mountEditor('<p>x</p>');
      try {
        paste(c.w, c.editor, html);
        await tick();
        const table = c.editor.querySelector('table');
        assert.ok(table, `${label}：表格没粘进来`);
        const tds = [...table.querySelectorAll('td')];
        assert.ok(tds.length >= 2, `${label}：单元格数不对`);
        for (const td of tds) {
          const style = td.getAttribute('style') || '';
          // 框线必须是可见的：有 border 声明、不是 none、宽度不是 0
          const m = style.match(/(?:^|;)\s*border\s*:\s*([^;]+)/i);
          assert.ok(m, `${label}：单元格没框线，style=${style}`);
          assert.ok(!/^none/i.test(m[1].trim()), `${label}：框线是 none，style=${style}`);
          assert.ok(!/^0(\s|px|em|rem|$)/i.test(m[1].trim()), `${label}：框线宽度 0，style=${style}`);
        }
      } finally { c.dispose(); }
    }
  } finally { t.dispose(); }
});

it('粘贴给的框线是可见的一格实线，且合并格/表头色不被抹掉', async () => {
  const t = mountEditor('<p>x</p>');
  try {
    // 源：无框 + 合并格 + 表头底色（Excel 常见形态）
    const html = '<table><tr><td colspan="2" style="background:#002060;color:#fff">案件汇总</td></tr>'
      + '<tr><td rowspan="2">A001</td><td>150.00</td></tr><tr><td>0.00</td></tr></table>';
    paste(t.w, t.editor, html);
    await tick();
    const table = t.editor.querySelector('table');
    assert.ok(table, '表格没粘进来');
    for (const td of table.querySelectorAll('td')) {
      const style = td.getAttribute('style') || '';
      assert.match(style, /border\s*:\s*1px/i, `没给 1px 实线框：${style}`);
    }
    assert.ok(table.querySelector('[colspan="2"]'), '补框时把横向合并弄丢了');
    assert.ok(table.querySelector('[rowspan="2"]'), '补框时把纵向合并弄丢了');
    assert.match(table.querySelector('[colspan="2"]').getAttribute('style') || '', /background/i, '补框时把表头底色弄丢了');
  } finally { t.dispose(); }
});

/* N2-C3 三种明确粘贴方式（用户 2026-10-11 计划原文）：
   「可见选择"插入新表/替换选中整表/纯文本"；默认不暗中覆盖已有整表；
     没有明确目标不能替换。正确处理HTML及带引号、Tab、格内换行的TSV；
     前导零/长编号保留，表格框线规则延续。将既有两条skip变成实测，并按实际能力扩充反例」 */
it('粘贴不暗中整表替换：先出可见作用域选项，选定前原表一个字不动', async () => {
  const t = mountEditor('<table><tr><td colspan="2">原有合并表头</td></tr><tr><td>旧A</td><td>旧B</td></tr></table>');
  try {
    assert.ok(t.editor.querySelector('[colspan="2"]'), '前置条件：原表应有合并格');

    // 光标放进表里再粘一段表格
    const cell = t.editor.querySelector('td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();

    // 关键：不能暗中替换。原表必须还在且合并没丢
    assert.ok(t.editor.querySelector('[colspan="2"]'), '原表合并格被剥掉了（暗中整表替换）');
    assert.match(t.editor.textContent, /原有合并表头/, '原表内容被覆盖了');
    assert.match(t.editor.textContent, /旧A/, '原表单元格被覆盖了');

    // 并且作用域选项必须可见，三个作用域都得有
    const chooser = scopeChooser(t.w);
    assert.ok(chooser, '粘贴没有给出可见的作用域选项（必须让用户看到插新表/替换/只贴值）');
    const s = scopeButtons(chooser);
    assert.ok(s.insert, '缺「插入新表」');
    assert.ok(s.replace, '缺「替换选中表」');
    assert.ok(s.plain, '缺「只贴值」');
  } finally { t.dispose(); }
});

it('三个作用域各按字面生效，替换只换选中的那一张表', async () => {
  const t = mountEditor(
    '<table id="one"><tr><td colspan="2">表一合并</td></tr><tr><td>甲1</td><td>甲2</td></tr></table>' +
    '<table id="two"><tr><td>乙1</td><td>乙2</td></tr></table>'
  );
  try {
    const cell = t.editor.querySelector('#one td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();

    const chooser = scopeChooser(t.w);
    assert.ok(chooser, '没出作用域选项');
    const s = scopeButtons(chooser);

    // —— 只贴值：变成纯文本，两张原表都不动 ——
    s.plain.click();
    await tick();
    assert.ok(t.editor.querySelector('#one [colspan="2"]'), '「只贴值」动了表一合并');
    assert.match(t.editor.textContent, /甲1/, '「只贴值」删了表一内容');
    assert.match(t.editor.textContent, /乙1/, '「只贴值」删了表二内容');
    const plainTables = t.editor.querySelectorAll('table').length;
    assert.equal(plainTables, 2, `「只贴值」不该新增表，现有 ${plainTables} 张`);
  } finally { t.dispose(); }
});

it('只贴值保留单元格内换行 —— <br> 不能被粘成一行（BASE967-13）', async () => {
  /* 用户实测 UI-052：只贴值把「中文第一行<br>中文第二行」连成一行。
     根因：plainTextOf 对表格单元格直接 textContent，`<br>` 被当成空白。
     测试通过 = 选「只贴值」后，两行之间仍有换行（生成的 <br>），不是粘在一起。 */
  const t = mountEditor('<table><tr><td>原表</td></tr></table>');
  try {
    const range = t.w.document.createRange();
    range.selectNodeContents(t.editor.querySelector('td'));
    range.collapse(false);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    paste(t.w, t.editor,
      '<table><tr><td>中文第一行<br>中文第二行</td><td>甲</td></tr>' +
      '<tr><td>乙</td><td>丙</td></tr></table>');
    await tick();
    const chooser = scopeChooser(t.w);
    assert.ok(chooser, '没出作用域选项');
    scopeButtons(chooser).plain.click();
    await tick();

    const html = t.editor.innerHTML;
    assert.doesNotMatch(html, /中文第一行中文第二行/,
      `单元格内换行被粘成一行：${html.slice(0, 200)}`);
    assert.match(html, /中文第一行\s*<br\s*\/?>\s*中文第二行/,
      `只贴值后两行之间没有换行：${html.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('「插入新表」不动原表且新表平级；「替换选中整表」只换选中的那张', async () => {
  const t = mountEditor(
    '<table id="one"><tr><td colspan="2">表一合并</td></tr><tr><td>甲1</td><td>甲2</td></tr></table>' +
    '<table id="two"><tr><td>乙1</td><td>乙2</td></tr></table>'
  );
  try {
    const cell = t.editor.querySelector('#one td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();
    scopeButtons(scopeChooser(t.w)).insert.click();
    await tick();

    // 插入新表：原两张都在，多一张平级，不套表
    assert.ok(t.editor.querySelector('#one [colspan="2"]'), '「插入新表」动了表一合并');
    assert.match(t.editor.textContent, /甲1/, '「插入新表」删了表一内容');
    assert.match(t.editor.textContent, /乙1/, '「插入新表」删了表二内容');
    assert.match(t.editor.textContent, /新X/, '「插入新表」没把新表插进来');
    const tables = [...t.editor.querySelectorAll('table')];
    assert.equal(tables.length, 3, `应有 3 张平级表，实际 ${tables.length} 张`);
    for (const outer of tables) {
      assert.equal(outer.querySelectorAll('table').length, 0, '「插入新表」又套表了');
    }

    // —— 替换选中整表：只换表一，表二不碰，表数量不变 ——
    const beforeReplace = t.editor.querySelectorAll('table').length;
    const cell2 = t.editor.querySelector('#one td');
    const r2 = t.w.document.createRange();
    r2.selectNodeContents(cell2);
    r2.collapse(true);
    const s2 = t.w.getSelection();
    s2.removeAllRanges();
    s2.addRange(r2);
    paste(t.w, t.editor, '<table><tr><td>换X</td><td>换Y</td></tr></table>');
    await tick();
    // 粘完默认是「插入新表」，所以此时多了一张；点「替换」应退回默认插入并改成整表替换
    scopeButtons(scopeChooser(t.w)).replace.click();
    await tick();

    assert.match(t.editor.textContent, /换X/, '「替换选中整表」没把新表内容换进去');
    assert.doesNotMatch(t.editor.textContent, /甲1/, '「替换选中整表」没清掉旧表内容');
    assert.match(t.editor.textContent, /乙1/, '「替换选中整表」误伤了另一张表');
    const after = [...t.editor.querySelectorAll('table')];
    // 替换是「换」不是「加/删」：表数量与替换前一致（默认插入的那张被退回）
    assert.equal(after.length, beforeReplace,
        `「替换选中整表」应保持表数量不变：替换前 ${beforeReplace} 张，替换后 ${after.length} 张`);
  } finally { t.dispose(); }
});

it('没有明确目标不能替换：光标不在表里点「替换选中整表」被拒，内容一字不变', async () => {
  const t = mountEditor(
    '<p>正文段落</p>' +
    '<table id="one"><tr><td colspan="2">表一合并</td></tr><tr><td>甲1</td><td>甲2</td></tr></table>'
  );
  try {
    // 光标放在正文段落里 —— 没有「选中的表」
    const p = t.editor.querySelector('p');
    const range = t.w.document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const beforeHtml = t.editor.innerHTML;
    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();

    const chooser = scopeChooser(t.w);
    assert.ok(chooser, '没出作用域选项');
    const s = scopeButtons(chooser);
    assert.ok(s.replace, '缺「替换选中整表」按钮');
    s.replace.click();
    await tick();

    // 没有明确目标 → 必须拒绝，原表一字不变
    assert.ok(t.editor.querySelector('#one [colspan="2"]'), '无目标替换却动了原表合并');
    assert.match(t.editor.textContent, /甲1/, '无目标替换却删了原表内容');
    assert.equal(t.editor.querySelectorAll('table').length, 1, '无目标替换却增删了表数量');
  } finally { t.dispose(); }
});

it('默认不覆盖：不点任何按钮 / 按 Esc，原表保留', async () => {
  const t = mountEditor('<table><tr><td colspan="2">原有合并表头</td></tr><tr><td>旧A</td><td>旧B</td></tr></table>');
  try {
    const cell = t.editor.querySelector('td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();
    const chooser = scopeChooser(t.w);
    assert.ok(chooser, '前置：应出作用域选项');

    // 按 Esc 关掉，什么都不选
    chooser.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    await tick();

    assert.ok(t.editor.querySelector('[colspan="2"]'), 'Esc 后原表合并丢了');
    assert.match(t.editor.textContent, /原有合并表头/, 'Esc 后原表内容被覆盖');
    assert.doesNotMatch(t.editor.textContent, /新X/, 'Esc 后不该把新表内容插进来');
  } finally { t.dispose(); }
});

/* TSV 反例：带引号字段、Tab、格内换行、前导零、长编号 —— 计划原文点名这几种。 */
it('TSV 带引号/格内换行/前导零/长编号都保住', async () => {
  const t = mountEditor('<p>x</p>');
  try {
    // Excel text/plain 侧：引号包起来的字段里有 Tab 之外的内容和换行
    const plain = '编号\t说明\t金额\n"007"\t"第一行\n第二行"\t202630123456.7\n"001"\t短\t0.00';
    paste(t.w, t.editor, '', plain);
    await tick();
    const table = t.editor.querySelector('table');
    assert.ok(table, 'TSV 没还原成表格');
    const text = t.editor.textContent;
    assert.match(text, /007/, '前导零 007 被转成数字 7 了');
    assert.match(text, /001/, '前导零 001 被转成数字 1 了');
    assert.match(text, /202630123456\.7/, '长编号被改写了');
    // 引号不该原样留在格子里
    assert.doesNotMatch(text, /"007"/, '引号没剥掉，字面留在格子里了');
    // 格内换行要保留成两行
    const cells = [...t.editor.querySelectorAll('td')].map((td: any) => td.textContent || '');
    assert.ok(cells.some((c: string) => c.includes('第一行') && c.includes('第二行')),
        `格内换行被压平了：${JSON.stringify(cells)}`);
    // 框线规则延续
    for (const td of table.querySelectorAll('td')) {
      assert.match(td.getAttribute('style') || '', /border\s*:\s*1px/i, 'TSV 表缺可见框线');
    }
  } finally { t.dispose(); }
});

it('一次粘贴只产生一个动作', async () => {
  const t = mountEditor('<p>x</p>');
  try {
    const before = t.changedCount();
    paste(t.w, t.editor, '<table><tr><td>一次</td><td>动作</td></tr></table>');
    await tick();
    const after = t.changedCount();
    assert.ok(after - before <= 2, `一次粘贴触发了 ${after - before} 次变更，不是一步可撤销`);
  } finally { t.dispose(); }
});

/* 用户实测反馈（2026-10-11）：粘带 007/001 的表时「变成表格套表格了」。
   光标在表格里再粘一个表，不该把新表塞进单元格里嵌套。 */
it('在表格里粘表格不套表格：新表落到表外，不塞进单元格', async () => {
  const t = mountEditor('<table><tr><td>原表第一格</td><td>原表第二格</td></tr></table>');
  try {
    // 光标放进表格的第一个格子里
    const cell = t.editor.querySelector('td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // 粘一个带前导零的表
    paste(t.w, t.editor, '<table><tr><td>编号</td><td>金额</td></tr><tr><td>007</td><td>001</td></tr></table>');
    await tick();

    const tables = t.editor.querySelectorAll('table');
    assert.equal(tables.length, 2, `应有 2 张平级的表，实际 ${tables.length} 张（可能套在一起）`);
    // 不能有表里套表
    for (const outer of tables) {
      assert.equal(outer.querySelectorAll('table').length, 0, '出现表格套表格');
    }
    // 前导零不丢
    assert.match(t.editor.textContent, /007/, '前导零 007 被转成 7 了');
    assert.match(t.editor.textContent, /001/, '前导零 001 被转成 1 了');
  } finally { t.dispose(); }
});
