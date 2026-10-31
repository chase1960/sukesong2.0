import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 测试通过 = 后端不可用（邮件服务未连接）时，用户仍能找到进入交互样例的入口。

 背景：顶部 `#examples-toggle` 被写成 `hidden = !showExamples`——只在已处于样例模式才显示，
 实为「退出」按钮；列表空态的 `[data-mail-examples]` 又要求 `connected === true`。
 后端没起来时 connected=false，于是两个入口都进不去——死锁。
 用户实测反馈「主要我没有看到查看交互样例」。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

function mount(handler: (url: string, body: any) => any, rows: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('/services/mail.account.status/')) return {ok: true, status: 200, json: async () => ({result: {account: {bound: false}}})};
    if (url.includes('/datasets/')) {
      // 模拟后端没接上：接口吐回网页（HTML）
      return {ok: true, status: 200, text: async () => '<!DOCTYPE html><html><body>首页</body></html>'};
    }
    const body = options.body ? JSON.parse(options.body) : null;
    const result = handler(url, body);
    return {ok: !result.error, status: result.status || (!result.error ? 200 : 400), json: async () => result, text: async () => JSON.stringify(result)};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, dispose: () => { dispose(); dom.window.close(); }};
}

it('后端未连接时空态提供进入交互样例的入口，且能进去', async () => {
  const t = mount(() => ({rows: [], total: 0}));
  try {
    await tick(); await tick();
    const entry = t.w.document.querySelector('[data-mail-examples]');
    assert.ok(entry, '后端未连接时找不到进入交互样例的入口（用户反馈：看不见「查看交互样例」）');
    entry.click();
    await tick(); await tick();
    // 进去了：列表应有样例邮件，写邮件按钮可用
    const mails = t.w.document.querySelectorAll('[data-mail]').length;
    assert.ok(mails > 0, '点击后没进入样例模式');
    const compose = t.w.document.querySelector('#compose');
    assert.ok(compose && !compose.disabled, '样例模式下写邮件仍不可用');
    // 进样例不该弹提示（旧的 #notice 劣等品已删，这里钉「不复活」）
    assert.equal(t.w.document.querySelector('#notice'), null, '页面里又贴回了 #notice');
    assert.equal(t.w.document.querySelectorAll('#toast-zone .toast').length, 0,
        `进样例不该弹提示，却弹了：${t.w.document.querySelector('#toast-zone')?.textContent || ''}`);
  } finally { t.dispose(); }
});

/* 用户实测反馈 5.1「没有这个邮件」：样例里一封带表格的都没有，
   于是 MAIL-02 的阅读显示（框线/合并格/金额日期/内嵌图）根本没东西可验。 */
it('样例里必须有一封带表格+合并单元格+内嵌图的邮件，且能点开看到结构', async () => {
  const t = mount(() => ({rows: [], total: 0}));
  try {
    await tick(); await tick();
    const entry = t.w.document.querySelector('[data-mail-examples]');
    assert.ok(entry, '找不到进入交互样例的入口');
    entry.click();
    await tick(); await tick();

    const mails = [...t.w.document.querySelectorAll('[data-mail]')];
    assert.ok(mails.length > 0, '样例列表是空的');

    // 逐封点开，找那封带表格的。注意：HTML 正文渲进**所见即所得的只读面**（父线 2026-10-21），
    // 查那个面里的实际内容 —— 那才是用户看到的。
    let found = false;
    for (const item of mails) {
      item.click();
      await tick(); await tick();
      const surface = t.w.document.querySelector('[data-mail-body-wysiwyg] .mail-body-editor') as any;
      if (!surface) continue;
      const doc = String(surface.innerHTML || '');
      if (!/<table/i.test(doc)) continue;
      assert.match(doc, /border\s*:\s*(?!none|0)[^;"']+/i, '样例表格没有框线');
      assert.ok(/colspan|rowspan/i.test(doc), '样例表格没有合并单元格');
      assert.ok(/cid:/i.test(doc), '样例邮件没有受管内嵌图引用');
      assert.ok(!/https?:\/\/[^"'\s]+\.(?:png|jpe?g|gif)/i.test(doc), '样例带了外链图片（不该外联）');
      found = true;
      break;
    }
    assert.ok(found, '样例列表里找不到带表格的邮件（用户反馈 5.1「没有这个邮件」）');
  } finally { t.dispose(); }
});

it('进入样例模式后出现「退出交互样例」按钮', async () => {
  const t = mount(() => ({rows: [], total: 0}));
  try {
    await tick(); await tick();
    const entry = t.w.document.querySelector('[data-mail-examples]');
    assert.ok(entry);
    entry.click();
    await tick(); await tick();
    const exit = t.w.document.querySelector('#examples-toggle');
    assert.ok(exit, '进入样例后缺少退出按钮');
    assert.match(exit.textContent, /退出交互样例/, '退出按钮文案不对');
    assert.equal(exit.hidden, false, '退出按钮应可见');
  } finally { t.dispose(); }
});
