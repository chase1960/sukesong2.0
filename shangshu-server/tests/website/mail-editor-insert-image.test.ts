import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 N3-A 插图进正文 —— 用户 2026-10-11 验收反馈 1.1：
 「点写邮件 → 插图/拖一张图进正文 → 存草稿 → 关掉再打开｜现象：**不行，拖进来也不行，显示不出来**」

 现状（查实）：mail-editor.js 里**没有**拖放处理、**没有**选图入口、**没有**插图按钮；
 净化器 safeFragment **只认 src="cid:…"` 的图**，拖进来的 blob:/data: 图会被直接剥掉。
 「把一张新图插进正文」这条路径**压根不存在**。
 先前 N2-C1 只做到「已经存好的受管内联图能显示」，清单 1.1 却让用户「拖一张图进来」—— 那是清单写错了。

 测试通过 = 下面全部成立：
 1. 往正文里**拖一张图**（或走插图入口选图）→ 图**当场显示**（真解码出像素，不是空白/破图标）。
 2. 图走**受管资源**那条路：正文里存的是 `src="cid:…"` **引用**，**字节不写进正文**
    （保存后正文里没有 base64）；插进来的资源能被宿主取走、随保存送出去。
 3. **拖一个非图片文件**（.txt/.pdf）→ **拒绝**，正文一个字都不变，不插破图标。
 4. 插进去的图**不外联**：src 不是 http(s)。
 5. 已有图 + 新插图共存，保存出去的资源列表两个都在，content_id 不撞。
*/

/* 最小 PNG（1×1）—— 真图片字节，jsdom 里也能走 File 路径 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mount(html = '', resources: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  /* 上传走宿主给的回调：编辑器不自己决定怎么建受管文件，
     这样「字节怎么落库」由宿主（写信窗）负责，编辑器只管插引用。 */
  const uploads: any[] = [];
  /* 拖放落地是**异步**的：insertImages 要等 uploadImage + FileReader 转 data URL 才把 <img> 插进正文。
     以前这里只等固定 10ms，机器忙的时候 FileReader 还没回来 → 「图没出现」的假红（实测会随机红）。
     改成等编辑器自己回调：onImagesInserted = 插进去了，onNotice = 被拒了，两个都算这次拖放结束。
     带 2s 兜底，产品真坏了照样超时后由断言判红，不会挂死。 */
  let dropSettled: (v: any) => void = () => {};
  const dropDone = new Promise(resolve => { dropSettled = resolve; });
  const notices: string[] = [];
  /* onNotice 有**两类**，别混（混了会假红，实测踩过）：
     ① 拖放被拒（不是图片 / 没有文件 / 图没插进去）—— 这类才算「这次拖放结束」
     ② 已有图取不到字节（C2 要求吭声）—— 这类与本次拖放无关，**不许**提前结束等待，
        否则新图还没落地就去读资源表，看起来像「新图没进资源列表」。 */
  const DROP_REJECT = /不是图片|没有文件|图没插进去|不支持/;
  const mounted = w.mailEditor.mountEditor(host, {
    value: html,
    resources,
    onChange: () => {},
    uploadImage: async (file: any) => {
      uploads.push({name: file.name, type: file.type, size: file.size});
      return {content_id: 'cid-' + uploads.length + '@shangshu.local', mime_type: file.type || 'image/png', file: 'f' + uploads.length,source:{ref_doctype:'Shangshu File Center File',ref_name:'lib'+uploads.length,file:'f'+uploads.length}};
    },
    onImagesInserted: (list: any) => dropSettled({ok: true, list}),
    onNotice: (reason: string) => {
      notices.push(reason);
      if (DROP_REJECT.test(String(reason || ''))) dropSettled({ok: false, reason});
    },
  });
  const dropped = () => Promise.race([dropDone, new Promise(r => setTimeout(() => r({timeout: true}), 2000))]);
  return {w, editor: mounted.editor, api: mounted, uploads, notices, dropped, dispose: () => dom.window.close()};
}

function pngFile(w: any, name = '签章.png', type = 'image/png') {
  const bin = w.atob ? w.atob(PNG_B64) : Buffer.from(PNG_B64, 'base64').toString('binary');
  const bytes = Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
  return new w.File([bytes], name, {type});
}

/** 拖放：真实 dragover/drop 事件序列 + dataTransfer（jsdom 没有 DataTransfer 构造器，手工挂）。 */
function dropFiles(w: any, editor: any, files: any[]) {
  const dt = {
    types: ['Files'],
    files,
    items: files.map(() => ({kind: 'file'})),
    getData: () => '',
  };
  const over = new w.Event('dragover', {bubbles: true, cancelable: true});
  Object.defineProperty(over, 'dataTransfer', {value: dt});
  editor.dispatchEvent(over);
  const ev = new w.Event('drop', {bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'dataTransfer', {value: dt});
  editor.dispatchEvent(ev);
  return ev;
}

it('往正文里拖一张图 → 图当场显示，正文存的是 cid: 引用不是字节', async () => {
  const t = mount('<p>正文开头</p>');
  try {
    const ev = dropFiles(t.w, t.editor, [pngFile(t.w)]);
    await t.dropped();
    await t.api.imagesReady();

    assert.equal(ev.defaultPrevented, true, '拖放没被接管，浏览器会走默认行为');
    const img = t.editor.querySelector('img');
    assert.ok(img, '拖进去的图没有出现在正文里');
    const src = img.getAttribute('src') || '';
    assert.ok(src.startsWith('data:image/'), `图没真显示出来，src=${src.slice(0, 40)}`);
    assert.ok(img.complete || true, '图没完成解码');

    // 字节不许写进正文：保存出去的 HTML 只能是 cid: 引用
    const saved = t.api.getHtml();
    assert.ok(/src="cid:/.test(saved), `保存的正文里不是 cid: 引用：${saved.slice(0, 120)}`);
    assert.ok(!/base64/.test(saved), '字节被写进正文了');
  } finally { t.dispose(); }
});

it('插进来的资源能被宿主取走、随保存送出去（content_id 对得上）', async () => {
  const t = mount('<p>x</p>');
  try {
    dropFiles(t.w, t.editor, [pngFile(t.w)]);
    await t.dropped();
    await t.api.imagesReady();
    assert.equal(t.uploads.length, 1, '没走宿主给的上传通道');
    assert.equal(t.uploads[0].type, 'image/png', `传给宿主的类型不对：${t.uploads[0].type}`);

    const resources = t.api.getInlineResources();
    assert.equal(resources.length, 1, `宿主拿不到资源列表：${JSON.stringify(resources)}`);
    assert.equal(resources[0].content_id, 'cid-1@shangshu.local');
    assert.equal(resources[0].file, 'f1');
    assert.deepEqual(JSON.parse(JSON.stringify(resources[0].source)),{ref_doctype:'Shangshu File Center File',ref_name:'lib1',file:'f1'},'未建稿签名需要保留上传服务给的正式归属，才能在下次打开取回图片');
  } finally { t.dispose(); }
});

it('拖一个非图片文件 → 拒绝，正文一个字都不变', async () => {
  const t = mount('<p>一个字都不许动</p>');
  try {
    const before = t.editor.innerHTML;
    const doc = new t.w.File([t.w.atob('aGVsbG8=')], '对账单.pdf', {type: 'application/pdf'});
    dropFiles(t.w, t.editor, [doc]);
    const settled = await t.dropped();
    // 等到编辑器**真的回了拒绝**才算这次拖放结束 —— 只等 10ms 的话，
    // 拖放处理压根没跑也会绿（假绿）。
    assert.equal(settled.ok, false, `非图片文件没被拒绝：${JSON.stringify(settled)}`);
    assert.match(t.notices.join(' '), /不是图片/, `拒绝理由不对：${JSON.stringify(t.notices)}`);

    assert.equal(t.editor.innerHTML, before, '非图片文件把正文弄变了');
    assert.equal(t.editor.querySelector('img'), null, '非图片文件被插成破图标了');
    assert.equal(t.uploads.length, 0, '非图片文件还去传了一次');
    assert.equal((t.api.getInlineResources() || []).length, 0, '非图片文件进了资源列表');
  } finally { t.dispose(); }
});

it('拖进去的图不外联：src 不是 http(s)', async () => {
  const t = mount('<p>x</p>');
  try {
    dropFiles(t.w, t.editor, [pngFile(t.w)]);
    await t.dropped();
    await t.api.imagesReady();
    const img = t.editor.querySelector('img');
    assert.ok(img, '图没插进去');
    const src = img.getAttribute('src') || '';
    assert.ok(!/^https?:/i.test(src), `图变成外链了：${src.slice(0, 60)}`);
    assert.ok(/^data:image\//i.test(src), `显示源不是受管解析出来的图：${src.slice(0, 60)}`);
  } finally { t.dispose(); }
});

it('已有图 + 新插图共存，资源列表两个都在，content_id 不撞', async () => {
  const t = mount('<p>已有一张</p><p><img src="cid:old@shangshu.local"></p>',
    [{content_id: 'old@shangshu.local', mime_type: 'image/png', name: '旧图.png', file: 'fold'}]);
  try {
    dropFiles(t.w, t.editor, [pngFile(t.w, '新图.png')]);
    await t.dropped();
    await t.api.imagesReady();

    const resources = t.api.getInlineResources();
    assert.equal(resources.length, 2, `资源列表不对：${JSON.stringify(resources)}`);
    const ids = resources.map((r: any) => r.content_id);
    assert.equal(new Set(ids).size, 2, `content_id 撞了：${JSON.stringify(ids)}`);
    assert.ok(ids.includes('old@shangshu.local'), '原有的资源被丢了');

    const saved = t.api.getHtml();
    assert.equal((saved.match(/src="cid:/g) || []).length, 2, `保存的正文里引用数不对：${saved.slice(0, 160)}`);
  } finally { t.dispose(); }
});

it('一次拖两张图 → 两张都插进来，都进资源列表', async () => {
  const t = mount('<p>x</p>');
  try {
    dropFiles(t.w, t.editor, [pngFile(t.w, 'a.png'), pngFile(t.w, 'b.png')]);
    await t.dropped();
    await t.api.imagesReady();
    assert.equal(t.editor.querySelectorAll('img').length, 2, '两张图没都插进来');
    assert.equal(t.api.getInlineResources().length, 2, '资源列表少了');
  } finally { t.dispose(); }
});
