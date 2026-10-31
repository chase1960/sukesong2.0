/* ==========================================================================
   骨架 mock 页（原工作台迁移）：任务管理 / 项目管理 / 记账 / 话题集 / SOP
   每页 mock 徽标 + 说明条写明实装接哪张表/哪个任务。
   ========================================================================== */

/* ============ 任务管理（任务2 / 3个月计划 W11） ============ */
const MOCK_TASKS = [
  { name: '需求确认书签署', project: '某制造企业 ERP 项目', owner: '王馨', start: '2026-08-03', end: '2026-08-07', pct: 100, status: '已完成' },
  { name: '排期表确认', project: '某制造企业 ERP 项目', owner: '张一诺', start: '2026-08-06', end: '2026-08-10', pct: 100, status: '已完成' },
  { name: '字段梳理与模板搭建', project: '某制造企业 ERP 项目', owner: '王馨', start: '2026-08-10', end: '2026-08-18', pct: 60, status: '进行中' },
  { name: '发票收集联调', project: '某制造企业 ERP 项目', owner: '李工', start: '2026-08-15', end: '2026-08-25', pct: 30, status: '进行中' },
  { name: '试运行 + 验收', project: '某制造企业 ERP 项目', owner: '张一诺', start: '2026-08-26', end: '2026-09-04', pct: 0, status: '未开始' },
  { name: '合同续签谈判', project: '官网维护项目', owner: '王馨', start: '2026-08-05', end: '2026-08-12', pct: 40, status: '进行中' },
];
let taskTab = 'list';
RENDER['task-mgmt'] = function () {
  const tabs = [['list', '任务列表'], ['gantt', '甘特图']].map(([k, n]) =>
    `<button class="tab ${taskTab === k ? 'on' : ''}" onclick="taskTab='${k}';RENDER['task-mgmt']()">${n}</button>`).join('');
  let body;
  if (taskTab === 'list') {
    body = `<div class="card"><table class="dtable">
      <tr><th>任务</th><th>项目</th><th>负责人</th><th>计划起止</th><th style="text-align:right">进度</th><th>状态</th></tr>
      ${MOCK_TASKS.map(t => `<tr><td><b>${t.name}</b></td><td>${t.project}</td><td>${t.owner}</td>
        <td>${t.start} ~ ${t.end}</td><td class="num">${t.pct}%</td>
        <td><span class="tag">${t.status}</span></td></tr>`).join('')}
    </table></div>`;
  } else {
    const d0 = new Date('2026-08-01'), span = 40;
    const off = (d) => Math.max(0, (new Date(d) - d0) / 864e5) / span * 100;
    const wid = (a, b) => Math.max(1.5, (new Date(b) - new Date(a)) / 864e5 / span * 100);
    const today = Math.min(100, Math.max(0, (Date.now() - d0) / 864e5)) / span * 100;
    body = `<div class="card"><div class="card-bd"><div class="gantt-mock">
      ${MOCK_TASKS.map(t => `<div class="gantt-row">
        <div class="lbl"><b>${t.name}</b> <span style="color:var(--fg3)">${t.owner}</span></div>
        <div class="gantt-track"><div class="gantt-bar ${t.pct < 100 && new Date(t.end) < new Date() ? 'late' : ''}" style="left:${off(t.start)}%;width:${wid(t.start, t.end)}%"><i style="width:${t.pct}%"></i></div><div class="gantt-today" style="left:${today}%"></div></div>
      </div>`).join('')}
    </div></div></div>`;
  }
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>任务管理</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('已记录','任务管理实装（W11）后生效')">＋ 添加任务</button>
      <button class="btn btn-ghost" onclick="toast('排期表拆解','任务管理实装（W11）后生效')">从排期表拆解</button></div></div>
    <div class="tabbar">${tabs}</div>${body}`;
  markMock('骨架页：数据为示例。实装接 process.tasks 表（3 个月计划 W11 · 排期表拆解 / 手动添加 / 负责人进度上报 / 甘特图）。');
};

/* ============ 项目管理（任务7 · v1.6） ============ */
const MOCK_PROJECTS = [
  { name: '某制造企业 ERP 项目', client: '某制造企业', type: 'ERP 实施', contract: 180000, cost: 62000, 人力: 210, pct: 55 },
  { name: '官网维护项目', client: '银聆科技', type: '运维服务', contract: 36000, cost: 9800, 人力: 60, pct: 80 },
  { name: '发票数字化项目', client: '某贸易公司', type: 'ERP 实施', contract: 95000, cost: 31000, 人力: 120, pct: 90 },
];
RENDER['projects'] = function () {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>项目管理</h1></div>
    <div class="grid-3">${MOCK_PROJECTS.map(p => `
      <div class="card"><div class="card-hd"><span class="t">${p.name}</span><span class="tag">${p.type}</span></div><div class="card-bd">
        <table class="dtable">
          <tr><td style="color:var(--fg3)">客户</td><td class="num">${p.client}</td></tr>
          <tr><td style="color:var(--fg3)">合同额</td><td class="num">${money(p.contract)}</td></tr>
          <tr><td style="color:var(--fg3)">已发生成本</td><td class="num">${money(p.cost)}</td></tr>
          <tr><td style="color:var(--fg3)">人力投入</td><td class="num">${p.人力} 人时</td></tr>
          <tr><td style="color:var(--fg3)">毛利</td><td class="num" style="color:var(--green2)">${money(p.contract - p.cost)}</td></tr>
          <tr><td style="color:var(--fg3)">进度</td><td class="num">${p.pct}%</td></tr>
        </table></div></div>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="card-hd"><span class="t">同类型项目预测</span><span class="tag am">mock</span></div><div class="card-bd">
      <div class="fgrid"><div class="fld"><label>项目类型</label><select><option>ERP 实施</option><option>运维服务</option></select></div>
      <div class="fld"><label>规模（人天预估）</label><input value="200"></div></div>
      <div class="ai-note" style="margin-top:10px"><span class="spark">✦</span><div>同类型历史 2 单：人力 120~210 人时、报价 9.5万~18万。<b>预测：人力 165±45 人时，建议报价 13.7万±4万</b>（相似案例回归，样本 &lt;5 仅供参考）</div></div>
    </div></div>`;
  markMock('骨架页：数据为示例。实装后项目成本来自记账表按项目聚合（W3 建 business.projects），人力来自任务工时；预测为 v1.6。');
};

/* ============ 话题集（任务5 · v1.6） ============ */
const MOCK_TOPICS = [
  { title: 'ERP 项目里程碑二要延期吗？', author: '张一诺', replies: 5, at: '2026-08-01', tag: '项目' },
  { title: '7 月报销发票还差哪几张', author: '王馨', replies: 3, at: '2026-07-30', tag: '财务' },
  { title: '新版排期表模板试用反馈', author: '李工', replies: 8, at: '2026-07-28', tag: '工具' },
];
RENDER['topics'] = function () {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>话题集</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('发帖','话题集实装（v1.6）后生效')">＋ 发话题</button></div></div>
    ${MOCK_TOPICS.map(t => `<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="topicDetail()"><div class="card-bd" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${t.title}</b> <span class="tag">${t.tag}</span><div style="font-size:11.5px;color:var(--fg3);margin-top:4px">${t.author} · ${t.at}</div></div>
        <div style="color:var(--fg3);font-size:12px">${ICONS.chat} ${t.replies}</div>
      </div></div></div>`).join('')}`;
  markMock('骨架页：数据为示例。实装接 cognition.topics / topic_replies 表（v1.6）。');
};
function topicDetail() {
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>ERP 项目里程碑二要延期吗？</h1><div class="sub">张一诺 · 2026-08-01</div>
      <div class="acts"><button class="btn btn-ghost" onclick="go('topics')">${ICONS.back} 返回</button></div></div>
    <div class="card" style="margin-bottom:10px"><div class="card-bd">联调环境还没好，里程碑二（8/18）估计要顺延 3 天，大家看行不行？</div></div>
    ${[['王馨', '我这边发票联调要等环境，顺延可以，但验收日别动。'], ['李工', '环境今晚能好，应该不用延。'], ['张一诺', '那我按不延期排，明晚再看一次。']].map(([a, c]) => `
      <div class="card" style="margin-bottom:8px"><div class="card-bd" style="padding:12px 16px"><b style="font-size:12.5px">${a}</b><div style="margin-top:4px">${c}</div></div></div>`).join('')}
    <div class="card"><div class="card-bd" style="display:flex;gap:8px"><input placeholder="回复…（mock）" style="flex:1;font-family:inherit;font-size:13px;padding:9px 10px;border:1px solid var(--line2);border-radius:var(--r)"><button class="btn btn-pri" onclick="toast('回复','话题集实装（v1.6）后生效')">回复</button></div></div>`;
  markMock();
}

/* ============ SOP 协作（任务8 · v1.6） ============ */
RENDER['sop'] = function () {
  const steps = [
    ['收集当月发票（AI 自动）', 'done'], ['OCR 抽取 + 待审（AI 自动）', 'done'],
    ['王馨复核发票（人）', 'doing'], ['生成月度记账汇总（AI 自动）', 'todo'],
    ['老板确认结转（人）', 'todo'],
  ];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>SOP 协作</h1>
      <div class="acts"><button class="btn btn-pri" onclick="toast('新建 SOP','SOP 协作实装（v1.6）后生效')">＋ 新建 SOP</button></div></div>
    <div class="card"><div class="card-hd"><span class="t">发票月结 SOP · 2026-07 实例</span><span class="tag">进行中 3/5</span></div><div class="card-bd">
      ${steps.map(([s, st], i) => `<div style="display:flex;gap:10px;align-items:center;padding:8px 2px;${i < steps.length - 1 ? 'border-bottom:1px solid var(--line)' : ''}">
        <span style="width:20px;text-align:center">${st === 'done' ? '<span style="color:var(--green2)">✓</span>' : st === 'doing' ? '<span style="color:var(--amber)">●</span>' : '<span style="color:var(--fg3)">○</span>'}</span>
        <span style="${st === 'todo' ? 'color:var(--fg3)' : ''}">${s}</span>
        ${st === 'doing' ? '<span class="tag" style="margin-left:auto">等待 王馨</span>' : ''}
      </div>`).join('')}
    </div></div>`;
  markMock('骨架页。实装后 SOP 即 skill（版本化、可同步），执行实例逐步跟踪（v1.6）。');
};
