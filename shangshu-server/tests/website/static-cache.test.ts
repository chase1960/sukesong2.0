import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticCacheControl, rewriteIndexAssets, assetFingerprint, readIndexPage } from '../../src/adapters/web/server.ts';

test('入口 HTML 不变，仅脚本或样式更新时指纹也立即变化', () => {
  const dir=mkdtempSync(join(tmpdir(),'ss-index-refresh-'));
  try {
    mkdirSync(join(dir,'js'));mkdirSync(join(dir,'css'));
    writeFileSync(join(dir,'index.html'),'<script src="js/mail.js"></script><link href="css/mail.css">');
    writeFileSync(join(dir,'js/mail.js'),'version-one');writeFileSync(join(dir,'css/mail.css'),'style-one');
    const first=readIndexPage(dir);
    writeFileSync(join(dir,'js/mail.js'),'version-two');
    const second=readIndexPage(dir);
    assert.notEqual(first,second);
    assert.ok(second.includes(assetFingerprint('version-two')));
    writeFileSync(join(dir,'css/mail.css'),'style-two');
    const third=readIndexPage(dir);
    assert.ok(third.includes(assetFingerprint('style-two')));
    assert.equal(third,readIndexPage(dir));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('缓存策略：?h= 内容指纹资源 immutable 长缓存；手工 ?v= 与无版本脚本仍每次重验证', () => {
  // ?h= 由服务端注入，内容变 URL 必变，弱网下允许直接命中本地缓存。
  assert.equal(staticCacheControl('/js/app.js', true), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/css/mail-center.css', true), 'public, max-age=31536000, immutable');
  // 手工 ?v= 不能保证脚本/样式内容不变（漏 bump 风险），保持重验证。
  for (const asset of ['/js/real-flowdesign.js', '/js/domains/finance-process.js', '/css/platform.css', '/js/file-pdf.mjs']) {
    assert.equal(staticCacheControl(asset, false), 'public, max-age=0, must-revalidate');
  }
  assert.equal(staticCacheControl('/fonts/app.woff2', true), 'public, max-age=604800, immutable');
  assert.equal(staticCacheControl('/images/logo.png', false), 'public, max-age=0, must-revalidate');
});

test('入口页重写：本地 js/css 换成内容指纹；外链、图片和缺失文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-index-'));
  try {
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'mail.css'), 'body{}');
    const resolve = (rel: string) => {
      if (rel === 'js/app.js') return join(dir, 'app.js');
      if (rel === 'css/mail.css') return join(dir, 'mail.css');
      return null; // 其余视为不存在，保持原样
    };
    const html = [
      '<script src="js/app.js?v=20260921-mail-1"></script>',
      '<link rel="stylesheet" href="css/mail.css">',
      '<link rel="stylesheet" href="css/missing.css">',
      '<img src="brand-mark.png">',
      '<script src="https://cdn.example.com/x.js"></script>',
    ].join('\n');
    const out = rewriteIndexAssets(html, resolve);
    assert.match(out, new RegExp(`src="js/app\\.js\\?h=${assetFingerprint('console.log(1)')}"`));
    assert.match(out, /href="css\/mail\.css\?h=[0-9a-f]{10}"/);
    assert.match(out, /css\/missing\.css"/);                 // 缺失文件不改写
    assert.match(out, /brand-mark\.png"/);                   // 图片不改写
    assert.match(out, /https:\/\/cdn\.example\.com\/x\.js"/); // 外链不改写
    // 内容变了指纹必须变
    writeFileSync(join(dir, 'app.js'), 'console.log(2)');
    const out2 = rewriteIndexAssets(html, resolve);
    assert.match(out2, new RegExp(`\\?h=${assetFingerprint('console.log(2)')}"`));
    assert.notEqual(assetFingerprint('console.log(1)'), assetFingerprint('console.log(2)'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('入口页响应带 no-cache 且资源 URL 已换指纹（真实 app 集成）', async () => {
  const { buildApp } = await import('../../src/adapters/web/server.ts');
  const app = buildApp();
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    const refs = [...body.matchAll(/(?:src|href)="((?:js|css|vendor)\/[^"?]+?\.(?:js|css))(?:\?h=[0-9a-f]{10})?"/g)].map(m => m[1]);
    assert.ok(refs.length >= 20, `应有大量本地资源被引用，实际 ${refs.length}`);
    for (const ref of refs) {
      assert.match(body, new RegExp(`${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?h=[0-9a-f]{10}"`), `${ref} 未带指纹`);
    }
    // 指纹资源响应 immutable
    const assetUrl = (body.match(/(?:src|href)="(js\/app\.js\?h=[0-9a-f]{10})"/) || [])[1];
    assert.ok(assetUrl, 'app.js 应带指纹');
    const asset = await fetch(`http://127.0.0.1:${port}/${assetUrl}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    // 手工 ?v= 仍重验证，不能被当成指纹
    const manual = await fetch(`http://127.0.0.1:${port}/js/app.js?v=20260921-sidebar-2`);
    assert.equal(manual.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    // 真正请求入口的每份样式，不能把“HTML写了指纹”当成样式已成功加载。
    const styles = [...body.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map(m => m[1]);
    assert.ok(styles.length > 0, '入口必须有样式');
    for (const href of styles) {
      const css = await fetch(`http://127.0.0.1:${port}/${href}`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(css.status, 200, `${href} 应正常返回`);
      assert.match(css.headers.get('content-type') || '', /^text\/css\b/i, `${href} 不能返回 HTML`);
      assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      const original = readFileSync(new URL(`../../../shangshu-web/${href.split('?')[0]}`, import.meta.url));
      if (original.length >= 1024) assert.equal(css.headers.get('content-encoding'), 'gzip', `${href} 应压缩`);
      // fetch 自动解压；逐字节比对原文件，覆盖压缩损坏或误返入口内容。
      assert.deepEqual(Buffer.from(await css.arrayBuffer()), original, `${href} 解压后的内容应与源文件一致`);
    }
    const missing = await fetch(`http://127.0.0.1:${port}/css/__missing_static_regression__.css`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(missing.status, 404, '缺失 CSS 不能以 200 回退到入口页');
    assert.doesNotMatch(await missing.text(), /id="workspace-shell"|id="boot-veil"/, '缺失 CSS 不能返回应用入口');
    assert.doesNotMatch(body,/src="[^\"]*(?:pdf\.min|pdf\.worker)/,'PDF引擎不能阻塞首屏');
    for(const rel of ['js/file-pdf.mjs','vendor/pdfjs-6.4.299/pdf.min.mjs','vendor/pdfjs-6.4.299/pdf.worker.min.mjs']){
      const res=await fetch(`http://127.0.0.1:${port}/${rel}`,{headers:{'Accept-Encoding':'gzip'}});
      assert.equal(res.status,200);assert.match(res.headers.get('content-type')||'',/javascript/);
      assert.equal(res.headers.get('content-encoding'),'gzip');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()),readFileSync(new URL('../../../shangshu-web/'+rel,import.meta.url)));
    }
  } finally { server.close(); }
});
