import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, lastToast, toastText} from '../helpers/toast.ts';

/* 邮箱建设页：交互样例内完成列表/阅读/撰写/草稿/回收，不访问业务接口、不假发送成功。 */
function mount() {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.fetch = () => { throw new Error('建设页不得访问业务接口'); };
  w.RENDER = {}; w.currentRole = () => 'admin';
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  w.eval(readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8'));
  const controller = new w.AbortController();
  w.__mailPreviewSignal = controller.signal;
  w.RENDER['mail']({host: w.document.querySelector('#host'), signal: controller.signal});
  return {dom, w, controller};
}

function selectBox(w: any, box: string) {
  const select=w.document.querySelector('#mail-box'); select.value=box; select.dispatchEvent(new w.Event('change'));
}
function enableExamples(w: any) {
  w.dispatchEvent(new w.Event('pagehide'));
  w.mountMailCenter(w.document.querySelector('#host'),{signal:w.__mailPreviewSignal,examples:true});
  selectBox(w, 'inbox');
}

/* 写信窗已经没有「存草稿」按钮（用户 2026-10-11：「存草稿不要用一个显性的按钮，只要失焦就保存」）。
   保存只剩两个入口：**失焦**自动存（120ms 防抖）、Ctrl/⌘S 手存。
   triggerSave 只派发 blur、不派发 focusout —— focusout 会顺带触发「单字段失焦保存」，多发一个请求。 */
async function triggerSave(w: any) {
  const ed = w.document.querySelector('.mail-body-editor') || w.document.querySelector('#c-body');
  if (ed) { ed.blur?.(); ed.dispatchEvent(new w.FocusEvent('blur', {bubbles: true})); }
  await new Promise(r => setTimeout(r, 320)); // 比 120ms 防抖长
}
/* 手存：写信窗里输入没动过（没置脏）时失焦不会自动存，只有 Ctrl/⌘S 这个入口会存。 */
function pressSave(w: any) {
  const event = new w.KeyboardEvent('keydown', {key: 's', metaKey: true, bubbles: true, cancelable: true});
  w.document.querySelector('#detail').dispatchEvent(event);
  return event;
}
/* 关闭确认从「按钮原地换字」改成了弹窗（用户 2026-10-11：「这个能不能用一个弹窗？你这个还没有做」）。 */
function visibleDialogs(w: any) {
  return [...w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')]
    .filter((d: any) => d.isConnected && !d.hidden);
}
function discardViaDialog(w: any) {
  const dialogs = visibleDialogs(w);
  assert.equal(dialogs.length, 1, `点关闭应弹出 1 个确认弹窗，实际 ${dialogs.length} 个`);
  const text = dialogs.map((d: any) => d.textContent || '').join(' ');
  assert.ok(/继续编辑/.test(text), `弹窗里没有「继续编辑」出口：${text.slice(0, 120)}`);
  assert.ok(/放弃修改并关闭/.test(text), `弹窗里没有「放弃修改并关闭」出口：${text.slice(0, 120)}`);
  /* 公共弹窗组件（ui.dialog）的按钮是 footer 里带 data-act 的 <button>，
     不再是旧的 [data-discard]。按文字认出口，顺带钉住「两个出口是两个按钮」。 */
  const buttons = [...dialogs[0].querySelectorAll('footer button, button')];
  const discard = buttons.find((b: any) => /放弃修改并关闭/.test(b.textContent || ''));
  assert.ok(discard, `弹窗里找不到「放弃修改并关闭」按钮：${dialogs[0].innerHTML.slice(0, 200)}`);
  discard.click();
}

it('邮件未保存正文阻止全局离页，明确关闭放弃后解除',()=>{
  const {dom,w,controller}=mount();
  try{
    enableExamples(w);w.document.querySelector('#compose').click();
    const input=w.document.querySelector('#c-body');input.value='保留这份未保存正文';input.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.equal(w.dispatchEvent(new w.Event('shangshu:before-page-change',{cancelable:true})),false);
    assert.equal(input.value,'保留这份未保存正文');
    // 有未保存修改 → 点「关闭」先弹确认弹窗（不是按钮原地换字），窗口还没关
    w.document.querySelector('#c-cancel').click();
    assert.ok(w.document.querySelector('#c-subject'),'还没确认，窗口不能关');
    discardViaDialog(w);
    assert.equal(w.document.querySelector('#c-subject'),null,'点了「放弃修改并关闭」才关');
    assert.equal(w.document.querySelectorAll('.mail-overlay').length,0,'确认弹窗点掉后必须消失');
    assert.equal(w.dispatchEvent(new w.Event('shangshu:before-page-change',{cancelable:true})),true);
  }finally{controller.abort();dom.window.close();}
});

it('默认空态禁用写邮件；样例开启后可筛选收件箱与未读邮件', () => {
  const {dom, w, controller} = mount();
  try {
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 0);
    assert.equal(w.document.querySelector('#compose').disabled, true);
    assert.equal(w.document.querySelector('#accounts-btn').disabled, false, '邮箱设置始终可进入，断开时也能自行连接');
    enableExamples(w);
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 7);
    assert.match(w.document.querySelector('#result-count').textContent, /未读 4/);
    assert.equal(w.document.querySelectorAll('.is-unread').length, 4);
  } finally { controller.abort(); dom.window.close(); }
});

it('打开未读邮件转为已读并减计数；标为未读可恢复', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    const first = w.document.querySelector('[data-open]');
    first.click();
    assert.equal(w.document.querySelector('#detail').hidden, false);
    assert.match(w.document.querySelector('#detail').textContent, /审查意见答复/);
    assert.equal(w.document.querySelectorAll('.is-unread').length, 3);
    w.document.querySelector('#toggle-unread').click();
    assert.equal(w.document.querySelector('.mail-has-selection'), null);
    assert.equal(w.document.querySelectorAll('.is-unread').length, 4);
  } finally { controller.abort(); dom.window.close(); }
});

it('回复仅原发件人；转发默认不带附件、原信附件走「显式加入并固定版本」', () => {
  /* 需求变更（计划 §6 C2 判据 E）：转发**不再自动全带附件**。
     旧断言钉的是「转发预填附件、再手动移除」，那是被淘汰的旧行为 —— 改写，不是削弱：
       改之前（旧行为）：点转发 → 附件栏里已经有一条账单.xlsx，要手动点「移除」才不带
       改之后（C2 要求）：点转发 → 附件栏**空**，原信附件列在「原信附件（可选）」里，
                         点「加入」才进附件栏，且带「已固定版本」（不会被后来的改动混进这封）
     怎么看：读信窗点转发 → 写信窗附件栏空；下方「原信附件（可选…）」列着原信的账单.xlsx，
             点「加入」→ 进附件栏且标「已固定版本」；点「移除」→ 回到空。 */
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('[data-open]').click();
    w.document.querySelector('#reply').click();
    assert.match(w.document.querySelector('#c-to').value, /zhang@acme\.example\.com/);
    assert.match(w.document.querySelector('#c-subject').value, /^Re: /);
    assert.match(w.document.querySelector('#c-body').value, /原始邮件/);
    assert.equal(w.document.querySelectorAll('#c-attachments [data-remove]').length, 0);
    w.document.querySelector('#c-cancel').click();
    w.document.querySelector('[data-open]').click();
    w.document.querySelector('#forward').click();
    assert.equal(w.document.querySelector('#c-to').value, '');
    assert.match(w.document.querySelector('#c-subject').value, /^Fwd: /);

    /* 判据 E 前半：**不默认全带** —— 附件栏一条都不该有 */
    assert.equal(w.document.querySelectorAll('#c-attachments [data-remove]').length, 0,
        '转发把原信附件自动全带上了（旧需求），C2 要求显式选择');
    /* 原信附件得列成可选，让用户挑。
       它画在 `#c-att-optional`（与已选附件分开）—— 因为真实产品里
       `#c-attachments` 由附件选择器接管，挤在一起会被刷掉。 */
    const zone = w.document.querySelector('#c-att-optional');
    assert.match(zone.textContent, /原信附件（可选/,
        `没把原信附件列成可选（用户没得挑）：${(zone.textContent || '').slice(0, 120)}`);
    const pick = zone.querySelector('[data-pick-att]');
    assert.ok(pick, '可选附件里没有「加入」入口');

    /* 判据 E 后半：点了才加，加进去的是**固定版本** */
    pick.click();
    const row = w.document.querySelector('#c-attachments .att-row [data-remove]');
    assert.ok(row, '点「加入」后附件没进附件栏');
    assert.match(w.document.querySelector('#c-attachments').textContent, /已固定版本/,
        '加入的附件没标「已固定版本」');
    assert.equal(zone.querySelectorAll('[data-pick-att]').length, 0,
        '加入后可选区没把它清掉（还能再加一次）');

    row.click();
    assert.equal(w.document.querySelectorAll('#c-attachments [data-remove]').length, 0, '移除不掉');
  } finally { controller.abort(); dom.window.close(); }
});

it('收件人分号解析：多地址成条，非法地址阻止保存并保留输入', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#compose').click();
    const to = w.document.querySelector('#c-to');
    to.value = '张三 <a@example.com>；李四 <b@example.com>；c@example.com';
    w.document.querySelector('#c-subject').value = '分号多收件人';
    pressSave(w);
    const search = w.document.querySelector('#search');
    search.value = '分号多收件人';
    search.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 1);
    w.document.querySelector('[data-open]').click();
    const reopen = w.document.querySelector('#c-to');
    assert.match(reopen.value, /张三 <a@example\.com>/);
    assert.match(reopen.value, /c@example\.com/);
    reopen.value = '张三 <a@example.com>；不是邮箱';
    pressSave(w);
    /* 收件人报错走**右下角 toast 公共件**（用户 2026-10-12：「收件人报错也放进公共提示组件里面去」，
       所谓公共组件就是产品本来就有的 #toast-zone toast），不再是收件人栏自己一套红字。
       而且比原来更强：原来只验「说了无法识别」，现在还要验**说清是哪个地址**认不出来，
       并且是错误色（toast-error）+ role="alert"，不是绿色成功色。 */
    const toast = lastToast(w) as any;
    assert.ok(toast, '认不出的地址没报出来（toast 公共件不在）');
    assert.ok(toast.classList.contains('toast-error'),
        `收件人报错没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.match(toast.textContent || '', /无法识别的地址/);
    assert.match(toast.textContent || '', /不是邮箱/, `没说清是哪个地址认不出来：${toast.textContent}`);
    assert.equal(w.document.querySelector('#notice'), null, '页面里又贴回了 #notice');
    // 收件人栏不许再自己渲染一套红字
    for (const id of ['#e-to', '#e-cc']) {
      const el = w.document.querySelector(id);
      const shown = el && !el.hidden && (el.textContent || '').trim();
      assert.ok(!shown, `收件人栏还在自己渲染红字 ${id}：${JSON.stringify(shown)}`);
    }
    assert.equal(w.document.querySelector('#c-to').value, '张三 <a@example.com>；不是邮箱');
    search.value = '不是邮箱';
    search.dispatchEvent(new w.Event('input'));
    assert.doesNotMatch(w.document.querySelector('#mail-rows').textContent, /不是邮箱/);
  } finally { controller.abort(); dom.window.close(); }
});

it('从文件库选附件带版本；移除草稿附件不影响文件库选项', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#compose').click();
    w.document.querySelector('#pick-lib').click();
    // ⚠️ 口径 2026-10-20 变更（FIX-46）：**表格没有版本**（后端 `upload()` 钉着
    // 「表格资源同名上传恒为新表」—— 表格是**多张表**，不是一张表的多个版本）。
    // 所以这里验「选版本」这个能力要验在**普通文件**上（L5 审查流程说明.pdf，带历史版本），
    // 那个 xlsx 现在只列当前这一条。
    const radios = w.document.querySelectorAll('input[data-lib="L5"]');
    assert.equal(radios.length, 2, '普通文件应当有「当前版本 + 历史版本」两项可选');
    // 表格**不列版本**（FIX-46）—— 只该有当前这一条
    assert.equal(w.document.querySelectorAll('input[data-lib="L2"]').length, 1,
      '表格不该列版本 —— 同名上传恒为新表，表格是「多张表」不是「多版本」');
    radios[1].click();
    w.document.querySelector('#pick-ok').click();
    assert.equal(w.document.querySelectorAll('#c-attachments .att-row').length, 1);
    assert.match(w.document.querySelector('#c-attachments').textContent, /审查流程说明/);
    assert.match(w.document.querySelector('#c-attachments').textContent, /v1/);
    w.document.querySelector('#pick-lib').click();
    assert.equal(w.document.querySelectorAll('.pick-file').length, 5, '文件库样例不因移除而减少');
    w.document.querySelector('#dlg-close2').click();
    w.document.querySelector('[data-remove="0"]').click();
    assert.match(w.document.querySelector('#c-attachments').textContent, /未添加附件/);
  } finally { controller.abort(); dom.window.close(); }
});

it('发送必须过确认清单；附件缺项需明确接受；未接后端不产生已发送记录', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    selectBox(w, 'draft');
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 2);
    w.document.querySelector('[data-open]').click();
    assert.ok(w.document.querySelector('#subject-candidate'), '模板草稿应带主题候选');
    w.document.querySelector('#use-subject').click();
    assert.match(w.document.querySelector('#c-subject').value, /第2次/);
    w.document.querySelector('#c-send').click();
    assert.match(w.document.querySelector('.mail-overlay').textContent, /模板要求 2 个附件，当前 1 个/);
    assert.equal(w.document.querySelector('#send-ok').disabled, true);
    w.document.querySelector('#accept-missing').click();
    assert.equal(w.document.querySelector('#send-ok').disabled, false);
    w.document.querySelector('#send-ok').click();
    assert.match(toastText(w), /未接后端/);
    selectBox(w, 'sent');
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 2, '不得假造已发送记录');
    selectBox(w, 'draft');
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 2, '确认发送后草稿保留');
  } finally { controller.abort(); dom.window.close(); }
});

it('删除是两步确认并提示不撤回对方；回收站可恢复原位置', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('[data-open]').click();
    const trash = w.document.querySelector('#trash-mail');
    trash.click();
    assert.match(trash.textContent, /不会撤回对方邮件/);
    assert.equal(w.document.querySelector('#detail').hidden, false, '首次点击不删除');
    trash.click();
    assert.equal(w.document.querySelector('.mail-has-selection'), null);
    selectBox(w, 'trash');
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 1);
    w.document.querySelector('[data-open]').click();
    w.document.querySelector('#restore-mail').click();
    selectBox(w, 'inbox');
    // 收件箱现有 7 封（含本轮新增的「年费核对表」—— 用户反馈 5.1「没有这个邮件」补的）
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 7);
  } finally { controller.abort(); dom.window.close(); }
});

it('邮箱设置：凭据只显示掩码，新凭据遮蔽输入且保存后不可见', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#accounts-btn').click();
    assert.equal(w.document.querySelectorAll('#acc-rows tr').length, 2);
    assert.match(w.document.querySelector('#acc-rows').textContent, /不可查看/);
    assert.equal(w.document.querySelector('#acc-secret').type, 'password');
    w.document.querySelector('#acc-addr').value = 'bad-addr';
    w.document.querySelector('#acc-add').click();
    /* 邮箱设置的报错也走 toast 公共件（用户 2026-10-12：.dlg-error 红字删掉）。
       比原来只验「#acc-error 显示出来」更强：还钉住文案 + 错误色 + alert 语义。 */
    const badToast = lastToast(w) as any;
    assert.ok(badToast, '邮箱地址格式报错没走右下角 toast 公共件');
    assert.match(badToast.textContent || '', /邮箱地址格式不正确/,
        `报错没说清是邮箱地址问题：${JSON.stringify(badToast.textContent)}`);
    assert.ok(badToast.classList.contains('toast-error'),
        `邮箱地址报错没走错误色（红），现在是：${badToast.className}`);
    assert.equal(badToast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.equal(w.document.querySelector('#acc-error'), null, '页面里又贴回了 #acc-error 红字');
    assert.equal(w.document.querySelector('#notice'), null, '页面里又贴回了 #notice');
    w.document.querySelector('#acc-addr').value = 'new.user@company.example.com';
    w.document.querySelector('#acc-secret').value = 'super-secret-123';
    w.document.querySelector('#acc-add').click();
    assert.equal(w.document.querySelectorAll('#acc-rows tr').length, 3);
    assert.doesNotMatch(w.document.querySelector('.mail-dialog').textContent, /super-secret-123/);
  } finally { controller.abort(); dom.window.close(); }
});

it('投递状态视图：已发送区分接受/部分接受，失败待处理给出重发策略文案', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    selectBox(w, 'sent');
    const text = w.document.querySelector('#mail-rows').textContent;
    assert.match(text, /服务商已接受/);
    assert.match(text, /部分接受/);
    selectBox(w, 'failed');
    assert.equal(w.document.querySelectorAll('[data-mail]').length, 2);
    assert.match(w.document.querySelector('#result-count').textContent, /2 封/);
    w.document.querySelector('[data-open]').click();
    assert.match(w.document.querySelector('#detail').textContent, /退信/);
    assert.match(w.document.querySelector('.resend-note').textContent, /可以按同一份内容重试/);
    const unknown = w.document.querySelectorAll('[data-mail]')[1];
    unknown.click();
    assert.match(w.document.querySelector('.resend-note').textContent, /结果未知：请先查投递状态/);
  } finally { controller.abort(); dom.window.close(); }
});

it('发送前核对渲染正文实际内容，并明示未保存时先保存再发送', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#compose').click();
    const to = w.document.querySelector('#c-to');
    to.value = 'zhang@acme.example.com';
    to.dispatchEvent(new w.Event('input'));
    w.document.querySelector('#c-subject').value = '正文渲染核对';
    w.document.querySelector('#c-subject').dispatchEvent(new w.Event('input'));
    w.document.querySelector('#c-body').value = '这是将要发出的正文内容。';
    w.document.querySelector('#c-body').dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelector('#dirty-note').hidden, false);
    w.document.querySelector('#c-send').click();
    const overlays = w.document.querySelectorAll('.mail-overlay');
    assert.equal(overlays.length, 1, '仅核对弹层，右侧撰写面保留');
    const confirm = overlays[overlays.length - 1];
    assert.match(confirm.textContent, /发送前核对/);
    assert.match(confirm.querySelector('.send-body-view').textContent, /这是将要发出的正文内容。/);
    assert.match(confirm.textContent, /当前有未保存修改：确认发送会先保存这份内容/);
  } finally { controller.abort(); dom.window.close(); }
});

it('撰写有未保存修改时关闭需二次确认，保存后直接关闭', async () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#compose').click();
    const subject = w.document.querySelector('#c-subject');
    subject.value = '关闭守卫';
    subject.dispatchEvent(new w.Event('input'));
    const cancel = w.document.querySelector('#c-cancel');
    cancel.click();
    assert.ok(w.document.querySelector('#c-subject'), '首次点击不关闭');
    /* 旧交互是「按钮原地换字」（点一下变成「确认关闭？未保存修改将丢弃」）；
       用户 2026-10-11 要的是弹窗。所以：按钮文字没被动过，弹窗里两个出口都在。 */
    assert.equal(cancel.textContent.trim(), '关闭', `关闭按钮被原地换字了：${JSON.stringify(cancel.textContent)}`);
    discardViaDialog(w);
    assert.equal(w.document.querySelectorAll('.mail-overlay').length, 0);
    assert.equal(w.document.querySelector('#c-subject'), null);
    // 保存后关闭不需要确认（写信窗没有「存草稿」按钮了，失焦就自动存）
    w.document.querySelector('#compose').click();
    const s2 = w.document.querySelector('#c-subject');
    s2.value = '保存后关闭';
    s2.dispatchEvent(new w.Event('input'));
    w.document.querySelector('#c-to').value = 'a@example.com';
    await triggerSave(w);
    assert.equal(w.document.querySelectorAll('.mail-overlay').length, 0);
    assert.equal(w.document.querySelector('#c-subject'), null);
    w.document.querySelector('[data-open]').click();
    assert.equal(w.document.querySelector('#dirty-note').hidden, true);
    w.document.querySelector('#c-cancel').click();
    assert.equal(w.document.querySelectorAll('.mail-overlay').length, 0, '无修改时一键关闭');
  } finally { controller.abort(); dom.window.close(); }
});

it('主题与搜索内容按纯文本渲染，不注入脚本', () => {
  const {dom, w, controller} = mount();
  try {
    enableExamples(w);
    const search = w.document.querySelector('#search');
    search.value = '<script>alert(1)</script>';
    search.dispatchEvent(new w.Event('input'));
    assert.match(w.document.querySelector('#mail-rows').textContent, /没有匹配的邮件/);
    assert.equal(w.document.querySelectorAll('#mail-rows script').length, 0);
    w.document.querySelector('#compose').click();
    const subject = w.document.querySelector('#c-subject');
    subject.value = '<img src=x onerror=alert(1)>';
    pressSave(w);
    assert.equal(w.document.querySelectorAll('#mail-rows img').length, 0);
  } finally { controller.abort(); dom.window.close(); }
});

it('未保存草稿按Esc不能绕过关闭确认，离页清除弹层', () => {
  const {dom,w,controller} = mount();
  try {
    enableExamples(w);
    w.document.querySelector('#compose').click();
    const input=w.document.querySelector('#c-subject');
    input.value='不能丢失';input.dispatchEvent(new w.Event('input'));
    input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(w.document.querySelector('#c-subject'),input);
    assert.equal(input.value,'不能丢失');
    controller.abort();
    assert.equal(w.document.querySelectorAll('.mail-overlay').length,0);
  } finally {controller.abort();dom.window.close();}
});
