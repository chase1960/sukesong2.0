/* 应用内有限页面/审批组合；与数据设计共用草稿、表单和发布入口。 */
function mountApplicationPages(root, application, changed) {
  const draft=JSON.parse(JSON.stringify(application.draft));
  draft.pages ||= [];draft.workflows ||= [];draft.overview ||= false;
  const models=(application.design_context.models||[]).filter(m=>m.active_revision&&m.definition.kind==='record');
  const roles=application.role_options||[];
  const role=title=>({type:'string',title,enum:roles.map(r=>r.id),enumNames:roles.map(r=>r.label)});
  const pages=root.querySelector('[data-app-pages]'),flows=root.querySelector('[data-app-flows]');
  function draw(){
    pages.innerHTML=`<div class="platform-section-head"><h3>申请表与列表字段</h3><button type="button" class="btn btn-pri" data-add-page>新建申请表</button></div><div class="application-resource-list">${draft.pages.map((p,i)=>`<article><div><b>${esc(p.title)}</b><small>${esc(models.find(m=>m.id===p.object_id)?.definition.title||p.object_id)} · ${p.fields.length} 个字段 · ${p.columns} 列</small></div><button type="button" class="btn btn-ghost" data-page="${i}">编辑</button><button type="button" class="btn btn-ghost" data-remove-page="${i}">移除</button></article>`).join('')||'<p>从已有数据表选择字段，申请材料保存在流程实例中，不自动创建业务表记录。</p>'}</div><label><input type="checkbox" data-app-overview ${draft.overview?'checked':''}> 将应用总览设为首页（记录统计、申请入口、最近待办）</label>`;
    pages.querySelector('[data-app-overview]').onchange=e=>{draft.overview=e.target.checked;changed();};
    pages.querySelector('[data-add-page]').onclick=()=>chooseTable();
    pages.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>editPage(draft.pages[Number(b.dataset.page)],Number(b.dataset.page)));
    pages.querySelectorAll('[data-remove-page]').forEach(b=>b.onclick=()=>{
      const i=Number(b.dataset.removePage),p=draft.pages[i];
      if(draft.workflows.some(f=>f.form_id===p.id)){toast('仍被流程引用','请先修改或移除对应审批配置。');return;}
      draft.pages.splice(i,1);changed();draw();
    });
    flows.innerHTML=`<div class="platform-section-head"><h3>申请审批</h3><button type="button" class="btn btn-pri" data-add-flow ${draft.pages.length?'':'disabled'}>新建审批</button></div><div class="application-resource-list">${draft.workflows.map((f,i)=>`<article><div><b>${esc(f.title)}</b><small>${esc(draft.pages.find(p=>p.id===f.form_id)?.title||'申请表失效')} · ${esc(roles.find(r=>r.id===f.approver_role)?.label||f.approver_role)}${f.amount_field?' · 金额达到 '+esc(f.threshold)+' 时增加复核':''}</small></div><button class="btn btn-ghost" type="button" data-flow="${i}">编辑</button><button class="btn btn-ghost" type="button" data-remove-flow="${i}">移除</button></article>`).join('')||'<p>先配置申请表，再选择审批人。通过、退回修改、重新提交使用同一流程。</p>'}</div>`;
    flows.querySelector('[data-add-flow]').onclick=()=>editFlow();
    flows.querySelectorAll('[data-flow]').forEach(b=>b.onclick=()=>editFlow(draft.workflows[Number(b.dataset.flow)],Number(b.dataset.flow)));
    flows.querySelectorAll('[data-remove-flow]').forEach(b=>b.onclick=()=>{draft.workflows.splice(Number(b.dataset.removeFlow),1);changed();draw();});
  }
  function chooseTable(){
    openSchemaForm({title:'选择申请数据表',properties:{object_id:{type:'string',title:'数据表',enum:models.map(m=>m.id),enumNames:models.map(m=>m.definition.title)}},required:['object_id'],submitLabel:'配置字段',onSubmit:async value=>{
      const model=models.find(m=>m.id===value.object_id);
      editPage({id:'form_'+crypto.randomUUID().replaceAll('-','').slice(0,12),title:model.definition.title+'申请',object_id:model.id,fields:Object.keys(model.input_schema.properties),columns:1});
    }});
  }
  function editPage(page,index=-1){
    const model=models.find(m=>m.id===page.object_id);if(!model){toast('数据表不可用','请先处理数据定义。');return;}
    const fields=Object.entries(model.input_schema.properties);
    const listFields=fields.filter(([,f])=>f.type!=='array');
    openSchemaForm({title:'配置申请表',properties:{title:{type:'string',title:'表单名称',minLength:1,maxLength:100},fields:{type:'array',title:'申请表显示字段（必填不能隐藏）',minItems:1,items:{type:'string',enum:fields.map(([id])=>id),enumNames:fields.map(([id,f])=>f.title||id)}},list_fields:{type:'array',title:'数据列表显示列（同表以首张申请表配置为准）',minItems:1,items:{type:'string',enum:listFields.map(([id])=>id),enumNames:listFields.map(([id,f])=>f.title||id)}},columns:{type:'integer',title:'表单布局',enum:[1,2],enumNames:['单列','双列']}},required:['title','fields','list_fields','columns'],values:{...page,list_fields:page.list_fields||listFields.map(([id])=>id)},submitLabel:'保留到草稿',onSubmit:async value=>{
      const next={id:page.id,object_id:page.object_id,...value};if(index<0)draft.pages.push(next);else draft.pages[index]=next;changed();draw();
    }});
  }
  function editFlow(flow={},index=-1){
    const numbers=[...new Set(models.flatMap(m=>Object.entries(m.input_schema.properties).filter(([,f])=>['number','integer'].includes(f.type)).map(([id])=>id)))];
    openSchemaForm({title:'配置审批',properties:{title:{type:'string',title:'流程名称',minLength:1,maxLength:100},form_id:{type:'string',title:'申请表',enum:draft.pages.map(p=>p.id),enumNames:draft.pages.map(p=>p.title)},approver_role:role('审批角色'),amount_field:{type:'string',title:'金额判断字段（可选）',enum:numbers,enumNames:numbers.map(id=>models.flatMap(m=>Object.entries(m.input_schema.properties)).find(([key])=>key===id)?.[1].title||id)},threshold:{type:'number',title:'达到此金额增加复核（可选）'},escalation_role:role('金额复核角色（可选）')},required:['title','form_id','approver_role'],values:flow,submitLabel:'保留到草稿',onSubmit:async value=>{
      const next={id:flow.id||'approval_'+crypto.randomUUID().replaceAll('-','').slice(0,12),...value};
      if(index<0)draft.workflows.push(next);else draft.workflows[index]=next;changed();draw();
    }});
  }
  draw();
  return ()=>({pages:draft.pages,workflows:draft.workflows,overview:draft.overview});
}
