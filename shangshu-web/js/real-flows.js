/* ============ 模块：链路图谱 —— 链路为主轴 + 分区滤镜 + 快速入口 ============ */
let flowData = null;
let flowZone = '';          // ''=全部；finance/sales/supply=视角高亮
let flowView = 'overview';
let flowSelId = null;
let flowLive = true;
let flowPulseTimer = null;
let flowDetailFlow = null;
let flowDetailStep = null;

const FLOW_TYPE_LABEL = { event: '事件', page_action: '页面操作', query: '查询', navigate: '跳转' };
const FLOW_VIEW_LABEL = { overview: '总览', lanes: '链路', pages: '页面', data: '数据' };
const FLOW_ZONE_LABEL = { '': '全部', finance: '财务', sales: '销售', supply: '供应链' };
const FLOW_ZONE_COLOR = { finance: '#10B981', sales: '#2563EB', supply: '#C77A0A' };
const FLOW_PAGE_ZONE = {
  review: 'finance', accounting: 'finance', payables: 'finance', expense: 'finance',
  orders: 'sales', delivery: 'sales', customers: 'sales',
  purchase: 'supply', inventory: 'supply', production: 'supply',
};
const FLOW_ENTITY_LABEL = { ledger: '记账表', payable: '应付', receivable: '应收', inventory: '库存' };
const FLOW_ENTITY_ZONE = { ledger: 'finance', payable: 'finance', receivable: 'finance', inventory: 'supply' };

function flowEntityLabel(id) { return FLOW_ENTITY_LABEL[id] || id; }

function flowAllFlows() { return flowData?.flows || []; }

function flowStepPageZones(step) {
  const z = new Set();
  for (const p of step.pages || []) {
    const zone = FLOW_PAGE_ZONE[p];
    if (zone) z.add(zone);
  }
  return z;
}

function flowStepInZone(step, zone) {
  if (!zone) return true;
  return flowStepPageZones(step).has(zone) || flowStepProjectZones(step).has(zone);
}

function flowStepProjectZones(step) {
  const z = new Set();
  for (const p of step.projects || []) {
    const zone = FLOW_ENTITY_ZONE[p];
    if (zone) z.add(zone);
  }
  return z;
}

function flowVisibleFlows() {
  const all = flowAllFlows();
  if (!flowZone) return all;
  return all.filter(f => f.domain === flowZone
    || f.steps.some(s => flowStepInZone(s, flowZone)));
}

function flowStepTargetPage(step) {
  return (step.pages || []).find(p => p !== 'chat' && RENDER[p]);
}

function flowCollectPages(flows) {
  const pages = new Set();
  for (const f of flows) {
    for (const s of f.steps) {
      for (const p of s.pages || []) if (p && p !== 'chat') pages.add(p);
    }
  }
  return [...pages];
}

function flowCollectEntities(flows) {
  const ents = new Set();
  for (const f of flows) {
    for (const s of f.steps) for (const p of s.projects || []) ents.add(p);
  }
  return [...ents];
}

function flowStepLiveClass(step) {
  if (!flowLive || !step.ref || step.kind !== 'event') return '';
  const st = flowData?.stats?.[step.ref];
  if (!st) return '';
  if (st.pending > 0) return 'live-wait';
  if (st.confirmed_7d > 0) return 'live-hot';
  return '';
}

function flowStepZoneTags(step, activeZone) {
  if (!activeZone) return '';
  const zones = new Set([...flowStepPageZones(step), ...flowStepProjectZones(step)]);
  zones.delete(activeZone);
  if (!zones.size) return '';
  return [...zones].map(z => `<span class="flow-zone-tag" style="--zt:${FLOW_ZONE_COLOR[z] || '#64748B'}">${esc(FLOW_ZONE_LABEL[z] || z)}</span>`).join('');
}

function flowRenderNode(step, flow, activeZone) {
  const inZone = flowStepInZone(step, activeZone);
  const kind = step.kind === 'event' ? 'capability' : 'page';
  const live = flowStepLiveClass(step);
  const zoneTags = flowStepZoneTags(step, activeZone);
  const pinned = typeof isFlowShortcut === 'function' && isFlowShortcut(flow.id, step.id);
  const pages = (step.pages || []).filter(p => p !== 'chat').map(p => flowData.pageLabels?.[p] || p).join(' · ');
  const projs = (step.projects || []).map(flowEntityLabel);
  const meta = [
    step.ref ? `<span class="flow-node-cap">${esc(step.ref)}</span>` : '',
    step.confirm ? '<span class="flow-node-tag">确认卡</span>' : '',
    pinned ? '<span class="flow-node-tag flow-pin-tag">★ 入口</span>' : '',
    pages ? `<span class="flow-node-pages">${esc(pages)}</span>` : '',
  ].filter(Boolean).join('');
  const chips = projs.length
    ? `<div class="flow-node-chips">${projs.map(p => `<span class="flow-chip entity">${esc(p)}</span>`).join('')}</div>` : '';
  return `<div class="flow-node ${kind} ${live} ${inZone ? 'in-zone' : 'out-zone'}" data-step-id="${esc(step.id)}" data-flow-id="${esc(flow.id)}"
    role="button" tabindex="0">
    <div class="flow-node-type">${esc(FLOW_TYPE_LABEL[step.kind] || step.kind)}${zoneTags ? ` ${zoneTags}` : ''}</div>
    <div class="flow-node-label">${esc(step.label)}</div>
    ${meta ? `<div class="flow-node-meta">${meta}</div>` : ''}
    ${step.note ? `<div class="flow-node-note">${esc(step.note)}</div>` : ''}
    ${chips}
  </div>`;
}

function flowRenderLane(flow, activeZone, hidden) {
  const steps = flow.steps || [];
  const track = steps.map((step, i) => {
    const conn = i < steps.length - 1
      ? `<div class="flow-connector" style="--lane:${esc(flow.color)}" aria-hidden="true"><span class="flow-connector-arrow"></span></div>` : '';
    return flowRenderNode(step, flow, activeZone) + conn;
  }).join('');
  return `<div class="flow-lane ${hidden ? 'hidden' : ''}" data-flow-id="${esc(flow.id)}" style="--lane:${esc(flow.color)}">
    <div class="flow-lane-hd">
      <span class="flow-lane-dot"></span>
      <span class="flow-lane-title">${esc(flow.name)}</span>
      <span class="flow-lane-badge">${esc(FLOW_ZONE_LABEL[flow.domain] || flow.domain)}</span>
      <span class="flow-lane-sub">${esc(flow.desc)}</span>
    </div>
    <div class="flow-lane-track">${track}</div>
  </div>`;
}

function flowBindNodes(root) {
  root.querySelectorAll('.flow-node').forEach(el => {
    const show = () => {
      const flow = flowData.flows.find(x => x.id === el.dataset.flowId);
      const step = flow?.steps.find(s => s.id === el.dataset.stepId);
      if (step) flowShowStepDetail(flow, step);
      root.querySelectorAll('.flow-node').forEach(n => n.classList.remove('on'));
      el.classList.add('on');
    };
    el.onclick = show;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } };
  });
}

function flowRenderLanes(stage) {
  const flows = flowVisibleFlows();
  const visible = flowSelId ? flows.filter(f => f.id === flowSelId) : flows;
  stage.innerHTML = `<div class="flow-board ${flowSelId ? 'mode-single' : 'mode-all'}" id="flow-board">
    ${visible.map(f => flowRenderLane(f, flowZone, false)).join('')}
  </div>`;
  flowBindNodes(stage);
}

function flowRenderOverview(stage) {
  const flows = flowVisibleFlows();
  const pages = flowCollectPages(flows);
  const ents = flowCollectEntities(flows);
  stage.innerHTML = `
    <div class="flow-overview">
      <div class="flow-overview-hd">
        <div class="flow-overview-title">业务链路</div>
        <div class="flow-overview-sub">每条链路是一个端到端闭环；枢纽页（如应收应付）会出现在多条链中。</div>
        <div class="flow-stat-row">
          <span class="flow-stat-pill">${flows.length} 条链路</span>
          <span class="flow-stat-pill">${pages.length} 个界面</span>
          <span class="flow-stat-pill">${ents.length} 种数据投影</span>
        </div>
      </div>
      <div class="flow-overview-grid">
        ${flows.map(f => {
          const pg = [...new Set(f.steps.flatMap(s => (s.pages || []).filter(p => p !== 'chat')))];
          const ej = [...new Set(f.steps.flatMap(s => s.projects || []))];
          return `<button type="button" class="flow-card" data-flow="${esc(f.id)}" style="--lane:${esc(f.color)}">
            <div class="flow-card-bar"></div>
            <div class="flow-card-name">${esc(f.name)}</div>
            <div class="flow-card-desc">${esc(f.desc)}</div>
            <div class="flow-card-meta">
              <span class="flow-card-tag">${esc(FLOW_ZONE_LABEL[f.domain] || f.domain)}</span>
              <span class="flow-card-tag">${f.steps.length} 步</span>
            </div>
            ${pg.length ? `<div class="flow-card-chips">${pg.map(p => `<span class="flow-chip page">${esc(flowData.pageLabels?.[p] || p)}</span>`).join('')}</div>` : ''}
            ${ej.length ? `<div class="flow-card-chips">${ej.map(e => `<span class="flow-chip entity">${esc(flowEntityLabel(e))}</span>`).join('')}</div>` : ''}
          </button>`;
        }).join('')}
      </div>
      <div class="flow-hint meta">在「链路」视图点步骤 → 右侧可 <b>设为快速入口</b>，侧栏一键跳到常用环节。</div>
    </div>`;
  stage.querySelectorAll('.flow-card').forEach(btn => {
    btn.onclick = () => { flowSelId = btn.dataset.flow; flowView = 'lanes'; flowRenderStage(); flowSyncChrome(); };
  });
}

function flowRenderPages(stage) {
  const pages = flowCollectPages(flowVisibleFlows());
  const flows = flowAllFlows();
  stage.innerHTML = `<div class="flow-matrix">
    ${pages.map(pg => {
      const roles = flows.flatMap(f => f.steps
        .filter(s => (s.pages || []).includes(pg))
        .map(s => ({ f, s })));
      return `<div class="flow-matrix-row">
        <div class="flow-matrix-hd">
          <div class="flow-matrix-title">${esc(flowData.pageLabels?.[pg] || pg)}</div>
          ${RENDER[pg] ? `<button type="button" class="btn btn-sm btn-ghost" onclick="go('${esc(pg)}')">打开</button>` : ''}
        </div>
        <div class="flow-matrix-body">
          <div class="flow-matrix-label">在此页的链路环节（同一页，不同角色）</div>
          ${roles.map(({ f, s }) => `
            <div class="flow-role-row">
              <span class="flow-chip lane" style="--lane:${esc(f.color)}">${esc(f.name)}</span>
              <span class="flow-role-step">${esc(s.label)}</span>
              ${s.ref ? `<span class="flow-node-cap">${esc(s.ref)}</span>` : ''}
              ${flowStepTargetPage(s) ? `<button type="button" class="btn btn-sm btn-ghost" onclick="flowRegisterShortcutFromStep('${esc(f.id)}','${esc(s.id)}')">+ 入口</button>` : ''}
            </div>`).join('') || '<span class="meta">—</span>'}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function flowRenderData(stage) {
  const ents = flowCollectEntities(flowVisibleFlows());
  const flows = flowAllFlows();
  stage.innerHTML = `<div class="flow-matrix">
    ${ents.map(ent => {
      const hits = flows.filter(f => f.steps.some(s => (s.projects || []).includes(ent)));
      const caps = [...new Set(hits.flatMap(f => f.steps.filter(s => (s.projects || []).includes(ent) && s.ref).map(s => s.ref)))];
      return `<div class="flow-matrix-row">
        <div class="flow-matrix-hd"><div class="flow-matrix-title">${esc(flowEntityLabel(ent))}</div></div>
        <div class="flow-matrix-body">
          <div class="flow-matrix-label">写入链路</div>
          <div class="flow-card-chips">${hits.map(f => `<span class="flow-chip lane" style="--lane:${esc(f.color)}">${esc(f.name)}</span>`).join('')}</div>
          ${caps.length ? `<div class="flow-matrix-label">来源能力</div><div class="flow-card-chips">${caps.map(c => `<span class="flow-node-cap">${esc(c)}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function flowRenderStage() {
  const stage = $('#flow-stage');
  if (!stage || !flowData) return;
  if (flowView === 'overview') flowRenderOverview(stage);
  else if (flowView === 'lanes') flowRenderLanes(stage);
  else if (flowView === 'pages') flowRenderPages(stage);
  else if (flowView === 'data') flowRenderData(stage);
  flowShowDetailPane();
}

function flowShortcutBtnHtml(flow, step) {
  const pg = flowStepTargetPage(step);
  if (!pg) return '<div class="meta" style="margin-top:8px">该步骤无独立业务页（如纯 AI 确认），无法设为入口。</div>';
  const pinned = typeof isFlowShortcut === 'function' && isFlowShortcut(flow.id, step.id);
  if (pinned) {
    return `<button class="btn btn-sm btn-ghost" style="margin-top:10px" type="button"
      onclick="removeFlowShortcut('${esc(flowShortcutId(flow.id, step.id))}');toast('已移除','${esc(step.label)}')">取消快速入口</button>`;
  }
  return `<button class="btn btn-sm btn-pri" style="margin-top:10px" type="button"
    onclick="flowRegisterShortcutFromStep('${esc(flow.id)}','${esc(step.id)}')">设为快速入口</button>`;
}

function flowRegisterShortcutFromStep(flowId, stepId) {
  const flow = flowData?.flows?.find(f => f.id === flowId);
  const step = flow?.steps?.find(s => s.id === stepId);
  if (!flow || !step) return;
  const pg = flowStepTargetPage(step);
  if (!pg) return toast('无法添加入口', '该步骤没有可跳转的业务页');
  registerFlowShortcut({
    flowId, stepId, page: pg,
    label: step.label, flowName: flow.name, color: flow.color,
  });
}

function flowCloseDetail() {
  flowDetailFlow = null;
  flowDetailStep = null;
  $('#flow-body')?.classList.remove('has-detail');
  $('#flow-stage')?.querySelectorAll('.flow-node.on').forEach(n => n.classList.remove('on'));
}

function flowShowStepDetail(flow, step) {
  flowDetailFlow = flow;
  flowDetailStep = step;
  const el = $('#flow-detail-body');
  const body = $('#flow-body');
  if (!el) return;
  body?.classList.add('has-detail');
  const st = step.ref && flowData?.stats?.[step.ref];
  const statsHtml = st ? `<div style="margin-top:8px">
    <span class="flow-stat ok">7日内 confirmed ${st.confirmed_7d}</span>
    ${st.pending ? `<span class="flow-stat wait">待确认 ${st.pending}</span>` : ''}
    ${st.last_at ? `<div class="meta" style="margin-top:6px">最近事件 ${dt(st.last_at)}</div>` : ''}
  </div>` : '';
  const pg = flowStepTargetPage(step);
  const openBtn = pg
    ? `<button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="go('${esc(pg)}')">打开「${esc(flowData.pageLabels?.[pg] || pg)}」</button>` : '';
  const zones = [...new Set([...flowStepPageZones(step), ...flowStepProjectZones(step)])];
  el.innerHTML = `<div class="t" style="color:${esc(flow.color)}">${esc(flow.name)}</div>
    <div class="meta">${esc(step.label)} · ${esc(FLOW_TYPE_LABEL[step.kind] || step.kind)}</div>
    <div class="kv">
      ${zones.length ? `<div>业务域 ${zones.map(z => FLOW_ZONE_LABEL[z] || z).join(' · ')}</div>` : ''}
      ${step.ref ? `<div>能力 <b>${esc(step.ref)}</b></div>` : ''}
      ${step.pages?.length ? `<div>关联页面 ${step.pages.map(p => esc(flowData.pageLabels?.[p] || p)).join(' · ')}</div>` : ''}
      ${step.projects?.length ? `<div>写入投影 ${step.projects.map(flowEntityLabel).join(' · ')}</div>` : ''}
      ${step.confirm ? `<div>需确认卡 <b>是</b></div>` : ''}
      ${step.note ? `<div>${esc(step.note)}</div>` : ''}
    </div>${statsHtml}${openBtn}${flowShortcutBtnHtml(flow, step)}`;
}

function refreshFlowDetailPanel() {
  if (flowDetailFlow && flowDetailStep) flowShowStepDetail(flowDetailFlow, flowDetailStep);
  if (flowView === 'lanes') flowRenderStage();
}

function flowShowDetailPane() {
  if (!flowDetailStep) flowCloseDetail();
}

function flowSyncChrome() {
  $$('.flow-zone-tab').forEach(btn => btn.classList.toggle('on', btn.dataset.zone === flowZone));
  $$('.flow-view-tab').forEach(btn => btn.classList.toggle('on', btn.dataset.view === flowView));
  const list = $('#flow-list-items');
  if (!list) return;
  const flows = flowVisibleFlows();
  list.innerHTML = `<button class="flow-item ${!flowSelId ? 'on' : ''}" type="button" data-flow="">
      <span class="name">全部链路</span><span class="sub">${flows.length} 条${flowZone ? '（已过滤）' : ''}</span></button>`
    + flows.map(f => `
      <button class="flow-item ${flowSelId === f.id ? 'on' : ''}" type="button" data-flow="${esc(f.id)}">
        <span class="name"><span class="dot" style="background:${esc(f.color)}"></span>${esc(f.name)}</span>
        <span class="sub">${esc(f.desc)}</span>
      </button>`).join('');
  list.querySelectorAll('.flow-item').forEach(btn => {
    btn.onclick = () => {
      flowSelId = btn.dataset.flow || null;
      flowCloseDetail();
      if (flowSelId && flowView === 'overview') flowView = 'lanes';
      flowSyncChrome();
      flowRenderStage();
    };
  });
}

async function flowAnimateSelected() {
  if (flowPulseTimer) clearTimeout(flowPulseTimer);
  const flows = flowVisibleFlows();
  const flow = flows.find(f => f.id === flowSelId) || flows[0];
  if (!flow) return toast('暂无可播放链路', '当前列表为空');
  flowSelId = flow.id;
  flowView = 'lanes';
  flowRenderStage();
  flowSyncChrome();
  const board = $('#flow-board');
  if (!board) return;
  for (const step of flow.steps) {
    board.querySelectorAll('.flow-node').forEach(n => n.classList.remove('pulse'));
    const el = board.querySelector(`.flow-node[data-flow-id="${CSS.escape(flow.id)}"][data-step-id="${CSS.escape(step.id)}"]`);
    if (!el) continue;
    el.classList.add('pulse');
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    await new Promise(r => { flowPulseTimer = setTimeout(r, 580); });
  }
  board.querySelectorAll('.flow-node').forEach(n => n.classList.remove('pulse'));
}

// 流程设计器入口（2026-08-28）：链路图谱页直达可视化画布编辑器（admin）
async function openFlowDesigner() {
  try {
    const wf = await apiJSON('api/workflows');
    const flows = wf.flows || [];
    if (!flows.length) return toast('没有流程', '系统里还没有可编辑的流程模板');
    openSchemaForm({
      title: '流程设计器 · 选择流程',
      description: '画布中拖拽节点/连线/配置审批角色，发布后仅影响新实例。',
      required: ['flow'],
      properties: { flow: { type: 'string', title: '流程', enum: flows.map(f => f.id), enumNames: flows.map(f => f.name || f.id) } },
      onSubmit: async ({ flow }) => { openFlowEditor(flow); },
    });
  } catch (e) { toast('加载失败', e.message); }
}

RENDER.flows = async function () {
  flowDetailFlow = null;
  flowDetailStep = null;
  mainBox().innerHTML = `
    <div class="flow-page-root">
      <div class="page-hd page-heading">
        <h1>链路图谱</h1>
      </div>
      <div class="flow-chrome">
        <div class="flow-zone-bar" id="flow-zone-bar">
          ${['', 'finance', 'sales', 'supply'].map(z => `
            <button type="button" class="flow-zone-tab ${z === flowZone ? 'on' : ''}" data-zone="${z}"
              style="${z ? `--zt:${FLOW_ZONE_COLOR[z]}` : ''}">${esc(FLOW_ZONE_LABEL[z])}${z ? '视角' : ''}</button>
          `).join('')}
        </div>
        <div class="flow-view-bar" id="flow-view-bar">
          ${Object.entries(FLOW_VIEW_LABEL).map(([k, label]) => `
            <button type="button" class="flow-view-tab ${k === flowView ? 'on' : ''}" data-view="${k}">${esc(label)}</button>
          `).join('')}
        </div>
        <div class="flow-toolbar">
          <button class="btn btn-sm btn-pri" id="flow-btn-design" type="button" style="display:${currentUserInfo?.role === 'admin' ? '' : 'none'}">流程设计器</button>
          <button class="btn btn-sm btn-pri" id="flow-btn-animate" type="button">播放链路</button>
          <label class="cell-sub flow-live-label">
            <input type="checkbox" id="flow-live-toggle" ${flowLive ? 'checked' : ''}> 运行态着色
          </label>
        </div>
      </div>
      <div class="flow-body" id="flow-body">
        <div class="flow-main">
          <aside class="flow-list"><div class="flow-list-hd">链路</div><div id="flow-list-items"></div></aside>
          <div class="flow-stage-wrap"><div id="flow-stage" class="flow-stage"></div></div>
        </div>
        <aside class="flow-detail">
          <div class="flow-detail-hd">详情 <button type="button" class="flow-detail-close" id="flow-detail-close" aria-label="关闭详情">×</button></div>
          <div id="flow-detail-body"></div>
          <div class="flow-legend">
            <span><i class="lg-in"></i>当前视角步骤</span>
            <span><i class="lg-out"></i>外区步骤</span>
            <span><i class="lg-pin"></i>已注册快速入口</span>
          </div>
        </aside>
      </div>
    </div>`;

  try {
    flowData = await apiJSON('api/flows');
  } catch (e) {
    $('#flow-list-items').innerHTML = `<div class="wfail">${esc(e?.message || '加载失败')}</div>`;
    return;
  }

  $('#flow-zone-bar').querySelectorAll('.flow-zone-tab').forEach(btn => {
    btn.onclick = () => {
      flowZone = btn.dataset.zone;
      flowSelId = null;
      flowCloseDetail();
      flowSyncChrome();
      flowRenderStage();
    };
  });
  $('#flow-view-bar').querySelectorAll('.flow-view-tab').forEach(btn => {
    btn.onclick = () => {
      flowView = btn.dataset.view;
      flowCloseDetail();
      flowSyncChrome();
      flowRenderStage();
    };
  });
  $('#flow-btn-animate').onclick = () => flowAnimateSelected();
    const designBtn = $('#flow-btn-design');
    if (designBtn) designBtn.onclick = () => openFlowDesigner();
  $('#flow-live-toggle').onchange = (e) => { flowLive = e.target.checked; flowRenderStage(); };
  $('#flow-detail-close').onclick = () => flowCloseDetail();

  flowSyncChrome();
  flowRenderStage();
};
