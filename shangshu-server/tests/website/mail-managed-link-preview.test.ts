import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 链接重接之后，读信页要把**受管地址**当成受管资源，不是外链。

 用户 2026-10-13 口径（执行计划「链接重接」）：
   「正文中的附件引用/图片链接重接到文件库的受管地址，不再指向原始 MIME 内嵌
     或临时路径。受管外链可行——授权范围内的人点链接能看/下载，撤权后链接失效。
     这也解决了外链图被安全设计拦下的问题：把外链转成受管内链即可放行。」

 后端已经把正文里的 cid: 换成 `/api/platform/file-content?…`（受管下载口）。
 但读信页是**沙箱 iframe**：CSP 是 `img-src cid: data:`，`safeFragment` 只放行
 `src="cid:…"`，其余 src 一律剥掉并标 `data-blocked-src`。
 于是受管地址会被**当外链挡掉** —— 后端接对了，页面上看还是破图。

 测试通过 = 下面全部成立：

 1. `safeFragment` **留住**受管地址的 src（不当外链剥）
 2. `previewSrcdoc` 把受管地址**换成已授权字节**（data URI），图真的显示
 3. **不是无差别放行**：随便一个外链 img 照样被剥、照样标 blocked
 4. `<a href>` 指向受管地址时**链接留得住**（授权的人点得开）
 5. CSP 仍然禁网禁脚本 —— 放行的是**解析后的 data URI**，不是把网络打开

跑法：node --test shangshu-server/tests/website/mail-managed-link-preview.test.ts
*/

const MANAGED = '/api/platform/file-content?ref=Shangshu+File+Center+File&ref_name=fc001&file=f001';
/* outerHTML 序列化会把 & 转义成 &amp; —— 断言里两个形态都要认，
   否则「留住了」会被自己的转义误判成「被剥了」（实测栽过一次）。 */
const MANAGED_ESC = MANAGED.replace(/&/g, '&amp;');
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
const EVIL = 'https://evil.example/track.png';

function keepsManaged(safe: string) {
  return (safe.includes(MANAGED) || safe.includes(MANAGED_ESC))
    && !safe.includes('data-blocked-src');
}

function load() {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js', import.meta.url), 'utf8'));
  return {w, dispose: () => dom.window.close()};
}

it('1. safeFragment 留住受管地址的 src，不当外链剥', () => {
  const t = load();
  try {
    const safe = t.w.mailEditor.safeFragment(`<img src="${MANAGED}" alt="logo">`);
    assert.ok(keepsManaged(safe), `受管地址被剥掉或标成外链拦下了：${safe}`);
  } finally { t.dispose(); }
});

it('2. previewSrcdoc 把受管地址换成已授权字节（图真的显示）', () => {
  const t = load();
  try {
    const map: Record<string, string> = {[MANAGED]: DATA_URI, [MANAGED.replace(/&/g, '&amp;')]: DATA_URI};
    const safe = t.w.mailEditor.safeFragment(`<img src="${MANAGED}" alt="logo">`);
    const srcdoc = t.w.mailEditor.previewSrcdoc(safe, map);
    assert.ok(srcdoc.includes(DATA_URI), `受管地址没被换成字节，图显示不出来：${srcdoc.slice(0, 400)}`);
    assert.ok(!srcdoc.includes('data-blocked-src'), `换完还标了 blocked：${srcdoc.slice(0, 400)}`);
  } finally { t.dispose(); }
});

it('3. 不是无差别放行 —— 随便一个外链 img 照样被剥、照样标 blocked', () => {
  const t = load();
  try {
    const map: Record<string, string> = {[MANAGED]: DATA_URI};
    const safe = t.w.mailEditor.safeFragment(`<img src="${EVIL}" alt="x">`);
    assert.ok(!safe.includes(EVIL), `外链没被剥：${safe}`);
    const srcdoc = t.w.mailEditor.previewSrcdoc(safe, map);
    assert.ok(!srcdoc.includes(EVIL), `外链进了预览：${srcdoc.slice(0, 400)}`);
    assert.ok(srcdoc.includes('data-blocked-src'), `外链没标 blocked：${srcdoc.slice(0, 400)}`);
  } finally { t.dispose(); }
});

it('4. <a href> 指向受管地址时链接留得住（授权的人点得开）', () => {
  const t = load();
  try {
    const safe = t.w.mailEditor.safeFragment(`<p>附件见 <a href="${MANAGED}">这里</a>。</p>`);
    assert.ok(keepsManaged(safe), `受管链接被剥掉了：${safe}`);
  } finally { t.dispose(); }
});

it('5. CSP 仍然禁网禁脚本 —— 放行的是解析后的 data URI，不是把网络打开', () => {
  const t = load();
  try {
    const map: Record<string, string> = {[MANAGED]: DATA_URI};
    const srcdoc = t.w.mailEditor.previewSrcdoc(
      t.w.mailEditor.safeFragment(`<img src="${MANAGED}">`), map);
    assert.ok(srcdoc.includes("default-src 'none'"), `CSP 的 default-src 被动过：${srcdoc.slice(0, 300)}`);
    assert.ok(!/img-src[^;]*https?:/i.test(srcdoc), `CSP 的 img-src 放开了网络：${srcdoc.slice(0, 300)}`);
    assert.ok(!/<script/i.test(srcdoc), `预览里冒出 script：${srcdoc.slice(0, 300)}`);
  } finally { t.dispose(); }
});

it('签名未建稿时用固定版本source读图，既有邮件403不能改借文件中心或错配file',async()=>{
 const t=load(),calls:any[]=[];const resource={content_id:'logo@example.invalid',mime_type:'image/png',file:'f001',source:{ref_doctype:'Shangshu File Center File',ref_name:'fc001',file:'f001'}};
 t.w.fetch=async(url:string,options:any)=>{calls.push({url,options});const query=new URL(url,'http://localhost/').searchParams;return {ok:query.get('ref')==='Shangshu File Center File',arrayBuffer:async()=>Uint8Array.from([137,80,78,71]).buffer};};
 try{const map=await t.w.mailEditor.inlinePreviewMap([resource],{});assert.match(map[resource.content_id],/^data:image\/png/);assert.equal(calls.length,1);assert.equal(calls[0].options.credentials,'same-origin');
  calls.length=0;const denied=await t.w.mailEditor.inlinePreviewMap([resource],{ref:'Shangshu Mail Message',ref_name:'mail-denied'});assert.deepEqual(Object.keys(denied),[]);assert.equal(calls.length,1,'已归属邮件读取被拒，不能换其他归属重试来绕过撤权');assert.equal(new URL(calls[0].url,'http://localhost/').searchParams.get('ref_name'),'mail-denied');
  calls.length=0;const mismatch=await t.w.mailEditor.inlinePreviewMap([{...resource,source:{...resource.source,file:'other-file'}}],{});assert.deepEqual(Object.keys(mismatch),[]);assert.equal(calls.length,0,'source必须是当前图片的固定版本');
 }finally{t.dispose();}
});
