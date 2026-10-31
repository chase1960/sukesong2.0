/* 文件中心内部工作区；编辑草稿仅在内存，正式内容仍由原文件域保存为新版本。 */
window.mountFileEditingWorkspace = function({ui,host,onChanged=async()=>{},onInfo=()=>{},getDirectories=()=>[],getDirectory=()=>''}) {
  const esc=ui.escape,tabs=new Map();let active=null;
  const list=document.createElement('div');list.className='file-list-pane';
  for(const child of Array.from(host.children))if(!child.matches('.file-heading,#notice,#drop-overlay'))list.append(child);
  const bar=document.createElement('nav');bar.className='file-document-tabs';bar.setAttribute('aria-label','打开的文件');bar.hidden=true;
  const area=document.createElement('div');area.className='file-editor-area';area.hidden=true;
  host.querySelector('.file-heading').after(bar,list,area);
  const alive=tab=>!ui.disposed&&tabs.get(tab.id)===tab;
  const dirty=tab=>!!tab.virtual||tab.workbook?.isDirty()||tab.document?.changes().length||tab.input&&tab.input.value!==tab.baseText;
  const busy=tab=>tab.loading||tab.saving||!!tab.attempt;
  function select(id){
    active=id;list.hidden=id!==null;area.hidden=id===null;
    for(const tab of tabs.values())tab.panel.hidden=tab.id!==id;
    drawTabs();
    updateContext();
  }
  function updateContext(){
    if(typeof chatSetBusinessContext!=='function')return;
    const tab=tabs.get(active);
    chatSetBusinessContext(tab&&!tab.virtual&&tab.row?.name?{module:'file-center',view:'file-editor',entity_type:'files.file',entity_id:tab.id,
      label:tab.row.file_name,metadata_revision:tab.shown?.version_no,editable_scope:'先通过授权目录读取固定文件版本；内容修改生成确认卡，不能覆盖人工未保存内容或改变业务状态。'}:
      {module:'file-center',view:'file-list',entity_type:'page',entity_id:'file-center',label:tab?.virtual?'未保存的新文件':'文件中心',editable_scope:tab?.virtual?'当前文件尚未保存，先由用户保存后再读取。':'查询已授权文件，修改须确认。'});
  }
  function drawTabs(){
    bar.hidden=tabs.size===0;
    bar.innerHTML='<button class="file-document-tab" data-file-list-tab'+(active===null?' aria-current="page"':'')+'>文件列表</button>'+
      Array.from(tabs.values(),tab=>`<span class="file-document-tab-item ${active===tab.id?'is-active':''}"><button class="file-document-tab" data-document-tab="${esc(tab.id)}" ${active===tab.id?'aria-current="page"':''} title="${esc(tab.row?.file_name||tab.label)}">${esc(tab.row?.file_name||tab.label)}${dirty(tab)?'<span class="file-draft-dot" aria-label="未保存">●</span>':''}</button><button class="file-document-close" data-close-document="${esc(tab.id)}" aria-label="关闭 ${esc(tab.row?.file_name||tab.label)}">×</button></span>`).join('');
    bar.querySelector('[data-file-list-tab]').onclick=()=>select(null);
    bar.querySelectorAll('[data-document-tab]').forEach(button=>button.onclick=()=>select(button.dataset.documentTab));
    bar.querySelectorAll('[data-close-document]').forEach(button=>button.onclick=()=>askClose(tabs.get(button.dataset.closeDocument)));
  }
  function state(tab,message){if(!alive(tab))return;tab.status.textContent=message;sync(tab);}
  function changed(tab){state(tab,dirty(tab)?'修改尚未保存 · 仅保存为文件版本':'与已保存内容一致 · 第 '+tab.shown.version_no+' 版');}
  function sync(tab){
    if(!alive(tab))return;
    tab.save.hidden=!tab.editable;tab.save.disabled=tab.loading||tab.saving||!dirty(tab)&&!tab.attempt;
    tab.save.textContent=tab.attempt?'核实并重试':'保存';
    tab.reload.disabled=busy(tab)||tab.virtual;tab.info.disabled=busy(tab)||(!tab.virtual&&dirty(tab));tab.versions.disabled=busy(tab)||dirty(tab)||tab.virtual;
    tab.versions.hidden=!!tab.virtual;tab.reload.hidden=!!tab.virtual;
    tab.title.title=tab.title.textContent;
    if(tab.input)tab.input.disabled=busy(tab);
    tab.workbook?.setDisabled(!!busy(tab));
    tab.document?.setDisabled(!!busy(tab));
    drawTabs();
  }
  async function request(url,body){
    const response=await fetch(url,{signal:ui.signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok===false)throw Object.assign(Error(data.error||'文件操作失败'),{status:response.status,code:data.code});
    return data.result||data;
  }
  const href=(tab,version)=>'/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:tab.id,file:version.frappe_file});
  async function bytes(tab,version,limit=1024*1024){
    const message=limit===1024*1024?'首版只编辑或预览 1MB 内的文本，请下载原件':'在线Office编辑上限10MB，请下载原件';
    if(version.size>limit)throw Object.assign(Error(message),{status:413});
    const response=await fetch(href(tab,version),{signal:ui.signal});
    if(!response.ok)throw Object.assign(Error('原件读取失败，请重新核对权限'),{status:response.status});
    const blob=await response.blob();
    if(blob.size>limit)throw Object.assign(Error(message),{status:413});
    return new Uint8Array(await blob.arrayBuffer());
  }
  function base64(value){let text='';for(let i=0;i<value.length;i+=8192)text+=String.fromCharCode(...value.subarray(i,i+8192));return btoa(text);}
  function encoded(tab,text){
    // textarea 使用 LF；源文件为统一 CRLF 时保存回原换行风格，不静默改编码。
    const normalized=tab.eol==='\r\n'?text.replace(/\r?\n/g,'\r\n'):text;
    const body=new TextEncoder().encode((tab.bom?'\uFEFF':'')+normalized);
    if(body.length>1024*1024)throw Object.assign(Error('首版编辑限 1MB，修改已保留'),{status:413});
    return base64(body);
  }
  function release(tab){window.clearFileMediaPreview(tab.surface);if(tab.url){URL.revokeObjectURL(tab.url);tab.url=null;}tab.workbook?.dispose();tab.workbook=null;tab.document=null;}
  function remove(tab){if(!alive(tab))return;release(tab);tabs.delete(tab.id);tab.panel.remove();if(active===tab.id)select(null);else drawTabs();}
  function askClose(tab,continuation=null){
    if(!tab)return;
    if(busy(tab)){ui.notify('文件仍在读取、保存或等待回执，请先核实');return;}
    const done=()=>continuation?continuation():remove(tab);
    if(!dirty(tab)){done();return;}
    const modal=ui.modal(`<header><h2>修改尚未保存</h2></header><main><p>${esc(tab.row.file_name)}</p><p>保留标签继续编辑，或保存后${continuation?'重新载入':'关闭'}。</p></main><footer><button class="btn" data-close-cancel>继续编辑</button><button class="btn" data-close-discard>放弃修改</button><button class="btn btn-pri" data-close-save>保存后${continuation?'重新载入':'关闭'}</button></footer>`,{native:true,className:'file-operation-dialog'});
    modal.querySelector('[data-close-cancel]').onclick=()=>ui.closeModal(true);
    modal.querySelector('[data-close-discard]').onclick=()=>{ui.closeModal(true);done();};
    modal.querySelector('[data-close-save]').onclick=async()=>{
      ui.closeModal(true);if(await save(tab))done();
    };
  }
  async function display(tab,version){
    const sequence=++tab.sequence;release(tab);tab.surface.textContent='正在读取原件…';tab.input=null;tab.editable=false;tab.shown=version;
    tab.download.href=href(tab,version);tab.download.download=tab.row.file_name;
    const ext=tab.row.file_name.split('.').pop().toLowerCase();
    tab.download.textContent=ext==='xlsx'?'下载 XLSX':'下载原件';
    const current=()=>alive(tab)&&sequence===tab.sequence;
    try{
      if(['md','txt','csv'].includes(ext)){
        const raw=await bytes(tab,version);if(!current())return;
        let text;
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}
        catch{throw Error('不是有效 UTF-8 文本，已保持只读；请下载原件核对编码');}
        if(text.includes('\0'))throw Error('包含非文本内容，已保持只读，请下载原件');
        const latest=version.version_no===tab.history[0].version_no;
        tab.editable=['md','txt'].includes(ext)&&latest&&tab.row.can_edit===true&&tab.row.status==='Active'&&tab.row.content_edit_revision===1;
        tab.surface.textContent='';
        if(tab.editable){
          tab.bom=raw[0]===239&&raw[1]===187&&raw[2]===191;
          tab.eol=text.includes('\r\n')&&!text.replace(/\r\n/g,'').includes('\n')?'\r\n':'\n';
          // 混合换行保留原件，不假装无损编辑。
          if(text.includes('\r')&&tab.eol!=='\r\n'){tab.editable=false;throw Error('文本使用混合或旧式换行，首版只读以保护原格式');}
          const input=document.createElement('textarea');input.dataset.editorText='';input.setAttribute('aria-label','文件正文');input.spellcheck=false;input.value=text;
          tab.input=input;tab.baseText=input.value;tab.surface.append(input);
          input.oninput=()=>changed(tab);
          input.onkeydown=event=>{if(event.key==='Tab'){event.preventDefault();const start=input.selectionStart;input.setRangeText('  ',start,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));}};
          state(tab,'第 '+version.version_no+' 版 · 可编辑');
        }else{const pre=document.createElement('pre');pre.textContent=text;tab.surface.append(pre);state(tab,'第 '+version.version_no+' 版 · 只读'+(!latest?'历史版本':'（此格式或当前权限不支持编辑）'));}
      }else if(ext==='xlsx'&&tab.row.workbook_edit_revision===1&&window.mountFileWorkbook){
        const book=await workbookRequest({operation:'open',file:tab.id,version:version.version_no});if(!current())return;
        const latest=version.version_no===tab.history[0].version_no;
        tab.editable=latest&&tab.row.can_edit===true&&tab.row.status==='Active'&&book.editable===true;
        mountWorkbook(tab,book);state(tab,'第 '+version.version_no+' 版 · '+(tab.editable?'自由表格 · 可编辑（公式暂不计算）':'只读 · '+(book.reason||(!latest?'历史版本':'当前账号无修改权限'))));
      }else if(ext==='docx'&&tab.row.document_edit_revision===1){
        const result=await documentRequest({operation:'open',file:tab.id,version:version.version_no});if(!current())return;
        if(result.revision!==1||!Array.isArray(result.paragraphs))throw Error('DOCX编辑回执不完整');
        tab.editable=version.version_no===tab.history[0].version_no&&tab.row.can_edit===true&&tab.row.status==='Active'&&result.editable===true;
        mountDocument(tab,result);state(tab,'第 '+version.version_no+' 版 · '+(tab.editable?'正文可编辑，原排版请下载查看':(result.reason||'只读正文')));
      }else if(ext==='docx'){
        const result=await request('/api/platform/services/platform.file.preview/invoke',{payload:{ref_doctype:'Shangshu File Center File',ref_name:tab.id,file:version.frappe_file}});
        if(!current())return;window.renderFileDocumentPreview(tab.surface,result);state(tab,'第 '+version.version_no+' 版 · DOCX 正文预览，暂不编辑');
      }else if(['pdf','png','jpg','jpeg'].includes(ext)){
        if(version.size>20*1024*1024)throw Error('在线预览上限20MB，请下载原件');
        const response=await fetch(href(tab,version),{signal:ui.signal});if(!response.ok)throw Error('原件读取失败');
        const blob=await response.blob();if(!current())return;if(blob.size>20*1024*1024)throw Error('在线预览上限20MB，请下载原件');tab.url=URL.createObjectURL(blob);tab.surface.textContent='';
        window.renderFileMediaPreview(tab.surface,{url:tab.url,name:tab.row.file_name,kind:ext==='pdf'?'pdf':'image',current});state(tab,'第 '+version.version_no+' 版 · 阅读操作不修改原件');
      }else{tab.surface.textContent='此格式暂不支持在线编辑，请下载原件。原文件与历史版本保持不变。';state(tab,'第 '+version.version_no+' 版 · 只读');}
    }catch(error){if(current()){tab.editable=false;tab.input=null;tab.surface.textContent=error.message;state(tab,'无法编辑或预览；仍可下载原件');}}
    if(current()){sync(tab);if(active===tab.id)updateContext();}
  }
  async function load(tab){
    if(!alive(tab)||busy(tab))return;
    tab.loading=true;state(tab,'正在读取文件…');
    try{
      const data=await window.readFileCenterVersions(tab.id,ui.signal);if(!alive(tab))return;
      if(data.file?.name!==tab.id||!data.versions?.length||!data.versions[0].frappe_file)throw Error('文件版本回执不完整');
      tab.row=data.file;tab.history=data.versions;
      tab.title.textContent=tab.row.file_name;
      tab.versions.innerHTML=tab.history.map(version=>`<option value="${esc(version.version_no)}">第 ${esc(version.version_no)} 版${version===tab.history[0]?' · 当前':''}</option>`).join('');
      await display(tab,tab.history[0]);
    }catch(error){if(alive(tab)){tab.surface.textContent='读取失败，可重新载入；未显示缓存文件。';state(tab,error.message);}}
    finally{tab.loading=false;sync(tab);}
  }
  async function save(tab){
    if(!alive(tab)||tab.saving||!tab.editable||!dirty(tab)&&!tab.attempt)return false;
    if(navigator.onLine===false){state(tab,'当前离线，草稿已保留；联网后'+(tab.attempt?'核实并重试':'再保存'));return false;}
    try{
      if(!tab.attempt){
        const snapshot=tab.workbook?.snapshot();
        tab.attempt={id:crypto.randomUUID(),action:tab.virtual?'files.upload':'files.new_version',text:tab.input?.value,snapshot,documentChanges:tab.document?.changes(),
          payload:tab.virtual?{file_name:tab.row.file_name,directory_id:tab.directory,create_only:true,note:'在线表格'}:{file:tab.id,expected_version:tab.shown.version_no,expected_modified:tab.row.modified,note:'在线编辑'}};
        if(!snapshot&&!tab.document)tab.attempt.payload.content_base64=encoded(tab,tab.input.value);
      }
    }catch(error){state(tab,error.message);return false;}
    tab.saving=true;state(tab,'正在保存新版本…');const attempt=tab.attempt;
    try{
      if(attempt.documentChanges&&!attempt.payload.content_base64){
        const result=await documentRequest({operation:'encode',file:tab.id,version:tab.shown.version_no,changes:attempt.documentChanges});
        if(result.revision!==1||typeof result.content_base64!=='string'||!result.content_base64)throw Object.assign(Error('DOCX编码回执无效，草稿保留'),{status:422});
        attempt.payload.content_base64=result.content_base64;
      }
      if(attempt.snapshot&&!attempt.payload.content_base64){
        const encoded=await workbookRequest({operation:'encode',...(!tab.virtual?{file:tab.id,version:tab.shown.version_no}:{}),...attempt.snapshot});
        if(encoded.revision!==1||typeof encoded.content_base64!=='string'||!encoded.content_base64)throw Object.assign(Error('表格编码回执无效，草稿保留'),{status:422});
        attempt.payload.content_base64=encoded.content_base64;
      }
      if(!attempt.receipt){
        attempt.sent=true;
        const receipt=await request('/api/platform/actions/'+attempt.action+'/execute',{payload:attempt.payload,confirmed:true,idempotency_key:attempt.id});
        if(!receipt.file||!Number.isInteger(receipt.version)||(tab.virtual?receipt.version!==1:receipt.file!==tab.id||receipt.version!==attempt.payload.expected_version+1))throw Error('保存回执不完整，结果待核实');
        attempt.receipt=receipt;
      }
      const savedId=attempt.receipt.file,data=await window.readFileCenterVersions(savedId,ui.signal);
      if(!alive(tab))return false;
      const saved=data.versions?.find(version=>version.version_no===attempt.receipt.version);
      if(data.file?.name!==savedId||!saved?.frappe_file)throw Error('新版本读回失败');
      if(base64(await bytes({id:savedId},saved,tab.workbook||tab.document?10*1024*1024:1024*1024))!==attempt.payload.content_base64)throw Error('新版本内容与输入不一致，请核对');
      if(!alive(tab))return false;
      if(tab.virtual){const oldId=tab.id;tabs.delete(oldId);tab.id=savedId;tabs.set(savedId,tab);tab.panel.dataset.editorPanel=savedId;if(active===oldId)active=savedId;tab.virtual=false;}
      tab.row=data.file;tab.history=data.versions;tab.shown=saved;tab.baseText=attempt.text;tab.attempt=null;
      tab.workbook?.markSaved();
      tab.document?.markSaved();
      tab.title.textContent=tab.row.file_name;
      tab.download.hidden=false;
      tab.download.textContent=tab.workbook?'下载 XLSX':'下载原件';tab.info.textContent='文件信息';
      tab.download.href=href(tab,saved);
      tab.versions.innerHTML=tab.history.map(version=>`<option value="${esc(version.version_no)}" ${version===saved?'selected':''}>第 ${esc(version.version_no)} 版${version===tab.history[0]?' · 当前':''}</option>`).join('');
      state(tab,'已保存并读回 · 第 '+saved.version_no+' 版'+(saved!==tab.history[0]?'；已有更新版本，请重新载入核对':''));
      window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:tab.id,source:'file-editor'}}));
      try{await onChanged(tab.row);}catch{ui.notify('文件已保存，列表刷新失败，请稍后刷新');}
      return true;
    }catch(error){
      if(!alive(tab))return false;
      const definite=error.status>=400&&error.status<500&&![408,429].includes(error.status);
      if(attempt.sent&&(!definite||attempt.receipt))attempt.unknown=true;
      if(!attempt.sent||definite&&!attempt.unknown)tab.attempt=null;
      state(tab,(tab.attempt?'结果待核实，重试沿用原请求；':'未保存，草稿已保留；')+error.message);return false;
    }finally{tab.saving=false;sync(tab);}
  }
  function addTab(id,label){
    if(ui.disposed)return null;
    if(tabs.size>=8){ui.notify('最多同时打开8个文件，请先关闭一个标签');return null;}
    const file={name:label};
    const panel=document.createElement('section');panel.className='file-editor-panel';panel.dataset.editorPanel=id;
    panel.innerHTML=`<div class="file-editor-toolbar"><h2 data-editor-title>${esc(file.name||'文件')}</h2><button class="btn btn-pri" data-editor-save hidden>保存</button><div class="file-editor-actions"><select data-editor-versions aria-label="查看文件版本"></select><button class="btn" data-editor-info>文件信息</button><button class="btn" data-editor-reload>重新载入</button><a class="btn" data-editor-download>下载原件</a></div></div><div class="file-editor-status" data-editor-status role="status"></div><div class="file-editor-surface"></div>`;
    const $=selector=>panel.querySelector(selector);
    const tab={id,label:file.name||'文件',panel,title:$('[data-editor-title]'),status:$('[data-editor-status]'),save:$('[data-editor-save]'),reload:$('[data-editor-reload]'),info:$('[data-editor-info]'),versions:$('[data-editor-versions]'),download:$('[data-editor-download]'),surface:$('.file-editor-surface'),sequence:0,loading:false,saving:false,attempt:null};
    tabs.set(id,tab);area.append(panel);select(id);
    tab.save.onclick=()=>save(tab);tab.reload.onclick=()=>askClose(tab,()=>load(tab));
    tab.info.onclick=async()=>{
      if(!tab.virtual){onInfo({id:tab.id,name:tab.row.file_name});return;}
      const target=await workbookTarget('文件名称与目录',tab.row.file_name,tab.directory);if(!target||!alive(tab)||busy(tab))return;
      tab.row.file_name=target.name;tab.directory=target.directory;tab.title.textContent=target.name;state(tab,'名称与目录已调整；尚未保存');
    };
    tab.versions.onchange=async()=>{if(busy(tab)||dirty(tab))return;tab.loading=true;sync(tab);await display(tab,tab.history.find(version=>String(version.version_no)===tab.versions.value));tab.loading=false;sync(tab);};
    return tab;
  }
  async function open(file){
    const id=file.id||file.name;if(!id||ui.disposed)return;
    if(tabs.has(id)){select(id);return;}
    const tab=addTab(id,file.name);if(tab)await load(tab);
  }
  const workbookRequest=payload=>request('/api/platform/services/files.workbook/invoke',{payload});
  const documentRequest=payload=>request('/api/platform/services/files.document/invoke',{payload});
  function mountDocument(tab,data){
    tab.surface.textContent='';const page=document.createElement('div');page.className='file-document-body';
    const notice=document.createElement('p');notice.className='file-preview-warning';notice.textContent=data.notice;page.append(notice);
    const fields=[];
    for(const paragraph of data.paragraphs){
      if(tab.editable&&paragraph.editable){
        const input=document.createElement('textarea');input.dataset.documentParagraph=paragraph.key;input.setAttribute('aria-label','正文段落 '+(fields.length+1));input.maxLength=20000;input.value=paragraph.text;input.rows=Math.min(12,Math.max(2,paragraph.text.split('\n').length));
        fields.push({key:paragraph.key,input,base:input.value});input.oninput=()=>changed(tab);page.append(input);
      }else{const p=document.createElement('p');p.className='file-preview-paragraph';p.textContent=paragraph.text||'（图片或复杂内容，请下载原件查看）';p.title=paragraph.reason||'';page.append(p);}
    }
    tab.surface.append(page);
    tab.document={changes:()=>fields.filter(f=>f.input.value!==f.base).map(f=>({key:f.key,text:f.input.value})),setDisabled:value=>fields.forEach(f=>f.input.disabled=value),markSaved:()=>fields.forEach(f=>f.base=f.input.value)};
  }
  function promptName(title,value){return new Promise(resolve=>{
    let result=null;const modal=ui.modal(`<form><header><h2>${esc(title)}</h2></header><main><label class="dlg-field">名称<input value="${esc(value)}" maxlength="31" required></label></main><footer><button type="button" class="btn" data-cancel>取消</button><button class="btn btn-pri" type="submit">确定</button></footer></form>`,{native:true,className:'file-operation-dialog',onClose:()=>resolve(result)});
    if(!modal){resolve(null);return;}modal.querySelector('[data-cancel]').onclick=()=>ui.closeModal(true);modal.querySelector('form').onsubmit=e=>{e.preventDefault();result=modal.querySelector('input').value.trim();ui.closeModal(true);};
  });}
  function confirmDelete(message){return new Promise(resolve=>{
    let result=false;const modal=ui.modal(`<header><h2>删除工作表</h2></header><main><p>${esc(message)}</p></main><footer><button class="btn" data-cancel>取消</button><button class="btn btn-pri" data-confirm>删除</button></footer>`,{native:true,className:'file-operation-dialog',onClose:()=>resolve(result)});
    if(!modal){resolve(false);return;}modal.querySelector('[data-cancel]').onclick=()=>ui.closeModal(true);modal.querySelector('[data-confirm]').onclick=()=>{result=true;ui.closeModal(true);};
  });}
  function mountWorkbook(tab,book){
    tab.surface.textContent='';const surface=document.createElement('div');tab.surface.append(surface);
    tab.workbook=window.mountFileWorkbook({host:surface,data:book,editable:tab.editable,onChange:()=>changed(tab),notify:ui.notify,promptName,confirmDelete});
  }
  async function createWorkbook(importFile=null){
    if(ui.disposed||!window.mountFileWorkbook||tabs.size>=8){ui.notify('请先关闭一个标签再新建');return;}
    if(importFile&&(!/\.(xlsx|csv)$/i.test(importFile.name)||importFile.size>10*1024*1024)){ui.notify('请选择10MB内的XLSX或UTF-8 CSV');return;}
    // 路径、名字在工作簿建立前显式选择；取消不创建文件，也不建数据库表。
    const target=await workbookTarget(importFile?'导入自由表格':'新建表格文件',importFile?.name||'未命名表格',getDirectory());
    if(!target||ui.disposed)return;
    try{
      const book=await workbookRequest(importFile?{operation:'import',filename:importFile.name,content_base64:await window.readFileCenterContent(importFile)}:{operation:'blank'});
      if(ui.disposed)return;if(book.editable!==true){ui.notify(book.reason||'格式暂不支持编辑，请使用上传文件保留原件');return;}
      const tab=addTab('new:'+crypto.randomUUID(),target.name);if(!tab)return;tab.virtual=true;tab.directory=target.directory;tab.row={file_name:target.name};tab.editable=true;tab.download.hidden=true;tab.info.textContent='文件名称与目录';
      mountWorkbook(tab,book);state(tab,'尚未保存 · 文件表格，不会创建业务数据库表');
    }catch(e){if(!ui.disposed)ui.notify('表格未建立：'+e.message);}
  }
  async function workbookTarget(title,filename,currentDirectory){
    const options=getDirectories();if(!options.length){ui.notify('目录未读取，请刷新文件列表后重试');return null;}
    return new Promise(resolve=>{
      let result=null;const modal=ui.modal(`<form><header><h2>${esc(title)}</h2></header><main><label class="dlg-field">文件名称<input data-workbook-name value="${esc(filename.replace(/\.(xlsx|csv)$/i,''))}" maxlength="190" required></label><label class="dlg-field">存入目录<select data-workbook-directory>${options.map(d=>`<option value="${esc(d.name)}">${esc(d.label||d.path||d.title)}</option>`).join('')}</select></label><p>保存为XLSX文件。不会创建业务表；与现有文件重名时拒绝保存，请改名。</p><p data-workbook-error role="alert"></p></main><footer><button type="button" class="btn" data-workbook-cancel>取消</button><button class="btn btn-pri" type="submit" data-workbook-confirm>确定</button></footer></form>`,{native:true,className:'file-operation-dialog',onClose:()=>resolve(result)});
      if(!modal){resolve(null);return;}
      const directory=modal.querySelector('[data-workbook-directory]');if(options.some(d=>d.name===currentDirectory))directory.value=currentDirectory;
      modal.querySelector('[data-workbook-cancel]').onclick=()=>ui.closeModal(true);
      modal.querySelector('form').onsubmit=e=>{e.preventDefault();const name=modal.querySelector('[data-workbook-name]').value.trim().replace(/\.xlsx$/i,'');if(!name||/[\\/\x00-\x1f]/.test(name)){modal.querySelector('[data-workbook-error]').textContent='请填写有效文件名称';return;}result={name:name+'.xlsx',directory:directory.value};ui.closeModal(true);};
    });
  }
  function canLeave(){if(Array.from(tabs.values()).some(tab=>dirty(tab)||tab.saving||tab.attempt)){ui.notify('文件还有未保存修改或待核实回执，请先保存或关闭文件标签');return false;}return true;}
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&active!==null&&!ui.modalCount){event.preventDefault();save(tabs.get(active));}
  },{signal:ui.signal});
  window.addEventListener('shangshu:before-object-change',event=>{
    if(event.detail?.object_id==='files.file'&&Array.from(tabs.values()).some(tab=>(!event.detail.name||tab.id===event.detail.name)&&(dirty(tab)||tab.saving||tab.attempt))){
      event.preventDefault();ui.notify('文件正文还有人工修改，请先保存或放弃');
    }
  },{signal:ui.signal});
  window.addEventListener('shangshu:object-changed',event=>{
    if(event.detail?.object_id!=='files.file'||event.detail.source==='file-editor')return;
    const tab=tabs.get(event.detail.name);if(!tab)return;
    if(dirty(tab)||busy(tab)){state(tab,'文件已发生外部修改，人工草稿已保留；请核对后保存');return;}
    load(tab);
  },{signal:ui.signal});
  ui.onDispose(()=>{for(const tab of tabs.values())release(tab);tabs.clear();});
  return {open,canLeave,createWorkbook,importWorkbook:file=>createWorkbook(file)};
};
