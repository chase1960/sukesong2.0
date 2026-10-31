/* 文件中心建设页：复用产品壳，存储未接入时禁止业务上传。 */
window.mountFileCenter = function(host, {signal, examples: showExamples = false} = {}) {
  host.classList.add('file-center-page');
  host.innerHTML = "\n    <header class=\"file-heading page-heading\">\n      \n      <h1>文件中心</h1><span class=\"preview-label\">建设中</span>\n      <button class=\"btn btn-pri\" id=\"upload\" disabled>存储待接入</button>\n      <input id=\"file-picker\" type=\"file\" multiple hidden>\n    <button class=\"btn btn-ghost\" id=\"examples-toggle\">查看交互样例</button></header>\n    <nav class=\"file-tabs\" aria-label=\"文件范围\">\n      <button data-view=\"all\" aria-current=\"page\">全部文件 <span id=\"all-count\"></span></button>\n      <button data-view=\"review\">待审核 <span id=\"review-count\"></span></button>\n      <button data-view=\"mine\">我的上传</button>\n      <button data-view=\"trash\">回收站</button>\n    </nav>\n    <section class=\"file-tools\" aria-label=\"搜索与筛选\">\n      <label class=\"file-search\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\"/><path d=\"m16 16 4 4\"/></svg><input id=\"search\" placeholder=\"搜索文件名或标签\" aria-label=\"搜索文件\"></label>\n      <select id=\"type\" aria-label=\"文件类型\"><option value=\"\">所有类型</option><option>文档</option><option>表格</option><option>图片</option><option>其他</option></select>\n      <select id=\"owner-filter\" data-filter-owner aria-label=\"按所有人筛选\"><option value=\"\">全部所有人</option></select>\n      <select id=\"mail-filter\" data-filter-mail aria-label=\"按关联邮件筛选\"><option value=\"\">所有关联邮件</option></select>\n      <button class=\"btn btn-ghost\" id=\"clear\">清除筛选</button>\n      <span class=\"file-count\" id=\"result-count\" aria-live=\"polite\"></span>\n      <div class=\"file-layouts\" role=\"group\" aria-label=\"显示方式\"><button data-layout=\"list\" aria-pressed=\"true\">列表</button><button data-layout=\"grid\" aria-pressed=\"false\">缩略图</button><button data-layout=\"groups\" aria-pressed=\"false\">分组</button></div>\n    </section>\n    <div class=\"file-selection\"><label><input id=\"select-page\" type=\"checkbox\"> 选择本页</label><span id=\"selection-count\">未选择</span><button id=\"batch-change\" class=\"btn btn-ghost\" disabled>移入回收站</button><select id=\"group-by\" aria-label=\"分组依据\" hidden><option value=\"date\">按月份</option><option value=\"source\">按来源</option><option value=\"tags\">按标签</option></select></div>\n    <div class=\"file-content\">\n      <section class=\"file-table-area\" aria-label=\"文件列表\">\n        <div class=\"file-table-scroll\">\n          <table class=\"file-table\"><thead><tr>\n            <th class=\"name-col\" scope=\"col\">文件名</th><th scope=\"col\">标签</th><th scope=\"col\">来源</th><th scope=\"col\">上传人</th><th scope=\"col\">所有人</th><th scope=\"col\">关联邮件</th>\n            <th scope=\"col\"><button id=\"sort\" aria-label=\"按更新时间排序\">更新时间 ↓</button></th><th class=\"size-col\" scope=\"col\">大小</th><th scope=\"col\">操作</th>\n          </tr></thead><tbody id=\"file-rows\"></tbody></table>\n          <div id=\"alternate-view\" hidden></div>\n          <div id=\"review-area\" hidden></div>\n        </div>\n        <div class=\"file-pagination\"><span id=\"page-info\"></span><select id=\"page-size\" aria-label=\"每页数量\"><option value=\"20\">20 条/页</option><option value=\"50\">50 条/页</option><option value=\"100\">100 条/页</option></select><button id=\"previous-page\" class=\"btn btn-ghost\">上一页</button><button id=\"next-page\" class=\"btn btn-ghost\">下一页</button></div>\n        <div class=\"cr-footer\" id=\"review-footer\" hidden><div><b id=\"review-selected\">已选 0 项</b><span id=\"review-result\" role=\"status\"></span></div><button class=\"btn btn-pri\" id=\"review-confirm\" disabled>确认所选</button></div>\n      </section>\n      <aside id=\"details\" class=\"file-details\" aria-label=\"文件详情\" hidden></aside>\n    </div>\n    <footer class=\"preview-footer\"><span class=\"preview-dot\"></span>建设中：存储、权限与 AI 检索尚未接入。交互样例仅在当前页面有效，不是企业文件。</footer>\n    <div id=\"drop-overlay\" hidden></div>";
  const ui = window.createToolWorkspace(host, {signal});
  const {$, escape, notify} = ui;
  /* 用户 2026-10-21 09:50：标题右边那两个「新建表格」「导入表格」**去掉**了 ——
     建表／导表在「Excel 清单页」里已经有了，文件中心这边再挂一份是重复入口。
     那一并带走的还有那个选 csv/xlsx 的隐藏 input（跟着按钮一起没的）。 */
  if(!showExamples){$('.preview-label').hidden=true;$('#examples-toggle').hidden=true;}
  const route=new URL(location.href);
  let related=route.searchParams.has('related_object')||route.searchParams.has('related_record')?{object_id:route.searchParams.get('related_object')||'',name:route.searchParams.get('related_record')||''}:null;
  $('#clear').insertAdjacentHTML('beforebegin','<button class="btn btn-ghost" id="related-filter" hidden>关联记录</button><span id="related-summary" role="status" hidden></span>');
  function showRelated(ref){
    const field=ref?.object?.fields?.find(f=>f.type==='text')?.id;
    $('#related-summary').hidden=!ref;
    $('#related-summary').textContent=ref?ref.record?`关联：${ref.object.title||ref.object.name} · ${ref.record[field]||ref.name}`:'关联记录：正在核对…':'';
  }
  function setRelated(ref){
    related=ref;showRelated(ref);const url=new URL(location.href);
    for(const [key,value] of [['related_object',ref?.object_id],['related_record',ref?.name]]){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);}
    history.replaceState(null,'',url);
  }
  showRelated(related);
  $('#related-filter').onclick=()=>{
    if(!realMode||batchBusy||pendingBatch)return;
    let picker;
    const modal=ui.modal('<header><h2>按关联记录查文件</h2><button class="btn" data-related-close>关闭</button></header><main data-related-picker></main>',{native:true,className:'file-operation-dialog',onClose:()=>picker?.dispose()});
    modal.querySelector('[data-related-close]').onclick=()=>ui.closeModal();
    picker=window.mountRecordReferencePicker({ui,node:modal.querySelector('[data-related-picker]'),onCancel:()=>ui.closeModal(),onPick:ref=>{setRelated(ref);ui.closeModal();resetResults();}});
  };
  $('[data-view="review"]').insertAdjacentHTML('afterend','<button data-view="reviewed">已处理</button>');
  let editor=null;
  ui.guardLeave(()=>{if(batchBusy||pendingBatch){notify('批量操作尚未核实，请先处理');return false;}return (!editor||editor.canLeave())&&ui.canCloseModals();});
  const directoryBar=document.createElement('div');directoryBar.className='file-directory-tools';directoryBar.hidden=true;
  directoryBar.innerHTML='<label>目录 <select id="directory-filter" aria-label="文件目录"><option value="">所有目录</option></select></label><div class="file-directory-actions" role="group" aria-label="目录管理"><button class="btn" id="directory-create" disabled>新建目录</button><button class="btn" id="directory-rename" disabled>重命名目录</button><button class="btn" id="directory-access" hidden disabled>访问权限</button></div>';
  $('.file-search').insertAdjacentElement('afterend',directoryBar);
  $('.file-selection').append($('#result-count'));
  // 筛选、目录维护和列表显示各有自己的位置；窄工作面按组换行。
  const filterRow=document.createElement('div');filterRow.className='file-filter-row';
  for(const control of [...$('.file-tools').children])if(!control.classList.contains('file-layouts'))filterRow.append(control);
  $('.file-tools').append(filterRow);
  $('.file-selection').insertBefore($('.file-layouts'),$('#result-count'));
  let directories=[],directoryId='',manageDirectories=false,accessOptions=null;
  function directoryOptions(selected){return directories.map(d=>`<option value="${escape(d.name)}" ${d.name===selected?'selected':''}>${escape(d.path)}</option>`).join('');}
  function syncDirectoryControls(){
    $('#directory-filter').innerHTML='<option value="">所有目录</option>'+directoryOptions(directoryId);
    $('#directory-create').disabled=!manageDirectories;$('#directory-rename').disabled=!manageDirectories||!directoryId||directoryId==='files-root';
    $('#directory-create').hidden=!manageDirectories;$('#directory-rename').hidden=!manageDirectories;
    $('#directory-access').hidden=!manageDirectories||!accessOptions;
    $('#directory-access').disabled=!manageDirectories||!accessOptions||!directoryId;
  }
  async function refreshDirectories(){
    const response=await fetch('/api/platform/services/files.directories/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{}})});
    const raw=await response.json(),data=raw.result||raw;
    if(!response.ok||raw.ok===false||!Array.isArray(data.directories))throw Error(raw.error||'目录功能尚未接入');
    if(ui.disposed)return;directories=data.directories;manageDirectories=data.can_manage===true;
    accessOptions=data.access_options?.version===1&&Array.isArray(data.access_options.people)&&Array.isArray(data.access_options.groups)?data.access_options:null;
    if(directoryId&&!directories.some(d=>d.name===directoryId))directoryId='';
    directoryBar.hidden=false;syncDirectoryControls();
  }
  const dispose = () => ui.dispose();
  const fetch = (url, options = {}) => window.fetch(url, {
    ...(['GET','HEAD'].includes(String(options.method||'GET').toUpperCase())?{signal:ui.signal}:{}),
    ...options,
  });
  const examples=[
    ['项目合作协议.pdf','合同','业务上传','林安','2026-09-21 10:42',1258291],
    ['九月采购计划.xlsx','采购','手动上传','我','2026-09-21 09:18',184320],
    ['产品需求讨论纪要.md','产品','手动上传','陈宁','2026-09-20 16:30',4096,'# 产品需求讨论纪要\n\n本周重点\n1. 文件统一收纳，不强制复杂分类。\n2. 搜索与预览放在同一个工作面。\n3. 保持现有业务附件独立可用。\n\n此内容仅用于界面预览。'],
    ['员工入职资料清单.txt','人事','手动上传','我','2026-09-20 14:06',1024,'员工入职资料清单\n\n□ 基本信息登记\n□ 合同签署\n□ 账号开通\n□ 设备领取\n\n此内容仅用于界面预览，不含员工真实资料。'],
    ['办公设备报价单.pdf','采购','邮件附件','林安','2026-09-19 11:26',452608],
    ['品牌标志.png','设计','手动上传','陈宁','2026-09-19 10:12',81920],
    ['九月费用汇总.xlsx','财务','业务上传','我','2026-09-18 17:35',96256],
    ['项目交付材料.zip','交付','手动上传','林安','2026-09-18 15:02',9437184],
  ];
  let files=(showExamples?examples:[]).map((r,i)=>({id:String(i),name:r[0],tags:[r[1]],source:r[2],owner:r[3],date:r[4],size:r[5],text:r[6],sample:true,deleted:false}));
  /* —— 真实链（files 域）：探测可用则接管列表/上传/版本/回收，不可用维持样例模式 —— */
  let realMode=false,connecting=!showExamples,readError='',batchBusy=false,readBusy=false,querySequence=0,remoteTotal=0;
  let queryReads=null,queryReadsReady=null,searchTimer=null,searchComposing=false;
  const readScope=()=>queryReadsReady??=(import('./lib/latest-read.mjs').then(({createLatestRead})=>queryReads=createLatestRead(ui.signal)));
  ui.onDispose(()=>{clearTimeout(searchTimer);queryReads?.dispose();});
  let pendingBatch=null,batchDialog=null,choosingRestore=false;
  window.addEventListener('shangshu:object-changed',event=>{
    if(event.detail?.object_id!=='files.file'||!realMode||batchBusy||pendingBatch)return;
    // 本页编辑器随后必调 onChanged；广播留给其他工作面，避免同一次保存读两遍。
    if(event.detail.source==='file-center'||event.detail.source==='file-editor'&&editor)return;
    if(event.detail.name)void refreshChangedFile({name:event.detail.name});else void refreshCurrentPage();
  },{signal:ui.signal});
  const sizeText=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
  /* BASE967-16/UI-054：「所有人」显示名映射（identity_id / 登录名 / frappe 用户名 → 显示名）。
     **映射源只有一处** —— loadOwnerFilterOptions 已经把人员目录取回来了，这里复用那份数据，
     不再发第二次请求、也不在前端另造一份人员表。
     **为什么三键都映射** —— 服务端 `_owner_subject_aliases()` 用 identity_id/user/collaboration_key
     三键互认（受管收信路径写登录名，schema 声明写员工ID），显示侧跟同一套键才能保证
     「列表显示谁」和「按谁筛得到」是同一个人。 */
  const ownerNameById=new Map();
  function ownerDisplay(subject,kind){
    const raw=String(subject||'').trim();
    if(!raw)return{text:'—',title:''};
    const name=ownerNameById.get(raw);
    if(name)return{text:name,title:raw};
    // 映射不到就显示原始值，并把原始值挂 title：宁可让用户看到真实键去问人，
    // 也不填一个猜的显示名。部门ID没有人员表可映射，走这条路。
    return{text:raw,title:raw};
  }
  /** 「所有人」列的一段渲染：类型标签 + 显示名，title 留原始键值给排查。 */
  const ownerCell=f=>{
    const d=ownerDisplay(f.ownerSubject,f.ownerSubjectKind);if(f.ownerSubjectLabel)d.text=f.ownerSubjectLabel;
    const tag=f.ownerSubjectKind==='Department'?'<span class="file-tag file-tag-dept">部门</span> ':f.ownerSubjectKind==='Employee'?'<span class="file-tag">员工</span> ':'';
    return`${tag}<span title="${escape(d.title)}">${escape(d.text)}</span>`;
  };
  const mapReal=r=>{const ownership=window.fileCenterOwnership(r);return({id:r.name,name:r.file_name,directoryId:r.directory_id,tags:Array.isArray(r.tags)?r.tags.map(String):String(r.tags||'').split('；').filter(Boolean),source:r.directory||'/',owner:r.owner||'',ownerSubjectKind:ownership.kind,ownerSubject:ownership.subject,ownerSubjectLabel:ownership.label,relatedMail:r.related_mail||'',date:String(r.modified||'').replace('T',' ').slice(0,16),modified:r.modified,restoreRelations:r.restore_relations===1,size:Number(r.current_size||0),status:r.status,note:r.note||'',currentFile:r.current_file||'',canEdit:r.can_edit===true,canAssign:r.can_assign===true||r.can_assign===1,real:true,deleted:r.status==='Recycled'});};
  /* fast：提案审阅定位到文件原件时，在这里按编号取回原件并打开（ours 的归属映射照旧）。 */
  window.addEventListener('shangshu:review-target',async event=>{
    if(event.detail?.module!=='file-center'||!event.detail.file||!editor)return;
    try{
      const response=await fetch('/api/platform/objects/files.file/records/'+encodeURIComponent(event.detail.file));
      const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||'无法读取原件');
      if(!ui.disposed)await editor.open(mapReal(data.record));
    }catch(error){if(!ui.disposed)notify('原件未能打开：'+error.message);}
  },{signal:ui.signal});
  async function realRefresh(){
    const sequence=++querySequence,limit=Number($('#page-size').value);
    const filters={scope:view,q:$('#search').value.trim(),kind:$('#type').value,order:descending?'desc':'asc'};
    if(related){filters.related_object=related.object_id;filters.related_record=related.name;}
    if(directoryId)filters.directory_id=directoryId;
    const ownerFilter=($('#owner-filter')||{}).value||'';
    const mailFilter=($('#mail-filter')||{}).value||'';
    if(ownerFilter)filters.owner_subject=ownerFilter;
    if(mailFilter)filters.related_mail=mailFilter;
    const params=new URLSearchParams({page:String(page),page_length:String(limit),filters:JSON.stringify(filters)});
    readBusy=true;readError='';
    try{
      const reads=await readScope();
      if(ui.disposed||sequence!==querySequence)return false;
      const request=reads.begin();
      const r=await fetch('/api/platform/datasets/files.file/records?'+params,{headers:{accept:'application/json'},signal:request.signal});
      const d=await r.json().catch(()=>({}));
      if(ui.disposed||sequence!==querySequence)return false;
      if(!r.ok||d.ok===false)throw Object.assign(new Error(d.error||'读取失败'),{code:d.code,status:r.status});
      if(related){
        const target=related;
        const result=await fetch('/api/platform/objects/'+encodeURIComponent(target.object_id)+'/records/'+encodeURIComponent(target.name),{signal:request.signal});
        const detail=await result.json();
        if(ui.disposed||sequence!==querySequence)return false;
        if(!result.ok||detail.ok===false)throw Error(detail.error||'关联记录已不可访问');
        showRelated({...target,...detail});
      }
      remoteTotal=Number(d.total??(d.rows||[]).length);
      const lastPage=Math.max(1,Math.ceil(remoteTotal/limit));
      if(page>lastPage){page=lastPage;return await realRefresh();}
      files=(d.rows||[]).map(mapReal);return true;
    }catch(error){
      if(ui.disposed||sequence!==querySequence)return false;
      readError=error.message||'读取失败';files=[];throw error;
    }finally{if(sequence===querySequence)readBusy=false;}
  }
  async function realAction(id,payload,key=crypto.randomUUID()){
    const r=await fetch('/api/platform/actions/'+id+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.ok===false)throw Object.assign(new Error(d.error||'办理失败'),{code:d.code,status:r.status});
    return d.result||d;
  }
  const uncertainError=error=>!(error.status>=400&&error.status<500&&![408,429].includes(error.status));
  function openDirectoryEditor(rename=false){
    const current=directories.find(d=>d.name===directoryId),initial=rename?current?.title||'':'';
    if(!manageDirectories||rename&&!current)return;
    const dialog=ui.modal(`<form><header><h2>${rename?'重命名目录':'新建目录'}</h2><button type="button" class="btn" data-cancel aria-label="关闭">×</button></header><main><label class="dlg-field">${rename?'当前目录':'创建位置'}<span>${escape(current?.path||'/')}</span></label><label class="dlg-field">目录名称<input aria-label="目录名称" maxlength="100" value="${escape(initial)}" required></label><p data-error role="alert"></p></main><footer><button type="button" class="btn" data-cancel>取消</button><button class="btn btn-pri" type="submit">${rename?'确认更名':'创建'}</button></footer></form>`,{native:true,className:'file-operation-dialog'});
    const input=dialog.querySelector('input'),button=dialog.querySelector('[type="submit"]'),error=dialog.querySelector('[data-error]');
    let busy=false,pending=null,unknown=false;
    ui.guardModal(dialog,()=>{if(busy||pending||input.value!==initial){notify('目录操作或输入尚未处理，请保存或明确取消');return false;}return true;});
    dialog.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{if(busy||pending){notify('操作结果待核实，请重试原操作');return;}ui.closeModal(true);});
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;button.disabled=true;input.disabled=true;
      pending??={key:crypto.randomUUID(),payload:rename?{directory:current.name,title:input.value.trim(),expected_modified:current.modified}:{parent:current?.name||'files-root',title:input.value.trim()}};
      try{const result=await realAction(rename?'files.directory_rename':'files.directory_create',pending.payload,pending.key);if(!result.directory||!result.path||!result.modified)throw Error('目录回执不完整');pending=null;ui.closeModal(true);directoryId=result.directory;try{await refreshDirectories();await loadResults();notify(rename?'目录已更名，文件仍在原目录中':'目录已创建');}catch(refreshError){notify('目录操作已完成，刷新失败：'+refreshError.message);}}
      catch(e){if(ui.disposed)return;unknown=unknown||uncertainError(e);if(!unknown)pending=null;error.textContent=(pending?'结果待核实，重试保持原操作；':'未完成，输入已保留；')+e.message;button.textContent=pending?'重试原操作':'重试';}
      finally{busy=false;button.disabled=false;input.disabled=!!pending;}
    };
  }
  function openDirectoryAccess(){
    const current=directories.find(d=>d.name===directoryId);
    if(!manageDirectories||!accessOptions||!current?.access)return;
    const access=current.access,people=[...accessOptions.people],groups=[...accessOptions.groups];
    for(const id of access.identities||[])if(!people.some(p=>p.identity_id===id))people.push({identity_id:id,label:'已不可用人员（请移除）'});
    for(const group of access.groups||[])if(!groups.includes(group))groups.push(group);
    const choices=(items,kind)=>items.map(item=>{
      const id=kind==='person'?item.identity_id:item;
      const duplicate=kind==='person'&&items.some(other=>other!==item&&other.label===item.label&&other.group===item.group);
      const account=item.account||id,short=account.length>16&&!items.some(other=>other!==item&&String(other.account||other.identity_id).slice(-6)===account.slice(-6))?'…'+account.slice(-6):account;
      const label=kind==='person'?item.label+(item.group?' · '+item.group:'')+(duplicate?'（'+short+'）':''):item;
      return `<label class="file-access-choice" title="${escape(account)}"><input type="checkbox" data-access-${kind} value="${escape(id)}" ${(kind==='person'?access.identities:access.groups)?.includes(id)?'checked':''}><span>${escape(label)}</span></label>`;
    }).join('');
    const dialog=ui.modal(`<form><header><h2>目录访问权限</h2><button type="button" class="btn" data-cancel aria-label="关闭">×</button></header><main><label class="dlg-field">当前目录<span>${escape(current.path)}</span></label><label class="dlg-field">可访问范围<select name="access-mode"><option value="inherit">${current.name==='files-root'?'全体已登录员工':'继承父目录'}</option><option value="restricted">指定人员或分组</option></select></label><section data-access-grants><fieldset><legend>协作分组</legend>${choices(groups,'group')||'<p>暂无分组</p>'}</fieldset><fieldset><legend>人员</legend>${choices(people,'person')||'<p>暂无可选人员</p>'}</fieldset></section><p>子目录不能扩大父目录的范围。系统管理员始终可访问；可见不等于可修改他人文件。</p><p data-access-empty hidden>未选人员或分组：仅系统管理员可访问。</p><p data-error role="alert"></p></main><footer><button type="button" class="btn" data-cancel>取消</button><button class="btn btn-pri" type="submit">保存权限</button></footer></form>`,{native:true,className:'file-operation-dialog'});
    const mode=dialog.querySelector('[name="access-mode"]'),button=dialog.querySelector('[type="submit"]'),error=dialog.querySelector('[data-error]');
    mode.value=access.mode;
    const selected=kind=>Array.from(dialog.querySelectorAll(`[data-access-${kind}]:checked`),node=>node.value);
    const payload=()=>({directory:current.name,expected_modified:current.modified,mode:mode.value,identities:mode.value==='restricted'?selected('person'):[],groups:mode.value==='restricted'?selected('group'):[]});
    const initial=JSON.stringify(payload());let busy=false,pending=null,unknown=false;
    const sync=()=>{dialog.querySelector('[data-access-grants]').hidden=mode.value!=='restricted';dialog.querySelector('[data-access-empty]').hidden=mode.value!=='restricted'||!!(selected('person').length+selected('group').length);};
    dialog.querySelectorAll('input,select').forEach(control=>control.onchange=sync);sync();
    ui.guardModal(dialog,()=>{if(busy||pending||JSON.stringify(payload())!==initial){notify('权限修改尚未处理，请保存或明确取消');return false;}return true;});
    dialog.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{if(busy||pending){notify('权限变更结果待核实，请重试原操作');return;}ui.closeModal(true);});
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;button.disabled=true;
      pending??={key:crypto.randomUUID(),payload:payload()};dialog.querySelectorAll('input,select').forEach(control=>control.disabled=true);
      try{
        const result=await realAction('files.directory_access',pending.payload,pending.key);
        if(result.directory!==current.name||result.mode!==pending.payload.mode||!result.modified)throw Error('权限回执不完整');
        pending=null;ui.closeModal(true);
        try{await refreshDirectories();await loadResults();notify('目录权限已保存');}catch(e){notify('权限已保存，刷新失败：'+e.message);}
      }catch(e){if(ui.disposed)return;unknown=unknown||uncertainError(e);if(!unknown)pending=null;error.textContent=(pending?'结果待核实，重试保持原授权；':'未完成，选择已保留；')+e.message;button.textContent=pending?'核实并重试原操作':'重试保存';}
      finally{busy=false;button.disabled=false;dialog.querySelectorAll('input,select').forEach(control=>control.disabled=!!pending);}
    };
  }
  async function realUpload(list){
    /* FIX-09：**先快照再 await**。`input.files` 是活对象，调用方清 input 时列表会空。 */
    const picked=Array.from(list||[]);
    let mountResourceAttribution;try{mountResourceAttribution=typeof globalThis.mountResourceAttribution==='function'?globalThis.mountResourceAttribution:(await import('./resource-attribution.mjs')).mountResourceAttribution;}catch{notify('归属组件加载失败，请刷新后重试');return;}
    const items=picked.map(file=>({file,key:crypto.randomUUID(),payload:null,done:false,error:'',unknown:false}));if(!items.length)return;
    const dialog=ui.modal(`<form><header><h2>上传文件</h2><button type="button" class="btn" data-cancel aria-label="关闭">×</button></header><main><label class="dlg-field">存入目录<select aria-label="上传目录">${directories.length?directoryOptions(directoryId||'files-root'):'<option value="">根目录 /</option>'}</select></label><div class="dlg-field"><span>文件归属</span><div data-resource-attribution></div></div><ul>${items.map(i=>`<li>${escape(i.file.name)}</li>`).join('')}</ul><p role="status" data-status></p></main><footer><button class="btn" type="button" data-cancel>取消</button><button class="btn btn-pri" type="submit">确认上传</button></footer></form>`,{native:true,className:'file-operation-dialog'});
    let busy=false;const select=dialog.querySelector('select'),submit=dialog.querySelector('[type="submit"]'),status=dialog.querySelector('[data-status]');
    /* 归属走**公共组件**（摊开式）—— 两张选项卡直接摊在这扇「上传文件」对话框里，
       **不再弹第二扇窗**（PKG-016：用户「不要用重叠弹窗，直接摊出来」）。
       PKG-016 同时把底部那句「同目录同名普通文件会新增版本…」删掉了。 */
    const attributionPicker=mountResourceAttribution(dialog.querySelector('[data-resource-attribution]'),{fetcher:fetch,signal:ui.signal,ui,label:''});
    void attributionPicker.load();
    const unknown=()=>items.some(i=>i.unknown);
    ui.guardModal(dialog,()=>{notify('请完成上传或明确取消；结果未知时须先核实');return false;});
    dialog.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=async()=>{if(busy||unknown()){notify('上传结果待核实，请重试原操作');return;}ui.closeModal(true);if(items.some(i=>i.done)){await loadResults();notify('已完成的文件保留；其余未上传');}});
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const attribution=attributionPicker.read();if(!attribution.ok){status.textContent=attribution.reason;return;}
      busy=true;select.disabled=true;attributionPicker.lock(true);submit.disabled=true;
      for(const item of items.filter(i=>!i.done)){
        if(ui.disposed)return;status.textContent='正在上传 '+item.file.name;
        try{item.payload??={file_name:item.file.name,attribution:attribution.value,content_base64:await window.readFileCenterContent(item.file),...(select.value?{directory_id:select.value}:{directory:'/'})};const result=await realAction('files.upload',item.payload,item.key);if(!result.file||!Number.isInteger(result.version))throw Error('上传回执不完整');item.done=true;item.error='';item.unknown=false;}
        catch(error){item.error=error.message;item.unknown=item.unknown||uncertainError(error);if(!item.unknown){item.payload=null;item.key=crypto.randomUUID();}}
      }
      busy=false;if(ui.disposed)return;submit.disabled=false;select.disabled=unknown();attributionPicker.lock(unknown());
      const remaining=items.filter(i=>!i.done);status.textContent=`已上传 ${items.length-remaining.length} 个，未完成 ${remaining.length} 个`+(remaining.length?'；'+remaining.map(i=>i.file.name+'：'+i.error).join('；'):'');submit.textContent=unknown()?'核实并重试原上传':'重试未完成文件';
      if(!remaining.length){ui.closeModal(true);try{await refreshCurrentPage();notify('文件已上传');}catch(e){notify('已上传，列表刷新失败：'+e.message);}}
    };
  }
  async function probeReal(){
    connecting=true;render();
    try{
      await realRefresh();realMode=true;updateFilterOptions();
    }catch(error){realMode=false;readError=error.message||'读取失败';}
    if(ui.disposed)return;
    connecting=false;$('.preview-label').hidden=realMode;
    $('.preview-label').textContent=realMode?'已连接文件域':(showExamples?'交互样例 · 不保存':'读取失败');
    $('#upload').disabled=!realMode&&!showExamples;
    $('#upload').textContent=realMode?'上传文件':(showExamples?'选择本地文件（不上传）':'暂不可上传');
    $('#examples-toggle').hidden=realMode||(!showExamples&&!!readError);
    render();
    if(realMode)refreshDirectories().catch(error=>{directoryBar.hidden=true;notify('文件可查看，目录读取失败：'+error.message);});
    if(readError&&!showExamples)notify('文件读取失败：'+readError);
  }
  let view='all',selected=null,descending=true,dragDepth=0;
  const urls=new Map();
  ui.onDispose(()=>{for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();});
  let layout='list',page=1;
  let thumbnailCycle=null;
  function stopThumbnails(){thumbnailCycle?.();thumbnailCycle=null;}
  ui.onDispose(stopThumbnails);
  function loadThumbnails(rows){
    if(!window.IntersectionObserver||!window.readFileCenterThumbnail)return;
    const controller=new AbortController(),queue=[],objects=new Set();let running=0,stopped=false;
    const elements=new Map(rows.map(f=>[f.id,f]));
    const pump=()=>{
      while(!stopped&&running<2&&queue.length){
        const element=queue.shift(),file=elements.get(element.dataset.thumbnail);if(!file||!element.isConnected)continue;
        running++;
        window.readFileCenterThumbnail(file,controller.signal).then(preview=>{
          if(stopped||ui.disposed||!element.isConnected||!preview)return;
          if(preview.kind==='text'&&preview.text){const text=document.createElement('span');text.className='tile-excerpt';text.textContent=preview.text;element.replaceChildren(text);}
          if(preview.kind==='image'){const image=document.createElement('img');image.alt='';image.src=URL.createObjectURL(preview.blob);objects.add(image.src);element.replaceChildren(image);}
        }).catch(()=>{/* 缩略图失败保留格式图标；原件仍由点击详情单独校验。 */}).finally(()=>{running--;pump();});
      }
    };
    const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){observer.unobserve(entry.target);queue.push(entry.target);}}pump();},{root:$('.file-table-scroll')});
    host.querySelectorAll('[data-thumbnail]').forEach(element=>observer.observe(element));
    thumbnailCycle=()=>{stopped=true;controller.abort();observer.disconnect();queue.length=0;for(const url of objects)URL.revokeObjectURL(url);objects.clear();};
  }
  const checked=new Set(),collapsed=new Set();
  function pageRows(){if(realMode)return files;const rows=visible(),limit=Number($('#page-size').value);page=Math.min(page,Math.max(1,Math.ceil(rows.length/limit)));return rows.slice((page-1)*limit,page*limit);}
  const checkbox=f=>`<input type="checkbox" data-check="${f.id}" aria-label="选择 ${escape(f.name)}" ${checked.has(f.id)?'checked':''}>`;
  function updateSelection(){
    const rows=pageRows(),count=rows.filter(f=>checked.has(f.id)).length;
    $('#select-page').checked=rows.length>0&&count===rows.length;$('#select-page').indeterminate=count>0&&count<rows.length;
    $('#select-page').disabled=!rows.length;$('#selection-count').textContent=checked.size?`已选 ${checked.size} 个`:'未选择';
    $('#batch-change').disabled=batchBusy||!checked.size;$('#batch-change').textContent=batchBusy?'正在办理…':view==='trash'?'恢复所选':'移入回收站';
  }
  function renderLayouts(rows){
    stopThumbnails();
    $('.file-table').hidden=layout!=='list';$('#alternate-view').hidden=layout==='list';$('#group-by').hidden=layout!=='groups';
    host.querySelectorAll('[data-layout]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layout===layout)));
    const item=f=>`<div class="group-file">${checkbox(f)}<button class="file-open" data-open="${f.id}">${icon(f)}<span class="file-name">${escape(f.name)}</span></button><span>${escape(f.date)}</span></div>`;
    if(layout==='grid'){
      $('#alternate-view').innerHTML=`<div class="file-grid">${rows.map(f=>`<article class="file-tile">${checkbox(f)}<button data-open="${f.id}" class="tile-open"><span class="tile-preview" ${f.real?'data-thumbnail="'+escape(f.id)+'"':''}>${f.text?'<span class="tile-excerpt">'+escape(f.text.slice(0,400))+'</span>':f.file&&/^image\/(png|jpeg|webp|gif)$/.test(f.file.type)?`<img src="${objectURL(f)}" alt="">`:icon(f)}</span><span class="tile-name">${escape(f.name)}</span><span class="tile-meta">${size(f.size)} · ${escape(f.date.slice(0,10))}</span></button></article>`).join('')}</div>`;
      if(view!=='review'&&view!=='reviewed')loadThumbnails(rows);
      host.querySelectorAll('.tile-open').forEach(button=>button.setAttribute('aria-label',rows.find(f=>f.id===button.dataset.open)?.name||'打开文件'));
    }
    else if(layout==='groups'){
      const groups=new Map();for(const f of rows){const key=$('#group-by').value,labels=key==='date'?[f.date.slice(0,7)]:key==='tags'?(f.tags.length?f.tags:['未标记']):[f.source];for(const label of labels){if(!groups.has(label))groups.set(label,[]);groups.get(label).push(f);}}
      $('#alternate-view').innerHTML=Array.from(groups,([label,items])=>`<details class="file-group" data-group="${escape(label)}" ${collapsed.has($('#group-by').value+label)?'':'open'}><summary>${escape(label)} <span>${items.length} 个 · 本页</span></summary>${items.map(item).join('')}</details>`).join('');
      const groupBy=$('#group-by').value;
      host.querySelectorAll('[data-group]').forEach(el=>el.ontoggle=()=>{if(!el.isConnected)return;const key=groupBy+el.dataset.group;if(el.open)collapsed.delete(key);else collapsed.add(key);});
    }else $('#alternate-view').innerHTML='';
    if(layout!=='list'&&!rows.length)$('#alternate-view').innerHTML='<div class="empty view-empty"><strong>没有匹配的文件</strong>可以清除筛选，或切换文件范围。</div>';
    const total=realMode?remoteTotal:visible().length,pages=Math.max(1,Math.ceil(total/Number($('#page-size').value)));
    $('#page-info').textContent=`第 ${page} / ${pages} 页 · 共 ${total} 个`;
    $('#previous-page').disabled=readBusy||page===1;$('#next-page').disabled=readBusy||page===pages;
    host.querySelectorAll('[data-check]').forEach(el=>el.onchange=()=>{if(el.checked)checked.add(el.dataset.check);else checked.delete(el.dataset.check);host.querySelectorAll(`[data-check="${el.dataset.check}"]`).forEach(other=>other.checked=el.checked);updateSelection();});
    updateSelection();
  }
  const extension=name=>name.split('.').pop().toLowerCase();
  function kind(name){const ext=extension(name);return ['xls','xlsx','csv'].includes(ext)?'表格':['png','jpg','jpeg','webp','gif'].includes(ext)?'图片':['pdf','doc','docx','txt','md'].includes(ext)?'文档':'其他';}
  function icon(file){const ext=extension(file.name);return `<span class="file-symbol ${ext==='pdf'?'pdf':kind(file.name)==='表格'?'sheet':kind(file.name)==='文档'?'doc':''}" aria-hidden="true">${escape(ext.slice(0,4).toUpperCase())}</span>`;}
  const size=bytes=>bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
  function visible(){if(realMode)return files;const term=$('#search').value.trim().toLowerCase();return files.filter(f=>{
    return (view==='trash'?f.deleted:!f.deleted)&&(view!=='mine'||f.owner==='我');
  }).filter(f=>!$('#type').value||kind(f.name)===$('#type').value).filter(f=>[f.name,...f.tags].join(' ').toLowerCase().includes(term)).sort((a,b)=>(descending?-1:1)*a.date.localeCompare(b.date));}
  /* —— 审核工作面（对齐旧版 review-center）：正式值 vs 待确认值三段式 + 勾选采用 + 整批确认 —— */
  const reviewSources={host:{label:'Host 补充',hint:'通知书带来的更新，含手动补传'},official:{label:'通知书校对',hint:'核对官方信息与当前记录的差异'}};
  const reviewSamples=[
    {id:'R1',source:'host',caseNo:'IP-2026-0245',caseName:'挡雨板连接结构（CN3024518）',material:'审查意见通知书.pdf',changes:[
      {key:'official_title',label:'案件名称',before:'挡雨板连接结构',after:'挡雨板连接机构',evidence:'通知书首页第 3 行'},
      {key:'applicant_name',label:'申请人',before:'苏州某某科技有限公司',after:'苏州某某科技有限公司；王某',evidence:'申请人栏多处记载'},
      {key:'application_date',label:'申请日',before:'2025-03-14',after:'2025-03-13',evidence:'受理通知书记载',type:'date'},
    ]},
    {id:'R2',source:'official',caseNo:'IP-2026-0231',caseName:'一种折叠支架（CN3021852）',material:'通知书状态比对 · 2026-09-20 导出',changes:[
      {key:'internal_status',label:'当前状态',before:'审查中',after:'待补正',evidence:'官方查询导出与案件记录不一致',type:'select',options:['待补正','已授权','驳回失效']},
    ]},
  ];
  let reviewDialog=null;
  function closeReviewDialog(){if(reviewDialog?.isConnected)ui.closeModal(true);reviewDialog=null;}
  function openReviewPreview(card){
    closeReviewDialog();
    reviewDialog=ui.modal(`<header><h2>${escape(card.material)}</h2><button class="btn" data-close aria-label="关闭预览">×</button></header><main><pre>国家知识产权局\n\n第一次审查意见通知书（节选，示例内容）\n\n本申请经审查，存在如下问题：……\n请申请人在指定期限内陈述意见或对申请文件进行修改。</pre></main>`,{native:true});
    reviewDialog.querySelector('[data-close]').onclick=closeReviewDialog;
  }
  const reviewValueInput=(card,c)=>{
    const key=`${card.id}.${c.key}`,attr=`data-review-value="${escape(key)}" aria-label="${escape(c.label)}"`;
    if(c.type==='select')return `<select ${attr}>${[c.after,...(c.options||[]).filter(o=>o!==c.after)].map(o=>`<option ${o===c.after?'selected':''}>${escape(o)}</option>`).join('')}</select>`;
    if(c.type==='date')return `<input type="date" ${attr} value="${escape(c.after)}">`;
    return `<textarea rows="1" ${attr}>${escape(c.after)}</textarea>`;
  };
  function renderReview(){
    directoryBar.hidden=true;
    $('.file-tools').hidden=true;$('.file-selection').hidden=true;$('.file-table').hidden=true;$('#alternate-view').hidden=true;$('.file-pagination').hidden=true;
    const area=$('#review-area');area.hidden=false;
    const cards=(showExamples&&!realMode)?reviewSamples:[];
    $('#review-count').textContent=cards.length?' '+cards.length:'';
    if(!cards.length){area.innerHTML='<div class="empty view-empty"><strong>当前没有待核对事项</strong>审核工作面待后端接入；可点击“查看交互样例”检查页面。</div>';$('#review-footer').hidden=true;return;}
    area.innerHTML=`<div class="cr-guide"><span>按案件核对：查看正式值 → 修改或勾选待确认值 → 预览附件 → 确认保存</span><label><input type="checkbox" id="review-select-all">全选当前可确认项</label></div>`+cards.map(card=>`
      <article class="cr-case-card cr-source-${card.source}" data-review="${card.id}">
        <header><label><input type="checkbox" data-card-check aria-label="选择本案件可确认字段"><strong>${escape(card.caseNo)}</strong><span class="cr-source-label" title="${escape(reviewSources[card.source].hint)}">${escape(reviewSources[card.source].label)}</span></label><span class="cr-pending">待确认</span><h2>${escape(card.caseName)}</h2></header>
        ${card.changes.map(c=>`<div class="cr-diff" data-field="${escape(c.key)}">
          <label><input type="checkbox" data-review-check="${escape(card.id+'.'+c.key)}"><b>${escape(c.label)}</b></label>
          <div class="cr-before"><small>当前正式值</small><strong>${escape(c.before)}</strong></div>
          <div class="cr-after"><small>待确认值 · 可直接修改</small>${reviewValueInput(card,c)}</div>
          <p class="cr-inline-evidence">${escape(c.evidence)}</p>
        </div>`).join('')}
        <div class="cr-evidence"><p><b>${escape(card.material)}</b></p><button class="btn" data-review-preview="${card.id}">预览附件</button></div>
      </article>`).join('');
    const count=()=>{
      const n=host.querySelectorAll('[data-review-check]:checked').length;
      $('#review-selected').textContent=`已选 ${n} 项`;
      $('#review-confirm').disabled=!n;
      host.querySelectorAll('[data-card-check]').forEach(c=>{const card=c.closest('[data-review]');const all=[...card.querySelectorAll('[data-review-check]')];const on=all.filter(x=>x.checked).length;c.checked=!!all.length&&on===all.length;c.indeterminate=on>0&&on<all.length;});
    };
    host.querySelectorAll('[data-review-check]').forEach(c=>c.onchange=count);
    host.querySelectorAll('[data-review-value]').forEach(el=>el.addEventListener('input',()=>{const check=host.querySelector(`[data-review-check="${el.dataset.reviewValue}"]`);if(check&&!check.disabled)check.checked=true;count();}));
    host.querySelectorAll('[data-card-check]').forEach(c=>c.onchange=()=>{c.closest('[data-review]').querySelectorAll('[data-review-check]').forEach(x=>x.checked=c.checked);count();});
    $('#review-select-all').onchange=e=>{host.querySelectorAll('[data-review-check]').forEach(x=>x.checked=e.target.checked);count();};
    host.querySelectorAll('[data-review-preview]').forEach(b=>b.onclick=()=>openReviewPreview(reviewSamples.find(r=>r.id===b.dataset.reviewPreview)));
    $('#review-footer').hidden=false;count();
    $('#review-confirm').onclick=()=>{
      const checkedFields=[...host.querySelectorAll('[data-review-check]:checked')];
      const empty=checkedFields.find(c=>!host.querySelector(`[data-review-value="${c.dataset.reviewCheck}"]`)?.value?.trim());
      if(empty){$('#review-result').textContent='请先补全已选项的待确认值。';return;}
      $('#review-result').textContent=`示例环境：未连接保存服务，${checkedFields.length} 项确认未写入正式记录。`;
    };
  }
  // 普通列表与单文件回执共用相同的行和操作绑定，不另造一套卡片语义。
  const fileRowMarkup=f=>`<tr data-file="${f.id}" class="${selected===f.id?'is-selected':''}"><td><button class="file-open" data-open="${f.id}" title="${escape(f.name)}">${icon(f)}<span class="file-name">${escape(f.name)}</span></button></td><td>${f.tags.map(t=>`<span class="file-tag">${escape(t)}</span>`).join('')||'—'}</td><td>${escape(f.source)}</td><td>${escape(f.owner)}</td><td>${ownerCell(f)}</td><td>${f.relatedMail?`<button class="file-link" data-mail="${escape(f.relatedMail)}">${escape(f.relatedMail)}</button>`:'—'}</td><td>${escape(f.date)}</td><td class="file-size">${size(f.size)}</td><td><button class="file-link" data-open="${f.id}">${view==='trash'?'查看 / 恢复':'查看'}</button>${f.canAssign&&!f.deleted?`<button class="file-link" data-assign="${escape(f.id)}">调整归属</button>`:''}</td></tr>`;
  function bindFileControls(root){
    const reviewing=realMode&&(view==='review'||view==='reviewed');
    root.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>open(b.dataset.open));
    root.querySelectorAll('[data-assign]').forEach(b=>b.onclick=()=>{const f=files.find(f=>f.id===b.dataset.assign);if(f?.canAssign)void window.openResourceAssignment({host,resource:f.id,title:f.name,onSaved:loadResults,signal:ui.signal});});
    if(realMode&&view!=='trash'&&!reviewing){
      root.querySelectorAll('tr[data-file] td:last-child').forEach(cell=>{
        const id=cell.parentElement.dataset.file;
        const file=files.find(f=>f.id===id);
        if(file.currentFile){
          const link=document.createElement('a');link.className='file-link';link.textContent='下载';link.dataset.download=id;link.download=file.name;
          link.href='/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:id,file:file.currentFile});cell.append(link);
        }else{
          const download=document.createElement('button');download.className='file-link';download.textContent='下载';download.dataset.download=id;cell.append(download);
          download.onclick=async()=>{
            download.disabled=true;download.textContent='读取…';
            try{
              const data=await window.readFileCenterVersions(id,ui.signal),version=data.current||data.versions?.[0];
              if(ui.disposed||!download.isConnected)return;
              if(data.file?.name!==id||!version?.frappe_file)throw Error('当前文件版本不可用，请刷新重试');
              const link=document.createElement('a');link.href='/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:id,file:version.frappe_file});link.download=file.name;document.body.append(link);link.click();link.remove();
            }catch(error){if(!ui.disposed)notify('下载未开始：'+error.message);}finally{download.disabled=false;download.textContent='下载';}
          };
        }
        if(!file.canEdit)return;
        const rename=document.createElement('button');rename.className='file-link';rename.textContent='重命名';rename.dataset.rename=id;rename.onclick=()=>realDetail(file,'file_name');cell.append(rename);
        const button=document.createElement('button');button.className='file-link';button.textContent='审核';
        button.onclick=()=>openReview(id);cell.append(button);
      });
    }
  }
  async function refreshCurrentPage(){
    clearTimeout(searchTimer);queryReads?.cancel();
    if(await realRefresh()){render();updateFilterOptions();}
  }
  function patchListRows(changedIds){
    if(layout!=='list'){render();return;}
    const body=$('#file-rows');
    for(const id of changedIds){
      const old=Array.from(body.querySelectorAll('tr[data-file]')).find(node=>node.dataset.file===id);
      const file=files.find(item=>item.id===id);
      if(!file){old?.remove();continue;}
      if(!old){render();return;}
      const template=document.createElement('template');template.innerHTML='<table><tbody>'+fileRowMarkup(file)+'</tbody></table>';
      const fresh=template.content.querySelector('tr');
      fresh.querySelector('td').insertAdjacentHTML('afterbegin',checkbox(file));
      old.replaceWith(fresh);bindFileControls(fresh);
    }
    // 只移动次序真正变化的行，其他行保留节点、事件与正在进行的下载状态。
    let cursor=body.firstElementChild;
    for(const file of files){
      const node=Array.from(body.querySelectorAll('tr[data-file]')).find(item=>item.dataset.file===file.id);
      if(!node)continue;if(node===cursor)cursor=cursor.nextElementSibling;else body.insertBefore(node,cursor);
    }
    if(!files.length){render();return;}
    renderLayouts(files);$('#result-count').textContent=`${remoteTotal} 个文件`;updateFilterOptions();
  }
  async function refreshChangedFile(row,change={}){
    if(ui.disposed||!realMode)return;
    const id=String(change.receipt?.file||row?.name||row?.id||'');
    const index=files.findIndex(file=>file.id===id),old=files[index];
    const action=change.action,receipt=change.receipt;
    if(old&&((action==='files.recycle'&&receipt?.status==='Recycled'&&view!=='trash')||(action==='files.restore'&&receipt?.status==='Active'&&view==='trash'))){
      // 已验证的状态回执只移出目标；需要补满页或翻到上一页时仍由服务端给真实边界。
      if(remoteTotal-1>files.length-1||page>1){await refreshCurrentPage();return;}
      clearTimeout(searchTimer);querySequence++;queryReads?.cancel();readBusy=false;
      files.splice(index,1);remoteTotal=Math.max(0,remoteTotal-1);checked.delete(id);patchListRows([id]);return;
    }
    const full=row?.name===id&&typeof row.file_name==='string'&&typeof row.modified==='string'&&typeof row.can_edit==='boolean'&&row.status==='Active';
    // 同文件并发保存的较旧回执不能覆盖已经显示的新版本。
    if(full&&old?.modified&&row.modified<old.modified)return;
    const unfiltered=view==='all'&&!related&&!directoryId&&!$('#search').value.trim()&&!$('#type').value&&!$('#owner-filter').value&&!$('#mail-filter').value;
    const stablePage=page===1&&(descending||remoteTotal<=Number($('#page-size').value));
    if(!readBusy&&old&&full&&unfiltered&&stablePage&&(!action||action==='files.update_meta')){
      clearTimeout(searchTimer);querySequence++;queryReads?.cancel();
      const updated=mapReal(row);
      // 元数据动作不改变内容引用；回执没有此字段时沿用已核实的同一原件。
      if(action==='files.update_meta'&&row.current_file===undefined)updated.currentFile=old.currentFile;
      files[index]=updated;files.sort((a,b)=>(descending?-1:1)*String(a.modified).localeCompare(String(b.modified)));
      patchListRows([id]);return;
    }
    // 缺少完整投影，或更改影响筛选/页边界：仅按原查询重读当前页，不清条件、不读全库。
    await refreshCurrentPage();
  }
  /* —— 骨架（文件列表还没到时的占位）——
     照**真表格**搭：真表头留着（列名是真的），数据行**空着**（只有细线）——
     真格里是字、长度未知 ⇒ 塞灰条就是假的；
     唯一有固定形状的是**文件图标位**（30×36）⇒ 那一位摆一块同样尺寸的灰底。
     ⚠️ 只表示「正在取数」⇒ 不写假文件名、不写假项数、不写假大小。 */
  const fileListSkeleton=(count=8)=>Array.from({length:count},()=>'<tr class="platform-skeleton" data-skeleton="file-row" data-skeleton-row="1"><td><span class="platform-skeleton-bar" style="width:30px;height:36px;border-radius:4px"></span></td>'+'<td></td>'.repeat(8)+'</tr>').join('');
  /* 计数那一行在取数期间也是骨架（不写看得见的字）。 */
  const countSkeleton='<span class="platform-skeleton-bar" style="display:inline-block;width:56px;height:11px;vertical-align:middle"></span>';
  function render(){
    host.querySelectorAll('[data-view],#search,#type,#sort,#page-size,#clear').forEach(control=>control.disabled=connecting);
    $('#related-filter').hidden=!realMode;$('#related-filter').disabled=readBusy;
    if(readError&&related)$('#related-summary').textContent='关联记录暂不可访问，请重试或清除筛选。';
    directoryBar.hidden=!realMode||!directories.length;
    const reviewing=realMode&&(view==='review'||view==='reviewed');
    $('.preview-footer').textContent=realMode?'文件已保存在企业文件域；AI 候选需人工核对，审核整份保存。':showExamples?'交互样例：仅保存在当前页面，不会上传服务器。':readError?'文件读取失败：'+readError+'。请检查权限或连接后重新打开。':'正在连接文件域…';
    /* PKG-016（用户 2026-10-21）：底部那块常驻的「也可以将文件拖到这里上传」**去掉**了 ——
     改成**有文件拖进来才出现**的整页遮罩；不拖进来就不占地方。遮罩上写什么，按当前能不能上传分。 */
    $('#drop-overlay').textContent=realMode?'松开即上传':showExamples?'松开加入本地预览（不上传）':'当前不可上传文件，松开也不会上传';
    host.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    if(view==='review'&&!realMode){renderReview();return;}
    $('.file-tools').hidden=false;$('.file-selection').hidden=false;$('.file-table').hidden=layout!=='list';$('#alternate-view').hidden=layout==='list';$('.file-pagination').hidden=false;$('#review-area').hidden=true;$('#review-footer').hidden=true;
    const rows=pageRows();$('#all-count').textContent=realMode?'':files.filter(f=>!f.deleted).length;$('#result-count').innerHTML=(readBusy||connecting)?countSkeleton:`${realMode?remoteTotal:visible().length} 个文件`;
    const filtered=$('#search').value||$('#type').value||related;
    const emptyTitle=filtered?'没有找到匹配的文件':view==='review'?'没有待审核文件':view==='reviewed'?'还没有已处理文件':view==='trash'?'回收站是空的':directoryId?'当前目录没有文件':view==='mine'?'你还没有上传文件':realMode?'还没有企业文件':'这里还没有文件';
    const emptyHint=filtered?'换个关键词，或清除筛选条件。':reviewing?'新上传或更新版本的文件进入待审核；保存审核后可在已处理中查看。':view==='trash'?'移入回收站的文件会出现在这里。':realMode?'点右上角「上传文件」，确认存入目录。':'存储待接入；可点击“查看交互样例”检查页面。';
    $('#file-rows').innerHTML=rows.map(fileRowMarkup).join('')||`<tr><td colspan="9" class="empty"><strong>${emptyTitle}</strong>${emptyHint}</td></tr>`;
    if(!reviewing)host.querySelectorAll('tr[data-file] td:first-child').forEach(cell=>{const f=files.find(f=>f.id===cell.parentElement.dataset.file);cell.insertAdjacentHTML('afterbegin',checkbox(f));});
    if(readError&&!showExamples)$('#file-rows').innerHTML=`<tr><td colspan="9" class="empty"><strong>文件列表暂不可用</strong>${escape(readError)}；请检查权限或连接后重新打开。</td></tr>`;
    if(connecting)$('#file-rows').innerHTML=fileListSkeleton();
    renderLayouts(rows);
    bindFileControls(host);
    if(reviewing){
      $('.file-selection').hidden=true;$('.file-layouts').hidden=true;$('.file-table').hidden=false;$('#alternate-view').hidden=true;
      host.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openReview(b.dataset.open));
      host.querySelectorAll('tr[data-file] td:last-child button').forEach(b=>b.textContent=view==='review'?'审核':'查看审核');
    }else $('.file-layouts').hidden=false;
  }
  let openingReview=false;
  async function openReview(id){
    if(openingReview)return;openingReview=true;
    try{await window.openFileReview({ui,file:files.find(f=>f.id===id),onChanged:loadResults});}
    catch(e){notify('审核无法打开：'+e.message);}finally{openingReview=false;}
  }
  function close(){selected=null;$('#details').hidden=true;render();}
  async function open(id){
    const f=files.find(f=>f.id===id);
    // FIX-45（用户 2026-10-20 13:05）：
    // 「xlsx 从文件中心点击就直接进入 excel 部分打开」——
    // **Excel 是文件中心的一部分**，只是内容太多，给了它自己的页面和交互；
    // 通用详情框里那套「第 N 版 / 查看此版本 / 下载此版本」是**普通文件**的概念
    //（同名再传一次才新增版本），**Excel 没有版本** ⇒ 表格不走那个框。
    // ⚠️ 回收站里的表格不能跳（已删的表 Excel 打不开）—— 走原来的详情/恢复路径。
    if(f&&f.real&&!f.deleted&&/\.xlsx$/i.test(f.name||'')){
      if(typeof window.shangshuOpenTable!=='function'){notify('表格工作面暂不可用，请刷新后重试','error');return;}
      const opened=window.shangshuOpenTable(f.id,{source:'xlsx'});
      if(opened?.ok===false)notify(opened.reason||'表格未打开，请重试','error');
      return;
    }
    if(f&&f.real){await realDetail(f);return;}
    selected=id;const panel=$('#details');panel.hidden=false;render();
    panel.innerHTML=`<div class="detail-head"><span>文件详情</span><button class="detail-close" id="close-detail" aria-label="关闭文件详情">×</button></div>${icon(f)}<h2>${escape(f.name)}</h2><div id="file-preview-content"></div><dl><dt>标签</dt><dd>${f.tags.map(t=>`<span class="file-tag">${escape(t)}</span>`).join('')||'未添加'}</dd><dt>来源</dt><dd>${escape(f.source)}</dd><dt>上传人</dt><dd>${escape(f.owner)}</dd><dt>所有人</dt><dd>${ownerCell(f)}</dd><dt>关联邮件</dt><dd>${f.relatedMail?`<button class="file-link" data-mail="${escape(f.relatedMail)}">${escape(f.relatedMail)}</button>`:'—（非邮件来源）'}</dd><dt>更新时间</dt><dd>${escape(f.date)}</dd><dt>大小</dt><dd>${size(f.size)}</dd><dt>存储状态</dt><dd>${f.sample?'界面样例，无服务器文件':'当前页面内存，未上传服务器'}</dd></dl><div class="detail-actions"><button class="btn btn-ghost" id="download" ${!f.file&&!f.text?'disabled':''}>下载${f.sample?'示例':''}</button>${f.deleted?'<button class="btn btn-pri" id="restore-file">恢复文件</button>':'<button class="btn btn-ghost" id="trash-file">移入回收站</button>'}</div>`;
    $('#close-detail').onclick=close;
    const preview=$('#file-preview-content');
    if(f.text){const pre=document.createElement('pre');pre.textContent=f.text;preview.append(pre);}
    else if(f.file&&kind(f.name)==='图片'&&/^image\/(png|jpeg|webp|gif)$/.test(f.file.type)){const img=document.createElement('img');img.src=objectURL(f);img.alt=f.name;preview.append(img);}
    else preview.innerHTML='<div class="preview-unavailable">此格式暂不提供内容预览<br>文件保存不依赖预览或 AI 解析</div>';
    $('#download').onclick=()=>{const a=document.createElement('a');a.href=objectURL(f);a.download=f.name;document.body.append(a);a.click();a.remove();};
    const change=()=>{checked.delete(f.id);f.deleted=!f.deleted;close();notify(f.deleted?'已移入预览回收站，可随时恢复':'已恢复到文件列表');};
    const action=f.deleted?$('#restore-file'):$('#trash-file');action.onclick=change;
    if(f.file&&['txt','md','csv'].includes(extension(f.name))&&f.size<1048576){try{const text=await f.file.text();if(ui.disposed||selected!==id||!panel.isConnected)return;preview.textContent='';const pre=document.createElement('pre');pre.textContent=text;preview.append(pre);}catch{if(selected===id)notify('本地文件读取失败，仍可下载原文件');}}
  }
  function objectURL(f){if(!urls.has(f.id))urls.set(f.id,URL.createObjectURL(f.file||new Blob([f.text],{type:'text/plain;charset=utf-8'})));return urls.get(f.id);}
  function addFiles(list){
    /* FIX-09：`input.files` 是**活的对象** —— 调用方随后 `input.value=''` 会把它清空。
       这里**同步快照**成数组再往下传；`realUpload` 是 async（先 await 动态 import），
       等它读列表时文件早没了 → 上传弹窗都不弹（用户报「上传按钮无法上传」）。 */
    const picked=Array.from(list||[]);
    if(realMode){realUpload(picked);return;}
    if(!showExamples)return;const incoming=picked;if(!incoming.length)return;const date=new Date().toLocaleString('sv-SE').slice(0,16);for(const file of incoming)files.unshift({id:crypto.randomUUID(),name:file.name,tags:[],source:'本地选择',owner:'我',date,size:file.size,file,deleted:false,sample:false});view='all';$('#search').value='';$('#type').value='';close();notify(`已加入 ${incoming.length} 个本地文件，尚未上传服务器`);
  }
  /* 当前文件与未来邮件附件共用同一个详情弹窗。 */
  let openingDetail=false;
  async function realDetail(f,editField=null){
    if(editor&&!editField)return editor.open(f);
    if(openingDetail)return;openingDetail=true;
    selected=f.id;render();
    try{return await window.openFileCenterDetail({ui,file:f,editField,onChanged:refreshChangedFile});}finally{openingDetail=false;}
  }
  if(window.mountFileEditingWorkspace&&!showExamples)editor=window.mountFileEditingWorkspace({ui,host,
    getDirectories:()=>directories,getDirectory:()=>directoryId||'files-root',
    onChanged:refreshChangedFile,
    onInfo:file=>window.openFileCenterDetail({ui,file,onChanged:async(row,change)=>{
      await refreshChangedFile(row,change);window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:row.name,source:'file-center'}}));
    }})});
  $('#upload').onclick=()=>$('#file-picker').click();$('#file-picker').onchange=e=>{addFiles(e.target.files);e.target.value='';};
  async function loadResults(){
    if(!realMode){close();return;}
    selected=null;$('#details').hidden=true;files=[];
    const loading=realRefresh();render();
    try{if(await loading){render();updateFilterOptions();}}catch(e){if(!ui.disposed){render();notify('文件读取失败：'+e.message);}}
  }
  // C10-A + BASE967-16：筛选下拉 ——
  // ① 候选用 list_collaboration_people()（不从前端结果聚合，那是假筛选）
  // ② 关联邮件下拉：先留空，等 C 的自动入库数据到了再填（当前没有邮件来源文件）
  // ③ **BASE967-16 部门身份项**：下拉要**同时装员工身份和部门身份**，
  //   按 `kind` 分组/标 label。改之前只装员工，导致筛 Administrator 这种部门身份 0 条
  //   （E 域 owner_subject_aliases 已修互认，A 这边却没把部门项装出来 = 0 命中）。
  // ④ 等 B 的 `include_groups` 改完接口，下方这版**结构**就位，调一次取数就接上。
  // 关联邮件下拉：先留空，等 C 的自动入库数据到了再填（当前没有邮件来源文件）
  async function loadOwnerFilterOptions(){
    const of=document.querySelector('#owner-filter');
    if(!of)return;
    try{
      const r=await fetch('/api/platform/services/identity.list_collaboration_people/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{include_groups:true}})});
      const body=await r.json().catch(()=>({}));
      // 员工与部门分别读取people/groups；旧混合回包仅作兼容。
      // 旧回包只有员工项 —— 当作全是员工（向后兼容）。
      if(!r.ok)throw new Error(body?.error||'所有人目录读取失败');
      const directory=body?.result||body;
      const raw=Array.isArray(directory?.people)?directory.people:[];
      const employees=raw.filter((p)=>!p.kind||p.kind==='employee');
      const departments=Array.isArray(directory?.groups)?directory.groups:raw.filter((p)=>p.kind==='department');
      const cur=of.value;
      of.innerHTML='<option value="">全部所有人</option>'
        + (employees.length?`<option value="" disabled>── 员工 ──</option>${employees.map((p)=>{
          const v=escape(p.identity_id||p.id||p.name);
          const lbl=escape(p.display_name||p.user_name||p.username||p.name||v);
          return `<option value="${v}" data-kind="employee" data-source="identity">${lbl}</option>`;
        }).join('')}`:'')
        + (departments.length?`<option value="" disabled>── 部门 ──</option>${departments.map((p)=>{
          const v=escape(p.id||p.department_id||p.name);
          const lbl=escape(p.display_name||p.department_name||p.name||v);
          return `<option value="${v}" data-kind="department" data-source="department">${lbl}（部门）</option>`;
        }).join('')}`:'');
      of.value=cur;
      // BASE967-16：同一次取数，顺手填显示名映射（不再单独请求人员目录）。
      // 三键都建索引：identity_id / username(collaboration_key) / user_name(frappe user)，
      // 与服务端 `_owner_subject_aliases()` 的互认键一致。
      ownerNameById.clear();
      for(const p of employees){
        const label=String(p.display_name||p.user_name||p.username||'').trim();
        if(!label)continue;
        for(const key of[p.identity_id,p.username,p.user_name]){
          const k=String(key||'').trim();
          if(k&&!ownerNameById.has(k))ownerNameById.set(k,label);
        }
      }
      // 部门项也填进映射 —— 列表 owner_subject_kind==='Department' 时拿到原始 dept_id
      // 就能查显示名（不是「未配置」），不用等下一次取数。
      for(const d of departments){
        const id=String(d.id||d.department_id||'').trim();
        const lbl=String(d.display_name||d.department_name||'').trim();
        if(id&&lbl&&!ownerNameById.has(id))ownerNameById.set(id,lbl);
      }
      // 人员目录是显示名的唯一来源：拿到之后要重画一次，否则列表/详情还是旧文案。
      if(realMode)void render();
    }catch{of.title='所有人目录读取失败，请刷新重试';}
  }
  function updateFilterOptions(){
    // 关联邮件下拉从当前数据聚合（仅用于展示已出现的邮件来源，不替代服务端筛选）
    const mf=document.querySelector('#mail-filter');
    if(mf){
      const mails=new Set(files.map(f=>f.relatedMail).filter(Boolean));
      const cur=mf.value;
      mf.innerHTML='<option value="">所有关联邮件</option>'+[...mails].map(id=>`<option value="${escape(id)}">${escape(id)}</option>`).join('');
      mf.value=cur;
    }
  }
  const resetResults=()=>{clearTimeout(searchTimer);queryReads?.cancel();page=1;checked.clear();loadResults();};
  const scheduleSearch=()=>{clearTimeout(searchTimer);querySequence++;queryReads?.cancel();if(showExamples){resetResults();return;}searchTimer=setTimeout(resetResults,250);};
  $('#directory-filter').onchange=()=>{directoryId=$('#directory-filter').value;syncDirectoryControls();resetResults();};
  $('#directory-create').onclick=()=>openDirectoryEditor();$('#directory-rename').onclick=()=>openDirectoryEditor(true);
  $('#directory-access').onclick=openDirectoryAccess;
  $('#search').oninput=()=>{if(!searchComposing)scheduleSearch();};
  $('#search').addEventListener('compositionstart',()=>{searchComposing=true;clearTimeout(searchTimer);querySequence++;queryReads?.cancel();});
  $('#search').addEventListener('compositionend',()=>{searchComposing=false;scheduleSearch();});
  $('#type').onchange=resetResults;
  $('#clear').onclick=()=>{$('#search').value='';$('#type').value='';const of=document.querySelector('#owner-filter');const mf=document.querySelector('#mail-filter');if(of)of.value='';if(mf)mf.value='';directoryId='';setRelated(null);syncDirectoryControls();resetResults();if(!realMode&&!showExamples)probeReal();};
  // C10-A: 所有人/关联邮件筛选
  const ownerFilterEl=document.querySelector('#owner-filter');
  const mailFilterEl=document.querySelector('#mail-filter');
  if(ownerFilterEl)ownerFilterEl.addEventListener('change',resetResults);
  if(mailFilterEl)mailFilterEl.addEventListener('change',resetResults);
  void loadOwnerFilterOptions();
  // C10-A: 点关联邮件 → 打开来源邮件（需权限）
  // C 确认路由：?mail=<id> + go('mail')，不是 ?object=（mail-center.js 读 location.search 的 mail 参数）
  host.addEventListener('click',e=>{
    const btn=e.target.closest('[data-mail]');
    if(!btn)return;
    const mailId=btn.getAttribute('data-mail');
    if(!mailId)return;
    const url=new URL(location.href);
    url.searchParams.set('mail',mailId);
    history.pushState(null,'',url);
    if(typeof go==='function')go('mail');else location.hash='#/mail';
  },{signal:ui.signal});
  host.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;resetResults();});
  host.querySelectorAll('[data-layout]').forEach(b=>b.onclick=()=>{layout=b.dataset.layout;render();});
  $('#group-by').onchange=()=>render();$('#page-size').onchange=resetResults;
  $('#previous-page').onclick=()=>{page--;checked.clear();loadResults();};$('#next-page').onclick=()=>{page++;checked.clear();loadResults();};
  $('#select-page').onchange=e=>{pageRows().forEach(f=>e.target.checked?checked.add(f.id):checked.delete(f.id));render();};
  async function runBatch(batch){
      if(batchBusy)return;
      let completed=0,refreshError='';const failed=[];batchBusy=true;updateSelection();
      if(batchDialog)batchDialog.querySelector('[data-batch-retry]').disabled=true;
      try{
        for(const item of batch.items){
          if(ui.disposed)return;
          try{const receipt=await realAction(batch.action,item.payload,item.key);if(receipt.file!==item.id||receipt.status!==(batch.action==='files.restore'?'Active':'Recycled'))throw Error('状态回执不完整');checked.delete(item.id);completed++;}
          catch(e){if(ui.disposed)return;const unknown=item.unknown||uncertainError(e);failed.push({...item,error:e.message,unknown,key:unknown?item.key:crypto.randomUUID()});}
        }
        try{await realRefresh();}catch(e){refreshError='；列表刷新失败：'+e.message;}
        if(ui.disposed)return;
        failed.forEach(f=>checked.add(f.id));
        close();render();
        pendingBatch=failed.some(f=>f.unknown)?{action:batch.action,items:failed}:null;
        if(pendingBatch){
          if(!batchDialog){batchDialog=ui.modal('<header><h2>批量操作结果待核实</h2></header><main><p data-batch-status role="status"></p><p>原操作已保留；先核实结果，不会重新办理已成功文件。</p></main><footer><button class="btn" data-batch-retry>核实并重试原操作</button></footer>',{native:true,className:'file-operation-dialog'});ui.guardModal(batchDialog,()=>{notify('结果待核实，请先重试原操作');return false;});batchDialog.querySelector('[data-batch-retry]').onclick=()=>runBatch(pendingBatch);}
          batchDialog.querySelector('[data-batch-status]').textContent=failed.map(f=>(files.find(row=>row.id===f.id)?.name||f.id)+'：'+f.error).join('；');
        }else if(batchDialog){ui.closeModal(true);batchDialog=null;}
        notify(`已办理 ${completed} 个，未完成 ${failed.length} 个${failed.length?'；失败项保留选中，可重试：'+failed[0].error:''}${refreshError}`);
      }finally{batchBusy=false;if(!ui.disposed){updateSelection();if(batchDialog)batchDialog.querySelector('[data-batch-retry]').disabled=false;}}
  }
  $('#batch-change').onclick=async()=>{
    if(batchBusy||choosingRestore)return;
    const count=checked.size;
    if(realMode){
      let batch=pendingBatch;
      if(!batch){
        const action=view==='trash'?'files.restore':'files.recycle';
        const selectedFiles=[...checked].map(id=>files.find(f=>f.id===id));
        let keep=null;
        if(action==='files.restore'&&selectedFiles.some(f=>f?.restoreRelations)){
          choosingRestore=true;$('#batch-change').disabled=true;
          try{keep=await window.chooseFileRestorePolicy(ui);}finally{choosingRestore=false;if(!ui.disposed)updateSelection();}
          if(keep===null||ui.disposed)return;
        }
        batch={action,items:selectedFiles.filter(Boolean).map(f=>({id:f.id,payload:{file:f.id,...(keep!==null&&f.restoreRelations?{keep_relations:keep,expected_modified:f.modified}:{})},key:crypto.randomUUID()}))};
      }
      await runBatch(batch);
      return;
    }
    files.filter(f=>checked.has(f.id)).forEach(f=>f.deleted=view!=='trash');checked.clear();close();notify(`已${view==='trash'?'恢复':'移入预览回收站'} ${count} 个文件`);
  };
  $('#sort').onclick=()=>{descending=!descending;$('#sort').textContent=`更新时间 ${descending?'↓':'↑'}`;resetResults();};
  host.addEventListener('keydown',e=>{if(e.key==='Escape'&&!ui.modalCount){const old=selected;close();host.querySelector(`[data-open="${old}"]`)?.focus();}},{signal:ui.signal});
  host.addEventListener('dragenter',e=>{if(Array.from(e.dataTransfer?.types||[]).includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}},{signal:ui.signal});
  host.addEventListener('dragover',e=>{if(Array.from(e.dataTransfer?.types||[]).includes('Files'))e.preventDefault();},{signal:ui.signal});
  /* 拖走（离开窗口）就收遮罩。计数器不许跑成负数 —— 浏览器在子元素上也会派发 dragleave。 */
  host.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drop-overlay').hidden=true;},{signal:ui.signal});
  host.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;addFiles(e.dataTransfer?.files||[]);},{signal:ui.signal});
  $('#examples-toggle').textContent=showExamples?'退出交互样例':'查看交互样例';
  $('#upload').disabled=!showExamples;
  $('#upload').textContent=showExamples?'选择本地文件（不上传）':'正在读取…';
  $('#examples-toggle').onclick=()=>{ui.toggleExamples(window.mountFileCenter,!showExamples);};
  render();
  if(!showExamples)probeReal(); // 显式样例独立于真实连接，不因探测失败清空样例。
  return dispose;
};
RENDER['file-center'] = page => {
  return window.mountFileCenter(page.host, {signal:page.signal});
};
