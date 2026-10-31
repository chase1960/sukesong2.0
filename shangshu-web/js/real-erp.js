/* ============ 模块：进销存 + 财务闭环（M1-M5 · 2026-08-07）============
   客户/产品（M1）→ 订单（M2）→ 采购（M3）→ 库存（M4）→ 应收应付（M5）
   写操作统一走事件写总线（页面提交 = 用户即确认，事件链留痕）；列表为真数据。 */

/* —— 通用：客户/产品主档页 —— */
function erpFormCard(s, fieldsHtml, btnId, onSave, editing = null) {
  return `<div class="card" style="margin-bottom:14px"><div class="card-hd"><span class="t">${editing ? '编辑' : '新建'}${s}</span></div><div class="card-bd">
    <div class="fgrid">${fieldsHtml}</div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
      <button class="btn btn-pri" id="${btnId}">保存</button>
      ${editing ? '<button class="btn btn-ghost" onclick="erpCancelEdit()">取消</button>' : ''}
      <span class="cell-sub">写操作走事件写总线（proposed → confirmed，事件链留痕）</span>
    </div>
  </div></div>`;
}

/* ============ 客户（M1）============ */
let erpEditCustomer = null;
RENDER.customers = async function () {
  const { list } = await apiJSON('api/customers').catch(() => ({ list: [] }));
  const rows = Array.isArray(list) ? list : [];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>客户</h1></div>
    <div id="erp-cust-form"></div>
    <div class="card"><table class="dtable">
      <tr><th>名称</th><th>联系人</th><th>电话</th><th>地址</th><th>状态</th><th>操作</th></tr>
      ${rows.map(c => `<tr>
        <td><b>${esc(c.name)}</b></td><td>${esc(c.contact || '—')}</td><td>${esc(c.phone || '—')}</td>
        <td>${esc(c.address || '—')}</td>
        <td><span class="tag">${esc(c.status || '启用')}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="erpEditCustomer=${JSON.stringify(c).replace(/"/g, '&quot;')};RENDER.customers()">编辑</button>
          <button class="btn btn-sm ${c.status === '启用' ? 'btn-ghost' : ''}" onclick="erpToggleCustomer('${c.id}')">${c.status === '启用' ? '停用' : '启用'}</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="wfail">还没有客户 —— 点「新建客户」添加</td></tr>'}
    </table></div>
    <div style="margin-top:10px"><button class="btn btn-pri" onclick="erpEditCustomer=null;erpShowCustomerForm()">+ 新建客户</button></div>`;
  if (erpEditCustomer) erpShowCustomerForm();
};
function erpShowCustomerForm() {
  const c = erpEditCustomer || {};
  $('#erp-cust-form').innerHTML = erpFormCard('客户', `
    <div class="fld"><label>名称 *</label><input id="cust-name" value="${esc(c.name || '')}"></div>
    <div class="fld"><label>联系人</label><input id="cust-contact" value="${esc(c.contact || '')}"></div>
    <div class="fld"><label>电话</label><input id="cust-phone" value="${esc(c.phone || '')}"></div>
    <div class="fld"><label>地址</label><input id="cust-address" value="${esc(c.address || '')}"></div>
  `, 'cust-save', null, erpEditCustomer);
  $('#cust-save').onclick = async () => {
    const name = $('#cust-name').value.trim();
    if (!name) return toast('客户名称不能为空', '请填写名称');
    const body = { name, contact: $('#cust-contact').value, phone: $('#cust-phone').value, address: $('#cust-address').value };
    try {
      if (erpEditCustomer) await api('api/customers/' + erpEditCustomer.id, { method: 'PATCH', body: JSON.stringify(body) }).then(r => r.json());
      else await api('api/customers', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
      toast(erpEditCustomer ? '已保存' : '已创建', '客户' + name);
      erpEditCustomer = null; RENDER.customers();
    } catch (e) { toast('保存失败', e?.message || String(e)); }
  };
}
function erpToggleCustomer(id) {
  apiJSON('api/customers', {}).then(async ({ list }) => {
    const c = (list || []).find(x => x.id === id);
    if (!c) return;
    await api('api/customers/' + id, { method: 'PATCH', body: JSON.stringify({ status: c.status === '启用' ? '停用' : '启用' }) }).then(r => r.json());
    toast('已更新', '客户状态：' + (c.status === '启用' ? '停用' : '启用'));
    RENDER.customers();
  });
}
function erpCancelEdit() { erpEditCustomer = null; erpShowCustomerForm(); }

/* ============ 产品（M1）============ */
let erpEditProduct = null;
RENDER.products = async function () {
  const { list } = await apiJSON('api/products').catch(() => ({ list: [] }));
  const rows = Array.isArray(list) ? list : [];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>产品（SKU）</h1></div>
    <div id="erp-prod-form"></div>
    <div class="card"><table class="dtable">
      <tr><th>SKU</th><th>名称</th><th>规格</th><th>单位</th><th style="text-align:right">售价</th><th style="text-align:right">成本</th><th>状态</th><th>操作</th></tr>
      ${rows.map(p => `<tr>
        <td><b>${esc(p.sku)}</b></td><td>${esc(p.name)}</td><td>${esc(p.spec || '—')}</td><td>${esc(p.unit || '—')}</td>
        <td class="num">${money(p.price)}</td><td class="num">${money(p.cost)}</td>
        <td><span class="tag">${esc(p.status || '启用')}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="erpEditProduct=${JSON.stringify(p).replace(/"/g, '&quot;')};RENDER.products()">编辑</button>
          <button class="btn btn-sm ${p.status === '启用' ? 'btn-ghost' : ''}" onclick="erpToggleProduct('${p.id}')">${p.status === '启用' ? '停用' : '启用'}</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="wfail">还没有产品 —— 点「新建产品」添加</td></tr>'}
    </table></div>
    <div style="margin-top:10px"><button class="btn btn-pri" onclick="erpEditProduct=null;erpShowProductForm()">+ 新建产品</button></div>`;
  if (erpEditProduct) erpShowProductForm();
};
function erpShowProductForm() {
  const p = erpEditProduct || {};
  $('#erp-prod-form').innerHTML = erpFormCard('产品', `
    <div class="fld"><label>SKU *</label><input id="prod-sku" value="${esc(p.sku || '')}"></div>
    <div class="fld"><label>名称 *</label><input id="prod-name" value="${esc(p.name || '')}"></div>
    <div class="fld"><label>规格</label><input id="prod-spec" value="${esc(p.spec || '')}"></div>
    <div class="fld"><label>单位</label><input id="prod-unit" value="${esc(p.unit || '')}"></div>
    <div class="fld"><label>售价（元）</label><input id="prod-price" type="number" value="${p.price ?? ''}"></div>
    <div class="fld"><label>成本（元）</label><input id="prod-cost" type="number" value="${p.cost ?? ''}"></div>
  `, 'prod-save', null, erpEditProduct);
  $('#prod-save').onclick = async () => {
    const sku = $('#prod-sku').value.trim(), name = $('#prod-name').value.trim();
    if (!sku || !name) return toast('SKU 与名称必填', '请填写后再保存');
    const body = { sku, name, spec: $('#prod-spec').value, unit: $('#prod-unit').value, price: Number($('#prod-price').value) || 0, cost: Number($('#prod-cost').value) || 0 };
    try {
      if (erpEditProduct) await api('api/products/' + erpEditProduct.id, { method: 'PATCH', body: JSON.stringify(body) }).then(r => r.json());
      else await api('api/products', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
      toast(erpEditProduct ? '已保存' : '已创建', '产品 ' + name);
      erpEditProduct = null; RENDER.products();
    } catch (e) { toast('保存失败', e?.message || String(e)); }
  };
}
function erpToggleProduct(id) {
  apiJSON('api/products', {}).then(async ({ list }) => {
    const p = (list || []).find(x => x.id === id);
    if (!p) return;
    await api('api/products/' + id, { method: 'PATCH', body: JSON.stringify({ status: p.status === '启用' ? '停用' : '启用' }) }).then(r => r.json());
    toast('已更新', '产品状态：' + (p.status === '启用' ? '停用' : '启用'));
    RENDER.products();
  });
}

/* ============ 订单（M2）：列表 + 新建（客户 + 明细行）→ 确认生成应收 ============ */
let erpOrderItems = [];
RENDER.orders = async function () {
  const [orders, customers, products] = await Promise.all([
    apiJSON('api/orders').then(r => r.list || []),
    apiJSON('api/customers').then(r => r.list || []),
    apiJSON('api/products').then(r => r.list || []),
  ]).catch(() => [[], [], []]);
  const stTag = (s) => `<span class="tag ${s === '已确认' ? 'ok' : s === '草稿' ? '' : s === '已完成' ? '' : 'no'}">${esc(s)}</span>`;
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>报价与订单</h1></div>
    <div id="erp-order-form"></div>
    <div class="card"><table class="dtable">
      <tr><th>单号</th><th>客户</th><th style="text-align:right">金额</th><th>状态</th><th>创建时间</th><th style="text-align:right">操作</th></tr>
      ${orders.map(o => `<tr data-ai-entity="order" data-ai-id="${esc(o.id)}" data-ai-key="${esc(o.order_no)}">
        <td><b>${esc(o.order_no)}</b></td><td>${esc(o.customer_name || o.customer_id || '—')}</td>
        <td class="num">${money(o.total_amount)}</td><td>${stTag(o.status)}</td>
        <td style="white-space:nowrap">${dt(o.created_at)}</td>
        <td style="white-space:nowrap;text-align:right">
          ${o.status === '草稿' ? `<button class="btn btn-sm" onclick="erpOrderAct('${o.id}','confirm')">确认</button>
          <button class="btn btn-sm btn-ghost" onclick="erpOrderAct('${o.id}','cancel')">取消</button>` : ''}
          ${o.status === '已确认' ? `<button class="btn btn-sm" onclick="erpOrderAct('${o.id}','complete')">标记完成</button>` : ''}
          ${o.status === '已确认' ? `<button class="btn btn-sm btn-ghost" onclick="erpOrderAct('${o.id}','cancel')">取消</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="wfail">还没有订单 —— 点「新建订单」添加</td></tr>'}
    </table></div>
    <div style="margin-top:10px"><button class="btn btn-pri" onclick="erpShowOrderForm()">+ 新建订单</button></div>`;
};
function erpShowOrderForm() {
  apiJSON('api/customers').then(async ({ list: customers }) => {
    const products = (await apiJSON('api/products')).list || [];
    erpOrderItems = [{ product_id: '', qty: 1 }];
    const prodOpts = (sel) => `<option value="">选择产品…</option>${products.map(p =>
      `<option value="${p.id}" data-price="${p.price}" data-name="${esc(p.name)}" data-sku="${esc(p.sku)}" ${sel === p.id ? 'selected' : ''}>${esc(p.sku)} · ${esc(p.name)}（${money(p.price)}）</option>`).join('')}`;
    $('#erp-order-form').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-hd"><span class="t">新建订单</span></div><div class="card-bd">
        <div class="fgrid">
          <div class="fld"><label>客户 *</label><select id="ord-cust">${customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="fld"><label>备注</label><input id="ord-note" placeholder="选填"></div>
        </div>
        <div id="ord-items"></div>
        <div style="margin:10px 0;display:flex;justify-content:space-between;align-items:center">
          <button class="btn btn-sm" onclick="erpAddOrderItem()">+ 加一行</button>
          <span>合计：<b id="ord-total">${money(0)}</b></span>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn btn-pri" onclick="erpSaveOrder()">保存订单（草稿）</button>
          <button class="btn btn-ghost" onclick="erpCancelOrderForm()">取消</button>
          <span class="cell-sub">保存后点「确认」→ 生成应收台账（事件链留痕）</span>
        </div>
      </div></div>`;
    window.__erpProdOpts = prodOpts;
    erpRenderOrderItems();
  });
}
function erpRenderOrderItems() {
  const prodOpts = window.__erpProdOpts || (() => '<option>—</option>');
  $('#ord-items').innerHTML = erpOrderItems.map((it, i) => `
    <div style="display:grid;grid-template-columns:1fr 120px 120px 130px 40px;gap:8px;margin-bottom:8px;align-items:center">
      <select id="oi-prod-${i}" onchange="erpOrderItemChange(${i})">${prodOpts(it.product_id)}</select>
      <input id="oi-qty-${i}" type="number" min="1" value="${it.qty}" oninput="erpOrderItemChange(${i})">
      <span id="oi-price-${i}" style="text-align:right">${money(0)}</span>
      <span id="oi-amt-${i}" style="text-align:right;font-weight:600">${money(0)}</span>
      <button class="btn btn-sm btn-ghost" onclick="erpOrderItems.splice(${i},1);erpRenderOrderItems()">✕</button>
    </div>`).join('');
  erpOrderItemChange();
}
function erpOrderItemChange() {
  let total = 0;
  erpOrderItems.forEach((it, i) => {
    const sel = $('#oi-prod-' + i);
    const qty = Number($('#oi-qty-' + i)?.value) || 0;
    const price = sel?.selectedOptions?.[0]?.dataset?.price ? Number(sel.selectedOptions[0].dataset.price) : 0;
    it.product_id = sel?.value || ''; it.qty = qty;
    $('#oi-price-' + i).textContent = money(price);
    const amt = Math.round(price * qty * 100) / 100;
    $('#oi-amt-' + i).textContent = money(amt);
    total += amt;
  });
  $('#ord-total').textContent = money(Math.round(total * 100) / 100);
}
function erpAddOrderItem() { erpOrderItems.push({ product_id: '', qty: 1 }); erpRenderOrderItems(); }
async function erpSaveOrder() {
  const customer_id = $('#ord-cust').value;
  const items = erpOrderItems
    .filter(it => it.product_id && it.qty > 0)
    .map(it => {
      const sel = document.querySelector(`#oi-prod-${erpOrderItems.indexOf(it)}`)?.selectedOptions?.[0];
      return { product_id: it.product_id, qty: it.qty, product_name: sel?.dataset?.name || '', sku: sel?.dataset?.sku || '', price: Number(sel?.dataset?.price) || 0 };
    });
  if (!customer_id) return toast('请选择客户', '新建订单需要客户');
  if (!items.length) return toast('请添加明细', '至少一条产品明细（数量>0）');
  try {
    await api('api/orders', { method: 'POST', body: JSON.stringify({ customer_id, items, note: $('#ord-note').value }) }).then(r => r.json());
    toast('订单已创建', '草稿状态 · 确认后生成应收');
    $('#erp-order-form').innerHTML = '';
    RENDER.orders();
  } catch (e) { toast('创建失败', e?.message || String(e)); }
}
function erpCancelOrderForm() {
  erpOrderItems = [];
  $('#erp-order-form').innerHTML = '';
}
async function erpOrderAct(id, act) {
  try {
    const r = await api(`api/orders/${id}/${act}`, { method: 'POST', body: '{}' }).then(x => x.json());
    if (!r.ok) return toast('操作失败', r.error || '');
    toast(act === 'confirm' ? '订单已确认' : act === 'cancel' ? '订单已取消' : '订单已完成',
      act === 'confirm' ? '应收台账已生成（未收）' : '事件链已留痕');
    RENDER.orders();
  } catch (e) { toast('操作失败', e?.message || String(e)); }
}

/* ============ 采购（M3）：列表 + 新建 → 确认 → 收货（入库联动）→ 完成 ============ */
let erpPurItems = [];
RENDER.purchase = async function () {
  const purchases = (await apiJSON('api/purchases').catch(() => ({ list: [] }))).list || [];
  const stTag = (s) => `<span class="tag ${s === '已收货' ? 'ok' : ''}">${esc(s)}</span>`;
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>采购</h1></div>
    <div id="erp-pur-form"></div>
    <div class="card"><table class="dtable">
      <tr><th>单号</th><th>供应商</th><th>类型</th><th style="text-align:right">金额</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
      ${purchases.map(p => `<tr>
        <td><b>${esc(p.purchase_no)}</b></td><td>${esc(p.supplier)}</td><td><span class="tag">${esc(p.type)}</span></td>
        <td class="num">${money(p.total_amount)}</td><td>${stTag(p.status)}</td>
        <td style="white-space:nowrap">${dt(p.created_at)}</td>
        <td style="white-space:nowrap">
          ${p.status === '草稿' ? `<button class="btn btn-sm" onclick="erpPurAct('${p.id}','confirm')">确认</button>` : ''}
          ${p.status === '已确认' ? `<button class="btn btn-sm" onclick="erpPurAct('${p.id}','receive')">收货入库</button>` : ''}
          ${p.status === '已收货' ? `<button class="btn btn-sm" onclick="erpPurAct('${p.id}','complete')">完成</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="wfail">还没有采购单 —— 点「新建采购单」添加</td></tr>'}
    </table></div>
    <div style="margin-top:10px"><button class="btn btn-pri" onclick="erpShowPurForm()">+ 新建采购单</button></div>`;
};
function erpShowPurForm() {
  apiJSON('api/products').then(async ({ list: products }) => {
    erpPurItems = [{ product_id: '', qty: 1 }];
    const prodOpts = (sel) => `<option value="">选择产品…</option>${products.map(p =>
      `<option value="${p.id}" data-price="${p.price}" data-name="${esc(p.name)}" data-sku="${esc(p.sku)}" ${sel === p.id ? 'selected' : ''}>${esc(p.sku)} · ${esc(p.name)}（${money(p.price)}）</option>`).join('')}`;
    window.__erpPurOpts = prodOpts;
    $('#erp-pur-form').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-hd"><span class="t">新建采购单</span></div><div class="card-bd">
        <div class="fgrid">
          <div class="fld"><label>供应商 *</label><input id="pur-supplier" placeholder="工厂 / 供应商名称"></div>
          <div class="fld"><label>类型</label><select id="pur-type"><option>常规</option><option>外采</option><option>库存</option></select></div>
          <div class="fld"><label>备注</label><input id="pur-note" placeholder="选填"></div>
        </div>
        <div id="pur-items"></div>
        <div style="margin:10px 0;display:flex;justify-content:space-between;align-items:center">
          <button class="btn btn-sm" onclick="erpAddPurItem()">+ 加一行</button>
          <span>合计：<b id="pur-total">${money(0)}</b></span>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn btn-pri" onclick="erpSavePur()">保存采购单（草稿）</button>
          <span class="cell-sub">收货时逐项入库（库存增加）并生成应付台账</span>
        </div>
      </div></div>`;
    erpRenderPurItems();
  });
}
function erpRenderPurItems() {
  const prodOpts = window.__erpPurOpts || (() => '<option>—</option>');
  $('#pur-items').innerHTML = erpPurItems.map((it, i) => `
    <div style="display:grid;grid-template-columns:1fr 120px 120px 130px 40px;gap:8px;margin-bottom:8px;align-items:center">
      <select id="pi-prod-${i}" onchange="erpPurItemChange(${i})">${prodOpts(it.product_id)}</select>
      <input id="pi-qty-${i}" type="number" min="1" value="${it.qty}" oninput="erpPurItemChange(${i})">
      <span id="pi-price-${i}" style="text-align:right">${money(0)}</span>
      <span id="pi-amt-${i}" style="text-align:right;font-weight:600">${money(0)}</span>
      <button class="btn btn-sm btn-ghost" onclick="erpPurItems.splice(${i},1);erpRenderPurItems()">✕</button>
    </div>`).join('');
  erpPurItemChange();
}
function erpPurItemChange() {
  let total = 0;
  erpPurItems.forEach((it, i) => {
    const sel = $('#pi-prod-' + i);
    const qty = Number($('#pi-qty-' + i)?.value) || 0;
    const price = sel?.selectedOptions?.[0]?.dataset?.price ? Number(sel.selectedOptions[0].dataset.price) : 0;
    it.product_id = sel?.value || ''; it.qty = qty;
    $('#pi-price-' + i).textContent = money(price);
    const amt = Math.round(price * qty * 100) / 100;
    $('#pi-amt-' + i).textContent = money(amt);
    total += amt;
  });
  $('#pur-total').textContent = money(Math.round(total * 100) / 100);
}
function erpAddPurItem() { erpPurItems.push({ product_id: '', qty: 1 }); erpRenderPurItems(); }
async function erpSavePur() {
  const supplier = $('#pur-supplier').value.trim();
  const items = erpPurItems.filter(it => it.product_id && it.qty > 0).map(it => {
    const sel = document.querySelector(`#pi-prod-${erpPurItems.indexOf(it)}`)?.selectedOptions?.[0];
    return { product_id: it.product_id, qty: it.qty, product_name: sel?.dataset?.name || '', sku: sel?.dataset?.sku || '', price: Number(sel?.dataset?.price) || 0 };
  });
  if (!supplier) return toast('请填写供应商', '新建采购单需要供应商');
  if (!items.length) return toast('请添加明细', '至少一条产品明细（数量>0）');
  try {
    await api('api/purchases', { method: 'POST', body: JSON.stringify({ supplier, type: $('#pur-type').value, items, note: $('#pur-note').value }) }).then(r => r.json());
    toast('采购单已创建', '草稿状态 · 确认后可收货入库');
    $('#erp-pur-form').innerHTML = '';
    RENDER.purchase();
  } catch (e) { toast('创建失败', e?.message || String(e)); }
}
async function erpPurAct(id, act) {
  try {
    const r = await api(`api/purchases/${id}/${act}`, { method: 'POST', body: '{}' }).then(x => x.json());
    if (!r.ok) return toast('操作失败', r.error || '');
    toast(act === 'confirm' ? '采购单已确认' : act === 'receive' ? '已收货入库' : '采购已完成',
      act === 'receive' ? '库存已增加 · 应付台账已生成' : '事件链已留痕');
    RENDER.purchase();
  } catch (e) { toast('操作失败', e?.message || String(e)); }
}

/* ============ 库存（M4）：当前量 + 出入库流水 ============ */
RENDER.inventory = async function () {
  const inv = await apiJSON('api/inventory').catch(() => ({ list: [], moves: [] }));
  const rows = Array.isArray(inv.list) ? inv.list : [];
  const moves = Array.isArray(inv.moves) ? inv.moves : [];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>库存</h1></div>
    <div class="card"><table class="dtable">
      <tr><th>SKU</th><th>名称</th><th style="text-align:right">当前库存</th><th>更新时间</th></tr>
      ${rows.map(r => `<tr><td><b>${esc(r.sku || '—')}</b></td><td>${esc(r.product_name || r.product_id || '—')}</td><td class="num" style="font-weight:600">${Number(r.qty) || 0}</td><td style="white-space:nowrap">${dt(r.updated_at)}</td></tr>`).join('') ||
        '<tr><td colspan="4" class="wfail">还没有库存 —— 采购单「收货入库」后自动出现</td></tr>'}
    </table></div>
    <div class="card" style="margin-top:14px"><div class="card-hd"><span class="t">出入库流水</span><span class="tag">append-only</span></div>
      <table class="dtable">
        <tr><th>时间</th><th>SKU</th><th>名称</th><th>类型</th><th style="text-align:right">数量</th><th>来源</th></tr>
        ${moves.map(m => `<tr><td style="white-space:nowrap">${dt(m.created_at)}</td><td>${esc(m.sku || '—')}</td><td>${esc(m.product_name || m.product_id || '—')}</td>
          <td><span class="tag ${m.type === '入库' ? 'ok' : 'no'}">${esc(m.type)}</span></td><td class="num">${Number(m.qty) || 0}</td><td>${esc(m.ref_type || '—')}</td></tr>`).join('') ||
          '<tr><td colspan="6" class="wfail">暂无流水</td></tr>'}
      </table></div>`;
};

/* ============ 应收应付（M5）：台账 + 回款/付款登记 ============ */
let erpFinTab = 'recv';
let erpCashRange={};
/* —— 骨架（这一档还没到时的占位）：照**最终那几块的样子**搭 ——
   应收/应付＝一张六列表（表头一条浅灰底带 ＋ 每格一条短灰条，数据行空着 ⇒ 只有细线）；
   实际收付款＝一条筛选条 ＋ 一张五列表；导入导出＝一块说明面。
   ⚠️ 只表示「正在取数」⇒ 不写假客户名、不写假金额、不写假日期。 */
const erpTableSkeleton=(widths,rows=6)=>{
  const head='<span class="platform-skeleton-td"><span class="platform-skeleton-bar"></span></span>';
  const cell='<span class="platform-skeleton-td"></span>';
  const line='<div class="platform-skeleton-tr">'+cell.repeat(widths.length)+'</div>';
  const grid=widths.map(w=>`minmax(0,${w}fr)`).join(',');
  return `<div class="platform-skeleton platform-skeleton-table" data-skeleton="table" style="grid-template-columns:${grid};--sk-row-h:30px;--sk-head-h:37px"><div class="platform-skeleton-thead platform-skeleton-tr">${head.repeat(widths.length)}</div>${line.repeat(rows)}</div>`;
};
const erpFinSkeleton=(tab)=>{
  if(tab==='cash')return `<div class="card"><div class="card-bd"><div class="platform-skeleton" data-skeleton="filters" style="display:flex;gap:8px;align-items:flex-end"><span class="platform-skeleton-input"></span><span class="platform-skeleton-input"></span><span class="platform-skeleton-btn"></span></div><span class="platform-skeleton-bar" style="display:block;width:100%;height:11px;margin-top:12px"></span></div></div><div class="card">${erpTableSkeleton([1.2,1.4,1,1.6,1])}</div>`;
  if(tab==='transfer')return `<div class="card"><div class="card-bd"><span class="platform-skeleton-bar" style="display:block;width:180px;height:14px"></span><span class="platform-skeleton-bar" style="display:block;width:100%;height:11px;margin-top:12px"></span><span class="platform-skeleton-bar" style="display:block;width:74%;height:11px;margin-top:8px"></span><span class="platform-skeleton-bar" style="display:block;width:46%;height:26px;border-radius:7px;margin-top:14px"></span></div></div>`;
  return `<div class="card">${erpTableSkeleton([1.6,1,1,1,1,1.2])}</div><span class="platform-skeleton-bar" style="display:block;width:100%;height:11px;margin-top:12px"></span>`;
};
RENDER.payables = async function () {
  const tabs = [['recv', '应收'], ['pay', '应付'], ['cash','实际收付款'], ['transfer','导入导出']].map(([k, n]) =>
    `<button class="tab ${erpFinTab === k ? 'on' : ''}" onclick="erpFinTab='${k}';RENDER.payables()">${n}</button>`).join('');
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>应收应付</h1></div>
    <div class="tabbar">${tabs}</div>
    <div id="fin-body">${erpFinSkeleton(erpFinTab)}</div>`;
  if(erpFinTab==='cash') return renderCashTab();
  if(erpFinTab==='transfer') return renderBusinessTransfer();
  if (erpFinTab === 'recv') return renderRecvTab();
  renderPayTab();
};
async function renderRecvTab() {
  const body = $('#fin-body');
  const { list } = await apiJSON('api/receivables').catch(() => ({ list: [] }));
  const rows = Array.isArray(list) ? list : [];
  const totalBal = rows.reduce((s, r) => s + (Number(r.amount) - Number(r.received)), 0);
  const stTag = (s) => `<span class="tag ${s === '已收' ? 'ok' : s === '未收' ? 'no' : ''}">${esc(s)}</span>`;
  body.innerHTML = rows.length ? `
    <div class="card"><table class="dtable">
      <tr><th>客户</th><th style="text-align:right">应收</th><th style="text-align:right">已收</th><th style="text-align:right">余额</th><th>状态</th><th>操作</th></tr>
      ${rows.map(r => `<tr data-ai-entity="receivable" data-ai-id="${esc(r.id)}" data-ai-key="${esc(r.invoice_id || '')}">
        <td><b>${esc(r.customer_name || '—')}</b></td>
        <td class="num">${money(r.amount)}</td><td class="num">${money(r.received)}</td>
        <td class="num" style="font-weight:600;${(Number(r.amount) - Number(r.received)) > 0 ? 'color:var(--red)' : ''}">${money(Number(r.amount) - Number(r.received))}</td>
        <td>${stTag(r.status)}</td>
        <td>${(Number(r.amount) - Number(r.received)) > 0 ? `<button class="btn btn-sm" onclick="erpRegPay('receivables','${r.id}','${esc(r.customer_name || '')}','${Number(r.amount) - Number(r.received)}')">登记回款</button>` : '—'}</td>
      </tr>`).join('')}
      <tr style="border-top:2px solid var(--line2)"><td style="text-align:right;font-weight:bold" colspan="3">未收合计</td><td class="num" style="font-weight:bold;color:var(--red)">${money(totalBal)}</td><td colspan="2"></td></tr>
    </table></div>
    <div class="ai-note" style="margin-top:12px"><span class="spark">✦</span><div>应收来自销售发票入账、订单确认或期初导入；回款登记后状态自动迁移：未收 → 部分已收 → 已收</div></div>` :
    `<div class="card"><div class="wfail">还没有应收 —— 可入账销售发票或导入期初</div></div>`;
}
async function renderPayTab() {
  const body = $('#fin-body');
  const { list } = await apiJSON('api/payables').catch(() => ({ list: [] }));
  const rows = Array.isArray(list) ? list : [];
  const totalBal = rows.reduce((s, r) => s + (Number(r.amount) - Number(r.paid)), 0);
  const stTag = (s) => `<span class="tag ${s === '已付' ? 'ok' : s === '未付' ? 'no' : ''}">${esc(s)}</span>`;
  body.innerHTML = rows.length ? `
    <div class="card"><table class="dtable">
      <tr><th>供应商</th><th style="text-align:right">应付</th><th style="text-align:right">已付</th><th style="text-align:right">余额</th><th>状态</th><th>操作</th></tr>
      ${rows.map(r => `<tr data-ai-entity="payable" data-ai-id="${esc(r.id)}" data-ai-key="${esc(r.invoice_id || '')}">
        <td><b>${esc(r.supplier || '—')}</b></td>
        <td class="num">${money(r.amount)}</td><td class="num">${money(r.paid)}</td>
        <td class="num" style="font-weight:600;${(Number(r.amount) - Number(r.paid)) > 0 ? 'color:var(--amber)' : ''}">${money(Number(r.amount) - Number(r.paid))}</td>
        <td>${stTag(r.status)}</td>
        <td>${(Number(r.amount) - Number(r.paid)) > 0 ? `<button class="btn btn-sm" onclick="erpRegPay('payables','${r.id}','${esc(r.supplier || '')}','${Number(r.amount) - Number(r.paid)}')">登记付款</button>` : '—'}</td>
      </tr>`).join('')}
      <tr style="border-top:2px solid var(--line2)"><td style="text-align:right;font-weight:bold" colspan="3">未付合计</td><td class="num" style="font-weight:bold;color:var(--amber)">${money(totalBal)}</td><td colspan="2"></td></tr>
    </table></div>` :
    `<div class="card"><div class="wfail">还没有应付 —— 可入账采购发票或导入期初</div></div>`;
}
async function erpRegPay(kind,id,name,maxAmount) {
  openSchemaForm({title:'登记'+(kind==='receivables'?'收款':'付款')+' · '+name,required:['amount','occurred_on'],properties:{
    amount:{type:'number',title:'本次金额（元）',minimum:0.01,maximum:Number(maxAmount)},occurred_on:{type:'string',format:'date',title:'实际收付日期',default:localBusinessDate()},account:{type:'string',title:'账户'},note:{type:'string',title:'备注'}
  },onSubmit:async data=>{await submitJSON(`api/${kind}/${encodeURIComponent(id)}/pay`,data);await RENDER.payables();}});
}
async function renderCashTab() {
  const {summary:s,list=[]}=await apiJSON('api/cash?'+new URLSearchParams(erpCashRange));
  $('#fin-body').innerHTML=`<div class="card"><div class="card-bd"><form id="cash-period"><label>开始 <input type="date" name="date_from" value="${esc(s.period.from)}" required></label> <label>结束 <input type="date" name="date_to" value="${esc(s.period.to)}" required></label> <button class="btn btn-ghost">查询</button><span id="cash-period-error" role="alert"></span></form><p>${esc(s.period.from)} 至 ${esc(s.period.to)} · 收款 ${money(s.received)} · 付款 ${money(s.paid)} · 净额 ${money(s.net)}</p><p class="cell-sub">此处仅统计已登记流水；发票入账及期初累计金额不计为本期到账。登记错误可冲回，实际退款应另记反向收付款。</p>${s.warnings.map(w=>`<p class="schema-error">${esc(w)}</p>`).join('')}${['admin','finance'].includes(currentUserInfo?.role)?'<button class="btn btn-pri" onclick="recordCash()">登记独立收付款</button>':''}</div></div><div class="card"><table class="dtable"><tr><th>日期</th><th>方向 / 对方</th><th>金额</th><th>账户 / 备注</th><th>纠错</th></tr>${list.map(r=>`<tr><td>${esc(r.occurred_on || r.created_at?.slice(0,10))}</td><td>${esc(r.direction)} · ${esc(r.counterparty)}</td><td>${money(r.amount_minor/100)}</td><td>${esc(r.account)} ${esc(r.note)}</td><td>${!r.reversed && !r.reversal_of && r.amount_minor>0 && ['admin','finance'].includes(currentUserInfo?.role)?`<button class="btn btn-sm" data-reverse="${esc(r.id)}">冲回错误登记</button>`:r.reversal_of?'冲回记录':r.reversed?'已冲回':'—'}</td></tr>`).join('') || '<tr><td colspan="5">本期暂无流水</td></tr>'}</table></div>`;
  $('#cash-period').onsubmit=async e=>{e.preventDefault();const next=Object.fromEntries(new FormData(e.target));if(next.date_from>next.date_to){$('#cash-period-error').textContent='开始日期不能晚于结束日期';return;}erpCashRange=next;await renderCashTab();};
  $$('[data-reverse]').forEach(b=>b.onclick=()=>openSchemaForm({title:'冲回错误登记',description:'保留原记录，追加负数并重算原发生日期的现金口径。实际退款不使用此操作。',required:['reason'],properties:{reason:{type:'string',title:'错误原因',minLength:1}},onSubmit:async data=>{await submitJSON('api/cash/'+encodeURIComponent(b.dataset.reverse)+'/reverse',data);await renderCashTab();}}));
}
function recordCash() {
  openSchemaForm({title:'独立收付款',description:'用于没有应收应付关联的真实收支。有关联的款项请从对应台账登记，避免重复。此操作不自动生成会计分录。',required:['direction','amount','counterparty','occurred_on'],properties:{direction:{type:'string',title:'方向',enum:['收款','付款']},amount:{type:'number',title:'金额（元）',minimum:0.01},counterparty:{type:'string',title:'交易对方',minLength:1},occurred_on:{type:'string',format:'date',title:'实际日期',default:localBusinessDate()},account:{type:'string',title:'账户'},note:{type:'string',title:'事由'}},onSubmit:async data=>{await submitJSON('api/cash',data);await renderCashTab();}});
}

/* ============ 发货与回款（M5）：已确认订单 → 预校验库存 → 出库 + 完成 ============ */
RENDER.delivery = async function () {
  const orders = (await apiJSON('api/orders').catch(() => ({ list: [] }))).list || [];
  const ready = orders.filter(o => o.status === '已确认');
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>发货与回款</h1></div>
    <div class="card"><table class="dtable">
      <tr><th>单号</th><th>客户</th><th style="text-align:right">金额</th><th>状态</th><th>操作</th></tr>
      ${ready.map(o => `<tr>
        <td><b>${esc(o.order_no)}</b></td><td>${esc(o.customer_name || '—')}</td><td class="num">${money(o.total_amount)}</td>
        <td><span class="tag">${esc(o.status)}</span></td>
        <td><button class="btn btn-sm" onclick="erpShip('${o.id}','${esc(o.order_no)}')">发货出库</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="wfail">没有待发货订单 —— 订单「确认」后出现在这里</td></tr>'}
    </table></div>`;
};
async function erpShip(id, no) {
  if (!confirm(`发货订单 ${no}？将按明细出库并标记完成（库存不足会被阻止）`)) return;
  try {
    const r = await api(`api/orders/${id}/ship`, { method: 'POST', body: '{}' }).then(x => x.json());
    if (!r.ok) return toast('发货失败', r.error || '');
    toast('已发货', `出库 ${r.shipped} 项 · 订单已完成 · 库存已扣减`);
    RENDER.delivery(); RENDER.orders();
  } catch (e) { toast('发货失败', e?.message || String(e)); }
}

async function renderBusinessTransfer() {
  const canImport=['admin','finance'].includes(currentUserInfo?.role);
  $('#fin-body').innerHTML=`<div class="card"><div class="card-bd"><h3>业务数据导入导出</h3><p class="cell-sub">使用 UTF-8 CSV，单次最多 1000 行。先导入往来单位，再导入期初应收应付；party_key 对应往来单位 external_key。kind 填客户、供应商或往来单位。金额单位为元；期初已结 settled 不算作本期到账。导出为对账用途，列结构可能与导入模板不同；流水 amount_minor 单位为分。</p><select id="transfer-kind"><option value="customers">往来单位</option><option value="receivables">期初应收</option><option value="payables">期初应付</option></select> ${canImport?'<button class="btn btn-ghost" id="transfer-template">下载模板</button><input type="file" id="transfer-file" accept=".csv,text/csv"><button class="btn btn-pri" id="transfer-preview">预览导入</button>':''}<h4>导出对账数据</h4>${['customers','receivables','payables','ledger','cash_movements'].map((k,i)=>`<a class="btn btn-ghost" href="api/data/export/${k}">${['往来单位','应收','应付','记账','收付款'][i]}</a>`).join(' ')}<div id="transfer-result" role="status"></div></div></div>`;
  if(!canImport) return;
  $('#transfer-template').onclick=()=>{location.href='api/data/templates/'+$('#transfer-kind').value;};
  $('#transfer-preview').onclick=async()=>{
    const out=$('#transfer-result'),file=$('#transfer-file').files[0];
    try {
      if(!file) throw new Error('请先选择 CSV 文件');if(file.size>1024*1024) throw new Error('文件不能超过 1MB');
      const r=await api('api/data/import/preview',{method:'POST',body:JSON.stringify({kind:$('#transfer-kind').value,csv:await file.text()})}).then(x=>x.json());
      if(!r.ok) throw new Error((r.errors || [r.error]).join('\n'));
      out.innerHTML=`<p>共 ${r.count} 行，以下展示前 10 行；${esc(r.notice)}</p><pre>${esc(JSON.stringify(r.sample,null,2))}</pre><button class="btn btn-pri" id="transfer-commit">确认整批导入</button>`;
      $('#transfer-commit').onclick=async()=>{const b=$('#transfer-commit');b.disabled=true;try{await submitJSON('api/data/import/'+encodeURIComponent(r.id)+'/commit',{});out.textContent='已导入 '+r.count+' 行。';}catch(e){out.append(document.createTextNode(e.message));b.disabled=false;}};
    }catch(e){out.textContent=e.message;}
  };
}
