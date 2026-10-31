/* ============ 模块：账号管理 ============
   平台模式（isPlatformManaged）：内核是身份权威，走 /api/platform/identities + platform.identity.* 动作；
   本地兼容模式：沿用既有 /api/users 路由（尚未迁移的兼容能力）。
   两种模式共用同一套界面与文案，避免出现"两套配置页"。 */
const USER_ROLE_LABEL = { admin: '系统管理员', finance: '财务', manager: '管理', staff: '员工' };
const USER_ROLE_ORDER = ['staff', 'finance', 'manager', 'admin'];
const USER_GROUPS = ['', '管理', '开发', '财务'];
function userRoleChoices(selected, disabled = false) {
  return USER_ROLE_ORDER.map(role => `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><input type="checkbox" data-platform-role value="${role}" ${selected.includes(role) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${USER_ROLE_LABEL[role]}</label>`).join('');
}
function userSelectedRoles(element) {
  return [...element.querySelectorAll('input[data-platform-role]:checked')].map(input => input.value);
}
function userBusinessRoleChoices(selected, options, disabled = false) {
  return options.map(item => `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><input type="checkbox" data-business-role value="${esc(item.role)}" ${selected.includes(item.role) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${esc(item.label || item.role)}</label>`).join('');
}
async function userSaveRoles(email, element) {
  const roles = userSelectedRoles(element);
  if (!roles.length) { toast('请选择至少一个角色', ''); return; }
  const business_roles = [...element.querySelectorAll('input[data-business-role]:checked')].map(input => input.value);
  if (await platformIdentityAction('platform.identity.role', { email, roles, business_roles }, '修改角色')) await RENDER.users();
}
function userDepartmentFields(group, scope) {
  return `<label>任务管理范围 <select data-scope><option value="related" ${scope === 'related' ? 'selected' : ''}>本人负责或发起（无需部门）</option><option value="department" ${scope === 'department' ? 'selected' : ''}>本部门（旧策略）</option><option value="company" ${scope === 'company' ? 'selected' : ''}>全公司（需授权）</option></select></label>
    <details><summary>部门（选填）</summary><select data-department aria-label="部门（选填）">${USER_GROUPS.map(g => `<option value="${g}" ${g === group ? 'selected' : ''}>${g || '未分配'}</option>`).join('')}</select></details>`;
}
async function userSaveDepartment(email, element) {
  if (await platformIdentityAction('platform.identity.group', { email,
    collaboration_group: element.querySelector('[data-department]').value,
    collaboration_scope: element.querySelector('[data-scope]').value }, '设置部门与范围')) await RENDER.users();
}

// —— 平台模式：全部经内核（动作带确认、幂等与审计），不在前端直连 Frappe ——
async function platformIdentities() {
  const r = await apiJSON('api/platform/identities');
  return r.list || [];
}
async function platformIdentityAction(action, payload, note) {
  const r = await api(`api/platform/actions/${encodeURIComponent(action)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ payload, confirmed: true, idempotency_key: crypto.randomUUID() }),
  });
  const j = await r.json();
  if (!j.ok) { toast(note + '失败', j.error || '操作失败'); return false; }
  return true;
}
// 停用前提示在途任务（任务在 Node 兼容存储，由前端按当前清单核对；内核不复制任务事实）
async function openTasksOf(username) {
  const { list } = await apiJSON('api/tasks');
  if (!Array.isArray(list)) throw new Error('任务清单未返回');
  return list.filter(t => t.assignee_id === username && ['待办', '进行中', '待验收'].includes(t.status));
}

RENDER['accounts'] = async function () {
  if (!isPlatformManaged() || currentUserInfo?.role !== 'admin') {
    mainBox().innerHTML = '<div class="platform-empty">仅平台管理员可进入账号管理。</div>';
    return;
  }
  return RENDER['users']();
};

RENDER['users'] = async function () {
  const platform = typeof isPlatformManaged === 'function' && isPlatformManaged();
  let users;
  let businessRoleOptions = [];
  if (platform) {
    const [identities, contributions] = await Promise.all([platformIdentities(), apiJSON('api/platform/contributions')]);
    users = identities;
    businessRoleOptions = (contributions.roles || []).filter(item => item.assignable === true);
  } else {
    users = await apiJSON('api/users');
  }
  if (!platform) { renderLegacyUsers(users); return; }
  const me = currentUserInfo?.username || '';
  mainBox().innerHTML = `
    <section class="admin-page admin-accounts-page">
    <div class="page-hd page-heading"><h1>账号管理</h1></div>
    <nav class="admin-destinations" data-admin-destinations></nav>
    <div class="card"><div class="card-hd"><span class="t">账号名单</span><span class="tag">${users.length} 个身份</span></div><div class="card-bd" style="padding:0">
    <table class="dtable">
      <tr><th>账号</th><th>姓名</th><th>平台角色</th><th>任务管理范围</th><th>状态</th><th>最近登录</th><th>操作</th></tr>
      ${users.map(u => {
        const isSelf = u.is_self || u.username === me;
        const isBuiltin = u.email === 'Administrator';
        const disabled = !u.enabled;
        const statusAction = isBuiltin
          ? '<span style="color:var(--fg3);font-size:11.5px">内置账号不可停用</span>'
          : `<button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" onclick="userToggleStatus('${esc(u.email)}', ${!disabled}, '${esc(u.display_name)}')">${disabled ? '启用' : '停用'}</button>`;
        // 空数组是真实的“未授予平台角色”，不能用会话的 staff 兼容投影冒充授权。
        const platformRoles = Array.isArray(u.platform_roles) ? u.platform_roles : [u.platform_role || 'staff'];
        return `<tr${disabled ? ' style="opacity:.55"' : ''}>
          <td><b>${esc(u.email)}</b>${u.username ? `<div class="cell-sub">登录名 ${esc(u.username)}</div>` : ''}${isSelf ? ' <span class="tag">我</span>' : ''}</td>
          <td>${esc(u.display_name)}</td>
          <td><details data-user-roles><summary>${platformRoles.length ? platformRoles.map(r => USER_ROLE_LABEL[r] || r).join('、') : '未分配平台角色'}</summary>
            ${userRoleChoices(platformRoles, isSelf || isBuiltin)}
            ${businessRoleOptions.length ? `<div class="cell-sub">业务审批授权（与协作管理分开）</div>${userBusinessRoleChoices(u.roles || [], businessRoleOptions, isSelf || isBuiltin)}` : ''}
            ${isSelf || isBuiltin ? '' : `<button class="btn btn-ghost" onclick="userSaveRoles('${esc(u.email)}', this.closest('details'))">保存角色</button>`}
          </details></td>
          <td>${isBuiltin ? '全公司（系统管理员）' : `<details data-task-scope><summary>${platformRoles.includes('admin') ? '全公司（系统管理员）' : u.collaboration_scope === 'company' ? '全公司' : u.collaboration_scope === 'related' ? '本人负责或发起' : u.collaboration_group ? '本部门' : '未分配 / 仅本人'}</summary>
            ${userDepartmentFields(u.collaboration_group || '', u.collaboration_scope)}
            <button class="btn btn-ghost" onclick="userSaveDepartment('${esc(u.email)}', this.closest('[data-task-scope]'))">保存范围</button>
          </details>`}</td>
          <td>${disabled ? '<span class="tag rd">停用</span>' : '<span class="tag" style="background:var(--accd);color:var(--green2)">启用</span>'}</td>
          <td>${esc(String(u.last_login || '').replace('T', ' ').slice(0, 16) || '—')}</td>
          <td style="white-space:nowrap">
            ${isSelf ? '<span style="color:var(--fg3);font-size:11.5px">当前登录账号</span>' : `
              ${statusAction}
              <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" onclick="userResetPw('${esc(u.email)}', '${esc(u.display_name)}')">重置密码</button>`}
          </td>
        </tr>`;
      }).join('')}
    </table>
    </div></div>
    <div class="card"><div class="card-hd"><span class="t">新建账号</span></div><div class="card-bd"><div class="fgrid">
      <div class="fld"><label>账号（邮箱）</label><input id="nu-email" placeholder="zhangsan@shangshu.local"></div>
      <div class="fld"><label>登录用户名（选填）</label><input id="nu-username" placeholder="zhangsan，可免输 @邮箱"></div>
      <div class="fld"><label>姓名</label><input id="nu-disp" placeholder="张三"></div>
      <div class="fld"><label>初始密码</label><input id="nu-pw" type="password" placeholder="至少 8 位，建好后转交本人"></div>
      <div class="fld"><label>平台角色（可多选）</label><div id="nu-roles">${userRoleChoices(['staff'])}</div></div>
      <div class="fld" id="nu-department">${userDepartmentFields('', 'related')}</div>
    </div><div class="admin-actions"><span class="admin-note">建好后把账号和初始密码转交给本人。</span><button class="btn btn-pri" onclick="createUser()">创建账号</button></div></div></div>
    </section>`;
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(mainBox(),'accounts');
};

// —— 平台模式操作 ——
async function createUser() {
  if (typeof isPlatformManaged === 'function' && isPlatformManaged()) {
    const email = $('#nu-email').value.trim().toLowerCase();
    const display = $('#nu-disp').value.trim();
    const password = $('#nu-pw').value;
    if (!email || !display) { toast('请填写账号和姓名', ''); return; }
    if (password.length < 8) { toast('初始密码至少 8 位', ''); return; }
    const username = $('#nu-username').value.trim().toLowerCase();
    const payload = {
      email, display_name: display, roles: userSelectedRoles($('#nu-roles')),
      initial_password: password, collaboration_group: $('#nu-department [data-department]').value,
      collaboration_scope: $('#nu-department [data-scope]').value,
    };
    if (username) payload.username = username;
    const ok = await platformIdentityAction('platform.identity.create', payload, '创建账号');
    if (ok) { await kernelPasswordShown(email, password, display); RENDER['users'](); }
    return;
  }
  const r = await api('api/users', { method: 'POST', body: JSON.stringify({ username: $('#nu-name').value.trim(), password: $('#nu-pw').value, role: $('#nu-role').value, display_name: $('#nu-disp').value.trim(), collaboration_group: $('#nu-group').value }) });
  const j = await r.json();
  if (j.ok) { toast('已创建', $('#nu-name').value); RENDER['users'](); }
  else toast('创建失败', j.error);
}

// 初始密码只在此刻提示一次；内核不保存明文，也不通过接口回传
async function kernelPasswordShown(email, password, display) {
  alert(`账号已创建：${email}（${display}）\n初始密码：${password}\n\n请立即转交本人；本提示关闭后密码不再显示，遗忘请用「重置密码」。`);
}

async function userToggleStatus(email, currentlyEnabled, display) {
  if (typeof isPlatformManaged === 'function' && isPlatformManaged()) {
    const nextEnabled = !currentlyEnabled;
    if (!nextEnabled) {
      const identity = (await platformIdentities()).find(u => u.email === email);
      if (!identity?.collaboration_key) { toast('无法核对在途任务', '请先检查该账号的平台身份协作键'); return; }
      let open;
      try { open = await openTasksOf(identity.collaboration_key); }
      catch { toast('无法核对在途任务', '请稍后重试，本次未停用账号'); return; }
      const warn = open.length ? `\n\n名下还有 ${open.length} 项在途任务：\n${open.map(t => `· ${t.title}（${t.status}）`).join('\n')}\n停用不会自动改派，请稍后到「待办 → 协作任务」逐条改派。` : '';
      if (!confirm(`停用「${display}」？停用后立即无法登录并撤销现有会话。${warn}`)) return;
    }
    if (await platformIdentityAction('platform.identity.status', { email, enabled: nextEnabled }, '停用/启用')) {
      toast(nextEnabled ? '已启用' : '已停用', display); await RENDER['users']();
    }
    return;
  }
  if (!currentlyEnabled) {
    if (!confirm(`停用「${display}」？停用后立即无法登录。`)) return;
  }
  const status = currentlyEnabled ? '停用' : '启用';
  const id = await legacyUserId(email);
  const r = await api(`api/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  const j = await r.json();
  if (j.ok) {
    toast(status === '停用' ? '已停用' : '已启用', display);
    RENDER['users']();
    if (status === '停用' && Array.isArray(j.open_tasks) && j.open_tasks.length)
      alert(`「${display}」名下还有 ${j.open_tasks.length} 项在途任务：\n${j.open_tasks.map(t => `· ${t.title}（${t.status}）`).join('\n')}\n\n请到「待办 → 协作任务」逐条改派；任务记录已保留。`);
  }
  else toast('操作失败', j.error);
}

// 本地兼容模式渲染（尚未迁移的 Node 用户表）：保持既有行为与文案，不再增加新能力
function renderLegacyUsers(users) {
  const me = currentUserInfo?.username || '';
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>账号管理</h1></div>
    <div class="card" style="margin-bottom:12px"><table class="dtable">
      <tr><th>账号</th><th>姓名</th><th>角色</th><th>协作分组</th><th>状态</th><th>操作</th></tr>
      ${users.map(u => {
        const isSelf = u.username === me;
        const disabled = u.status === '停用';
        return `<tr${disabled ? ' style="opacity:.55"' : ''}>
          <td><b>${esc(u.username)}</b>${isSelf ? ' <span class="tag">我</span>' : ''}</td>
          <td>${esc(u.display_name)}</td>
          <td><select class="im-input-field" style="padding:2px 6px;font-size:12px" onchange="userChangeRole('${u.username}', this.value, '${esc(u.username)}')">
            ${USER_ROLE_ORDER.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${USER_ROLE_LABEL[r]}</option>`).join('')}
          </select></td>
          <td><select class="im-input-field" style="padding:2px 6px;font-size:12px" onchange="userChangeGroup('${u.username}', this.value, '${esc(u.username)}')">
            ${USER_GROUPS.map(g => `<option value="${g}" ${(u.collaboration_group || '') === g ? 'selected' : ''}>${g || '不分组'}</option>`).join('')}
          </select></td>
          <td>${disabled ? '<span class="tag rd">停用</span>' : '<span class="tag" style="background:var(--accd);color:var(--green2)">启用</span>'}</td>
          <td style="white-space:nowrap">
            ${isSelf ? '<span style="color:var(--fg3);font-size:11.5px">当前登录账号</span>' : `
              <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" onclick="userToggleStatus('${u.username}', ${!disabled}, '${esc(u.username)}')">${disabled ? '启用' : '停用'}</button>
              <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" onclick="userResetPw('${u.username}', '${esc(u.username)}')">重置密码</button>
              <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px;color:var(--red)" onclick="userDelete('${u.id}', '${esc(u.username)}')">删除</button>`}
          </td>
        </tr>`;
      }).join('')}
    </table></div>
    <div class="card"><div class="card-hd"><span class="t">新建账号</span></div><div class="card-bd"><div class="fgrid">
      <div class="fld"><label>账号</label><input id="nu-name"></div>
      <div class="fld"><label>姓名</label><input id="nu-disp"></div>
      <div class="fld"><label>密码</label><input id="nu-pw" type="password"></div>
      <div class="fld"><label>角色</label><select id="nu-role">${USER_ROLE_ORDER.slice().reverse().map(r => `<option value="${r}">${USER_ROLE_LABEL[r]}</option>`).join('')}</select></div>
      <div class="fld"><label>协作分组</label><select id="nu-group">${USER_GROUPS.map(g => `<option value="${g}">${g || '不分组'}</option>`).join('')}</select></div>
    </div><div style="margin-top:12px"><button class="btn btn-pri" onclick="createUser()">创建账号</button></div></div></div>`;
}

async function userChangeRole(email, role, display) {
  if (typeof isPlatformManaged === 'function' && isPlatformManaged()) {
    if (await platformIdentityAction('platform.identity.role', { email, role }, '改角色')) {
      toast('角色已更新', `${display} → ${USER_ROLE_LABEL[role] || role}`); RENDER['users']();
    } else RENDER['users']();
    return;
  }
  const id = await legacyUserId(email);
  const r = await api(`api/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
  const j = await r.json();
  if (j.ok) { toast('角色已更新', `${display} → ${USER_ROLE_LABEL[role] || role}`); RENDER['users'](); }
  else { toast('修改失败', j.error); RENDER['users'](); }
}

async function userChangeGroup(email, group, display) {
  if (typeof isPlatformManaged === 'function' && isPlatformManaged()) {
    if (await platformIdentityAction('platform.identity.group', { email, collaboration_group: group }, '改分组')) {
      toast('分组已更新', `${display} → ${group || '不分组（全公司）'}`);
    } else RENDER['users']();
    return;
  }
  const id = await legacyUserId(email);
  const r = await api(`api/users/${id}/group`, { method: 'PATCH', body: JSON.stringify({ group }) });
  const j = await r.json();
  if (j.ok) toast('分组已更新', `${display} → ${group || '不分组（全公司）'}`);
  else { toast('修改失败', j.error); RENDER['users'](); }
}

async function userResetPw(email, display) {
  const platform = typeof isPlatformManaged === 'function' && isPlatformManaged();
  const pw = prompt(`为「${display}」设置新密码（至少 ${platform ? 8 : 6} 位）：`);
  if (pw == null) return;
  if (pw.length < (platform ? 8 : 6)) { toast('密码太短', ''); return; }
  if (platform) {
    if (await platformIdentityAction('platform.identity.password', { email, new_password: pw }, '重置密码')) {
      alert(`「${display}」的密码已重置，现有会话已撤销。\n新密码：${pw}\n\n请立即转交本人。`);
      toast('密码已重置', display);
    }
    return;
  }
  const id = await legacyUserId(email);
  const r = await api(`api/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
  const j = await r.json();
  if (j.ok) toast('密码已重置', display);
  else toast('重置失败', j.error);
}

// 本地兼容模式仍然按 username 操作，界面用同一套 email 字段承载
async function legacyUserId(username) {
  const users = await apiJSON('api/users');
  const row = users.find(u => u.username === username || u.email === username);
  return row ? row.id : username;
}

// 仅本地兼容模式：Node 用户表可删除（平台模式身份不可变，只停用不删除）
async function userDelete(id, username) {
  if (!confirm(`删除账号「${username}」？\n删除后该账号立即消失且无法恢复（审计事件中的历史记录保留）。`)) return;
  const r = await api(`api/users/${id}`, { method: 'DELETE' });
  const j = await r.json();
  if (j.ok) { toast('已删除', username); RENDER['users'](); }
  else toast('删除失败', j.error);
}
