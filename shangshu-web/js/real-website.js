/* ============ 模块：待审批 ============ */
const MODULE_TAGS = { cases: '案例', services: '服务', partners: '合作伙伴', steps: '合作步骤', honors: '荣誉', config: '配置', filing: '备案' };
const ACTION_TXT = { create: '新增', update: '更新', delete: '删除', 'create-package': '上传案例包' };

RENDER.appr = async () => {
  const main = $('.main');
  mainBox().innerHTML = `<div class="page-hd page-heading"><h1>待审批</h1></div>
    <div class="card"><div class="card-hd"><span class="t">排队中</span><span class="tag am" id="appr-count"></span></div><div id="appr-list"></div></div>`;
  try {
    const raw = await apiJSON('/api/website/submissions');
    if (raw && raw.kind) throw raw;
    const all = Array.isArray(raw) ? raw : (raw.submissions || raw.items || []);
    const list = all.filter(s => s.status === 'pending');
    updateApprBadge(list.length);
    $('#appr-count').textContent = `${list.length} 条待审`;
    $('#appr-list').innerHTML = list.length ? '' : '<div class="wfail">没有排队中的提交</div>';
    list.forEach((s, i) => {
      const title = s.payload?.title || s.payload?.name || s.payload?.key || s.summary || `#${s.id}`;
      const row = document.createElement('div');
      row.className = 'appr'; row.style.animationDelay = `${i * .05}s`;
      row.innerHTML = `<span class="tag bl">${esc(MODULE_TAGS[s.module] || s.module)}</span>
        <div><div class="tt">${esc(ACTION_TXT[s.action] || s.action)}「${esc(title)}」</div>
        <div class="mt">${esc(s.created_at || '')}${s.reason ? ' · ' + esc(s.reason) : ''}</div></div>
        <div class="ops"><button class="ok">通过</button><button class="no">驳回</button></div>`;
      row.querySelector('.ok').onclick = () => decide(s.id, 'approve', row);
      row.querySelector('.no').onclick = () => decide(s.id, 'reject', row);
      $('#appr-list').appendChild(row);
    });
  } catch (e) {
    $('#appr-list').innerHTML = `<div class="wfail">${e.kind === 'NOT_CONFIGURED' ? '未配置官网连接，去系统配置' : e.kind === 'UNAUTHORIZED' ? '官网 key 失效，去系统配置检查' : '官网离线，稍后刷新'}</div>`;
  }
};

async function decide(id, action, row) {
  try {
    const res = await api(`/api/website/submissions/${id}/${action}`, { method: 'PUT', body: '{}' });
    const data = await res.json();
    if (!res.ok || data.kind) throw data;
    row.classList.add('gone');
    setTimeout(() => { row.remove(); updateApprBadge(apprCount - 1); $('#appr-count').textContent = `${apprCount} 条待审`; }, 300);
    toast(action === 'approve' ? '已通过' : '已驳回', '官网已' + (action === 'approve' ? '生效' : '记录'));
  } catch (e) {
    toast('操作失败', e.error || '官网不可达');
    RENDER.appr();
  }
}

/* ============ 模块：官网后台（iframe 嵌入） ============ */
RENDER.website = () => {
  $('.main').innerHTML = `<div class="page-hd page-heading"><h1>官网后台</h1></div>
    <div class="card" style="overflow:hidden"><iframe src="/website-admin/" style="width:100%;height:calc(100vh - 190px);border:none;display:block"></iframe></div>`;
};
