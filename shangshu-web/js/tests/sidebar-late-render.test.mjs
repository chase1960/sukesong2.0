// 判据：**晚挂 `RENDER` 的页也要能进侧栏** —— 侧栏要在**所有脚本加载完**之后重画一次。
//
// **测试通过 =**（一句话）
// 「`app.js` 在 `load` 事件（所有脚本都执行完了）之后**重画一次侧栏**
//   ⇒ 晚挂渲染函数的页（核心页，如审核中心）**不会**被 `pageAvailable()` 漏掉。」
//
// ⚠️ **这条是通用兜底，不是「审核中心」缺项的原因**（2026-10-22 复核）：
//   这段兜底上线后侧栏**仍然**缺「审核中心」那一项 ⇒ 真原因是**岗位预设**
//   （`ROLE_PRESET` 四份都没列它）⇒ 那条由 `sidebar-review-entry.test.mjs` 钉住。
//   本条只保证「机制本身还在」：以后再有页晚挂 `RENDER`，别再漏一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const appSource = fs.readFileSync(path.join(ROOT, 'shangshu-web/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'shangshu-web/index.html'), 'utf8');

test('① app.js 在 load 之后重画一次侧栏', () => {
  assert.match(appSource, /addEventListener\(\s*['"]load['"]/,
    'app.js 没有在 load 之后重画侧栏 ⇒ 晚挂 RENDER 的页进不了侧栏');
  const loadBlock = appSource.slice(appSource.indexOf("addEventListener('load'"));
  assert.match(loadBlock.slice(0, 400), /renderChrome\(\)/,
    'load 回调里没有调 renderChrome（侧栏不会被重画）');
});

test('② 审核中心这一页的渲染函数**晚于 app.js**（所以需要那一次重画）', () => {
  const appAt = html.indexOf('js/app.js');
  const centerAt = html.indexOf('js/review-center.js');
  assert.ok(appAt > 0 && centerAt > 0, 'index.html 里找不到这两个脚本');
  assert.ok(centerAt > appAt,
    '审核中心现在排在 app.js **之前**了 ⇒ 那条判据的前提变了，得重新想时序');
});

test('③ 侧栏那一项在 GROUPS 里（公共页也要有入口）', () => {
  assert.match(appSource, /id:\s*'review-center'/, "侧栏里没有「审核中心」这一项");
});
