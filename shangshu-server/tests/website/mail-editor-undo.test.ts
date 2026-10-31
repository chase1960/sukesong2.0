import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 N2-C6 正文撤销/重做 —— 用户 2026-10-11 补的一条：
 「撤回只要求撤回正文里的内容，包括表的粘贴和撤回」

 ⚠️ 与「编辑撤回」严格分开：编辑撤回＝已发邮件的撤回/改稿，属后续工作包，本批不碰。
    这里只是**编辑区内的 Ctrl+Z**。

 为什么必须自己维护撤销栈：粘贴走的是 `preventDefault()` + 自建插入
 （否则剪贴板 HTML 会绕过净化门），浏览器原生撤销栈因此是断的。
 用原生撤销去撤粘贴，会退不回去 —— 用户实测「表的粘贴和撤回」要的就是这个。

 测试通过 = 下面全部成立：
 1. 正文里打字 → Ctrl+Z 字没了 → Ctrl+Shift+Z 重做回来。
 2. 粘一张表 → Ctrl+Z **整张表**消失，正文回到粘贴前（不是只撤掉一个字符）。
 3. 一次粘贴 = **一步**撤销：连按一次 Ctrl+Z 就干净回到粘贴前，不残留半张表。
 4. 表格结构操作（插行/删列）后 Ctrl+Z → 该步操作**整个**回退。
 5. 撤销只作用于正文：主题、收件人、附件栏不受影响。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mountEditor(html = '', resources: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  const mounted = w.mailEditor.mountEditor(host, {value: html, resources, onChange: () => {}});
  return {
    w,
    editor: mounted.editor,
    api: mounted,
    dispose: () => dom.window.close(),
  };
}

function key(w: any, editor: any, k: string, mods: any = {}) {
  editor.dispatchEvent(new w.KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
  }));
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

function typeIn(w: any, editor: any, text: string) {
  editor.focus?.();
  editor.textContent = (editor.textContent || '') + text;
  editor.dispatchEvent(new w.Event('input', {bubbles: true}));
}

it('打字后 Ctrl+Z 撤掉，Ctrl+Shift+Z 重做回来', async () => {
  const t = mountEditor('<p>开头</p>');
  try {
    typeIn(t.w, t.editor, 'ABC');
    await tick();
    assert.match(t.editor.textContent, /ABC/, '前置：输入没进正文');

    key(t.w, t.editor, 'z', {ctrlKey: true});
    await tick();
    assert.doesNotMatch(t.editor.textContent, /ABC/, 'Ctrl+Z 没把刚打的字撤掉');

    key(t.w, t.editor, 'z', {ctrlKey: true, shiftKey: true});
    await tick();
    assert.match(t.editor.textContent, /ABC/, 'Ctrl+Shift+Z 没重做回来');
  } finally { t.dispose(); }
});

it('粘一张表后 Ctrl+Z 整张表消失，一步回到粘贴前', async () => {
  const t = mountEditor('<p>粘贴前</p>');
  try {
    paste(t.w, t.editor, '<table><tr><td>新X</td><td>新Y</td></tr></table>');
    await tick();
    assert.ok(t.editor.querySelector('table'), '前置：表没粘进来');

    key(t.w, t.editor, 'z', {ctrlKey: true});
    await tick();

    assert.equal(t.editor.querySelectorAll('table').length, 0,
        'Ctrl+Z 没把整张表撤掉，表还在');
    assert.match(t.editor.textContent, /粘贴前/, '撤销把粘贴前的内容也弄没了');
    assert.doesNotMatch(t.editor.textContent, /新X/, '撤销后还残留表内容');
  } finally { t.dispose(); }
});

it('一次粘贴 = 一步撤销：按一次就干净，不残留半张表', async () => {
  const t = mountEditor('<p>基线</p>');
  try {
    const before = t.editor.innerHTML;
    paste(t.w, t.editor, '<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>');
    await tick();
    const afterPaste = t.editor.innerHTML;
    assert.notEqual(afterPaste, before, '前置：粘贴应改变正文');

    // 连着撤多次 —— 第一次就该干净，后面几次不该再变
    key(t.w, t.editor, 'z', {ctrlKey: true});
    await tick();
    const afterOne = t.editor.innerHTML;
    assert.equal(t.editor.querySelectorAll('table').length, 0, '一次撤销后仍残留表格');
    assert.doesNotMatch(t.editor.textContent, /丙/, '一次撤销后仍残留表格内容');

    for (let i = 0; i < 3; i++) {
      key(t.w, t.editor, 'z', {ctrlKey: true});
      await tick();
      assert.equal(t.editor.querySelectorAll('table').length, 0, `第 ${i + 2} 次撤销又冒出表格`);
    }
    void afterOne;
  } finally { t.dispose(); }
});

it('表格结构操作（插行/删列）后 Ctrl+Z 整步回退', async () => {
  const t = mountEditor('<table><tr><td>甲1</td><td>甲2</td></tr><tr><td>乙1</td><td>乙2</td></tr></table>');
  try {
    const rowsBefore = t.editor.querySelectorAll('tr').length;
    const cell = t.editor.querySelector('td');
    const range = t.w.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = t.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    t.api.insertRow();
    await tick();
    assert.equal(t.editor.querySelectorAll('tr').length, rowsBefore + 1, '前置：插行没生效');

    key(t.w, t.editor, 'z', {ctrlKey: true});
    await tick();
    assert.equal(t.editor.querySelectorAll('tr').length, rowsBefore, 'Ctrl+Z 没把整步插行退回去');
  } finally { t.dispose(); }
});

it('撤销只作用于正文，不越界到主题/收件人/附件', async () => {
  const t = mountEditor('<p>正文</p>');
  try {
    // 模拟「主题栏」有自己的值 —— 撤销只该动编辑器内部
    const subject = t.w.document.createElement('input');
    subject.id = 'c-subject';
    subject.value = '主题不该被动';
    t.w.document.body.appendChild(subject);

    typeIn(t.w, t.editor, '待撤销');
    await tick();
    key(t.w, t.editor, 'z', {ctrlKey: true});
    await tick();

    assert.doesNotMatch(t.editor.textContent, /待撤销/, '正文没被撤掉');
    assert.equal(subject.value, '主题不该被动', '撤销越界改了主题栏');
  } finally { t.dispose(); }
});

/* ---- PKG-014-T01：Excel 网格 → 邮件表格（联测，邮件侧这一半）----

 A（Excel/文件前端）2026-10-14 交的 **`copyData` 真实产物**，不是我自造的替代品。
 A 侧 J1 已 5/5；这条验的是**接口那一半**：A 产出的剪贴板内容，我这边吃得对不对。

 测试通过 = 下面全部成立：

 J1  A 的真实 HTML（含 TSV）粘进正文 → **HTML 那一份被采用**，不是 TSV
 J2  表格进来是 **2 行 × 2 列**，四格文字**一字不差**（含前导零 `BH-00001`、
     `测试品-0001` —— 不许被当成数字吃成 `1`）
 J3  只给 TSV（降级路）→ **≥2 列自动成表**，文字同样保真
 J4  粘进去之后**还能改单元格**（不是一次性死表）
 J5  样式归一后是**两条 border 并存**（`#d0d5dd` 前置 + A 的 `#ccc` 后置后者胜），
     不是被顶掉 —— 这条是 A 与我 2026-10-14 对齐过的口径
*/

/* A 的 copyData 真实输出（2×2 选区） */
const A_HTML = '<table style="border-collapse:collapse;">'
  + '<tr><td style="border:1px solid #ccc;padding:4px 8px;">G2-test-mv6g3ycg</td>'
  + '<td style="border:1px solid #ccc;padding:4px 8px;">G2-test-mv6fz2bc</td></tr>'
  + '<tr><td style="border:1px solid #ccc;padding:4px 8px;">BH-00001</td>'
  + '<td style="border:1px solid #ccc;padding:4px 8px;">测试品-0001</td></tr>'
  + '</table>';
const A_TSV = 'G2-test-mv6g3ycg\tG2-test-mv6fz2bc\nBH-00001\t测试品-0001';

function cells(editor: any) {
  return [...editor.querySelectorAll('td,th')].map((c: any) => (c.textContent || '').trim());
}

it('J1 双格式都在时用 HTML，不是 TSV', async () => {
  const t = mountEditor('');
  try {
    /* HTML 与 plain 给**不同的标记**，才验得出「用的是哪一份」——
       两份内容一样就验不出优先级，那是假判据。 */
    paste(t.w, t.editor,
      '<table style="border-collapse:collapse;"><tr><td style="border:1px solid #ccc;padding:4px 8px;">来自HTML</td></tr></table>',
      '来自TSV');
    await tick();
    const text = t.editor.innerHTML;
    assert.ok(text.includes('来自HTML'),
      `该用 text/html 那一份，实际：${text.slice(0, 200)}`);
    assert.ok(!text.includes('来自TSV'),
      `text/plain 不该顶掉 text/html（Excel 双格式剪贴板），实际：${text.slice(0, 200)}`);
  } finally { t.dispose(); }
});

it('J2 A 的真实产物：2 行 × 2 列、四格文字一字不差（含前导零）', async () => {
  const t = mountEditor('');
  try {
    paste(t.w, t.editor, A_HTML, A_TSV);
    await tick();
    assert.equal(t.editor.querySelectorAll('tr').length, 2,
      `该 2 行，实际 ${t.editor.querySelectorAll('tr').length}`);
    assert.equal(t.editor.querySelectorAll('td').length, 4,
      `该 4 格，实际 ${t.editor.querySelectorAll('td').length}`);
    const got = cells(t.editor);
    assert.deepEqual(got, ['G2-test-mv6g3ycg', 'G2-test-mv6fz2bc', 'BH-00001', '测试品-0001'],
      `四格文字要一字不差，实际 ${JSON.stringify(got)}`);
    /* 前导零单独钉一条 —— 被当数字吃掉会变成 1 / 0001，那是静默失真 */
    assert.ok(got.includes('BH-00001'),
      `前导零被吃了：BH-00001 变成 ${JSON.stringify(got.filter(g => g.startsWith('BH')))}`);
  } finally { t.dispose(); }
});

it('J3 只给 TSV 的降级路：≥2 列自动成表、文字保真', async () => {
  const t = mountEditor('');
  try {
    paste(t.w, t.editor, '', A_TSV);
    await tick();
    assert.equal(t.editor.querySelectorAll('tr').length, 2, 'TSV 该还原成 2 行');
    assert.equal(t.editor.querySelectorAll('td').length, 4, 'TSV 该还原成 4 格');
    assert.deepEqual(cells(t.editor),
      ['G2-test-mv6g3ycg', 'G2-test-mv6fz2bc', 'BH-00001', '测试品-0001'],
      'TSV 降级路的文字也要保真');
  } finally { t.dispose(); }
});

it('J4 粘进去之后还能改单元格（不是死表）', async () => {
  const t = mountEditor('');
  try {
    paste(t.w, t.editor, A_HTML, A_TSV);
    await tick();
    const cell = [...t.editor.querySelectorAll('td')]
      .find((c: any) => (c.textContent || '').trim() === 'BH-00001') as any;
    assert.ok(cell, '找不到 BH-00001 那格');
    assert.notEqual(t.editor.getAttribute('contenteditable'), 'false',
      '正文区不该是不可编辑');
    /* 在那格里改字 */
    cell.textContent = 'BH-00002-改过';
    t.editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();
    assert.ok(cells(t.editor).includes('BH-00002-改过'),
      `粘进去的格子要能改，实际 ${JSON.stringify(cells(t.editor))}`);
  } finally { t.dispose(); }
});

it('J5 样式归一：两条 border 并存（#d0d5dd 前置 + A 的 #ccc 后置后者胜）', async () => {
  const t = mountEditor('');
  try {
    paste(t.w, t.editor, A_HTML, A_TSV);
    await tick();
    const style = t.editor.querySelector('td')?.getAttribute('style') || '';
    /* A 与 C 2026-10-14 对齐的口径：ensureTableBorders 是**前置**加，不是替换。
       所以 #ccc 必须还在，而且在后面（CSS 后者胜 → 视觉上赢的是 A 的 #ccc）。 */
    assert.ok(style.includes('#ccc'),
      `A 的 #ccc 不该被顶掉（ensureTableBorders 是前置不是替换），实际 style=${style}`);
    assert.ok(style.includes('#d0d5dd'),
      `归一会前置 #d0d5dd，实际 style=${style}`);
    const iD = style.indexOf('#d0d5dd'), iC = style.indexOf('#ccc');
    assert.ok(iD > -1 && iC > -1 && iD < iC,
      `#d0d5dd 该在前、#ccc 在后（后者胜），实际 style=${style}`);
  } finally { t.dispose(); }
});

/* ── BASE967-47（req 5）：切签名后撤回，正文与 CID 资源必须**一起**回退 ─────────
   用户实测 UI-058：换身份签名后再撤回，画面恢复了旧 Logo，但关闭时自动保存报
   「正文引用的内联图片未随本次保存提供」—— 正文引用了 CID，保存载荷里没有对应资源。
   测试通过 = 撤回后正文回到旧签名，且正文里每个 cid: 都有对应的受管资源。 */
const logoRes = (cid: string) => ({
  content_id: cid, mime_type: 'image/png', name: cid + '.png', file: 'file-' + cid,
});

it('切签名后撤回：正文里的 CID 仍有对应受管资源（BASE967-47）', async () => {
  const SIG_A = '<p>此致敬礼<br><img src="cid:logo-a@x" alt="Logo"></p>';
  const SIG_B = '<p>此致敬礼<br><img src="cid:logo-b@x" alt="Logo"></p>';
  const t = mountEditor('<p>正文</p>' + SIG_A, [logoRes('logo-a@x'), logoRes('logo-b@x')]);
  try {
    // 模拟写信窗里「换成新身份的签名」：bodyEditor.applyEdit(next, {actor:'user', resources:[B]})
    t.api.applyEdit('<p>正文</p>' + SIG_B, {actor: 'user', resources: [logoRes('logo-b@x')]});
    await tick();
    t.api.undo();
    await tick();
    const html = t.api.getHtml();
    assert.match(html, /cid:logo-a@x/, `撤回后正文没回到旧签名：${html.slice(0, 160)}`);
    assert.doesNotMatch(html, /cid:logo-b@x/, `撤回后正文还留着新签名：${html.slice(0, 160)}`);
    const ids = new Set(t.api.getInlineResourcesForSave().map((r: any) => r.content_id));
    for (const m of html.matchAll(/cid:([A-Za-z0-9._@+-]+)/g)) {
      assert.ok(ids.has(m[1]),
        `正文引用了 cid:${m[1]}，保存资源里却没有它 —— 保存会被「内联图片未随本次保存提供」拒绝；` +
        `现有资源：${[...ids].join('、')}`);
    }
  } finally { t.dispose(); }
});
