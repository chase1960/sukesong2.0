/* ============ 模块：看板（老板驾驶舱 · 演示数据，P7 实装真实聚合） ============ */
const KANBAN_VIEWS = {
  boss: {
    perm: '老板 · 全部数据可见（含金额、利润、全员动态）',
    insight: '本周成交 <b>¥286,000</b>（环比 +18%），但<b>恒泰贸易</b>合同 14 天后到期未续签，影响约 ¥48,000/年 —— 建议今天推动签约。',
    insightBtn: '让 AI 去催办',
    kpis: [
      { k: '本月成交', v: 286000, unit: '¥', d: '+18% 环比', cls: 'up' },
      { k: '本月回款', v: 198000, unit: '¥', d: '+6% 环比', cls: 'up' },
      { k: '进行中项目', v: 7, d: '2 个临近交付', cls: '' },
      { k: '风险预警', v: 2, d: 'L3 ×1 · L2 ×1', cls: 'warn' },
    ],
    lanes: [
      { name: '跟进中', cards: [
        { t: '蓝海制造', s: '报价发出 3 天未反馈 · 打开 2 次', pills: [['L2 跟进','a']], who: '陈', prog: 40 },
        { t: '云启物流', s: '初次接触 · 需求待确认', pills: [['新客户','b']], who: '李', prog: 15 },
      ]},
      { name: '报价中', cards: [
        { t: '恒泰贸易', s: '报价 v3 已发 · 签约概率 78%', pills: [['重点','g'],['L3 到期','r']], who: '陈', prog: 75 },
        { t: '明远咨询', s: '积分增购 5,000 · 已审批', pills: [['已审批','g']], who: '李', prog: 85 },
      ]},
      { name: '签约', cards: [
        { t: '弘毅工厂', s: '合同草案 v1.2 · 法务预审中', pills: [['预审中','b']], who: '陈', prog: 90 },
      ]},
      { name: '交付', cards: [
        { t: '君海晟财税', s: 'FDE 第 2 次上门 · Skill 适配中', pills: [['FDE','g']], who: '王', prog: 55 },
        { t: '鑫源商贸', s: '验收待确认 · 已逾期 2 天', pills: [['逾期','r']], who: '王', prog: 92 },
      ]},
    ],
    files: [
      { n: '恒泰贸易 · 报价单 v3.pdf', m: 'AI 生成 · 税额已单独标注', i: 'f-pdf', ic: 'PDF', t: '10:24' },
      { n: '弘毅工厂 · 合同草案 v1.2.doc', m: '法务预审中', i: 'f-doc', ic: '文', t: '09:50' },
      { n: '7月第3周 · 经营周报.doc', m: 'AI 汇总 · 待老板确认', i: 'f-doc', ic: '文', t: '08:00' },
      { n: '君海晟 · 交付清单 v2.xls', m: 'FDE 更新', i: 'f-xls', ic: '表', t: '昨天' },
    ],
    feed: [
      { who: 'ai', tx: '<b>AI</b> 检测到恒泰贸易合同 14 天后到期，已向陈晓推送 L3 预警', tm: '08:45' },
      { who: 'ai', tx: '<b>AI</b> 汇总生成 7 月第 3 周经营周报，待确认', tm: '08:00' },
      { who: '陈', tx: '<b>陈晓</b> 发送恒泰贸易报价单 v3（¥45,600）', tm: '10:24' },
      { who: 'ai', tx: '<b>AI</b> 将「报价单独标注税额」写入实战教训 #13，全员生效', tm: '10:31' },
      { who: '王', tx: '<b>王芳</b> 完成君海晟第 2 次 FDE 上门', tm: '昨天' },
    ],
  },
  sales: {
    perm: '销售 · 仅可见本人客户与任务（金额已按授权开放）',
    insight: '<b>蓝海制造</b>报价单被打开 2 次未回复 —— AI 建议电话切入，话术已备好。',
    insightBtn: '查看话术',
    kpis: [
      { k: '我的客户', v: 12, d: '本周新增 2', cls: 'up' },
      { k: '我的报价', v: 3, unit: ' 份', d: '共 ¥118,600', cls: '' },
      { k: '本月回款', v: 20000, unit: '¥', d: '目标 ¥80,000', cls: 'warn' },
      { k: '待办任务', v: 5, d: '2 个今天到期', cls: 'warn' },
    ],
    lanes: [
      { name: '待跟进', cards: [
        { t: '蓝海制造', s: '报价 3 天未反馈 · AI 建议电话', pills: [['L2','a']], who: '陈', prog: 40 },
      ]},
      { name: '报价中', cards: [
        { t: '恒泰贸易', s: 'v3 已发 · 等待孙立确认', pills: [['重点','g']], who: '陈', prog: 75 },
      ]},
      { name: '签约', cards: [] },
      { name: '已成交', cards: [
        { t: '明远咨询', s: '积分增购已审批 · 本月回款 ¥20,000', pills: [['已回款','g']], who: '陈', prog: 100 },
      ]},
    ],
    files: [
      { n: '恒泰 · 需求确认纪要-0712.doc', m: 'AI 生成', i: 'f-doc', ic: '文', t: '7/12' },
      { n: '蓝海 · 报价单 v2.pdf', m: '被打开 2 次', i: 'f-pdf', ic: 'PDF', t: '7/14' },
      { n: 'INV-2026-07153 发票.jpg', m: '已关联 RB-2026-054', i: 'f-img', ic: '图', t: '7/15' },
    ],
    feed: [
      { who: 'ai', tx: '<b>AI</b> 为恒泰贸易生成报价单 v3，已发送孙立', tm: '10:24' },
      { who: 'ai', tx: '<b>AI</b> 提交报销单 RB-2026-054（¥4,120）', tm: '09:40' },
      { who: '陈', tx: '<b>陈晓</b> 完成恒泰第 3 次拜访，纪要已自动归档', tm: '7/12' },
    ],
  },
  finance: {
    perm: '财务 · 仅可见报销、发票与预算（客户详情已脱敏）',
    insight: '本月预算已用 <b>72%</b>，销售部差旅费同比增长 34% —— 暂无超支风险，AI 将持续监控。',
    insightBtn: '查看预算明细',
    kpis: [
      { k: '待审报销', v: 3, unit: ' 单', d: 'AI 预审全通过', cls: '' },
      { k: '本月发票', v: 47, unit: ' 张', d: 'OCR 自动归档', cls: 'up' },
      { k: '预算执行', v: 72, unit: '%', d: '80% 将触发 L3', cls: 'warn' },
      { k: '本月支出', v: 156000, unit: '¥', d: '预算 ¥216,000', cls: '' },
    ],
    restricted: true,
    files: [
      { n: 'RB-2026-054 · 陈晓差旅报销', m: '¥4,120 · AI 预审通过', i: 'f-doc', ic: '文', t: '09:40' },
      { n: 'RB-2026-053 · 李婷市内交通', m: '¥860 · AI 预审通过', i: 'f-doc', ic: '文', t: '昨天' },
      { n: '7月发票汇总.xls', m: '47 张 · 自动归类', i: 'f-xls', ic: '表', t: '周一' },
    ],
    feed: [
      { who: 'ai', tx: '<b>AI</b> 预审通过 RB-2026-054，发票已自动归档', tm: '09:40' },
      { who: 'ai', tx: '<b>AI</b> 检测销售部差旅费同比 +34%，低于预警线', tm: '08:00' },
      { who: '李', tx: '<b>李婷</b> 提交 RB-2026-053 报销', tm: '昨天' },
    ],
  },
};

/* 员工甘特（老板视角） */
const KANBAN_GANTT = [
  { who: '陈晓', c: '#2E5E4E', bars: [
    { t: '恒泰贸易续约', s: '07-10', e: '07-31', p: 75 },
    { t: '蓝海制造跟进', s: '07-14', e: '07-22', p: 40 },
  ]},
  { who: '李婷', c: '#4A78B8', bars: [
    { t: '明远增购交付', s: '07-15', e: '07-20', p: 85 },
    { t: '云启物流培育', s: '07-16', e: '07-28', p: 15 },
  ]},
  { who: '王强', c: '#B0722A', bars: [
    { t: 'MO-0712 连接件', s: '07-12', e: '07-19', p: 65 },
    { t: 'MO-0715 螺栓', s: '07-15', e: '07-24', p: 30, warn: '缺料' },
  ]},
  { who: '王芳', c: '#7A5AA0', bars: [
    { t: '君海晟 FDE 交付', s: '07-08', e: '07-25', p: 55 },
    { t: '鑫源商贸验收', s: '07-10', e: '07-18', p: 92, warn: '逾期' },
  ]},
];
const KANBAN_G_MS = [
  { d: '07-20', t: 'PO-0098 碳钢棒料到货' },
  { d: '07-31', t: '恒泰合同到期 · 永鑫应付 ¥86,000' },
];
function kanbanRenderGantt() {
  const start = new Date(2026, 6, 6), DAYS = 35; // 7/6 – 8/9
  const X = ds => (new Date(2026, +ds.slice(0, 2) - 1, +ds.slice(3)) - start) / 864e5 / DAYS * 100;
  const weeks = ['7/6', '7/13', '7/20', '7/27', '8/3'];
  return `
  <div class="sec-title" style="animation-delay:.3s">员工甘特<span class="sub">按人看任务跨度与进度 · 红线为今天 · ◆ 为关键节点</span></div>
  <div class="gantt" style="animation-delay:.36s">
    <div class="g-ruler">
      ${weeks.map((w, i) => `<span class="g-tick" style="left:${i * 7 / DAYS * 100}%">${w}</span>`).join('')}
      ${KANBAN_G_MS.map(m => `<span class="g-ms" style="left:${X(m.d)}%" title="${m.t}">◆</span>`).join('')}
    </div>
    <div class="g-body">
      <div class="g-today" style="left:calc(66px + (100% - 66px) * ${X('07-17') / 100})"><span>今天 7/17</span></div>
      ${KANBAN_GANTT.map((g, gi) => `
        <div class="g-row">
          <div class="g-who"><span class="g-ava" style="background:${g.c}">${g.who[0]}</span>${g.who}</div>
          <div class="g-track">
            ${g.bars.map((b, bi) => `
              <div class="g-lane">
                <div class="g-bar ${b.warn ? 'alert' : ''}" style="left:${X(b.s)}%;width:${X(b.e) - X(b.s)}%;--c:${g.c};animation-delay:${.15 + (gi * 2 + bi) * .07}s" title="${b.t} · ${b.s.replace('-', '/')}–${b.e.replace('-', '/')} · ${b.p}%">
                  <i style="width:${b.p}%"></i>
                </div>
                <span class="g-lb" style="left:calc(${X(b.e)}% + 7px);animation-delay:${.3 + (gi * 2 + bi) * .07}s"><b>${b.t}</b> · ${b.p}%${b.warn ? ` · <span class="warn">${b.warn}</span>` : ''}</span>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}

/* ============ 渲染 ============ */
let kanbanCur = 'boss';
function kanbanFmtNum(n, unit) {
  if (unit === '¥') return '¥' + n.toLocaleString();
  return n.toLocaleString() + (unit || '');
}
function kanbanRender() {
  const v = KANBAN_VIEWS[kanbanCur];
  $('#perm-text').textContent = v.perm;
  const D = 0.04; let i = 0;
  let html = `
    <div class="insight" style="animation-delay:${i++ * D}s">
      <div class="i"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L21 18H3zM12 21L3 6h18z"/></svg></div>
      <div class="tx">${v.insight}</div>
      <button class="go" onclick="alert('演示：已转交 Agent 处理')">${v.insightBtn} →</button>
    </div>
    <div class="kpis">
      ${v.kpis.map((k, j) => `
        <div class="kpi" style="animation-delay:${i++ * D}s">
          <div class="k">${k.k}</div>
          <div class="v" data-n="${k.v}" data-u="${k.unit || ''}">0</div>
          <div class="d ${k.cls}">${k.d}</div>
        </div>`).join('')}
    </div>`;
  if (v.restricted) {
    html += `<div class="sec-title" style="animation-delay:${i++ * D}s">客户与项目<span class="sub">按权限脱敏</span></div>
      <div class="restricted" style="animation-delay:${i++ * D}s"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>客户名称、合同金额等业务数据超出财务视角授权范围<br>如需查看，请在管理页申请权限或由老板授权</div>`;
  } else {
    html += `<div class="sec-title" style="animation-delay:${i++ * D}s">项目看板<span class="sub">数据来自状态数据库 · 实时同步</span></div>
    <div class="board">
      ${v.lanes.map((l, li) => `
        <div class="lane" style="animation-delay:${i++ * D * 0.5}s">
          <div class="lane-hd">${l.name}<span class="n">${l.cards.length}</span></div>
          ${l.cards.map((c, ci) => `
            <div class="b-card" style="animation-delay:${(i + ci) * D}s">
              <div class="t">${c.t}</div>
              <div class="s">${c.s}</div>
              <div class="prog"><i style="width:${c.prog}%"></i></div>
              <div class="ft">${c.pills.map(p => `<span class="pill ${p[1]}">${p[0]}</span>`).join('')}<span class="who">${c.who}</span></div>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;
  }
  if (kanbanCur === 'boss') html += kanbanRenderGantt();
  html += `<div class="sec-title" style="animation-delay:${i++ * D}s">文件与动态<span class="sub">AI 产出与人工操作同流呈现</span></div>
  <div class="grid-2">
    <div class="panel" style="animation-delay:${i++ * D}s">
      <div class="panel-hd">最新文件<span class="more">全部文件 →</span></div>
      ${v.files.map((f, j) => `
        <div class="file-row" style="animation-delay:${(i + j) * D}s">
          <div class="f-ico ${f.i}">${f.ic}</div>
          <div><div class="n">${f.n}</div><div class="m">${f.m}</div></div>
          <div class="t">${f.t}</div>
        </div>`).join('')}
    </div>
    <div class="panel" style="animation-delay:${i++ * D}s">
      <div class="panel-hd">动态<span class="more">审计日志 →</span></div>
      <div class="feed">
        ${v.feed.map((f, j) => `
          <div class="feed-item" style="animation-delay:${(i + j) * D}s">
            <span class="feed-dot" style="background:${f.who === 'ai' ? '#10B981' : '#2E5E4E'}"></span>
            <div><div class="tx">${f.who === 'ai' ? '<span class="ai-who"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L21 18H3zM12 21L3 6h18z"/></svg></span>' : ''}${f.tx}</div><div class="tm">${f.tm}</div></div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
  $('#page').innerHTML = html;
  kanbanCountUp();
}

/* 数字滚动 */
function kanbanCountUp() {
  $('#page').querySelectorAll('.kpi .v').forEach(el => {
    const n = +el.dataset.n, u = el.dataset.u;
    const t0 = performance.now(), dur = 900;
    (function tick(t) {
      const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
      el.textContent = kanbanFmtNum(Math.round(n * e), u);
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  });
}

/* 视角切换 */
function kanbanSwitch(btn) {
  if (btn.disabled || btn.dataset.r === kanbanCur) return;
  const seg = btn.closest('.seg');
  seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
  btn.classList.add('on');
  const ind = $('#seg-ind');
  ind.style.left = btn.offsetLeft + 'px';
  ind.style.width = btn.offsetWidth + 'px';
  kanbanCur = btn.dataset.r;
  const page = $('#page');
  page.style.animation = 'none'; page.offsetHeight; page.style.animation = '';
  kanbanRender();
}

/* ============ 模块入口 ============ */
RENDER.kanban = async function () {
  const role = currentUserInfo?.role || 'staff';
  const allowed = role === 'admin' ? ['boss', 'sales', 'finance']
    : role === 'finance' ? ['finance'] : ['sales'];
  kanbanCur = allowed[0];
  const segBtn = (r, label) => `<button data-r="${r}" ${allowed.includes(r) ? '' : 'hidden disabled'} ${r === kanbanCur ? 'class="on"' : ''}>${label}</button>`;
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>看板</h1></div>
    <div class="perm-bar">
      <div class="seg" id="seg">
        <div class="seg-ind" id="seg-ind"></div>
        ${segBtn('boss', '老板视角')}${segBtn('sales', '销售视角')}${segBtn('finance', '财务视角')}
      </div>
      <div class="perm-note"><span class="lock"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="display:block"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg></span><span id="perm-text"></span></div>
    </div>
    <div id="page"></div>`;
  markMock('演示页：KPI/看板/甘特为演示数据；真实聚合（应收/发票/记账）在 P3-P4 实装');
  const seg = $('#seg');
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => kanbanSwitch(b)));
  const active = seg.querySelector('button.on');
  requestAnimationFrame(() => {
    const ind = $('#seg-ind');
    ind.style.left = active.offsetLeft + 'px';
    ind.style.width = active.offsetWidth + 'px';
  });
  kanbanRender();
};
