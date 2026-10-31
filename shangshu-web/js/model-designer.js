/* 应用内数据设计：只生成逻辑字段；校验、物理映射和迁移由后端负责。 */
function createModelDesigner(application, reload, isActive) {
  const models=application.design_context.models||[];
  const types={text:'短文本',long_text:'长文本',integer:'整数',decimal:'数值',boolean:'是/否',date:'日期',choice:'单选',reference:'关联记录',detail:'明细表'};
  const roleNames=ids=>(ids||[]).map(id=>application.role_options?.find(role=>role.id===id)?.label||id).join('、')||'继承数据表';
  function capabilities(model){
    const value=model.capabilities;
    if(!value)return '<details data-model-capabilities><summary>查看规则</summary><p>未检查当前能力，请刷新配置。</p></details>';
    if(!value.revision)return `<details data-model-capabilities><summary>查看规则与权限</summary><p>${esc(value.reason||'尚未生效')}</p></details>`;
    const operationNames={read:'查看',create:'新建',update:'修改',recycle:'回收',restore:'恢复'};
    const fields=value.fields||[];
    return `<details data-model-capabilities><summary>查看规则与权限</summary>
      <p>生效版本 ${Number(value.revision||0)} · ${value.status==='checked'?'当前登录账号：'+esc(value.operations.map(op=>operationNames[op]||op).join('、')||'无可用操作'):'当前不可用'}；不代表其他员工权限。</p>
      ${value.reason?`<p role="status">${esc(value.reason)}</p>`:''}
      <p>记录范围：${value.record_scope==='own'?'普通员工仅本人创建':'按声明权限访问全部记录'}；查看：${esc(roleNames(value.read_roles))}；新建和修改：${esc(roleNames(value.write_roles))}。</p>
      <p>${value.deletion?.supported?'可恢复回收：'+esc(value.recycle_roles?.length?roleNames(value.recycle_roles):'仅系统管理员')+'；员工还须有原读写权限，不支持彻底删除或自动清除。':'不支持删除记录。'}停用应用只收起入口，不删除数据。</p>
      ${(value.unique_keys||[]).length?`<p>业务唯一键：${esc(value.unique_keys.map((group,index)=>'组合 '+(index+1)+'：'+group.map(id=>(fields.find(field=>field.id===id)||{}).label||id).join(' + ')).join('；'))}；同组合同值不能重复，回收记录仍占用。</p>`:''}
      ${fields.length?`<div class="model-capabilities-scroll"><table class="model-capabilities-table"><thead><tr><th>字段</th><th>类型与规则</th><th>查看 / 修改角色</th></tr></thead><tbody>${fields.map(field=>`<tr><td>${esc(field.label)}</td><td>${esc(types[field.type]||field.type)}${field.required?' · 必填':''}${field.deprecated?' · 已弃用':''}${field.target?' · 关联 '+esc(models.find(item=>item.id===field.target)?.definition.title||field.target):''}${field.constraints?' · '+esc(Object.entries(field.constraints).map(([key,v])=>({minimum:'最小值',maximum:'最大值',minLength:'最少字数',maxLength:'最多字数',minItems:'最少行数',maxItems:'最多行数'}[key]||key)+' '+v).join('，')):''}</td><td>${esc(roleNames(field.read_roles))} / ${esc(roleNames(field.write_roles))}</td></tr>`).join('')}</tbody></table></div>`:''}
      <small>规则来自已生效数据定义；上方配置字段编辑的是草稿。管理员保留管理权限，员工操作仍由服务端校验。</small>
    </details>`;
  }
  const dialogs=new Set();let disposed=false;
  const safe=()=>!disposed&&isActive();
  const track=dialog=>{for(const item of dialogs)if(!item.isConnected)dialogs.delete(item);dialogs.add(dialog);return dialog;};
  const form=options=>track(openSchemaForm(options));
  const create=()=>form({title:'新建数据表',properties:{title:{type:'string',title:'表名称',minLength:1,maxLength:100},kind:{type:'string',title:'用途',enum:['record','detail'],enumNames:['独立数据表','其他表中的明细行']}},required:['title','kind'],values:{kind:'record'},submitLabel:'配置字段',onSubmit:async value=>{if(safe())edit({definition:{schema_version:1,...value,fields:[],access:{read_roles:['Desk User'],write_roles:['Desk User'],record_scope:'own'}},revision:0});}});
  async function edit(model) {
    const draft=JSON.parse(JSON.stringify(model.definition));
    const dialog=document.createElement('dialog');dialog.className='schema-dialog model-dialog';
    dialog.innerHTML=`<section class="schema-form"><header class="model-editor-head"><h2>${esc(draft.title)}</h2><button class="btn btn-ghost" type="button" data-close>关闭</button></header><div data-model-fields></div><div class="schema-actions"><button class="btn btn-ghost" type="button" data-add-field>添加字段</button><button class="btn btn-ghost" type="button" data-access>数据权限</button><button class="btn btn-ghost" type="button" data-unique>业务唯一键</button><button class="btn btn-pri" type="button" data-prepare>检查变更</button></div><p class="schema-error" role="alert"></p><div data-change></div></section>`;
    let change=null,busy=false,requestKey=crypto.randomUUID();
    const alive=()=>dialog.isConnected&&safe();
    const error=dialog.querySelector('[role=alert]');
    const close=()=>{if(!busy)dialog.remove();};
    dialog.querySelector('[data-close]').onclick=close;
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    function drawFields(){
      dialog.querySelector('[data-model-fields]').innerHTML=`<div class="application-resource-list">${draft.fields.map((field,i)=>`<article><div><b>${esc(field.label)}</b><small>${esc(types[field.type])}${field.required?' · 必填':''}${field.deprecated?' · 已弃用':''}</small></div><button class="btn btn-ghost" type="button" data-field="${i}" ${change?'disabled':''}>编辑</button><button class="btn btn-ghost" type="button" data-remove="${i}" ${change?'disabled':''}>${model.active_revision?'弃用':'移除'}</button></article>`).join('')||'<p>添加第一个字段，例如“名称”或“金额”。</p>'}</div>`;
      dialog.querySelectorAll('[data-field]').forEach(b=>b.onclick=()=>fieldEditor(Number(b.dataset.field)));
      dialog.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const index=Number(b.dataset.remove);if(model.active_revision){draft.fields[index].deprecated=true;draft.fields[index].required=false;}else draft.fields.splice(index,1);requestKey=crypto.randomUUID();drawFields();});
      dialog.querySelectorAll('[data-add-field],[data-access],[data-unique],[data-prepare]').forEach(b=>b.disabled=Boolean(change));
    }
    function roleSchema(title,minItems=1){const roles=application.role_options||[];return {type:'array',title,minItems,items:{type:'string',enum:roles.map(r=>r.id),enumNames:roles.map(r=>r.label)}};}
    function fieldEditor(index) {
      const prior=draft.fields[index];
      const field=prior||{id:'field_'+crypto.randomUUID().replaceAll('-','').slice(0,12),type:'text',required:false};
      const targets=models.filter(m=>m.active_revision);
      const editor=form({title:prior?'编辑字段':'添加字段',properties:{
        label:{type:'string',title:'字段名称',minLength:1,maxLength:100},type:{type:'string',title:'字段类型',enum:Object.keys(types),enumNames:Object.values(types)},
        required:{type:'boolean',title:'必填'},options:{type:'string',title:'单选选项（每行一个，仅单选填写）',multiline:true},
        target:{type:'string',title:'关联目标（仅关联或明细填写）',enum:targets.map(m=>m.id),enumNames:targets.map(m=>m.definition.title)},
        minimum:{type:'number',title:'最小数值（可选）'},maximum:{type:'number',title:'最大数值（可选）'},
        minLength:{type:'integer',title:'最少字数（可选）',minimum:0},maxLength:{type:'integer',title:'最多字数（文本可选）',minimum:1},
        minItems:{type:'integer',title:'最少明细行数（可选）',minimum:0},maxItems:{type:'integer',title:'最多明细行数（可选）',minimum:1,maximum:1000},
        read_roles:roleSchema('额外限定查看角色（不选则继承）',0),write_roles:roleSchema('额外限定修改角色（不选则继承）',0)
      },required:['label','type'],values:{...field,...field.constraints,options:field.options?.join('\n'),read_roles:field.read_roles||[],write_roles:field.write_roles||[]},submitLabel:'保留字段',onSubmit:async values=>{
        const next={id:field.id,label:values.label,type:values.type,required:values.required,deprecated:Boolean(field.deprecated)};
        if(values.read_roles.length)next.read_roles=values.read_roles;
        if(values.write_roles.length)next.write_roles=values.write_roles;
        if(values.type==='choice')next.options=(values.options||'').split('\n').map(v=>v.trim()).filter(Boolean);
        if(['reference','detail'].includes(values.type))next.target=values.target;
        const constraints=values.type===field.type?{...field.constraints}:{};
        const keys=['integer','decimal'].includes(values.type)?['minimum','maximum']:['text','long_text'].includes(values.type)?['minLength','maxLength']:values.type==='detail'?['minItems','maxItems']:[];
        keys.forEach(key=>{if(values[key]!==undefined)constraints[key]=values[key];else delete constraints[key];});
        if(Object.keys(constraints).length)next.constraints=constraints;
        if(prior)draft.fields[index]=next;else draft.fields.push(next);
        requestKey=crypto.randomUUID();drawFields();
      }});
      const access=document.createElement('details');access.className='model-field-access';
      access.innerHTML='<summary>字段权限（默认继承数据表）</summary>';
      ['read_roles','write_roles'].forEach(key=>access.append(editor.querySelector('[data-schema-field="'+key+'"]')));
      editor.querySelector('.schema-fields').append(access);
      const typeControl=editor.querySelector('[name=type]');
      const showRelevant=()=>{
        const kind=Object.keys(types)[Number(typeControl.value)];
        const conditions={options:kind==='choice',target:['reference','detail'].includes(kind),minimum:['integer','decimal'].includes(kind),maximum:['integer','decimal'].includes(kind),minLength:['text','long_text'].includes(kind),maxLength:['text','long_text'].includes(kind),minItems:kind==='detail',maxItems:kind==='detail'};
        Object.entries(conditions).forEach(([key,visible])=>{editor.querySelector('[data-schema-field="'+key+'"]').hidden=!visible;});
        const targetControl=editor.querySelector('[name=target]');targetControl.required=conditions.target;
        for(const option of targetControl.options){if(option.value==='')continue;const target=targets[Number(option.value)];option.disabled=conditions.target&&((kind==='detail')!==(target.definition.kind==='detail'));}
        if(targetControl.selectedOptions[0]?.disabled)targetControl.value='';
      };
      typeControl.addEventListener('change',showRelevant);showRelevant();
    }
    dialog.querySelector('[data-add-field]').onclick=()=>fieldEditor(-1);
    dialog.querySelector('[data-access]').onclick=()=>form({title:'数据权限',properties:{read_roles:roleSchema('谁能读取记录'),write_roles:roleSchema('谁能新建和修改记录'),recycle_roles:roleSchema('额外允许回收/恢复的角色（还须有读写权限；不选则仅管理员）',0),record_scope:{type:'string',title:'普通用户可访问的记录',enum:['own','all'],enumNames:['仅本人创建','全部记录（如共享供应商）']}},required:['read_roles','write_roles','record_scope'],values:{recycle_roles:[],...(draft.access||{read_roles:['Desk User'],write_roles:['Desk User'],record_scope:'own'})},onSubmit:async value=>{draft.access=value;requestKey=crypto.randomUUID();}});
    function uniqueEditor(){
      const scalar=['text','long_text','integer','decimal','date','choice','boolean'];
      const candidates=draft.fields.filter(field=>scalar.includes(field.type)&&!field.deprecated);
      if(!candidates.length){error.textContent='请先添加可用作唯一键的标量字段（文本、数字、日期、选项或是/否）。';return;}
      const groups=draft.unique_keys||[];
      const list=document.createElement('div');list.className='model-unique-list';
      list.innerHTML='<h3>已声明组合</h3>'+(groups.length?groups.map((group,index)=>`<p><span>${esc(group.map(id=>draft.fields.find(field=>field.id===id)?.label||id).join(' + '))}</span> <button type="button" class="btn btn-ghost" data-unique-remove="${index}">移除</button></p>`).join(''):'<p>尚未声明唯一键；同组合同值的记录不能重复保存。</p>');
      const picker=form({title:'业务唯一键',description:'声明“组合唯一”：同组合字段值相同（任一字段为空则不参与）的记录不能重复。关联、明细与弃用字段不能作为唯一键。',
        properties:{fields:{type:'array',title:'添加一个唯一组合（可多选字段）',minItems:1,items:{type:'string',enum:candidates.map(field=>field.id),enumNames:candidates.map(field=>field.label)}}},
        required:['fields'],values:{fields:[]},submitLabel:'添加组合',onSubmit:async value=>{
          const keys=[...new Set(value.fields)].sort();
          if(!keys.length)throw Error('请选择至少一个字段。');
          draft.unique_keys=draft.unique_keys||[];
          if(draft.unique_keys.some(group=>group.join(',')===keys.join(',')))throw Error('该组合已声明。');
          draft.unique_keys.push(keys);requestKey=crypto.randomUUID();
          picker.querySelector('[data-cancel]').click();uniqueEditor();
        }});
      picker.querySelector('.schema-fields').prepend(list);
      list.querySelectorAll('[data-unique-remove]').forEach(button=>button.onclick=()=>{draft.unique_keys.splice(Number(button.dataset.uniqueRemove),1);requestKey=crypto.randomUUID();picker.querySelector('[data-cancel]').click();uniqueEditor();});
    }
    dialog.querySelector('[data-unique]').onclick=()=>uniqueEditor();
    async function run(task){if(busy)return;busy=true;error.textContent='';dialog.querySelectorAll('button').forEach(b=>b.disabled=true);try{await task();}catch(e){if(alive()){      error.textContent=e.message||String(e);
      if(change)try{const response=await api('/api/platform/object-changes/'+encodeURIComponent(change.id));const data=await response.json();if(response.ok&&alive())change=data.change;}catch{/* 保留原错误，不把网络失败当成迁移已成功。 */}
    }}finally{busy=false;if(alive()){drawFields();if(change)drawChange();dialog.querySelector('[data-close]').disabled=false;}}}
    dialog.querySelector('[data-prepare]').onclick=()=>run(async()=>{
      if(!draft.fields.length)throw Error('请至少添加一个字段。');
      const response=await submitJSON('/api/platform/application-definitions/'+encodeURIComponent(application.id)+'/object-changes',{definition:draft,idempotency_key:requestKey,object_id:model.id,expected_revision:model.revision});
      if(alive()){change=response.change;drawChange();}
    });
    function drawChange(){
      const status={Planned:'等待确认',Running:'执行中或待恢复',Failed:'执行未完成',Applied:'已完成',Cancelled:'已取消'};
      const reasons={field_removal_requires_deprecation:'字段不能直接删除，请弃用',type_or_target_change_requires_migration:'不能直接更换类型或关联目标'};
      const target=dialog.querySelector('[data-change]');
      target.innerHTML=`<h3>${esc(status[change.status]||change.status)}</h3><p>${change.plan.operation==='create'?'将创建数据表':'将更新表结构'}，不会自动改写旧记录。</p>${change.plan.blocked.map(i=>`<p class="schema-error">${esc(reasons[i.reason]||i.reason)}</p>`).join('')}<p>${esc(change.error||'')}</p><div class="schema-actions"><button class="btn btn-ghost" type="button" data-preview>预览录入表单</button>${['Planned','Failed','Running'].includes(change.status)?`<button class="btn btn-pri" type="button" data-execute ${change.plan.blocked.length?'disabled':''}>${change.status==='Planned'?'确认执行':'重试恢复'}</button>`:''}${change.status==='Planned'?'<button class="btn btn-ghost" type="button" data-cancel-change>取消计划</button>':''}</div>`;
      const summary=document.createElement('ul');
      const changes=change.plan.operation==='create'?change.definition.fields.map(f=>({field:f.id,operation:'add'})):change.plan.changes;
      const labels={add:'新增字段',update:'修改字段',permissions:'修改数据权限',references:'更新关联表版本',title:'修改表名称',unique_keys:'修改业务唯一键'};
      changes.forEach(item=>{const li=document.createElement('li');li.textContent=(labels[item.operation]||item.operation)+(item.field?' · '+(change.definition.fields.find(f=>f.id===item.field)?.label||item.field):'');summary.append(li);});
      target.querySelector('.schema-actions').before(summary);
      target.querySelector('[data-preview]').onclick=()=>{
        const preview=form({title:'表单预览 · '+draft.title,...change.input_schema,submitLabel:'关闭预览',onSubmit:async()=>{}});
        const closePreview=preview.querySelector('[type=submit]');closePreview.type='button';closePreview.onclick=()=>preview.remove();
      };
      target.querySelector('[data-execute]')?.addEventListener('click',()=>run(async()=>{const response=await submitJSON('/api/platform/object-changes/'+encodeURIComponent(change.id)+'/execute',{confirmed:true});change=response.change;dialog.remove();if(safe())await reload(change);}));
      target.querySelector('[data-cancel-change]')?.addEventListener('click',()=>run(async()=>{await submitJSON('/api/platform/object-changes/'+encodeURIComponent(change.id)+'/cancel',{});dialog.remove();if(safe())await reload();}));
    }
    document.body.append(dialog);track(dialog);dialog.showModal();drawFields();
    if(model.change_id)await run(async()=>{const response=await api('/api/platform/object-changes/'+encodeURIComponent(model.change_id));const data=await response.json();if(!response.ok)throw Error(data.error||'变更读取失败');change=data.change;});
  }
  return {create,edit,capabilities,hasOpenDialog:()=>[...dialogs].some(dialog=>dialog.isConnected),dispose(){disposed=true;dialogs.forEach(dialog=>dialog.remove());dialogs.clear();}};
}

function mountModelDesigner(container, application, reload, isActive) {
  const models=application.design_context.models||[];
  const designer=createModelDesigner(application,reload,()=>container.isConnected&&isActive());
  container.innerHTML=`<div class="platform-section-head"><h3>本应用的数据表</h3><button type="button" class="btn btn-pri" data-new-model>新建数据表</button></div><div class="application-resource-list">${models.map((model,i)=>`<article><div><b>${esc(model.definition.title)}</b><small>${model.definition.kind==='detail'?'明细表':'数据表'} · ${model.active_revision?'已建表':'未建表'}${model.change_id?' · 有待处理变更':''}</small></div><button class="btn btn-ghost" type="button" data-edit-model="${i}">${model.change_id?'处理变更':'配置字段'}</button></article>`).join('')||'<p class="cell-sub">先建数据表，再从应用中录入记录。</p>'}</div>`;
  container.querySelector('[data-new-model]').onclick=()=>designer.create();
  container.querySelectorAll('[data-edit-model]').forEach(button=>{
    const model=models[Number(button.dataset.editModel)];button.onclick=()=>designer.edit(model);
    const detail=document.createElement('div');detail.className='model-capabilities-row';detail.innerHTML=designer.capabilities(model);button.closest('article').after(detail);
  });
  return designer;
}
