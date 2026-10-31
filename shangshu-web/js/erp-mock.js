/* ==========================================================================
   template ERP 模块（严格复原 frontend-template/shangshu-os/erp.html）
   演示公司：银舟实业（五金建材 · 生产 + 贸易）
   数据故事线：恒泰报价 v3 → 成交将生单 → MO-0712 赶工 / MO-0715 缺料
   → 触发采购 PO-0098 → 月底应付永鑫 ¥86,000
   全部为演示数据（mock 徽标注明实装接哪张表/哪个里程碑）。
   ========================================================================== */

/* ============ 销售：客户 ============ */
const CUSTOMERS = [
  { n: '恒泰贸易', who: '孙立（老板）', amt: '120 万/年', stage: ['报价中', 'b'], last: '7/12 需求确认', due: '合同 7/31 到期', hot: true },
  { n: '蓝海制造', who: '周工', amt: '—', stage: ['报价中', 'b'], last: '7/14 发报价 · 未回复', due: '—' },
  { n: '明远咨询', who: '沈总', amt: '40 万/年', stage: ['已成交', 'g'], last: '7/15 积分增购', due: '—' },
  { n: '云启物流', who: '待定', amt: '—', stage: ['初次接触', 'n'], last: '7/16 首次电话', due: '—' },
];
function renderCustomers() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>客户</h1>
      <div class="acts"><button class="btn btn-ghost" onclick="toast('新增客户','也可以在对话页直接说：新增客户 XX（演示）')">＋ 新增客户</button></div></div>
    <div class="card">
      <table class="dtable">
        <tr><th>客户名称</th><th>决策人</th><th>年采购额</th><th>阶段</th><th>最近动态</th><th>提醒</th></tr>
        ${CUSTOMERS.map(c => `
          <tr class="row-link" onclick="toast('打开客户档案','${c.n} · 完整档案含证件/票据/沟通记录（演示）')">
            <td><b>${c.n}</b>${c.hot ? ' <span class="pill r" style="margin-left:4px">重点</span>' : ''}</td>
            <td class="ed" contenteditable onclick="event.stopPropagation()">${c.who}</td>
            <td class="num">${c.amt}</td>
            <td><span class="pill ${c.stage[1]}">${c.stage[0]}</span></td>
            <td>${c.last}</td>
            <td style="color:${c.hot ? 'var(--red)' : 'var(--fg3)'};font-size:11.5px">${c.due}</td>
          </tr>`).join('')}
      </table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">客户档案 · 恒泰贸易</span><span class="tag">AI 上下文 · Skill 执行前自动加载</span></div>
      <div class="card-bd">
        ${[['主营', '建材贸易 · 年采购约 120 万'], ['决策人', '<b>孙立</b>（老板）· 对含税价敏感'], ['需求', 'SKU 240 · 双仓 · 月结对账要花 3 天'], ['合同', 'HT-2025-114 · <b>2026-07-31 到期（14 天后）</b>'], ['沟通', '3 次拜访 · 最近 7/12 需求确认'], ['教训', '报价单需单独标注税额（#12）']]
          .map((f, i) => `<div class="frow" style="animation-delay:${i * .05}s"><span class="k">${f[0]}</span><span class="v">${f[1]}</span></div>`).join('')}
      </div>
    </div>`;
  $('#main').querySelectorAll('td.ed').forEach(el => el.addEventListener('blur', () => aiSense('客户资料')));
}

/* ============ 销售：报价与订单 ============ */
const QUOTE = { items: [40000, 8000], discount: 2400, saved: false };
function quoteTotals() {
  const sub = QUOTE.items.reduce((a, b) => a + b, 0);
  const total = sub - QUOTE.discount;
  const tax = Math.round(total * 0.13);
  return { sub, total, tax, grand: total + tax };
}
function renderOrders() {
  const { sub, total, tax, grand } = quoteTotals();
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>报价与订单</h1>
      <div class="acts">
        <button class="btn btn-ghost" onclick="toast('版本历史','v1 → v2 → v3 · 支持一键回滚（演示）')">历史版本</button>
        <button class="btn btn-pri" onclick="toast('已发送','报价单 v3 已发给孙立（演示）')">发送给客户</button>
      </div></div>
    <div class="ai-banner" id="ai-banner">
      <span>◈</span><span id="ai-banner-txt">AI：我注意到你调整了报价。</span>
      <span class="acts"><button class="b1" onclick="saveLesson()">记入实战教训</button><button class="b2" onclick="dismissBanner()">只此一次</button></span>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">报价单 · 恒泰贸易</span><span class="tag">AI 生成</span><span class="tag am">v3</span><span class="more" onclick="go('files')">关联文件 →</span></div>
      <div class="card-bd">
        <table class="dtable">
          <tr><th>项目</th><th>说明</th><th style="text-align:right">金额</th></tr>
          <tr><td>尚书·专业版</td><td>订阅 / 年 · FDE 上门 2 次/月</td><td class="num ed" contenteditable data-k="i0">${QUOTE.items[0].toLocaleString()}</td></tr>
          <tr><td>进销存 Skill 定制</td><td>一次性 · 含 240 SKU 迁移</td><td class="num ed" contenteditable data-k="i1">${QUOTE.items[1].toLocaleString()}</td></tr>
          <tr class="sub"><td>小计</td><td></td><td class="num" id="q-sub">${fmt(sub)}</td></tr>
          <tr class="sub"><td>年付折扣（95 折）</td><td class="ed" contenteditable style="font-size:11px">老客户续约</td><td class="num ed" contenteditable data-k="d">-${QUOTE.discount.toLocaleString()}</td></tr>
          <tr class="total"><td>合计（不含税）</td><td></td><td class="num" id="q-total">${fmt(total)}</td></tr>
          <tr class="sub"><td>税额（13%，单独标注）</td><td>实战教训 #12</td><td class="num" id="q-tax">${fmt(tax)}</td></tr>
          <tr class="total"><td>价税合计</td><td></td><td class="num" id="q-grand">${fmt(grand)}</td></tr>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">销售订单</span><span class="sub" style="font-size:11px;color:var(--fg3);margin-left:6px">成交后自动触发生产与出库</span></div>
      <table class="dtable">
        <tr><th>单号</th><th>客户</th><th>金额</th><th>状态</th><th>关联</th><th>更新</th></tr>
        <tr><td class="num">SO-2026-018</td><td>恒泰贸易<span class="cell-sub">报价 v3 待客户确认</span></td><td class="num">¥ 45,600</td><td><span class="pill a">待确认</span></td><td style="font-size:11.5px;color:var(--fg3)">成交后将占用 MO-0712 产能</td><td>今天</td></tr>
        <tr><td class="num">SO-2026-015</td><td>明远咨询</td><td class="num">¥ 11,000</td><td><span class="pill g">已回款</span></td><td style="font-size:11.5px;color:var(--fg3)">DL-0042 运输中</td><td>7/15</td></tr>
        <tr><td class="num">SO-2026-012</td><td>恒泰贸易（上期）</td><td class="num">¥ 30,000</td><td><span class="pill g">已完成</span></td><td style="font-size:11.5px;color:var(--fg3)">—</td><td>6/30</td></tr>
      </table>
    </div>`;
  $('#main').querySelectorAll('td.ed[data-k]').forEach(td => {
    td.addEventListener('blur', () => onQuoteEdit(td));
    td.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); td.blur(); } });
  });
}
function onQuoteEdit(td) {
  const num = parseInt(td.textContent.replace(/[^\d]/g, ''), 10);
  if (td.dataset.k === 'i0' && !isNaN(num)) QUOTE.items[0] = num;
  if (td.dataset.k === 'i1' && !isNaN(num)) QUOTE.items[1] = num;
  if (td.dataset.k === 'd' && !isNaN(num)) QUOTE.discount = num;
  const { sub, total, tax, grand } = quoteTotals();
  $('#q-sub').textContent = fmt(sub);
  $('#q-total').textContent = fmt(total);
  $('#q-tax').textContent = fmt(tax);
  $('#q-grand').textContent = fmt(grand);
  ['#q-sub', '#q-total', '#q-tax', '#q-grand'].forEach(s => { const el = $(s); el.classList.remove('flash'); el.offsetHeight; el.classList.add('flash'); });
  if (!QUOTE.saved) {
    $('#ai-banner-txt').textContent = `AI：我注意到你把不含税合计调整为 ${fmt(total)}，已重新算价。这个改法以后每次都用吗？`;
    setTimeout(() => $('#ai-banner').classList.add('show'), 700);
  } else aiSense('报价单');
}
function saveLesson() {
  QUOTE.saved = true;
  $('#ai-banner').classList.remove('show');
  toast('已记入实战教训 #13', '客户跟进流程 v2.3.1 → v2.3.2 · 全员自动生效');
}
function dismissBanner() { $('#ai-banner').classList.remove('show'); toast('好的', '仅本次生效，不写入教训'); }

/* ============ 销售：发货与回款 ============ */
function renderDelivery() {
  const canPay = currentUserInfo && ['admin', 'finance', 'manager'].includes(currentUserInfo.role);
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>发货与回款</h1></div>
    <div class="card">
      <div class="card-hd"><span class="t">发货单</span></div>
      <table class="dtable">
        <tr><th>单号</th><th>客户 / 内容</th><th>物流</th><th>状态</th><th>日期</th></tr>
        <tr><td class="num">DL-0042</td><td>明远咨询<span class="cell-sub">标准件 ×400</span></td><td>顺丰 SF-8892</td><td><span class="pill b">运输中 · 预计 7/18 达</span></td><td>7/16</td></tr>
        <tr><td class="num">DL-0041</td><td>恒泰贸易（上期）<span class="cell-sub">连接件 ×2,000</span></td><td>德邦 DB-2201</td><td><span class="pill g">已签收</span></td><td>7/02</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">回款记录</span><span class="more" onclick="go('payables')">${canPay ? '应收应付 →' : ''}</span></div>
      <table class="dtable">
        <tr><th>客户</th><th>金额</th><th>方式</th><th>状态</th><th>日期</th></tr>
        <tr><td>明远咨询</td><td class="num">¥ 11,000</td><td>对公转账</td><td><span class="pill g">已到账</span></td><td>7/15</td></tr>
        <tr><td>恒泰贸易（上期）</td><td class="num">¥ 30,000</td><td>对公转账</td><td><span class="pill g">已到账</span></td><td>6/30</td></tr>
        <tr><td>恒泰贸易（SO-2026-018）</td><td class="num">¥ 45,600</td><td>—</td><td><span class="pill a">待签约后开票</span></td><td>—</td></tr>
      </table>
    </div>`;
}

/* ============ 供应链：生产工单 ============ */
function renderProduction() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>生产工单</h1>
      <div class="acts"><button class="btn btn-ghost" onclick="toast('新建工单','对话页说「下一批连接件排产」即可（演示）')">＋ 新建工单</button></div></div>
    <div class="ai-note"><span class="spark">✦</span><div><b>AI 排产建议：</b>MO-0715 因碳钢棒料缺口 0.8 吨将停滞（PO-0098 预计 7/20 到货）。恒泰 SO-2026-018 一旦确认将占用装配线——建议 MO-0715 顺延 2 天，优先保障恒泰交期。<b>是否按此调整排产？</b></div>
      <span class="acts" style="margin-left:auto;display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-pri" style="font-size:11.5px;padding:5px 12px" onclick="this.closest('.ai-note').innerHTML='<span class=spark>✓</span><div>已调整：MO-0715 顺延至 7/22，装配线优先保障恒泰订单。已同步车间。</div>'">采纳调整</button>
      </span></div>
    <div class="mo-card">
      <div class="mo-hd"><span class="no">MO-0712</span><span class="t">不锈钢连接件</span><span class="qty">× 5,000 件</span><span class="pill b" style="margin-left:auto">进行中 · 65%</span></div>
      <div class="mo-bd">
        <div class="mo-prog"><i style="width:65%"></i></div>
        <div class="mo-steps">
          <div class="mo-step done"><span class="st-dot">✓</span>切割</div><div class="mo-line done"></div>
          <div class="mo-step done"><span class="st-dot">✓</span>打磨</div><div class="mo-line done"></div>
          <div class="mo-step cur"><span class="st-dot">▶</span>装配</div><div class="mo-line"></div>
          <div class="mo-step"><span class="st-dot">4</span>质检</div>
        </div>
        <div class="mo-meta"><span>开单 7/12 · 预计完工 <b>7/19</b></span><span style="color:var(--green2)">✓ 物料齐套</span><span>对应订单：恒泰 SO-2026-018（待确认）</span></div>
      </div>
    </div>
    <div class="mo-card">
      <div class="mo-hd"><span class="no">MO-0715</span><span class="t">六角螺栓 M8</span><span class="qty">× 20,000 件</span><span class="pill r" style="margin-left:auto">缺料预警</span></div>
      <div class="mo-bd">
        <div class="mo-prog"><i style="width:30%"></i></div>
        <div class="mo-steps">
          <div class="mo-step cur"><span class="st-dot">▶</span>切割</div><div class="mo-line"></div>
          <div class="mo-step"><span class="st-dot">2</span>滚丝</div><div class="mo-line"></div>
          <div class="mo-step"><span class="st-dot">3</span>热处理</div><div class="mo-line"></div>
          <div class="mo-step"><span class="st-dot">4</span>包装</div>
        </div>
        <div class="mo-meta"><span>开单 7/15 · 原计划 7/24 完工</span><span class="warn">✕ 缺料：碳钢棒料缺口 0.8 吨（PO-0098 · 7/20 到货）</span></div>
        <div class="mo-acts">
          <button class="btn btn-ghost" onclick="go('purchase')">查看采购单 PO-0098 →</button>
          <button class="btn btn-ghost" onclick="toast('已发起加急采购','加急单已推送采购负责人审批（演示）')">申请加急采购</button>
        </div>
      </div>
    </div>`;
}

/* ============ 供应链：库存（含盘点表——人工手写场景） ============ */
const STOCK_FIN = [
  { sku: 'FG-1001', n: '不锈钢连接件', wh: '成品仓', qty: 3200, unit: '件', warn: 1000 },
  { sku: 'FG-1002', n: '六角螺栓 M8', wh: '成品仓', qty: 8600, unit: '件', warn: 5000 },
  { sku: 'FG-1007', n: '定制支架（恒泰款）', wh: '成品仓', qty: 240, unit: '件', warn: 200 },
];
const STOCK_RAW = [
  { sku: 'RM-2001', n: '304 不锈钢板', wh: '原料仓', qty: 1.2, unit: '吨', warn: 0.5 },
  { sku: 'RM-2002', n: '碳钢棒料', wh: '原料仓', qty: 0.3, unit: '吨', warn: 1.0, low: true },
  { sku: 'RM-2005', n: '切削液', wh: '原料仓', qty: 14, unit: '桶', warn: 6 },
];
function stockRows(list) {
  return list.map(s => {
    const low = s.low || s.qty <= s.warn;
    return `<tr>
      <td class="num">${s.sku}</td><td><b>${s.n}</b></td><td>${s.wh}</td>
      <td class="num" style="${low ? 'color:var(--red);font-weight:bold' : ''}">${s.qty.toLocaleString()} ${s.unit}</td>
      <td class="num" style="color:var(--fg3)">${s.warn} ${s.unit}</td>
      <td>${low ? '<span class="pill r">低于预警</span>' : '<span class="pill g">正常</span>'}</td>
    </tr>`;
  }).join('');
}
function renderInventory() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>库存</h1>
      <div class="acts"><button class="btn btn-ghost" onclick="toast('导出','库存快照已导出（演示）')">导出</button></div></div>
    <div class="ai-note"><span class="spark">✦</span><div><b>AI 预警：</b>碳钢棒料仅剩 <b>0.3 吨</b>（预警线 1.0 吨），MO-0715 将在明天断料。PO-0098 预计 7/20 到货，可覆盖缺口。</div></div>
    <div class="card">
      <div class="card-hd"><span class="t">成品仓</span></div>
      <table class="dtable"><tr><th>SKU</th><th>品名</th><th>仓库</th><th style="text-align:right">现存</th><th style="text-align:right">预警线</th><th>状态</th></tr>${stockRows(STOCK_FIN)}</table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">原料仓</span></div>
      <table class="dtable"><tr><th>SKU</th><th>品名</th><th>仓库</th><th style="text-align:right">现存</th><th style="text-align:right">预警线</th><th>状态</th></tr>${stockRows(STOCK_RAW)}</table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">月末盘点表</span><span class="tag am">人工填写</span><span class="sub" style="font-size:11px;color:var(--fg3);margin-left:6px">像 Excel 一样直接写 · AI 自动比对差异</span></div>
      <div class="card-bd">
        <table class="dtable" id="count-table">
          <tr><th>SKU</th><th>品名</th><th style="text-align:right">账面</th><th style="text-align:right">实盘 ✎</th><th>差异</th></tr>
          ${STOCK_FIN.slice(0, 3).map((s, i) => `
            <tr><td class="num">${s.sku}</td><td>${s.n}</td>
            <td class="num">${s.qty.toLocaleString()}</td>
            <td class="num ed" contenteditable data-book="${s.qty}" data-n="${s.n}">${s.qty.toLocaleString()}</td>
            <td class="diff" style="font-size:12px;color:var(--fg3)">—</td></tr>`).join('')}
        </table>
      </div>
    </div>`;
  $('#main').querySelectorAll('#count-table td.ed').forEach(td => {
    td.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); td.blur(); } });
    td.addEventListener('blur', () => {
      const book = +td.dataset.book;
      const real = parseInt(td.textContent.replace(/[^\d]/g, ''), 10);
      const cell = td.closest('tr').querySelector('.diff');
      if (isNaN(real) || real === book) { cell.textContent = '—'; cell.style.color = 'var(--fg3)'; return; }
      const d = real - book;
      cell.innerHTML = d < 0 ? `<span class="pill r">盘亏 ${-d} 件</span>` : `<span class="pill a">盘盈 ${d} 件</span>`;
      td.classList.remove('flash'); td.offsetHeight; td.classList.add('flash');
      toast(`AI 发现${d < 0 ? '盘亏' : '盘盈'}：${td.dataset.n}`, `差异 ${Math.abs(d)} 件 · 已生成待确认的盘点差异单`);
    });
  });
}

/* ============ 供应链：采购 ============ */
function renderPurchase() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>采购</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('新建采购单','对话页说「订 1 吨碳钢棒料」即可（演示）')">＋ 新建采购单</button></div></div>
    <div class="card">
      <div class="card-hd"><span class="t">采购订单</span></div>
      <table class="dtable">
        <tr><th>单号</th><th>物料 / 供应商</th><th style="text-align:right">数量</th><th style="text-align:right">金额</th><th>状态</th><th>关联</th></tr>
        <tr><td class="num">PO-0098</td><td>碳钢棒料 · 永鑫金属</td><td class="num">2.0 吨</td><td class="num">¥ 86,000</td><td><span class="pill b">在途 · 7/20 到</span></td><td style="font-size:11.5px;color:var(--fg3)">补 MO-0715 缺口</td></tr>
        <tr><td class="num">PO-0099</td><td>304 不锈钢板 · 永鑫金属</td><td class="num">1.0 吨</td><td class="num">¥ 41,000</td><td><span class="pill a">到货待检</span></td><td style="font-size:11.5px;color:var(--fg3)">常规补库</td></tr>
        <tr><td class="num">PO-0095</td><td>标准紧固件 · 华标</td><td class="num">5,000 件</td><td class="num">¥ 12,400</td><td><span class="pill g">已入库</span></td><td style="font-size:11.5px;color:var(--fg3)">—</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">供应商</span></div>
      <table class="dtable">
        <tr><th>名称</th><th>供应内容</th><th>账期</th><th>评级</th><th>最近到货</th></tr>
        <tr><td><b>永鑫金属</b></td><td>板材 / 棒料</td><td>月结 30 天</td><td><span class="pill g">A</span></td><td>7/14 · 准时</td></tr>
        <tr><td><b>华标紧固件</b></td><td>标准件</td><td>款到发货</td><td><span class="pill b">B</span></td><td>7/05 · 晚 1 天</td></tr>
      </table>
    </div>`;
}

/* ============ 财务：发票报销 ============ */
function renderExpense() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>发票报销</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('拍照录入','请在对话页使用 ＋ 拍照（演示）')">＋ 拍照录入</button></div></div>
    <div class="grid-2">
      <div class="card">
        <div class="card-hd"><span class="t">发票识别结果</span><span class="tag">OCR · 本地模型</span><span class="tag am">置信度 98%</span></div>
        <div class="card-bd">
          ${[['发票号码', 'INV-2026-07153'], ['金额', '<b>¥ 4,120.00</b>'], ['税率', '13%'], ['开票日期', '2026-07-15'], ['费用类别', '<b>差旅费</b>（AI 按历史习惯归类）'], ['销售方', '杭州云栖酒店管理有限公司']]
            .map((f, i) => `<div class="frow" style="animation-delay:${i * .05}s"><span class="k">${f[0]}</span><span class="v">${f[1]}</span></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-hd"><span class="t">报销单 RB-2026-054</span><span class="tag bl">AI 预审已通过</span></div>
        <div class="card-bd">
          ${[['报销人', '陈晓 · 销售部'], ['事由', '7/15 恒泰贸易上门拜访 · 住宿'], ['金额', '<b>¥ 4,120.00</b>'], ['审批流', '直属上级 → 财务'], ['状态', '<b>待提交</b>']]
            .map((f, i) => `<div class="frow" style="animation-delay:${i * .05}s"><span class="k">${f[0]}</span><span class="v">${f[1]}</span></div>`).join('')}
          <div style="margin-top:12px"><button class="btn btn-pri" onclick="this.outerHTML='<span class=&quot;pill g&quot;>✓ 已提交审批</span>';toast('报销已提交','发票原件自动归档')">提交报销</button></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">历史报销</span></div>
      <table class="dtable">
        <tr><th>单号</th><th>事由</th><th>金额</th><th>状态</th><th>日期</th></tr>
        <tr><td class="num">RB-2026-053</td><td>市内交通</td><td class="num">¥ 860</td><td><span class="pill g">已打款</span></td><td>7/10</td></tr>
        <tr><td class="num">RB-2026-049</td><td>客户招待</td><td class="num">¥ 2,300</td><td><span class="pill g">已打款</span></td><td>7/02</td></tr>
      </table>
    </div>`;
}

/* ============ 财务：应收应付 ============ */
function renderPayables() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>应收应付</h1></div>
    <div class="grid-2">
      <div class="card">
        <div class="card-hd"><span class="t">应收</span><span class="tag">合计 ¥45,600</span></div>
        <table class="dtable">
          <tr><th>客户</th><th style="text-align:right">金额</th><th>到期</th><th>状态</th></tr>
          <tr><td>恒泰贸易（SO-2026-018）</td><td class="num">¥ 45,600</td><td>签约后开票</td><td><span class="pill a">待确认</span></td></tr>
          <tr><td>明远咨询</td><td class="num">¥ 11,000</td><td>—</td><td><span class="pill g">已清</span></td></tr>
        </table>
      </div>
      <div class="card">
        <div class="card-hd"><span class="t">应付</span><span class="tag am">合计 ¥86,000</span></div>
        <table class="dtable">
          <tr><th>供应商</th><th style="text-align:right">金额</th><th>到期</th><th>状态</th></tr>
          <tr><td>永鑫金属（PO-0098）</td><td class="num">¥ 86,000</td><td style="color:var(--red)">7/31</td><td><span class="pill a">月结待付</span></td></tr>
          <tr><td>华标紧固件</td><td class="num">¥ 12,400</td><td>—</td><td><span class="pill g">已付</span></td></tr>
        </table>
      </div>
    </div>
    <div class="ai-note"><span class="spark">✦</span><div><b>AI 现金流提示：</b>7/31 永鑫应付 ¥86,000 与恒泰合同到期同日。若恒泰 SO-2026-018 在本周签约并收 30% 预付款（¥13,680），月底现金压力可覆盖。</div></div>`;
}

/* ============ 文件：文档 / 文件库 ============ */
function renderDocs() {
  const isProd = DEMO_ROLE === 'prod';
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>文档</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('已发送','${isProd ? '生产日报已发车间与老板' : '周报已发老板和管理层'}（演示）')">发送</button></div></div>
    <div class="card">
      <div class="card-hd"><span class="t">${isProd ? '生产日报 · 7月17日' : '销售周报 · 7月第3周'}</span><span class="tag">AI 汇总</span></div>
      <div class="card-bd">
        <div class="doc-page" contenteditable>${isProd ? `
          <h4>一、工单进度</h4>
          <ul><li>MO-0712 不锈钢连接件：65%，装配工序进行中，预计 7/19 完工</li>
          <li>MO-0715 六角螺栓：30%，<b>缺料预警</b>（碳钢棒料缺口 0.8 吨）</li></ul>
          <h4>二、到料与库存</h4>
          <ul><li>PO-0099 不锈钢板已到货，待质检入库</li>
          <li>碳钢棒料现存 0.3 吨，低于预警线</li></ul>
          <h4>三、AI 建议</h4>
          <ul><li>MO-0715 顺延 2 天，装配线优先保障恒泰订单</li></ul>` : `
          <h4>一、客户进展</h4>
          <ul><li>恒泰贸易：进入方案报价，报价单 v3 已发出，签约概率 78%</li>
          <li>蓝海制造：报价发出 3 天未反馈，已生成跟进话术</li>
          <li>明远咨询：积分增购 5,000 已审批通过</li></ul>
          <h4>二、数据</h4>
          <ul><li>新增客户 2 · 报价 3 份共 ¥118,600 · 回款 ¥20,000</li></ul>
          <h4>三、AI 建议</h4>
          <ul><li>恒泰周五前敲定签约，避免跨月账期</li>
          <li>蓝海改用「上门演示」切入，而非再发文字版报价</li></ul>`}
        </div>
      </div>
    </div>`;
  $('#main').querySelector('.doc-page').addEventListener('blur', () => aiSense('文档'), true);
}
function renderFiles() {
  const groups = [
    { name: '恒泰贸易', files: [
      { n: '报价单 v3.pdf', i: 'f-pdf', ic: 'PDF', m: 'AI 生成 · 税额单独标注', t: '10:24' },
      { n: '需求确认纪要-0712.doc', i: 'f-doc', ic: '文', m: 'AI 生成', t: '7/12' },
      { n: '营业执照.jpg', i: 'f-img', ic: '图', m: 'OCR 已归档', t: '6/28' },
      { n: 'HT-2025-114 合同.pdf', i: 'f-pdf', ic: 'PDF', m: '7月31日到期', t: '6/20' },
    ]},
    { name: '生产', files: [
      { n: 'MO-0712 工艺卡.pdf', i: 'f-pdf', ic: 'PDF', m: '不锈钢连接件 · 4 道工序', t: '7/12' },
      { n: '连接件图纸-v4.dwg', i: 'f-img', ic: '图', m: '恒泰定制款', t: '7/08' },
    ]},
    { name: '陈晓 / 票据', files: [
      { n: 'INV-2026-07153 发票.jpg', i: 'f-img', ic: '图', m: '¥4,120 · 已关联 RB-2026-054', t: '7/15' },
    ]},
  ];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>文件库</h1></div>
    ${groups.map(g => `
      <div class="fg-name">${g.name}</div>
      ${g.files.map((f, i) => `
        <div class="file-item" style="animation-delay:${i * .05}s" onclick="toast('预览','${f.n}（演示）')">
          <div class="file-ico ${f.i}">${f.ic}</div>
          <div><div class="file-name">${f.n}</div><div class="file-meta">${f.m}</div></div>
          <div class="file-time">${f.t}</div>
        </div>`).join('')}`).join('')}`;
}

/* ============ 管理：Skill 管理 ============ */
const ENT_SKILLS = [
  { n: '客户跟进流程', v: 'v2.3.2', users: '陈晓 · 李婷', runs: 34, ok: '97%', lessons: 13, on: true },
  { n: '报价管理', v: 'v1.8.0', users: '陈晓 · 李婷', runs: 21, ok: '95%', lessons: 5, on: true },
  { n: '生产排程', v: 'v1.2.6', users: '王强', runs: 18, ok: '94%', lessons: 4, on: true },
  { n: '库存盘点', v: 'v1.0.9', users: '王强 · 仓管', runs: 9, ok: '100%', lessons: 2, on: true },
  { n: '合同签署', v: 'v1.4.2', users: '陈晓', runs: 6, ok: '100%', lessons: 2, on: true },
  { n: '发票报销', v: 'v3.0.1', users: '全员', runs: 58, ok: '98%', lessons: 8, on: true },
];
function renderSkillsMock() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>Skill 管理</h1>
      <div class="acts"><button class="btn btn-ghost" onclick="toast('Skill 市场','47 个可安装（演示）')">Skill 市场</button>
      <button class="btn btn-pri" onclick="toast('对话式创建','到对话页描述业务流程，AI 帮你生成 Skill（演示）')">＋ 对话式创建</button></div></div>
    <div class="card">
      <table class="dtable">
        <tr><th>Skill</th><th>版本</th><th>已配员工</th><th>执行</th><th>成功率</th><th>实战教训</th><th>状态</th></tr>
        ${ENT_SKILLS.map(s => `
          <tr>
            <td><b>${s.n}</b></td><td class="num">${s.v}</td><td>${s.users}</td>
            <td class="num">${s.runs} 次</td><td class="num">${s.ok}</td>
            <td><span class="pill b">${s.lessons} 条</span></td>
            <td><label class="switch" style="margin:0"><input type="checkbox" ${s.on ? 'checked' : ''} onchange="toast(this.checked?'Skill 已上线':'Skill 已下线','${s.n}')"><i></i></label></td>
          </tr>`).join('')}
      </table>
    </div>
    <div class="card">
      <div class="card-hd"><span class="t">实战教训库</span><span class="sub" style="font-size:11px;color:var(--fg3);margin-left:6px">踩过的坑，所有后续执行自动避开</span></div>
      <div class="card-bd">
        ${[['#13', '恒泰报价按手动调整口径执行，折扣变动需注明「战略客户专项」', '今天 · 陈晓的 Agent 沉淀'],
           ['#12', '恒泰贸易对含税价敏感，报价单必须单独标注税额', '上周 · 全员生效中'],
           ['#09', '碳钢棒料低于 1 吨时提前 5 天触发采购，不等断料', '7/02 · 生产排程 Skill'],
           ['#08', '报价发出 3 天未回复时，电话切入优于再发文字版', '7/05 · 全员生效中']]
          .map((l, i) => `<div class="frow" style="animation-delay:${i * .05}s"><span class="k" style="font-family:var(--mono)">${l[0]}</span><span class="v">${l[1]}<div style="font-size:10.5px;color:var(--fg3);margin-top:2px">${l[2]}</div></span></div>`).join('')}
      </div>
    </div>`;
}

/* ============ 管理：数字员工 ============ */
const STAFF = [
  { id: 'chen', name: '陈晓', role: '销售', color: '#2E5E4E',
    skills: [{ n: '客户跟进流程', on: true }, { n: '报价管理', on: true }, { n: '合同签署', on: true }, { n: '发票报销', on: true }, { n: '周报汇总', on: false }],
    memory: ['恒泰贸易孙立对含税价敏感，报价单必须单独标注税额', '陈晓习惯上午拜访客户，日程优先排 10:00-12:00', '报价口径：年付统一 95 折，老客户可再谈'],
    approvals: [
      { kind: '实战教训', cls: '', from: '陈晓的 Agent · 今天 10:31', body: '<b>恒泰报价按手动调整口径执行</b>：折扣由 95 折改为 9 折时，需注明「战略客户专项」。', why: 'Agent 理由：陈晓手动改价后确认有效，建议沉淀为默认行为。' },
      { kind: '客户偏好', cls: 'bl', from: '陈晓的 Agent · 昨天 17:20', body: '蓝海制造周工<b>不接 15:00 后的电话</b>，联系窗口为 9:30-11:30。', why: 'Agent 理由：近 3 次 15:00 后拨打均未接通，上午 2 次均接通。' },
    ] },
  { id: 'wq', name: '王强', role: '生产主管', color: '#8A5A2B',
    skills: [{ n: '生产排程', on: true }, { n: '库存盘点', on: true }, { n: '发票报销', on: true }],
    memory: ['装配线优先保障恒泰订单（孙总 7/10 指示）', 'MO 工单缺料超过 1 天时必须当天上报'],
    approvals: [
      { kind: '排产规则', cls: '', from: '王强的 Agent · 今天 08:20', body: '缺料工单<b>优先顺延非客户定制件</b>，标准件库存可支撑贸易单 5 天。', why: 'Agent 理由：近 2 次缺料均按此原则处理，孙总未提出异议。' },
    ] },
  { id: 'li', name: '李婷', role: '销售', color: '#4A78B8',
    skills: [{ n: '客户跟进流程', on: true }, { n: '发票报销', on: true }],
    memory: ['李婷负责的客户以物流行业为主，报价用物流版模板'],
    approvals: [{ kind: '实战教训', cls: '', from: '李婷的 Agent · 昨天', body: '云启物流偏好<b>先用 1 个月试用版</b>再谈年付。', why: 'Agent 理由：云启明确表达过该意向，同行业 2 家客户同样如此。' }] },
];
let curStaff = STAFF[0], agentTab = 'skills';
function agentPendingCount() { return STAFF.reduce((a, s) => a + s.approvals.filter(x => !x.state).length, 0); }
function renderAgents() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>数字员工</h1></div>
    <div class="staff-strip">
      ${STAFF.map((s, i) => `
        <div class="staff-chip ${s.id === curStaff.id ? 'on' : ''}" style="animation-delay:${i * .06}s" onclick="pickStaff('${s.id}')">
          <span class="ava" style="background:${s.color}">${s.name[0]}</span>
          <div><div class="n">${s.name}</div><div class="s">${s.role} · ${s.skills.filter(k => k.on).length} Skill</div></div>
        </div>`).join('')}
      <div class="staff-chip" style="border-style:dashed;color:var(--fg3)" onclick="toast('新增员工','入职自动创建数字分身并加载岗位 Skill 包（演示）')"><div class="n" style="font-weight:normal">＋ 新增员工</div></div>
    </div>
    <div class="sub-tabs">
      <button class="sub-tab ${agentTab === 'skills' ? 'on' : ''}" onclick="agentTab='skills';renderAgents()">已配 Skill</button>
      <button class="sub-tab ${agentTab === 'memory' ? 'on' : ''}" onclick="agentTab='memory';renderAgents()">Agent 记忆</button>
      <button class="sub-tab ${agentTab === 'approve' ? 'on' : ''}" onclick="agentTab='approve';renderAgents()">入库审批${curStaff.approvals.filter(a => !a.state).length ? `<span class="bdg">${curStaff.approvals.filter(a => !a.state).length}</span>` : ''}</button>
    </div>
    <div id="agent-pane"></div>`;
  const pane = $('#agent-pane');
  if (agentTab === 'skills') {
    pane.innerHTML = curStaff.skills.map((s, i) => `
      <div class="mem-item" style="animation-delay:${i * .05}s;align-items:center">
        <span class="mi">☷</span><div style="flex:1;font-size:13px;font-weight:${s.on ? 'bold' : 'normal'};opacity:${s.on ? 1 : .5}">${s.n}</div>
        <label class="switch"><input type="checkbox" ${s.on ? 'checked' : ''} onchange="curStaff.skills[${i}].on=this.checked;toast(this.checked?'Skill 已启用':'Skill 已停用','${s.n}')"><i></i></label>
      </div>`).join('') +
      `<div class="add-row" onclick="toast('分配 Skill','从企业 Skill 库中选择（演示）')">＋ 从 Skill 库分配</div>`;
  } else if (agentTab === 'memory') {
    pane.innerHTML = `
      <div class="mem-note">◈ <b>记忆决定 Agent 的行为偏好。</b>点击文字直接修改，Agent 下次执行立刻生效。</div>
      ${curStaff.memory.map((m, i) => `
        <div class="mem-item" style="animation-delay:${i * .05}s">
          <span class="mi">◆</span><div class="mem-txt" contenteditable data-i="${i}">${m}</div>
          <button class="mem-del" onclick="curStaff.memory.splice(${i},1);renderAgents();toast('记忆已删除','Agent 将立即遗忘')">✕</button>
        </div>`).join('')}
      <div class="add-row" onclick="curStaff.memory.push('新记忆（点击编辑）');renderAgents()">＋ 添加一条记忆</div>`;
    pane.querySelectorAll('.mem-txt').forEach(el => el.addEventListener('blur', () => { curStaff.memory[+el.dataset.i] = el.textContent.trim(); toast('记忆已更新', 'Agent 下次执行立即生效'); }));
  } else {
    pane.innerHTML = `
      <div class="mem-note">◈ <b>入库审批：Agent 想把新学到的东西写进企业知识库，由你把关。</b>批准后全员 Agent 同步生效。</div>
      ${curStaff.approvals.length ? curStaff.approvals.map((a, i) => `
        <div class="ap-card ${a.state || ''}" style="animation-delay:${i * .06}s">
          <div class="ap-head"><span class="tag ${a.cls}">${a.kind}</span><span class="ap-from">${a.from}</span></div>
          <div class="ap-body">${a.body}</div>
          <div class="ap-why">${a.why}</div>
          ${a.state ? `<div class="ap-result ${a.state === 'approved' ? 'ok' : 'no'}">${a.state === 'approved' ? '✓ 已批准入库 · 全员 Agent 同步生效' : '✕ 已拒绝 · 已反馈给 Agent'}</div>` : `
          <div class="ap-acts">
            <button class="ap-btn ap-ok" onclick="agentDecide(${i},true)">批准入库</button>
            <button class="ap-btn ap-no" onclick="agentDecide(${i},false)">拒绝</button>
          </div>`}
        </div>`).join('') : '<div class="mem-note" style="background:var(--accd);border-color:#D3E5DA;color:var(--green2)">✓ 该员工的 Agent 暂无待审批内容</div>'}`;
  }
  markMock('演示页：数字员工/Agent 记忆/入库审批为 v1.6 规划（PRD 数字分身），当前为示例数据。');
}
function pickStaff(id) { curStaff = STAFF.find(s => s.id === id); renderAgents(); }
function agentDecide(i, ok) {
  curStaff.approvals[i].state = ok ? 'approved' : 'rejected';
  renderAgents();
  toast(ok ? '已批准入库' : '已拒绝', ok ? '写入企业知识库 · 全员 Agent 同步' : '拒绝理由已反馈给 Agent');
}

/* ============ 日程：日历（任务与截止自动来自 Skill 执行） ============ */
const CAL_TYPES = { 客户: 'b', 工单: 'g', 采购: 'a', 财务: 'a', 审批: 'r', 死线: 'r', 汇报: 'n', 会议: 'b', 交付: 'g', 库存: 'a' };
const CAL_TASKS = {
  staff: [
    { d: '2026-07-17', t: '发送恒泰报价单 v3', time: '10:00', type: '客户', from: '客户跟进流程' },
    { d: '2026-07-17', t: '蓝海制造电话跟进', time: '14:00', type: '客户', from: 'AI 建议话术' },
    { d: '2026-07-18', t: '提交本周周报', time: '17:00', type: '汇报', from: '周报汇总 Skill' },
    { d: '2026-07-20', t: '回访明远咨询交付情况', time: '09:30', type: '客户' },
    { d: '2026-07-21', t: '恒泰贸易第 4 次拜访', time: '10:00', type: '客户' },
    { d: '2026-07-24', t: '云启物流需求确认会', time: '15:00', type: '会议' },
    { d: '2026-07-31', t: '恒泰合同到期 · 签约死线', type: '死线', from: '合同签署 Skill' },
  ],
  prod: [
    { d: '2026-07-17', t: 'PO-0099 不锈钢板质检入库', time: '11:00', type: '采购' },
    { d: '2026-07-18', t: 'MO-0712 质检工序', time: '09:00', type: '工单' },
    { d: '2026-07-18', t: 'MO-0715 预计断料日', type: '死线', from: '生产排程 Skill' },
    { d: '2026-07-20', t: 'PO-0098 碳钢棒料到货', type: '采购' },
    { d: '2026-07-22', t: 'MO-0715 复工 · 恢复排产', time: '08:30', type: '工单' },
    { d: '2026-07-24', t: 'MO-0715 原定交期', type: '死线' },
    { d: '2026-07-31', t: '月末盘点', time: '16:00', type: '库存', from: '库存盘点 Skill' },
  ],
  boss: [
    { d: '2026-07-17', t: '审批：王强排产调整', type: '审批', from: '数字员工' },
    { d: '2026-07-17', t: '审批：实战教训 #13 入库', type: '审批', from: '数字员工' },
    { d: '2026-07-20', t: '经营周会', time: '09:30', type: '会议' },
    { d: '2026-07-27', t: '经营周会', time: '09:30', type: '会议' },
    { d: '2026-07-31', t: '恒泰合同到期', type: '死线' },
    { d: '2026-07-31', t: '永鑫金属应付 ¥86,000', type: '财务' },
    { d: '2026-08-05', t: 'FDE 月度上门 · 恒泰', type: '交付' },
  ],
};
const CAL_NOTE = {
  staff: '<b>AI 排期建议：</b>恒泰报价今天 10:00 前发出——周五前签约可避免跨月账期。已把「蓝海电话跟进」排在下午对方惯例空闲时段。',
  prod: '<b>AI 排期提醒：</b>明天是 MO-0715 预计断料日，PO-0098 到货（7/20）前不要给切割工序排班；月末盘点已与工单错峰。',
  boss: '<b>AI 提醒：</b>7/31 是双重死线——恒泰合同到期 + 永鑫应付 ¥86,000。本周签掉恒泰并收预付款，月底现金压力即可覆盖。',
};
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const TODAY_DS = '2026-07-17';
let calView = 'month', calY = 2026, calM = 6, calSel = TODAY_DS;
const pad2 = n => String(n).padStart(2, '0');
const dsOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const tasksOn = ds => CAL_TASKS[DEMO_ROLE].filter(t => t.d === ds);

function renderCalendar() {
  let title = '', body = '';
  if (calView === 'month') { title = `${calY} 年 ${calM + 1} 月`; body = calMonthHtml(); }
  else if (calView === 'day') {
    const [y, m, d] = calSel.split('-').map(Number);
    title = `${m} 月 ${d} 日 · 周${WD[new Date(y, m - 1, d).getDay()]}`;
    body = calDayHtml();
  } else { title = `${calY} 年`; body = calYearHtml(); }
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>日历</h1></div>
    <div class="ai-note"><span class="spark">✦</span><div>${CAL_NOTE[DEMO_ROLE]}</div></div>
    <div class="cal-bar">
      <button class="nav-b" onclick="calNav(-1)">‹</button>
      <div class="cal-title">${title}</div>
      <button class="nav-b" onclick="calNav(1)">›</button>
      <button class="btn btn-ghost" style="padding:5px 11px;font-size:11.5px" onclick="calToday()">回到今天</button>
      <div class="cal-tabs">
        ${[['day', '日'], ['month', '月'], ['year', '年']].map(v => `<button class="cal-tab ${calView === v[0] ? 'on' : ''}" onclick="calSetView('${v[0]}')">${v[1]}</button>`).join('')}
      </div>
    </div>
    ${body}
    ${calView !== 'year' ? calAgendaHtml() : ''}`;
  markMock('演示页：日程数据为示例（银舟实业故事线，今天=2026-07-17）。日历为 v1.6 规划。');
}
function calMonthHtml() {
  const off = new Date(calY, calM, 1).getDay();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const dt = new Date(calY, calM, 1 - off + i);
    const ds = dsOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const ts = tasksOn(ds);
    cells += `<div class="cal-cell ${dt.getMonth() !== calM ? 'dim' : ''} ${ds === TODAY_DS ? 'today' : ''} ${ds === calSel ? 'sel' : ''}" style="animation-delay:${i * .012}s" onclick="calPick('${ds}')">
      <span class="d-num">${dt.getDate()}</span>
      ${ts.slice(0, 2).map(t => `<span class="cal-ev ${CAL_TYPES[t.type]}">${t.t}</span>`).join('')}
      ${ts.length > 2 ? `<div class="cal-more">+${ts.length - 2} 项</div>` : ''}
    </div>`;
  }
  return `<div class="cal-grid">${WD.map(w => `<div class="cal-wd">${w}</div>`).join('')}${cells}</div>`;
}
function calDayHtml() {
  const ts = tasksOn(calSel);
  const allDay = ts.filter(t => !t.time), timed = ts.filter(t => t.time);
  let rows = '';
  for (let h = 8; h <= 19; h++) {
    const evs = timed.filter(t => parseInt(t.time) === h);
    rows += `<div class="day-row"><div class="day-h">${pad2(h)}:00</div><div class="day-body">
      ${evs.map((t, i) => `<div class="day-ev ${CAL_TYPES[t.type]}" style="animation-delay:${i * .06}s"><b>${t.time}</b>　${t.t}${t.from ? `<span class="de-from">来自 ${t.from}</span>` : ''}</div>`).join('')}
    </div></div>`;
  }
  return `${allDay.length ? `<div class="day-allday">${allDay.map((t, i) => `<span class="cal-ev ${CAL_TYPES[t.type]}" style="animation-delay:${i * .06}s">全天 · ${t.t}</span>`).join('')}</div>` : ''}
    <div class="card"><div class="card-bd" style="padding:8px 16px">${rows}</div></div>`;
}
function calYearHtml() {
  return `<div class="year-grid">${Array.from({ length: 12 }, (_, m) => {
    const off = new Date(calY, m, 1).getDay(), dim = new Date(calY, m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < off; i++) cells += '<span class="ym-d"></span>';
    for (let d = 1; d <= dim; d++) {
      const ds = dsOf(calY, m, d), ts = tasksOn(ds);
      cells += `<span class="ym-d ${ds === TODAY_DS ? 'td' : ''} ${ts.length ? 'has' : ''} ${ts.some(t => CAL_TYPES[t.type] === 'r') ? 'hot' : ''}">${d}</span>`;
    }
    const cnt = CAL_TASKS[DEMO_ROLE].filter(t => +t.d.slice(5, 7) === m + 1).length;
    return `<div class="ym-card" style="animation-delay:${m * .04}s" onclick="calGotoMonth(${m})">
      <div class="t">${m + 1} 月${cnt ? `<span class="ym-cnt">${cnt} 项</span>` : ''}</div>
      <div class="ym-grid">${cells}</div>
    </div>`;
  }).join('')}</div>`;
}
function calAgendaHtml() {
  const ts = tasksOn(calSel);
  const [y, m, d] = calSel.split('-').map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `<div class="card cal-agenda">
    <div class="card-hd"><span class="t">${m} 月 ${d} 日 · 周${wd}</span><span class="sub" style="font-size:11px;color:var(--fg3);margin-left:6px">${ts.length ? ts.length + ' 项安排' : '暂无安排 · 对 Agent 说「帮我排个会」即可创建'}</span></div>
    ${ts.length ? `<table class="dtable">${ts.map(t => `
      <tr><td style="width:76px" class="num">${t.time || '全天'}</td>
      <td><b>${t.t}</b>${t.from ? `<span class="cell-sub">来自 ${t.from}</span>` : ''}</td>
      <td style="width:76px"><span class="pill ${CAL_TYPES[t.type]}">${t.type}</span></td></tr>`).join('')}</table>` : ''}
  </div>`;
}
function calNav(dir) {
  if (calView === 'month') { calM += dir; if (calM < 0) { calM = 11; calY--; } if (calM > 11) { calM = 0; calY++; } }
  else if (calView === 'year') calY += dir;
  else { const [y, m, d] = calSel.split('-').map(Number); const dt = new Date(y, m - 1, d + dir); calSel = dsOf(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
  renderCalendar();
}
function calSetView(v) { calView = v; renderCalendar(); }
function calPick(ds) { calSel = ds; const [y, m] = ds.split('-').map(Number); calY = y; calM = m - 1; if (calView === 'year') calView = 'month'; renderCalendar(); }
function calGotoMonth(m) { calM = m; calView = 'month'; renderCalendar(); }
function calToday() { calY = 2026; calM = 6; calSel = TODAY_DS; renderCalendar(); }

/* ============ 工具 ============ */
const TOOLS_DATA = {
  'tools-logo': {
    name: 'Logo 简化器', icon: 'wand',
    color: 'linear-gradient(135deg,#7C3AED,#A855F7)',
    desc: '基于尚书 AI 基座的<b>图生图</b>能力，一键简化 Logo 为极线稿 / 单色版本，适配不同场景。',
    features: ['上传任意格式 Logo（PNG/SVG/JPG）', '自动生成 3 种简化方案：线稿 / 单色 / 反色', '支持批量导出 SVG + PNG（含透明底）', '自动适配 ERP 系统内各处 Logo 尺寸'],
    tag: 'AI 基座', tagCls: '',
  },
  'tools-crawl': {
    name: '行业情报', icon: 'globe',
    color: 'linear-gradient(135deg,#0369A1,#0EA5E9)',
    desc: '自动爬取五金建材行业动态、竞品报价、政策变化，<b>每周生成行业简报</b>推送给相关角色。',
    features: ['覆盖 200+ 行业网站 & B2B 平台', 'AI 自动过滤噪音，提炼关键变化', '按客户/产品维度定制监控范围', '简报自动归档至 ERP 文档模块'],
    tag: '自动爬取', tagCls: 'bl',
  },
  'tools-site': {
    name: '独立站管理', icon: 'chart',
    color: 'linear-gradient(135deg,#059669,#10B981)',
    desc: '尚书基座上的<b>独立站数据看板</b>，实时查看访问量、询盘、转化率等核心指标。',
    features: ['实时流量 & 访客来源分析', '询盘自动同步至 ERP 客户模块', '热门产品排行 & 跳出率预警', 'AI 自动生成运营建议'],
    tag: '数据看板', tagCls: 'g',
  },
  'tools-img': {
    name: '商品图生成', icon: 'image',
    color: 'linear-gradient(135deg,#C2410C,#F97316)',
    desc: 'AI<b>一键生成商品主图 / 场景图 / 详情页图</b>，用于独立站、阿里国际站、1688 等平台。',
    features: ['上传产品实拍，AI 自动抠图 + 换背景', '支持白底图 / 场景图 / 模特图 3 种风格', '批量生成，一次最多 50 张', '尺寸自动适配各电商平台规范'],
    tag: 'AI 生成', tagCls: 'am',
  },
};
function renderTool(id) {
  const t = TOOLS_DATA[id];
  const features = t.features.map(f => `<li>${f}</li>`).join('');
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>${t.name}</h1><span class="tag ${t.tagCls}">${t.tag}</span></div>
    <div class="tool-card" style="animation-delay:.05s">
      <div class="tool-card-hd">
        <div class="ico" style="background:${t.color}">${ICONS[t.icon]}</div>
        <div class="t">${t.name}</div>
      </div>
      <div class="tool-card-bd">
        <p>${t.desc}</p>
        <ul>${features}</ul>
        <div class="tool-card-acts">
          <button class="btn btn-pri" onclick="toast('${t.name}','演示环境，接入尚书 AI 基座后可用')">启动工具</button>
          <button class="btn btn-ghost" onclick="toast('帮助文档','文档将在正式版中提供')">查看文档</button>
        </div>
      </div>
    </div>
    <div class="ai-note" style="animation-delay:.15s">
      <span class="spark">✦</span>
      <span>该工具基于<b>尚书 AI 基座</b>运行，支持在对话页通过 <b>/${t.name}</b> 直接调用。工具产出自动同步至 ERP 相关模块。</span>
    </div>
    <div class="card" style="animation-delay:.2s">
      <div class="card-hd"><span class="t">最近使用记录</span></div>
      <div class="card-bd" style="font-size:12.5px;color:var(--fg3);padding:18px 16px;text-align:center;">
        暂无使用记录。启动工具后，执行历史将在此展示。
      </div>
    </div>`;
  markMock('演示页：v1.6+ 增值件（AI 基座工具），当前不排期。');
}

/* ============ 沟通：即时通讯 ============ */
const CONTACTS = [
  { id: 'chen', name: '陈晓', role: '销售', color: '#2E5E4E', avatar: '陈' },
  { id: 'wang', name: '王强', role: '生产主管', color: '#8A5A2B', avatar: '王' },
  { id: 'li', name: '李婷', role: '销售', color: '#4A78B8', avatar: '李' },
  { id: 'sun', name: '孙总', role: '老板', color: '#1B3A2D', avatar: '孙' },
  { id: 'fang', name: '王芳', role: '财务', color: '#B45309', avatar: '芳' },
];
function getContact(id) { return CONTACTS.find(c => c.id === id); }

const CHATS = [
  { id: 'g-sales', type: 'group', name: '销售部', members: ['chen', 'li', 'sun'], unread: 2, role: ['staff', 'boss'] },
  { id: 'g-prod', type: 'group', name: '生产部', members: ['wang', 'sun'], unread: 0, role: ['prod', 'boss'] },
  { id: 'g-all', type: 'group', name: '银舟全员', members: ['chen', 'wang', 'li', 'sun', 'fang'], unread: 5, role: ['staff', 'prod', 'boss'] },
  { id: 'dm-sun-chen', type: 'dm', peer: 'chen', unread: 1, role: ['staff', 'boss'] },
  { id: 'dm-chen-wang', type: 'dm', peer: 'wang', unread: 0, role: ['staff', 'prod', 'boss'] },
  { id: 'dm-sun-wang', type: 'dm', peer: 'wang', unread: 0, role: ['prod', 'boss'] },
];
function getChats() { return CHATS.filter(c => c.role.includes(DEMO_ROLE)); }

const MESSAGES = {
  'g-sales': [
    { from: 'chen', text: '恒泰的报价单我已经改好了，9 折 + 税额单独标注', time: '09:15', ai: false },
    { from: 'li', text: '收到，蓝海那边周工还没回我，我下午再跟一下', time: '09:18', ai: false },
    { from: 'sun', text: '陈晓，恒泰 7/31 合同到期，这周必须推进签约', time: '09:22', ai: false },
    { from: 'chen', text: '收到孙总，今天下午约了孙立面谈', time: '09:24', ai: false },
    { from: 'ai', text: '✦ 系统提示：恒泰贸易报价单 v3 已生成，待陈晓确认后发送', time: '09:25', ai: true },
    { from: 'li', text: '对了，云启物流那边首次电话聊得还行，对方想先试用一个月', time: '09:40', ai: false },
    { from: 'chen', text: '试用版可以走，但要提前说好年付价格锁定，别试完跑了', time: '09:42', ai: false },
    { from: 'sun', text: '同意，试用合同里加一条：试用期结束 7 天内签年付，否则恢复原价', time: '09:45', ai: false },
    { from: 'ai', text: '✦ 系统提示：云启物流试用合同模板已生成，含「试用转年付锁定条款」', time: '09:47', ai: true },
  ],
  'g-prod': [
    { from: 'wang', text: 'MO-0715 缺料问题确认了，B 料供应商那边要 7/20 才能到', time: '08:30', ai: false },
    { from: 'sun', text: '那 MO-0712 先不等了，正常推进', time: '08:35', ai: false },
    { from: 'wang', text: '明白，MO-0712 今天下午完成最终质检', time: '08:38', ai: false },
    { from: 'wang', text: '另外 MO-0715 的 A 料库存还有 3 天余量，够撑到 B 料到货', time: '08:42', ai: false },
    { from: 'sun', text: '好，7/20 到货后第一时间安排 MO-0715 复工', time: '08:45', ai: false },
    { from: 'ai', text: '✦ 系统提示：PO-0098 采购单已确认，预计 7/20 到货', time: '08:47', ai: true },
    { from: 'wang', text: '收到。还有个事，7 月底要做库存盘点，我先让小李准备盘点表', time: '09:00', ai: false },
    { from: 'sun', text: '行，盘点完出一份差异报告给我', time: '09:05', ai: false },
  ],
  'g-all': [
    { from: 'sun', text: '各位，本周五下午 3 点开经营周会，请准备好各自的数据', time: '08:00', ai: false },
    { from: 'chen', text: '收到，我准备恒泰和蓝海的进展报告', time: '08:05', ai: false },
    { from: 'wang', text: '生产部这边 MO-0712 和 MO-0715 的进度我来汇报', time: '08:08', ai: false },
    { from: 'fang', text: '财务提醒：本月应付账款 ¥86,000 需在 7/31 前结清', time: '08:12', ai: false },
    { from: 'ai', text: '✦ 系统提示：周会日程已同步到各位日历，议题清单已发群文件', time: '08:15', ai: true },
    { from: 'li', text: '王芳，蓝海的试用款能走加急吗？', time: '08:20', ai: false },
    { from: 'fang', text: '可以，走正常报销流程我今天处理', time: '08:22', ai: false },
    { from: 'chen', text: '补充一下：恒泰那边如果这周签约成功，Q3 营收目标就稳了', time: '08:30', ai: false },
    { from: 'wang', text: '生产这边也没问题，MO-0712 明天出货，MO-0715 月底前补上', time: '08:33', ai: false },
    { from: 'sun', text: '很好，周五见。另外提醒一下，7/31 是恒泰合同到期日，也是应付账款截止日，两件事别撞了', time: '08:36', ai: false },
    { from: 'fang', text: '明白，我提前催一下永鑫那边的回款', time: '08:38', ai: false },
  ],
  'dm-sun-chen': [
    { from: 'sun', text: '陈晓，恒泰那边什么情况？', time: '09:00', ai: false },
    { from: 'chen', text: '孙总，昨天和孙立通了电话，他对 9 折方案基本认可，但要求发票单独开', time: '09:05', ai: false },
    { from: 'sun', text: '可以，发票让王芳单独处理。这周能签吗？', time: '09:08', ai: false },
    { from: 'chen', text: '我今天下午去面谈，争取周五前搞定', time: '09:10', ai: false },
    { from: 'ai', text: '✦ AI 建议：恒泰合同 7/31 到期，建议本周签约避免跨月账期风险', time: '09:12', ai: true },
    { from: 'sun', text: '另外，蓝海那边什么态度？', time: '09:20', ai: false },
    { from: 'chen', text: '周工对价格有点犹豫，想再比比价。不过我们产品质量他认可', time: '09:23', ai: false },
    { from: 'sun', text: '那就先给他试用，用了之后他就知道差距了', time: '09:25', ai: false },
    { from: 'chen', text: '明白，我下午一起跟他说', time: '09:27', ai: false },
  ],
  'dm-chen-wang': [
    { from: 'chen', text: '王强，MO-0712 什么时候能出货？客户在催', time: '11:00', ai: false },
    { from: 'wang', text: '今天下午质检完，明天上午可以安排发货', time: '11:05', ai: false },
    { from: 'chen', text: '好的，我跟客户确认收货地址', time: '11:08', ai: false },
    { from: 'wang', text: '对了，MO-0715 的 B 料 7/20 到，到之前我先把 MO-0712 的尾数清完', time: '11:15', ai: false },
    { from: 'chen', text: '行，辛苦了。客户那边我盯着', time: '11:18', ai: false },
    { from: 'wang', text: '不辛苦，你那边恒泰签约顺利的话，我们排产也好安排', time: '11:20', ai: false },
  ],
  'dm-sun-wang': [
    { from: 'sun', text: '王强，MO-0715 断料的事怎么处理？', time: '14:00', ai: false },
    { from: 'wang', text: '孙总，B 料 7/20 到，到之前先排 MO-0712 的工序，不耽误出货', time: '14:05', ai: false },
    { from: 'sun', text: '行，你来安排，有问题随时说', time: '14:08', ai: false },
    { from: 'ai', text: '✦ AI 建议：MO-0715 排产建议顺延至 7/22，优先保障 MO-0712 交付', time: '14:10', ai: true },
    { from: 'wang', text: '收到，我还想问一下，7 月底的库存盘点您有什么特别关注的品类吗？', time: '14:15', ai: false },
    { from: 'sun', text: '重点关注 B 料和成品库存，特别是恒泰的定制件', time: '14:18', ai: false },
    { from: 'wang', text: '明白，我让小李重点盯这几项', time: '14:20', ai: false },
  ],
};

const IM_ROLE_MAP = { staff: 'chen', prod: 'wang', boss: 'sun' };
let curChat = null;
function renderIM() {
  const chats = getChats();
  if (!curChat) curChat = chats[0]?.id;
  const msgs = MESSAGES[curChat] || [];
  const activeChat = CHATS.find(c => c.id === curChat);

  // 左栏：会话列表
  let listHtml = '';
  chats.forEach((c, i) => {
    const lastMsg = (MESSAGES[c.id] || []).slice(-1)[0];
    const preview = lastMsg ? lastMsg.text.slice(0, 28) + (lastMsg.text.length > 28 ? '…' : '') : '';
    const time = lastMsg ? lastMsg.time : '';
    let avatarHtml;
    if (c.type === 'group') {
      const members = c.members.slice(0, 3).map(id => { const m = getContact(id); return `<span style="display:inline-block;width:14px;height:14px;border-radius:2px;background:${m.color};color:#fff;font-size:7px;text-align:center;line-height:14px;">${m.avatar}</span>`; }).join('');
      avatarHtml = `<div class="im-av-group">${members}</div>`;
    } else {
      const p = getContact(c.peer);
      avatarHtml = `<div class="im-av" style="background:${p.color}">${p.avatar}</div>`;
    }
    listHtml += `
      <div class="im-item ${c.id === curChat ? 'on' : ''}" onclick="openChat('${c.id}')" style="animation-delay:${i * .04}s">
        ${avatarHtml}
        <div class="im-item-info">
          <div class="im-item-top">
            <span class="im-item-name">${c.type === 'group' ? c.name : getContact(c.peer).name}</span>
            <span class="im-item-time">${time}</span>
          </div>
          <div class="im-item-preview">${preview}</div>
        </div>
        ${c.unread ? `<span class="im-unread">${c.unread}</span>` : ''}
      </div>`;
  });

  // 右栏：消息
  let msgsHtml = '';
  if (activeChat) {
    const chatName = activeChat.type === 'group' ? activeChat.name : getContact(activeChat.peer).name;
    const memberInfo = activeChat.type === 'group'
      ? `${activeChat.members.length} 名成员`
      : getContact(activeChat.peer).role;
    msgsHtml = `
      <div class="im-hd">
        <div class="im-hd-info">
          <div class="im-hd-name">${chatName}</div>
          <div class="im-hd-sub">${memberInfo}</div>
        </div>
        ${activeChat.type === 'group' ? `<button class="btn btn-ghost" onclick="toast('群设置','演示环境，可管理成员和群名')">群设置</button>` : ''}
      </div>
      <div class="im-msgs" id="im-msgs">`;
    msgs.forEach((m, i) => {
      if (m.ai) {
        msgsHtml += `
          <div class="im-msg im-ai" style="animation-delay:${i * .05}s">
            <div class="im-ai-tag">✦ 系统</div>
            <div class="im-bubble ai">${m.text}</div>
            <div class="im-msg-time">${m.time}</div>
          </div>`;
      } else {
        const sender = getContact(m.from);
        const isMe = m.from === IM_ROLE_MAP[DEMO_ROLE];
        msgsHtml += `
          <div class="im-msg ${isMe ? 'self' : ''}" style="animation-delay:${i * .05}s">
            ${!isMe ? `<div class="im-av sm" style="background:${sender.color}">${sender.avatar}</div>` : ''}
            <div class="im-msg-body">
              ${!isMe ? `<div class="im-msg-name">${sender.name}</div>` : ''}
              <div class="im-bubble">${m.text}</div>
              <div class="im-msg-time">${m.time}</div>
            </div>
            ${isMe ? `<div class="im-av sm" style="background:${sender.color}">${sender.avatar}</div>` : ''}
          </div>`;
      }
    });
    msgsHtml += `</div>
      <div class="im-input">
        <div class="im-input-bar">
          <button class="ib-btn" title="表情" onclick="toast('表情','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg></button>
          <button class="ib-btn" title="文件" onclick="toast('文件','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14.5 3.5h6v6M14.5 9.5L21 3M10 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5"/></svg></button>
          <button class="ib-btn" title="图片" onclick="toast('图片','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3.5" width="18" height="17" rx="1.5"/><circle cx="8.5" cy="9" r="2.2"/><path d="M21 16l-5-5-4 4-3-3-6 6"/></svg></button>
        </div>
        <div class="im-input-box">
          <input type="text" id="im-input" placeholder="输入消息…" onkeydown="if(event.key==='Enter')sendIMMsg()">
          <button class="send-btn" onclick="sendIMMsg()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L3 10.3l7.2 2.7L12.9 21z"/><path d="M21 3L10.2 13"/></svg></button>
        </div>
      </div>`;
  }

  mainBox().innerHTML = `
    <div class="im-layout">
      <div class="im-list">
        <div class="im-list-hd">
          <span>消息 <span class="tag am" style="font-size:9px;vertical-align:2px">mock</span></span>
          <button class="im-add-btn" onclick="openNewGroup()" title="新建群聊">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        ${listHtml}
      </div>
      <div class="im-chat">
        ${msgsHtml || '<div class="im-empty">选择一个会话开始聊天</div>'}
      </div>
    </div>
    <div class="im-modal" id="im-modal" style="display:none" onclick="if(event.target===this)closeNewGroup()">
      <div class="im-modal-box">
        <div class="im-modal-hd">新建群聊</div>
        <div class="im-modal-bd">
          <label class="im-label">群名称</label>
          <input type="text" id="new-group-name" class="im-input-field" placeholder="输入群名…">
          <label class="im-label" style="margin-top:12px">添加成员</label>
          <div class="im-member-list">
            ${CONTACTS.map(c => `
              <label class="im-member-check">
                <input type="checkbox" value="${c.id}">
                <div class="im-av sm" style="background:${c.color}">${c.avatar}</div>
                <span>${c.name}</span>
                <span class="im-member-role">${c.role}</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="im-modal-ft">
          <button class="btn btn-ghost" onclick="closeNewGroup()">取消</button>
          <button class="btn btn-pri" onclick="createGroup()">创建</button>
        </div>
      </div>
    </div>`;

  // 滚动到底部
  const msgsEl = document.getElementById('im-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

function openChat(id) {
  curChat = id;
  const chat = CHATS.find(c => c.id === id);
  if (chat) chat.unread = 0;
  renderIM();
}

function sendIMMsg() {
  const input = document.getElementById('im-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  const me = IM_ROLE_MAP[DEMO_ROLE];
  if (!MESSAGES[curChat]) MESSAGES[curChat] = [];
  MESSAGES[curChat].push({ from: me, text, time: '刚刚', ai: false });
  renderIM();
  toast('消息已发送', text.length > 16 ? text.slice(0, 16) + '…' : text);
}

function openNewGroup() { document.getElementById('im-modal').style.display = 'flex'; }
function closeNewGroup() { document.getElementById('im-modal').style.display = 'none'; }
function createGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  if (!name) { toast('请输入群名', ''); return; }
  const checks = document.querySelectorAll('.im-member-list input:checked');
  if (checks.length < 1) { toast('请选择至少一名成员', ''); return; }
  const members = Array.from(checks).map(c => c.value);
  if (!members.includes(IM_ROLE_MAP[DEMO_ROLE])) members.push(IM_ROLE_MAP[DEMO_ROLE]);
  const id = 'g-' + Date.now();
  CHATS.unshift({ id, type: 'group', name, icon: '💬', members, unread: 0, role: ['staff', 'prod', 'boss'] });
  MESSAGES[id] = [{ from: 'ai', text: `✦ 群聊「${name}」已创建`, time: '刚刚', ai: true }];
  closeNewGroup();
  curChat = id;
  toast('群聊已创建', name);
  renderIM();
}

/* ============ 注册（mock 徽标 + 说明条：写明实装接哪张表/哪个里程碑） ============ */
(function registerErpMock() {
  const reg = (id, fn, note) => { RENDER[id] = () => { fn(); if (note) markMock(note); }; };
  reg('im', renderIM);          // IM 无 page-hd，徽标已内嵌在列表头
  RENDER['calendar'] = renderCalendar;   // 自带 markMock
  reg('customers', renderCustomers, '骨架演示页：数据为示例。实装接 business.customers（3 个月计划 W8 · 客户主档 CRUD+搜索+标签）。');
  reg('orders', renderOrders, '骨架演示页：数据为示例。实装接 business.orders（W9 · 状态机简化版：草稿→确认→完成）。');
  reg('delivery', renderDelivery, '骨架演示页：数据为示例。实装接发货/回款（W9-10 · 与应收台账联动，应收深做见 W4-5）。');
  reg('production', renderProduction, '演示页：生产工单为 v1.6 规划（功能清单 P1），当前不排期。');
  reg('inventory', renderInventory, '骨架演示页：数据为示例。实装接 business.inventory + inventory_movements（W10 · 流水 append-only）。');
  reg('purchase', renderPurchase, '骨架演示页：数据为示例。实装接 business.purchases（W9 · 收货→入库联动，应付见 W10）。');
  reg('expense', renderExpense, '演示页：报销审批流为 v1.6 规划。真实发票链路（邮箱收票→OCR→审核→入账）见「发票审核」。');
  reg('payables', renderPayables, '骨架演示页：数据为示例。应收台账 W4-5 深做（发票→入账→应收），应付 W10。');
  reg('docs', renderDocs, '演示页：日报/周报 AI 汇总为 W6 每日简报的一部分。真实文档生成见「文档生成」。');
  reg('files', renderFiles, '演示页：统一文件库为 v1.6 规划。当前真实附件归档在发票链路（入库即传飞书）。');
  reg('skills', renderSkillsMock, '演示页：Skill 运营管理为 v1.6 规划。真实 skill 双向同步见「Skill 同步」。');
  RENDER['agents'] = renderAgents;       // 自带 markMock
  ['tools-logo', 'tools-crawl', 'tools-site', 'tools-img'].forEach(id => { RENDER[id] = () => renderTool(id); });
})();
