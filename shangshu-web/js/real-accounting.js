/* ============ 模块：记账（P2 切真 = 记账表真数据 + 记一笔走事件写总线） ============ */
let accTab = 'flow';

/* —— 骨架（这一档还没到时的占位）：照**最终那几块的样子**搭 ——
   流水＝一张六列表（表头一条浅灰底带 ＋ 每格一条短灰条，数据行空着 ⇒ 只有细线）；
   记一笔＝一格一格的表单（五个字段位）；应收未收＝一张七列表。
   ⚠️ 只表示「正在取数」⇒ 不写假摘要、不写假金额、不写假日期。 */
const accTableSkeleton=(widths,rows=6)=>{
  const head='<span class="platform-skeleton-td"><span class="platform-skeleton-bar"></span></span>';
  const cell='<span class="platform-skeleton-td"></span>';
  const line='<div class="platform-skeleton-tr">'+cell.repeat(widths.length)+'</div>';
  const grid=widths.map(w=>`minmax(0,${w}fr)`).join(',');
  return `<div class="platform-skeleton platform-skeleton-table" data-skeleton="table" style="grid-template-columns:${grid};--sk-row-h:30px;--sk-head-h:37px"><div class="platform-skeleton-thead platform-skeleton-tr">${head.repeat(widths.length)}</div>${line.repeat(rows)}</div>`;
};
const accSkeleton=(tab)=>{
  if(tab==='entry')return `<div class="card"><div class="card-bd"><div class="platform-skeleton" data-skeleton="form" style="display:grid;grid-template-columns:repeat(2,minmax(0,280px));gap:0 14px">${Array.from({length:5},()=>'<div class="fld"><span class="platform-skeleton-bar" style="display:block;width:56px;height:11px;margin-bottom:6px"></span><span class="platform-skeleton-input" style="width:100%;max-width:280px"></span></div>').join('')}</div><div class="platform-skeleton" data-skeleton="actions" style="display:flex;gap:10px;align-items:center;margin-top:12px"><span class="platform-skeleton-btn"></span><span class="platform-skeleton-bar" style="width:220px;height:11px"></span></div></div></div>`;
  if(tab==='recv')return `<div class="card">${accTableSkeleton([1.4,1,1,1,0.8,0.9,0.9])}</div>`;
  return `<div class="card">${accTableSkeleton([1.2,1.6,1.4,0.9,1.1,1.2])}</div><span class="platform-skeleton-bar" style="display:block;width:100%;height:11px;margin-top:12px"></span>`;
};
RENDER.accounting = async function () {
  const tabs = [['flow', '流水'], ['entry', '记一笔'], ['recv', '应收未收']].map(([k, n]) =>
    `<button class="tab ${accTab === k ? 'on' : ''}" onclick="accTab='${k}';RENDER.accounting()">${n}</button>`).join('');
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>记账</h1></div>
    <div class="tabbar">${tabs}</div>
    <div id="acc-body">${accSkeleton(accTab)}</div>`;

  if (accTab === 'flow') return renderFlow();
  if (accTab === 'entry') return renderEntry();
  renderRecv();
};

async function renderFlow() {
  const body = $('#acc-body');
  try {
    const { list } = await apiJSON('api/ledger');
    const rows = Array.isArray(list) ? list : [];
    const total = rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    body.innerHTML = rows.length ? `
      <div class="card"><table class="dtable dtable-fix">
        <colgroup><col style="width:142px"><col><col><col style="width:56px"><col style="width:90px"><col style="width:84px"></colgroup>
        <tr><th>入账日期</th><th>摘要</th><th>对方单位</th><th>方向</th><th style="text-align:right">价税合计</th><th>发票号</th></tr>
        ${rows.map(r => `<tr data-ai-entity="ledger" data-ai-id="${esc(r.id)}" data-ai-key="${esc(r.invoice_no || '')}">
          <td>${dt(r.posted_at)}</td>
          <td title="${esc(r.summary || '')}"><b>${esc(r.summary || '—')}</b></td>
          <td title="${esc(r.counterparty || '')}">${esc(r.counterparty || '—')}</td>
          <td><span class="tag">${esc(r.direction || '—')}</span></td>
          <td class="num">${money(r.total_amount)}</td>
          <td title="${esc(r.invoice_no || '')}">${esc(r.invoice_no || '—')}</td>
        </tr>`).join('')}
        <tr style="border-top:2px solid var(--line2)"><td colspan="4" style="text-align:right;font-weight:bold">合计</td><td class="num" style="font-weight:bold">${money(total)}</td><td></td></tr>
      </table></div>
      <div class="ai-note" style="margin-top:12px"><span class="spark">✦</span><div>记账表 append-only：改账走红冲 + 重记，不覆盖历史；每一笔都有事件链留痕</div></div>` :
      `<div class="card"><div class="wfail">记账表还没有记录——发票入账或「记一笔」后会出现在这里</div></div>`;
  } catch (e) {
    body.innerHTML = `<div class="wfail">加载失败：${esc(e?.message || String(e))}</div>`;
  }
}

function renderEntry() {
  $('#acc-body').innerHTML = `<div class="card"><div class="card-bd"><div class="fgrid">
      <div class="fld"><label>对方单位</label><input id="le-cp" placeholder="客户 / 供应商">
        <div id="le-habit" class="cell-sub" style="display:none;margin-top:4px"></div></div>
      <div class="fld"><label>金额（价税合计）</label><input id="le-amt" type="number" placeholder="0.00"></div>
      <div class="fld"><label>业务日期</label><input id="le-date" type="date"></div>
      <div class="fld"><label>方向</label><select id="le-dir"><option>进项</option><option>出项</option></select></div>
      <div class="fld"><label>摘要</label><input id="le-sum" placeholder="一句话说明"></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn btn-pri" onclick="postLedgerEntry()">记一笔</button>
      <span class="cell-sub">写操作 = 事件（proposed → confirmed）→ 记账表投影</span>
    </div></div></div>`;
  // 渐进吸收小字提示（2026-08-19）：输入对方单位时查历史习惯，提示「照旧？」——
  // 只是提示，提交时才沿用；阈值在服务端（habit.min_count，默认 3 次）。
  leHabit = null;
  let t = null;
  $('#le-cp').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(leHabitHint, 400);
  });
}
let leHabit = null;
async function leHabitHint() {
  const cp = $('#le-cp')?.value.trim();
  const el = $('#le-habit');
  leHabit = null;
  if (!el) return;
  if (!cp) { el.style.display = 'none'; return; }
  try {
    const r = await apiJSON('api/habits/ledger-suggest?counterparty=' + encodeURIComponent(cp));
    if (r.found && ($('#le-cp')?.value.trim() === cp)) {
      leHabit = r;
      el.innerHTML = `✦ 照旧？该单位历史 ${r.count} 次记为：<b>${esc([r.category, r.account_subject].filter(Boolean).join(' / ')) || '—'}</b>（${esc(r.direction)}）· 提交时沿用`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  } catch { el.style.display = 'none'; }
}

// R1（2026-08-14）：应收 tab 切真——真台账来自 /api/receivables（订单确认 + 出项发票入账生成）。
// 账龄 = 创建至今天数（演示口径；逾期预警见「应收应付」/提醒）。
async function renderRecv() {
  const body = $('#acc-body');
  try {
    const { list } = await apiJSON('api/receivables');
    const rows = Array.isArray(list) ? list : [];
    const totalRecv = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalUnrecv = rows.reduce((s, r) => s + ((Number(r.amount) || 0) - (Number(r.received) || 0)), 0);
    body.innerHTML = rows.length ? `
      <div class="card"><table class="dtable">
        <tr><th>客户</th><th style="text-align:right">应收</th><th style="text-align:right">已收</th><th style="text-align:right">未收</th><th>账龄</th><th>状态</th><th>来源</th></tr>
        ${rows.map(r => {
          const bal = (Number(r.amount) || 0) - (Number(r.received) || 0);
          const ageDays = Math.max(0, Math.floor((Date.now() - new Date(String(r.created_at || '')).getTime()) / 86400000));
          const age = ageDays < 1 ? '当天' : `${ageDays}天`;
          const col = bal <= 0 ? 'var(--green2)' : ageDays > 30 ? 'var(--red)' : ageDays > 15 ? 'var(--amber)' : 'inherit';
          return `<tr>
            <td><b>${esc(r.customer_name || '—')}</b></td>
            <td class="num">${money(r.amount)}</td>
            <td class="num">${money(r.received)}</td>
            <td class="num" style="color:${col}">${money(bal)}</td>
            <td><span class="tag">${age}</span></td>
            <td><span class="tag">${esc(r.status || '—')}</span></td>
            <td><span class="cell-sub">${r.order_id ? '订单' : r.invoice_id ? '发票' : '—'}</span></td>
          </tr>`;
        }).join('')}
        <tr style="border-top:2px solid var(--line2)"><td style="text-align:right;font-weight:bold">合计</td>
          <td class="num" style="font-weight:bold">${money(totalRecv)}</td><td></td>
          <td class="num" style="font-weight:bold;color:var(--red)">${money(totalUnrecv)}</td><td colspan="3"></td></tr>
      </table></div>
      <div class="ai-note" style="margin-top:12px"><span class="spark">✦</span><div>真数据：订单确认与出项发票入账自动生成应收；回款登记在「应收应付」页</div></div>` :
      `<div class="card"><div class="wfail">还没有应收——订单确认或出项发票入账后会出现在这里</div></div>`;
  } catch (e) {
    body.innerHTML = `<div class="wfail">加载失败：${esc(e?.message || String(e))}</div>`;
  }
}

async function postLedgerEntry() {
  const cp = $('#le-cp')?.value.trim();
  const amt = parseFloat($('#le-amt')?.value || '0');
  const date = $('#le-date')?.value || '';
  const dir = $('#le-dir')?.value || '进项';
  const sum = $('#le-sum')?.value.trim() || '';
  if (!cp || !amt) { toast('信息不全', '对方单位和金额必填'); return; }
  try {
    // 习惯推荐只在「提示仍对应当前输入单位」时沿用（用户没填科目字段，沿用不算覆盖）
    const habit = (leHabit && leHabit.found) ? { category: leHabit.category || '', account_subject: leHabit.account_subject || '' } : {};
    const r = await api('api/ledger', { method: 'POST', body: JSON.stringify({ entry: { counterparty: cp, total_amount: amt, biz_date: date, direction: dir, summary: sum, ...habit } }) }).then(r => r.json());
    if (!r.ok) { toast('记一笔失败', r.error || '未知错误'); return; }
    toast('已记一笔', `${cp} ¥${amt.toLocaleString()} · 事件链已留痕${habit.category ? ' · 已沿用历史科目' : ''}`);
    accTab = 'flow';
    RENDER.accounting();
  } catch (e) {
    toast('记一笔失败', String(e?.message || e));
  }
}
