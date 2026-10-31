/* ============ 模块：领域中立数据目录
   数据集由已启用领域声明；普通页面不显示对象 ID/字段 ID，写操作仍交给确认卡。
*/
RENDER.objects = async (renderPage) => {
  const main=mainBox();
  let datasets=[];
  let selected=null;
  let page=1;
  let filters={};
  let datasetRequest = 0;
  /* ⚠️ **读请求要挂页面取消信号**（切页时上游能真的把它掐掉）：
     公共壳 `beginPageRender` 每次换页都会 abort 旧页的 AbortController，
     并把那个 signal 交给这一页的渲染函数（`renderPage.signal`）——
     ⇒ 这一页发出去的**读**请求带上它，切页时它们当场作废，不再回来写这一页。
     ⚠️ **只有读请求挂**：写操作（执行动作）**不挂** ——
     已发出的写必须保留核验与恢复语义，不能因为人切了页就被盲目中止。 */
  const readInit=()=>renderPage&&renderPage.signal?{signal:renderPage.signal}:{};
  /* ⚠️ **取消（AbortError）不是「读失败」**：切页时上游 abort 掉这一页的读请求
     ⇒ 那些请求会以 AbortError 失败 ⇒ 那不是出错，只是这一页已经不该管了
     ⇒ 不许拿它当「读不到」（会弹出吓人的报错提示），
     也不许拿它当「开不了」（那是「这一页的结论作废」⇒ 直接停手）。 */
  const isAbort=(error)=>!!(error&&(error.name==='AbortError'||error.code==='ABORT_ERR'));
  /* —— 骨架（正在取数时的占位）——
     照**最终那两栏／那张表**的样子画（表格骨架的列数＝真列数，这一页知道）；
     ⚠️ **只表示「正在取数」** ⇒ 不写假名字、不写假数字、不写假条目。 */
  const skeletonPanel=()=>'<div class="platform-skeleton platform-skeleton-panel" data-skeleton="panel"><span class="platform-skeleton-panel-title"></span><span class="platform-skeleton-panel-line"></span><span class="platform-skeleton-panel-line short"></span><span class="platform-skeleton-panel-block"></span></div>';
  /* 表格骨架：照**真表**（`.dataset-table`：表头浅灰底带、数据格空、只有细线；行高 38）。
     列数＝这一页知道的真列数。 */
  const skeletonTable=(columns,rows)=>{
    const head='<span class="platform-skeleton-td"><span class="platform-skeleton-bar"></span></span>';
    const cell='<span class="platform-skeleton-td"></span>';
    const line='<div class="platform-skeleton-tr">'+cell.repeat(columns)+'</div>';
    return `<div class="platform-skeleton platform-skeleton-table" data-skeleton="table" style="grid-template-columns:repeat(${columns},minmax(0,1fr));--sk-row-h:38px;--sk-head-h:38px"><div class="platform-skeleton-thead platform-skeleton-tr">${head.repeat(columns)}</div>${line.repeat(rows)}</div>`;
  };
  /* 左栏那一列：**直接用真页面的外壳类**（`.dataset-panel`／`.dataset-panel-head`／`.dataset-search`／`.dataset-item`）
     ⇒ 面板的内缩、搜索框的宽、条目的行高**天然跟真页面一样**（自己另起一套类 ⇒ padding 必歪）。 */
  const skeletonCatalog=()=>`<div class="dataset-list platform-skeleton" data-skeleton="catalog">${'<div class="dataset-item"><span class="platform-skeleton-bar platform-skeleton-dataset-name"></span></div>'.repeat(5)}</div>`;
  const skeletonSide=()=>'<aside class="dataset-panel" data-skeleton="side">'
    +'<div class="dataset-panel-head"><b>数据表</b><button class="btn btn-sm btn-ghost" type="button">×</button></div>'
    +'<input class="dataset-search" type="search" placeholder="查找数据表" readonly>'
    +skeletonCatalog()+'</aside>';
  /* 工作区那一块：**同样直接用真外壳类**（`.dataset-head`／`.dataset-filters`／`.dataset-table-wrap`／`.dataset-pagination`）
     ⇒ 四块的内缩与真页面一致；只有「字」换成灰底块。 */
  const skeletonWork=()=>'<section class="dataset-work" data-skeleton="work">'
    +'<div class="dataset-head"><div><span class="platform-skeleton-bar platform-skeleton-work-title"></span><span class="platform-skeleton-bar platform-skeleton-work-desc"></span></div><span class="platform-skeleton-bar platform-skeleton-work-count"></span></div>'
    +'<div class="dataset-filters"><label><span class="platform-skeleton-bar platform-skeleton-work-desc"></span><span class="platform-skeleton-input"></span></label><label><span class="platform-skeleton-bar platform-skeleton-work-desc"></span><span class="platform-skeleton-input"></span></label><div class="dataset-filter-actions"><span class="platform-skeleton-btn"></span><span class="platform-skeleton-btn"></span></div></div>'
    +'<div class="dataset-table-wrap">'+skeletonTable(4,3)+'</div>'
    +'<footer class="dataset-pagination"><span class="platform-skeleton-bar platform-skeleton-work-count"></span><div><span class="platform-skeleton-btn"></span><span class="platform-skeleton-btn"></span></div></footer>'
    +'</section>';
  /* 开场那一刻：**总目录路**（不知道要开哪张表）真页面是**两栏浏览**（左边一列清单 ＋ 右边工作区）⇒ 骨架照那两栏搭；
     ⚠️ **直达路（知道要开哪张表）不许画两栏**（PKG-116-T15：先画后扔 ＝ 白画）⇒ 那条路只摆一块中性占位。 */
  const skeletonBrowser=()=>`<div class="platform-skeleton-browser" data-skeleton="browser">${skeletonSide()}${skeletonWork()}</div>`;
  /* 真列数（这一页知道）；拿不到就按 4 列占位。 */
  const tableColumns=()=>Math.max(1,((selected&&selected.columns)||[]).length||4);
  /* 记录表：骨架就是**那张真表**（`.dataset-table` ＋ 真列名），数据行**空着**。 */
  const skeletonRecordsTable=()=>{
    const columns=(selected&&selected.columns)||[];
    const head='<tr>'+(columns.length?columns.map(column=>`<th scope="col">${esc(displayLabel(column.label,column.field))}</th>`).join(''):'<th scope="col"></th>')+'</tr>';
    const row='<tr data-skeleton-row="1">'+'<td></td>'.repeat(Math.max(1,columns.length))+'</tr>';
    return `<div class="dataset-table-wrap"><table class="dataset-table platform-skeleton" data-skeleton="table"><thead>${head}</thead><tbody>${row.repeat(6)}</tbody></table></div>`;
  };
  /* 页面标题只画一次（视觉一致性对齐，任务号：待补）：
     业务域受管表页内嵌的表格部件（sheet-center）自己带一个 h1（表名），
     宿主页再画一个大标题就成「标题画两遍」⇒ 挂表格时把宿主标题降级成
     一行**上下文条**（.page-context，13px/500/次级色），表格回到普通数据表时再还回来。 */
  let titleHost=null;
  const setPageTitle=text=>{if(!titleHost)titleHost=$('h1',main);if(titleHost)titleHost.textContent=text;};
  const useH1Title=()=>{
    if(!titleHost)return;
    if(titleHost.tagName==='H1')return;
    const h1=document.createElement('h1');
    h1.textContent=titleHost.textContent;
    titleHost.replaceWith(h1);
    titleHost=h1;
  };
  const params=new URLSearchParams(location.search);
  const applicationId=params.get('application');
  /* ⚠️ **分界点：「进页之前知不知道要开哪张表/哪一页」**（用户 2026-10-25 拍板的三种骨架）：
       · 地址里带 `?dataset=`（深链、旧表格链接的兼容路由、应用页点某张表）
         或**记住了上次选的那张**（`shangshu.dataset.open`）⇒ **知道** ⇒ **直达目标页**（骨架①/②）；
       · 都没带 ⇒ 这是点「数据」总目录进来的 ⇒ **不知道** ⇒ 这一页就长成**两栏浏览界面**（骨架③）。
     ⚠️ **「数据」总目录不许自己把人甩进某张表** ⇒ 直达只由「明确要看哪张」触发。 */
  const requested=params.get('dataset');
  const remembered=sessionStorage.getItem('shangshu.dataset.open');
  let explicit=!!requested||!!remembered;
  if(typeof selectApplicationNavigation==='function')selectApplicationNavigation(applicationId);
  /* ⚠️ **进页先只留一行字**（用户 2026-10-25 原话：「为什么不能是 excel 表作为一种骨架，
     然后 host（= 通知书助手，域自己那一页）作为一个骨架，其他的就进入两栏这种，
     因为前两者才是常用的」）：
     ⇒ **三种骨架**：① Excel 工作面 ② 域自己那一页（通知书助手／邮件规则表那种）③ 其余 ⇒「数据」总目录的两栏。
     ⇒ **分界点不是「能不能开 Excel」，而是「进页之前知不知道要开哪张表/哪一页」**：
        知道的 ⇒ **直达目标页**（不经过数据页的两栏骨架）；不知道的 ⇒ 数据页登场（两栏浏览）。
     ⇒ 所以**两栏浏览界面要等确定了「这一页就长这样」才画** ⇒ 直达那条路上
        **从头到尾 DOM 里没有 `.objects-shell`／`.dataset-panel`**（先画后扔 ＝ 白画，
        人还会看到一帧旧界面才跳走）；等待的那一句交给**目标页自己的骨架**
        （Excel 页开机就有「正在打开表格…」）。 */
  main.innerHTML=`<section class="platform-page objects-page" data-objects-stage><header class="page-hd platform-page-head page-heading"><h1>数据</h1><div class="page-actions"><button class="btn btn-ghost" type="button" data-ai-data>${ICONS.spark} 让 AI 协助</button></div></header><nav class="admin-destinations" data-admin-destinations></nav><div class="objects-stage-body" data-objects-stage-body>${explicit?skeletonPanel():skeletonBrowser()}</div></section>`;
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(main,'objects');
  $('[data-ai-data]',main).onclick=()=>chatAssist({module:'objects',label:selected?`数据 · ${selected.name}`:'数据目录'},selected?`请基于「${selected.name}」当前筛选结果协助我分析；任何修改先给确认卡。`:'请帮我设计或查找需要的业务数据；任何写操作先给确认卡。');
  const stage=$('[data-objects-stage]',main);
  const stageBody=$('[data-objects-stage-body]',main);
  const active=()=>stage.parentNode===main&&(!renderPage||renderPage.isActive());
  /* 把这一页画成**两栏浏览界面**（只有「就在这儿看」的那条路才画它）。 */
  const buildBrowser=()=>{
    if(stageBody.querySelector('.objects-shell'))return;
    stageBody.innerHTML=`<div class="objects-shell"><aside class="dataset-panel"><div class="dataset-panel-head"><b>数据集</b><button class="btn btn-sm btn-ghost" type="button" data-close-datasets aria-label="关闭数据集">×</button></div><div class="dataset-list">${skeletonCatalog()}</div></aside><section class="dataset-work">${skeletonTable(4,3)}</section></div>`;
    $('[data-close-datasets]',main).onclick=()=>main.querySelector('.objects-shell').classList.remove('show-catalog');
    const search=document.createElement('input');search.type='search';search.placeholder='查找数据表';search.setAttribute('aria-label','查找数据表');search.className='dataset-search';
    $('.dataset-panel-head',stage).after(search);search.oninput=drawCatalog;
    $('.dataset-panel-head b',stage).textContent='数据表';
    /* 应用里只有一张表时 ⇒ 左边那一栏藏起来（只剩右栏）。 */
    stageBody.querySelector('.objects-shell').classList.toggle('single-dataset',!!applicationId&&datasets.length===1);
  };
  try{
    // 应用详情是已授权的绑定投影，不从全局目录按名称猜测归属。
    const transferred=applicationId&&window.shangshuTakeApplicationNavigationDetail?.(applicationId,requested||remembered);
    const response=transferred?null:await api(applicationId?`/api/platform/applications/${encodeURIComponent(applicationId)}`:'/api/platform/datasets',readInit());
    const data=transferred?{application:transferred}:await response.json();
    if(!active())return;
    if((response&&!response.ok)||data.ok===false)throw new Error(data.error||'数据目录加载失败');
    datasets=applicationId?(data.application?.datasets||[]):(data.list||[]);
    setPageTitle(applicationId?(data.application?.title||'应用数据'):'全部数据');
    if(applicationId){
      const back=document.createElement('button');back.type='button';back.className='btn btn-ghost';back.textContent='全部应用';
      back.onclick=()=>go('applications');
      $('.page-actions',stage).prepend(back);
      const app=data.application;
      if(app.overview_enabled){
        back.textContent='应用总览';
        back.onclick=()=>{sessionStorage.setItem('shangshu.application.open',applicationId);go('applications');};
      }
      const launches=[...(app.primary_action?.type==='process'&&app.primary_action.target?[{id:app.primary_action.target,name:app.primary_action.label}]:[]),...(app.processes||[])];
      const seen=new Set();
      for(const process of launches){
        if(!process.id||seen.has(process.id))continue;seen.add(process.id);
        const launch=document.createElement('button');launch.type='button';launch.className='btn btn-pri';launch.textContent=process.name||process.title||'发起申请';
        launch.onclick=()=>{sessionStorage.setItem('shangshu.process.intent',JSON.stringify({definition_id:process.id,mode:'launch'}));go('flowdesign');};
        $('.page-actions',stage).append(launch);
      }
      if(currentUserInfo?.role==='admin'){
        const configure=document.createElement('button');configure.type='button';configure.className='btn btn-ghost';configure.textContent='配置应用';
        configure.onclick=()=>{sessionStorage.setItem('shangshu.application.open',applicationId);go('app-design');};$('.page-actions',stage).prepend(configure);
      }
    }
    if(!datasets.length){stageBody.innerHTML=`<div class="platform-empty wide"><b>当前没有业务数据集</b><p>平台内核正常运行。启用业务应用后，它贡献的数据集会显示在这里。</p>${currentUserInfo?.role==='admin'?'<button class="btn btn-ghost" type="button" data-empty-apps>应用管理</button>':''}</div>`;const b=$('[data-empty-apps]',main);if(b)b.onclick=()=>go('apps');return;}
    const preferred=requested||remembered;sessionStorage.removeItem('shangshu.dataset.open');
    selected=datasets.find(item=>item.id===preferred)||datasets[0];
    if(requested&&requested!==selected.id){const url=new URL(location.href);url.searchParams.set('dataset',selected.id);history.replaceState(null,'',url);}
    /* ⚠️ **浏览路（骨架③）先立起两栏**：左栏（数据集清单）**不用等记录** ——
       记录还在路上时也能换表（判据 platform-remediation-ui：旧请求回来时不能盖掉新选的那张）。 */
    if(!explicit){buildBrowser();drawCatalog();}
    await drawDataset();
    const intent=sessionStorage.getItem('shangshu.record.open');
    if(intent&&active()){
      sessionStorage.removeItem('shangshu.record.open');
      try{const record=JSON.parse(intent);if(record.dataset===selected.id&&selected.object_id)await openRecord(selected.object_id,record.name);}catch(error){toast('记录无法打开',error.message||String(error));}
    }
  }catch(error){if(isAbort(error)||!active())return;stageBody.innerHTML=`<div class="platform-error wide"><b>数据目录暂时无法读取</b><p>${esc(error.message||error)}</p><button class="btn btn-ghost" type="button" data-retry>重新加载</button></div>`;$('[data-retry]',main).onclick=()=>RENDER.objects(renderPage);}

  function drawCatalog(){
    if(!stageBody.querySelector('.objects-shell'))buildBrowser();
    const term=$('.dataset-search',main)?.value.trim()||'';
    $('.dataset-list',main).innerHTML=datasets.filter(item=>item.name.includes(term)).map(item=>`<button type="button" class="dataset-item ${item.id===selected.id?'on':''}" data-dataset="${esc(item.id)}" title="${esc(item.name)}"><span>${esc(item.name)}</span></button>`).join('')||'<p class="dataset-list-empty">没有匹配的数据表</p>';
    $$('[data-dataset]',main).forEach(button=>button.onclick=async()=>{
      if(selected.id===button.dataset.dataset)return;
      if(!window.dispatchEvent(new Event('shangshu:before-page-change',{cancelable:true})))return;
      /* ⚠️ **人刚点了某张表 ⇒ 从这一刻起「知道要开哪张表」了** ⇒ 这张表能开 Excel 就直达那一页。 */
      explicit=true;
      selected=datasets.find(item=>item.id===button.dataset.dataset);page=1;filters={};
      const url=new URL(location.href);url.searchParams.set('dataset',selected.id);history.replaceState(null,'',url);
      drawCatalog();main.querySelector('.objects-shell').classList.remove('show-catalog');await drawDataset();
    });
  }

  async function drawDataset(){
    const request = ++datasetRequest;
    let work=null;
    const work0=$('.dataset-work',main);if(work0)work0.innerHTML=skeletonRecordsTable();
    try{
      if(explicit&&selected.object_id){
        const intent=readRecordIntent();
        const record=intent&&intent.dataset===selected.id?String(intent.name||''):'';
        sessionStorage.removeItem('shangshu.record.open');
        const opened=window.shangshuOpenTable?.(selected.object_id,{recordName:record,pageId:clickedNavPageId(),source:'db'});
        if(!opened||opened.ok===false)throw Error(opened?.reason||'表格工作面暂不可用，请刷新后重试');
        return;
      }
      const query=new URLSearchParams({page:String(page),page_length:'30',filters:JSON.stringify(filters)});
      const response=await api(`/api/platform/datasets/${encodeURIComponent(selected.id)}/records?${query}`,readInit());const data=await response.json();
      if(request!==datasetRequest||(renderPage&&!renderPage.isActive()))return;
      if(!response.ok||data.ok===false)throw new Error(data.error||'记录加载失败');
      if(typeof chatSetBusinessContext==='function')chatSetBusinessContext({module:'objects',view:'data-table',entity_type:'object',entity_id:selected.object_id,label:selected.name,editable_scope:'查询当前数据表；写入先核对确认，与人工维护共用同一业务记录'});
      /* 业务表**一律走 Excel 工作面**（用户 2026-10-25 拍板：
         「业务这边也都直接改成 excel 交互，不要再用图片上的样子」；
         并且这一批把 native 表也切过来 ⇒ 表格中心这一批就空了，下一步才能整块退役它）。
         能不能开，靠**对象自己的记录口通不通**（见 canOpenInExcel）。 */
      /* ⚠️ **探针的结论要分三态**：能开（true）／开不了（false）／**被取消（null）**。
         取消 = 人已经切走了这一页（上游 abort 了探针）⇒ 这一页的结论一律作废
         ⇒ 直接停手（不换页、不画旧形态）—— 取消**不是**「开不了」。 */
      const probe=selected.object_id?await canOpenInExcel(selected.object_id,data,renderPage&&renderPage.signal):false;
      /* ⚠️ **这一句 await 之后必须复查**（改之前没有这一句）：
         等探针的那一下，人可能已经点了侧栏别的页（这一页失活），
         也可能已经换选了另一张表（代次变了）⇒ 旧结论一律作废。
         **不复查就会拿旧结论去换页 ⇒ 人被拽回旧表**（审查报告 R21）。
         判据照 `openRecord`／`editManagedRecord` 的原样：代次 ＋ 页面活跃，两道一起判。 */
      if(request!==datasetRequest||(renderPage&&!renderPage.isActive()))return;
      if(probe===null)return;
      const excelReady=!!probe;
      if(excelReady){
        /* ⚠️ **直达路（骨架①）：进页之前就知道要开哪张表** ⇒ 换页到目标页
           （Excel 工作面／域自己那一页），那一页自己画它的骨架
           ⇒ **「数据」页从头到尾只剩那一行字**，不会「画了又扔」
           （用户 2026-10-25 原话：「前两者才是常用的」）。
         ⚠️ **不整页跳转**（`location.href`）—— 那样侧栏会重画，而侧栏条目是**异步到达**的
            ⇒ 重载后先画一遍「少的」再补 ⇒ 「侧栏会少好多个选项」（用户原话）。
            ⇒ 走 `shangshuOpenTable`（同页换页，表号自己写进地址）。 */
        /* 换不过去（没装开表入口／登记口不认这张表）⇒ 留在这一页，
           给一个「打开表格」的入口；**不画旧形态的表格**（旧形态这一批已经退役）。 */
        buildBrowser();drawCatalog();
        work=$('.dataset-work',main);
        if(work){
          work.innerHTML=`<div class="platform-empty wide"><b>${esc(selected.name)}</b><p>这是业务表格，在 Excel 工作面里查看和编辑。</p><button class="btn btn-pri" type="button" data-open-excel>打开表格</button></div>`;
          $('[data-open-excel]',work).onclick=()=>window.shangshuOpenTable?.(selected.object_id,{pageId:clickedNavPageId(),source:'db'});
        }
        return;
      }
      /* 浏览路（骨架③）：两栏浏览界面。 */
      buildBrowser();
      drawCatalog();
      work=$('.dataset-work',main);
      if(!work)return;
      work.innerHTML=skeletonRecordsTable();
      /* 表格中心**这一批空出来了**（用户 2026-10-25：「我们需要逐渐把表格中心给弃用」）：
         受管对象与 native 表都走 Excel 工作面 ⇒ 这里不再挂表格部件。
         部件本身（js/sheet-center.js）**一个字没动** —— 整块退役是下一批的事。 */
      useH1Title();/* 普通数据表（不是表格部件）⇒ 宿主标题仍是页面主标题 */
      const rows=data.rows||[],columns=selected.columns||[],pages=Math.max(1,Math.ceil(Number(data.total||0)/Number(data.page_length||30)));
      work.innerHTML=`<div class="dataset-head"><button class="btn btn-sm btn-ghost dataset-catalog-button" type="button" data-open-datasets>数据集</button><div><h2>${esc(selected.name)}</h2><p>${esc(selected.description||'')}</p></div><span class="dataset-total">共 ${Number(data.total||0)} 条</span></div>${renderFilters(selected.filters||[])}<div class="dataset-table-wrap">${rows.length?`<table class="dataset-table"><thead><tr>${columns.map(column=>`<th>${esc(displayLabel(column.label,column.field))}</th>`).join('')}</tr></thead><tbody>${rows.map((row,index)=>`<tr>${columns.map((column,ci)=>`<td>${ci===0&&selected.object_id&&row.name?`<button class="btn btn-sm btn-ghost" type="button" data-record="${index}">${formatCell(row._display?.[column.field]??row[column.field],column)}</button>`:formatCell(row._display?.[column.field]??row[column.field],column)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:`<div class="platform-empty"><b>没有匹配记录</b><p>${data.object?.source==='managed'?'点击“新建记录”开始录入，或调整筛选条件。':'调整筛选条件，或从对应流程发起新的业务事项。'}</p></div>`}</div><footer class="dataset-pagination"><span>第 ${page} / ${pages} 页</span><div><button class="btn btn-sm btn-ghost" type="button" data-prev ${page<=1?'disabled':''}>上一页</button><button class="btn btn-sm btn-ghost" type="button" data-next ${page>=pages?'disabled':''}>下一页</button></div></footer>`;
      $$('[data-record]',work).forEach(button=>button.onclick=()=>openRecord(selected.object_id,rows[Number(button.dataset.record)].name));
      if(!rows.length){
        const empty=$('.dataset-table-wrap',work);
        empty.insertAdjacentHTML('afterbegin',`<table class="dataset-table"><thead><tr>${columns.map(column=>`<th>${esc(displayLabel(column.label,column.field))}</th>`).join('')}</tr></thead></table>`);
      }
      const table=$('.dataset-table',work);
      if(table){
        table.style.minWidth=(columns.length*140+80)+'px';
        const editable=data.object?.source==='managed'&&data.object.operations.includes('update');
        const th=document.createElement('th');th.textContent='操作';th.className='dataset-row-actions';table.tHead.rows[0].append(th);
        Array.from(table.tBodies[0]?.rows||[]).forEach((tr,index)=>{
          const row=rows[index];
          const actions=document.createElement('td');actions.className='dataset-row-actions';
          const button=document.createElement('button');button.type='button';button.className='btn btn-ghost';button.textContent=editable?'编辑':'查看';
          button.onclick=async()=>{
            if(!editable){openRecord(selected.object_id,row.name);return;}
            try{const response=await api('/api/platform/objects/'+encodeURIComponent(selected.object_id)+'/records/'+encodeURIComponent(row.name),readInit());const detail=await response.json();if(!response.ok||detail.ok===false)throw Error(detail.error||'读取失败');if(request===datasetRequest&&active())editManagedRecord(detail.object,detail.record);}catch(error){if(isAbort(error))return;toast('无法编辑',error.message);}
          };
          if(selected.object_id&&row.name)actions.append(button);tr.append(actions);
        });
      }
      if(data.object?.source==='managed' && data.object.operations.includes('create')){
        const add=document.createElement('button');add.className='btn btn-pri';add.type='button';add.textContent='新建'+selected.name;
        add.onclick=()=>editManagedRecord(data.object);
        $('.dataset-head',work).append(add);
      }
      for(const action of data.actions||[]){
        const add=document.createElement('button');add.type='button';add.className='btn btn-pri';add.textContent=action.title;
        add.onclick=()=>runAction(action,async()=>{if(request===datasetRequest&&active())await drawDataset();});
        $('.dataset-head',work).append(add);
      }
      $('[data-open-datasets]',work).onclick=()=>main.querySelector('.objects-shell').classList.add('show-catalog');
      const form=$('[data-filter-form]',work);if(form)form.onsubmit=async event=>{event.preventDefault();filters=Object.fromEntries(new FormData(form).entries());page=1;await drawDataset();};
      const clear=$('[data-filter-clear]',work);if(clear)clear.onclick=async()=>{filters={};page=1;await drawDataset();};
      const prev=$('[data-prev]',work);if(prev)prev.onclick=async()=>{page--;await drawDataset();};
      const next=$('[data-next]',work);if(next)next.onclick=async()=>{page++;await drawDataset();};
    }catch(error){if(isAbort(error)||request!==datasetRequest||(renderPage&&!renderPage.isActive()))return;const message=`<div class="platform-error"><b>记录暂时无法读取</b><p>${esc(error.message||error)}</p><button class="btn btn-ghost" type="button" data-retry>重试</button></div>`;if(work){work.innerHTML=message;$('[data-retry]',work).onclick=drawDataset;}else{stageBody.innerHTML=message;$('[data-retry]',main).onclick=drawDataset;}}
  }


  /* **被点的那一项自己的页 id**（没有就退回实现页 `excel`）。
     ⚠️ **先问登记口**（域登记过「这张表归哪一页管」就用那一页）——
        这是**最准**的一条：它说的就是「这张表」。
        侧栏高亮项（`data-nav-page`）是次选：那是「人当时在侧栏点的是哪一项」，
        数据页里点数据集时侧栏高亮的**不是**那一项 ⇒ 拿它当准会认错。
     ⚠️ 页 id 是**别名页自己的 id**（如某域的 `ip.<域>.cases`），
        不是它指向的实现页（`excel`）—— 写实现页就丢了身份。 */
  function clickedNavPageId(){
    const owner=selected&&selected.object_id&&window.shangshuTablePage?window.shangshuTablePage(selected.object_id):null;
    if(owner&&owner.pageId)return owner.pageId;
    const fromSide=document.querySelector('#side .side-item.on[data-nav-page]');
    const sideId=fromSide&&fromSide.getAttribute('data-nav-page');
    /* ⚠️ **侧栏高亮项给的页 id 要验过再用**（用户 2026-10-25 探针）：
       高亮项可能是**应用项**（`application:…`）—— 那不是页，页面注册表认不出
       ⇒ 拿它去跳表 ⇒ `go()` 退回 dash ⇒ 人点业务表却掉回工作台。
       ⇒ 认不出就不采用（退回实现页 `excel`）。 */
    if(sideId&&typeof resolvePage==='function'&&resolvePage(sideId))return sideId;
    return 'excel';
  }
  /* 这张表能不能用 Excel 工作面打开？
     判据只有一条：**对象自己的记录口通不通**（Excel 页就走那条口读数据）。
     · 受管对象／原生表 ⇒ 数据集读口已经给了 `object.source` ⇒ 直接能开；
     · 原生只读数据集（finance.*、warehouse.*、mail.message、files.file）
       ⇒ 数据集读口给的是**数据集投影**（不是对象记录）⇒ 探一下对象记录口：
         通 ⇒ 去 Excel（只读，但读全通）；不通 ⇒ 留在原来的表格形态。
       **不通的典型**：域声明的受管对象在本站没装物理表（对象记录口 417）。
     探不通就**如实留在原处**，不跳到一个打不开的页面。 */
  /* ⚠️ **取消信号是参数传进来的**（不许引入新的全局状态）：探针自己也是这一页的读请求
     ⇒ 切页时它也该被掐掉 ⇒ 它得挂这一页的取消信号。
     ⚠️ **结论分三态**：`true` 能开 ／ `false` 真开不了 ／ **`null` 被取消**
     （被取消**不是**「开不了」—— 那是「这一页的结论作废」⇒ 调用方要直接停手）。 */
  async function canOpenInExcel(objectId,data,signal){
    const source=data?.object?.source;
    if(source==='managed'||source==='native')return true;
    try{
      const response=await api('/api/platform/objects/'+encodeURIComponent(objectId)+'/records?page=1&page_length=1',signal?{signal}:{});
      const body=await response.json();
      return !!response.ok&&body?.ok!==false;
    }catch(error){
      /* ⚠️ **取消 与 真的开不了，要分开**（改之前这里一律 `catch{return false}`）：
         取消 = 人已经切走了这一页 ⇒ 这一页的结论作废 ⇒ 回「不知道」（null），
         让调用方**直接停手**（不许拿它去换页，也不许当成「开不了」去画旧形态）。 */
      if(isAbort(error)||(signal&&signal.aborted))return null;
      return false;
    }
  }
  /* 待办点一条记录 ⇒ 壳把意图放在 sessionStorage 里；读它（读坏了就当没有）。 */
  function readRecordIntent(){
    try{
      const raw=sessionStorage.getItem('shangshu.record.open');
      if(!raw)return null;
      const intent=JSON.parse(raw);
      return intent&&typeof intent==='object'?intent:null;
    }catch{return null;}
  }

  async function openRecord(objectId,name){
    const request=datasetRequest;
    try{
      const response=await api('/api/platform/objects/'+encodeURIComponent(objectId)+'/records/'+encodeURIComponent(name),readInit());
      const data=await response.json();
      if(request!==datasetRequest||(renderPage&&!renderPage.isActive()))return;
      if(!response.ok||data.ok===false)throw new Error(data.error||'详情读取失败');
      /* 受管记录 **和原生记录**都不再走旧详情弹窗 ⇒ 去 Excel 工作面看这条记录（旧形态不留）。
         ⚠️ 同样**不整页跳转**（侧栏不重画 ⇒ 不会短暂少几项）。 */
      if(data.object?.source==='managed'||data.object?.source==='native'){
        sessionStorage.removeItem('shangshu.record.open');
        window.shangshuOpenTable?.(objectId,{recordName:name,pageId:clickedNavPageId(),source:'db'});
        return;
      }
      const dialog=document.createElement('dialog');dialog.className='schema-dialog';
      dialog.innerHTML=`<section class="schema-form"><h2>${esc(data.object?.name||'记录详情')}</h2><dl class="pf-facts">${(data.object?.fields||[]).map(field=>`<div><dt>${esc(displayLabel(field.label||field.id,field.id))}</dt><dd>${recordValue(data.record?._display?.[field.id]??data.record?.[field.id],field)}</dd></div>`).join('')}</dl><div data-record-processes></div><div class="schema-actions" data-record-actions><button type="button" class="btn btn-ghost" data-close>关闭</button></div></section>`;
      const close=()=>dialog.remove();dialog.querySelector('[data-close]').onclick=close;dialog.addEventListener('cancel',close);
      if(data.object?.source==='managed' && data.object.operations.includes('update')){
        const edit=document.createElement('button');edit.type='button';edit.className='btn btn-pri';edit.textContent='编辑记录';
        edit.onclick=()=>{close();editManagedRecord(data.object,data.record);};
        dialog.querySelector('[data-record-actions]').prepend(edit);
      }
      (data.processes||[]).forEach(instance=>{
        const b=document.createElement('button');b.className='btn btn-ghost';b.type='button';b.textContent='查看关联事项 · '+(instance.business_name||instance.name);
        b.onclick=()=>{close();sessionStorage.setItem('shangshu.process.intent',JSON.stringify({mode:'instance',instance}));go('flowdesign');};
        dialog.querySelector('[data-record-processes]').append(b);
      });
      (data.actions||[]).forEach(action=>{
        const b=document.createElement('button');b.className='btn btn-pri';b.type='button';b.textContent=action.title;
        b.onclick=()=>runAction(action,async()=>{close();if(request===datasetRequest&&active())await drawDataset();});
        dialog.querySelector('[data-record-actions]').prepend(b);
      });
      document.body.append(dialog);dialog.showModal();
    }catch(error){
      /* ⚠️ **取消不是「详情读取失败」**：切页时这一页的读请求被 abort ⇒
         不许弹报错（人切个页却看到一句「详情读取失败」＝白吓人）。 */
      if(isAbort(error)||(renderPage&&!renderPage.isActive()))return;
      toast('详情读取失败',error.message||String(error));
    }
  }

  async function editManagedRecord(object,record=null){
    const request=datasetRequest;
    try{
      const schema=schemaWithLookups(object.input_schema,object.reference_fields);
      if(request!==datasetRequest||(renderPage&&!renderPage.isActive()))return;
      const key=crypto.randomUUID();
      openSchemaForm({title:(record?'编辑':'新建')+' · '+object.title,...schema,values:record||{},submitLabel:'确认保存',onSubmit:async values=>{
        const payload={object_id:object.id,expected_revision:object.revision,
          values:Object.fromEntries(Object.keys(schema.properties).map(key=>[key,values[key]??null])),
          ...(record?{name:record.name,expected_modified:record.modified}:{})};
        await submitJSON('/api/platform/actions/platform.object.'+(record?'update':'create')+'/execute',{payload,confirmed:true,idempotency_key:key});
        if(request===datasetRequest&&(!renderPage||renderPage.isActive()))await drawDataset();
      }});
    }catch(error){toast('表单读取失败',error.message||String(error));}
  }

  function runAction(action,onSuccess){
    const idempotencyKey=crypto.randomUUID();
    const schema=action.input_schema||{},fields=schema.properties||{},required=schema.required||[];
    const properties=Object.fromEntries([...new Set([...required,...Object.keys(fields)])].filter(key=>fields[key]).map(key=>[key,fields[key]]));
    openSchemaForm({title:action.title,properties,required,
      values:action.values||{},hidden:action.hidden||{},submitLabel:'确认执行',onSubmit:async payload=>{
        /* ⚠️ **写请求不许挂取消信号**（只有读请求挂）：
           已发出的写必须保留核验与恢复语义 —— 人切了页也不能把这个写**盲目中止**。 */
        const result=await api('/api/platform/actions/'+encodeURIComponent(action.id)+'/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:idempotencyKey})});
        const body=await result.json();if(!result.ok||body.ok===false)throw new Error(body.error||'操作失败');
        await onSuccess();
      }});
  }

  function recordValue(value,field){
    if(field.value_labels?.[value]!==undefined)return esc(field.value_labels[value]);
    if(field.type==='detail' && Array.isArray(value))return value.length?`<div class="dataset-table-wrap"><table class="dataset-table"><thead><tr>${(field.children||[]).map(f=>`<th>${esc(displayLabel(f.label,f.id))}</th>`).join('')}</tr></thead><tbody>${value.map(row=>`<tr>${(field.children||[]).map(f=>`<td>${recordValue(row._display?.[f.id]??row[f.id],f)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'—';
    if(field.type==='boolean')return value?'是':'否';
    if(field.id?.endsWith('_cents')&&value!==null&&value!==undefined&&/^-?\d+$/.test(String(value)))return money(Number(value)/100);
    return esc(String(value??'—'));
  }

  function displayLabel(label,field){return field?.endsWith('_cents')?String(label).replace(/（分）$/, '').replace(/（元）$/, '')+'（元）':label;}
  function renderFilters(specs){if(!specs.length)return'';return`<form class="dataset-filters" data-filter-form>${specs.map(spec=>`<label><span>${esc(spec.label)}</span>${spec.type==='select'?`<select name="${esc(spec.field)}">${(spec.options||[]).map(option=>`<option value="${esc(option.value)}" ${String(filters[spec.field]||'')===String(option.value)?'selected':''}>${esc(option.label)}</option>`).join('')}</select>`:`<input name="${esc(spec.field)}" value="${esc(filters[spec.field]||'')}" placeholder="筛选${esc(spec.label)}">`}</label>`).join('')}<div class="dataset-filter-actions"><button class="btn btn-pri btn-sm" type="submit">应用筛选</button><button class="btn btn-ghost btn-sm" type="button" data-filter-clear>清除</button></div></form>`;}
  function formatCell(value,column){if(value===null||value===undefined||value==='')return'<span class="muted">—</span>';if(column.value_labels&&column.value_labels[value]!==undefined)return esc(column.value_labels[value]);const filter=(selected.filters||[]).find(item=>item.field===column.field);const option=(filter?.options||[]).find(item=>String(item.value)===String(value));if(option)return esc(option.label);if(column.field?.endsWith('_cents')&&/^-?\d+$/.test(String(value)))return money(Number(value)/100);if(column.format==='money')return money(value);if(column.format==='datetime')return esc(String(value).replace('T',' ').slice(0,16));return esc(String(value));}
};
