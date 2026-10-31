/* 应用定义交付：仅编排已有 Service / Action / 数据表迁移，不建立第二套保存接口。 */
async function applicationDeliveryRequest(path, body) {
  const response=await api(path,{method:'POST',body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok||data.ok===false)throw Error(data.error||data.message||'应用交付请求失败');
  return data;
}
function inspectApplicationDelivery(application_id, operation, values={}) {
  return applicationDeliveryRequest('/api/platform/services/platform.application.delivery/invoke',{payload:{application_id,operation,...values}});
}
function confirmApplicationDelivery(title, changes, execute) {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='schema-dialog model-dialog';
    const display=value=>typeof value==='string'?value:JSON.stringify(value??null,null,2);
    dialog.innerHTML=`<h2>${esc(title)}</h2><div class="model-capabilities-scroll"><table class="model-capabilities-table"><thead><tr><th>项目</th><th>当前</th><th>变更后</th></tr></thead><tbody>${changes.map(item=>`<tr><td>${esc(item.label)}</td><td><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(display(item.before))}</pre></td><td><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(display(item.after))}</pre></td></tr>`).join('')}</tbody></table></div><p role="status" data-delivery-status>仅保存草稿，不自动发布；已有业务记录不随包迁移。</p><div class="schema-actions"><button class="btn btn-ghost" type="button" data-delivery-cancel>取消</button><button class="btn btn-pri" type="button" data-delivery-confirm>确认执行</button></div>`;
    let busy=false;
    const cancel=()=>{if(!busy){dialog.remove();resolve(false);}};
    dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
    dialog.querySelector('[data-delivery-cancel]').onclick=cancel;
    dialog.querySelector('[data-delivery-confirm]').onclick=async()=>{
      if(busy)return;busy=true;
      dialog.querySelectorAll('button').forEach(button=>button.disabled=true);
      try{await execute(text=>{dialog.querySelector('[data-delivery-status]').textContent=text;});dialog.remove();resolve(true);}
      catch(error){dialog.querySelector('[data-delivery-status]').textContent=error.message||String(error);}
      finally{busy=false;dialog.querySelectorAll('button').forEach(button=>button.disabled=false);}
    };
    document.body.append(dialog);dialog.showModal();
  });
}
async function saveApplicationWithPreview(application_id, expected_revision, definition, isActive=()=>true) {
  const preview=await inspectApplicationDelivery(application_id,'change_preview',{expected_revision,definition});
  if(!isActive())return false;
  if(!preview.changes.length)return true; // 与当前草稿相同：不写新修订，允许页面清除脏标记。
  const key=crypto.randomUUID();
  return confirmApplicationDelivery('确认应用草稿变更',preview.changes,async()=>{
    if(!isActive())throw Error('已离开当前应用，请关闭后重新检查。');
    await applicationDeliveryRequest('/api/platform/actions/platform.application.configure/execute',{
      payload:{application_id,expected_revision:preview.expected_revision,definition:preview.definition,dependency_hash:preview.dependency_hash},
      confirmed:true,idempotency_key:key});
  });
}
function mountApplicationDelivery(container, application, {isDirty,isActive,reload}) {
  const section=document.createElement('fieldset');section.className='application-role-picker';
  section.innerHTML='<legend>定义交付</legend><div><button type="button" class="btn btn-ghost" data-delivery-export>导出定义</button><button type="button" class="btn btn-ghost" data-delivery-import>导入定义</button><input type="file" accept=".json,application/json" hidden data-delivery-file></div><small>只传递页面、表结构、审批配置和依赖声明。导入需新建空应用；数据、账号和密钥不包含在内。</small><p role="status" data-package-status></p>';
  container.append(section);
  const rules=document.createElement('details');
  rules.innerHTML='<summary>人工与 AI 共用规则</summary>'+(application.design_context.configuration_actions||[]).map(action=>`<p>${esc(action.title)} · 版本 ${esc(action.version)} · ${action.confirmation==='required'?'必须确认':'按动作规则执行'}</p><p>人工保存与 AI 提案共用此动作；只改草稿，不能直接发布或执行数据库迁移。</p><details><summary>输入与输出</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({input:action.input_schema,output:action.output_schema},null,2))}</pre></details>`).join('');
  section.append(rules);
  const upgrade=document.createElement('p');upgrade.className='cell-sub';
  upgrade.textContent='本站升级/恢复演练：未登记。定义预检不等于升级验证，部署前仍需按交付手册演练。';
  section.append(upgrade);
  let busy=false;
  const status=section.querySelector('[data-package-status]');
  const run=async callback=>{
    if(busy)return;
    if(isDirty()){status.textContent='请先保存当前草稿。';return;}
    busy=true;section.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{await callback();}catch(error){if(isActive())status.textContent=error.message||String(error);}
    finally{busy=false;section.querySelectorAll('button').forEach(button=>button.disabled=false);}
  };
  section.querySelector('[data-delivery-export]').onclick=()=>run(async()=>{
    const result=await inspectApplicationDelivery(application.id,'export');
    if(!isActive())return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(result.package,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='application-definition.json';link.click();URL.revokeObjectURL(url);
    status.textContent='已导出草稿修订 '+result.revision+'；未包含业务数据。';
  });
  const input=section.querySelector('[data-delivery-file]');
  section.querySelector('[data-delivery-import]').onclick=()=>{if(isDirty()){status.textContent='请先保存当前草稿。';return;}input.click();};
  input.onchange=()=>run(async()=>{
    const file=input.files[0];input.value='';if(!file)return;
    if(file.size>1_000_000)throw Error('应用包不能超过 1MB。');
    const pkg=JSON.parse(await file.text());
    const preview=await inspectApplicationDelivery(application.id,'import_preview',{package:pkg});
    if(!isActive())return;
    const key=crypto.randomUUID();
    const saved=await confirmApplicationDelivery('导入到当前空应用',[
      {label:'应用名称',before:application.draft.title,after:preview.definition.title},
      {label:'数据表',before:'新建空应用',after:preview.models.map(item=>item.definition.title)},
      {label:'外部依赖',before:'未绑定',after:preview.dependencies}
    ],async progress=>{
      if(!isActive()||isDirty())throw Error('页面已变化，请重新检查后导入。');
      const current=await inspectApplicationDelivery(application.id,'import_preview',{package:pkg});
      for(const [index,model] of current.models.entries()){
        if(model.complete)continue;
        progress('正在创建数据表 '+(index+1)+' / '+current.models.length+'：'+model.definition.title+'。失败后可重试同一文件。');
        const planned=await applicationDeliveryRequest('/api/platform/application-definitions/'+encodeURIComponent(application.id)+'/object-changes',{
          definition:model.definition,idempotency_key:model.idempotency_key,expected_revision:0});
        await applicationDeliveryRequest('/api/platform/object-changes/'+encodeURIComponent(planned.change.id)+'/execute',{confirmed:true});
      }
      progress('正在保存应用草稿…');
      await applicationDeliveryRequest('/api/platform/actions/platform.application.configure/execute',{
        payload:{application_id:application.id,expected_revision:current.expected_revision,definition:current.definition,dependency_hash:current.dependency_hash},confirmed:true,idempotency_key:key});
    });
    if(saved&&isActive())await reload();
  });
}
