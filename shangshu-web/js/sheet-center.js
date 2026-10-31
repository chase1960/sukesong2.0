/* 旧表格界面（sheet-center）：受管对象读写；交互样例与真实数据分开。
   ⚠️ **2026-10-25 用户拍板**：业务表改走 **Excel 工作面**（侧栏那一栏「表格」）⇒
   **这个部件逐步退役**（PKG-116-T06）。它的标题统一叫「**数据表**」——
   「**表格**」那个词留给侧栏的 Excel 工作面（客户最熟、且是唯一留下来的表格界面）⇒
   用户说「表格」时只有一个东西可指。
   交互模型对齐 3in 2cad1c70 总表：双击或键盘直接编格、
   脏格标“未保存”、撤销/重做按格子独立时间线、保存只清提交那一刻的修订。 */
window.mountSheetCenter = function (host, {signal, examples: showExamples = false, objectId = null, onOpenRecord, onEditRecord, recordSchema} = {}) {
  const scoped = objectId !== null;
  if(scoped)showExamples=false;
  const canDesign = typeof currentRole === 'function' && currentRole() === 'admin';
  host.classList.add('sheet-center-page');
  host.innerHTML = `
    <header class="sheet-heading page-heading">
      <h1>数据表</h1><span class="managed-label" ${scoped?'':'hidden'}>受管</span><span class="preview-label" ${scoped?'hidden':''}>建设中</span>
      <p class="page-sub" ${scoped?'hidden':''}>像表格一样维护业务数据；修改后保存并留有记录，可随时追溯</p>
      <div class="sheet-heading-actions">
        <select id="sheet-select" aria-label="选择数据表" hidden></select>
        <button class="btn btn-pri" id="add-row" disabled>存储待接入</button>
        <button class="btn btn-ghost" id="edit-mode" disabled aria-pressed="false">进入编辑模式</button>
        <button class="btn btn-ghost" id="refresh-sheet" disabled>刷新</button>
        <button class="btn btn-ghost" id="new-sheet">新建业务表</button>
        <button class="btn btn-ghost" id="configure-sheet" disabled>字段（列）</button>
        <button class="btn btn-ghost" id="import-sheet" disabled>导入 Excel</button>
        <details class="sheet-settings"><summary class="btn btn-ghost">更多</summary><div class="sheet-settings-menu">
          <button class="btn btn-ghost" id="export-sheet" disabled>导出筛选结果</button>
          <button class="btn btn-ghost" id="recycle-sheet" disabled>回收站</button>
          <button class="btn btn-ghost" id="view-mode">切换完整台账</button>
          <button class="btn btn-ghost" id="manage-columns">列管理</button>
          <button class="btn btn-ghost" id="quick-sheet" hidden>快速建表（通用台账）</button>
          <button class="btn btn-ghost" id="examples-toggle">查看交互样例</button>
        </div></details>
      </div>
    </header>
    <nav class="sheet-tabs" aria-label="行范围" ${showExamples?'':'hidden'}>
      <button data-view="rows" aria-current="page">全部记录 <span id="rows-count"></span></button>
      <button data-view="trash">行回收站</button>
    </nav>
    <section class="sheet-filterbar" aria-label="搜索与筛选">
      <label class="sheet-search"><input id="search" placeholder="搜索案号、名称、客户或申请人" aria-label="搜索记录"></label>
      <select id="status-filter" aria-label="状态筛选"><option value="">全部状态</option></select>
      <button class="btn btn-ghost" id="filter-fields" hidden>添加筛选</button>
      <button class="btn btn-ghost" id="clear">清除筛选</button>
      <div class="table-navigation" role="group" aria-label="横向滚动表格"><button class="btn btn-ghost" id="pan-left" aria-label="向左滚动表格">‹</button><button class="btn btn-ghost" id="pan-right" aria-label="向右滚动表格">›</button></div>
      <div id="field-filter-summary" role="status" hidden></div>
      <span class="sheet-count" id="result-count" aria-live="polite"></span>
    </section>
    <div class="sheet-content">
      <section class="sheet-table-area" aria-label="记录列表">
        <div id="sheet-hero" class="sheet-hero" hidden>
          <strong>创建你的第一张业务台账</strong>
          <p>选择所属应用，配置字段后即可录入；字段可新增、配置或弃用，已有数据不直接删列。也可以核对 Excel 表头并映射导入。自由编辑文件请进入文件中心。</p>
          <div class="sheet-hero-actions"><button class="btn btn-pri" id="hero-quick">快速创建业务台账</button><button class="btn btn-ghost" id="hero-create">自定义字段建表</button></div>
        </div>
        <div class="sheet-table-card">
          <div class="editbar" id="editbar" hidden>
            <div><b id="edit-summary">尚未修改字段 · 双击单元格开始编辑</b><span id="edit-result" role="status"></span></div>
            <div class="editbar-actions">
              <button class="btn btn-ghost" id="compare-conflicts" hidden>核对最新值</button>
              <button class="btn btn-ghost" id="undo" disabled>撤销</button>
              <button class="btn btn-ghost" id="redo" disabled>重做</button>
              <button class="btn btn-pri" id="save-edits" disabled>保存修改</button>
              <button class="btn btn-ghost" id="discard-edits" disabled>放弃修改</button>
            </div>
          </div>
          <div class="sheet-table-scroll">
            <table class="sheet-table"><caption class="sheet-caption" id="sheet-caption"></caption><thead><tr id="sheet-head"></tr></thead><tbody id="sheet-rows"></tbody></table>
          </div>
          <div class="sheet-pager" hidden><button class="btn btn-ghost" id="sheet-prev">上一页</button><span id="sheet-page-info"></span><button class="btn btn-ghost" id="sheet-next">下一页</button></div>
        </div>
      </section>
      <aside id="row-detail" class="sheet-detail" aria-label="记录详情" hidden></aside>
    </div>
    <footer class="preview-footer" ${scoped?'hidden':''}><span class="preview-dot"></span>建设中：对象持久化、权限与并发冲突处理未接入。交互样例仅当前页面有效，不是企业数据。</footer>`;
  const ui = window.createToolWorkspace(host, {signal});
  const {$, escape, notify} = ui;
  const dispose = () => ui.dispose();
  /* —— 页头那个徽标（`.preview-label`）＝**这一页的加载态**。
   *   契约 `loading-state-v1.json`：**加载态不许有看得见的文字** ⇒ 取数期间摆**一条会呼吸的灰条**
   *   （宽高照最终那几个字那一档 ⇒ 数据到了不跳版）；读到了／读失败了／确实没有 ⇒ 换回**人话**。
   *   ⚠️ 读屏的信号用 `aria-busy`（不写字）。 */
  const setLabel = text => {const el=$('.preview-label');if(!el)return;el.removeAttribute('aria-busy');el.textContent=text;};
  const setLabelSkeleton = () => {const el=$('.preview-label');if(!el)return;
    el.innerHTML='<span class="platform-skeleton-bar platform-skeleton-desc" data-skeleton="sheet-status"></span>';
    el.setAttribute('aria-busy','true');};
  const uid = () => (crypto.randomUUID?.() || `r-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const formatTime=value=>{if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('sv-SE',{hour12:false});};

  /* 列定义：类型可见（数据-02）；筛选与排序白名单（数据-04 整行一起移动）。 */
  let COLUMNS = showExamples ? [
    {key: 'case_no', label: '案号', type: 'text', width: '13%'},
    {key: 'title', label: '案件名称', type: 'text', width: '24%'},
    {key: 'customer', label: '客户', type: 'text', width: '14%'},
    {key: 'applicants', label: '申请人', type: 'multi', width: '18%'},
    {key: 'status', label: '当前状态', type: 'select', width: '9%', options: ['待递交', '已递交', '已受理', '审查中', '待补正', '已授权']},
    {key: 'application_date', label: '申请日', type: 'date', width: '10%'},
    {key: 'note', label: '备注', type: 'text', width: '12%'},
  ] : [];
  const STATUS_TONE = {'待递交': 'tone-amber', '待补正': 'tone-red', '已授权': 'tone-green', '审查中': 'tone-blue'};

  const samples = [
    {case_no: 'IP-2026-0245', title: '挡雨板连接结构', customer: '苏州某某科技有限公司', applicants: '王某；李某', status: '审查中', application_date: '2025-03-14', note: '第一次审查意见答复中'},
    {case_no: 'IP-2026-0244', title: '一种折叠支架', customer: '南京某某智造股份有限公司', applicants: '陈某', status: '待补正', application_date: '2025-03-10', note: '补正期限 10-06'},
    {case_no: 'IP-2026-0231', title: '车载无线充电模组', customer: '苏州某某科技有限公司', applicants: '周某；吴某；郑某', status: '已受理', application_date: '2025-01-22', note: ''},
    {case_no: 'IP-2026-0222', title: '智能温控杯', customer: '上海某某贸易有限公司', applicants: '冯某', status: '待递交', application_date: '', note: '等待委托书'},
    {case_no: 'IP-2026-0218', title: '模块化光伏支架系统', customer: '合肥某某新能源有限公司', applicants: '许某；赵某', status: '审查中', application_date: '2025-02-18', note: ''},
    {case_no: 'IP-2026-0211', title: '雾化给药装置', customer: '北京某某医疗器械有限公司', applicants: '钱某；孙某', status: '已授权', application_date: '2024-11-05', note: '年缴截止 10-15'},
    {case_no: 'IP-2026-0208', title: '折叠屏铰链结构', customer: '深圳某某精密制造有限公司', applicants: '李某；王某；张某', status: '已递交', application_date: '2025-02-02', note: ''},
    {case_no: 'IP-2026-0199', title: '仓储分拣机器人导航方法', customer: '杭州某某物流科技有限公司', applicants: '何某', status: '审查中', application_date: '2024-12-30', note: '同族 US 申请并行'},
    {case_no: 'IP-2026-0196', title: '耐高温密封圈材料', customer: '宁波某某橡塑有限公司', applicants: '沈某；韩某', status: '待补正', application_date: '2024-12-19', note: '补正期限 09-28'},
    {case_no: 'IP-2026-0190', title: '儿童安全座椅缓冲结构', customer: '上海某某贸易有限公司', applicants: '杨某', status: '已授权', application_date: '2024-10-11', note: ''},
    {case_no: 'IP-2026-0186', title: '户外储能电源外壳', customer: '苏州某某科技有限公司', applicants: '朱某；秦某', status: '待递交', application_date: '', note: '客户补材料中'},
    {case_no: 'IP-2026-0181', title: '自动开合窗帘轨道', customer: '广州某某家居有限公司', applicants: '刘某', status: '已受理', application_date: '2024-09-26', note: ''},
  ];
  let rows = (showExamples ? samples : []).map((r, i) => ({id: String(i), ...r, deleted: false, fresh: false}));
  /* ⚠️ 开局就是**正在取数**（不是先摆一句「这里还没有记录」）——
     那句话在真页面读回来之前是**假话**（读不到 ≠ 没有记录）。 */
  let realMode=false, object=null, page=1, total=0, loading=!showExamples, saving=false, loadSequence=0, recordDialog=null;
  let designer=null,schemaChooser=null,designLoading=false,lifecycleBusy=false,importDialog=null;
  ui.signal.addEventListener('abort',()=>{designer?.dispose();schemaChooser?.remove();},{once:true});
  let searchTerm='',statusValue='',appliedSearch='',appliedStatus='',searchSequence=0,readError='';
  let fieldFilters={},filterDialog=null;
  let hiddenColumns=new Set(),columnWidths={},viewKey='',resize=null;
  /* 视图两档（对齐 3in）：常用视图按本地列管理；完整台账显示对象全部字段、忽略本地隐藏。
     通用对象没有领域命名视图（示例企业总表/期限表等），故只对齐两档语义，不硬造命名视图。 */
  let viewMode='common';
  const shownColumns=()=>{
    if(viewMode==='ledger')return COLUMNS;
    const list=COLUMNS.filter(c=>!hiddenColumns.has(c.key));
    return list.length?list:COLUMNS.slice(0,1);
  };
  const columnWidth=c=>columnWidths[c.key]||140;
  function restoreColumnView(){
    const user=typeof currentUserInfo==='undefined'?'':currentUserInfo?.username;
    const key=user&&object?.id?'shangshu.sheet.view.'+JSON.stringify([user,object.id]):'';
    if(key!==viewKey){viewKey=key;hiddenColumns=new Set();columnWidths={};
      try{const saved=key&&JSON.parse(localStorage.getItem(key));if(saved?.version===1){hiddenColumns=new Set(Array.isArray(saved.hidden)?saved.hidden:[]);viewMode=saved.mode==='ledger'?'ledger':'common';for(const c of COLUMNS){const width=saved.widths?.[c.key];if(Number.isFinite(width))columnWidths[c.key]=Math.max(88,Math.min(560,Math.round(width)));}}}catch{}
    }
    hiddenColumns=new Set(COLUMNS.filter(c=>hiddenColumns.has(c.key)).map(c=>c.key));
    columnWidths=Object.fromEntries(COLUMNS.filter(c=>columnWidths[c.key]).map(c=>[c.key,columnWidths[c.key]]));
    if(COLUMNS.length&&hiddenColumns.size===COLUMNS.length)hiddenColumns.delete(COLUMNS[0].key);
  }
  function persistColumnView(){if(viewKey)try{localStorage.setItem(viewKey,JSON.stringify({version:1,hidden:[...hiddenColumns],widths:columnWidths,mode:viewMode}));}catch{notify('浏览器不允许保存视图；当前页仍可使用。');}}
  /* 切换常用视图 ↔ 完整台账；完整台账忽略本地隐藏列，列管理需在常用视图下进行。 */
  function applyViewMode(mode){
    if(mode===viewMode)return;
    if(unsaved()){notify('有未保存修改：先保存或放弃，再切换视图。');return;}
    viewMode=mode;$('.sheet-settings').open=false;persistColumnView();render();
    notify(mode==='ledger'?'已切到完整台账：显示全部字段（本地隐藏列不生效）。':'已切到常用视图：按你的列管理显示。');
  }
  function applyColumnWidths(){
    const columns=shownColumns(),sum=columns.reduce((n,c)=>n+columnWidth(c),100),table=$('.sheet-table');
    table.style.minWidth=sum+'px';table.style.width=columns.some(c=>columnWidths[c.key])?sum+'px':'100%';
    host.querySelectorAll('[data-resize]').forEach(handle=>{const width=columnWidths[handle.dataset.resize];handle.closest('th').style.width=width?width+'px':'auto';handle.setAttribute('aria-valuenow',String(width||140));});
  }
  function snapshotWidths(){for(const handle of host.querySelectorAll('[data-resize]'))columnWidths[handle.dataset.resize]=Math.max(88,Math.min(560,Math.round(handle.closest('th').getBoundingClientRect().width||140)));}
  function resizeColumn(key,width){columnWidths[key]=Math.max(88,Math.min(560,Math.round(width)));applyColumnWidths();}
  function finishResize(cancel=false){if(!resize)return;if(cancel)columnWidths=resize.before;resize=null;applyColumnWidths();if(!cancel)persistColumnView();}
  window.addEventListener('pointermove',event=>{if(resize)resizeColumn(resize.key,resize.width+event.clientX-resize.x);},{signal:ui.signal});
  window.addEventListener('pointerup',()=>finishResize(),{signal:ui.signal});
  window.addEventListener('pointercancel',()=>finishResize(true),{signal:ui.signal});
  function manageColumns(){
    if(unsaved()||!COLUMNS.length)return;$('.sheet-settings').open=false;
    if(viewMode==='ledger'){notify('完整台账显示全部字段：切回常用视图后再调整列管理。');return;}
    const dialog=ui.modal(`<div class="dlg-head"><h2>列管理</h2><button class="btn btn-ghost" data-close-columns>关闭</button></div><div class="dlg-body" data-column-options><p>勾选要显示的列；拖动表头右边界调宽。仅保存本浏览器中你的当前表视图，不删除字段。</p>${COLUMNS.map(c=>`<label class="column-option"><input type="checkbox" data-column="${escape(c.key)}" ${hiddenColumns.has(c.key)?'':'checked'}>${escape(c.label)}</label>`).join('')}<p class="dlg-error" role="alert"></p><div class="dlg-foot"><button class="btn btn-ghost" data-columns-default>恢复默认列</button><button class="btn btn-pri" data-columns-apply>应用</button></div></div>`,{prefix:'sheet'});
    dialog.querySelector('[data-close-columns]').onclick=()=>ui.closeModal();
    dialog.querySelector('[data-columns-apply]').onclick=()=>{const checked=new Set([...dialog.querySelectorAll('[data-column]:checked')].map(el=>el.dataset.column));if(!checked.size){dialog.querySelector('[role=alert]').textContent='至少保留一列。';return;}hiddenColumns=new Set(COLUMNS.filter(c=>!checked.has(c.key)).map(c=>c.key));persistColumnView();ui.closeModal();render();};
    dialog.querySelector('[data-columns-default]').onclick=()=>{hiddenColumns.clear();columnWidths={};persistColumnView();ui.closeModal();render();};
  }
  const remoteQuery=()=>realMode&&object?.query?.version===1;
  const queryFilters=()=>({...fieldFilters,...(remoteQuery()?{...(statusValue?{status:statusValue}:{}),$search:searchTerm,...(sortKey?{$sort:sortKey,$direction:sortDesc?'desc':'asc'}:{})}:{})});
  function filterFields(){
    if(!remoteQuery()||loading||unsaved()||filterDialog?.isConnected)return;
    const fields=COLUMNS.filter(c=>['text','long_text','integer','decimal','date','boolean','select'].includes(c.type));
    const control=c=>{
      const value=fieldFilters[c.key]??(c.key==='status'?statusValue:'');
      const attr=`data-filter-field="${escape(c.key)}" aria-label="${escape(c.label)}"`;
      if(c.type==='select'||c.type==='boolean'){
        const options=c.type==='boolean'?[[1,'是'],[0,'否']]:(c.options||[]).map(v=>[v,v]);
        return `<select ${attr}><option value="">不限</option>${options.map(([v,label])=>`<option value="${escape(v)}" ${String(value)===String(v)?'selected':''}>${escape(label)}</option>`).join('')}</select>`;
      }
      return `<input ${attr} type="${c.type==='date'?'date':['integer','decimal'].includes(c.type)?'number':'text'}" ${c.type==='integer'?'step="1"':c.type==='decimal'?'step="any"':''} value="${escape(value)}" placeholder="不限">`;
    };
    const dialog=filterDialog=ui.modal(`<div class="dlg-head"><h2>筛选记录</h2><button class="btn btn-ghost" data-filter-cancel>取消</button></div><div class="dlg-body"><p>填写的条件同时满足，按完整值匹配；模糊查找使用表格上方搜索。</p>${fields.map(c=>`<label class="dlg-field"><span>${escape(c.label)}</span>${control(c)}</label>`).join('')}<p class="dlg-error" role="alert" data-filter-error></p></div><div class="dlg-foot"><button class="btn btn-pri" data-filter-apply>应用筛选</button></div>`,{prefix:'sheet'});
    dialog.querySelector('[data-filter-cancel]').onclick=()=>ui.closeModal();
    dialog.querySelector('[data-filter-apply]').onclick=()=>{
      const next={};
      for(const c of fields){
        const input=dialog.querySelector(`[data-filter-field="${c.key}"]`),value=input.value;
        if(!input.checkValidity()){dialog.querySelector('[data-filter-error]').textContent=`请检查「${c.label}」的${c.type==='integer'?'整数':'输入'}格式`;return;}
        if(value!=='')next[c.key]=['integer','decimal','boolean'].includes(c.type)?Number(value):value;
      }
      fieldFilters=next;
      if(COLUMNS.some(c=>c.key==='status'&&c.type==='select')){statusValue=String(next.status??'');delete fieldFilters.status;}
      // 所有条件共用原精确字段筛选；仅确认后查询。
      searchSequence++;page=1;ui.closeModal();closeDetail();loadRecords();
    };
  }
  let exporting=false;
  const downloads=new Set();
  ui.onDispose(()=>{for(const url of downloads)URL.revokeObjectURL(url);downloads.clear();});
  async function exportSheet(){
    if(exporting||loading||!realMode||object?.export?.available!==true||object.export.service!=='platform.object.export'||unsaved())return;
    const target=object.id;exporting=true;render();
    try{
      const data=await request('/api/platform/services/platform.object.export/invoke',{payload:{object_id:target,expected_revision:object.revision,filters:queryFilters()}});
      if(ui.disposed||object?.id!==target)return;
      if(typeof data.content_base64!=='string'||!data.filename?.endsWith('.xlsx')||!Number.isInteger(data.total)||data.total<0||data.mime_type!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')throw Error('导出回执不完整，未下载文件');
      const bytes=Uint8Array.from(atob(data.content_base64),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:data.mime_type}));downloads.add(url);
      const link=document.createElement('a');link.href=url;link.download=data.filename;document.body.append(link);link.click();link.remove();
      ui.later(()=>{URL.revokeObjectURL(url);downloads.delete(url);},1000);
      notify(`已导出 ${data.total} 条正式记录（全部有权列，不限本页）。`);
    }catch(error){if(!ui.disposed)notify('导出失败：'+error.message);}
    finally{exporting=false;if(!ui.disposed)render();}
  }
  const requests=new Map();
  async function request(url, body) {
    const response=await window.fetch(url,{signal:ui.signal,headers:{'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok||data.ok===false)throw Object.assign(Error(data.error||'操作失败'),{status:response.status});
    return data;
  }
  function writable(){return realMode?!!object?.operations?.includes('update'):showExamples;}
  function importable(){return realMode&&object?.import?.version===1&&object.import.available===true&&object.import.service==='platform.object.import_preview'&&object.import.action==='platform.object.import';}
  function openImport(){
    if(showExamples||loading||!importable()||importDialog?.isConnected||unsaved())return;
    const target=object.id,revision=object.revision,capability=object.import;
    let content=null,meta=null,plan=null,checked=null,pending=null,uncertain=false,busy=false,resultPage=1;
    const dialog=importDialog=ui.modal(`<div class="dlg-head"><h2>导入 Excel · ${escape(object.title)}</h2><button class="btn btn-ghost" data-import-close>取消</button></div><div class="dlg-body">
      <p class="import-steps" data-import-step>1 选择文件与工作表</p>
      <section data-import-start><label class="dlg-field">本地 XLSX 文件<input type="file" accept=".xlsx" data-import-file></label><button class="btn btn-ghost" data-import-library>从文件库选择</button><fieldset data-import-reference hidden><div data-import-picker></div><button class="btn btn-ghost" data-import-use-reference disabled>使用选中版本</button></fieldset><p class="history-notice" data-import-source role="status"></p><p class="history-notice">单次最多 ${escape(capability.max_rows)} 行、${escape(Math.floor(capability.max_bytes/1048576))}MB。导入前核对新增和修改，不保存或修改原文件。</p><div class="import-source-fields"><label class="dlg-field">工作表<select data-import-sheet><option value="">请先选择文件</option></select></label><label class="dlg-field">表头行<input type="number" min="1" max="100" value="1" data-import-header></label><button class="btn btn-ghost" data-import-read disabled>读取表头</button></div></section>
      <section data-import-mapping hidden></section><section data-import-result hidden></section><p class="dlg-error" role="alert" data-import-error></p>
      </div><div class="dlg-foot"><button class="btn btn-ghost" data-import-back hidden>上一步</button><button class="btn btn-pri" data-import-check hidden>检查导入</button><button class="btn btn-pri" data-import-confirm hidden>确认导入</button></div>`,{prefix:'sheet'});
    dialog.firstElementChild.classList.add('sheet-import-dialog');
    const get=selector=>dialog.querySelector(selector),alive=()=>!ui.disposed&&dialog.isConnected&&object?.id===target;
    const references=[];let refreshReference=null;
    const error=message=>{get('[data-import-error]').textContent=message;};
    function sync(){
      dialog.querySelectorAll('input,select,[data-import-close],[data-import-back],[data-import-read],[data-import-check]').forEach(control=>control.disabled=busy||!!pending);
      get('[data-import-read]').disabled=busy||!!pending||!content;
      get('[data-import-library]').disabled=busy||!!pending;
      get('[data-import-reference]').disabled=busy||!!pending;
      get('[data-import-use-reference]').disabled=busy||!!pending||references.length!==1;
      get('[data-import-confirm]').disabled=busy||!plan||!!plan.summary?.errors;
      get('[data-import-confirm]').textContent=busy&&pending?'正在导入…':pending?'重试核实原请求':'确认导入';
    }
    async function run(operation){
      if(busy||!alive())return;busy=true;error('');sync();
      try{await operation();}catch(cause){if(alive())error(cause.message||'操作失败，请重试');}
      finally{busy=false;if(alive())sync();}
    }
    function stage(number){
      get('[data-import-start]').hidden=number!==1;get('[data-import-mapping]').hidden=number!==2;get('[data-import-result]').hidden=number!==3;
      get('[data-import-back]').hidden=number===1;get('[data-import-check]').hidden=number!==2;get('[data-import-confirm]').hidden=number!==3;
      get('[data-import-step]').textContent=['1 选择文件与工作表','2 核对列映射与匹配依据','3 核对导入范围'][number-1];
    }
    function mappingView(){
      const options=meta.columns.map(column=>`<option value="${column.index}">${escape(column.letter)} · ${escape(column.label)}</option>`).join('');
      get('[data-import-mapping]').innerHTML=`<div class="import-table-scroll"><table class="import-table"><thead><tr><th>系统字段</th><th>类型</th><th>Excel 来源列</th></tr></thead><tbody>${meta.fields.map(field=>`<tr><td>${escape(field.label)}${field.required?' *':''}</td><td>${escape({text:'文本',long_text:'长文本',integer:'整数',decimal:'数字',date:'日期',boolean:'是/否',choice:'选项'}[field.type]||field.type)}</td><td><select data-import-map="${escape(field.id)}" aria-label="${escape(field.label)}来源列"><option value="">不导入此列</option>${options}</select></td></tr>`).join('')}</tbody></table></div><label class="dlg-field">用哪一列匹配已有记录？<select data-import-match><option value="">请选择匹配依据</option>${meta.fields.filter(field=>['text','integer','date','choice'].includes(field.type)).map(field=>`<option value="${escape(field.id)}">${escape(field.label)}</option>`).join('')}</select></label><p class="history-notice">相同值更新原行，没有匹配则新增；重复或已回收的匹配值会阻止导入。未映射的列保持原值。</p>`;
      for(const field of meta.fields){const candidates=meta.columns.filter(column=>column.label===field.label);if(candidates.length===1&&meta.fields.filter(f=>f.label===field.label).length===1)get(`[data-import-map="${field.id}"]`).value=String(candidates[0].index);}
    }
    function resultView(){
      const summary=plan.summary,items=plan.errors?.length?plan.errors:plan.rows,start=(resultPage-1)*20;
      const blank=value=>value==null?'（空）':String(value);
      get('[data-import-result]').innerHTML=`<p class="import-summary">新增 ${summary.create} 行 · 修改 ${summary.update} 行 · 不变 ${summary.unchanged} 行 · 错误 ${summary.errors} 项</p>${summary.errors?'<p class="dlg-error">请修正全部错误后重试，本次不会部分导入。</p>':''}<div class="import-table-scroll"><table class="import-table"><thead><tr>${summary.errors?'<th>工作表 / 行</th><th>列</th><th>错误与处理</th>':'<th>行 / 操作</th><th>匹配值</th><th>正式值 → 导入值</th>'}</tr></thead><tbody>${items.slice(start,start+20).map(item=>summary.errors?`<tr><td>${escape(item.sheet)} · ${escape(item.row)}</td><td>${escape(item.label||item.coordinate||item.column)}</td><td>${escape(item.message)}</td></tr>`:`<tr><td>${escape(item.row)} · ${escape({create:'新增',update:'修改',unchanged:'不变'}[item.operation]||item.operation)}</td><td>${escape(blank(item.values[checked.match_field]))}</td><td>${item.changes.map(change=>`${escape(change.label)}：${escape(blank(change.before))} → ${escape(blank(change.after))}`).join('<br>')||'无变化'}</td></tr>`).join('')}</tbody></table></div><div class="history-pager"><button class="btn btn-ghost" data-import-prev ${resultPage===1?'disabled':''}>上一页</button><span>第 ${resultPage} / ${Math.max(1,Math.ceil(items.length/20))} 页</span><button class="btn btn-ghost" data-import-next ${start+20>=items.length?'disabled':''}>下一页</button></div>`;
      get('[data-import-prev]').onclick=()=>{if(resultPage>1){resultPage--;resultView();}};
      get('[data-import-next]').onclick=()=>{if(resultPage*20<items.length){resultPage++;resultView();}};
    }
    function safeClose(){if(busy||pending){notify(pending?'导入结果待核实，请重试原请求后再离开。':'正在检查导入，请稍候。');return false;}return true;}
    ui.guardModal(dialog,safeClose);
    get('[data-import-close]').onclick=()=>ui.closeModal();
    function resetSource(){
      content=null;meta=null;plan=null;checked=null;
      get('[data-import-sheet]').innerHTML='<option value="">请先选择文件</option>';
      get('[data-import-source]').textContent='';
    }
    async function readSource(file,name,label){
      if(!file)return;
      if(!name.toLowerCase().endsWith('.xlsx')||!file.size||file.size>capability.max_bytes)throw Error('请选择非空 .xlsx 文件，大小不能超过 '+Math.floor(capability.max_bytes/1048576)+'MB');
      const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败，请重新选择'));reader.readAsDataURL(file);});
      if(!alive())return;
      const candidate={object_id:target,expected_revision:revision,filename:name,content_base64:encoded};
      const data=await request('/api/platform/services/platform.object.import_preview/invoke',{payload:candidate});
      if(!alive())return;if(!Array.isArray(data.sheets)||!data.sheets.length)throw Error('未读取到工作表，请检查文件');
      content=candidate;get('[data-import-sheet]').innerHTML='<option value="">请选择工作表</option>'+data.sheets.map(name=>`<option value="${escape(name)}">${escape(name)}</option>`).join('');
      get('[data-import-source]').textContent=label;
    }
    get('[data-import-file]').onchange=()=>run(async()=>{
      resetSource();references.splice(0);refreshReference?.();get('[data-import-reference]').hidden=true;
      const file=get('[data-import-file]').files?.[0];await readSource(file,file?.name||'',file?.name||'');
    });
    get('[data-import-library]').onclick=()=>{
      if(busy||pending)return;get('[data-import-reference]').hidden=false;
      if(!refreshReference)refreshReference=window.mountFileReferencePicker({ui,node:get('[data-import-picker]'),values:references,max:1,kind:'表格',extensions:['xlsx'],alive,
        /* 表格导入要的是那个 xlsx **原件本身**（要解析它建表），不是表格的当前内容 →
           走版本，不走受管快照。 */
        attachMode:'file',
        onChange:sync,preview:ref=>window.openFileCenterDetail?.({ui,file:{id:ref.lib,name:ref.name},version:ref.version,snapshot:true})});
    };
    get('[data-import-use-reference]').onclick=()=>run(async()=>{
      resetSource();const ref=references[0];if(!ref?.lib||!ref.file)throw Error('请先选择文件及版本');
      if(!ref.name.toLowerCase().endsWith('.xlsx')||ref.size>capability.max_bytes)throw Error('请选择大小符合限制的 XLSX 版本');
      const response=await fetch('/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:ref.lib,file:ref.file}),{signal:ui.signal});
      if(!response.ok)throw Error('所选原件读取失败（'+response.status+'），请检查文件权限或启用状态');
      if(!alive())return;await readSource(await response.blob(),ref.name,ref.name+' · '+ref.tag);
      if(alive()){get('[data-import-file]').value='';get('[data-import-reference]').hidden=true;}
    });
    get('[data-import-read]').onclick=()=>run(async()=>{
      const sheet=get('[data-import-sheet]').value,header=Number(get('[data-import-header]').value);
      if(!content||!sheet||!Number.isInteger(header)||header<1||header>100)throw Error('请选择工作表，表头行填写 1–100 的整数');
      const payload={...content,sheet,header_row:header};
      const data=await request('/api/platform/services/platform.object.import_preview/invoke',{payload});
      if(!alive())return;if(!Array.isArray(data.columns)||!Array.isArray(data.fields))throw Error('列定义回执不完整');
      content=payload;meta=data;mappingView();stage(2);
    });
    get('[data-import-check]').onclick=()=>run(async()=>{
      const mapping=Object.fromEntries([...dialog.querySelectorAll('[data-import-map]')].filter(control=>control.value).map(control=>[control.dataset.importMap,Number(control.value)]));
      const match=get('[data-import-match]').value;if(!mapping[match])throw Error('请明确选择匹配依据，并映射该字段的 Excel 来源列');
      if(new Set(Object.values(mapping)).size!==Object.keys(mapping).length)throw Error('同一来源列不能重复映射，请检查列对应关系');
      const payload={...content,mapping,match_field:match};
      const data=await request('/api/platform/services/platform.object.import_preview/invoke',{payload});
      if(!alive())return;if(!data.summary||!Array.isArray(data.errors)||!Array.isArray(data.rows)||typeof data.preview_hash!=='string')throw Error('导入预检回执不完整');
      checked=payload;plan=data;resultPage=1;resultView();stage(3);
    });
    get('[data-import-back]').onclick=()=>{if(busy||pending)return;error('');if(!get('[data-import-result]').hidden){plan=null;checked=null;stage(2);}else{stage(1);}sync();};
    get('[data-import-confirm]').onclick=()=>run(async()=>{
      if(!plan||plan.summary.errors)return;
      pending=pending||{...checked,preview_hash:plan.preview_hash};sync();
      try{
        const result=await writeRecord('import',pending,result=>{if(!['create','update','unchanged'].every(key=>Number.isInteger(result[key])&&result[key]>=0))throw Error('导入回执不完整');});if(!alive())return;
        pending=null;busy=false;ui.closeModal();page=1;closeDetail();await loadRecords();
        notify(`导入已保存：新增 ${result.create} 行、修改 ${result.update} 行、不变 ${result.unchanged} 行。`);
      }catch(cause){
        if(!uncertain&&cause.status>=400&&cause.status<500&&![408,429].includes(cause.status)){pending=null;throw cause;}
        uncertain=true;
        throw Error('导入结果待核实：'+cause.message+'。请重试原请求，不要重复导入或换文件。');
      }
    });
    sync();
  }
  function recyclable(){return realMode&&object?.lifecycle?.version===1&&object.lifecycle.available===true&&object.operations?.includes('recycle')&&object.operations?.includes('restore');}
  function canEditColumn(col){return (!scoped||editMode)&&writable()&&(!realMode||Object.hasOwn(object.input_schema?.properties||{},col.key))&&!['array','object'].includes(object?.input_schema?.properties?.[col.key]?.type)&&!['reference','detail'].includes(col.type);}
  function unsaved(){if(lifecycleBusy){notify('记录操作正在提交，请等待结果。');return true;}if(editing)commitEdit(false);if(edits.size||saving){notify('有未保存修改：先保存或放弃，再切换。');return true;}return false;}
  async function loadRecords() {
    const sequence=++loadSequence;loading=true;readError='';rows=[];render();
    try{
      const filters=queryFilters();
      const params=new URLSearchParams({page:String(page),page_length:'30',filters:JSON.stringify(filters)});
      const data=await request('/api/platform/objects/'+encodeURIComponent(object.id)+'/records?'+params);
      if(ui.disposed||sequence!==loadSequence)return;
      if(scoped&&data.object?.id!==objectId)throw Error('返回的数据表与当前应用不符，请重新打开');
      object=data.object;total=data.total;rows=data.rows.map(row=>({...row,id:row.name,deleted:false}));
      if(recordSchema){
        // 展示沿现有公共动作 schema；只收窄对象已声明列，不增加写权限。
        const properties=Object.fromEntries(Object.entries(recordSchema.properties||{}).filter(([key])=>Object.hasOwn(object.input_schema?.properties||{},key)));
        object={...object,input_schema:{...object.input_schema,properties,required:(object.input_schema?.required||[]).filter(key=>Object.hasOwn(properties,key))}};
      }
      if(scoped)$('h1').textContent=object.title||object.name||'数据表';
      appliedSearch=searchTerm;appliedStatus=statusValue;
      if(page>Math.max(1,Math.ceil(total/30))){page=Math.max(1,Math.ceil(total/30));await loadRecords();return;}
      COLUMNS=object.fields.map(field=>({...field,label:recordSchema?.displayProperties?.[field.id]?.title||field.label,key:field.id,type:field.type==='choice'?'select':field.type,width:'auto'}));
      restoreColumnView();
      const status=COLUMNS.find(c=>c.key==='status'&&c.type==='select');
      $('#status-filter').hidden=!status;$('#status-filter').innerHTML='<option value="">全部状态</option>'+(status?.options||[]).map(v=>`<option>${escape(v)}</option>`).join('');
      $('#status-filter').value=statusValue;
      $('#search').placeholder=remoteQuery()?'搜索全表文本或选项':'筛选当前页记录';
      $('#search').maxLength=object.query?.search_max_length||200;
      $('#add-row').disabled=!object.operations.includes('create');$('#add-row').textContent='新增记录';
      $('#edit-mode').disabled=!writable();
      setLabel('已连接数据');
      $('.preview-footer').textContent='数据保存在企业数据库中；每个人的修改都有记录，可随时查看历史。';
    }catch(error){if(!ui.disposed&&sequence===loadSequence){readError='读取失败：'+error.message;rows=[];notify(readError);setLabel('读取失败');$('#add-row').disabled=true;}}
    finally{if(!ui.disposed&&sequence===loadSequence){loading=false;render();}}
  }
  async function connect(preferredId){
    try{
      /* ⚠️ **走公共壳的「清单口」**（同一轮里只读一次）——
     壳的那个口不在（判据假世界）⇒ 照旧自己读。 */
    const catalog=window.shangshuPlatformCatalog;
    const data=catalog?await catalog.objects():await request('/api/platform/objects');if(ui.disposed)return;
      const models=(data.list||[]).filter(item=>(item.source==='managed'||item.source==='native')&&(!scoped||item.id===objectId));
      realMode=true;COLUMNS=[];
      $('#status-filter').hidden=true;$('#add-row').textContent='新增记录';
      $('#sheet-select').hidden=scoped;$('#sheet-select').innerHTML=models.map(item=>`<option value="${escape(item.id)}">${escape(item.title||item.name)}</option>`).join('');
      $('#examples-toggle').hidden=true;$('#search').placeholder='筛选当前页记录';$('.sheet-pager').hidden=false;
      $('.sheet-tabs').hidden=true; // 真实链对齐 3in：回收站在顶部弹层，不再多一层范围导航。
      if(scoped&&!models.length)throw Error('当前数据表不存在或不可访问，请返回应用重新选择');
      if(!models.length){object=null;rows=[];total=0;$('#configure-sheet').disabled=true;setLabel('尚无数据表');$('.preview-footer').textContent=canDesign?'点击“新建表”，配置字段后即可录入，不需要先上传 Excel。':'暂无可访问的数据表，请联系管理员发布应用并配置数据权限。';
        // ⚠️ **加载态要在这里收掉**（2026-10-30 · PKG-133）：`loading` 只在 `loadRecords()` 的
        //   finally 里复位 ⇒ **空目录这条路不走 loadRecords**（它在 connect 里直接 render）
        //   ⇒ `loading` 永远为 true ⇒ `heroVisible` 要求 `!loading`
        //   ⇒ 「创建你的第一张业务台账」那个引导**永远不出现**（人只看到一直转圈）。
        loading=false;render();return;}
      const user=typeof currentUserInfo==='undefined'?'':currentUserInfo?.username;
      const selectionKey=!scoped&&user?'shangshu.sheet.last.'+user:'';
      if(!preferredId&&selectionKey)try{preferredId=localStorage.getItem(selectionKey);}catch{}
      const remember=()=>{if(selectionKey)try{localStorage.setItem(selectionKey,object.id);}catch{}};
      object=models.find(item=>item.id===(scoped?objectId:preferredId))||models[0];remember();$('#sheet-select').value=object.id;$('#configure-sheet').disabled=object.source!=='managed';await loadRecords();
      $('#sheet-select').onchange=()=>{if(unsaved()){$('#sheet-select').value=object.id;return;}searchSequence++;object=models.find(item=>item.id===$('#sheet-select').value);remember();page=1;searchTerm='';statusValue='';fieldFilters={};sortKey='';sortDesc=false;$('#search').value='';closeDetail();loadRecords();};
    }catch(error){if(!ui.disposed){if(scoped)realMode=true;readError='数据表读取失败：'+error.message;rows=[];total=0;$('#add-row').disabled=true;$('#edit-mode').disabled=true;setLabel('读取失败');notify(readError);
      // ⚠️ **读失败也要把加载态收掉**（2026-10-30 · PKG-133）：否则表格区一直摆着骨架
      //   ⇒ 人以为还在取数；而且 `loading` 为 true 时那句「这里还没有记录」被骨架盖住
      //   ⇒ **真读失败被说成空表**。收掉加载态 ⇒ 表格区显示「读取失败：…」那句。
      loading=false;render();}}
  }
  /* 快速建表（对齐 3in“打开即台账”的开箱体验）：预置通用台账模板，
     自动挂到「业务台账」应用（没有则创建），跳过选应用；字段仍经设计器确认后生效。
     字段 ID 不能用内核保留字 name/modified，故首列取 title。 */
  const LEDGER_TEMPLATE={schema_version:1,title:'业务台账',kind:'record',
    fields:[
      {id:'title',label:'名称',type:'text',required:true},
      {id:'date',label:'日期',type:'date'},
      {id:'status',label:'状态',type:'choice',options:['待处理','进行中','已完成']},
      {id:'amount',label:'金额',type:'decimal'},
      {id:'note',label:'备注',type:'long_text'},
    ],
    access:{read_roles:['Desk User'],write_roles:['Desk User'],record_scope:'own'}};
  async function quickCreate(){
    if(!canDesign||scoped)return;
    if(showExamples){notify('请先退出交互样例，再创建真实数据表。');return;}
    if(designLoading||designer?.hasOpenDialog()||schemaChooser?.isConnected||unsaved())return;
    if(typeof createModelDesigner!=='function'){notify('字段编辑器未加载，请刷新后重试。');return;}
    designLoading=true;$('.sheet-settings').open=false;
    const active=()=>!ui.disposed&&host.isConnected;
    try{
      const apps=(await request('/api/platform/application-definitions')).list.filter(app=>app.status!=='Disabled');
      if(!active())return;
      let target=apps.find(app=>String(app.draft?.title||'').trim()==='业务台账');
      let key=uid();
      if(!target){target=(await request('/api/platform/application-definitions',{title:'业务台账',idempotency_key:key})).application;}
      const data=await request('/api/platform/application-definitions/'+encodeURIComponent(target.id));
      if(!active())return;
      designer?.dispose();
      designer=createModelDesigner(data.application,async change=>{
        if(!active())return;
        searchSequence++;searchTerm='';statusValue='';sortKey='';page=1;$('#search').value='';
        await connect(change?.object_id||object?.id);
        notify('业务台账已创建；默认只有你能看到自己的记录，发布给同事请在应用配置里调整。');
      },active);
      await designer.edit({definition:JSON.parse(JSON.stringify(LEDGER_TEMPLATE)),revision:0});
    }catch(error){if(active())notify('快速建表未完成：'+error.message);}
    finally{designLoading=false;}
  }
  async function openDesign(editCurrent=false){
    if(!canDesign||scoped)return;
    if(showExamples){notify('请先退出交互样例，再创建或配置真实数据表。');return;}
    if(designLoading||designer?.hasOpenDialog()||schemaChooser?.isConnected||unsaved())return;
    if(typeof createModelDesigner!=='function'||typeof openSchemaForm!=='function'){notify('字段编辑器未加载，请刷新后重试。');return;}
    designLoading=true;
    $('.sheet-settings').open=false;
    const active=()=>!ui.disposed&&host.isConnected;
    const start=async(application,modelId)=>{
      if(!active())return;
      const model=modelId?application.design_context.models.find(item=>item.id===modelId):null;
      if(modelId&&!model)throw Error('当前应用没有该数据表的配置权限。');
      designer?.dispose();
      designer=createModelDesigner(application,async change=>{
        if(!active())return;
        searchSequence++;searchTerm='';statusValue='';sortKey='';page=1;$('#search').value='';
        await connect(change?.object_id||object?.id);
        notify('数据表已刷新；需要 Excel 数据时，请使用“导入 Excel”。本次不会自动发布应用或扩大员工权限。');
      },active);
      if(model)await designer.edit(model);else designer.create();
    };
    try{
      if(editCurrent){const data=await request('/api/platform/application-definitions/'+encodeURIComponent(object.owner));await start(data.application,object.id);return;}
      const data=await request('/api/platform/application-definitions');if(!active())return;
      const apps=data.list.filter(app=>app.status!=='Disabled'),newApp='__new__';let createKey=uid(),createTitle='';
      schemaChooser=openSchemaForm({title:'新建表 · 所属应用',description:'先配置并确认创建业务表，需要数据时再导入 Excel。文件中心的表格文件不会因此变成业务表。默认只允许员工访问本人创建的记录。',
        properties:{application:{type:'string',title:'所属应用',enum:[...apps.map(app=>app.id),newApp],enumNames:[...apps.map(app=>app.draft.title),'新建应用…']},title:{type:'string',title:'新应用名称',minLength:1,maxLength:100}},
        required:['application'],values:{application:apps.some(app=>app.id===object?.owner)?object.owner:apps[0]?.id||newApp},submitLabel:'下一步',
        onSubmit:async value=>{
          let id=value.application;
          if(id===newApp){const title=(value.title||'').trim();if(!title)throw Error('请填写新应用名称。');if(createTitle!==title){createTitle=title;createKey=uid();}
            const made=await request('/api/platform/application-definitions',{title,idempotency_key:createKey});id=made.application.id;}
          if(!active())return;
          const result=await request('/api/platform/application-definitions/'+encodeURIComponent(id));await start(result.application);
        }});
      const control=schemaChooser.querySelector('[name=application]');
      const showTitle=()=>{schemaChooser.querySelector('[data-schema-field=title]').hidden=Number(control.value)!==apps.length;};control.onchange=showTitle;showTitle();
    }catch(error){if(active())notify('数据表配置读取失败：'+error.message);}
    finally{designLoading=false;}
  }
  async function writeRecord(operation,payload,validate){
    const fingerprint=JSON.stringify({operation,payload});
    if(!requests.has(fingerprint))requests.set(fingerprint,uid());
    const response=await request('/api/platform/actions/platform.object.'+operation+'/execute',{payload,confirmed:true,idempotency_key:requests.get(fingerprint)});
    const result=response.result||response;if(validate)validate(result);
    requests.delete(fingerprint);return result;
  }
  /* 编辑状态：基线/脏格/按格子独立撤销栈（对齐旧版 GridEditState 的最小集）。 */
  let view = 'rows', editMode = false, detailId = null, sortKey = '', sortDesc = false, detailWidth = 'normal';
  const edits = new Map();        /* `${rowId}.${field}` → 当前编辑值 */
  const history = new Map();      /* key → [{value}] 撤销栈 */
  const redo = new Map();         /* key → [{value}] 重做栈 */
  const cellKey = (id, field) => JSON.stringify([id,field]);
  const revisions=new Map();
  const conflicts=new Set();
  let conflictDialog=null;
  const base = (row, field) => row[field] ?? '';
  const currentValue = (row, field) => {
    const v = edits.get(cellKey(row.id, field));
    return v === undefined ? base(row, field) : v;
  };
  const isDirty = (row, field) => edits.has(cellKey(row.id, field));

  async function compareConflict(){
    if(saving||conflictDialog?.isConnected)return;
    if(editing)commitEdit(false);
    const row=rows.find(r=>conflicts.has(r.id)&&COLUMNS.some(c=>isDirty(r,c.key)));
    if(!row)return;
    const target=object;
    const dialog=conflictDialog=ui.modal('<div class="dlg-head"><h2>核对最新值</h2><button class="btn btn-ghost" data-conflict-cancel>取消</button></div><div class="dlg-body"><p>此记录已被其他操作修改。逐项选择要保留的值；应用选择后仍需点击“保存修改”，不会自动覆盖。</p><div class="history-entry" data-conflict-values role="status"><span class="platform-skeleton-bar" style="width:60%;height:11px;margin-bottom:6px"></span><span class="platform-skeleton-bar" style="width:40%;height:11px"></span></div><p class="dlg-error" data-conflict-error role="alert"></p></div><div class="dlg-foot"><button class="btn btn-pri" data-conflict-apply disabled>应用选择</button></div>',{prefix:'sheet'});
    dialog.querySelector('[data-conflict-cancel]').onclick=()=>ui.closeModal();
    dialog.querySelector('.sheet-dialog').classList.add('record-history-dialog');
    const panel=dialog.querySelector('[data-conflict-values]'),apply=dialog.querySelector('[data-conflict-apply]');
    try{
      const data=await request('/api/platform/objects/'+encodeURIComponent(target.id)+'/records/'+encodeURIComponent(row.id));
      if(ui.disposed||!dialog.isConnected)return;
      const latest=data.record,definition=data.object;
      if(definition?.id!==target.id||definition.revision!==target.revision||!definition.operations?.includes('update'))throw Error('字段定义或编辑权限已变化，请保留输入后重新打开数据表。');
      if(latest?.name!==row.id||!latest.modified)throw Error('最新记录回执不完整');
      const fields=COLUMNS.filter(c=>isDirty(row,c.key));
      if(fields.some(c=>!definition.fields.some(f=>f.id===c.key)||!Object.hasOwn(definition.input_schema?.properties||{},c.key)))throw Error('字段权限已变化，请保留输入后重新打开数据表。');
      const display=value=>value===null||value===undefined||value===''?'（空）':String(value);
      panel.innerHTML='<table><thead><tr><th>字段</th><th>服务器最新值</th><th>你的修改</th><th>保留哪个值</th></tr></thead><tbody>'+fields.map(c=>`<tr><th>${escape(c.label)}</th><td>${escape(display(latest[c.key]))}</td><td>${escape(display(currentValue(row,c.key)))}</td><td><select data-conflict-choice="${escape(c.key)}" aria-label="${escape(c.label)}保留哪个值"><option value="">请选择</option><option value="latest">服务器最新值</option><option value="mine">我的修改</option></select></td></tr>`).join('')+'</tbody></table>';
      apply.disabled=false;
      apply.onclick=()=>{
        const choices=fields.map(c=>[c,dialog.querySelector(`[data-conflict-choice="${c.key}"]`).value]);
        if(choices.some(([,choice])=>!['mine','latest'].includes(choice))){dialog.querySelector('[data-conflict-error]').textContent='请为每个字段选择要保留的值。';return;}
        // 仅在明确确认后更新本地基线，不提交，也不跳过下一次版本检查。
        for(const c of COLUMNS){if(definition.fields.some(f=>f.id===c.key))row[c.key]=latest[c.key];else delete row[c.key];}
        row.modified=latest.modified;row._display=latest._display;
        for(const [c,choice] of choices){const key=cellKey(row.id,c.key);if(choice==='latest'||String(edits.get(key)??'')===String(latest[c.key]??''))edits.delete(key);history.delete(key);redo.delete(key);}
        conflicts.delete(row.id);ui.closeModal();render();$('#edit-result').textContent='已核对最新值；保留的修改尚未保存。';notify(edits.size?'已应用选择；保留的修改尚未保存。':'已采用服务器最新值。');
      };
    }catch(error){if(!ui.disposed&&dialog.isConnected)panel.textContent='无法核对：'+error.message+'。你的修改仍保留。';}
  }

  function visibleRows() {
    if(remoteQuery())return rows;
    const term = $('#search').value.trim().toLowerCase(), st = $('#status-filter').value;
    return rows
      .filter(r => (view === 'trash' ? r.deleted : !r.deleted))
      .filter(r => !st || currentValue(r, 'status') === st)
      .filter(r => !term || COLUMNS.map(c => currentValue(r, c.key)).join(' ').toLowerCase().includes(term))
      .sort((a, b) => {
        if (!sortKey) return 0;
        const av = currentValue(a, sortKey), bv = currentValue(b, sortKey);
        return (av === bv ? 0 : av > bv ? 1 : -1) * (sortDesc ? -1 : 1) || 0;
      });
  }

  function renderHead() {
    $('#filter-fields').hidden=!remoteQuery();
    $('#filter-fields').disabled=loading;
    $('#refresh-sheet').disabled=!realMode||!object||loading;
    $('#quick-sheet').hidden=scoped||!canDesign||!realMode;
  }
  /* 活动筛选 chips（对齐 3in 筛选栏）：字段：值 ×，逐个可移除并立即重查。 */
  function renderFilterChips(){
    const box=$('#field-filter-summary');
    if(!box)return;
    const entries=[...Object.entries(fieldFilters)];
    if(statusValue&&COLUMNS.some(c=>c.key==='status'))entries.push(['status',statusValue]);
    box.hidden=!entries.length;
    box.innerHTML=entries.map(([key,value])=>{const column=COLUMNS.find(c=>c.key===key);const label=column?.label||key;const text=column?.type==='boolean'?(value?'是':'否'):value;return `<button class="filter-chip" type="button" data-remove-filter="${escape(key)}" aria-label="移除筛选 ${escape(label)}">${escape(label)}：${escape(String(text))} ×</button>`;}).join('');
    box.querySelectorAll('[data-remove-filter]').forEach(chip=>chip.onclick=()=>{
      const key=chip.dataset.removeFilter;
      if(key==='status'){statusValue='';$('#status-filter').value='';}else delete fieldFilters[key];
      if(remoteQuery()){searchSequence++;page=1;loadRecords();}else render();
    });
  }
  function renderHeadTail(){
    $('#add-row').hidden=realMode&&(!object||!object.operations?.includes('create'));
    $('#view-mode').textContent=viewMode==='ledger'?'切换常用视图':'切换完整台账';
    $('#view-mode').hidden=!realMode||!COLUMNS.length;
    $('#new-sheet').hidden=scoped||!canDesign;$('#configure-sheet').hidden=scoped||!canDesign||object?.source==='native';
    $('#examples-toggle').hidden=scoped||!canDesign||realMode;
    $('#export-sheet').hidden=showExamples||object?.export?.available!==true;
    $('#import-sheet').disabled=loading||!importable();$('#import-sheet').hidden=showExamples||!importable();
    $('#import-sheet').title=importable()?'导入当前表，先核对新增/修改范围':'当前账号、内核或字段类型尚未开放导入';
    $('#export-sheet').disabled=exporting||loading||!realMode||object?.export?.available!==true||object.export.service!=='platform.object.export';
    $('#export-sheet').textContent=exporting?'正在导出…':'导出筛选结果';
    $('#export-sheet').title=object?.export?.available?'导出当前筛选的全部正式记录与有权列（含视图隐藏列）':'当前内核或账号尚未开放 XLSX 导出，或此表包含不支持的明细列';
    $('#sheet-head').innerHTML = shownColumns().map(c => `<th scope="col" aria-sort="${sortKey===c.key?(sortDesc?'descending':'ascending'):'none'}"><button class="col-sort" data-sort="${c.key}" ${remoteQuery()&&!object.query.sort_fields.includes(c.key)?'disabled title="此列不支持排序"':''} aria-label="${realMode&&!remoteQuery()?'当前页':''}按${escape(c.label)}排序">${escape(c.label)}${sortKey === c.key ? (sortDesc ? ' ↓' : ' ↑') : ' ↕'}</button><span class="col-type">${escape({long_text:'长文本',multi:'多值',select:'选项',date:'日期',integer:'整数',decimal:'数值',boolean:'是/否',reference:'关联',detail:'明细'}[c.type]||'文本')}</span><span class="column-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整${escape(c.label)}列宽" aria-valuemin="88" aria-valuemax="560" data-resize="${c.key}" title="拖动调宽，双击复位；方向键微调"></span></th>`).join('') + '<th scope="col" style="width:100px">操作</th>';
    /* —— **骨架（正在取数）**：列是**记录回执里带的** ⇒ 这时列数还不知道
       ⇒ 表头只画**一条整行灰带**（画成一格一格就是**假结构**）；列到了再换回真表头。 */
    if(loading&&!COLUMNS.length)$('#sheet-head').innerHTML='<th scope="col" colspan="99"><span class="platform-skeleton-bar" style="display:inline-block;width:38%;height:8px"></span></th>';
    applyColumnWidths();
    host.querySelectorAll('[data-resize]').forEach(handle=>{
      handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();if(unsaved())return;const before={...columnWidths};snapshotWidths();resize={key:handle.dataset.resize,x:event.clientX,width:columnWidths[handle.dataset.resize],before};};
      handle.ondblclick=()=>{if(unsaved())return;delete columnWidths[handle.dataset.resize];applyColumnWidths();persistColumnView();};
      handle.onkeydown=event=>{if(event.key==='Escape'){finishResize(true);return;}if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();if(unsaved())return;const key=handle.dataset.resize;snapshotWidths();resizeColumn(key,event.key==='Home'?88:event.key==='End'?560:columnWidths[key]+(event.key==='ArrowLeft'?-20:20));persistColumnView();};
    });
    host.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
      if(realMode&&unsaved())return;
      const key = b.dataset.sort;
      if (sortKey === key) { if (sortDesc) { sortKey = ''; sortDesc = false; } else sortDesc = true; }
      else { sortKey = key; sortDesc = false; }
      if(remoteQuery()){searchSequence++;page=1;closeDetail();loadRecords();}else render();
    });
  }

  function cellHtml(row, col) {
    const value = currentValue(row, col.key);
    const dirty = isDirty(row, col.key);
    if(recordSchema?.displayProperties?.[col.key]||recordSchema?.properties?.[col.key])return `<span class="cell-text ${dirty?'is-dirty':''}">${escape(displayValue(row,col))||'—'}</span>`;
    if(col.type==='detail')return `<span>${Array.isArray(value)?value.length:0} 行明细</span>`;
    if(col.type==='boolean')return `<span class="cell-text ${dirty?'is-dirty':''}">${value?'是':'否'}</span>`;
    if(col.type==='reference')return `<span>${escape(row._display?.[col.key]||value)||'—'}</span>`;
    if (col.key === 'status') {
      const tone = STATUS_TONE[value] || '';
      return `<span class="status-pill ${tone} ${dirty ? 'is-dirty' : ''}" ${dirty ? `title="未保存：${escape(value)}"` : ''}>${escape(value) || '—'}</span>`;
    }
    if (col.key === 'applicants') {
      const items = String(value || '').split(/；|;/).map(s => s.trim()).filter(Boolean);
      const html = items.map(p => `<span class="multi-chip ${dirty ? 'is-dirty' : ''}">${escape(p)}</span>`).join('');
      return `<span class="multi-cell" ${dirty ? `title="未保存：${escape(value)}"` : ''}>${html || '—'}</span>`;
    }
    return `<span class="cell-text ${dirty ? 'is-dirty' : ''}" ${dirty ? `title="未保存：${escape(value)}"` : ''}>${escape(value) || (col.type === 'date' ? '—' : '')}</span>`;
  }
  function displayValue(row,col){
    const value=currentValue(row,col.key),spec=recordSchema?.displayProperties?.[col.key]||recordSchema?.properties?.[col.key];
    if(col.type==='boolean'||spec?.type==='boolean')return value?'是':'否';
    if(spec?.type==='array'){
      let items=value;try{if(typeof items==='string')items=JSON.parse(items);}catch{}
      if(Array.isArray(items))return items.map(item=>typeof item==='object'&&item!==null?(item.value??JSON.stringify(item)):String(item??'')).join('；');
    }
    const index=spec?.enum?.indexOf(value);if(index>=0&&spec.enumNames?.[index]!==undefined)return spec.enumNames[index];
    const option=spec?.suggestions?.find(item=>item.id===value);if(option)return option.label;
    return typeof value==='boolean'?(value?'是':'否'):(!isDirty(row,col.key)?row._display?.[col.key]:undefined)??value;
  }

  function render() {
    renderHead();
    renderHeadTail();
    /* 空目录管理员直开引导（对齐 3in 开箱即台账）；有表后收起。 */
    const heroVisible=!scoped&&realMode&&!object&&!loading&&!readError&&canDesign;
    $('#sheet-hero').hidden=!heroVisible;
    $('.sheet-table-scroll').hidden=heroVisible;
    $('.sheet-pager').hidden=heroVisible||!realMode;
    $('#sheet-caption').textContent=loading?'':heroVisible||scoped?'':realMode?(viewMode==='ledger'?(object?.title?object.title+' · 完整台账视图':'完整台账视图'):(object?.title||'')):'示例台账 · 示例企业总表样式';
    $('#sheet-caption').hidden=scoped;
    renderFilterChips();
    $('#recycle-sheet').hidden=showExamples;
    $('#recycle-sheet').disabled=loading||!recyclable();
    $('#recycle-sheet').title=recyclable()?'查看并恢复已回收记录':'当前账号无回收权限，或数据表尚未升级';
    const list = visibleRows();
    if(realMode){$('#sheet-page-info').textContent=`第 ${page} 页 · 共 ${total} 条`;$('#sheet-prev').disabled=loading||!!readError||page===1;$('#sheet-next').disabled=loading||!!readError||page*30>=total;}
    $('#rows-count').textContent = realMode?'':rows.filter(r => !r.deleted).length ? ' ' + rows.filter(r => !r.deleted).length : '';
    $('#result-count').textContent = loading?'正在查询…':remoteQuery()?`共 ${total} 条 · 本页 ${list.length} 条`:`${list.length} 条记录`;
    host.querySelectorAll('[data-view]').forEach(b => b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
    $('#sheet-rows').innerHTML = list.map(row => `<tr data-row="${row.id}" class="${detailId === row.id ? 'is-selected' : ''} ${row.fresh ? 'is-fresh' : ''}">
      ${shownColumns().map(c => `<td data-field="${c.key}" data-editable="${canEditColumn(c) && view === 'rows' && !row.deleted ? '1' : ''}">${cellHtml(row, c)}</td>`).join('')}
      <td>${realMode?`<button class="row-link" data-open="${row.id}">详情</button>${writable()?`<button class="row-link" data-form="${row.id}">编辑</button>`:''}`:view === 'trash' ? '<button class="row-link" data-restore="' + row.id + '">恢复</button>' : `<button class="row-link" data-open="${row.id}">详情</button><button class="row-link dim" data-del="${row.id}">删除</button>`}</td></tr>`).join('')
      || `<tr><td colspan="${shownColumns().length + 1}" class="empty"><strong>${$('#search').value || $('#status-filter').value ? '没有匹配的记录' : view === 'trash' ? '行回收站是空的' : showExamples ? '没有记录' : '这里还没有记录'}</strong>${showExamples ? '清除筛选可看全部。' : '对象存储待接入；可点击“查看交互样例”检查页面。'}</td></tr>`;
    host.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { if (!unsaved()) openDetail(b.dataset.open); });
    host.querySelectorAll('[data-form]').forEach(b=>b.onclick=()=>openRealForm(rows.find(row=>row.id===b.dataset.form)));
    // ⚠️ **读失败时，表格区不许说「没有记录」**（2026-10-30 · PKG-133）：
    //   真读失败（403／权限撤销／后端没接上）被说成「这里还没有记录」
    //   ⇒ 人以为表是空的 ⇒ 去看数据、去做别的事 ⇒ **真问题被藏起来**。
    //   ⇒ 这一块单独说一句「读取失败：…」，并说清「未成功读取不代表没有记录」。
    if(readError&&!list.length)$('#sheet-rows').innerHTML=
      `<tr><td colspan="${shownColumns().length + 1}" class="empty"><strong>${escape(readError)}</strong>未成功读取不代表没有记录；可清除筛选重试。</td></tr>`;
    if(loading&&!list.length)$('#sheet-rows').innerHTML=loading
      /* —— **骨架（正在取数）**：**照真表格** —— 真表头留着（列名是真的），
         数据行**空着**（只有细线）⇒ 真格里是字、长度未知，塞灰条就是假的。 */
      ? `<tr data-skeleton-row="1"><td colspan="99"></td></tr>`.repeat(8)
      : `<tr><td colspan="${shownColumns().length+1}" class="empty"><strong>${readError?escape(readError):object?'没有匹配记录':'尚无数据表'}</strong>${readError?'可清除筛选重试；未成功读取不代表没有记录。':object?'可调整筛选'+(object.operations?.includes('create')?'，或新增记录。':'。'):'点击上方“新建表”，无需上传文件。'}</td></tr>`;
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const row = rows.find(r => r.id === b.dataset.del);
      if (editMode && COLUMNS.some(c => isDirty(row, c.key))) { notify('该行有未保存修改：先保存或放弃，再删除。'); return; }
      row.deleted = true;
      if (detailId === row.id) closeDetail();
      render();
      notify('已移入行回收站；删除原始导入文件不会删除已导入记录，两者互不混淆');
    });
    host.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
      rows.find(r => r.id === b.dataset.restore).deleted = false;
      view = 'rows'; render(); notify('已恢复该行，原值与位置保留');
    });
    bindCellEditing();
    updateEditbar();
  }

  /* —— 单元格编辑：双击进入，Enter/失焦提交，Esc 取消；提交只改脏格不改基线 —— */
  let editing = null, activeCell = null, selectionAnchor = null;
  const cellPosition=td=>({row:td.parentElement.dataset.row,field:td.dataset.field});
  const gridCells=()=>[...host.querySelectorAll('#sheet-rows td[data-field]')];
  const findCell=pos=>pos&&gridCells().find(td=>td.parentElement.dataset.row===pos.row&&td.dataset.field===pos.field);
  function selectionBounds(){
    const list=visibleRows(),cols=shownColumns();
    const a=selectionAnchor||activeCell,b=activeCell;if(!a||!b)return null;
    const r=[list.findIndex(row=>row.id===a.row),list.findIndex(row=>row.id===b.row)],c=[cols.findIndex(col=>col.key===a.field),cols.findIndex(col=>col.key===b.field)];
    return [...r,...c].some(n=>n<0)?null:{list,cols,r0:Math.min(...r),r1:Math.max(...r),c0:Math.min(...c),c1:Math.max(...c)};
  }
  function paintSelection(){
    const bounds=selectionBounds();
    gridCells().forEach(td=>{
      const pos=cellPosition(td),active=pos.row===activeCell?.row&&pos.field===activeCell?.field;
      td.classList.toggle('is-active',active);td.tabIndex=active?0:-1;
      const r=bounds?.list.findIndex(row=>row.id===pos.row),c=bounds?.cols.findIndex(col=>col.key===pos.field);
      td.classList.toggle('is-range',!!bounds&&r>=bounds.r0&&r<=bounds.r1&&c>=bounds.c0&&c<=bounds.c1);
    });
    if(!findCell(activeCell)&&gridCells()[0])gridCells()[0].tabIndex=0;
  }
  function selectCell(td,extend=false,focus=true){
    if(!td)return;if(!extend||!selectionAnchor)selectionAnchor=cellPosition(td);
    activeCell=cellPosition(td);paintSelection();if(focus)td.focus();
  }
  function nextCell(td,dr=0,dc=0,wrap=false){
    const list=visibleRows(),cols=shownColumns(),pos=cellPosition(td);
    let r=list.findIndex(row=>row.id===pos.row)+dr,c=cols.findIndex(col=>col.key===pos.field)+dc;
    if(wrap){if(c>=cols.length){c=0;r++;}if(c<0){c=cols.length-1;r--;}}
    return r>=0&&r<list.length&&c>=0&&c<cols.length?findCell({row:list[r].id,field:cols[c].key}):td;
  }
  function clipboardValue(raw,col){
    if(col.type==='select'&&!col.options.includes(raw)){
      const matches=recordSchema?col.options.filter(value=>displayValue({[col.key]:value},col)===raw):[];
      if(matches.length!==1)throw new Error(`${col.label}：请选择已有选项`);
      raw=matches[0];
    }
    if(col.type==='boolean'){if(['true','是','1'].includes(raw))return true;if(['false','否','0'].includes(raw))return false;throw new Error(`${col.label}：请填写是或否`);}
    if(['integer','decimal'].includes(col.type)){
      if(raw==='')return null;
      const n=Number(raw);if(!raw.trim()||!Number.isFinite(n)||(col.type==='integer'&&!Number.isSafeInteger(n)))throw new Error(`${col.label}：数字不合法或超出安全精度`);
      return n;
    }
    if(col.type==='date'){
      if(raw==='')return realMode?null:'';
      if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString().slice(0,10)!==raw)throw new Error(`${col.label}：请使用 YYYY-MM-DD 日期`);
    }
    return raw;
  }
  // Excel 剪贴板 TSV：引号内允许换行、制表符与双引号。不解析或执行公式。
  function parseClipboard(text){
    if(text.length>200000)throw new Error('粘贴内容太大，请分批或使用导入 Excel');
    const result=[],row=[];let value='',quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(ch==='"'&&(quoted||value==='')){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(ch==='\t'||ch==='\n'||ch==='\r')){
        row.push(value);value='';if(ch!=='\t'){result.push(row.splice(0));if(ch==='\r'&&text[i+1]==='\n')i++;}
      }else value+=ch;
    }
    if(quoted)throw new Error('粘贴内容的引号未闭合');
    if(value!==''||row.length||!result.length){row.push(value);result.push(row);}
    if(result.reduce((n,r)=>n+r.length,0)>1000)throw new Error('单次最多粘贴 1000 格，请分批操作');
    if(result.some(r=>r.length!==result[0].length))throw new Error('粘贴内容不是完整矩形，请重新复制');
    return result;
  }
  function stageCell(row,col,value){
    const key=cellKey(row.id,col.key),before=currentValue(row,col.key);
    if(String(value)!==String(before))pushHistory(key,before);
    if(String(value)===String(base(row,col.key)))edits.delete(key);else edits.set(key,value);
    revisions.set(key,(revisions.get(key)||0)+1);
  }
  function bindCellEditing() {
    gridCells().forEach(td => {
      td.title=td.dataset.editable==='1'?'双击或 Enter 编辑 · Tab 换列 · 支持粘贴 Excel 数据':'只读';
      td.ondblclick = () => beginEdit(td);
      td.onclick=e=>{if(!editing)selectCell(td,e.shiftKey);};
      td.onfocus=()=>{if(!editing&&findCell(activeCell)!==td)selectCell(td,false,false);};
      td.onkeydown=e=>{
        if(e.target!==td||editing)return;
        const moves={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
        if(moves[e.key]){e.preventDefault();selectCell(nextCell(td,...moves[e.key]),e.shiftKey);}
        else if(e.key==='Tab'){e.preventDefault();selectCell(nextCell(td,0,e.shiftKey?-1:1,true));}
        else if(e.key==='Enter'||e.key==='F2'){e.preventDefault();beginEdit(td);}
        else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();$('#save-edits').click();}
        else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.isComposing){beginEdit(td);const input=td.querySelector('input.cell-input');if(input){e.preventDefault();input.value=e.key;}}
      };
      td.oncopy=e=>{
        if(editing||e.target!==td||!e.clipboardData)return;
        if(!activeCell)selectCell(td);const b=selectionBounds();if(!b)return;
        const quote=v=>/[\t\r\n"]/.test(v)?'"'+v.replaceAll('"','""')+'"':v;
        const text=b.list.slice(b.r0,b.r1+1).map(row=>b.cols.slice(b.c0,b.c1+1).map(col=>quote(String((recordSchema?displayValue(row,col):currentValue(row,col.key))??''))).join('\t')).join('\n');
        e.preventDefault();e.clipboardData.setData('text/plain',text);
      };
      td.onpaste=e=>{
        if(editing||e.target!==td||!e.clipboardData)return;e.preventDefault();
        try{
          const values=parseClipboard(e.clipboardData.getData('text/plain')),list=visibleRows(),cols=shownColumns(),pos=cellPosition(td);
          const r0=list.findIndex(row=>row.id===pos.row),c0=cols.findIndex(col=>col.key===pos.field);
          if(r0+values.length>list.length||c0+values[0].length>cols.length)throw new Error('粘贴超出当前页或可见列；请缩小范围，不会自动新增记录');
          const pending=values.flatMap((line,r)=>line.map((raw,c)=>{
            const row=list[r0+r],col=cols[c0+c];
            if(view!=='rows'||row.deleted||!canEditColumn(col))throw new Error(`${col.label}为只读或尚未启用表格编辑；未粘贴任何内容`);
            return {row,col,value:clipboardValue(raw,col)};
          }));
          pending.forEach(({row,col,value})=>stageCell(row,col,value));editMode=true;$('#edit-mode').setAttribute('aria-pressed','true');
          activeCell=pos;selectionAnchor=pos;render();selectCell(findCell(pos));notify(`已粘贴 ${pending.length} 格，保存修改后才写入记录`);
        }catch(error){notify(error.message);}
      };
    });
    paintSelection();
  }
  function beginEdit(td) {
    if (editing) {const pos=cellPosition(td);commitEdit(false);td=findCell(pos);}
    if(!td||td.dataset.editable!=='1')return;
    const row = rows.find(r => r.id === td.parentElement.dataset.row);
    const col = COLUMNS.find(c => c.key === td.dataset.field);
    if(!canEditColumn(col))return;
    selectCell(td,false,false);editMode=true;$('#edit-mode').setAttribute('aria-pressed','true');updateEditbar();
    const value = currentValue(row, col.key);
    editing = {td, row, col, before: value};
    td.classList.add('is-editing');
    const input = col.type==='boolean'
      ? Object.assign(document.createElement('select'),{className:'cell-input',innerHTML:`<option value="true" ${value?'selected':''}>是</option><option value="false" ${!value?'selected':''}>否</option>`})
      : col.type === 'select'
      ? Object.assign(document.createElement('select'), {className: 'cell-input'}, {innerHTML: col.options.map(o => `<option value="${escape(o)}" ${o === value ? 'selected' : ''}>${escape(displayValue({[col.key]:o},col))}</option>`).join('')})
      : Object.assign(document.createElement('input'), {className: 'cell-input', type: col.type === 'date' ? 'date' : ['integer','decimal'].includes(col.type)?'number':'text', value});
    td.textContent = '';
    td.append(input);
    input.focus();
    if (input.select) input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter'||e.key==='Tab') { e.preventDefault(); commitEdit(e.key==='Enter'?'down':e.shiftKey?'previous':'next'); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    });
    input.addEventListener('blur', () => { if (editing && editing.td === td) commitEdit(false); });
  }
  function pushHistory(key, value) {
    const stack = history.get(key) || [];
    stack.push({value});
    history.set(key, stack);
    redo.set(key, []);
  }
  function commitEdit(focusNext) {
    if (!editing) return;
    const {td, row, col, before} = editing;
    const input = td.querySelector('.cell-input');
    const raw = input ? input.value : before;
    const value=realMode?(col.type==='boolean'?raw==='true':['integer','decimal'].includes(col.type)?raw===''?null:Number(raw):col.type==='date'&&raw===''?null:raw):raw;
    editing = null;
    const destination=focusNext?cellPosition(nextCell(td,focusNext==='down'?1:0,focusNext==='next'?1:focusNext==='previous'?-1:0,focusNext!=='down')):null;
    stageCell(row,col,value);
    td.classList.remove('is-editing', 'is-active');
    render();
    if (destination) selectCell(findCell(destination));
  }
  function cancelEdit() {
    if (!editing) return;
    const {td} = editing,position=cellPosition(td);
    editing = null;
    td.classList.remove('is-editing');
    render();
    selectCell(findCell(position));
  }

  /* —— 编辑操作条：撤销/重做按格子独立时间线；保存只认提交那一刻的修订 —— */
  function updateEditbar() {
    for(const id of conflicts)if(!COLUMNS.some(c=>edits.has(cellKey(id,c.key))))conflicts.delete(id);
    $('#compare-conflicts').hidden=!conflicts.size;
    $('#compare-conflicts').disabled=saving;
    $('#editbar').hidden = view !== 'rows' || !(edits.size || saving || [...redo.values()].some(s=>s.length));
    if (!editMode) return;
    const n = edits.size;
    $('#edit-summary').textContent = n ? `有 ${n} 处未保存修改` : '尚未修改字段 · 双击单元格开始编辑';
    $('#undo').disabled = ![...history.values()].some(s => s.length);
    $('#redo').disabled = ![...redo.values()].some(s => s.length);
    $('#save-edits').disabled = saving||!n;
    $('#discard-edits').disabled = saving||!n;
    $('#save-edits').textContent=saving?'保存中…':'保存修改';
    $('#edit-mode').textContent = scoped?'退出表格编辑':'退出编辑模式';
  }
  $('#undo').onclick = () => {
    for (const [key, stack] of history) {
      if (!stack.length) continue;
      const prev = stack.pop();
      const [rowId, field] = JSON.parse(key);
      const row = rows.find(r => r.id === rowId);
      redo.get(key)?.push({value: row?currentValue(row,field):edits.get(key)});
      /* 撤销回到基线值等于没有未保存修改。 */
      if (row && String(prev.value) === String(base(row, field))) edits.delete(key);
      else edits.set(key, prev.value);
      revisions.set(key,(revisions.get(key)||0)+1);
    }
    render();
  };
  $('#redo').onclick = () => {
    for (const [key, stack] of redo) {
      if (!stack.length) continue;
      const next = stack.pop();
      const [rowId,field]=JSON.parse(key),row=rows.find(r=>r.id===rowId);
      history.get(key)?.push({value:row?currentValue(row,field):edits.get(key)});
      edits.set(key, next.value);
      revisions.set(key,(revisions.get(key)||0)+1);
    }
    render();
  };
  $('#save-edits').onclick = async () => {
    if(saving)return;
    if(editing)commitEdit(false);
    const n = edits.size;
    if (!n) return;
    /* 空案号等必填校验：确认前不写入（数据-08 精神在保存侧的最小集）。 */
    for (const [key, value] of edits) {
      const [rowId, field] = JSON.parse(key);
      const column=COLUMNS.find(c=>c.key===field);
      if ((realMode?column?.required:field==='case_no') && (value===null||!String(value).trim())) {
        $('#edit-result').textContent = (column?.label||'案号')+'不能为空：请补全后再保存。';
        return;
      }
    }
    if(realMode){
      const grouped=new Map();
      for(const [key,value] of edits){const [id,field]=JSON.parse(key);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push({key,field,value,revision:revisions.get(key)});}
      saving=true;updateEditbar();let succeeded=0;const failed=[];
      try{
        for(const [id,changes] of grouped){
          const row=rows.find(r=>r.id===id);if(!row)continue;
          try{
            const result=await writeRecord('update',{object_id:object.id,expected_revision:object.revision,name:row.id,expected_modified:row.modified,values:Object.fromEntries(changes.map(c=>[c.field,c.value]))});
            if(ui.disposed)return;
            if(editing)commitEdit(false);
            row.modified=result.modified;
            conflicts.delete(row.id);
            // 回执是保存后的权威值（可能含金额等派生字段）；只采纳已声明列。
            // 保存期间的新编辑仍在 edits 中覆盖基线，不被较早的回执清除。
            for(const column of COLUMNS)if(result.record&&Object.hasOwn(result.record,column.key))row[column.key]=result.record[column.key];
            for(const change of changes){if(!result.record||!Object.hasOwn(result.record,change.field))row[change.field]=change.value;if(revisions.get(change.key)===change.revision){edits.delete(change.key);history.delete(change.key);redo.delete(change.key);}}
            succeeded++;
          }catch(error){if(ui.disposed)return;failed.push(error.message);if([400,409,417].includes(error.status)&&/记录已被修改/.test(error.message))conflicts.add(row.id);}
        }
      }finally{saving=false;if(!ui.disposed){render();const message=`已保存 ${succeeded} 条${failed.length?'；'+failed.length+' 条未保存，修改已保留：'+failed.join('；'):''}`;$('#edit-result').textContent=message;notify(message);}}
      return;
    }
    $('#edit-result').textContent = `已核对 ${n} 处修改；示例环境未接后端：未写入正式记录，修改仍保留在页面内。`;
    notify('示例环境：未连接保存服务，本次修改未写入正式记录');
  };
  $('#discard-edits').onclick = () => {
    edits.clear(); history.clear(); redo.clear();conflicts.clear();
    $('#edit-result').textContent = '';
    render();
    notify('已放弃全部未保存修改');
  };
  $('#edit-mode').onclick = () => {
    if(!writable())return;
    if (editMode && unsaved()) return;
    editMode = !editMode;
    $('#edit-mode').setAttribute('aria-pressed', String(editMode));
    $('#edit-mode').textContent = scoped?(editMode?'退出表格编辑':'表格编辑'):(editMode ? '退出编辑模式' : '进入编辑模式');
    if (!editMode) { edits.clear(); history.clear(); redo.clear(); $('#edit-result').textContent = ''; }
    closeDetail();
    render();
  };

  /* —— 详情：浏览模式单击打开；编辑模式不打开（对齐旧版 §5.2）。 —— */
  function recycleRecord(row){
    if(!recyclable()||unsaved())return;
    const target={id:object.id,revision:object.revision};
    const title=COLUMNS.find(c=>c.type==='text');
    const dialog=ui.modal(`<div class="dlg-head"><h2>移入回收站</h2></div><div class="dlg-body"><p>将「${escape(title?base(row,title.key):row.id)}」移入回收站？</p><p>原值和明细会保留，可从表格顶部“回收站”恢复。不会删除原始文件，也不会自动永久清除。</p><p class="dlg-error" data-recycle-error role="alert"></p></div><div class="dlg-foot"><button class="btn btn-ghost" data-recycle-cancel>取消</button><button class="btn btn-pri" data-recycle-confirm>移入回收站</button></div>`,{prefix:'sheet'});
    let busy=false;ui.guardModal(dialog,()=>!busy);
    dialog.querySelector('[data-recycle-cancel]').onclick=()=>ui.closeModal();
    const button=dialog.querySelector('[data-recycle-confirm]');
    button.onclick=async()=>{
      if(busy)return;busy=true;lifecycleBusy=true;button.disabled=true;dialog.querySelector('[data-recycle-error]').textContent='';
      try{
        await writeRecord('recycle',{object_id:target.id,expected_revision:target.revision,name:row.id,expected_modified:row.modified});
        busy=false;lifecycleBusy=false;
        if(ui.disposed||object?.id!==target.id)return;
        ui.closeModal();closeDetail();await loadRecords();notify('已移入回收站，可从顶部恢复。');
      }catch(error){if(!ui.disposed&&dialog.isConnected)dialog.querySelector('[data-recycle-error]').textContent='未完成：'+error.message;}
      finally{busy=false;lifecycleBusy=false;if(dialog.isConnected)button.disabled=false;}
    };
  }
  function openRecycle(){
    if(!recyclable()||unsaved())return;
    const target={id:object.id,revision:object.revision,title:object.title},title=COLUMNS.find(c=>c.type==='text');
    const dialog=ui.modal(`<div class="dlg-head"><h2>回收站 · ${escape(target.title)}</h2><button class="btn btn-ghost" data-trash-close>关闭</button></div><div class="dlg-body" data-record-trash></div>`,{prefix:'sheet'});
    dialog.firstElementChild.classList.add('record-history-dialog');
    let busy=false,sequence=0;const panel=dialog.querySelector('[data-record-trash]');
    ui.guardModal(dialog,()=>!busy);dialog.querySelector('[data-trash-close]').onclick=()=>ui.closeModal();
    const active=()=>!ui.disposed&&dialog.isConnected&&object?.id===target.id;
    async function load(page=1){
      const requestId=++sequence;
      /* —— 骨架（正在取数）：那张四列表还没来 ⇒ 表格骨架（照真表：表头带短条、数据格空）。 */
      panel.innerHTML='<div class="platform-skeleton platform-skeleton-table" data-skeleton="table" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="platform-skeleton-thead platform-skeleton-tr">'+'<span class="platform-skeleton-td"><span class="platform-skeleton-bar"></span></span>'.repeat(4)+'</div>'+'<div class="platform-skeleton-tr">'+'<span class="platform-skeleton-td"></span>'.repeat(4)+'</div>'.repeat(4)+'</div>';
      try{
        const params=new URLSearchParams({page:String(page),page_length:'30',filters:JSON.stringify({$scope:'trash'})});
        const data=await request('/api/platform/objects/'+encodeURIComponent(target.id)+'/records?'+params);
        if(!active()||requestId!==sequence)return;
        if(!Array.isArray(data.rows)||!Number.isInteger(data.total))throw Error('回收站回执不完整');
        if(page>1&&!data.rows.length){await load(page-1);return;}
        panel.innerHTML=`<p class="history-notice">原值和明细保留；当前不自动清除。恢复后回到原表，不新建替代记录。</p><p class="dlg-error" role="alert"></p><div class="recycle-table-scroll"><table class="recycle-table"><thead><tr><th>记录</th><th>回收时间</th><th>回收人</th><th>操作</th></tr></thead><tbody>${data.rows.map((row,i)=>`<tr><td>${escape(title?row[title.key]||row.name:row.name)}</td><td><time datetime="${escape(row._lifecycle?.recycled_at||'')}">${escape(formatTime(row._lifecycle?.recycled_at))}</time></td><td>${escape(row._lifecycle?.recycled_by||'—')}</td><td><button class="btn btn-ghost" data-trash-restore="${i}">恢复</button>${object.history?.version===1?`<button class="row-link" data-trash-history="${i}">历史</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4">回收站为空</td></tr>'}</tbody></table></div><div class="history-pager"><button class="btn btn-ghost" data-trash-prev ${page===1?'disabled':''}>上一页</button><span>第 ${page} 页 · 共 ${data.total} 条</span><button class="btn btn-ghost" data-trash-next ${page*30>=data.total?'disabled':''}>下一页</button><button class="btn btn-ghost" data-trash-refresh>刷新</button></div>`;
        panel.querySelector('[data-trash-prev]').onclick=()=>load(page-1);panel.querySelector('[data-trash-next]').onclick=()=>load(page+1);panel.querySelector('[data-trash-refresh]').onclick=()=>load(page);
        panel.querySelectorAll('[data-trash-history]').forEach(button=>button.onclick=()=>openRecordHistory({...data.rows[Number(button.dataset.trashHistory)],id:data.rows[Number(button.dataset.trashHistory)].name}));
        panel.querySelectorAll('[data-trash-restore]').forEach(button=>button.onclick=async()=>{
          if(busy)return;const row=data.rows[Number(button.dataset.trashRestore)];busy=true;lifecycleBusy=true;
          const buttons=[...panel.querySelectorAll('button')],disabled=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);panel.querySelector('[role=alert]').textContent='';
          try{
            await writeRecord('restore',{object_id:target.id,expected_revision:target.revision,name:row.name,expected_modified:row.modified});
            if(!active())return;
            await loadRecords();await load(page);notify('已恢复到原表。');
          }catch(error){if(active())panel.querySelector('[role=alert]').textContent='恢复未完成：'+error.message;}
          finally{busy=false;lifecycleBusy=false;buttons.forEach((b,i)=>b.disabled=disabled[i]);}
        });
      }catch(error){if(active()&&requestId===sequence){panel.innerHTML=`<p role="alert">读取失败：${escape(error.message)}</p><button class="btn btn-ghost" data-trash-retry>重试</button>`;panel.querySelector('[data-trash-retry]').onclick=()=>load(page);}}
    }
    load();
  }
  function openRecordHistory(row){
    if(unsaved()||object?.history?.version!==1||object.history.service!=='platform.object.history')return;
    const target=object.id;
    const dialog=ui.modal('<div class="dlg-head"><h2>修改历史</h2><button class="btn btn-ghost" data-history-close>关闭</button></div><div class="dlg-body" data-record-history></div>',{prefix:'sheet'});
    dialog.firstElementChild.classList.add('record-history-dialog');
    dialog.querySelector('[data-history-close]').onclick=()=>ui.closeModal();
    const panel=dialog.querySelector('[data-record-history]');
    const display=value=>value===null||value===undefined?'—':typeof value==='boolean'?(value?'是':'否'):Array.isArray(value)?value.map((row,i)=>Array.isArray(row)?`${i+1}. ${row.map(part=>`${part.label}：${display(part.value)}`).join('；')}`:String(row)).join('\n'):String(value);
    const time=formatTime;
    async function load(page=1){
      /* —— 骨架（正在取数）：一条条记录还没来 ⇒ 几条骨架条目（标题 ＋ 两行）。 */
      panel.innerHTML='<div class="platform-skeleton platform-skeleton-list" data-skeleton="history">'
        +'<div class="platform-skeleton-row" style="align-items:flex-start;flex-direction:column;gap:8px;padding:10px 0">'
        +'<span class="platform-skeleton-bar" style="width:38%"></span><span class="platform-skeleton-bar" style="width:72%"></span></div>'.repeat(3)
        +'</div>';
      try{
        const data=await request('/api/platform/services/platform.object.history/invoke',{payload:{object_id:target,name:row.id,page,page_length:20}});
        if(ui.disposed||!dialog.isConnected)return;
        if(!Array.isArray(data.items)||!Number.isInteger(data.total))throw Error('历史回执不完整');
        panel.innerHTML=`<p class="history-notice">${escape(data.notice||'仅展示已保存的正式字段变更。')}</p>${data.items.map(item=>`<article class="history-entry"><header><strong>${escape(item.actor)}</strong><span>${item.source==='import'?'Excel 导入 · ':''}${escape({create:'新增',update:'修改',recycle:'移入回收站',restore:'恢复'}[item.operation]||'记录操作')}</span><time datetime="${escape(item.time)}" title="${escape(item.time)}">${escape(time(item.time))}</time></header>${item.changes.length?`<table><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${item.changes.map(change=>`<tr><th>${escape(change.label)}</th><td>${escape(display(change.before))}</td><td>${escape(display(change.after))}</td></tr>`).join('')}</tbody></table>`:'<p>本次没有当前权限内可显示的字段差异。</p>'}</article>`).join('')||'<p>尚无可用的字段修改历史。</p>'}<div class="history-pager"><button class="btn btn-ghost" data-history-prev ${page<=1?'disabled':''}>上一页</button><span>第 ${page} 页 · ${data.total} 次记录操作</span><button class="btn btn-ghost" data-history-next ${page*20>=data.total?'disabled':''}>下一页</button></div>`;
        panel.querySelector('[data-history-prev]').onclick=()=>load(page-1);panel.querySelector('[data-history-next]').onclick=()=>load(page+1);
      }catch(error){if(!ui.disposed&&dialog.isConnected){panel.innerHTML=`<p role="alert">读取失败：${escape(error.message)}</p><button class="btn btn-ghost" data-history-retry>重试</button>`;panel.querySelector('[data-history-retry]').onclick=()=>load(page);}}
    }
    load();
  }
  function closeDetail() { detailId = null; detailWidth='normal'; $('#row-detail').hidden = true; $('.sheet-content').dataset.detailWidth=''; render(); }
  /* 详情宽度两档（对齐 3in 的 data-detail-wide / is-fullpage）：常规 → 宽屏 → 全页。 */
  function cycleDetailWidth(){
    detailWidth = detailWidth==='normal'?'wide':detailWidth==='wide'?'full':'normal';
    applyDetailWidth();
  }
  function applyDetailWidth(){
    const box=$('.sheet-content'),btn=$('#detail-width');
    if(box)box.dataset.detailWidth=detailWidth==='normal'?'':detailWidth;
    if(btn){
      const label={normal:'展开详情',wide:'全页详情',full:'收起详情'}[detailWidth];
      btn.textContent=label;btn.setAttribute('aria-label',label);
      btn.title='切换详情宽度：常规 / 宽屏 / 全页';
    }
  }
  function openDetail(id) {
    const row = rows.find(r => r.id === id);
    if (!row || row.deleted) return;
    if(realMode&&typeof onOpenRecord==='function'){closeDetail();onOpenRecord(object.id,row.id);return;}
    detailId = id;
    const p = $('#row-detail');
    p.hidden = false;
    const field = (label, value, extra = '') => `<div class="detail-field"><dt>${escape(label)}</dt><dd>${escape(value) || '—'}${extra}</dd></div>`;
    const dirtyCount = COLUMNS.filter(c => isDirty(row, c.key)).length;
    if(realMode){
      p.innerHTML=`<div class="detail-head"><span>记录详情</span><span class="detail-head-actions"><button class="btn btn-ghost" id="detail-width" aria-label="展开详情"></button><button class="detail-close" id="close-detail" aria-label="关闭记录详情">×</button></span></div><h2>${escape(object.title)}</h2><dl>${COLUMNS.map(c=>field(c.label,c.type==='detail'?JSON.stringify(base(row,c.key)):row._display?.[c.key]??base(row,c.key))).join('')}</dl><div class="detail-actions">${writable()?'<button class="btn btn-ghost" id="edit-this">编辑记录</button>':''}${object.history?.version===1?'<button class="btn btn-ghost" id="record-history">修改历史</button>':''}${recyclable()?'<button class="btn btn-ghost" id="recycle-this">移入回收站</button>':''}</div>`;
      const fileUrl='index.html?'+new URLSearchParams({related_object:object.id,related_record:row.id})+'#/file-center';
      p.querySelector('.detail-actions').insertAdjacentHTML('beforeend',`<a class="btn btn-ghost" data-record-files href="${escape(fileUrl)}">关联文件</a>`);
      applyDetailWidth();
      $('#detail-width').onclick=cycleDetailWidth;
      $('#close-detail').onclick=closeDetail;if($('#edit-this'))$('#edit-this').onclick=()=>openRealForm(row);if($('#record-history'))$('#record-history').onclick=()=>openRecordHistory(row);if($('#recycle-this'))$('#recycle-this').onclick=()=>recycleRecord(row);render();return;
    }
    p.innerHTML = `<div class="detail-head"><span>记录详情</span><button class="detail-close" id="close-detail" aria-label="关闭记录详情">×</button></div>
      <h2>${escape(currentValue(row, 'case_no'))}</h2>
      ${dirtyCount ? `<p class="detail-dirty">此行有 ${dirtyCount} 处未保存修改，详情显示正式值。</p>` : ''}
      <dl>
        ${field('案件名称', currentValue(row, 'title'))}
        ${field('客户', currentValue(row, 'customer'))}
        ${field('申请人（多值，以；分隔）', currentValue(row, 'applicants'))}
        ${field('当前状态', currentValue(row, 'status'))}
        ${field('申请日', currentValue(row, 'application_date'))}
        ${field('备注', currentValue(row, 'note'))}
      </dl>
      <div class="detail-actions"><button class="btn btn-ghost" id="edit-this">进入编辑模式修改</button></div>`;
    $('#close-detail').onclick = closeDetail;
    $('#edit-this').onclick = () => { if (!editMode) $('#edit-mode').click(); };
    render();
  }

  /* —— 新增行（数据-03）：必填校验，确认前不落表。 —— */
  function openRealForm(record=null){
    if(unsaved())return;
    // 领域摘要不保证含完整明细；沿原记录编辑器读取最新值与授权动作。
    if(record&&typeof onEditRecord==='function'){onEditRecord(object.id,record.id);return;}
    const selectedObject=object;
    const schema=schemaWithLookups(selectedObject.input_schema,selectedObject.reference_fields);
    const values={...record};
    if(recordSchema)for(const [key,spec] of Object.entries(schema.properties||{}))if(spec.type==='array'&&typeof values[key]==='string')try{const parsed=JSON.parse(values[key]);if(Array.isArray(parsed))values[key]=parsed;}catch{}
    const dialog=openSchemaForm({title:(record?'编辑':'新增')+' · '+selectedObject.title,...schema,values,submitLabel:'确认保存',onSubmit:async values=>{
      if(ui.disposed||object.id!==selectedObject.id)throw Error('工作面已切换，请重新打开表单');
      await writeRecord(record?'update':'create',{object_id:selectedObject.id,expected_revision:selectedObject.revision,values,...(record?{name:record.id,expected_modified:record.modified}:{})});
      if(!ui.disposed){await loadRecords();notify('记录已保存');}
    }});
    recordDialog=dialog;
    ui.onDispose(()=>dialog.remove());
  }
  $('#add-row').onclick = () => {
    if(realMode){openRealForm();return;}
    const dlg = openModal(`
      <div class="dlg-head"><span>新增记录</span><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      <div class="dlg-body">
        <label class="dlg-field"><span>案号 *</span><input id="n-case-no" placeholder="IP-2026-XXXX" autocomplete="off"></label>
        <div class="dlg-error" id="n-error" hidden></div>
        <label class="dlg-field"><span>案件名称</span><input id="n-title" autocomplete="off"></label>
        <label class="dlg-field"><span>客户</span><input id="n-customer" autocomplete="off"></label>
        <label class="dlg-field"><span>申请人（多值用；分隔）</span><input id="n-applicants" placeholder="王某；李某" autocomplete="off"></label>
        <label class="dlg-field"><span>当前状态</span><select id="n-status">${COLUMNS.find(c => c.key === 'status').options.map(o => `<option>${escape(o)}</option>`).join('')}</select></label>
        <label class="dlg-field"><span>申请日</span><input id="n-date" type="date"></label>
        <div class="send-warn">示例环境：新增不写入正式记录，仅当前页面有效。</div>
      </div>
      <div class="dlg-foot"><button class="btn btn-ghost" id="dlg-close2">取消</button><button class="btn btn-pri" id="n-ok">加入本页</button></div>`);
    const q = s => dlg.querySelector(s);
    q('#dlg-close').onclick = closeModal; q('#dlg-close2').onclick = closeModal;
    q('#n-ok').onclick = () => {
      const caseNo = q('#n-case-no').value.trim();
      const err = q('#n-error');
      const bad = !caseNo || rows.some(r => !r.deleted && currentValue(r, 'case_no') === caseNo);
      err.hidden = !bad;
      err.textContent = !caseNo ? '案号为必填项。' : '案号已存在：重复匹配依据不唯一时不能新增。';
      if (bad) return;
      rows.unshift({id: uid(), case_no: caseNo, title: q('#n-title').value.trim(), customer: q('#n-customer').value.trim(), applicants: q('#n-applicants').value.trim(), status: q('#n-status').value, application_date: q('#n-date').value, note: '', deleted: false, fresh: true});
      closeModal(); view = 'rows'; render();
      notify('已加入本页（示例：未写入正式记录）；系统生成的编号等只读信息见正式实现');
    };
  };

  /* —— 弹层栈（与邮箱/文件中心同模式）。 —— */
  const closeModal = () => ui.closeModal();
  const closeAllModals = () => ui.closeAllModals();
  const openModal = html => ui.modal(html, {prefix:'sheet'});
  host.addEventListener('keydown', e => { if (e.key === 'Escape' && !ui.modalCount) { if (editing) cancelEdit(); else closeDetail(); } }, {signal:ui.signal});

  for (const s of COLUMNS.find(c => c.key === 'status')?.options || []) $('#status-filter').insertAdjacentHTML('beforeend', `<option>${escape(s)}</option>`);
  $('#status-filter').hidden=!showExamples;
  function changeQuery(debounce=false){
    if(realMode&&unsaved()){$('#search').value=searchTerm;$('#status-filter').value=statusValue;return;}
    searchTerm=$('#search').value;statusValue=$('#status-filter').value;
    const sequence=++searchSequence;closeDetail();
    if(!remoteQuery()){render();return;}
    loadSequence++;
    const apply=()=>{if(sequence!==searchSequence)return;if(unsaved()){searchTerm=appliedSearch;statusValue=appliedStatus;$('#search').value=searchTerm;$('#status-filter').value=statusValue;return;}page=1;loadRecords();};
    if(debounce)ui.later(apply,200);else apply();
  }
  $('#status-filter').onchange = () => changeQuery();
  $('#search').oninput = () => changeQuery(true);
  $('#filter-fields').onclick=filterFields;
  function refreshRecords(changed=false){
    if(!realMode||!object)return;
    if(ui.modalCount||recordDialog?.isConnected||designer?.hasOpenDialog()||schemaChooser?.isConnected||designLoading||unsaved()){
      notify(changed?'数据已更新；请先保存或放弃编辑、关闭弹窗，再点击“刷新”。':'请先保存或放弃编辑、关闭弹窗，再刷新。');return;
    }
    closeDetail();loadRecords();
  }
  $('#refresh-sheet').onclick=()=>refreshRecords();
  window.addEventListener('shangshu:object-changed',event=>{
    if(event.detail?.object_id===object?.id)refreshRecords(true);
  },{signal:ui.signal});
  window.addEventListener('shangshu:before-object-change',event=>{
    if(event.detail?.object_id!==object?.id)return;
    if(recordDialog?.isConnected||conflictDialog?.isConnected||unsaved()){
      event.preventDefault();notify('当前记录有人工编辑：请先保存或放弃，再确认 AI 修改。');
    }
  },{signal:ui.signal});
  $('#compare-conflicts').onclick=compareConflict;
  $('#clear').onclick = () => {if(realMode&&unsaved())return;fieldFilters={};$('#search').value = ''; $('#status-filter').value = '';changeQuery();};
  host.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; closeDetail(); render(); });
  $('#sheet-prev').onclick=()=>{if(!unsaved()){searchSequence++;page--;closeDetail();loadRecords();}};
  $('#sheet-next').onclick=()=>{if(!unsaved()){searchSequence++;page++;closeDetail();loadRecords();}};

  $('#examples-toggle').textContent = showExamples ? '退出交互样例' : '查看交互样例';
  /* 取数期间＝**骨架**（契约 `loading-state-v1.json`）：徽标不写加载文字 ⇒ 一条会呼吸的灰条。 */
  if(showExamples)setLabel('交互样例 · 不保存');else setLabelSkeleton();
  $('#add-row').disabled = !showExamples;
  $('#add-row').textContent = '新增记录';
  $('#edit-mode').disabled = !showExamples;
  $('#edit-mode').hidden=!scoped; // 独立旧工作面仍双击直接编辑；应用内从同一列表显式启用。
  if(scoped)$('#edit-mode').textContent='表格编辑';
  $('#examples-toggle').onclick = () => { ui.toggleExamples(window.mountSheetCenter, !showExamples); };
  $('#new-sheet').onclick=()=>openDesign();$('#configure-sheet').onclick=()=>openDesign(true);
  $('#quick-sheet').onclick=quickCreate;$('#hero-quick').onclick=quickCreate;$('#hero-create').onclick=()=>openDesign();
  const panTable=offset=>{const scroller=$('.sheet-table-scroll');if(!scroller)return;if(typeof scroller.scrollBy==='function')scroller.scrollBy({left:offset});else scroller.scrollLeft+=offset;};
  $('#pan-left').onclick=()=>panTable(-240);
  $('#pan-right').onclick=()=>panTable(240);
  $('#manage-columns').onclick=manageColumns;
  $('#view-mode').onclick=()=>applyViewMode(viewMode==='ledger'?'common':'ledger');
  $('#export-sheet').onclick=exportSheet;
  $('#import-sheet').onclick=()=>openImport();
  $('#recycle-sheet').onclick=openRecycle;
  ui.guardLeave(()=>{
    if(conflictDialog?.isConnected){notify('请先应用或取消冲突核对，再离开。');return false;}
    if(filterDialog?.isConnected){notify('请先应用或取消筛选，再离开。');return false;}
    if(importDialog?.isConnected){notify('请先完成、核实或取消导入，再离开。');return false;}
    if(designLoading||schemaChooser?.isConnected||designer?.hasOpenDialog()){notify('请先完成或关闭数据表配置，再离开。');return false;}
    if(recordDialog?.isConnected){notify('请先保存或关闭记录表单，再离开。');return false;}
    return !unsaved();
  });
  render();
  if(!showExamples)connect();
  return dispose;
};
// 旧书签仍可用，但表格是应用数据的编辑方式，不再另开一套工具。
RENDER['sheets'] = async page => {
  /* —— 骨架（正在取数）：一整块内容还没到 ⇒ 区块形状（不是一行「正在进入应用数据…」）。 */
  page.host.innerHTML='<div class="platform-skeleton platform-skeleton-panel" data-skeleton="panel"><span class="platform-skeleton-panel-title"></span><span class="platform-skeleton-panel-line"></span><span class="platform-skeleton-panel-line short"></span><span class="platform-skeleton-panel-block"></span></div>';
  try{
    const response=await api('/api/platform/applications');const data=await response.json();
    if(page.isActive&&!page.isActive())return;
    if(!response.ok||data.ok===false)throw Error(data.error||'应用读取失败');
    let preferred=sessionStorage.getItem('shangshu.dataset.open');
    if(!preferred)try{preferred=localStorage.getItem('shangshu.sheet.last.'+currentUserInfo?.username);}catch{}
    const apps=data.list||[];
    const app=apps.find(item=>item.datasets?.some(d=>d.object_id===preferred||d.id===preferred))||apps.find(item=>item.source==='managed'&&item.datasets?.length);
    if(!app){go('applications');return;}
    const dataset=app.datasets.find(item=>item.object_id===preferred||item.id===preferred)||app.datasets[0];
    const url=new URL(location.href);url.searchParams.set('application',app.id);url.searchParams.set('dataset',dataset.id);
    history.replaceState(null,'',url);go('objects');
  }catch(error){
    if(page.isActive&&!page.isActive())return;
    page.host.textContent='无法读取应用：'+error.message;
    const retry=document.createElement('button');retry.className='btn btn-ghost';retry.textContent='重试';retry.onclick=()=>RENDER.sheets(page);page.host.append(retry);
  }
};
