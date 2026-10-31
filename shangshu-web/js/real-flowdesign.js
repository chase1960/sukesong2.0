/* ============ 模块：工作流
   产品前端仍由 shangshu-web 渲染；Frappe 只提供身份、元数据、流程与账务 API。
   设计器和办理端分面展示，发布版本不可变，AI 只能形成待确认提案。
*/
RENDER.flowdesign = async function (page) {
  const main = page?.host || mainBox();
  const activePage = () => main.isConnected && (!page || page.isActive());
  let centerRequest = 0;
  const isAdmin = currentUserInfo?.role === 'admin';
  let contributions = {processes:[],domains:[]};
  let publishedProcesses = [];
  let designableProcesses = [];
  const viewLabels = { launch:'可发起', pending:'待我处理', started:'我发起的', completed:'已完成', copied:'抄送我的' };
  const nodeTypeLabels = {
    human_task:'人工办理', action:'系统动作', condition:'条件判断', ai_select:'AI 选择工具',
    start:'开始', end:'结束', subflow:'子流程', timer:'定时器'
  };
  const parse = (value, fallback) => {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch { return fallback; }
  };
  const shortTime = (value) => String(value || '').replace('T', ' ').slice(0, 16) || '—';
  const key = (prefix) => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  main.innerHTML = `
    <section class="pf-root">
      <header class="page-hd pf-page-head page-heading">
        <div><h1>待办</h1></div>
        <div class="pf-head-actions">
          <button class="btn btn-pri" type="button" data-open-launch>发起流程</button>
        </div>
      </header>
      <div class="pf-surface" id="pf-surface"><div class="pf-empty">正在读取流程…</div></div>
    </section>`;

  $('[data-open-launch]', main).onclick = () => renderCenter('launch');
  try {
    const [resourceData, processData, definitionData] = await Promise.all([
      platformJSON('/api/platform/contributions'),
      platformJSON('/api/platform/processes'),
      isAdmin ? platformJSON('/api/platform/process-definitions') : Promise.resolve({list:[]}),
    ]);
    if (!activePage()) return;
    contributions = resourceData;
    publishedProcesses = processData.list || [];
    designableProcesses = definitionData.list || [];
  } catch (error) {
    if (!activePage()) return;
    $('#pf-surface', main).innerHTML = `<div class="pf-empty pf-error"><div><b>平台资源加载失败</b><p>${esc(error.message || error)}</p><button class="btn btn-ghost" type="button" data-retry>重新加载</button></div></div>`;
    $('[data-retry]', main).onclick = () => RENDER.flowdesign();
    return;
  }
  const requestedView = sessionStorage.getItem('shangshu.process.view') || 'pending';
  sessionStorage.removeItem('shangshu.process.view');
  await renderCenter(viewLabels[requestedView] ? requestedView : 'pending');
  const pendingIntent = (() => {
    try { return JSON.parse(sessionStorage.getItem('shangshu.process.intent') || 'null'); }
    catch { return null; }
  })();
  if (pendingIntent?.definition_id) {
    sessionStorage.removeItem('shangshu.process.intent');
    if (pendingIntent.mode === 'design' && isAdmin) await renderDesigner(pendingIntent.definition_id);
    else launchProcess(pendingIntent.definition_id);
  }
  if (pendingIntent?.mode === 'instance' && pendingIntent.instance?.name) {
    sessionStorage.removeItem('shangshu.process.intent');
    await openProcessInstance(pendingIntent.instance);
  }

  async function platformJSON(path, options) {
    const response = await api(path, options);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '平台请求失败');
    return data;
  }

  async function renderCenter(active) {
    if (!activePage()) return;
    const request = ++centerRequest;
    const surface = $('#pf-surface', main);
    surface.className = 'pf-surface todo-surface';
    surface.innerHTML = `
      <aside class="todo-sidebar"><div class="todo-sidebar-head"><b>我的事项</b></div><nav class="pf-tabs" aria-label="待办视图">
        ${Object.entries(viewLabels).map(([id,label]) => `<button type="button" class="${id === active ? 'on' : ''}" data-center-view="${id}">${label}<span data-count="${id}"></span></button>`).join('')}
      </nav></aside><section class="todo-work"><header class="todo-work-head"><h2>${viewLabels[active]}</h2></header><div class="pf-center-body"><div class="pf-empty">正在读取${viewLabels[active]}…</div></div></section>`;
    if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({
      module:'flowdesign', view:active, entity_type:'process_view', entity_id:active,
      label:`待办 · ${viewLabels[active]}`,
      editable_scope:'查询当前流程视图和有权限的实例；发起与办理动作必须经过确认',
    });
    $$('[data-center-view]', surface).forEach(button => button.onclick = () => renderCenter(button.dataset.centerView));
    try {
      if (active === 'launch') {
        const processMeta = new Map((contributions.processes || []).map(item => [item.id,item]));
        $('.pf-center-body', surface).innerHTML = publishedProcesses.length ? publishedProcesses.map(item => {
          const meta = processMeta.get(item.definition_id) || {};
          return `
          <article class="pf-launch-card">
            <div class="pf-app-mark">${esc((item.domain_name || meta.domain_name || '流').slice(0,1))}</div><div class="pf-grow"><h2>${esc(item.title)}</h2><p>${esc(meta.journey || '按已发布流程填写资料并办理')}</p>
            <small>${esc(item.domain_name || '平台流程')} · 已发布</small></div>
            <button class="btn btn-pri" type="button" data-launch-process="${esc(item.definition_id)}" ${item.can_launch===false?'disabled':''} title="${esc(item.launch_reason||'')}">${item.can_launch===false?'暂不可发起':'立即发起'}</button>
          </article>`;
        }).join('') : emptyState('当前没有可发起的流程', isAdmin ? '请先在应用设计中补齐流程并发布，或在应用管理中启用业务应用。' : '当前企业尚未向你的角色开放可发起流程。', isAdmin ? '应用设计' : '', isAdmin ? 'app-design' : '');
        $$('[data-launch-process]', surface).forEach(button => button.onclick = () => launchProcess(button.dataset.launchProcess));
        const emptyRoute = $('[data-empty-route]', surface); if (emptyRoute) emptyRoute.onclick = () => go(emptyRoute.dataset.emptyRoute);
        return;
      }
      const data = await platformJSON(`/api/platform/process-instances?view=${encodeURIComponent(active)}`);
      if (!activePage() || request !== centerRequest) return;
      const list = data.list || [];
      $(`[data-count="${active}"]`, surface).textContent = list.length ? String(list.length) : '';
      $('.pf-center-body', surface).innerHTML = list.length ? `
        <div class="pf-list-head"><span>事项</span><span>当前步骤</span><span>状态</span><span>更新时间</span></div>
        ${list.map(item => `<button class="pf-process-row" type="button" data-instance="${esc(item.name)}">
          <span><b>${esc(item.definition_title || item.business_name || '业务事项')}</b><small>${esc(item.domain_name || '平台流程')} · ${esc(item.initiator_user || '')}</small></span>
          <span>${esc(item.current_node_title || '处理中')}</span><span><i class="pf-state">${esc(item.status === 'Completed' ? '已完成' : '进行中')}</i></span><span>${shortTime(item.modified)}</span>
        </button>`).join('')}` : `<div class="pf-empty">${active === 'pending' ? '现在没有需要你处理的事项' : `暂无${viewLabels[active]}记录`}</div>`;
      $$('[data-instance]', surface).forEach((row,index) => row.onclick = () => openProcessInstance(list[index]));
    } catch (error) {
      if (!activePage() || request !== centerRequest) return;
      $('.pf-center-body', surface).innerHTML = `<div class="pf-empty pf-error">加载失败：${esc(error.message || error)}</div>`;
    }
  }

  function emptyState(title, description, actionLabel='', route='') {
    return `<div class="pf-empty"><div><b>${esc(title)}</b><p>${esc(description)}</p>${actionLabel ? `<button class="btn btn-ghost" type="button" data-empty-route="${esc(route)}">${esc(actionLabel)}</button>` : ''}</div></div>`;
  }

  function processAdapter(id) {
    const create=window.shangshuProcessAdapters?.[id];
    return create ? create({main,platformJSON,submitJSON,renderCenter,renderExecution,shortTime,key,
      beginView:()=>{const request=++centerRequest;return ()=>activePage()&&request===centerRequest;}}) : null;
  }

  async function launchProcess(definitionId) {
    const meta = (contributions.processes || []).find(item => item.id === definitionId) || {};
    const adapter=processAdapter(meta.launch_adapter);
    if(adapter)return adapter.launch();
    try {
      const context=await platformJSON(`/api/platform/processes/${encodeURIComponent(definitionId)}/launch-context`);
      if(!activePage())return;
      if(!context.supported)return toast('暂不能从通用入口发起',context.reason);
      const requestKey=key('process-launch'),schema=schemaWithLookups(context.schema||{},context.reference_fields,context.field_order);
      openSchemaForm({title:`发起${context.title||'流程'}`,columns:context.columns,properties:schema.properties||{},required:schema.required||[],submitLabel:'确认发起',
        onSubmit:async values=>{
          const result=await submitJSON(`/api/platform/processes/${encodeURIComponent(definitionId)}/launch`,{values,idempotency_key:requestKey,confirmed:true});
          if(activePage())await renderGenericInstance(result.name);
        }});
    }catch(error){if(activePage())toast('发起信息读取失败',error.message||String(error));}
  }

  function openProcessInstance(item) {
    const meta = (contributions.processes || []).find(row => row.id === item.definition_id) || {};
    const adapter=processAdapter(meta.instance_adapter);
    if(adapter&&item.business_name)return adapter.renderInstance(item);
    return renderGenericInstance(item.name);
  }

  async function renderGenericInstance(id) {
    if(!activePage())return;
    const request=++centerRequest;
    const surface = $('#pf-surface', main);
    surface.className = 'pf-surface';
    surface.innerHTML = '<div class="pf-empty">正在读取流程实例…</div>';
    try {
      const data = await platformJSON(`/api/platform/process-instances/${encodeURIComponent(id)}/task`);
      if(!activePage()||request!==centerRequest)return;
      const instance = data.instance || {};
      if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({
        module:'flowdesign', view:'instance', entity_type:'process_instance', entity_id:id,
        label:`流程实例 · ${data.definition_title || instance.business_name || id}`,
        editable_scope:'解释当前节点、时间线和可执行动作；办理动作必须经过确认',
      });
      surface.innerHTML = `<div class="pf-instance-head"><button class="btn btn-ghost btn-sm" type="button" data-back>← 待办</button><div><h2>${esc(data.definition_title || instance.business_name || '流程实例')}</h2><p>${esc(data.domain?.name || '平台')} · ${esc(data.current_node_title || '处理中')} · ${esc(instance.status === 'Completed' ? '已完成' : '进行中')}</p></div></div><div class="pf-config-page"><section class="pf-card"><h3>执行时间线</h3>${renderExecution(data.executions || [])}</section></div>`;
      $('[data-back]', surface).onclick = () => renderCenter('pending');
      const task=data.task||{},schema=schemaWithLookups(task.schema||{},task.reference_fields,task.field_order),displaySchema=task.display_schema||schema;
      const section=document.createElement('section');section.className='pf-card';
      section.innerHTML=`<h3>当前办理</h3><p>${esc(data.current_node_title||'')}</p>${task.reason?`<p>${esc(task.reason)}</p>`:''}<dl class="pf-facts">${Object.entries(task.values||{}).map(([field,value])=>`<div><dt>${esc(displaySchema.properties?.[field]?.title||field)}</dt><dd>${esc(typeof value==='object'?JSON.stringify(value):String(value??'—'))}</dd></div>`).join('')}</dl>${task.can_handle?'<button class="btn btn-pri" type="button" data-handle-task>办理</button>':'<p>当前账号没有待执行操作</p>'}`;
      $('.pf-config-page',surface).prepend(section);
      const handle=$('[data-handle-task]',section);
      if(handle)handle.onclick=()=>{
        const choices=task.choices||[],requestKey=key('process-task');
        openSchemaForm({title:data.current_node_title||'办理',columns:task.columns,properties:{...(schema.properties||{}),...(choices.length?{__decision:{type:'string',title:'办理结果',enum:choices.map(item=>item.id),enumNames:choices.map(item=>item.title)}}:{})},required:[...(schema.required||[]),...(choices.length?['__decision']:[])],values:task.values||{},submitLabel:'确认办理',
          onSubmit:async values=>{const decision=values.__decision;delete values.__decision;await submitJSON(`/api/platform/process-instances/${encodeURIComponent(id)}/task`,{node_id:task.node_id,values,decision,idempotency_key:requestKey,confirmed:true});if(activePage())await renderGenericInstance(id);}});
      };
    } catch (error) { if(activePage()&&request===centerRequest)surface.innerHTML = `<div class="pf-empty pf-error">实例加载失败：${esc(error.message || error)}</div>`; }
  }

  function openDesignerChooser() {
    if (!designableProcesses.length) return openCreateProcess();
    const ids=[...designableProcesses.map(item=>item.definition_id),'__new__'];
    const names=[...designableProcesses.map(item=>`${item.title}${item.status==='Draft'?'（草稿）':''}`),'＋ 新建空白流程'];
    openSchemaForm({title:'流程设计',description:'选择已有流程继续设计，或创建一份不自动发布的空白草稿。',submitLabel:'继续',required:['definition_id'],values:{definition_id:ids[0]},properties:{definition_id:{type:'string',title:'流程',enum:ids,enumNames:names}},onSubmit:async({definition_id})=>definition_id==='__new__'?openCreateProcess():renderDesigner(definition_id)});
  }

  function openCreateProcess() {
    openSchemaForm({title:'新建空白流程',description:'先创建最小草稿，再在画布中添加节点、表单、数据流转和办理权限；不会自动发布。',submitLabel:'创建并打开',required:['title'],properties:{title:{type:'string',title:'流程名称'},business_object:{type:'string',title:'业务对象说明',description:'使用业务语言描述，例如“客户申请”或“文件归档”；可暂时留空。'}},onSubmit:async values=>{const result=await submitJSON('/api/platform/process-definitions',values);designableProcesses.unshift(result);await renderDesigner(result.definition_id);}});
  }

  function renderExecution(rows) {
    if (!rows.length) return '<div class="pf-empty compact">暂无执行记录</div>';
    return `<ol class="pf-timeline">${rows.map(row => {
      const id = String(row.node_id || '').split('.').pop();
      const tool = row.selected_tool ? ` · 工具 ${row.selected_tool}` : '';
      return `<li><i></i><div><b>${esc(row.node_title || row.action_id || row.node_id)}</b><p>${esc(nodeTypeLabels[row.node_type] || row.node_type)}${esc(tool)}</p>${row.selection_reason ? `<small>${esc(row.selection_reason)}</small>` : ''}</div><time>${shortTime(row.ended_at || row.started_at)}</time></li>`;
    }).join('')}</ol>`;
  }

  async function renderDesigner(definitionId) {
    const surface = $('#pf-surface', main);
    surface.className = 'pf-surface';
    surface.innerHTML = '<div class="pf-empty">正在读取流程定义…</div>';
    try {
      const data = await platformJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}`);
      mountDesigner(data, definitionId);
    } catch (error) { surface.innerHTML = `<div class="pf-empty pf-error">设计器加载失败：${esc(error.message || error)}</div>`; }
  }

  function mountDesigner(context, definitionId) {
    const surface = $('#pf-surface', main);
    let graph = structuredClone(context.definition.graph || {nodes:[],edges:[]});
    let revision = Number(context.definition.draft_revision || 0);
    let active = 'graph';
    let graphDesigner = null;
    if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({
      module:'flowdesign', view:'designer', entity_type:'process_definition', entity_id:definitionId,
      label:`流程设计 · ${context.definition.title || definitionId}`,
      editable_scope:'辅助修改当前流程草稿；AI 提案不得自动保存或发布',
    });
    surface.innerHTML = `
      <div class="pf-designer-head"><button class="btn btn-ghost btn-sm" type="button" data-back>← 应用设计</button>
        <div><h2>${esc(context.definition.title || '业务流程')}</h2><p>草稿修订 ${revision} · ${context.latest_version ? `已发布版本 ${Number(context.latest_version.version_number || 1)}` : '尚未发布'}</p></div>
        <button class="btn btn-ghost" type="button" data-validate-draft>校验</button><button class="btn btn-ghost" type="button" data-simulate-draft>模拟</button>
        <button class="btn btn-ghost" type="button" data-ai-design>${ICONS.spark} AI 辅助设计</button>
        <button class="btn btn-ghost" type="button" data-save-draft>保存草稿</button><button class="btn btn-pri" type="button" data-publish>发布新版本</button>
      </div>
      <nav class="pf-designer-tabs">
        ${[['graph','流程图'],['form','表单'],['mapping','数据流转'],['permission','办理权限'],['publish','发布测试']].map(([id,label]) => `<button type="button" data-design-view="${id}" class="${id === active ? 'on' : ''}">${label}</button>`).join('')}
      </nav><div class="pf-designer-body"></div>`;
    $('[data-back]', surface).onclick = () => go('app-design');
    $$('[data-design-view]', surface).forEach(button => button.onclick = () => { active = button.dataset.designView; draw(); });
    $('[data-ai-design]', surface).onclick = () => openSchemaForm({
      title:'AI 辅助设计流程',
      description:'AI 只能引用已注册动作，并返回完整草稿提案。提案不会自动保存或发布；你需要先审阅，再应用到当前草稿。',
      submitLabel:'生成设计提案', required:['instruction'], properties:{instruction:{type:'string',title:'希望怎样修改',multiline:true,description:'例如：增加金额超过 5000 元时由总经理复核，退回后仍回到原审批节点。'}},
      onSubmit:async ({instruction}) => {
        const result = await submitJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}/ai-proposals`, {instruction});
        if (Number(result.based_on_revision) !== revision) throw new Error('流程草稿已变化，请刷新后重新生成提案');
        showAiProposal(result.proposal);
      }
    });
    $('[data-save-draft]', surface).onclick = saveDraft;
    $('[data-validate-draft]', surface).onclick = () => validateDraft(true);
    $('[data-simulate-draft]', surface).onclick = openSimulation;
    $('[data-publish]', surface).onclick = () => openSchemaForm({
      title:'发布流程新版本', description:'发布后会创建不可变版本；已有实例继续绑定旧版本，不会被这次修改覆盖。', submitLabel:'确认发布', properties:{},
      onSubmit:async () => { await saveDraft(true); await validateDraft(false); const result = await submitJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}/publish`, {expected_revision:revision}); toast('流程已发布',result.version_id || '新版本已生效'); await renderDesigner(definitionId); }
    });

    async function saveDraft(silent=false) {
      if (graphDesigner) graph = graphDesigner.getGraph();
      const result = await submitJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}`, {graph, expected_revision:revision}, 'PUT');
      revision = Number(result.draft_revision); $('.pf-designer-head p', surface).textContent = `草稿修订 ${revision} · ${context.latest_version ? `已发布版本 ${Number(context.latest_version.version_number || 1)}` : '尚未发布'}`;
      graphDesigner?.markSaved();
      if (!silent) toast('草稿已保存','尚未发布，不影响运行中的实例');
    }

    async function validateDraft(showToast) {
      if (graphDesigner) graph = graphDesigner.getGraph();
      const result = await submitJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}/validate`, {graph});
      if (showToast) toast('流程校验通过',result.summary || '结构、条件和资源引用正确');
      return result;
    }

    function openSimulation() {
      openSchemaForm({
        title:'模拟运行流程', description:'只计算路径，不调用 OCR、AI、过账或付款动作，不写入业务数据。', submitLabel:'开始模拟',
        required:['amount'], values:{has_text_layer:true,amount:4999.99,manager_decision:'approved',finance_decision:'approved'},
        properties:{
          has_text_layer:{type:'boolean',title:'票据是否有文字层'}, amount:{type:'number',title:'报销金额'},
          manager_decision:{type:'string',title:'经理处理',enum:['approved','returned'],enumNames:['通过','退回']},
          finance_decision:{type:'string',title:'财务处理',enum:['approved','returned'],enumNames:['通过','退回']}
        },
        onSubmit:async values => {
          if (graphDesigner) graph = graphDesigner.getGraph();
          const nodes = graph.nodes || [];
          const byTail = tail => nodes.find(node => String(node.id || '').endsWith(`.${tail}`))?.id;
          const sample = {document_extraction:{has_text_layer:!!values.has_text_layer},expense_claim:{amount:Number(values.amount)},decisions:{[byTail('manager')]:values.manager_decision,[byTail('finance')]:values.finance_decision,[byTail('supplement')]:'resubmitted'}};
          const result = await submitJSON(`/api/platform/process-definitions/${encodeURIComponent(definitionId)}/simulate`, {graph,sample});
          showSimulationResult(result);
        }
      });
    }

    function showSimulationResult(result) {
      surface.querySelector('.pf-simulation-result')?.remove();
      const card = document.createElement('section');
      card.className = 'pf-simulation-result';
      card.innerHTML = `<div><b>${result.status === 'completed' ? '模拟完成' : '模拟等待输入'}</b><p>${(result.trace || []).map(step => esc(step.title)).join(' → ')}</p></div><button type="button" aria-label="关闭模拟结果">×</button>`;
      $('.pf-designer-tabs',surface).insertAdjacentElement('afterend',card);
      $('button',card).onclick = () => card.remove();
    }

    function showAiProposal(proposal) {
      const previous = surface.querySelector('.pf-ai-proposal');
      if (previous) previous.remove();
      const card = document.createElement('section');
      card.className = 'pf-ai-proposal';
      card.innerHTML = `<div><b>AI 设计提案 · 尚未应用</b><p>${esc(proposal.summary || 'AI 已生成一份完整流程草稿，请先检查节点、数据与权限。')}</p></div><button class="btn btn-ghost btn-sm" type="button" data-dismiss>放弃</button><button class="btn btn-pri btn-sm" type="button" data-apply>应用到当前草稿</button>`;
      $('.pf-designer-tabs', surface).insertAdjacentElement('afterend', card);
      $('[data-dismiss]', card).onclick = () => card.remove();
      $('[data-apply]', card).onclick = () => {
        graph = structuredClone(proposal.graph); active = 'graph'; card.remove(); graphDesigner?.destroy(); graphDesigner = null; draw();
        toast('AI 提案已应用到页面','尚未保存草稿，也尚未发布；请检查后手动保存');
      };
    }

    function draw() {
      if (active !== 'graph' && graphDesigner) { graph = graphDesigner.getGraph(); graphDesigner.destroy(); graphDesigner = null; }
      $$('[data-design-view]', surface).forEach(button => button.classList.toggle('on', button.dataset.designView === active));
      const body = $('.pf-designer-body', surface);
      if (active === 'graph') drawGraph(body);
      else if (active === 'form') drawForm(body);
      else if (active === 'mapping') drawMapping(body);
      else if (active === 'permission') drawPermissions(body);
      else drawPublish(body);
    }

    function drawGraph(body) {
      body.innerHTML = '<div class="pfd-host"></div>';
      graphDesigner = window.mountPlatformGraphDesigner({
        container:$('.pfd-host',body), graph, context, definitionId,
        onChange:updated => { graph = updated; },
      });
    }

    function drawForm(body) {
      const form = graph.form || {sections:[]};
      body.innerHTML = `<div class="pf-config-page"><div class="pf-config-intro"><h3>发起与办理表单</h3><p>表单与业务对象字段绑定；发布后由流程中心生成实际办理界面。</p></div>${(form.sections || []).length ? `<div class="pf-form-preview">${form.sections.map(section => `<section><h4>${esc(section.title)}</h4><div>${(section.fields || []).map(field => `<label><span>${esc(field)}</span><input disabled value="字段预览"></label>`).join('')}</div></section>`).join('')}</div>` : '<div class="pf-empty compact">当前流程尚未配置表单</div>'}</div>`;
    }

    function drawMapping(body) {
      const rows = graph.mappings || [];
      body.innerHTML = `<div class="pf-config-page"><div class="pf-config-intro"><h3>数据流转</h3><p>显示字段来源、目标对象与写入闸门，避免“连上线但不知道数据去了哪里”。</p></div>${rows.length ? `<div class="pf-map-table"><div><b>来源</b><b>目标</b><b>写入条件</b></div>${rows.map(row => `<div><span>${esc(row.source)}</span><span>${esc(row.target)}</span><em>${esc(row.mode || '按节点')}</em></div>`).join('')}</div>` : '<div class="pf-empty compact">当前流程尚未配置字段映射</div>'}</div>`;
      const actions=graph.nodes.filter(n=>n.type==='action');
      const host=body.firstElementChild;
      host.insertAdjacentHTML('beforeend',`<table class="application-data-table"><thead><tr><th>动作节点</th><th>执行方式</th><th>输入 / 输出映射</th><th>操作</th></tr></thead><tbody>${actions.map((n,i)=>`<tr><td>${esc(n.title||n.action_id)}</td><td>${n.automatic?'自动（只读/抽取）':'人工确认'}</td><td>${Object.keys(n.input_mapping||{}).length} / ${Object.keys(n.output_mapping||{}).length}</td><td><button class="btn btn-ghost" data-edit-map="${i}">配置</button></td></tr>`).join('')||'<tr><td colspan="4">先在流程图中添加系统动作节点</td></tr>'}</tbody></table>`);
      host.querySelectorAll('[data-edit-map]').forEach(button=>button.onclick=()=>editMapping(actions[Number(button.dataset.editMap)]));
    }

    function editMapping(node){
      const action=(context.actions||[]).find(a=>a.action_id===node.action_id);
      if(!action){toast('动作不可用','请重新选择已注册动作');return;}
      const input=parse(action.input_schema_json,{}),fields=graph.form?.input_schema?.properties||{};
      const properties={automatic:{type:'boolean',title:'自动执行（仅无需确认的只读/抽取动作）'}},values={automatic:!!node.automatic};
      Object.entries(input.properties||{}).forEach(([id,prop],i)=>{
        const compatible=Object.entries(fields).filter(([,p])=>p.type===prop.type||p.type==='integer'&&prop.type==='number');
        properties['source_'+i]={type:'string',title:(prop.title||id)+'：来源',enum:['__omit__','__literal__',...compatible.map(([key])=>key)],enumNames:['不传入','固定值',...compatible.map(([key,p])=>p.title||key)]};
        properties['value_'+i]={...prop,title:(prop.title||id)+'：固定值（仅固定值模式使用）'};
        const binding=node.input_mapping?.[id];values['source_'+i]=binding?.field||(binding&&'value'in binding?'__literal__':'__omit__');if(binding&&'value'in binding)values['value_'+i]=binding.value;
      });
      properties.outputs={type:'array',title:'动作结果 → 流程变量',items:{type:'object',properties:{field:{type:'string',title:'结果字段'},variable:{type:'string',title:'变量名（不能覆盖申请字段）'},type:{type:'string',title:'类型',enum:['string','number','integer','boolean','object','array']}},required:['field','variable','type']}};
      values.outputs=Object.entries(node.output_mapping||{}).map(([variable,b])=>({variable,...b}));
      openSchemaForm({title:'配置 '+(node.title||action.title),properties,values,submitLabel:'保留到草稿',onSubmit:async value=>{
        if(value.automatic&&(!['read','external/read','extract'].includes(action.effect)||action.confirmation_policy==='required'))throw Error('该动作必须人工确认，不能自动执行');
        const inputs={},outputs={};
        Object.keys(input.properties||{}).forEach((id,i)=>{const source=value['source_'+i];if(source==='__literal__')inputs[id]={value:value['value_'+i]};else if(source&&source!=='__omit__')inputs[id]={field:source};});
        if((input.required||[]).some(id=>!inputs[id]))throw Error('请配置所有必填输入的来源');
        (value.outputs||[]).forEach(row=>{if(outputs[row.variable]||fields[row.variable])throw Error('输出变量重复或覆盖申请字段');outputs[row.variable]={field:row.field,type:row.type};});
        node.automatic=!!value.automatic;node.input_mapping=inputs;node.output_mapping=outputs;draw();
      }});
    }

    function drawPermissions(body) {
      const rows = (graph.nodes || []).filter(node => (node.allowed_roles || []).length).map(node => [node.title || '办理节点',(node.allowed_roles || []).join('、'),'当前节点记录']);
      rows.push(['设计、保存、发布','System Manager','流程定义']);
      body.innerHTML = `<div class="pf-config-page"><div class="pf-config-intro"><h3>办理权限</h3><p>运行时同时检查角色与记录权限；界面隐藏不能代替服务端鉴权。</p></div><div class="pf-map-table"><div><b>操作</b><b>角色</b><b>数据范围</b></div>${rows.map(row => `<div><span>${esc(row[0])}</span><span>${esc(row[1])}</span><em>${esc(row[2])}</em></div>`).join('')}</div></div>`;
    }

    function drawPublish(body) {
      body.innerHTML = `<div class="pf-config-page"><div class="pf-config-intro"><h3>发布与测试</h3><p>先查看结构与安全检查，再创建不可变新版本。</p></div><div class="pf-checks">${(context.checks || []).map(check => `<article class="${check.status}"><i>${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '×'}</i><div><b>${esc(check.title)}</b><p>${esc(check.detail)}</p></div></article>`).join('')}</div><div class="pf-version-note"><b>版本规则</b><p>当前草稿修订 ${revision}。发布只新增版本，运行中的实例继续使用启动时绑定的图和动作版本。</p></div></div>`;
    }
    draw();
  }
};
