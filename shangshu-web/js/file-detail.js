/* Modern organization attribution is authoritative; legacy owner fields are display fallback only. */
window.fileCenterOwnership = function(row) {
  const attribution=[row.ownership,row.attribution].find(value=>value&&['personal','department'].includes(value.level));
  if(attribution){
    if(attribution.level==='department')return{kind:'Department',subject:String(attribution.department||''),label:String(attribution.department_title||'')};
    return{kind:'Employee',subject:String(attribution.owner_user||''),label:''};
  }
  return{kind:String(row.owner_subject_kind||''),subject:String(row.owner_subject||''),label:''};
};
/* 文件与邮件共用的文件详情。只读快照固定版本，不复制文件域的写入规则。 */
window.renderFileDocumentPreview = function(surface,result) {
  if(!Array.isArray(result.blocks)||!Array.isArray(result.warnings))throw Error('文档预览回执不完整');
  surface.textContent='';
  for(const message of result.warnings){const notice=document.createElement('p');notice.className='file-preview-warning';notice.textContent=message;surface.append(notice);}
  for(const block of result.blocks){
    if(block.type==='paragraph'){const p=document.createElement('p');p.className='file-preview-paragraph';p.textContent=block.text;surface.append(p);}
    else if(block.type==='table'){const table=document.createElement('table');table.className='file-preview-table';for(const cells of block.rows){const tr=document.createElement('tr');for(const value of cells){const td=document.createElement('td');td.textContent=value;tr.append(td);}table.append(tr);}surface.append(table);}
  }
  if(!result.blocks.length){const blank=document.createElement('p');blank.textContent='文档没有可显示的正文，请下载原件核对。';surface.append(blank);}
};
window.loadFilePdfReader = ()=>import('./file-pdf.mjs?v=20261028-reader-6');
window.clearFileMediaPreview = surface=>{surface?._disposeFileMedia?.();if(surface)delete surface._disposeFileMedia;};
// 标签页和详情共用阅读器。缩放/旋转只是本地视图，不生成文件版本。
window.renderFileMediaPreview = function(surface,{url,name,kind,current=()=>true}) {
  window.clearFileMediaPreview(surface);
  surface.textContent='';
  if(kind==='pdf'){
    let disposed=false,release;
    surface._disposeFileMedia=()=>{disposed=true;release?.();};
    surface.textContent='正在加载PDF阅读器…';
    window.loadFilePdfReader().then(({mountPdf})=>{
      if(!disposed&&current())release=mountPdf(surface,{url,name,current:()=>!disposed&&current()});
    }).catch(()=>{if(!disposed&&current())surface.textContent='PDF阅读器加载失败，请重新查看此版本或下载原件。';});
    return;
  }
  const box=document.createElement('div');box.className='file-image-preview';
  const toolbar=document.createElement('div');toolbar.className='file-image-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label',kind==='image'?'图片阅读':'PDF阅读');
  const open=document.createElement('a');open.className='btn';open.href=url;open.target='_blank';open.rel='noopener';open.textContent='独立打开';toolbar.append(open);box.append(toolbar);surface.append(box);
  toolbar.insertAdjacentHTML('afterbegin','<button class="btn" data-image-zoom="out" aria-label="缩小图片" disabled>−</button><span data-image-scale role="status">正在解码…</span><button class="btn" data-image-zoom="in" aria-label="放大图片" disabled>＋</button><button class="btn" data-image-zoom="fit" disabled>适应窗口</button><button class="btn" data-image-zoom="actual" disabled>原始大小</button><button class="btn" data-image-rotate disabled>旋转查看</button>');
  const viewport=document.createElement('div');viewport.className='file-image-viewport';const stage=document.createElement('div');stage.className='file-image-stage';const img=document.createElement('img');img.alt=name;stage.append(img);viewport.append(stage);box.append(viewport);
  const label=toolbar.querySelector('[data-image-scale]'),buttons=[...toolbar.querySelectorAll('button')];let scale=null,rotation=0;
  function render(){
    if(!current())return;
    const swapped=rotation%180!==0,nw=img.naturalWidth,nh=img.naturalHeight;
    const fit=Math.min(1,(viewport.clientWidth||nw)/(swapped?nh:nw),(viewport.clientHeight||nh)/(swapped?nw:nh));
    const ratio=scale===null?fit:scale/100,w=Math.round(nw*ratio),h=Math.round(nh*ratio);
    stage.style.width=(swapped?h:w)+'px';stage.style.height=(swapped?w:h)+'px';img.style.width=w+'px';img.style.height=h+'px';img.style.transform='translate(-50%,-50%) rotate('+rotation+'deg)';
    img.classList.toggle('is-zoomed',scale!==null);label.textContent=scale===null?'适应窗口':scale+'%';
    buttons.forEach(b=>b.disabled=b.dataset.imageZoom==='in'?scale>=400:b.dataset.imageZoom==='out'?scale!==null&&scale<=25:false);
  }
  img.onload=()=>render();img.onerror=()=>{if(current())surface.textContent='图片无法解码，可能已损坏。请下载原件核对。';};
  buttons.forEach(b=>b.onclick=()=>{
    if(!current())return;
    if(b.hasAttribute('data-image-rotate'))rotation=(rotation+90)%360;
    else if(b.dataset.imageZoom==='fit')scale=null;
    else if(b.dataset.imageZoom==='actual')scale=100;
    else scale=Math.max(25,Math.min(400,(scale??Math.round(parseFloat(img.style.width)/img.naturalWidth*100))+(b.dataset.imageZoom==='in'?25:-25)));
    render();
  });img.src=url;
};
window.readFileCenterVersions = async function(file,signal) {
  const response=await fetch('/api/platform/services/files.versions/invoke',{signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{file}})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok===false)throw Object.assign(Error(data.error||'文件版本读取失败'),{status:response.status});
  return data.result||data;
};
// 缩略图只读现有受权版本；不新存摘要，不预下载大原件。
window.readFileCenterThumbnail = async function(file,signal) {
  const ext=(file.name||'').split('.').pop().toLowerCase();
  if(!['md','txt','csv','docx','png','jpg','jpeg'].includes(ext)||!file.size||file.size>1024*1024)return null;
  let pinned=file.currentFile;
  if(!pinned){
    const data=await window.readFileCenterVersions(file.id,signal);
    if(data.file?.name!==file.id||!data.versions?.[0]?.frappe_file)throw Error('文件版本不可读取');
    pinned=data.versions[0].frappe_file;
  }
  const reference={ref_doctype:'Shangshu File Center File',ref_name:file.id,file:pinned};
  if(ext==='docx'){
    const response=await fetch('/api/platform/services/platform.file.preview/invoke',{signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:reference})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok===false)throw Error(data.error||'预览不可读取');
    const result=data.result||data;
    return {kind:'text',text:(result.blocks||[]).map(b=>b.text||'').filter(Boolean).join('\n').slice(0,400)};
  }
  const response=await fetch('/api/platform/file-content?'+new URLSearchParams({ref:reference.ref_doctype,ref_name:file.id,file:pinned}),{signal});
  if(!response.ok)throw Error('预览不可读取');
  if(['png','jpg','jpeg'].includes(ext))return {kind:'image',blob:await response.blob()};
  // 有流时只取正文前缀，随后取消；不会把整篇文本保存到前端缓存。
  let text='';
  if(response.body?.getReader){
    const reader=response.body.getReader(),decoder=new TextDecoder();let length=0;
    try{while(length<4096){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;text+=decoder.decode(value.slice(0,4096),{stream:true});}text+=decoder.decode();}
    finally{await reader.cancel();}
  }else text=await response.text();
  return {kind:'text',text:text.slice(0,400)};
};
// 文件元信息仍走原确认接口；这里只核对已授权字段和文件修订、呈现前后值与真实读回。
window.shangshuConfirmationPresenters=window.shangshuConfirmationPresenters||Object.create(null);
window.shangshuConfirmationPresenters['files.edit_cells']={
  action:'files.edit_cells',service:'files.cells',title:'修改表格',
  async read(confirm,version){
    const p=confirm.payload||{};
    if(!p.file||!p.expected_modified||!Number.isInteger(p.expected_version)||!Array.isArray(p.changes)||!p.changes.length)throw Error('文件版本或修改明细缺失，请重新提案');
    const response=await fetch('/api/platform/services/'+this.service+'/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{file:p.file,version,changes:p.changes}})});
    const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||'无法核对原表格');
    const result=data.result||data;if(result.file?.name!==p.file||result.version!==version||!Array.isArray(result.changes)||result.changes.length!==p.changes.length)throw Error('原件版本回执不完整');
    return result;
  },
  lines(changes,readback=false){
    const display=value=>value===null?'空':String(value?.v??'');
    return changes.map(c=>`${c.sheet} · 第${c.row}行第${c.column}列：${display(c.before)}${readback?'':' → '+display(c.after)}`);
  },
  diff(changes){
    const display=value=>value===null?'空':String(value?.v??'');
    return changes.map(c=>{
      let column=c.column,label='';
      while(column>0){column--;label=String.fromCharCode(65+column%26)+label;column=Math.floor(column/26);}
      return {label:`${c.sheet} · ${label}${c.row}`,before:display(c.before),after:display(c.after)};
    });
  },
  async prepare(confirm){
    const p=confirm.payload,result=await this.read(confirm,p.expected_version);
    /* ⚠️ **走公共壳的「清单口」**（同一轮里只读一次）；
       壳的那个口不在（判据假世界）⇒ 照旧自己读。 */
    const catalog=window.shangshuPlatformCatalog;
    const data=catalog?await catalog.actions().catch(()=>({list:[]})):await (await fetch('/api/platform/actions')).json();
    if(!data.list?.some(a=>a.id===this.action&&a.executable)||result.file.can_edit!==true||result.file.status!=='Active'||!result.editable)throw Error('当前没有文件内容修改权限');
    if(result.file.version!==p.expected_version||result.file.modified!==p.expected_modified)throw Error('文件版本或修订已变化，请重新提案');
    return {title:this.title,resource:{name:result.file.file_name,version:p.expected_version},changes:this.diff(result.changes),confirmLabel:'确认修改',lines:this.lines(result.changes),objectId:'files.file',recordName:p.file};
  },
  matches(c,expected){return c.sheet===expected.sheet&&c.row===expected.row&&c.column===expected.column&&JSON.stringify(c.before)===JSON.stringify(expected.value);},
  async afterExecution(confirm,response){
    const p=confirm.payload,receipt=response.result;
    if(receipt?.file!==p.file||receipt.version!==p.expected_version+1)throw Error('保存版本未核实');
    const result=await this.read(confirm,receipt.version);
    if(result.changes.some((c,i)=>!this.matches(c,p.changes[i])))throw Error('保存内容与确认值不一致，请核实原件');
    window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:p.file}}));
    return {title:`已保存 · 第${receipt.version}版`,resource:{name:result.file.file_name,version:receipt.version},lines:this.lines(result.changes,true),tone:'success',objectId:'files.file',recordName:p.file};
  },
};
// 同一确认/版本读回流程，仅正文差异的展示不同；不另加AI写入口。
window.shangshuConfirmationPresenters['files.edit_paragraphs']={
  ...window.shangshuConfirmationPresenters['files.edit_cells'],
  action:'files.edit_paragraphs',service:'files.paragraphs',title:'修改DOCX正文',
  lines(changes,readback=false){return changes.map(c=>`正文第${c.number}段：${c.before||'空'}${readback?'':' → '+(c.after||'空')}`);},
  diff(changes){return changes.map(c=>({label:`正文第${c.number}段`,before:c.before||'空',after:c.after||'空'}));},
  matches(c,expected){return c.key===expected.key&&c.before===expected.text;},
};
window.shangshuConfirmationPresenters['files.update_meta']={
  async summary(confirm,checked){
    const p=confirm.payload||{};
    if(typeof p.file!=='string'||!p.file||checked&&!p.expected_modified)throw Error('文件或修订缺失，请重新提案。');
    const catalog=window.shangshuPlatformCatalog;
    const [{file:row},data]=await Promise.all([window.readFileCenterVersions(p.file),catalog?catalog.actions().catch(()=>({list:[]})):fetch('/api/platform/actions').then(r=>r.json())]);
    const action=data.list?.find(item=>item.id==='files.update_meta'&&item.executable);
    if(!action||row?.name!==p.file||row.can_edit!==true||row.metadata_revision!==true||row.status!=='Active')throw Error('当前没有文件修改权限，请重新核对。');
    if(checked&&row.modified!==p.expected_modified)throw Error('文件修订已变化，请重新提案。');
    const fields=action.input_schema?.properties||{},lines=[];
    const display=value=>value==null||value===''?'空':Array.isArray(value)?value.join('；')||'空':String(value);
    let directories;
    for(const key of Object.keys(p)){
      if(key==='file'||key==='expected_modified')continue;
      if(!fields[key]?.title||!Object.hasOwn(row,key))throw Error('文件字段已变化，请重新提案。');
      let before=row[key],after=p[key];
      if(key==='directory_id'){
        before=row.directory||'/';
        if(checked){
          directories=directories||await fetch('/api/platform/services/files.directories/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{}})}).then(async r=>{const d=await r.json();if(!r.ok||d.ok===false)throw Error('目录无法核对');return (d.result||d).directories;});
          const directory=directories?.find(d=>d.name===after);if(!directory)throw Error('目标目录不可用，请重新提案。');after=directory.path;
        }
      }
      lines.push(fields[key].title+'：'+(checked?display(before)+' → '+display(after):display(before)));
    }
    if(!lines.length)throw Error('没有可核对的文件修改。');
    return {title:(checked?'修改文件 · ':'已保存 · ')+row.file_name,lines,objectId:'files.file',recordName:row.name,tone:'success'};
  },
  prepare(confirm){return this.summary(confirm,true);},
  async afterExecution(confirm){const receipt=await this.summary(confirm,false);window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:receipt.recordName}}));return receipt;},
};
window.readFileCenterContent = async function(file) {
  const reject=message=>{throw Object.assign(Error(message),{status:400});};
  if(!/\.(pdf|docx|xlsx|png|jpe?g|txt|md|csv|zip)$/i.test(file.name))reject('不支持此格式；支持 PDF、DOCX、XLSX、PNG、JPG/JPEG、TXT、MD、CSV、ZIP');
  if(!file.size)reject('文件为空，未上传');
  if(file.size>20*1024*1024)reject('单文件不能超过 20MB，未上传');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
    reader.onerror=()=>reject(Object.assign(Error('本地读取失败，未上传'),{status:400}));reader.readAsDataURL(file);
  });
};
window.chooseFileRestorePolicy = function(ui) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;resolve(value);};
    const modal=ui.modal('<header><h2>恢复文件</h2></header><main><label class="file-access-choice"><input type="checkbox" data-restore-keep checked> 保留原业务关联</label><p>取消勾选只解除文件与业务记录的关系，不删除记录、不清除已填写字段，也不改变已发邮件。</p></main><footer><button class="btn" data-restore-cancel>取消</button><button class="btn btn-pri" data-restore-confirm>确认恢复</button></footer>',{native:true,className:'file-operation-dialog',onClose:()=>finish(null)});
    ui.onDispose(()=>finish(null));
    modal.querySelector('[data-restore-cancel]').onclick=()=>ui.closeModal(true);
    modal.querySelector('[data-restore-confirm]').onclick=()=>{const keep=modal.querySelector('[data-restore-keep]').checked;finish(keep);ui.closeModal(true);};
  });
};
window.openFileCenterDetail = async function({ui, file, version=null, snapshot=false, reference=null, editField=null, onChanged=async()=>{}}) {
  const esc=ui.escape,signal=ui.signal;
  async function request(url,body){
    const response=await fetch(url,{signal,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const value=await response.json().catch(()=>({}));
    if(!response.ok||value.ok===false)throw Object.assign(Error(value.error||'读取或办理失败'),{status:response.status});
    return value.result||value;
  }
  const read=()=>window.readFileCenterVersions(file.id||file.name,signal);
  let data;
  try{
    if(reference){
      if(!reference.doctype||!reference.name||!reference.file)throw Error('附件引用不完整');
      snapshot=true;version=null;
      data={file:{name:reference.name,file_name:file.name,owner:file.owner||'—',modified:file.date||'—'},versions:[{version_no:0,frappe_file:reference.file}]};
    }else data=await read();
    if(!Array.isArray(data.versions)||!data.versions.length)throw Error('文件版本回执不完整');
  }
  catch(error){if(!ui.disposed)ui.notify('无法打开文件详情：'+error.message);return null;}
  if(ui.disposed)return null;
  let row=data.file||{name:file.id,file_name:file.name,directory:file.source,tags:file.tags||[],owner:file.owner,owner_subject_kind:file.ownerSubjectKind||'',owner_subject:file.ownerSubject||'',related_mail:file.relatedMail||'',note:file.note||'',modified:file.date,status:file.status};
  const ownership=window.fileCenterOwnership(row);
  let versions=data.versions;
  let shown=version==null?versions[0]:versions.find(v=>Number(v.version_no)===Number(version));
  if(!shown){ui.notify('所引用的文件版本不可用，没有改为打开最新版本');return null;}
  if(snapshot)versions=[shown];
  const editable=!snapshot&&row.can_edit===true&&row.metadata_revision===true;
  const href=v=>'/api/platform/file-content?'+new URLSearchParams({ref:reference?.doctype||'Shangshu File Center File',ref_name:reference?.name||row.name,file:v.frappe_file});
  const versionTitle=v=>reference?(reference.label||'固定原件'):'第 '+v.version_no+' 版';
  const input=(key,label,value)=>`<label class="file-property"><span>${label}</span><input data-property="${key}" aria-label="${label}" value="${esc(value)}" readonly ${editable?'':'disabled'} title="${editable?'双击编辑，失焦保存':'只读'}"></label>`;
  const modal=ui.modal(`<header><h2>${esc(row.file_name)}</h2>${snapshot?'<span>快照 · 只读</span>':''}<button class="btn" data-detail-close aria-label="关闭文件详情">×</button></header>
    ${snapshot?`<p class="file-snapshot-note">${reference?'邮件保存的独立附件引用，不随文件库换版变化。':'原件固定为被引用的版本；目录和标签显示当前信息，在此不能修改。'}</p>`:''}
    <div class="file-detail-columns"><section class="file-properties" aria-label="文件信息与操作"><h3 class="file-properties-heading">文件信息</h3><div class="file-property-scroll">
      ${input('file_name','文件名称',row.file_name)}
      ${reference?'':`<label class="file-property"><span>所属目录</span><select data-property="directory_id" aria-label="所属目录" disabled><option value="${esc(row.directory_id||'')}">${esc(row.directory||'/')}</option></select></label>
      ${input('tags','标签',(row.tags||[]).join('；'))}${input('note','备注',row.note||'')}`}
      <h3>辅助字段与版本</h3><dl><dt>上传人</dt><dd>${esc(row.owner)}</dd><dt>所有人</dt><dd>${ownership.kind==='Department'?'<span class="file-tag file-tag-dept">部门</span> ':ownership.kind==='Employee'?'<span class="file-tag">员工</span> ':''}${esc(ownership.label||ownership.subject||'—')}</dd><dt>关联邮件</dt><dd>${row.related_mail?`<button class="file-link" data-mail="${esc(row.related_mail)}">${esc(row.related_mail)}</button>`:'—（非邮件来源）'}</dd><dt>更新时间</dt><dd data-modified>${esc(row.modified)}</dd></dl>
      <div class="file-version-list">${versions.map(v=>`<div class="file-version-row"><strong>${esc(versionTitle(v))}</strong><small>${esc(v.uploaded_at||'')}</small><div><button class="btn" data-version-preview="${esc(v.version_no)}" ${snapshot&&v!==shown?'disabled':''}>查看此版本</button><a class="btn" data-version-download href="${href(v)}" download>下载此版本</a></div></div>`).join('')}</div>
    </div><footer class="file-detail-actions">${editable?'<button class="btn" data-reupload>重新上传</button>':''}<a class="btn" data-current-download href="${href(shown)}" download>下载</a>${editable?'<button class="btn file-detail-danger" data-recycle>移入回收站</button>':!snapshot&&row.can_restore?'<button class="btn file-detail-danger" data-restore>恢复文件</button>':''}</footer>
    <div class="file-save-state"><span role="status" data-save-state></span><button class="btn" data-retry hidden>重试原操作</button><button class="btn" data-discard hidden>放弃修改并关闭</button></div>
    </section><section class="file-detail-preview" aria-label="文件预览"><div class="file-preview-heading"><span>文件预览</span><span data-preview-heading></span></div><div data-file-visual></div></section></div>`,{native:true,className:'file-detail-dialog',onClose:()=>clearUrls(),onEscape:event=>{
      const input=event.target.closest('[data-property]');
      if(!input||input.tagName!=='INPUT'||input.readOnly||busy||attempt)return false;
      input.onkeydown(event);return true; // 第一按取消字段，下一按才关闭详情。
    }});
  const $=selector=>modal.querySelector(selector),queue=new Map(),urls=new Set();
  let attempt=null,busy=false,uncertain=false,failed=false,previewSequence=0,discardConfirmed=false;
  const alive=()=>!ui.disposed&&modal.isConnected;
  const controls=()=>Array.from(modal.querySelectorAll('[data-property]'));
  const valueOf=el=>el.dataset.property==='tags'?el.value.split(/[；;]/).map(x=>x.trim()).filter(Boolean):el.value.trim();
  const different=(a,b)=>JSON.stringify(a??'')!==JSON.stringify(b??'');
  const dirty=()=>controls().some(el=>!el.disabled&&different(valueOf(el),row[el.dataset.property]));
  const clearUrls=()=>{window.clearFileMediaPreview($('[data-file-visual]'));for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
  ui.onDispose(clearUrls);
  window.addEventListener('shangshu:before-object-change',event=>{
    if(alive()&&!snapshot&&event.detail?.object_id==='files.file'&&(busy||attempt||dirty())){event.preventDefault();ui.notify('文件还有人工修改，请先保存或放弃');}
  },{signal});
  window.addEventListener('shangshu:object-changed',async event=>{
    if(!alive()||snapshot||event.detail?.object_id!=='files.file'||event.detail.name!==row.name)return;
    if(busy||attempt||dirty()){state('AI 已保存，当前人工输入已保留；请先处理修改');return;}
    try{
      const latest=await read();if(!alive()||busy||attempt||dirty())return;
      if(latest.file?.name!==row.name)throw Error('文件回执不完整');Object.assign(row,latest.file);
      controls().forEach(el=>{el.value=el.dataset.property==='tags'?(row.tags||[]).join('；'):row[el.dataset.property]||'';});
      $('h2').textContent=row.file_name;$('[data-modified]').textContent=row.modified;state('AI 修改已保存并读回');
    }catch{if(alive())state('AI 已保存，详情读回失败；请关闭后刷新，不要重复提交');}
  },{signal});
  ui.guardModal(modal,()=>{if(busy||attempt||dirty()){ui.notify('还有未保存修改或待核实操作，请先处理');return false;}return true;});
  $('[data-detail-close]').onclick=()=>ui.closeModal();
  function state(message){if(!alive())return;$('[data-save-state]').textContent=message;$('[data-retry]').hidden=busy||(!failed&&!uncertain);$('[data-discard]').hidden=busy||uncertain||(!dirty()&&!failed);}
  async function changed(action,receipt){try{await onChanged(row,{action,receipt});}catch{ui.notify('操作已完成，列表刷新失败，请稍后刷新');}}
  async function drain(){
    if(busy||!alive())return;
    const tags=controls().find(el=>el.dataset.property==='tags');
    if(!attempt&&tags&&(valueOf(tags).length>10||valueOf(tags).some(tag=>Array.from(tag).length>20))){failed=true;state('标签最多 10 个，每个不超过 20 字；请缩短后重试');return;}
    if(!attempt){const entry=queue.entries().next().value;if(!entry)return;const [key,value]=entry;queue.delete(key);attempt={key,value,payload:{file:row.name,expected_modified:row.modified,[key]:value},id:crypto.randomUUID(),action:'files.update_meta'};}
    busy=true;failed=false;state('正在保存…');
    try{
      const receipt=await request('/api/platform/actions/'+attempt.action+'/execute',{payload:attempt.payload,confirmed:true,idempotency_key:attempt.id});
      if(!alive())return;
      if(receipt.file!==row.name)throw Error('回执不完整，结果待核实');
      if(attempt.action==='files.new_version'&&!Number.isInteger(receipt.version))throw Error('版本回执不完整，结果待核实');
      if(attempt.action==='files.recycle'&&receipt.status!=='Recycled'||attempt.action==='files.restore'&&receipt.status!=='Active')throw Error('状态回执不完整，结果待核实');
      if(attempt.action==='files.update_meta'){
        if(!receipt.record?.modified||different(receipt.record[attempt.key],attempt.value))throw Error('保存回执与输入不一致，结果待核实');
        Object.assign(row,receipt.record);$('h2').textContent=row.file_name;$('[data-modified]').textContent=row.modified;
      }
      const completed=attempt.action;attempt=null;uncertain=false;await changed(completed,receipt);state('已保存');
      if(completed!=='files.update_meta'){queue.clear();controls().forEach(el=>{el.disabled=true;});ui.closeModal(true);return;}
    }catch(error){
      if(!alive())return;failed=true;uncertain=uncertain||!(error.status>=400&&error.status<500&&![408,429].includes(error.status));
      if(!uncertain)attempt=null;
      state((uncertain?'结果待核实，请重试原操作；':'未保存，输入已保留；')+error.message);
    }finally{busy=false;if(alive()){state($('[data-save-state]').textContent);if(!failed&&queue.size)drain();}}
  }
  function enqueue(el){const key=el.dataset.property,value=valueOf(el);if(different(value,row[key]))queue.set(key,value);else queue.delete(key);discardConfirmed=false;if(!uncertain)drain();}
  controls().forEach(el=>{
    if(el.tagName==='SELECT'){el.onchange=()=>enqueue(el);return;}
    el.ondblclick=()=>{if(editable){el.readOnly=false;el.focus();el.select();}};
    el.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(el.readOnly)el.ondblclick();else el.blur();}if(e.key==='Escape'&&!busy&&!attempt){el.value=el.dataset.property==='tags'?row.tags.join('；'):row[el.dataset.property]||'';el.blur();}};
    el.onblur=()=>{el.readOnly=true;if(editable)enqueue(el);};
    el.oninput=()=>{discardConfirmed=false;state('修改尚未保存，离开字段后保存');};
  });
  $('[data-retry]').onclick=()=>{if(!attempt){controls().filter(el=>!el.disabled).forEach(el=>{if(different(valueOf(el),row[el.dataset.property]))queue.set(el.dataset.property,valueOf(el));});}drain();};
  $('[data-discard]').onclick=()=>{if(busy||uncertain)return;if(!discardConfirmed){discardConfirmed=true;$('[data-discard]').textContent='确认放弃并关闭';return;}queue.clear();attempt=null;clearUrls();ui.closeModal(true);};
  async function preview(v){
    const sequence=++previewSequence;shown=v;$('[data-current-download]').href=href(v);$('[data-preview-heading]').textContent=versionTitle(v);
    const surface=$('[data-file-visual]');surface.textContent='正在读取原件…';clearUrls();
    try{
      const ext=row.file_name.split('.').pop().toLowerCase();
      if(ext==='pdf'){
        let page=1,pageCount=1,pageGeneration=0;
        const showPage=async(target)=>{
          const generation=++pageGeneration;
          surface.textContent='正在读取预览页…';
          try{
            const result=await request('/api/platform/services/platform.file.pdf_page/invoke',{payload:{ref_doctype:reference?.doctype||'Shangshu File Center File',ref_name:reference?.name||row.name,file:v.frappe_file,page:target}});
            if(!alive()||sequence!==previewSequence||generation!==pageGeneration)return;
            if(result.mime_type!=='image/png'||typeof result.image_base64!=='string'||result.page!==target||!Number.isInteger(result.page_count))throw Error('PDF预览回执不完整');
            page=target;pageCount=result.page_count;surface.textContent='';
            const toolbar=document.createElement('div');toolbar.className='file-pdf-toolbar';toolbar.setAttribute('aria-label','PDF翻页');
            const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');
            previous.textContent='上一页';next.textContent='下一页';previous.className=next.className='btn';previous.disabled=page<=1;next.disabled=page>=pageCount;
            label.textContent=`第 ${page} / ${pageCount} 页`;label.setAttribute('role','status');
            previous.onclick=()=>showPage(page-1);next.onclick=()=>showPage(page+1);toolbar.append(previous,label,next);
            const image=document.createElement('img');image.alt=`PDF第${page}页`;image.style.maxWidth='100%';image.style.height='auto';image.src='data:image/png;base64,'+result.image_base64;
            surface.append(toolbar,image);
          }catch(error){if(alive()&&sequence===previewSequence&&generation===pageGeneration)surface.textContent=error.message+'；可重试查看此版本。';}
        };
        await showPage(1);return;
      }
      /* fast：在线预览上限 20MB —— PDF 走上面的逐页取图（不整份下载），其余格式仍在下载前挡一道。 */
      if(v.size>20*1024*1024)throw Error('在线预览上限20MB，请下载原件');
      if(ext==='docx'){
        const result=await request('/api/platform/services/platform.file.preview/invoke',{payload:{ref_doctype:reference?.doctype||'Shangshu File Center File',ref_name:reference?.name||row.name,file:v.frappe_file}});
        if(!alive()||sequence!==previewSequence)return;
        window.renderFileDocumentPreview(surface,result);return;
      }
      const response=await fetch(href(v),{signal});if(!response.ok)throw Error('原件读取失败（'+response.status+'）');
      const blob=await response.blob();if(!alive()||sequence!==previewSequence)return;
      if(blob.size>20*1024*1024)throw Error('在线预览上限20MB，请下载原件');
      if(['txt','md','csv'].includes(ext)){surface.textContent='';const pre=document.createElement('pre');pre.textContent=await blob.text();if(alive()&&sequence===previewSequence)surface.append(pre);}
      else if(['png','jpg','jpeg'].includes(ext)){
        const url=URL.createObjectURL(blob);urls.add(url);
        window.renderFileMediaPreview(surface,{url,name:row.file_name,kind:ext==='pdf'?'pdf':'image',current:()=>alive()&&sequence===previewSequence});
      }
      else surface.textContent='此格式暂不支持内嵌预览，请下载原件核对。';
    }catch(error){if(alive()&&sequence===previewSequence)surface.textContent=error.message+'；可重试查看此版本。';}
  }
  modal.querySelectorAll('[data-version-preview]').forEach(b=>b.onclick=()=>preview(versions.find(v=>String(v.version_no)===b.dataset.versionPreview)));
  preview(shown);
  if(editable){
    request('/api/platform/services/files.directories/invoke',{payload:{}}).then(result=>{if(!alive()||!Array.isArray(result.directories))return;const select=$('[data-property="directory_id"]');select.innerHTML=result.directories.map(d=>`<option value="${esc(d.name)}">${esc(d.path)}</option>`).join('');select.value=row.directory_id;select.disabled=!select.value;}).catch(()=>{if(alive())$('[data-property="directory_id"]').title='目录读取失败，暂不可移动';});
    $('[data-recycle]').onclick=()=>{if(busy||attempt||dirty()){state('请先完成文件修改');return;}const b=$('[data-recycle]');if(!b.dataset.confirm){b.dataset.confirm='1';b.textContent='确认移入回收站？';return;}attempt={action:'files.recycle',payload:{file:row.name},id:crypto.randomUUID()};drain();};
    const picker=document.createElement('input');picker.type='file';picker.hidden=true;modal.append(picker);
    $('[data-reupload]').onclick=()=>{if(busy||attempt||dirty()){state('请先完成文件修改');return;}picker.click();};
    picker.onchange=async()=>{const selected=picker.files[0];if(!selected)return;busy=true;state('正在读取文件…');try{const content=await window.readFileCenterContent(selected);if(alive()){attempt={action:'files.new_version',payload:{file:row.name,content_base64:content,note:'重新上传'},id:crypto.randomUUID()};}}catch(error){state(error.message);}finally{busy=false;picker.value='';if(attempt)drain();}};
  }
  if($('[data-restore]'))$('[data-restore]').onclick=async()=>{
    if(busy||attempt)return;
    const button=$('[data-restore]');button.disabled=true;
    try{
      const payload={file:row.name};
      if(row.restore_relations===1){const keep=await window.chooseFileRestorePolicy(ui);if(keep===null||!alive())return;payload.keep_relations=keep;payload.expected_modified=row.modified;}
      if(!alive())return;
      attempt={action:'files.restore',payload,id:crypto.randomUUID()};await drain();
    }finally{if(alive())button.disabled=false;}
  };
  if(editable&&editField==='file_name')$('[data-property="file_name"]').ondblclick();
  return {element:modal,close:()=>ui.closeModal()};
};
