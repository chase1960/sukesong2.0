/* 个人邮箱设置：复用公共 Action/Service，不把授权码交给 AI 或浏览器存储。 */
/* 「归属」走**公共组件** resource-attribution.mjs（**摊开式**，全站同一件 —— PKG-016 之后
   两张选项卡直接摊开在表单里，不再点「选择」弹第二扇窗）。
   本文件是经典脚本，拿不到 ES module 的导出 —— 优先用宿主注入的全局件，
   否则动态 import（浏览器支持；经典脚本里 import() 是合法的）。 */
const loadAttributionComponent = async () => {
  if (typeof globalThis.mountResourceAttribution === 'function') return globalThis.mountResourceAttribution;
  const mod = await import('../../resource-attribution.mjs');
  return mod.mountResourceAttribution;
};

/* —— 表单本体 ——
   **字段、校验、错误文案一个字没改**；改的只有「住在哪儿」：
   原来住在**一整页**（挡住别的东西、也丑），现在住在**公共弹窗**里
   （`.os-dialog` —— 公共壳的弹窗件，不另造一套）。 */
const MAIL_SETTINGS_FORM = `<form id="mail-account-form" autocomplete="off">
      <label class="dlg-field"><span>邮箱地址</span><input id="mail-account-email" type="email" required maxlength="254" placeholder="你的工作邮箱或个人邮箱" autocomplete="off"></label>
      <label class="dlg-field"><span>邮箱服务商</span><select id="mail-account-provider"><option value="">请选择邮箱服务商</option><option value="qq">QQ 邮箱</option><option value="163">网易 163 邮箱</option><option value="netease-enterprise">网易企业邮箱</option></select></label>
      <label class="dlg-field"><span>发件人姓名（选填）</span><input id="mail-account-name" maxlength="100" autocomplete="off"></label>
      <div class="dlg-field"><span>归属</span><div data-resource-attribution></div></div>
      <div class="dlg-field" id="mail-account-dept-field" hidden><span>所属部门</span><span data-mail-dept-display></span></div>
      <label class="dlg-field"><span>邮箱授权码</span><input id="mail-account-password" type="password" autocomplete="new-password" placeholder="填写邮箱的客户端授权码，不是登录密码"></label>
      <p class="mail-settings-help"><span id="mail-account-provider-help">自定义企业邮箱请手动选择实际服务商。在邮箱网页端开启 IMAP/SMTP，生成客户端授权码后填在这里。</span>凭据加密保存，不向 AI 提供，也不会再次显示。</p>
      <p id="mail-account-result" class="mail-settings-result" role="status" hidden></p>
      <div class="mail-settings-actions">
        <button class="btn btn-ghost" id="mail-account-test" type="button" hidden>测试已保存连接</button>
        <button class="btn btn-ghost" id="mail-account-reset" type="button" hidden>放弃修改</button>
        <button class="btn btn-pri" id="mail-account-save" type="submit" disabled>测试连接并保存</button>
      </div>
    </form>
    <div class="mail-settings-actions mail-settings-lifecycle" id="mail-account-lifecycle" hidden><button class="btn btn-ghost" id="mail-account-toggle" type="button">暂停收发</button><button class="btn btn-ghost" id="mail-account-disconnect" type="button">解除绑定</button></div>
    <p class="mail-settings-help">只管理你自己的邮箱。尚书中的移入回收站不会删除原邮箱里的邮件；暂停或解绑保留尚书已保存的邮件。</p>`;

/** 读本人邮箱连接状态（同一个公共 service，弹窗与自动弹出都走它）。 */
async function readMailAccountStatus() {
  const response = await fetch('/api/platform/services/mail.account.status/invoke', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: {} }),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false || data.error) throw Error(data.error || '邮箱设置暂不可用');
  return data.result || data;
}

/* —— 邮箱设置弹窗 ——
   公共弹窗 `.os-dialog`（原生 dialog + 半透明遮罩）⇒ **背景看得见邮件列表**，
   关掉弹窗就回到邮件列表，不再把人困在一张空页上。 */
let activeMailSettingsDialog = null;

/**
 * 打开邮箱设置弹窗。
 * @param {{signal?:AbortSignal, onClose?:Function}} options
 * @returns {Promise<{close:Function, element:Element}|null>}
 */
window.openMailSettingsDialog = async function (options = {}) {
  if (activeMailSettingsDialog) return activeMailSettingsDialog;
  const { signal, onClose } = options;
  /* 工作面挂在 body 上：原生 dialog 本来就挂在 body（不��工作面的 overflow 裁切），
     `$` 也就找得到弹窗里的字段。 */
  const ui = window.createToolWorkspace(document.body, { signal });
  const { $, notify } = ui;
  const element = ui.dialog({
    title: '邮箱设置',
    body: `<div class="mail-settings-dialog"><p class="mail-settings-summary" id="mail-account-state" role="status">正在读取…</p>${MAIL_SETTINGS_FORM}</div>`,
    actions: [{ label: '返回邮箱', onClick: () => ui.closeModal() }],
    onClose: () => { activeMailSettingsDialog = null; onClose?.(); },
  });
  if (!element) { ui.dispose(); return null; }
  /* 弹窗脚手架给的动作按钮没有 id —— 补上，代码里按 id 找（一个 id 只有一处）。 */
  const backButton = element.querySelector('footer [data-act]');
  if (backButton) backButton.id = 'mail-account-back';
  const handle = { close: () => ui.closeAllModals(), element, ui };
  activeMailSettingsDialog = handle;

  /* 归属：公共件（**摊开式** —— 两张选项卡直接摊开在弹窗里，不再点「选择」弹第二扇窗）。
     **值仍由两个隐藏 input 承载**（#mail-account-kind /
     #mail-account-department）—— 下面的 draw() 回填、syncDeptField()、提交读取、
     controls() 禁用逻辑一个字都不用改。
     邮箱的「所属部门」是**自由文本**（原来就是个可手填的输入框）⇒ 走手填模式，
     不能改成从列表里挑（那是行为变更）。 */
  let attribution = null;
  try {
    const mountResourceAttribution = await loadAttributionComponent();
    attribution = mountResourceAttribution($('[data-resource-attribution]'), { ui, label: '', defaultLevel: 'personal',
      levels: [{ value: 'personal', label: '个人邮箱', hint: '这个邮箱只属于你自己。' }, { value: 'department', label: '部门邮箱（共享）', hint: '这个邮箱归某个部门，部门同事共用。' }],
      departmentLabel: '所属部门', departmentMode: 'text', departmentSource: 'provided',
      departmentPlaceholder: '这个共享邮箱归哪个部门，例如：市场部',
      levelInputId: 'mail-account-kind', departmentInputId: 'mail-account-department' });
  } catch (error) {
    /* 公共件加载不上：表单其余部分照常用，归属那格降级成隐藏 input 兜底，
       提示用户刷新（不静默改语义）。 */
    $('[data-resource-attribution]').innerHTML = '<input type="hidden" id="mail-account-kind" value="personal"><input type="hidden" id="mail-account-department"><p class="attribution-picker-status" role="status">归属选择暂不可用，请刷新后重试</p>';
  }
  let account = { bound: false }, dirty = false, busy = false, loaded = false, pending = null, providerChosen = false;
  const keys = new Map(), uid = () => crypto.randomUUID();
  const fields = ['#mail-account-email', '#mail-account-provider', '#mail-account-name', '#mail-account-password', '#mail-account-kind', '#mail-account-department'];
  function controls() {
    fields.forEach(id => $(id).disabled = busy || !loaded || Boolean(pending));
    attribution?.lock(busy || !loaded || Boolean(pending));
    $('#mail-account-save').disabled = busy || !loaded;
    $('#mail-account-test').disabled = busy || dirty;
    $('#mail-account-toggle').disabled = busy || dirty;
    $('#mail-account-disconnect').disabled = busy || dirty;
    $('#mail-account-reset').hidden = !dirty;
    $('#mail-account-reset').disabled = busy || Boolean(pending);
    $('#mail-account-save').textContent = pending ? '核实上次保存' : busy ? '正在连接…' : '测试连接并保存';
  }
  async function request(id, payload = {}, write = false) {
    let response, data;
    const requestBody = { payload };
    if (write) { const fingerprint = JSON.stringify([id, payload]); if (!keys.has(fingerprint)) keys.set(fingerprint, uid()); Object.assign(requestBody, { confirmed: true, idempotency_key: keys.get(fingerprint) }); }
    try { response = await fetch('/api/platform/' + (write ? 'actions/' : 'services/') + id + (write ? '/execute' : '/invoke'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody), signal: ui.signal }); data = await response.json(); }
    catch (error) { throw Object.assign(Error('连接中断'), { uncertain: true }); }
    if (!response.ok || data.ok === false || data.error) throw Object.assign(Error('邮箱操作未完成'), { uncertain: response.status >= 500 || [408, 429].includes(response.status) });
    return data.result || data;
  }
  function result(text, error = false) { $('#mail-account-result').hidden = false; $('#mail-account-result').textContent = text; $('#mail-account-result').classList.toggle('is-error', error); }
  function providerHelp() {
    const select = $('#mail-account-provider'), provider = select.value;
    $('#mail-account-provider-help').textContent = provider.startsWith('netease-enterprise')
      ? '网易企业邮箱网页端：设置 → 账号与安全 → 客户端设置 → 进入设置，开启 IMAP/SMTP 并生成授权码。机房节点请按企业邮箱管理员提供的配置选择。'
      : `${provider ? '' : '自定义企业邮箱请手动选择实际服务商。'}在${provider ? select.selectedOptions[0].textContent : '邮箱'}网页端开启 IMAP/SMTP，生成客户端授权码后填在这里。`;
  }
  function draw(next) {
    account = next?.account || next || { bound: false };
    if (Array.isArray(next?.providers)) $('#mail-account-provider').innerHTML = '<option value="">请选择邮箱服务商</option>' + next.providers.filter(p => typeof p?.id === 'string' && typeof p.label === 'string').map(p => `<option value="${ui.escape(p.id)}">${ui.escape(p.label)}</option>`).join('');
    $('#mail-account-email').value = account.email || ''; $('#mail-account-provider').value = account.provider || ''; $('#mail-account-name').value = account.display_name || ''; $('#mail-account-password').value = '';
    // G2：归属要回填 —— 不回填的话打开设置页永远显示「个人邮箱」，
    // 一保存就把部门箱静默改回个人箱（改完没有任何提示，最糟的那种改坏）。
    $('#mail-account-kind').value = account.kind || 'personal'; $('#mail-account-department').value = account.department || '';
    syncDeptField();
    attribution?.sync();   /* 摊开式的两张选项卡要跟着回填（回填后要跟着变） */
    providerChosen = Boolean(account.bound && account.provider); providerHelp();
    $('#mail-account-password').placeholder = account.bound ? '已保存；不更换授权码时留空' : '填写邮箱的客户端授权码，不是登录密码';
    $('#mail-account-state').textContent = account.bound ? `${account.email} · ${account.enabled ? '已启用' : '已暂停'}` : '尚未绑定邮箱';
    $('#mail-account-test').hidden = !account.bound; $('#mail-account-lifecycle').hidden = !account.bound;
    $('#mail-account-toggle').textContent = account.enabled ? '暂停收发' : '启用收发';
    dirty = false; controls();
  }
  async function perform(id, payload) {
    if (busy) return;
    busy = true; controls();
    try { const value = await request(id, payload, true); if (ui.disposed) return;
      if (id === 'mail.account.test') result('已保存的邮箱连接测试通过。');
      else { pending = null; keys.clear(); draw(value); result(id === 'mail.account.configure' ? '连接测试通过，邮箱已保存。' : id === 'mail.account.disconnect' ? '已解除绑定，历史邮件保留。' : '邮箱收发状态已更新。'); }
      return true;
    } catch (error) { if (ui.disposed) return;
      if (id === 'mail.account.configure' && error.uncertain) pending = { id, payload };
      result(pending ? '保存结果待核实，请点击“核实上次保存”；不会使用新请求重复配置。' : '操作未保存。请检查地址、授权码和邮箱的 IMAP/SMTP 设置后重试。', true);
    } finally { busy = false; if (!ui.disposed) controls(); }
  }
  fields.forEach(id => $(id).addEventListener('input', () => { dirty = true; controls(); }));
  $('#mail-account-provider').addEventListener('change', () => { providerChosen = Boolean($('#mail-account-provider').value); dirty = true; providerHelp(); controls(); });
  $('#mail-account-email').addEventListener('input', () => {
    if (providerChosen) return;
    const domain = $('#mail-account-email').value.trim().toLowerCase().split('@')[1];
    $('#mail-account-provider').value = domain === 'qq.com' || domain === 'foxmail.com' ? 'qq' : domain === '163.com' ? '163' : '';
    providerHelp();
  });
  $('#mail-account-form').onsubmit = event => {
    event.preventDefault(); if (busy) return;
    if (pending) { void perform(pending.id, pending.payload); return; }
    const email = $('#mail-account-email').value.trim(), password = $('#mail-account-password').value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { result('请填写有效邮箱地址。', true); return; }
    if (!$('#mail-account-provider').value) { result('请选择邮箱实际使用的服务商；自定义企业域名不能自动识别。', true); return; }
    if (!password && (!account.bound || account.email !== email || account.provider !== $('#mail-account-provider').value)) { result('首次绑定或更换邮箱时，请填写客户端授权码。', true); return; }
    const kind = $('#mail-account-kind').value || 'personal', department = $('#mail-account-department').value.trim();
    if (kind === 'department' && !department) { result('部门邮箱请填写所属部门。', true); return; }
    if (kind === 'personal' && department) { result('个人邮箱不填所属部门。', true); return; }
    void perform('mail.account.configure', { provider: $('#mail-account-provider').value, email, display_name: $('#mail-account-name').value.trim(), enabled: account.bound ? Boolean(account.enabled) : true, kind, ...(kind === 'department' ? { department } : {}), ...(password ? { password } : {}) });
  };
  function syncDeptField() {
    const isDept = $('#mail-account-kind').value === 'department';
    $('#mail-account-dept-field').hidden = !isDept;
    if (!isDept) $('#mail-account-department').value = '';
    $('[data-mail-dept-display]').textContent = $('#mail-account-department').value || '—';
  }
  $('#mail-account-kind').addEventListener('change', () => { syncDeptField(); dirty = true; controls(); }, { signal: ui.signal });
  $('#mail-account-department').addEventListener('input', () => { syncDeptField(); dirty = true; controls(); }, { signal: ui.signal });
  $('#mail-account-test').onclick = () => void perform('mail.account.test', {});
  $('#mail-account-reset').onclick = () => {
    if (busy || pending) return;
    const modal = ui.modal('<div class="dlg-head">放弃未保存设置？</div><div class="dlg-body">清除本次输入的授权码与修改，已经保存的邮箱连接不变。</div><div class="dlg-foot"><button class="btn btn-ghost" id="mail-reset-cancel">继续编辑</button><button class="btn btn-pri" id="mail-reset-confirm">放弃修改</button></div>');
    modal.querySelector('#mail-reset-cancel').onclick = () => ui.closeModal();
    modal.querySelector('#mail-reset-confirm').onclick = () => { draw(account); keys.clear(); ui.closeModal(); };
  };
  $('#mail-account-toggle').onclick = () => void perform('mail.account.status', { enabled: !account.enabled });
  $('#mail-account-disconnect').onclick = () => {
    const modal = ui.modal('<div class="dlg-head">解除邮箱绑定</div><div class="dlg-body">解绑后不能继续收发，已保存的历史邮件和附件保留，不删除服务商邮箱中的邮件。</div><div class="dlg-foot"><button class="btn btn-ghost" id="mail-account-disconnect-cancel">取消</button><button class="btn btn-pri" id="mail-account-disconnect-confirm">确认解除</button></div>');
    ui.guardModal(modal, () => !busy);
    modal.querySelector('#mail-account-disconnect-cancel').onclick = () => ui.closeModal();
    modal.querySelector('#mail-account-disconnect-confirm').onclick = async () => { const btn = modal.querySelector('#mail-account-disconnect-confirm'); btn.disabled = true; if (await perform('mail.account.disconnect', {})) ui.closeModal(); else if (btn.isConnected) btn.disabled = false; };
  };
  const leave = () => { if (busy || pending || dirty) { notify(busy ? '正在连接，请等待结果' : pending ? '请先核实上次保存' : '邮箱设置尚未保存，请先保存后离开'); return false; } return true; };
  $('#mail-account-back').onclick = () => { if (leave()) ui.closeModal(); };
  ui.guardLeave(leave); controls();
  void request('mail.account.status').then(value => { if (!ui.disposed) { loaded = true; draw(value); } }).catch(() => { if (!ui.disposed) { $('#mail-account-state').textContent = '邮箱设置暂不可用'; result('无法读取邮箱配置，请刷新重试；未修改你的邮箱。', true); } });
  ui.onDispose(() => { keys.clear(); pending = null; $('#mail-account-password') && ($('#mail-account-password').value = ''); });
  return handle;
};

/* —— 页面入口（保留这个路由，页面本身现在只负责「摆背景 + 开弹窗」）——
   背景是**邮件列表**：用户是从邮件中心过来的，关掉弹窗就回到列表。 */
window.mountMailSettings = async function (host, { signal } = {}) {
  const disposeMail = typeof window.mountMailCenter === 'function' ? window.mountMailCenter(host, { signal }) : null;
  const handle = await window.openMailSettingsDialog({ signal });
  return () => { handle?.close(); disposeMail?.(); };
};

/* —— 进邮件中心、当前用户**没绑邮箱** ⇒ 自动弹绑定窗（背景仍是邮件列表）——
   已绑 ⇒ 不弹。用户 2026-10-21：「这一整页很难看，而且挡住了别的东西」⇒ 改成弹窗。 */
let mailSettingsAutoChecked = false;
async function autoOpenMailSettingsWhenUnbound() {
  if (mailSettingsAutoChecked || activeMailSettingsDialog) return;
  if ((location.hash || '') !== '#/mail') return;
  mailSettingsAutoChecked = true;
  try {
    const value = await readMailAccountStatus();
    const account = value?.account || value || {};
    if (account.bound) return;              /* 已绑 ⇒ 不弹 */
    await window.openMailSettingsDialog();
  } catch (error) {
    /* 读不到连接状态 ⇒ 不打扰用户（弹窗里读不到会自己说明）。 */
  }
}
window.addEventListener('hashchange', () => {
  if ((location.hash || '') === '#/mail') void autoOpenMailSettingsWhenUnbound();
  else mailSettingsAutoChecked = false;   /* 离开邮件中心 ⇒ 下次进来重新判断 */
});
/* 域脚本是**动态加载**的 —— DOMContentLoaded 可能早就过去了，这时直接判断一次。 */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void autoOpenMailSettingsWhenUnbound(); });
else void autoOpenMailSettingsWhenUnbound();

window.shangshuRegisterPages(['mail-settings'], { owner: 'com.shangshu.mail', name: '邮箱设置', roles: ['admin', 'staff', 'finance', 'manager'] });
window.shangshuRegisterNav?.([{ id: 'mail-settings', name: '邮箱设置', ico: 'mail', accountMenu: true, sidebarHidden: true, roles: ['admin', 'staff', 'finance', 'manager'], sec: '个人设置' }]);
RENDER['mail-settings'] = page => window.mountMailSettings(page.host, { signal: page.signal });
