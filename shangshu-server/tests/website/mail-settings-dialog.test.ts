import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/* 邮箱设置「从整页改成弹窗」。

   这组判据要成立 =：
   · 邮箱设置**住在公共弹窗**（`<dialog class="os-dialog">`）里，不是**一整页**；
   · 弹窗里字段与「测试连接并保存」**原样保留**（一个字没改）；
   · 弹窗**可关闭**，关掉之后**背景仍是邮件列表**（不把人困在空页上）；
   · **没绑邮箱**时进邮件中心**自动弹**；**已绑**时**不弹**。 */

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(handler: (id: string, payload: any) => any, options: { url?: string; withMail?: boolean; openDialog?: boolean } = {}) {
  const dom = new JSDOM('<div id="host" class="main-scroll"></div>', { url: options.url || 'http://localhost/#/mail-settings', runScripts: 'outside-only' });
  const w = dom.window as any;
  w.RENDER = {};
  w.shangshuRegisterPages = () => ({ ok: true });
  w.mountResourceAttribution = (await import('../../../shangshu-web/js/resource-attribution.mjs')).mountResourceAttribution;
  w.fetch = async (url: string, options: any) => {
    const data = await handler(url, JSON.parse(options.body).payload);
    return { ok: !data.error, status: data.error ? 400 : 200, json: async () => data };
  };
  installToast(w);
  if (options.withMail) {
    /* 邮件中心（背景）：只画一个列表壳，判据看它还在不在。 */
    w.mountMailCenter = (host: any) => {
      host.innerHTML = '<section class="mail-list-pane" id="mail-rows"></section>';
      return () => { host.innerHTML = ''; };
    };
  }
  for (const file of ['tool-workspace.js', 'domains/mail/mail-settings.js']) {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/' + file, import.meta.url), 'utf8'));
  }
  const dispose = options.openDialog === false
    ? () => { dom.window.close(); }
    : await w.mountMailSettings(w.document.querySelector('#host'));
  return { w, dispose: () => { dispose(); dom.window.close(); } };
}

const dialogOf = (w: any) => w.document.querySelector('dialog.os-dialog');

it('邮箱设置是弹窗不是整页：字段与「测试连接并保存」原样留在弹窗里', async () => {
  const t = await mount(() => ({ result: { account: { bound: false } } }), { withMail: true });
  try {
    await tick();
    const dialog = dialogOf(t.w);
    assert.ok(dialog, '邮箱设置没住在公共弹窗（dialog.os-dialog）里');
    assert.ok(dialog.querySelector('#mail-account-email'), '弹窗里没有「邮箱地址」');
    assert.ok(dialog.querySelector('#mail-account-provider'), '弹窗里没有「邮箱服务商」');
    assert.ok(dialog.querySelector('#mail-account-name'), '弹窗里没有「发件人姓名」');
    assert.ok(dialog.querySelector('#mail-account-password'), '弹窗里没有「邮箱授权码」');
    assert.ok(dialog.querySelector('#mail-account-kind'), '弹窗里没有「归属」');
    const save = dialog.querySelector('#mail-account-save');
    assert.ok(save, '弹窗里没有「测试连接并保存」那个按钮');
    assert.equal(save.textContent, '测试连接并保存', '主操作文案被改了');
    /* 整页的老样子：一页一个 h1「邮箱设置」—— 现在不该再有。 */
    assert.equal(t.w.document.querySelector('#host h1'), null, '邮箱设置还在以整页的样式占着页面');
  } finally { t.dispose(); }
});

it('弹窗可关闭：关掉之后背景还是邮件列表，人没被留在空页上', async () => {
  const t = await mount(() => ({ result: { account: { bound: false } } }), { withMail: true });
  try {
    await tick();
    assert.ok(dialogOf(t.w), '没弹出来');
    const back = dialogOf(t.w).querySelector('#mail-account-back');
    assert.ok(back, '弹窗里没有关闭出口');
    back.click();
    await tick();
    assert.equal(dialogOf(t.w), null, '点了关闭，弹窗还在');
    assert.ok(t.w.document.querySelector('#mail-rows'), '关掉弹窗后背景的邮件列表没了 —— 人被留在空页上');
  } finally { t.dispose(); }
});

it('没绑邮箱时进邮件中心自动弹绑定窗；已绑则不弹', async () => {
  /* 没绑：进邮件中心 ⇒ 弹。 */
  const unbound = await mount(() => ({ result: { account: { bound: false } } }), { url: 'http://localhost/#/dash', withMail: true, openDialog: false });
  try {
    await tick();
    assert.equal(dialogOf(unbound.w), null, '还没进邮件中心就先弹了');
    unbound.w.location.hash = '#/mail';
    await tick(30);
    assert.ok(dialogOf(unbound.w), '进了邮件中心、没绑邮箱，却没自动弹绑定窗');
  } finally { unbound.dispose(); }

  /* 已绑：进邮件中心 ⇒ 不弹。 */
  const bound = await mount(() => ({ result: { account: { bound: true, email: 'demo@qq.com', enabled: true } } }), { url: 'http://localhost/#/dash', withMail: true, openDialog: false });
  try {
    await tick();
    bound.w.location.hash = '#/mail';
    await tick(30);
    assert.equal(dialogOf(bound.w), null, '已经绑了邮箱还弹绑定窗');
  } finally { bound.dispose(); }
});
