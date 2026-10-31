/* 待办是统一使用入口；流程办理和协作任务保留各自的权限、确认和执行机制。 */
(function () {
  const renderProcesses=RENDER.flowdesign;
  const renderTasks=RENDER['task-mgmt'];
  let taskContext=null;
  let generation=0;
  /* —— 骨架（正在取数时的占位）：照最终那一张待办表画（事项／来源／当前步骤／操作 四列）；
     ⚠️ **只表示「正在取数」** ⇒ 不写假事项、不写假数字。 */
  /* 骨架就是**那张真表**（`.card` ＋ `.dtable` ＋ 真列名），数据行**空着**（只有细线）。
     ⚠️ 真格里是字、长度未知 ⇒ 塞灰条就是假的；列名是**真的**（那一档的列名本来就是固定的）。 */
  const skeletonWorkTable=(columns)=>{
    const head='<tr>'+columns.map(name=>`<th scope="col">${esc(name)}</th>`).join('')+'</tr>';
    const row='<tr data-skeleton-row="1">'+'<td></td>'.repeat(columns.length)+'</tr>';
    return `<div class="card" style="overflow:auto"><table class="dtable platform-skeleton" data-skeleton="table"><thead>${head}</thead><tbody>${row.repeat(7)}</tbody></table></div>`;
  };
  const WORK_TABLE_COLUMNS={all:['事项','来源','当前步骤','操作'],reminders:['提醒','时间','操作']};
  function mountActions(context) {
    if(!context.isActive())return;
    const actions=context.host.querySelector('.pf-page-head .pf-head-actions, .platform-hd .acts');
    context.actionsHost.replaceChildren();
    if(actions)context.actionsHost.appendChild(actions);
  }

  RENDER.flowdesign=async function(page) {
    const host=page?.host || mainBox();
    const current=++generation;
    let selection=0;
    const active=()=>current===generation&&host.isConnected&&(!page||page.isActive());
    const requested=sessionStorage.getItem('shangshu.work.view');
    sessionStorage.removeItem('shangshu.work.view');
    // 应用的流程发起/实例/设计直达优先，不被上一次任务视图截走。
    const processIntent=sessionStorage.getItem('shangshu.process.intent')||sessionStorage.getItem('shangshu.process.view');
    host.innerHTML=`<section class="unified-work"><header class="page-hd unified-work-header page-heading"><h1>待办</h1>
      <nav class="tabbar unified-work-tabs" aria-label="待办类型"><button class="tab" type="button" data-work-kind="all">全部待办</button><button class="tab" type="button" data-work-kind="processes">流程事项</button><button class="tab" type="button" data-work-kind="tasks">协作任务</button><button class="tab" type="button" data-work-kind="reminders">提醒</button></nav>
      <div class="unified-work-actions"></div></header><div class="unified-work-content"></div></section>`;
    async function select(kind) {
      if(!active())return;
      const ticket=++selection;
      taskContext=null;
      $('.unified-work-actions',host).replaceChildren();
      $$('[data-work-kind]',host).forEach(button=>{
        const selected=button.dataset.workKind===kind;
        button.classList.toggle('on',selected);
        button.setAttribute('aria-pressed',String(selected));
      });
      const content=$('.unified-work-content',host);
      content.replaceChildren();
      const pane=document.createElement('div');
      pane.className='unified-work-pane';
      pane.dataset.kind=kind;
      content.appendChild(pane);
      const context={...page,host:pane,actionsHost:$('.unified-work-actions',host),isActive:()=>active()&&ticket===selection&&pane.isConnected};
      pane.innerHTML=kind==='all'||kind==='reminders'?skeletonWorkTable(WORK_TABLE_COLUMNS[kind]):'<div class="platform-skeleton platform-skeleton-panel" data-skeleton="panel"><span class="platform-skeleton-panel-title"></span><span class="platform-skeleton-panel-line"></span><span class="platform-skeleton-panel-line short"></span><span class="platform-skeleton-panel-block"></span></div>';
      if(kind==='reminders'){
        let work;
        try{ work=await apiJSON('api/me/work'); }
        catch(error){ if(!context.isActive())return; pane.innerHTML=`<p role="alert">提醒读取失败：${esc(error.message||'请重试')}</p>`; return; }
        if(!context.isActive())return;
        const items=work.notifications||[];
        pane.innerHTML=`<div class="card"><div class="card-bd">${items.length
          ?`<table class="dtable"><thead><tr><th>提醒</th><th>时间</th><th>操作</th></tr></thead><tbody>${items.map((n,i)=>`<tr><td>${esc(n.message)}</td><td>${esc(String(n.created_at||'').replace('T',' ').slice(0,16))}</td><td><button class="btn btn-ghost" type="button" data-work-note-open="${i}">查看任务</button></td></tr>`).join('')}</tbody></table>`
          :'<p style="padding:12px;color:var(--fg3)">当前没有未读提醒</p>'}</div></div>`;
        context.actionsHost.innerHTML='<button class="btn btn-ghost" type="button" data-work-note-read-all>全部已读</button>';
        $('[data-work-note-read-all]',context.actionsHost).onclick=async()=>{
          for(const n of items){ try{ await api('api/me/notifications/'+encodeURIComponent(n.id)+'/read',{method:'POST'}); }catch{} }
          await select('reminders'); refreshWorkBadge();
        };
        $$('[data-work-note-open]',pane).forEach(button=>button.onclick=async()=>{
          const item=items[Number(button.dataset.workNoteOpen)];
          try{ await api('api/me/notifications/'+encodeURIComponent(item.id)+'/read',{method:'POST'}); }catch{}
          const next=selection+1;
          await select('tasks');
          if(active()&&selection===next&&taskContext?.isActive()&&typeof rtEditTask==='function')rtEditTask(item.task_id);
          refreshWorkBadge();
        });
        return;
      }
      if(kind==='all'){
        const responses=await Promise.allSettled([apiJSON('api/platform/process-instances?view=pending'),apiJSON('api/tasks'),apiJSON('api/platform/contributions?include_work=1')]);
        if(!context.isActive())return;
        const rows=[];
        if(responses[0].status==='fulfilled')for(const item of responses[0].value.list||[])rows.push({source:'process',id:item.name,title:item.definition_title||item.business_name||'流程事项',step:item.current_node_title||'待办理',item});
        if(responses[1].status==='fulfilled')for(const item of responses[1].value.list||[]){
          const me=currentUserInfo?.username;
          if((item.assignee_id===me&&['待办','进行中'].includes(item.status))||(item.created_by===me&&item.status==='待验收'))rows.push({source:'task',id:item.id,title:item.title,step:item.status,item});
        }
        if(responses[2].status==='fulfilled')for(const item of responses[2].value.work_items||[])rows.push({source:'record',id:item.name,title:item.title,step:item.step,item});
        pane.innerHTML=responses.map((result,i)=>result.status==='rejected'?`<p role="alert">${['流程事项','协作任务','业务待办'][i]}读取失败：${esc(result.reason?.message||'请重试')}</p>`:'').join('')+
          (responses[2].status==='fulfilled'?(responses[2].value.work_errors||[]).map(error=>`<p role="alert">业务待办读取失败：${esc(error.message)}</p>`).join(''):'')+
          `<div class="card" style="overflow:auto"><table class="dtable"><thead><tr><th>事项</th><th>来源</th><th>当前步骤</th><th>操作</th></tr></thead><tbody>${rows.map((row,i)=>`<tr><td>${esc(row.title)}</td><td>${({process:'流程',task:'协作任务',record:'业务申请'})[row.source]}</td><td>${esc(row.step)}</td><td><button class="btn btn-ghost" type="button" data-work-open="${i}">办理</button></td></tr>`).join('')||'<tr><td colspan="4">当前已读取来源中没有待办</td></tr>'}</tbody></table></div>`;
        context.actionsHost.innerHTML='<button class="btn btn-ghost" type="button" data-work-refresh>刷新</button>';
        $('[data-work-refresh]',context.actionsHost).onclick=()=>select('all');
        $$('[data-work-open]',pane).forEach(button=>button.onclick=async()=>{
          const row=rows[Number(button.dataset.workOpen)];
          if(row.source==='process'){
            sessionStorage.setItem('shangshu.process.intent',JSON.stringify({mode:'instance',instance:row.item}));
            await select('processes');
          }else if(row.source==='record'){
            const url=new URL(location.href);
            url.searchParams.set('application',row.item.application);
            url.searchParams.set('dataset',row.item.dataset);
            sessionStorage.setItem('shangshu.record.open',JSON.stringify({dataset:row.item.dataset,name:row.id}));
            history.replaceState({},'',url.pathname+url.search+url.hash);
            go('objects');
          }else{
            const next=selection+1;
            await select('tasks');
            if(active()&&selection===next&&taskContext?.isActive())rtEditTask(row.id);
          }
        });
        return;
      }
      if(kind==='tasks')taskContext=context;
      await (kind==='tasks'?renderTasks:renderProcesses)(context);
      mountActions(context);
    }
    $$('[data-work-kind]',host).forEach(button=>button.onclick=()=>select(button.dataset.workKind));
    await select(processIntent?'processes':requested==='tasks'?'tasks':requested==='reminders'?'reminders':'all');
  };
  RENDER['task-mgmt']=function() {
    if(taskContext?.isActive()){
      const context=taskContext;
      return Promise.resolve(renderTasks(context)).then(()=>mountActions(context));
    }
    return go('task-mgmt');
  };
  // 顶栏“待办”徽标：未读工作提醒数；读取失败静默（各页面有自己的错误提示）。
  async function refreshWorkBadge(){
    if(typeof currentUserInfo==='undefined'||!currentUserInfo||typeof apiJSON!=='function'||typeof updateWorkBadge!=='function')return;
    try{ const {notifications}=await apiJSON('api/me/work'); updateWorkBadge((notifications||[]).length); }catch{}
  }
  refreshWorkBadge();
  setInterval(refreshWorkBadge,60000);
  window.addEventListener('shangshu:work-reminder-read',refreshWorkBadge);
})();
