/* ============ 模块：发票审核 ============ */
let reviewTab = '待审';
const FIELDS = [
  ['invoice_type', '发票类型', 'select', ['普票', '专票', '电子普', '电子专', '其他']],
  ['invoice_direction', '发票方向', 'select', ['进项', '出项']],
  ['seller_name', '开票方（销售方）'], ['buyer_name', '购买方'],
  ['invoice_code', '发票代码'], ['invoice_no', '发票号码'],
  ['total_amount', '价税合计', 'number'], ['amount_ex_tax', '不含税额', 'number'], ['tax_amount', '税额', 'number'],
  ['issued_at', '开票日期'], ['check_code', '校验码'],
];
RENDER.review = async function () {
  const all = await apiJSON('api/invoices');
  const cnt = { '待审': 0, '已入库': 0, '已入账': 0, '已拒绝': 0 };
  all.forEach(x => { if (cnt[x.status] != null) cnt[x.status]++; });
  updateBadge(cnt['待审']);
  const rows = all.filter(x => x.status === reviewTab);
  const tabs = ['待审', '已入库', '已入账', '已拒绝'].map(s =>
    `<button class="tab ${s === reviewTab ? 'on' : ''}" onclick="reviewTab='${s}';RENDER.review()">${s}<span class="bdg">${cnt[s]}</span></button>`).join('');
  const empty = `<div style="text-align:center;padding:50px 20px;color:var(--fg3)"><div style="font-size:26px;opacity:.4;margin-bottom:6px">${ICONS.receipt.replace('width="13"','width="28"')}</div>没有「${reviewTab}」的发票</div>`;
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>发票审核</h1>
      <div class="acts"><button class="btn btn-pri" onclick="document.getElementById('invFile').click()">↑ 上传发票</button></div></div>
    <input type="file" id="invFile" multiple accept=".pdf,application/pdf" style="display:none" onchange="uploadInvoices(this)">
    <div class="tabbar">${tabs}</div>
    <div class="card">${rows.length ? `<table class="dtable">
      <tr><th>开票方</th><th>发票号</th><th>类型</th><th style="text-align:right">价税合计</th><th></th></tr>
      ${rows.map(x => `<tr class="row-link" data-ai-entity="invoice" data-ai-id="${esc(x.id)}" data-ai-label="${esc(x.seller_name || '未识别发票')}" onclick="reviewDetail('${x.id}')">
        <td><b>${x.seller_name || '（未识别）'}</b><span class="cell-sub">${day(x.issued_at)} · ${x.invoice_code}</span></td>
        <td>${x.invoice_no}</td>
        <td><span class="tag">${x.invoice_type}</span></td>
        <td class="num">${money(x.total_amount)}</td>
        <td>${Object.keys(x.validation_warnings || {}).length ? `<span style="color:var(--amber)">⚠${Object.keys(x.validation_warnings).length}</span>` : ''}</td>
      </tr>`).join('')}
    </table>` : empty}</div>
    <div id="confirm-box" style="margin-top:14px"></div>`;
  renderConfirmations();
};

/* ============ 确认卡（P1）：AI 待确认写操作 ============ */
async function renderConfirmations() {
  const el = $('#confirm-box');
  if (!el) return;
  try {
    const { list } = await fetchPendingConfirmations();
    if (!list || !list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="card"><div class="card-hd"><span class="t">✦ 待确认操作</span><span class="tag">${list.length}</span></div>
      <div style="padding:12px 16px">
      ${list.map(x => {
        const sum = x.summary || {};
        const lines = (sum.lines || []).map(l => `<div>${esc(l)}</div>`).join('');
        // 统一确认卡组件（.confirm-card，浅琥珀）；曾误用 .ai-note（flex 行容器）把字段挤成竖排
        return `<div class="confirm-card">
        <div class="cc-title">${esc(sum.title || x.capability)}<span class="cell-sub"> · 发起：${esc(x.initiator)}</span></div>
        <div class="cc-lines">${lines}</div>
        <div class="cc-acts">
          <button class="btn btn-pri btn-sm" onclick="confirmResolve('${x.id}','confirmed')">${ICONS.check} 同意</button>
          <button class="btn btn-ghost btn-sm" onclick="confirmResolve('${x.id}','rejected')">✕ 拒绝</button>
        </div>
      </div>`;
      }).join('')}</div></div>`;
  } catch (e) { el.innerHTML = ''; }
}

async function confirmResolve(id, decision) {
  const r = await resolveConfirmation(id, decision);
  if (r.ok) toast(decision === 'confirmed' ? '已同意' : '已拒绝', '确认卡已处理，事件已留痕');
  else toast('操作失败', r.error || '未知错误');
  renderConfirmations();
}

async function reviewDetail(id) {
  const x = await apiJSON('api/invoices/' + id);
  // R1：客户/项目主档（出项发票入账 → 应收挂客户）
  const [custs, projs] = await Promise.all([
    apiJSON('api/customers').then(j => j.list || []).catch(() => []),
    apiJSON('api/projects').then(j => j.list || []).catch(() => []),
  ]);
  const editable = x.status === '待审';
  const dir = x.invoice_direction || '进项';
  // 出项发票才显示客户/项目（挂客户是入账生成应收的前提；进项自动以销方为供应商建应付）
  const dirExtra = editable ? `
    <div id="dir-extra" style="display:${dir === '出项' ? '' : 'none'}">
      <div class="fld"><label>客户（出项发票入账 → 应收挂此客户）</label>
        <select data-k="customer_id"><option value="">— 请选择客户 —</option>
          ${custs.map(c => `<option value="${c.id}" ${x.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>
      <div class="fld"><label>项目（可选）</label>
        <select data-k="project_id"><option value="">— 不挂项目 —</option>
          ${projs.map(p => `<option value="${p.id}" ${x.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
    </div>` : '';
  window.toggleDirExtra = function () {
    const el = $('#dir-extra');
    if (!el) return;
    const sel = document.querySelector('[data-k="invoice_direction"]');
    el.style.display = sel && sel.value === '出项' ? '' : 'none';
  };
  const ext = (x.file_token || '').split('.').pop().toLowerCase();
  const preview = !x.file_token
    ? `<div style="text-align:center;color:var(--fg3);padding:40px 10px"><div style="font-size:24px;opacity:.4;margin-bottom:6px">${ICONS.receipt.replace('width="13"','width="26"')}</div>无原图文件（该记录未归档附件）</div>`
    : /^(jpg|jpeg|png|webp|bmp|gif)$/.test(ext)
      ? `<img src="api/files/${x.file_token}">`
      : `<embed src="api/files/${x.file_token}" style="width:100%;min-height:380px">`;
  const w = x.validation_warnings || {};
  const warnHtml = Object.keys(w).length ? `<div class="ai-note" style="background:var(--amberd);border-color:#EBCF9A;color:#7A5B16"><span class="spark" style="color:var(--amber)">⚠</span><div>${Object.entries(w).map(([k, v]) => `<div>• ${v}</div>`).join('')}</div></div>` : '';
  const rawHtml = (() => {
    if (!x.raw_extract) return '';
    try {
      const r = typeof x.raw_extract === 'string' ? JSON.parse(x.raw_extract) : x.raw_extract;
      return `<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--fg3);font-size:12px">原始识别留档（${r.provider || '?'} ${r.model || ''} · ${dt(r.at)}）</summary><pre style="font-size:11px;background:var(--bg-alt);padding:8px;border-radius:var(--r);overflow:auto;max-height:220px">${esc(JSON.stringify(r.fields, null, 1))}</pre></details>`;
    } catch { return ''; }
  })();
  const fields = FIELDS.map(([k, label, type, opts]) => {
    const v = x[k] ?? '';
    if (type === 'select') return `<div class="fld"><label>${label}</label><select data-k="${k}" ${k === 'invoice_direction' ? 'onchange="toggleDirExtra()"' : ''} ${editable ? '' : 'disabled'}>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    return `<div class="fld"><label>${label}</label><input data-k="${k}" type="${type || 'text'}" value="${v}" ${editable ? '' : 'disabled'}></div>`;
  }).join('') + dirExtra;
  const foot = editable
    ? `<div style="display:flex;gap:10px;margin-top:14px"><button class="btn btn-pri" onclick="reviewApprove('${id}')">${ICONS.check} 上传</button><button class="btn btn-ghost" onclick="reviewReject('${id}')">✕ 拒绝</button></div>`
    : x.status === '已入库'
      ? `<div class="ai-note"><span class="spark">✦</span><div><b>已入库</b> · ${x.reviewer || ''} ${dt(x.reviewed_at)} · 待入账${x.invoice_direction === '出项' ? (x.customer_id ? ` · 客户已挂` : ' · ⚠ 未挂客户') : ''}</div></div><div style="margin-top:10px"><button class="btn btn-pri" onclick="reviewAccount('${id}')">${ICONS.check} 入账（按方向生成应收/应付）</button></div>`
      : x.status === '已入账'
        ? `<div class="ai-note"><span class="spark">✦</span><div><b>已入账</b> · ${x.reviewer || ''} ${dt(x.reviewed_at)}${x.ledger_record_id ? ` · 记账记录 <code>${x.ledger_record_id}</code>` : ''}${x.invoice_direction === '出项' ? ' · 应收已生成' : ' · 应付已生成'}</div></div>`
        : `<div class="ai-note"><span class="spark">✦</span><div><b>${x.status}</b> · ${x.reviewer || ''} ${dt(x.reviewed_at)}${x.review_note ? ' · ' + x.review_note : ''}</div></div>`;
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>${x.seller_name || '发票详情'}</h1><div class="sub">${x.invoice_code} ${x.invoice_no} · ${x.invoice_type}</div>
      <div class="acts"><button class="btn btn-ghost" onclick="go('review')">${ICONS.back} 返回</button></div></div>
    <div class="grid-2">
      <div class="card"><div class="card-hd"><span class="t">发票原件</span><span class="tag">${x.invoice_type}</span></div><div class="card-bd"><div class="preview">${preview}</div></div></div>
      <div class="card"><div class="card-hd"><span class="t">识别字段</span></div><div class="card-bd"><div class="fgrid">${fields}</div>${warnHtml}${rawHtml}${foot}</div></div>
    </div>`;
  if (typeof chatSetBusinessContext === 'function') {
    chatSetBusinessContext({
      module:'review', entity_type:'invoice', entity_id:id,
      label:x.seller_name || `发票 ${x.invoice_no || id}`,
    });
  }
}
function gatherEdits() {
  const p = {};
  $$('#main [data-k]').forEach(el => { let v = el.value; if (el.type === 'number') v = parseFloat(v) || 0; p[el.dataset.k] = v; });
  return p;
}
async function reviewApprove(id) {
  // 上传 = 提交字段（改过的以改后为准，OCR 错就改完再传）+ 状态已入库 + 附件传飞书
  const r = await api('api/invoices/' + id, { method: 'PATCH', body: JSON.stringify({ ...gatherEdits(), status: '已入库' }) }).then(r => r.json());
  toast('已上传', r.attachment?.uploaded ? '发票字段 + 附件已归档飞书' : `字段已入库${r.attachment?.reason ? '；附件未传：' + r.attachment.reason : ''}`);
  go('review');
}
async function reviewAccount(id) {
  // 入账 = 记账表 append + 按方向联动台账（出项→应收挂客户；进项→应付挂销方），事件链留痕
  const x = await apiJSON('api/invoices/' + id);
  if (x.invoice_direction === '出项' && !x.customer_id) {
    toast('入账失败', '出项发票需先挂客户：在「待审」状态选择客户后再上传/入账');
    return;
  }
  if (!confirm('确认入账？将写入记账表，并按方向生成应收/应付台账。\n入账后不可在此重复操作。')) return;
  const r = await api('api/invoices/' + id, {
    method: 'PATCH',
    body: JSON.stringify({ status: '已入账', customer_id: x.customer_id || '', project_id: x.project_id || '' }),
  }).then(r => r.json());
  if (r.ok && r.posted) toast('已入账', `${x.invoice_direction === '出项' ? '应收' : '应付'}台账已生成` + (r.note ? ' · ' + r.note : ''));
  else toast('入账失败', r.error || '未知错误');
  go('review');
}
async function reviewReject(id) {
  // 拒绝 = 状态已拒绝 + 备注（后端自动记审核人/时间）；不传字段改动
  if (!confirm('确认拒绝这张发票？拒绝后可在「已拒绝」tab 查看。')) return;
  await api('api/invoices/' + id, { method: 'PATCH', body: JSON.stringify({ status: '已拒绝', review_note: '审核拒绝' }) });
  toast('已拒绝', '可在「已拒绝」tab 查看');
  go('review');
}
async function uploadInvoices(input) {
  // 批量上传：逐文件 octet-stream → 后端走和邮件一样的 OCR→查重→待审 管线
  const files = [...(input.files || [])];
  input.value = ''; // 清空，允许重选同一批文件
  if (!files.length) return;
  let added = 0, duplicate = 0, failed = 0;
  toast('上传中', `正在处理 ${files.length} 张发票…`);
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const r = await api('api/invoices/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }).then(r => r.json());
      if (r.status === 'added') added++;
      else if (r.status === 'duplicate') duplicate++;
      else failed++;
      if (r.tool_used && added === 1 && files.length === 1) {
        toast('抽取完成', `${r.tool_used}${r.extraction_path ? ' · ' + r.extraction_path : ''}`);
      }
    } catch (e) { failed++; }
  }
  toast('上传完成', `新增 ${added} · 重复 ${duplicate}${failed ? ' · 失败 ' + failed : ''}`);
  reviewTab = '待审';
  RENDER.review();
}
