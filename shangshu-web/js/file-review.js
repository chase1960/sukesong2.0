/* 单文件审核：本地核对，整份保存；不复制对象字段规则或逐格写正式值。 */
window.openFileReview = async function({ui,file,onChanged=async()=>{}}){
  const esc=ui.escape;
  async function request(url,body){
    const r=await fetch(url,{signal:ui.signal,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.ok===false)throw Object.assign(Error(d.error||'读取或保存失败'),{status:r.status});
    return d.result||d;
  }
  let data;
  try{data=await request('/api/platform/services/files.review/invoke',{payload:{file:file.id}});}
  catch(e){ui.notify('无法打开审核：'+e.message);return;}
  if(ui.disposed)return;
  const row=data.file,relations=data.relations.map(r=>({...r,values:{}}));
  let busy=false,pending=null,unknown=false,changed=false,chooserSequence=0,generating=false,picker=null;
  const editable=data.can_review===true;
  const modal=ui.modal(`<header><h2>${esc(row.file_name)}</h2><button class="btn" data-review-preview>预览原件</button><button class="btn" data-review-cancel aria-label="关闭审核">×</button></header>
    <main><section><h3>文件信息</h3><label class="file-property"><span>文件名</span><input data-meta="file_name" aria-label="文件名" maxlength="200" value="${esc(row.file_name)}"></label><label class="file-property"><span>标签</span><input data-meta="tags" aria-label="标签" value="${esc((row.tags||[]).join('；'))}"></label><label class="file-property"><span>备注</span><textarea data-meta="note" aria-label="备注" maxlength="500">${esc(row.note||'')}</textarea></label></section>
    <section><div class="file-review-section-heading"><h3>关联记录</h3><button class="btn" data-add-relation>关联记录</button></div><div data-relations></div><div data-relation-chooser hidden></div></section>
    <section><h3>记录字段</h3><p class="file-review-hint">双击字段修改。只有修改过的字段会在“保存文件”时写入，未修改的字段保留原值。</p><div data-record-fields></div></section>
    ${data.unavailable?'<p role="alert">有关联记录已不可访问，请由仍有权限的人员处理。此次不能保存。</p>':''}
    </main><footer><span data-review-state role="status"></span><button class="btn" data-review-cancel>取消</button><button class="btn btn-pri" data-review-save>保存文件</button></footer>`,{native:true,className:'file-review-dialog',onClose:()=>picker?.dispose()});
  const $=s=>modal.querySelector(s),alive=()=>!ui.disposed&&modal.isConnected;
  const controls=()=>modal.querySelectorAll('input,textarea,select,[data-remove-relation],[data-add-relation],[data-suggest-record],[data-adopt-candidate],[data-keep-candidate]');
  const freeze=()=>{controls().forEach(e=>e.disabled=!editable||busy||!!pending||e.closest('[data-editable]')?.dataset.editable==='false'||(e.matches('[data-review-field]')&&e.tagName==='SELECT'&&e.dataset.editing!=='true'));$('[data-review-save]').disabled=!editable||busy;};
  const state=message=>{if(alive())$('[data-review-state]').textContent=message;};
  ui.guardModal(modal,()=>{if(busy||pending||changed){state('还有未保存内容，请保存或明确取消；结果未知须先核实');return false;}return true;});
  modal.querySelectorAll('[data-review-cancel]').forEach(b=>b.onclick=()=>{if(busy||pending){state('保存结果待核实，请重试原操作');return;}ui.closeModal(true);});
  modal.querySelectorAll('[data-meta]').forEach(el=>el.oninput=()=>{changed=true;state('尚未保存');});
  $('[data-review-preview]').onclick=()=>window.openFileCenterDetail({ui,file,version:row.version,snapshot:true});
  function label(ref){
    const f=ref.object.fields.find(f=>f.type==='text');
    return String(ref.record[f?.id]||ref.name);
  }
  function renderRelations(){
    $('[data-relations]').innerHTML=relations.map((r,i)=>`<div class="file-review-relation"><span>${esc(r.object.title||r.object.name)} · ${esc(label(r))}</span><button class="btn" data-remove-relation="${i}">解除关联</button></div>`).join('')||'<p class="file-review-hint">未关联记录。可直接保存文件，不必先选择业务。</p>';
    $('[data-record-fields]').innerHTML=relations.map((r,i)=>{
      const properties=r.object.input_schema?.properties||{};
      return `<fieldset data-record="${i}"><legend>${esc(label(r))}</legend>${editable&&r.object.operations.includes('update')?`<button class="btn" data-suggest-record="${i}" ${generating?'disabled':''}>从原件提取候选</button><p class="file-review-hint">使用已配置的 AI 模型读取本份原件；仅生成建议，不自动保存。</p>`:''}${r.object.fields.map(f=>{
        const can=editable&&r.object.operations.includes('update')&&Object.hasOwn(properties,f.id)&&!['reference','detail'].includes(f.type);
        const value=Object.hasOwn(r.values,f.id)?r.values[f.id]:r.record[f.id];
        const attr=`data-review-field="${esc(f.id)}" data-index="${i}" aria-label="${esc(f.label)}" title="正式值：${esc(r.record[f.id]??'—')}"`;
        const input=f.type==='choice'?`<select ${attr} disabled><option value=""></option>${(f.options||[]).map(v=>`<option ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select>`:f.type==='boolean'?`<select ${attr} disabled><option value="false" ${value?'':'selected'}>否</option><option value="true" ${value?'selected':''}>是</option></select>`:f.type==='long_text'?`<textarea ${attr} readonly>${esc(value??'')}</textarea>`:`<input ${attr} type="${f.type==='date'?'date':['integer','number','decimal'].includes(f.type)?'number':'text'}" value="${esc(typeof value==='object'?JSON.stringify(value):value??'')}" readonly>`;
        const candidate=r.candidates?.find(c=>c.field===f.id);
        return `<label class="file-property ${Object.hasOwn(r.values,f.id)?'is-adopted':''}" data-editable="${can}"><span>${esc(f.label)}</span>${input}</label>${candidate?`<div class="file-review-candidate" data-candidate="${esc(f.id)}"><span>建议：<span role="button" tabindex="0" data-edit-candidate="${esc(f.id)}" title="双击或回车修改候选">${esc(candidate.value)}</span></span><button class="btn" data-adopt-candidate="${esc(f.id)}">采用</button><button class="btn" data-keep-candidate="${esc(f.id)}">保留原值</button><small>原文：${esc(candidate.evidence)}</small><small data-candidate-state>${esc(candidate.state||'待核对')}</small></div>`:''}`;
      }).join('')}</fieldset>`;
    }).join('')||'<p class="file-review-hint">关联记录后在这里核对字段。</p>';
    modal.querySelectorAll('[data-remove-relation]').forEach(b=>b.onclick=()=>{relations.splice(Number(b.dataset.removeRelation),1);changed=true;renderRelations();});
    modal.querySelectorAll('[data-review-field]').forEach(el=>{
      const can=el.closest('[data-editable]').dataset.editable==='true';
      const edit=()=>{if(!can||busy||pending)return;el.dataset.editing='true';el.disabled=false;el.readOnly=false;el.focus();};
      el.ondblclick=edit;el.closest('label').ondblclick=edit;
      if(can&&el.tagName==='SELECT'){const label=el.closest('label');label.tabIndex=0;label.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();edit();}};}
      el.onkeydown=e=>{if(e.key==='Enter'&&el.readOnly){e.preventDefault();edit();}};
      const adopt=()=>{
        if(!can||busy||pending)return;
        const r=relations[Number(el.dataset.index)],f=r.object.fields.find(f=>f.id===el.dataset.reviewField);
        const val=f.type==='boolean'?el.value==='true':['integer','number','decimal'].includes(f.type)?(el.value===''?null:Number(el.value)):el.value;
        if(val===(r.record[f.id]??''))delete r.values[f.id];else r.values[f.id]=val;
        el.closest('label').classList.toggle('is-adopted',Object.hasOwn(r.values,f.id));changed=true;state('尚未保存');
        const candidate=r.candidates?.find(c=>c.field===f.id);if(candidate){candidate.state='已修改，待保存';candidateStatus(el.closest('fieldset'),f.id,candidate.state);}
      };
      el.oninput=adopt;el.onchange=adopt;el.onblur=()=>{el.dataset.editing='false';el.readOnly=true;if(el.tagName==='SELECT')el.disabled=true;};
      if(!can)el.disabled=true;
    });
    modal.querySelectorAll('[data-candidate]').forEach(box=>{
      const group=box.closest('fieldset'),r=relations[Number(group.dataset.record)],c=r.candidates.find(c=>c.field===box.dataset.candidate);
      const input=Array.from(group.querySelectorAll('[data-review-field]')).find(el=>el.dataset.reviewField===c.field);
      const use=(keep=false,edit=false)=>{
        if(!editable||busy||pending)return;
        if(keep)delete r.values[c.field];else r.values[c.field]=c.value;
        input.value=keep?(r.record[c.field]??''):String(c.value);
        input.closest('label').classList.toggle('is-adopted',!keep);changed=true;
        c.state=keep?'已保留原值':'已采用，待保存';candidateStatus(group,c.field,c.state);state('尚未保存');
        if(edit){input.dataset.editing='true';input.disabled=false;input.readOnly=false;input.focus();}
      };
      box.querySelector('[data-adopt-candidate]').onclick=()=>use();box.querySelector('[data-keep-candidate]').onclick=()=>use(true);
      const value=box.querySelector('[data-edit-candidate]');value.ondblclick=()=>use(false,true);value.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();use(false,true);}};
    });
    modal.querySelectorAll('[data-suggest-record]').forEach(button=>button.onclick=async()=>{
      if(generating||busy||pending||!editable)return;
      const r=relations[Number(button.dataset.suggestRecord)];generating=true;button.disabled=true;state('正在读取原件并生成候选…');
      try{
        const current=await request('/api/platform/services/files.versions/invoke',{payload:{file:row.name}});
        if(current.file?.modified!==row.modified||current.file?.version!==row.version)throw Error('原件或文件信息已变化，请重新打开审核');
        const original=current.versions.find(v=>Number(v.version_no)===row.version);
        if(!original?.frappe_file)throw Error('原件版本不可用');
        const source={ref_doctype:'Shangshu File Center File',ref_name:row.name,file:original.frappe_file};
        const result=await request('/api/platform/objects/'+encodeURIComponent(r.object_id)+'/records/'+encodeURIComponent(r.name)+'/file-suggestions',{source});
        if(!alive()||!relations.includes(r))return;
        if(result.expected_revision!==r.object.revision||result.expected_modified!==r.record.modified||result.source?.file!==original.frappe_file)throw Error('候选对应的记录版本已变化，请重新核对');
        r.candidates=result.candidates;renderRelations();state(r.candidates.length?'候选待核对；原有手工修改未被覆盖':'没有可靠候选，可继续人工填写');
      }catch(e){state('未生成候选，原输入保留；'+e.message);}
      finally{generating=false;if(alive())modal.querySelectorAll('[data-suggest-record]').forEach(b=>b.disabled=!editable||busy||!!pending);}
    });
    if(!editable)controls().forEach(e=>e.disabled=true);
  }
  function candidateStatus(group,field,message){const box=Array.from(group.querySelectorAll('[data-candidate]')).find(el=>el.dataset.candidate===field);if(box)box.querySelector('[data-candidate-state]').textContent=message;}
  $('[data-add-relation]').onclick=()=>{
    picker?.dispose();
    const panel=$('[data-relation-chooser]');panel.hidden=false;const sequence=++chooserSequence;
    picker=window.mountRecordReferencePicker({ui,node:panel,alive:()=>alive()&&sequence===chooserSequence&&!panel.hidden,
      onCancel:()=>{panel.hidden=true;chooserSequence++;},onPick:ref=>{
        if(busy||pending)return;
        if(relations.some(r=>r.object_id===ref.object_id&&r.name===ref.name)){state('该记录已经关联');return;}
        if(relations.length>=20){state('每份文件最多关联20条记录');return;}
        relations.push({...ref,values:{}});changed=true;renderRelations();panel.hidden=true;chooserSequence++;picker?.dispose();
      }});
  };
  $('[data-review-save]').onclick=async()=>{
    if(busy||!editable)return;
    if(generating){state('请等候选提取结束，或取消本次审核');return;}
    if(relations.some(r=>r.candidates?.some(c=>!c.state))){state('还有候选未核对，请采用、修改或保留原值');return;}
    const meta=Object.fromEntries(Array.from(modal.querySelectorAll('[data-meta]'),e=>[e.dataset.meta,e.value.trim()]));
    const tags=meta.tags.split(/[；;]/).map(t=>t.trim()).filter(Boolean);
    if(!pending&&(!meta.file_name||tags.length>10||tags.some(t=>Array.from(t).length>20))){state('请填写文件名；标签最多10项，每项20字');return;}
    pending??={key:crypto.randomUUID(),payload:{file:row.name,expected_modified:row.modified,expected_version:row.version,...meta,tags,
      relations:relations.map(r=>({object_id:r.object_id,name:r.name,expected_revision:r.object.revision,expected_modified:r.record.modified,values:{...r.values}}))}};
    busy=true;chooserSequence++;picker?.dispose();$('[data-relation-chooser]').hidden=true;freeze();state('正在保存整份文件…');
    try{
      const result=await request('/api/platform/actions/files.review/execute',{payload:pending.payload,confirmed:true,idempotency_key:pending.key});
      if(result.file!==row.name||!result.record?.modified||result.relation_count!==pending.payload.relations.length)throw Error('保存回执不完整');
      pending=null;unknown=false;changed=false;ui.closeModal(true);
      try{await onChanged();ui.notify('文件已保存');}catch(e){ui.notify('已保存，列表刷新失败：'+e.message);}
    }catch(e){
      if(!alive())return;unknown=unknown||!(e.status>=400&&e.status<500&&![408,429].includes(e.status));
      if(!unknown)pending=null;
      state((unknown?'结果待核实，请重试原操作；':'未保存，输入已保留；')+e.message);
      $('[data-review-save]').textContent=unknown?'核实并重试':'重试保存';
    }finally{busy=false;if(alive())freeze();}
  };
  renderRelations();if(!editable)freeze();
  return {element:modal};
};
