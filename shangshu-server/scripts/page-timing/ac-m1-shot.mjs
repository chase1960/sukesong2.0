/*
 AC-M1 肉眼证据：把那封「原来一片空白」的 HTML 信打开，抓一张读信画面。
 数字证据说「抽进预览 5275 字」，这张图是给人看的 —— 到底空不空，一眼定。
 只走无界面 Chrome（CDP），不拉起任何本机图形应用。
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';
const OUT = process.env.SHOT_OUT || '/path/to/workspace';

function readPassword() {
  const m = fs.readFileSync(ACCOUNT_FILE, 'utf8').match(/密码[：:]\s*(\S+)/);
  if (!m) throw new Error('账号文件里没读到密码行');
  return m[1];
}

const {send, open, ws} = connect(await browserWsUrl());
await open;
const {sendS} = await openPage(send, ws, `${BASE}/`);
await new Promise(r => setTimeout(r, 2500));

const already = await evalIn(sendS, `!document.querySelector('#un')`);
if (!already) {
  const pw = readPassword();
  await evalIn(sendS, `(() => {
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                             : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    set(document.querySelector('#un'), 'Administrator');
    set(document.querySelector('#pw'), ${JSON.stringify(pw)});
    document.querySelector('button[type=submit]').click();
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 3500));
}

await evalIn(sendS, `location.hash = '#/mail', 'nav'`);
await new Promise(r => setTimeout(r, 3500));

const info = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const box = document.querySelector('#mail-box');
  if (box) { box.value = 'inbox'; box.dispatchEvent(new Event('change', {bubbles: true})); }
  for (let i = 0; i < 40 && !document.querySelector('#mail-rows [data-open]'); i++) await sleep(150);
  const items = [...document.querySelectorAll('#mail-rows [data-open], #mail-rows [data-mail]')];
  const pick = items.find(el => /NVIDIA|训练营|课程|Free, open source|聆听/.test(el.textContent || '')) || items[0];
  if (!pick) return {error: '没找到可点的信'};
  pick.click();
  for (let i = 0; i < 60 && !document.querySelector('iframe.mail-body-preview'); i++) await sleep(100);
  await sleep(1500);
  return {
    subject: (document.querySelector('.mail-reading-pane h2')?.textContent || '').slice(0, 60),
    frame: !!document.querySelector('iframe.mail-body-preview'),
  };
})()`);
console.log('打开的信：', JSON.stringify(info));

// 页面是 height:100dvh + overflow:hidden —— 正文区在视口底下会被切掉。
// 先把「窗口」拉高，才能把正文一并截进来。
await sendS('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 1700, deviceScaleFactor: 1, mobile: false,
});
await new Promise(r => setTimeout(r, 800));

const shot = await sendS('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
if (shot && shot.data) {
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图已存：', OUT);
} else {
  console.log('截图失败：', JSON.stringify(shot).slice(0, 200));
}

process.exit(0);
