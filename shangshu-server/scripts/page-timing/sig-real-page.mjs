/*
 SIG 真页面实测 —— jsdom 测具绿不等于页面上真能用。
 判据：测试通过 = 在正式页面上
   ① 邮箱页头有「签名」入口，点开是弹窗、编辑区带工具栏、**没有「预览」框**
   ② 改签名并保存，提示保存成功
   ③ 点「写邮件」，正文末尾**真的出现**刚才那个签名
 只走无界面 Chrome（CDP），不拉起本机图形应用。口令从 0600 文件读，不打印。
*/
import fs from 'node:fs';
import {browserWsUrl, connect, openPage, evalIn} from './cdp.mjs';

const ACCOUNT_FILE = '/path/to/workspace';
const BASE = 'http://127.0.0.1:3830';
const MARK = 'SIG真页实测签名校验';

function readPassword() {
  const m = fs.readFileSync(ACCOUNT_FILE, 'utf8').match(/密码[：:]\s*(\S+)/);
  if (!m) throw new Error('账号文件里没读到密码行');
  return m[1];
}
const PASS = [], FAIL = [];
const need = (code, label, ok, detail = '') => {
  (ok ? PASS : FAIL).push(code);
  console.log(`  ${ok ? '✔' : '✖'} ${code} ${label}${!ok && detail ? '  ← ' + detail : ''}`);
};

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

const r = await evalIn(sendS, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const entry = document.querySelector('#sig-btn');
  out.hasEntry = !!entry;
  out.entryText = entry ? (entry.textContent || '').trim() : '';
  if (!entry) return out;
  entry.click();
  await sleep(400);
  const dlg = document.querySelector('dialog.os-dialog, .os-dialog');
  out.hasDialog = !!dlg;
  if (!dlg) return out;
  out.dialogText = (dlg.textContent || '').trim().slice(0, 80);
  out.hasToolbar = !!dlg.querySelector('.mail-editor-toolbar');
  out.hasPreviewBox = !!dlg.querySelector('.sig-preview') || /实时预览/.test(dlg.textContent || '');
  const editable = dlg.querySelector('[contenteditable]');
  out.hasEditor = !!editable;

  // 改签名并保存
  if (editable) {
    editable.innerHTML = '<p class="mail-signature">—— ' + ${JSON.stringify(MARK)} + '</p>';
    editable.dispatchEvent(new Event('input', {bubbles: true}));
    await sleep(200);
  }
  const toggle = dlg.querySelector('#sig-enabled');
  if (toggle && !toggle.checked) { toggle.checked = true; toggle.dispatchEvent(new Event('change', {bubbles: true})); }
  const save = [...dlg.querySelectorAll('button')].find(b => /保存/.test(b.textContent || ''));
  out.hasSave = !!save;
  if (save) save.click();
  await sleep(800);
  out.toast = (document.querySelector('#toast-zone')?.innerText || '').trim().slice(0, 60);
  out.dialogGone = !document.querySelector('dialog.os-dialog, .os-dialog');

  // 写新信看末尾
  const compose = document.querySelector('#compose');
  if (compose) compose.click();
  await sleep(600);
  const ed = document.querySelector('.mail-body-editor') || document.querySelector('#c-body');
  out.hasComposeEditor = !!ed;
  if (ed) {
    const html = ed.contentDocument ? ed.contentDocument.body.innerHTML : ed.innerHTML;
    out.bodyHasSig = html.includes(${JSON.stringify(MARK)});
    out.bodySnippet = (html || '').slice(0, 160);
  }
  return out;
})()`);
console.log('实测详情：', JSON.stringify(r));
need('S1', '邮箱页头有「签名」入口', r.hasEntry, `入口文字=${r.entryText}`);
need('S2', '点开是弹窗，编辑区带工具栏', r.hasDialog && r.hasToolbar,
  `dialog=${r.hasDialog} toolbar=${r.hasToolbar}`);
need('S3', '没有单独的「预览」框', r.hasDialog && !r.hasPreviewBox,
  `hasPreviewBox=${r.hasPreviewBox}`);
need('S4', '保存成功（弹窗关掉）', r.dialogGone, `toast=${r.toast}`);
need('S5', '写新信正文末尾真有签名', r.bodyHasSig, `正文=${r.bodySnippet}`);

console.log(`\n通过 ${PASS.length} 条，未过 ${FAIL.length} 条`);
process.exit(FAIL.length ? 1 : 0);
