/* Frappe Process Definition ↔ LogicFlow 纯画布适配器。
   LogicFlow 只负责拖拽、连线和历史；保存的仍是尚书 Graph 协议。 */
(function () {
  const TYPE_META = {
    human_task: { mark:'人', label:'人工办理', note:'表单、审批、补充材料' },
    condition: { mark:'条', label:'条件分支', note:'按对象字段选择路径' },
    action: { mark:'系', label:'系统动作', note:'调用已注册 ActionDef' },
    ai_select: { mark:'AI', label:'AI 选择工具', note:'只能在安全候选集内选择' },
    wait_event: { mark:'等', label:'等待事件', note:'等待回调、通知或超时' },
    subflow: { mark:'子', label:'子流程', note:'引用已发布流程版本' },
  };
  const OPERATOR_LABELS = {
    eq:'等于', neq:'不等于', gt:'大于', gte:'大于等于', lt:'小于', lte:'小于等于',
    contains:'包含', in:'属于', is_empty:'为空', is_not_empty:'不为空',
  };
  const clone = value => JSON.parse(JSON.stringify(value ?? {}));
  const parseJson = (value, fallback) => {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch { return fallback; }
  };
  const q = (root, selector) => root.querySelector(selector);
  const qa = (root, selector) => [...root.querySelectorAll(selector)];
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  function resolveLogicFlow() {
    const ns = window.Core || window.LogicFlow;
    if (!ns) return null;
    const LogicFlow = typeof window.LogicFlow === 'function' ? window.LogicFlow : (typeof ns === 'function' ? ns : (ns.default || ns.LogicFlow));
    if (typeof LogicFlow !== 'function') return null;
    const pack = typeof ns === 'object' ? ns : LogicFlow;
    return { LogicFlow, RectNode:pack.RectNode || LogicFlow.RectNode, RectNodeModel:pack.RectNodeModel || LogicFlow.RectNodeModel };
  }

  function edgeLabel(edge) {
    if (edge.label) return edge.label;
    if (edge.is_default) return '其他情况';
    if (edge.condition && typeof edge.condition === 'object') return edge.condition.summary || '条件分支';
    return ({approved:'通过', returned:'退回', resubmitted:'重提'})[edge.condition] || edge.condition || '';
  }

  function automaticPositions(graph) {
    const nodes = graph.nodes || [], edges = graph.edges || [];
    const rank = new Map();
    const incoming = new Map(nodes.map(node => [node.id, 0]));
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    const returns = edge => /returned|resubmitted|退回|重提/.test(`${edge.condition || ''} ${edge.label || ''}`);
    edges.filter(edge => !returns(edge)).forEach(edge => {
      if (!incoming.has(edge.target) || !outgoing.has(edge.source)) return;
      incoming.set(edge.target, incoming.get(edge.target) + 1);
      outgoing.get(edge.source).push(edge.target);
    });
    const queue = nodes.filter(node => node.start || incoming.get(node.id) === 0);
    queue.forEach(node => rank.set(node.id, 0));
    const degree = new Map(incoming);
    while (queue.length) {
      const node = queue.shift();
      for (const target of outgoing.get(node.id) || []) {
        rank.set(target, Math.max(rank.get(target) || 0, (rank.get(node.id) || 0) + 1));
        degree.set(target, degree.get(target) - 1);
        if (degree.get(target) === 0) queue.push(nodes.find(item => item.id === target));
      }
    }
    let tail = Math.max(0, ...rank.values());
    nodes.forEach(node => { if (!rank.has(node.id)) rank.set(node.id, ++tail); });
    const layers = {};
    nodes.forEach(node => (layers[rank.get(node.id)] ||= []).push(node));
    const positions = new Map();
    Object.entries(layers).forEach(([level, rows]) => rows.forEach((node, index) => {
      positions.set(node.id, { x:360 + (index - (rows.length - 1) / 2) * 240, y:90 + Number(level) * 118 });
    }));
    return positions;
  }

  function conditionFromLegacy(condition, sources) {
    if (condition && typeof condition === 'object') return clone(condition);
    if (/has_text_layer\s*==\s*true/i.test(String(condition || ''))) {
      return {
        kind:'clause', source:{scope:'business_object',object_id:'document_extraction',field_path:'has_text_layer',field_label:'是否包含可靠文字层',data_type:'boolean'},
        operator:'eq', value:true, summary:'包含可靠文字层',
      };
    }
    const first = sources.flatMap(source => (source.fields || []).map(field => ({source,field})))[0];
    if (!first) return null;
    return {
      kind:'clause', source:{scope:first.source.scope || 'business_object',object_id:first.source.id,field_path:first.field.path,field_label:first.field.label,data_type:first.field.data_type || 'string'},
      operator:'eq', value:'', summary:`${first.field.label} 等于`,
    };
  }

  window.mountPlatformGraphDesigner = function mountPlatformGraphDesigner(options) {
    const container = options.container;
    const lib = resolveLogicFlow();
    if (!lib) throw new Error('LogicFlow 画布未加载');
    if (container._platformGraphDesigner?.destroy) container._platformGraphDesigner.destroy();
    let graph = clone(options.graph || {nodes:[],edges:[]});
    const actions = (options.context?.actions || []).map(action => ({
      ...action,
      roles:parseJson(action.allowed_roles_json, []),
      input_schema:parseJson(action.input_schema_json, {}),
      output_schema:parseJson(action.output_schema_json, {}),
    }));
    const roles = (options.context?.roles || []).filter(role => !['Guest','All'].includes(role));
    const sources = graph.data_sources || options.context?.data_sources || [];
    let selected = null;
    let lf = null;
    let resizeObserver = null;
    let dirty = false;

    container.innerHTML = `<div class="pfd-shell no-inspector">
      <aside class="pfd-palette"><div class="pfd-pane-title">节点库</div>
        ${Object.entries(TYPE_META).map(([type, meta]) => `<button type="button" data-add-node="${type}"><i>${meta.mark}</i><span><b>${meta.label}</b><small>${meta.note}</small></span><em>+</em></button>`).join('')}
        <button type="button" data-add-node="end"><i>终</i><span><b>结束</b><small>设置流程结果和归档终态</small></span><em>+</em></button>
      </aside>
      <section class="pfd-workspace">
        <div class="pfd-toolbar">
          <button type="button" data-undo title="撤销">↶</button><button type="button" data-redo title="重做">↷</button><span></span>
          <button type="button" data-duplicate title="复制节点">复制</button><button type="button" data-delete title="删除选中">删除</button><span></span>
          <button type="button" data-zoom-out title="缩小">−</button><button type="button" data-zoom-in title="放大">+</button><button type="button" data-fit>适应画布</button>
          <em data-dirty>已保存</em>
        </div>
        <div class="pfd-canvas" aria-label="可编辑流程画布"></div>
      </section>
      <aside class="pfd-inspector"><div class="pfd-pane-title">流程设置</div><div class="pfd-inspector-body"></div></aside>
    </div>`;
    const canvas = q(container, '.pfd-canvas');
    const inspector = q(container, '.pfd-inspector-body');
    const shell = q(container, '.pfd-shell');

    function markDirty(reason) {
      dirty = true;
      q(container, '[data-dirty]').textContent = '未保存';
      options.onChange?.(exportGraph(), reason || 'graph.change');
    }

    function nodeText(node) {
      const meta = TYPE_META[node.type] || TYPE_META.human_task;
      return `${meta.mark} ${node.title || node.id.split('.').pop()}`;
    }

    function toLogicFlow(value) {
      const positions = automaticPositions(value);
      return {
        nodes:(value.nodes || []).map(node => {
          const pos = node.position || positions.get(node.id) || {x:360,y:120};
          return { id:node.id, type:'platform-node', x:Number(pos.x), y:Number(pos.y), text:nodeText(node), properties:{ _node:clone(node) } };
        }),
        edges:(value.edges || []).map((edge, index) => ({
          id:edge.id || `edge-${index}-${String(edge.source).split('.').pop()}-${String(edge.target).split('.').pop()}`,
          type:'polyline', sourceNodeId:edge.source, targetNodeId:edge.target, text:edgeLabel(edge), properties:{ _edge:clone(edge) },
        })),
      };
    }

    function exportGraph() {
      if (!lf) return clone(graph);
      const data = lf.getGraphData();
      const nodes = (data.nodes || []).map(item => {
        const node = clone(item.properties?._node || {id:String(item.id),type:'human_task',title:String(item.text?.value || item.id)});
        node.id = String(item.id);
        node.position = {x:Math.round(item.x), y:Math.round(item.y)};
        return node;
      });
      const edges = (data.edges || []).map(item => {
        const edge = clone(item.properties?._edge || {});
        edge.id = edge.id || String(item.id);
        edge.source = String(item.sourceNodeId);
        edge.target = String(item.targetNodeId);
        return edge;
      });
      graph = {...graph,nodes,edges,schema_version:2};
      return clone(graph);
    }

    function updateNode(id, patch) {
      const data = lf.getNodeDataById(id);
      if (!data) return;
      const node = {...clone(data.properties?._node || {}),...patch,id};
      lf.setProperties(id,{_node:node});
      lf.updateText(id,nodeText(node));
      markDirty('node.update');
    }

    function updateEdge(id, patch) {
      const data = lf.getEdgeDataById(id);
      if (!data) return;
      const edge = {...clone(data.properties?._edge || {}),...patch,id,source:String(data.sourceNodeId),target:String(data.targetNodeId)};
      lf.setProperties(id,{_edge:edge});
      lf.updateText(id,edgeLabel(edge));
      markDirty('edge.update');
    }

    function selectedData() {
      if (!selected) return null;
      if (selected.type === 'node') return lf.getNodeDataById(selected.id);
      return lf.getEdgeDataById(selected.id);
    }

    function renderInspector() {
      const data = selectedData();
      if (!data) {
        shell.classList.add('no-inspector');
        inspector.innerHTML = `<div class="pfd-empty-inspector"><b>选中一个节点或连线</b><p>拖动节点调整位置；从节点端口拉到另一节点即可连线。</p><p>左侧“+”可新增节点，撤销和重做使用同一画布历史。</p></div>`;
        return;
      }
      shell.classList.remove('no-inspector');
      if (selected.type === 'node') renderNodeInspector(data);
      else renderEdgeInspector(data);
    }

    function renderNodeInspector(data) {
      const node = clone(data.properties?._node || {});
      const type = node.type || 'human_task';
      const safeActions = actions.filter(action => ['read','external/read','extract'].includes(action.effect));
      inspector.innerHTML = `<div class="pfd-selection-title"><i>${TYPE_META[type]?.mark || '步'}</i><span><b>${esc(node.title || '未命名节点')}</b><small>${esc(TYPE_META[type]?.label || type)}</small></span></div>
        <label class="pfd-field"><span>节点名称</span><input data-node-title value="${esc(node.title || '')}"></label>
        <label class="pfd-field"><span>节点类型</span><select data-node-type>${Object.entries(TYPE_META).map(([key,meta]) => `<option value="${key}" ${key === type ? 'selected' : ''}>${meta.label}</option>`).join('')}</select></label>
        <div class="pfd-inline-checks"><label><input type="checkbox" data-node-start ${node.start ? 'checked' : ''}> 流程起点</label><label><input type="checkbox" data-node-terminal ${node.terminal ? 'checked' : ''}> 流程终态</label></div>
        ${type === 'human_task' ? `<fieldset class="pfd-fieldset"><legend>办理人角色</legend>${roles.map(role => `<label><input type="checkbox" data-node-role="${esc(role)}" ${(node.allowed_roles || []).includes(role) ? 'checked' : ''}> ${esc(role)}</label>`).join('') || '<small>暂无可选角色</small>'}</fieldset>` : ''}
        ${type === 'action' ? `<label class="pfd-field"><span>注册动作</span><select data-node-action><option value="">请选择 ActionDef</option>${actions.map(action => `<option value="${esc(action.action_id)}" ${node.action_id === action.action_id ? 'selected' : ''}>${esc(action.title)} · ${esc(action.effect)}</option>`).join('')}</select></label>${actionHint(actions.find(action => action.action_id === node.action_id))}` : ''}
        ${type === 'ai_select' ? `<fieldset class="pfd-fieldset"><legend>AI 候选工具</legend>${safeActions.map(action => `<label class="pfd-tool-choice"><input type="checkbox" data-node-candidate="${esc(action.action_id)}" ${(node.candidates || []).includes(action.action_id) ? 'checked' : ''}><span><b>${esc(action.title)}</b><small>${esc(action.action_id)}</small></span></label>`).join('') || '<small>没有符合安全约束的候选工具</small>'}</fieldset>` : ''}
        ${type === 'wait_event' ? `<label class="pfd-field"><span>超时分钟</span><input type="number" min="1" data-node-timeout value="${Number(node.timeout_minutes || 60)}"></label>` : ''}
        ${type === 'subflow' ? `<label class="pfd-field"><span>已发布子流程版本</span><input data-node-subflow value="${esc(node.definition_version || '')}" placeholder="com.example.flow@1"></label>` : ''}
        <label class="pfd-field"><span>说明</span><textarea data-node-description rows="3">${esc(node.description || '')}</textarea></label>
        <div class="pfd-id"><span>节点 ID</span><code>${esc(node.id)}</code></div>`;
      q(inspector,'[data-node-title]').oninput = event => {
        const title = event.target.value.trim() || '未命名节点';
        updateNode(node.id,{title});
        q(inspector,'.pfd-selection-title b').textContent = title;
      };
      q(inspector,'[data-node-description]').oninput = event => updateNode(node.id,{description:event.target.value.trim() || undefined});
      q(inspector,'[data-node-type]').onchange = event => {
        const next = event.target.value;
        const patch = {type:next,action_id:undefined,candidates:undefined,allowed_roles:undefined,definition_version:undefined};
        if (next === 'action') patch.action_id = actions[0]?.action_id || '';
        if (next === 'ai_select') patch.candidates = safeActions.slice(0,2).map(action => action.action_id);
        if (next === 'human_task') patch.allowed_roles = [];
        updateNode(node.id,patch); renderInspector();
      };
      q(inspector,'[data-node-start]').onchange = event => {
        if (event.target.checked) {
          for (const item of lf.getGraphData().nodes || []) {
            const other = clone(item.properties?._node || {});
            if (other.start && item.id !== node.id) lf.setProperties(item.id,{_node:{...other,start:false}});
          }
        }
        updateNode(node.id,{start:event.target.checked || undefined});
      };
      q(inspector,'[data-node-terminal]').onchange = event => updateNode(node.id,{terminal:event.target.checked || undefined});
      qa(inspector,'[data-node-role]').forEach(input => input.onchange = () => updateNode(node.id,{allowed_roles:qa(inspector,'[data-node-role]').filter(item => item.checked).map(item => item.dataset.nodeRole)}));
      const actionSelect = q(inspector,'[data-node-action]'); if (actionSelect) actionSelect.onchange = event => { updateNode(node.id,{action_id:event.target.value}); renderInspector(); };
      qa(inspector,'[data-node-candidate]').forEach(input => input.onchange = () => updateNode(node.id,{candidates:qa(inspector,'[data-node-candidate]').filter(item => item.checked).map(item => item.dataset.nodeCandidate)}));
      const timeout = q(inspector,'[data-node-timeout]'); if (timeout) timeout.oninput = event => updateNode(node.id,{timeout_minutes:Number(event.target.value || 60)});
      const subflow = q(inspector,'[data-node-subflow]'); if (subflow) subflow.oninput = event => updateNode(node.id,{definition_version:event.target.value.trim()});
    }

    function actionHint(action) {
      if (!action) return '<div class="pfd-callout warn">请选择已注册动作，不能手写方法名或 URL。</div>';
      return `<div class="pfd-callout"><b>${esc(action.confirmation_policy === 'required' ? '执行前必须确认' : '可按流程自动执行')}</b><span>${esc(action.registry_key)} · ${esc(action.retry_policy || '不重试')}</span></div>`;
    }

    function renderEdgeInspector(data) {
      const edge = clone(data.properties?._edge || {id:String(data.id),source:String(data.sourceNodeId),target:String(data.targetNodeId)});
      const sourceNode = lf.getNodeDataById(String(data.sourceNodeId));
      const sourceType = sourceNode?.properties?._node?.type;
      const isCondition = sourceType === 'condition';
      const rule = conditionFromLegacy(edge.condition,sources);
      const fieldOptions = sources.flatMap(source => (source.fields || []).map(field => ({
        key:`${source.id}::${field.path}`, source, field,
      })));
      const currentKey = rule ? `${rule.source?.object_id || ''}::${rule.source?.field_path || ''}` : '';
      inspector.innerHTML = `<div class="pfd-selection-title"><i>线</i><span><b>${esc(edge.label || edgeLabel(edge) || '连线')}</b><small>${esc(String(data.sourceNodeId).split('.').pop())} → ${esc(String(data.targetNodeId).split('.').pop())}</small></span></div>
        <label class="pfd-field"><span>画布标签</span><input data-edge-label value="${esc(edge.label || '')}" placeholder="例如：金额达到 5000"></label>
        ${isCondition ? `<div class="pfd-condition-editor">
          <label class="pfd-default"><input type="checkbox" data-edge-default ${edge.is_default ? 'checked' : ''}> 设为其他情况（默认分支）</label>
          <div data-condition-fields ${edge.is_default ? 'hidden' : ''}>
            <label class="pfd-field"><span>从哪里判断</span><select data-edge-source><option value="">选择对象字段</option>${fieldOptions.map(item => `<option value="${esc(item.key)}" ${item.key === currentKey ? 'selected' : ''}>${esc(item.source.title)} / ${esc(item.field.label)}</option>`).join('')}</select></label>
            <label class="pfd-field"><span>判断方式</span><select data-edge-operator>${Object.entries(OPERATOR_LABELS).map(([key,label]) => `<option value="${key}" ${rule?.operator === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            <label class="pfd-field" data-edge-value-wrap><span>比较值</span><input data-edge-value value="${esc(rule?.value ?? '')}"></label>
          </div>
          <label class="pfd-field"><span>分支优先级</span><input type="number" min="0" data-edge-priority value="${Number(edge.priority || 0)}"></label>
        </div>` : `<label class="pfd-field"><span>办理结果</span><select data-edge-decision>${[['','无条件'],['approved','通过'],['returned','退回'],['resubmitted','重提']].map(([key,label]) => `<option value="${key}" ${edge.condition === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`}
        <div class="pfd-id"><span>连线 ID</span><code>${esc(edge.id || data.id)}</code></div>`;
      q(inspector,'[data-edge-label]').oninput = event => {
        const label = event.target.value.trim();
        updateEdge(data.id,{label:label || undefined});
        q(inspector,'.pfd-selection-title b').textContent = label || edgeLabel(edge) || '连线';
      };
      if (!isCondition) {
        q(inspector,'[data-edge-decision]').onchange = event => updateEdge(data.id,{condition:event.target.value || undefined});
        return;
      }
      const defaultBox = q(inspector,'[data-edge-default]');
      const commit = () => {
        const isDefault = defaultBox.checked;
        if (isDefault) {
          updateEdge(data.id,{is_default:true,condition:undefined,priority:Number(q(inspector,'[data-edge-priority]').value || 0)});
          return;
        }
        const option = fieldOptions.find(item => item.key === q(inspector,'[data-edge-source]').value);
        if (!option) return;
        const operator = q(inspector,'[data-edge-operator]').value;
        const raw = q(inspector,'[data-edge-value]').value;
        const value = option.field.data_type === 'boolean' ? raw === 'true' : option.field.data_type === 'number' ? Number(raw || 0) : raw;
        const summary = `${option.field.label} ${OPERATOR_LABELS[operator]}${['is_empty','is_not_empty'].includes(operator) ? '' : ` ${raw}`}`;
        updateEdge(data.id,{
          is_default:undefined, priority:Number(q(inspector,'[data-edge-priority]').value || 0),
          condition:{kind:'clause',source:{scope:option.source.scope || 'business_object',object_id:option.source.id,field_path:option.field.path,field_label:option.field.label,data_type:option.field.data_type || 'string'},operator,value,summary},
        });
      };
      defaultBox.onchange = () => { q(inspector,'[data-condition-fields]').hidden = defaultBox.checked; commit(); };
      ['[data-edge-source]','[data-edge-operator]'].forEach(selector => q(inspector,selector).onchange = commit);
      ['[data-edge-value]','[data-edge-priority]'].forEach(selector => q(inspector,selector).oninput = commit);
      const sourceSelect = q(inspector,'[data-edge-source]');
      const updateValueControl = () => {
        const option = fieldOptions.find(item => item.key === sourceSelect.value);
        const wrap = q(inspector,'[data-edge-value-wrap]');
        if (!option || option.field.data_type !== 'boolean') return;
        wrap.innerHTML = `<span>比较值</span><select data-edge-value><option value="true" ${rule?.value === true ? 'selected' : ''}>是</option><option value="false" ${rule?.value === false ? 'selected' : ''}>否</option></select>`;
        q(inspector,'[data-edge-value]').onchange = commit;
      };
      updateValueControl();
      sourceSelect.onchange = () => { updateValueControl(); commit(); };
    }

    function addNode(type) {
      const count = (lf.getGraphData().nodes || []).length;
      const id = uid(`${options.definitionId || 'com.shangshu.custom'}.node`);
      const center = lf.getPointByClient(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2)?.canvasOverlayPosition || {x:360,y:160};
      const node = {id,type:type === 'end' ? 'human_task' : type,title:type === 'end' ? '完成' : TYPE_META[type]?.label || '新节点'};
      if (type === 'end') node.terminal = true;
      if (node.type === 'action') node.action_id = actions[0]?.action_id || '';
      if (node.type === 'ai_select') node.candidates = actions.filter(action => ['read','external/read','extract'].includes(action.effect)).slice(0,2).map(action => action.action_id);
      if (node.type === 'human_task') node.allowed_roles = [];
      lf.addNode({id,type:'platform-node',x:center.x + (count % 3) * 24,y:center.y + (count % 3) * 18,text:nodeText(node),properties:{_node:node}});
      selected = {type:'node',id}; lf.selectElementById(id); markDirty('node.add'); renderInspector();
    }

    function duplicateSelected() {
      if (selected?.type !== 'node') return;
      const data = lf.getNodeDataById(selected.id); if (!data) return;
      const original = clone(data.properties?._node || {});
      const id = uid(`${options.definitionId || 'com.shangshu.custom'}.node`);
      const node = {...original,id,title:`${original.title || '节点'} 副本`,start:undefined};
      lf.addNode({id,type:'platform-node',x:data.x + 44,y:data.y + 44,text:nodeText(node),properties:{_node:node}});
      selected = {type:'node',id}; lf.selectElementById(id); markDirty('node.duplicate'); renderInspector();
    }

    function deleteSelected() {
      if (!selected) return;
      if (selected.type === 'node') {
        const data = lf.getNodeDataById(selected.id);
        const affected = (lf.getNodeIncomingEdge(selected.id) || []).length + (lf.getNodeOutgoingEdge(selected.id) || []).length;
        if (!confirm(`删除“${data?.properties?._node?.title || selected.id}”将同时删除 ${affected} 条连线，继续吗？`)) return;
      }
      lf.deleteElement(selected.id); selected = null; markDirty('element.remove'); renderInspector();
    }

    const initial = toLogicFlow(graph);
    lf = new lib.LogicFlow({container:canvas,width:Math.max(canvas.clientWidth,1),height:Math.max(canvas.clientHeight,1),grid:{size:20,visible:false},background:{color:'transparent'},keyboard:{enabled:true},edgeType:'polyline'});
    try {
      class PlatformNodeModel extends lib.RectNodeModel {
        initNodeData(data) { super.initNodeData(data); this.width = 196; this.height = 64; this.radius = 10; }
        getNodeStyle() { const style = super.getNodeStyle(); style.fill = '#fff'; style.stroke = 'rgba(30,35,44,.22)'; style.strokeWidth = 1.1; return style; }
      }
      lf.register({type:'platform-node',view:lib.RectNode,model:PlatformNodeModel});
    } catch { initial.nodes.forEach(node => { node.type = 'rect'; }); }
    lf.setTheme({
      rect:{rx:10,ry:10,stroke:'rgba(30,35,44,.22)',strokeWidth:1.1,fill:'#fff'},
      polyline:{stroke:'rgba(30,35,44,.32)',strokeWidth:1.3,offset:26,adjustLine:{stroke:'#0ea372'}},
      anchor:{r:4,fill:'#fff',stroke:'#0ea372'},
      nodeText:{fontSize:13,color:'#20242c',overflowMode:'ellipsis'},
      edgeText:{fontSize:11,color:'#606771',background:{fill:'#fff',stroke:'#dfe3e8',radius:5},padding:[3,7,3,7]},
    });
    lf.render(initial);
    lf.on('node:click',({data}) => { selected={type:'node',id:String(data.id)}; renderInspector(); });
    lf.on('edge:click',({data}) => { selected={type:'edge',id:String(data.id)}; renderInspector(); });
    lf.on('blank:click',() => { selected=null; renderInspector(); });
    lf.on('node:drop',() => markDirty('node.move'));
    lf.on('edge:add',({data}) => { lf.setProperties(data.id,{_edge:{id:String(data.id),source:String(data.sourceNodeId),target:String(data.targetNodeId)}}); markDirty('edge.add'); });
    lf.on('node:delete',() => markDirty('node.remove'));
    lf.on('edge:delete',() => markDirty('edge.remove'));

    qa(container,'[data-add-node]').forEach(button => button.onclick = () => addNode(button.dataset.addNode));
    q(container,'[data-undo]').onclick = () => { lf.undo(); selected=null; markDirty('history.undo'); renderInspector(); };
    q(container,'[data-redo]').onclick = () => { lf.redo(); selected=null; markDirty('history.redo'); renderInspector(); };
    q(container,'[data-duplicate]').onclick = duplicateSelected;
    q(container,'[data-delete]').onclick = deleteSelected;
    q(container,'[data-fit]').onclick = () => lf.fitView(44,36);
    q(container,'[data-zoom-in]').onclick = () => lf.zoom(true);
    q(container,'[data-zoom-out]').onclick = () => lf.zoom(false);
    renderInspector();
    // LogicFlow 的平移量必须由 fitView 连同缩放一起计算。单独 zoom 后再
    // translateCenter 会忽略长流程的实际边界，导致顶部节点被推到画布外。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      lf.fitView(44,36);
    }));
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => { const rect=canvas.getBoundingClientRect(); if (rect.width > 20 && rect.height > 20) lf.resize(rect.width,rect.height); });
      resizeObserver.observe(canvas);
    }

    const api = {
      getGraph:exportGraph,
      markSaved() { dirty=false; q(container,'[data-dirty]').textContent='已保存'; },
      isDirty:() => dirty,
      fit:() => lf.fitView(44,36),
      destroy() { resizeObserver?.disconnect(); try { lf?.destroy(); } catch {} container._platformGraphDesigner=null; },
    };
    container._platformGraphDesigner = api;
    return api;
  };
})();
