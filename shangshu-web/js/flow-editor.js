/* ============ 流程编辑器核心（LogicFlow，2026-08-28）
   两种挂载方式：
   - flowEditorEmbed({toolbar, canvas, panel}, flowId) —— 页面内嵌（「流程」页本体即画布）
   - openFlowEditor(flowId) —— 全屏弹层（其他页面的编辑按钮用）
   业务映射：模板 graph ↔ LogicFlow graphData；发布走 meta 版本链；回放=轨迹标记。
*/
(function () {
  const KIND_MARK = { capability: '◆', approval: '✓', agent: '✦', gateway: '◇' };
  const KIND_LABEL = { capability: '步骤', approval: '审批', agent: 'AI', gateway: '分支' };
  const ROLE_CN = { admin: '管理员', finance: '会计', manager: '项目负责人', staff: '员工' };
  const EDIT_ICON = {
    edit: ic('<path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    start: ic('<path d="M8 5l11 7-11 7z"/>'),
    remove: ic('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'),
    close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
  };
  // @logicflow/core UMD 挂在 window.Core（default / LogicFlow 都是构造函数），不是 window.LogicFlow
  function resolveLogicFlow() {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    const ns = g.Core || g.LogicFlow;
    if (!ns) return null;
    const Ctor = typeof g.LogicFlow === 'function'
      ? g.LogicFlow
      : (typeof ns === 'function' ? ns : (ns.default || ns.LogicFlow));
    if (typeof Ctor !== 'function') return null;
    const pack = (typeof ns === 'object' && ns) || g.Core || Ctor;
    return {
      LogicFlow: Ctor,
      RectNode: pack.RectNode || Ctor.RectNode,
      RectNodeModel: pack.RectNodeModel || Ctor.RectNodeModel,
    };
  }
  let LFLib = null;
  let lf = null;
  let nodeType = 'rect';
  let canvasRo = null;
  let E = null;          // 当前流程编辑状态（含 capability 目录与选中节点）
  let C = null;          // 挂载容器 {toolbar, palette?, canvas, panel}

  async function loadTemplate(flowId) {
    try {
      const m = await apiJSON('api/metadata/flow/' + encodeURIComponent(flowId));
      const rec = m.entry || m;
      if (m?.ok && rec?.payload) return { tpl: rec.payload, version: Number(rec.version) || 0 };
    } catch { /* 未发布或无权限 → 运行时模板 */ }
    const r = await apiJSON('api/workflows/' + encodeURIComponent(flowId));
    if (!r?.ok) throw new Error(r?.error || '流程不存在');
    return { tpl: r.flow, version: Number(r.version ?? r.flow?.revision) || 0 };
  }
  function linearToGraph(steps) {
    const nodes = steps.map((s, i) => ({
      id: s.id, kind: s.strategy === 'agent' ? 'agent' : 'capability', name: s.name || s.id,
      capability: s.capability, candidateTools: s.candidateTools, inputMap: s.inputMap,
      when: s.when, retry: s.retry, optional: s.optional, note: s.note, ui: { x: 100 + i * 200, y: 132 },
    }));
    const edges = [];
    for (let i = 0; i + 1 < nodes.length; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
    return { nodes, edges, start: nodes[0]?.id || '' };
  }
  const toLf = (n) => ({ x: (n.ui?.x ?? 100) + 80, y: (n.ui?.y ?? 120) + 28 });
  const fromLf = (x, y) => ({ x: Math.round(x - 80), y: Math.round(y - 28) });
  const nodeText = (n) => `${KIND_MARK[n.kind || 'capability']} ${n.name || n.id}`;
  function edgeLabel(e) {
    return e.label || (e.kind === 'rejected' ? '拒绝' : e.kind === 'timeout' ? '超时' : e.kind === 'success' ? '通过' : (e.when ? '= ' + JSON.stringify(e.when.equals) : ''));
  }
  function toGraphData(tpl) {
    const g = tpl.graph && tpl.graph.nodes?.length ? tpl.graph : linearToGraph(tpl.steps || []);
    return {
      start: g.start || (g.nodes[0] && g.nodes[0].id) || '',
      nodes: g.nodes.map(n => ({ id: n.id, type: 'rect', x: toLf(n).x, y: toLf(n).y, text: nodeText(n), properties: { ...n, _name: n.name || n.id } })),
      edges: g.edges.map((e, i) => ({ id: `e_${e.from}_${e.to}_${i}`, type: 'polyline', sourceNodeId: e.from, targetNodeId: e.to, text: edgeLabel(e), properties: { kind: e.kind || 'success', when: e.when, label: e.label || '' } })),
    };
  }
  const cloneGraph = (data) => JSON.parse(JSON.stringify(data || { nodes:[], edges:[] }));
  function previewGraph(data, axis) {
    const out = cloneGraph(data);
    const nodes = out.nodes || [];
    if (!nodes.length) return out;
    const byId = Object.fromEntries(nodes.map(n => [String(n.id), n]));
    const next = {};
    for (const e of out.edges || []) (next[String(e.sourceNodeId)] ||= []).push(String(e.targetNodeId));
    const depth = {};
    const start = String(E?.start || nodes[0].id);
    const queue = [[start, 0]];
    while (queue.length) {
      const [id, d] = queue.shift();
      if (!byId[id] || (depth[id] != null && depth[id] <= d)) continue;
      depth[id] = d;
      for (const target of next[id] || []) queue.push([target, d + 1]);
    }
    let tail = Math.max(0, ...Object.values(depth));
    for (const n of nodes) if (depth[String(n.id)] == null) depth[String(n.id)] = ++tail;
    const layers = {};
    for (const n of nodes) (layers[depth[String(n.id)]] ||= []).push(n);
    for (const group of Object.values(layers)) group.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const [rawDepth, group] of Object.entries(layers)) {
      const d = Number(rawDepth);
      group.forEach((n, index) => {
        const offset = index - (group.length - 1) / 2;
        if (axis === 'vertical') { n.x = 360 + offset * 220; n.y = 105 + d * 106; }
        else { n.x = 118 + d * 212; n.y = 250 + offset * 148; }
        if (n.text && typeof n.text === 'object') { n.text.x = n.x; n.text.y = n.y; }
      });
    }
    return out;
  }
  function fromGraphData(data) {
    const nodes = (data.nodes || []).map(n => {
      const p = n.properties || {};
      const out = { id: String(n.id), kind: p.kind || 'capability', name: p._name || String(n.text?.value ?? n.id).replace(/^\S+\s/, ''), ui: fromLf(n.x, n.y) };
      if (out.kind === 'capability') { out.capability = p.capability || ''; if (p.when) out.when = p.when; if (p.retry) out.retry = p.retry; if (p.optional) out.optional = true; }
      if (out.kind === 'agent') out.candidateTools = p.candidateTools || [];
      if (out.kind === 'approval') out.approval = p.approval;
      if (out.kind === 'gateway') out.switch = p.switch;
      if (p.inputMap && Object.keys(p.inputMap).length) out.inputMap = p.inputMap;
      if (p.note) out.note = p.note;
      return out;
    });
    const edges = (data.edges || []).map(e => ({
      from: String(e.sourceNodeId), to: String(e.targetNodeId),
      ...(e.properties?.kind && e.properties.kind !== 'success' ? { kind: e.properties.kind } : {}),
      ...(e.properties?.when ? { when: e.properties.when } : {}),
      ...(e.properties?.label ? { label: e.properties.label } : {}),
    }));
    return { nodes, edges, start: E.start };
  }
  function markDirty() {
    if (!E) return;
    E.dirty = true;
    const t = C.toolbar.querySelector('.fe-tag'); if (t) t.textContent = `v${E.version}`;
    const s = C.toolbar.querySelector('.fe-state-text'); if (s) s.textContent = '未发布修改';
  }
  const dndText = (kind) => `${KIND_MARK[kind]} 新${KIND_LABEL[kind] || '节点'}`;
  const dndProps = (kind) => {
    const p = { kind, _name: dndText(kind) };
    if (kind === 'approval') p.approval = { roles: ['finance'], mode: 'serial' };
    if (kind === 'gateway') p.switch = { path: '' };
    if (kind === 'agent') p.candidateTools = [];
    if (kind === 'capability') { p.capability = 'flow.note'; p.inputMap = { note: '' }; }
    return p;
  };
  function addNode(kind) {
    if (!lf) return toast('画布未就绪', '请稍候再试');
    const box = C.canvas.getBoundingClientRect();
    let x = 220, y = 160;
    try {
      const p = lf.getPointByClient(box.left + box.width * 0.42, box.top + box.height * 0.38);
      const pos = p?.canvasOverlayPosition || p?.dropPoint || p;
      if (pos && Number.isFinite(pos.x)) { x = pos.x; y = pos.y; }
    } catch { /* 用默认坐标 */ }
    const n = (lf.getGraphData().nodes || []).length;
    const id = 'n_' + Date.now().toString(36) + n;
    try {
      lf.addNode({
        id, type: nodeType,
        x: x + (n % 4) * 28, y: y + (n % 4) * 20,
        text: dndText(kind),
        properties: dndProps(kind),
      });
    } catch (e) { return toast('加节点失败', String((e && e.message) || e)); }
    E.sel = { type: 'node', id };
    markDirty();
    renderPanel();
    syncAiContext();
  }

  function renderPalette() {
    if (!C?.palette) return;
    const canEdit = E?.editMode && currentUserInfo?.role === 'admin';
    C.palette.innerHTML = `<div class="fe-palette-title">节点 <span>点击添加</span></div>
      ${[
        ['capability','数据与工具','查询、新增、更新或发送通知'],
        ['approval','人工审批','按角色串行或任一通过'],
        ['agent','AI 决策','只在候选能力白名单内选择'],
        ['gateway','条件分支','按运行数据选择出口'],
      ].map(([kind,name,note]) => `<button type="button" class="fe-palette-item" data-add="${kind}" title="${esc(note)}" ${canEdit ? '' : 'disabled'}><span class="mark ${kind}">${KIND_MARK[kind]}</span><b>${name}</b></button>`).join('')}
      <div class="fe-palette-rule">能力受注册契约约束</div>`;
    C.palette.querySelectorAll('[data-add]').forEach(b => { b.onclick = () => addNode(b.dataset.add); });
  }

  function currentNode() {
    if (!E?.sel || E.sel.type !== 'node' || !lf) return null;
    const data = (lf.getGraphData().nodes || []).find(n => String(n.id) === String(E.sel.id));
    return data ? { id:String(data.id), name:nodeDisplayName(data), kind:data.properties?.kind || 'capability' } : null;
  }
  function syncAiContext() {
    if (!E || typeof chatSetBusinessContext !== 'function') return;
    const node = currentNode();
    chatSetBusinessContext({
      module:'flowdesign', view:'workflow-builder', entity_type:'flow', entity_id:E.flowId,
      label:node ? `${E.name} · ${node.name}` : `工作流 · ${E.name}`,
      metadata_kind:'flow', metadata_key:E.flowId, metadata_revision:E.version,
      selected_node_id:node?.id || '', editable_scope:node ? `优先只修改节点 ${node.id}` : '流程结构、输入、节点与连线',
    });
  }

  function syncShellClass() {
    const shell = C?.toolbar?.closest('.fdw-main') || C?.toolbar?.closest('.fe-shell');
    if (shell) shell.classList.toggle('is-editing', !!E?.editMode);
  }
  function setEditMode(on) {
    if (!E) return;
    if (on && currentUserInfo?.role !== 'admin') return;
    if (!on && E.dirty && !confirm('有未发布改动，确定退出编辑？')) return;
    if (!on && E.dirty) {
      E.name = E.sourceMeta.name;
      E.description = E.sourceMeta.description;
      E.inputSchema = cloneGraph(E.sourceMeta.inputSchema);
      E.dirty = false;
    }
    E.editMode = !!on;
    if (!on) E.sel = null;
    E.previewAxis = '';
    if (lf) {
      const data = on ? cloneGraph(E.sourceData) : previewGraph(E.sourceData, C.canvas.clientWidth < 760 ? 'vertical' : 'horizontal');
      for (const n of data.nodes || []) n.type = nodeType;
      lf.render(data);
      E.previewAxis = on ? '' : (C.canvas.clientWidth < 760 ? 'vertical' : 'horizontal');
    }
    try { lf.updateEditConfig({ isSilentMode: !on }); } catch { /* */ }
    renderToolbar();
    renderPalette();
    renderPanel();
    requestAnimationFrame(() => sizeLf(true));
  }
  function renderToolbar() {
    const isAdmin = currentUserInfo?.role === 'admin';
    const editing = !!(E.editMode && isAdmin);
    syncShellClass();
    if (!editing) {
      C.toolbar.innerHTML = `
        ${isAdmin ? `<button type="button" class="wf-icon-btn" id="fe-edit" title="编辑流程" aria-label="编辑流程">${EDIT_ICON.edit}</button>` : ''}`;
      const ed = C.toolbar.querySelector('#fe-edit');
      if (ed) ed.onclick = () => setEditMode(true);
      return;
    }
    C.toolbar.innerHTML = `
      <span class="fe-status"><span class="fe-tag tag">v${E.version}</span><span class="fe-state-text">${E.dirty ? '未发布修改' : '编辑中'}</span></span>
      <button type="button" class="wf-icon-btn" id="fe-start" title="设为起点" aria-label="设为起点">${EDIT_ICON.start}</button>
      <button type="button" class="wf-icon-btn" id="fe-del" title="删除选中" aria-label="删除选中">${EDIT_ICON.remove}</button>
      <button type="button" class="wf-icon-btn" id="fe-exit" title="退出编辑" aria-label="退出编辑">${EDIT_ICON.close}</button>
      <button type="button" class="wf-icon-btn fe-publish" id="fe-publish" title="发布" aria-label="发布">${ICONS.check}</button>`;
    C.toolbar.querySelector('#fe-start').onclick = () => {
      if (!E.sel || E.sel.type !== 'node') return toast('设为起点', '先点选一个节点');
      E.start = E.sel.id; markDirty();
    };
    C.toolbar.querySelector('#fe-del').onclick = () => {
      if (!E.sel) return toast('删除', '先点选节点或连线');
      lf.deleteElement(E.sel.id); E.sel = null; markDirty(); renderPanel();
    };
    C.toolbar.querySelector('#fe-exit').onclick = () => setEditMode(false);
    C.toolbar.querySelector('#fe-publish').onclick = publish;
    renderPalette();
  }

  // 节点统一白底，只用细边框区分语义；选中态由库处理。
  const NODE_PALETTE = {
    capability: { fill: 'var(--bg)', stroke: 'rgba(30,35,44,.22)' },
    approval:   { fill: 'var(--bg)', stroke: 'rgba(30,35,44,.22)' },
    agent:      { fill: 'var(--bg)', stroke: 'rgba(30,35,44,.22)' },
    gateway:    { fill: 'var(--bg)', stroke: 'rgba(30,35,44,.22)' },
  };
  let fittedOnce = false;
  let lastFitW = 0;
  let lastFitH = 0;
  let lastResizeW = 0;
  let lastResizeH = 0;
  let resizeFrame = 0;
  function destroyLf() {
    if (canvasRo) { try { canvasRo.disconnect(); } catch { /* */ } canvasRo = null; }
    if (resizeFrame) { cancelAnimationFrame(resizeFrame); resizeFrame = 0; }
    if (lf) {
      try { if (typeof lf.destroy === 'function') lf.destroy(); } catch { /* */ }
      lf = null;
    }
    fittedOnce = false;
    lastFitW = 0;
    lastFitH = 0;
    lastResizeW = 0;
    lastResizeH = 0;
    if (C?.canvas) C.canvas.innerHTML = '';
  }
  function sizeLf(force) {
    if (!lf || !C?.canvas) return;
    const r = C.canvas.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const resized = Math.abs(r.width - lastResizeW) > 0.5 || Math.abs(r.height - lastResizeH) > 0.5;
    if (force || resized) {
      try { if (typeof lf.resize === 'function') lf.resize(r.width, r.height); } catch { try { lf.resize(); } catch { /* */ } }
      lastResizeW = r.width;
      lastResizeH = r.height;
    }
    const axis = r.width < 760 ? 'vertical' : 'horizontal';
    if (!E?.editMode && E?.previewAxis !== axis) {
      const data = previewGraph(E.sourceData, axis);
      for (const n of data.nodes || []) n.type = nodeType;
      lf.render(data);
      E.previewAxis = axis;
      force = true;
    }
    const ready = r.width >= 120 && r.height >= 120;
    const jumped = Math.abs(r.width - lastFitW) > 80 || Math.abs(r.height - lastFitH) > 80;
    if (ready && (force || !fittedOnce || jumped)) {
      try { lf.fitView(56, 40); } catch { /* */ }
      fittedOnce = true;
      lastFitW = r.width;
      lastFitH = r.height;
    }
  }
  function initLf(data) {
    destroyLf();
    lf = new LFLib.LogicFlow({
      container: C.canvas,
      width: Math.max(C.canvas.clientWidth, 1),
      height: Math.max(C.canvas.clientHeight, 1),
      grid: { size: 20, visible: false, type: 'dot' },
      background: { color: 'transparent' },
      keyboard: { enabled: !!E.editMode },
      edgeType: 'polyline',
      textEdit: false,
      isSilentMode: !E.editMode,
    });
    nodeType = 'rect';
    try {
      const { RectNode, RectNodeModel } = LFLib;
      if (typeof RectNode !== 'function' || typeof RectNodeModel !== 'function') throw new Error('RectNode 未导出');
      class FlowRectModel extends RectNodeModel {
        initNodeData(d) { super.initNodeData(d); this.width = 184; this.height = 52; this.radius = 6; }
        getNodeStyle() {
          const st = super.getNodeStyle();
          const c = NODE_PALETTE[(this.properties && this.properties.kind) || 'capability'] || NODE_PALETTE.capability;
          st.fill = c.fill; st.stroke = c.stroke; st.strokeWidth = 1.1;
          return st;
        }
      }
      lf.register({ type: 'flow-rect', view: RectNode, model: FlowRectModel });
      nodeType = 'flow-rect';
      for (const n of data.nodes || []) n.type = nodeType;
    } catch (e) { console.warn('[flow-editor] 自定义节点注册失败，回落默认 rect', e); }
    lf.setTheme({
      rect: { rx: 6, ry: 6, stroke: 'rgba(30,35,44,.22)', strokeWidth: 1.1, fill: 'var(--bg)' },
      polyline: { stroke: 'rgba(30,35,44,.27)', strokeWidth: 1.2, offset: 24, adjustLine: { stroke: 'var(--green)' } },
      anchor: { r: 3, fill: 'var(--bg)', stroke: 'var(--green)' },
      arrow: { offsetTop: 6, offsetBottom: 8 },
      edgeText: { fontSize: 11, color: 'var(--fg2)', background: { fill: 'var(--bg)', stroke: 'var(--line)', radius: 4 }, padding: [2, 6, 2, 6] },
      nodeText: { fontSize: 13, color: 'var(--fg)', overflowMode: 'ellipsis' },
    });
    E.previewAxis = E.editMode ? '' : (C.canvas.clientWidth < 760 ? 'vertical' : 'horizontal');
    const initialData = E.editMode ? data : previewGraph(E.sourceData, E.previewAxis);
    for (const n of initialData.nodes || []) n.type = nodeType;
    lf.render(initialData);
    lf.on('node:click', ({ data }) => { E.sel = { type: 'node', id: String(data.id) }; renderPanel(); syncAiContext(); });
    lf.on('edge:click', ({ data }) => { E.sel = { type: 'edge', id: String(data.id) }; renderPanel(); syncAiContext(); });
    lf.on('blank:click', () => { E.sel = null; renderPanel(); syncAiContext(); });
    lf.on('node:drop', () => { if (E.editMode) markDirty(); });
    lf.on('edge:add', () => { if (E.editMode) markDirty(); });
    lf.on('node:delete', () => { if (E.editMode) markDirty(); });
    lf.on('edge:delete', () => { if (E.editMode) markDirty(); });
    requestAnimationFrame(() => requestAnimationFrame(() => sizeLf(true)));
    setTimeout(() => sizeLf(true), 80);
    setTimeout(() => sizeLf(true), 240);
    if (typeof ResizeObserver === 'function') {
      canvasRo = new ResizeObserver(() => {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; sizeLf(); });
      });
      canvasRo.observe(C.canvas);
    }
  }

  function nodeDisplayName(n) {
    const p = n.properties || {};
    return p._name || String(n.text?.value ?? n.id).replace(/^\S+\s/, '');
  }
  function roleText(roles) {
    return (roles || []).map(r => ROLE_CN[r] || r).join('、') || '未指定';
  }
  function nodeSubline(n) {
    const p = n.properties || {};
    const kind = p.kind || 'capability';
    if (kind === 'approval') {
      const mode = p.approval?.mode === 'any' ? '任一通过' : '依次审';
      return `审批 · ${roleText(p.approval?.roles)} · ${mode}`;
    }
    if (kind === 'agent') return 'AI 步骤';
    if (kind === 'gateway') return '分支';
    return p.note || '办理步骤';
  }
  function orderedNodes() {
    const data = lf.getGraphData();
    const nodes = data.nodes || [];
    const byId = Object.fromEntries(nodes.map(n => [String(n.id), n]));
    const succ = {};
    for (const e of data.edges || []) {
      const k = e.properties?.kind;
      if (k === 'rejected' || k === 'timeout') continue;
      (succ[String(e.sourceNodeId)] ||= []).push(String(e.targetNodeId));
    }
    const out = [];
    const seen = new Set();
    const walk = (id) => {
      if (!id || seen.has(id) || !byId[id]) return;
      seen.add(id);
      out.push(byId[id]);
      for (const t of (succ[id] || [])) walk(t);
    };
    walk(String(E.start || nodes[0]?.id || ''));
    for (const n of nodes) if (!seen.has(String(n.id))) out.push(n);
    return out;
  }
  function renderPreviewPanel() {
    const p = C.panel;
    const rows = orderedNodes();
    const selId = E.sel?.type === 'node' ? E.sel.id : '';
    p.innerHTML = `
      <div class="fe-panel-hd">流程步骤</div>
      <ol class="fe-steps">
        ${rows.map(n => {
          const id = String(n.id);
          const on = id === selId ? ' on' : '';
          return `<li class="fe-step${on}" data-nid="${esc(id)}"><b>${esc(nodeDisplayName(n))}</b><small>${esc(nodeSubline(n))}</small></li>`;
        }).join('') || '<li class="fe-step"><b>还没有步骤</b></li>'}
      </ol>`;
    p.querySelectorAll('[data-nid]').forEach(el => {
      el.onclick = () => {
        E.sel = { type: 'node', id: el.dataset.nid };
        try { lf.selectElementById(el.dataset.nid); } catch { /* */ }
        renderPreviewPanel();
      };
    });
  }
  function inputFieldRows() {
    const schema = E.inputSchema || { type:'object', properties:{} };
    const required = new Set(schema.required || []);
    return Object.entries(schema.properties || {}).map(([key, spec]) => `<div class="fe-input-row" data-input-row data-original-key="${esc(key)}">
      <input data-input-key value="${esc(key)}" aria-label="字段标识">
      <input data-input-title value="${esc(spec.title || key)}" aria-label="字段名称">
      <select data-input-type aria-label="字段类型">${[['string','文本'],['number','数字'],['boolean','是/否'],['object','对象'],['array','列表']].map(([v,n]) => `<option value="${v}" ${spec.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label><input type="checkbox" data-input-required ${required.has(key) ? 'checked' : ''}>必填</label>
      <button type="button" data-input-remove title="删除">×</button>
    </div>`).join('');
  }
  function collectInputSchema() {
    const properties = {}, required = [];
    C.panel.querySelectorAll('[data-input-row]').forEach(row => {
      const key = row.querySelector('[data-input-key]').value.trim();
      if (!key) return;
      const original = row.dataset.originalKey || key;
      const previous = E.inputSchema?.properties?.[original] || {};
      properties[key] = { ...previous, type:row.querySelector('[data-input-type]').value, title:row.querySelector('[data-input-title]').value.trim() || key };
      if (row.querySelector('[data-input-required]').checked) required.push(key);
    });
    E.inputSchema = { type:'object', properties, ...(required.length ? {required} : {}) };
  }
  function mappingRows(map) {
    const src = map && typeof map === 'object' ? map : {};
    const simple = Object.entries(src).filter(([,v]) => ['string','number','boolean'].includes(typeof v));
    const advanced = Object.entries(src).filter(([,v]) => !['string','number','boolean'].includes(typeof v));
    return `<div class="fe-map-list">${simple.map(([key,value]) => `<div class="fe-map-row" data-map-row><input data-map-key value="${esc(key)}" placeholder="参数"><span>←</span><input data-map-value value="${esc(String(value))}" placeholder="$input.字段"></div>`).join('')}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="fp-map-add">＋ 添加映射</button>
      ${advanced.length ? `<div class="fe-advanced-note">已保留 ${advanced.map(([k])=>`<code>${esc(k)}</code>`).join('、')} 的高级映射。可让 AI 在不破坏其他配置的前提下修改。</div>` : ''}`;
  }
  function collectMapping(previous) {
    const out = {};
    for (const [key,value] of Object.entries(previous || {})) if (!['string','number','boolean'].includes(typeof value)) out[key] = value;
    C.panel.querySelectorAll('[data-map-row]').forEach(row => {
      const key = row.querySelector('[data-map-key]').value.trim();
      const value = row.querySelector('[data-map-value]').value.trim();
      if (!key) return;
      out[key] = value === 'true' ? true : value === 'false' ? false : (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
    });
    return Object.keys(out).length ? out : undefined;
  }
  function renderPanelBindingsAfterAdd(saveMeta) {
    C.panel.querySelectorAll('[data-input-row] input,[data-input-row] select').forEach(el => { el.onchange = saveMeta; });
    C.panel.querySelectorAll('[data-input-remove]').forEach(btn => { btn.onclick = () => { btn.closest('[data-input-row]').remove(); saveMeta(); }; });
  }
  function askAiDesign(prompt) {
    if (!E || typeof chatAssist !== 'function') return toast('AI 助手未就绪', '请刷新页面后重试');
    const node = currentNode();
    chatAssist({
      module:'flowdesign', view:'workflow-builder', entity_type:'flow', entity_id:E.flowId,
      label:node ? `${E.name} · ${node.name}` : `设计工作流 · ${E.name}`,
      metadata_kind:'flow', metadata_key:E.flowId, metadata_revision:E.version,
      selected_node_id:node?.id || '', editable_scope:node ? `优先只修改节点 ${node.id}` : '流程结构、输入、节点与连线',
    }, prompt);
  }
  function renderPanel() {
    const p = C.panel;
    if (!lf || !E) return;
    const editing = !!(E.editMode && currentUserInfo?.role === 'admin');
    if (!editing) { renderPreviewPanel(); return; }
    if (!E.sel) {
      p.innerHTML = `
        <div class="fe-panel-hd">流程设置</div>
        <div class="fe-panel-hint">节点和连线负责执行顺序；这里定义流程名称及发起表单。</div>
        <label class="fe-row">流程名称 <input id="fp-flow-name" value="${esc(E.name || '')}"></label>
        <label class="fe-row">使用说明 <textarea id="fp-flow-desc" rows="3">${esc(E.description || '')}</textarea></label>
        <div class="fe-section-title">发起时填写</div>
        <div class="fe-input-list" id="fp-input-list">${inputFieldRows()}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="fp-input-add">＋ 添加字段</button>
        ${currentUserInfo?.role === 'admin' ? '<button type="button" class="fe-ai-help" id="fp-ai-flow"><b>✦ 让 AI 帮我设计</b><span>描述目标，AI 会读取当前版本和能力目录，先给草稿再提案发布。</span></button>' : ''}`;
      const saveMeta = () => {
        E.name = $('#fp-flow-name')?.value.trim() || E.flowId;
        E.description = $('#fp-flow-desc')?.value.trim() || '';
        collectInputSchema(); markDirty();
      };
      ['fp-flow-name', 'fp-flow-desc'].forEach(id => { const el = $('#' + id); if (el) el.onchange = saveMeta; });
      renderPanelBindingsAfterAdd(saveMeta);
      $('#fp-input-add').onclick = () => {
        $('#fp-input-list').insertAdjacentHTML('beforeend', `<div class="fe-input-row" data-input-row><input data-input-key placeholder="field_name"><input data-input-title placeholder="显示名称"><select data-input-type><option value="string">文本</option><option value="number">数字</option><option value="boolean">是/否</option><option value="object">对象</option><option value="array">列表</option></select><label><input type="checkbox" data-input-required>必填</label><button type="button" data-input-remove>×</button></div>`);
        renderPanelBindingsAfterAdd(saveMeta);
      };
      const ai = $('#fp-ai-flow'); if (ai) ai.onclick = () => askAiDesign('请根据我的目标辅助设计当前工作流。先读取当前流程版本、对象与能力目录，指出缺口并向我确认；不要直接改未讨论的节点。');
      return;
    }
    const pr = lf.getElementProperties(E.sel.id) || {};
    if (E.sel.type === 'node') {
      const kind = pr.kind || 'capability';
      const caps = E.capabilities || [];
      const roleBoxes = ['admin', 'finance', 'manager', 'staff'].map(r =>
        `<label class="fe-chk"><input type="checkbox" data-role="${r}" ${((pr.approval?.roles) || []).includes(r) ? 'checked' : ''}> ${ROLE_CN[r] || r}</label>`).join('');
      const capabilityOptions = caps.map(c => `<option value="${esc(c.id)}" ${pr.capability === c.id ? 'selected' : ''}>${esc(c.name)} · ${esc(c.id)}</option>`).join('');
      const candidateChecks = caps.filter(c => ['read','extract','orchestrate'].includes(c.effect)).map(c => `<label class="fe-tool-check"><input type="checkbox" data-candidate="${esc(c.id)}" ${(pr.candidateTools || []).includes(c.id) ? 'checked' : ''}><span><b>${esc(c.name)}</b><small>${esc(c.id)} · ${esc(c.effect)}</small></span></label>`).join('');
      p.innerHTML = `
        <div class="fe-panel-hd">节点设置 <code>${esc(E.sel.id)}</code></div>
        <label class="fe-row">名称 <input id="fp-name" value="${esc(pr._name || '')}"></label>
        <label class="fe-row">类型
          <select id="fp-kind">${['capability', 'approval', 'agent', 'gateway'].map(k => `<option value="${k}" ${kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select></label>
        ${kind === 'capability' ? `<label class="fe-row">执行能力 <select id="fp-cap"><option value="">请选择已注册能力</option>${capabilityOptions}</select></label>` : ''}
        ${kind === 'agent' ? `<div class="fe-row"><b>AI 候选能力</b><span class="fe-panel-hint">运行时只能从勾选项中选择。</span><div class="fe-tool-list">${candidateChecks || '没有可供 AI 选择的能力'}</div></div>` : ''}
        ${kind === 'approval' ? `
          <div class="fe-row"><b>审批角色</b>${roleBoxes}</div>
          <label class="fe-row">模式
            <select id="fp-mode">
              <option value="serial" ${(pr.approval?.mode || 'serial') === 'serial' ? 'selected' : ''}>串行（按角色顺序逐个审）</option>
              <option value="any" ${pr.approval?.mode === 'any' ? 'selected' : ''}>任一（任一角色通过即过）</option>
            </select></label>
          <label class="fe-row">超时小时（走「超时」边）<input id="fp-timeout" type="number" min="0" step="1" value="${pr.approval?.timeout_hours ?? ''}"></label>` : ''}
        ${kind === 'gateway' ? `<label class="fe-row">取值路径 <input id="fp-switch" value="${esc(pr.switch?.path || '')}"></label>` : ''}
        ${kind === 'capability' || kind === 'agent' ? `<div class="fe-row"><b>输入映射</b><span class="fe-panel-hint">把本流程输入或前一步输出映射给这个节点。</span>${mappingRows(pr.inputMap)}</div>` : ''}
        <label class="fe-row">说明 <textarea id="fp-note" rows="2">${esc(pr.note || '')}</textarea></label>
        ${currentUserInfo?.role === 'admin' ? '<button type="button" class="fe-ai-help" id="fp-ai-node"><b>✦ 用 AI 修改这个节点</b><span>AI 将只处理当前节点及必要连线，其他配置保持不变。</span></button>' : ''}`;
      const commit = () => {
        const k = $('#fp-kind').value;
        const patch = { kind: k, _name: $('#fp-name').value.trim() || E.sel.id };
        patch.capability = k === 'capability' ? ($('#fp-cap')?.value.trim() || '') : undefined;
        patch.candidateTools = k === 'agent' ? [...C.panel.querySelectorAll('[data-candidate]')].filter(x => x.checked).map(x => x.dataset.candidate) : undefined;
        if (k === 'approval') {
          patch.approval = {
            roles: [...C.panel.querySelectorAll('[data-role]')].filter(c => c.checked).map(c => c.dataset.role),
            mode: $('#fp-mode')?.value || 'serial',
            timeout_hours: $('#fp-timeout')?.value ? Number($('#fp-timeout').value) : undefined,
          };
          if (!patch.approval.roles.length) { toast('审批节点', '至少选一个角色'); patch.approval.roles = ['finance']; }
        }
        patch.switch = k === 'gateway' ? { path: $('#fp-switch')?.value.trim() || '' } : undefined;
        if (k === 'capability' || k === 'agent') {
          patch.inputMap = collectMapping(pr.inputMap);
        }
        patch.note = $('#fp-note')?.value.trim() || undefined;
        lf.setProperties(E.sel.id, patch);
        lf.updateText(E.sel.id, `${KIND_MARK[k]} ${patch._name}`);
        markDirty();
      };
      ['fp-name', 'fp-cap', 'fp-mode', 'fp-timeout', 'fp-switch', 'fp-note'].forEach(id => { const el = $('#' + id); if (el) el.onchange = commit; });
      C.panel.querySelectorAll('[data-role]').forEach(cb => cb.onchange = commit);
      C.panel.querySelectorAll('[data-candidate]').forEach(cb => cb.onchange = commit);
      C.panel.querySelectorAll('[data-map-row] input').forEach(input => input.onchange = commit);
      const mapAdd = $('#fp-map-add'); if (mapAdd) mapAdd.onclick = () => {
        C.panel.querySelector('.fe-map-list').insertAdjacentHTML('beforeend', '<div class="fe-map-row" data-map-row><input data-map-key placeholder="参数"><span>←</span><input data-map-value placeholder="$input.字段"></div>');
        C.panel.querySelectorAll('[data-map-row] input').forEach(input => input.onchange = commit);
      };
      $('#fp-kind').onchange = () => { commit(); renderPanel(); };
      const nodeAi = $('#fp-ai-node'); if (nodeAi) nodeAi.onclick = () => askAiDesign(`请只优化当前选中节点 ${E.sel.id}（${pr._name || E.sel.id}）及必要连线。先解释问题和建议，得到我确认后再提交完整流程元数据提案。`);
      return;
    }
    const ep = pr;
    let isAppr = false;
    try {
      const gd = lf.getGraphData();
      const srcId2 = (gd.edges || []).find(e => String(e.id) === E.sel.id)?.sourceNodeId;
      const src = (gd.nodes || []).find(n => String(n.id) === String(srcId2));
      isAppr = src && (src.properties?.kind) === 'approval';
    } catch { /* false */ }
    p.innerHTML = `
      <div class="fe-panel-hd">连线</div>
      ${isAppr ? `<label class="fe-row">语义
        <select id="fe-kind">
          ${['success', 'rejected', 'timeout'].map(k => { const names = { success: '通过', rejected: '拒绝', timeout: '超时' }; return `<option value="${k}" ${(ep.kind || 'success') === k ? 'selected' : ''}>${names[k]}</option>`; }).join('')}
        </select></label>` : `
        <label class="fe-row">条件值（留空=默认边）<input id="fe-when" value="${esc(ep.when?.equals ?? '')}"></label>`}
      <label class="fe-row">标签 <input id="fe-label" value="${esc(ep.label || '')}"></label>`;
    const commit2 = () => {
      const patch = {};
      if (isAppr) patch.kind = $('#fe-kind')?.value || 'success';
      else {
        const v = $('#fe-when')?.value ?? '';
        patch.when = v === '' ? undefined : { equals: isNaN(Number(v)) ? v : Number(v) };
      }
      patch.label = $('#fe-label')?.value.trim() || undefined;
      lf.setProperties(E.sel.id, patch);
      markDirty();
    };
    ['fe-kind', 'fe-when', 'fe-label'].forEach(id => { const el = $('#' + id); if (el) el.onchange = commit2; });
  }

  async function publish() {
    const data = lf.getGraphData();
    const graph = fromGraphData(data);
    graph.start = E.start;
    if (!graph.nodes.some(n => n.id === graph.start)) graph.start = graph.nodes[0]?.id || '';
    const payload = { id: E.flowId, name: E.name, description: E.description, steps: [], graph, inputSchema: E.inputSchema };
    if (E.resultMap) payload.resultMap = E.resultMap;
    if (E.doctype) payload.doctype = E.doctype;
    try {
      const d = await submitJSON('api/metadata/drafts', { kind: 'flow', key: E.flowId, payload });
      const pub = await submitJSON(`api/metadata/drafts/${encodeURIComponent(d.id)}/publish`, { expected_revision: E.version });
      toast('已发布', `${E.flowId} → v${pub.revision}；仅影响新实例`);
      E.version = pub.revision; E.dirty = false;
      E.sourceData = cloneGraph(lf.getGraphData());
      E.sourceMeta = { name:E.name, description:E.description, inputSchema:cloneGraph(E.inputSchema) };
      const t = C.toolbar.querySelector('.fe-tag'); if (t) t.textContent = `v${E.version}`;
      const s = C.toolbar.querySelector('.fe-state-text'); if (s) s.textContent = '已发布';
    } catch (e) { toast('发布失败', String((e && e.message) || e)); }
  }

  async function replayRun(runId) {
    let run;
    try { const r = await apiJSON('api/workflows/runs/' + encodeURIComponent(runId)); run = r.run || r; }
    catch (e) { return toast('回放失败', e.message); }
    if (!run) return toast('回放失败', '运行记录不存在');
    const byStep = {};
    for (const t of run.steps || []) byStep[t.step_id] = t;
    const mark = (id) => {
      const t = byStep[id];
      if (!t) return run.cursor === id && run.status === 'waiting' ? ' ⏸待审' : '';
      if (t.status === 'failed') return ' ❌';
      if (t.status === 'skipped') return ' ⤼';
      if (t.approval) return { approved: ' ✅', rejected: ' ⛔', timeout: ' ⏰' }[t.approval.decision] || ' ✅';
      return ' ✅';
    };
    const data = lf.getGraphData();
    for (const n of data.nodes) {
      const suffix = mark(String(n.id));
      if (suffix) lf.updateText(String(n.id), String(n.text?.value ?? '') + suffix);
    }
    const rows = (run.steps || []).map(t => `<div class="fe-replay-row"><code>${esc(t.step_id)}</code> ${esc(t.name)} — ${t.status === 'ok' ? '✅' : t.status === 'failed' ? '❌ ' + esc(t.error || '') : '⤼ 跳过'}${t.approval ? ' · ' + ({ approved: '通过', rejected: '拒绝', timeout: '超时' })[t.approval.decision] : ''}</div>`).join('');
    C.panel.innerHTML = `<div class="fe-panel-hd">回放 · ${esc(String(run.id).slice(0, 12))}…</div>
      <div class="fe-replay-state">${run.status === 'completed' ? '✅ 已完成' : run.status === 'waiting' ? '⏸ 等待审批（' + esc(run.cursor || '') + '）' : run.status === 'failed' ? '❌ 失败：' + esc(run.error || '') : '▶ 执行中'}</div>
      ${rows || '<div class="fe-replay-row">（无步骤）</div>'}`;
  }
  window._flowReplayRun = (runId) => replayRun(runId);

  // —— 核心：装载到给定容器 ——
  async function attach(c, flowId, startEditing) {
    LFLib = resolveLogicFlow();
    if (!LFLib) throw new Error('LogicFlow 未加载，请刷新页面');
    const { tpl, version } = await loadTemplate(flowId);
    const capResponse = await apiJSON('api/capabilities').catch(() => []);
    const capabilityList = Array.isArray(capResponse) ? capResponse : (capResponse.capabilities || capResponse.list || []);
    const data = toGraphData(tpl);
    C = c;
    const inputSchema = tpl.inputSchema || { type: 'object' };
    E = { flowId, version, name: tpl.name, description: tpl.description || '', doctype: tpl.doctype || '', inputSchema, resultMap: tpl.resultMap, start: data.start, sourceData:cloneGraph(data), sourceMeta:{name:tpl.name,description:tpl.description || '',inputSchema:cloneGraph(inputSchema)}, previewAxis:'', dirty: false, sel: null, editMode: !!(startEditing && currentUserInfo?.role === 'admin'), capabilities: capabilityList };
    renderToolbar();
    renderPalette();
    initLf(data);
    renderPanel();
    syncAiContext();
    return E;
  }

  // 页面内嵌（「流程」页本体即画布）
  window.flowEditorEmbed = async function (c, flowId) {
    try { return await attach(c, flowId, false); }
    catch (e) { console.error('[flow-editor]', e); toast('画布加载失败', String((e && e.message) || e)); }
  };
  window.flowEditorAskAi = (prompt) => askAiDesign(prompt || '请分析并辅助设计当前工作流。先说明建议，确认后再提交元数据提案。');
  window.flowEditorFit = () => sizeLf(true);
  window.flowEditorAddNode = (kind) => addNode(kind);

  // 全屏弹层（其他页面按钮用）
  window.openFlowEditor = async function (flowId) {
    try {
      document.querySelectorAll('.fe-overlay').forEach(o => o.remove());
      const ov = document.createElement('div');
      ov.className = 'fe-overlay';
      ov.innerHTML = `<div class="fe-shell">
        <header class="fe-hd"><div class="fe-toolbar" id="fe-modal-toolbar"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="fe-close">关闭</button></header>
        <div class="fe-body"><div class="fe-canvas-wrap" id="fe-modal-canvas"></div><aside class="fe-panel" id="fe-modal-panel"></aside></div>
      </div>`;
      document.body.appendChild(ov);
      $('#fe-close').onclick = () => { if (E?.dirty && !confirm('有未发布改动，确定关闭？')) return; destroyLf(); ov.remove(); E = null; C = null; };
      await attach({ toolbar: $('#fe-modal-toolbar'), canvas: $('#fe-modal-canvas'), panel: $('#fe-modal-panel') }, flowId, true);
    } catch (e) { console.error('[flow-editor]', e); toast('编辑器打开失败', String((e && e.message) || e)); }
  };
  window.addEventListener('resize', () => sizeLf());
})();
