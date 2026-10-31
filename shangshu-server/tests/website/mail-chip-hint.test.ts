import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
  收件人/抄送「+ 号」的可发现性 —— 2026-10-20 @browser-use 走查发现：
  写信窗里，收件人栏只有一个 28px 的小圆钮「+」，页面上**没有任何一句看得见的话**
  告诉人「要点它才能加收件人」。chip-input 给那颗加号写的 title="添加一个人"
  只有鼠标悬停才冒出来 —— 也就是没人能看见。

  「+ 号在胶囊右边、点 + 在它左边开一个填写位」是用户 2026-10-11 定的交互，**不动**；
  这一批只补**看得见的说明**。

  测试通过 = 下面全部成立：
  1. 收件人栏里有一句**看得见的**文字说明怎么加人（不是 title、不是 placeholder ——
     那两种鼠标不动就看不见），文字里点得出那颗「+」；
  2. 栏里**还没有人**时这句说明是显示的；加进人之后它**收起来**（不跟胶囊挤一行）；
  3. 抄送栏有**自己那一条**说明（不是拿收件人那条凑数）；
  4. 说明只是说明，**不改变**既有交互：点「+」在它左边开一个填写位、回车收成一枚胶囊、
     点 × 删掉。

  说明文字的措辞不钉死 —— 钉的是「看得见、说得清、添了人会让位」。
*/

const tick = () => new Promise(r => setTimeout(r, 20));

function mount(rows: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  w.currentRole = () => 'admin';
  const saved: any[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我',
      }}})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      saved.push(body?.payload || {});
      return {ok: true, status: 200,
        json: async () => ({result: {name: 'm-1', record_version: 1, attachments: [], attachment_bindings: {}}}),
        text: async () => '{}'};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('/services/mail.detail/')) {
      const found = rows.find(r => r.name === body?.payload?.mail) || rows[0] || {};
      const payload = {mail: found};
      return {ok: true, status: 200, json: async () => ({result: payload}), text: async () => JSON.stringify({result: payload})};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {
    w, saved,
    dispose: () => { dispose(); dom.window.close(); },
    doc: () => w.document,
  };
}

async function openCompose(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  const compose = t.doc().querySelector('#compose') as any;
  assert.ok(compose, '找不到写邮件按钮');
  compose.click();
  await tick(); await tick();
}

/* 写信窗里「收件人」「抄送」那两个字段（.dlg-field）。 */
function fieldByLabel(t: ReturnType<typeof mount>, label: string): any {
  const fields = [...t.doc().querySelectorAll('.dlg-field')];
  const hit = fields.find((f: any) => {
    const span = f.querySelector(':scope > span');
    return span && (span.textContent || '').trim() === label;
  });
  assert.ok(hit, `写信窗里找不到「${label}」那一栏`);
  return hit;
}

/* 那一栏里**看得见的**说明文字。
   FIX-24（2026-10-20）之后口径变过一次：这一栏**整栏都能点**开填写位了
   （原先只有那颗 28px 小「+」算入口，栏里 600 多 px 空白点不动），
   所以说明从「点「+」加收件人」改成「点一下加收件人」—— 指的是**这一栏**，
   不再单指那颗加号。
   这里按**标记**找说明（[data-chip-hint]），不再靠「文字里有没有 +」来猜：
   那是旧契约下的特征，按文字猜会把「说明还在但措辞变了」误判成「说明没了」。 */
function visibleHint(field: any): any {
  const hint = field.querySelector('[data-chip-hint]');
  if (!hint) return null;
  if (hint.hasAttribute('hidden')) return null;
  const style = hint.ownerDocument.defaultView?.getComputedStyle?.(hint);
  if (style && style.display === 'none') return null;
  return hint;
}

function hiddenNow(el: any): boolean {
  if (!el) return true;
  if (el.hasAttribute('hidden')) return true;
  if ((el.textContent || '').trim() === '') return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle?.(el);
  return !!style && style.display === 'none';
}

/* 加一个人 —— 走用户实测定的交互：点「+」→ 填一个 → 回车。 */
async function addPerson(t: ReturnType<typeof mount>, host: any, value: string) {
  const add = host.querySelector('[data-chip-add]') as any;
  assert.ok(add, '胶囊栏缺「+」按钮');
  add.click();
  await tick();
  const field = host.querySelector('[data-chip-field]') as any;
  assert.ok(field, '点「+」没开出填写位');
  field.value = value;
  field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  await tick();
}

it('收件人栏里有一句看得见的说明，告诉人这一栏能加人', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const field = fieldByLabel(t, '收件人');
    const hint = visibleHint(field);
    assert.ok(hint, '收件人栏里一句看得见的加人说明都没有（只有那颗鼠标不悬停就看不见的小「+」）');
    const txt = (hint.textContent || '').trim();
    assert.ok(txt.length >= 6, `说明太短，等于没说明：${JSON.stringify(txt)}`);
    assert.match(txt, /加/, `说明没说要干什么：${JSON.stringify(txt)}`);
    assert.ok(!hiddenNow(hint), '说明在没人时却藏着，用户还是不知道这一栏能加人');
  } finally { t.dispose(); }
});

it('说明让位：加了人之后收起来，删掉人又回来', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const field = fieldByLabel(t, '收件人');
    const hint = visibleHint(field);
    assert.ok(hint, '前置：收件人栏没有说明');
    assert.ok(!hiddenNow(hint), '前置：没人时说明该显示');

    const host = field.querySelector('#c-to-chips') as any;
    await addPerson(t, host, '张三 <a@qq.com>');
    assert.equal(host.querySelectorAll('[data-chip]').length, 1, '前置：应有一枚胶囊');
    assert.ok(hiddenNow(hint), '加了人之后说明还杵在栏里，跟胶囊挤一行');

    (host.querySelector('[data-chip-remove]') as any).click();
    await tick();
    assert.equal(host.querySelectorAll('[data-chip]').length, 0, '前置：胶囊没删掉');
    assert.ok(!hiddenNow(hint), '人删光了，说明该回来');
  } finally { t.dispose(); }
});

it('抄送栏有自己那一条说明（不是拿收件人那条凑数）', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const toHint = visibleHint(fieldByLabel(t, '收件人'));
    const ccHint = visibleHint(fieldByLabel(t, '抄送'));
    assert.ok(ccHint, '抄送栏一句看得见的说明都没有');
    assert.match((ccHint.textContent || ''), /加/, '抄送栏的说明里没说要干什么');
    assert.notEqual((ccHint.textContent || '').trim(), (toHint.textContent || '').trim(),
      '抄送栏跟收件人栏共用同一句说明，看不出这一栏是干什么的');
  } finally { t.dispose(); }
});

it('说明只是说明：点「+」开填写位、回车成胶囊、点 × 删掉，都照旧', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const field = fieldByLabel(t, '收件人');
    const host = field.querySelector('#c-to-chips') as any;
    const add = host.querySelector('[data-chip-add]') as any;
    assert.ok(add, '胶囊栏缺「+」按钮');
    add.click();
    await tick();
    const slot = host.querySelector('[data-chip-field]') as any;
    assert.ok(slot, '点「+」没在它左边开填写位');
    slot.value = '甲 <a@qq.com>';
    slot.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    const chips = [...host.querySelectorAll('[data-chip]')];
    assert.equal(chips.length, 1, '回车后没收成一枚胶囊');
    assert.match(chips[0].textContent || '', /甲/, '胶囊上没显示人');
    (chips[0].querySelector('[data-chip-remove]') as any).click();
    await tick();
    assert.equal(host.querySelectorAll('[data-chip]').length, 0, '点 × 没删掉');
  } finally { t.dispose(); }
});
