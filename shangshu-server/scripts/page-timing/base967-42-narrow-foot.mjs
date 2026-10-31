/*
 BASE967-42（UI045）窄栏按钮遮挡 —— **真页面几何验证**（不是 jsdom）。

 判据：测试通过 = 900×800 窄栏下，草稿底部「关闭」按钮的**中心点**用
   `elementFromPoint` 命中的是**那个按钮本身**，不是 `.ai-fab` 的 SVG；
   1400×900 宽栏下不出现新遮挡。

 为什么不是 jsdom：jsdom 不做真实布局，`elementFromPoint` 与盒模型都不算。
 这条是 967-ui045-narrow-overlap 那份证据用的同一手法（DOM elementFromPoint + 截图）。

 为什么不用整站：BASE967 线的代码没部署到运行实例（部署要授权，闸拒着）。
 这里把**真 CSS**（deepseek.css 的 .ai-fab + mail-center.css 的 .dlg-foot）注进
 最小 HTML，验的就是那两条规则的真实几何 —— **布局问题就该在布局层验**。

 只走无界面 Chrome + CDP，不拉起本机图形应用。
*/
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../../shangshu-web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const deepseek = read('css/deepseek.css');
const mailCenter = read('css/mail-center.css');

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${deepseek}</style><style>${mailCenter}</style>
<style>
  /* 把两个真实规则装到最小结构上，验的就是它们的几何 */
  body{margin:0}
  .mail-center-page{height:100dvh}
  .mail-center-page .mail-reading-pane.is-composing{height:100%;display:flex;flex-direction:column}
  .mail-center-page .is-composing .dlg-body{flex:1}
</style></head><body>
<div class="mail-center-page">
  <div class="mail-reading-pane is-composing">
    <div class="dlg-head"><span>写邮件</span></div>
    <div class="dlg-body"><p>正文</p></div>
    <div class="dlg-foot">
      <button type="button" class="btn">保存</button>
      <button type="button" class="btn" id="close-btn">关闭</button>
    </div>
  </div>
</div>
<button class="ai-fab show" id="ai-fab"><svg width="15" height="15"><circle cx="7" cy="7" r="7"/></svg>AI 助手</button>
</body></html>`;

const PASS = [], FAIL = [];
const need = (code, label, ok, detail = '') => {
  if (typeof ok !== 'boolean') throw new Error(`need() 第三参必须是布尔，实收 ${typeof ok}`);
  (ok ? PASS : FAIL).push(code);
  console.log(`  ${ok ? '✔' : '✖'} ${code} ${label}${!ok && detail ? '  ← ' + detail : ''}`);
};

const {send, open, ws} = connect(await browserWsUrl());
await open;

async function check(width, height, tag) {
  const {sendS} = await openPage(send, ws, 'about:blank');
  /* ★ 真正设视口 —— 用 CDP 的 Emulation.setDeviceMetricsOverride。
     我第一版用 `document.documentElement.style.width`，**那不改变真实视口**，
     窄栏根本没生效（按钮 y=777 而缺陷是 y=713，浮钮压根没盖上来），
     于是判据恒真、注掉修复照样绿 —— 差点交一个假绿。 */
  await sendS('Emulation.setDeviceMetricsOverride',
    {width, height, deviceScaleFactor: 1, mobile: false});
  await evalIn(sendS, `document.open(); document.write(${JSON.stringify(html)}); document.close();`);
  await new Promise(r => setTimeout(r, 200));
  const out = await evalIn(sendS, `(async () => {
    const btn = document.getElementById('close-btn');
    const fab = document.getElementById('ai-fab');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      btnRect: {x: r.left, y: r.top, w: r.width, h: r.height},
      center: {x: cx, y: cy},
      hitTag: hit ? (hit.id || hit.className || hit.tagName) : null,
      hitIsBtn: !!(hit && (hit === btn || btn.contains(hit))),
      hitIsFab: !!(hit && (hit === fab || (fab && fab.contains(hit)))),
      fabRect: fab ? (() => { const f = fab.getBoundingClientRect(); return {x: f.left, y: f.top, w: f.width, h: f.height}; })() : null,
      overlap: fab ? (() => { const f = fab.getBoundingClientRect();
        return !(r.right < f.left || r.left > f.right || r.bottom < f.top || r.top > f.bottom); })() : null,
    });
  })()`);
  const r = JSON.parse(out);
  console.log(`  [${tag} ${width}×${height}] 关闭=${JSON.stringify(r.btnRect)} 浮钮=${JSON.stringify(r.fabRect)} 几何重叠=${r.overlap} 中心命中=${r.hitTag}`);
  need(`${tag}-1`, `关闭按钮中心命中的是按钮本身`, r.hitIsBtn,
       `命中 ${r.hitTag} —— 中心 ${JSON.stringify(r.center)} 被别的控件盖住`);
  need(`${tag}-2`, `关闭按钮中心不是浮钮`, !r.hitIsFab,
       `命中了 .ai-fab —— 浮钮遮挡仍在`);
  need(`${tag}-3`, `关闭按钮与浮钮几何上不重叠`, r.overlap === false,
       `两个矩形相交 —— 即使中心暂时没被遮，也是布局隐患`);
}

console.log('窄栏 900×800（BASE967-42 的实测视口）');
await check(900, 800, 'N');
console.log('宽栏 1400×900（复验正常宽度不引入新遮挡）');
await check(1400, 900, 'W');

console.log('');
console.log('='.repeat(50));
console.log(`通过 ${PASS.length} 条，失败 ${FAIL.length} 条`);
if (FAIL.length) { console.log('未过：' + FAIL.join(' | ')); process.exit(1); }
process.exit(0);
