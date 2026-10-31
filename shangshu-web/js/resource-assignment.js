/* 文件与 Excel 共用归属移交。权限由服务端每次重验，预览不是执行授权。 */
(() => {
const active = new WeakMap();
/* 「归属级别 + 部门」走**公共组件** resource-attribution.mjs（**摊开式**，全站同一件 —— PKG-016
   之后没有「点开再弹一扇窗」那种形态了）。本文件是经典脚本，拿不到 ES module 的导出 ——
   优先用全局挂件，否则动态 import。 */
const loadAttribution=async()=>{
  if(typeof globalThis.mountResourceAttribution==='function')return globalThis.mountResourceAttribution;
  const mod=await import('./resource-attribution.mjs');
  return mod.mountResourceAttribution;
};
window.openResourceAssignment = async function({host, resource, title, onSaved, signal}) {
  if(active.has(host))return;
  const ui=window.createToolWorkspace(host,{signal}), esc=ui.escape;
  active.set(host,ui);
  let busy=false, pending=null, preview=null, disposed=false;
  let mountResourceAttribution;
  try{mountResourceAttribution=await loadAttribution();}
  catch(e){active.delete(host);ui.dispose();window.toast?.('归属组件加载失败，请刷新后重试','error');return;}
  const dialog=ui.dialog({title:'调整归属 · '+title,body:`<p>归属调整可能改变其他人的访问权限。部门管理人可明确清空。</p><div class="attribution-field"><span>归属级别</span><div data-resource-attribution></div></div><label class="dlg-field"><span data-owner-label>所有人</span><select data-owner><option value="">请选择人员</option></select></label><section data-preview hidden></section><p data-error role="alert"></p>`,actions:[{label:'取消',onClick:()=>{if(!busy&&!pending)ui.dispose();}},{label:'预览影响',variant:'pri',onClick:()=>void submit()}],onClose:()=>{disposed=true;active.delete(host);queueMicrotask(()=>ui.dispose());}});
  if(!dialog){active.delete(host);ui.dispose();return;}
  const get=s=>dialog.querySelector(s), owner=get('[data-owner]'), button=get('[data-act="1"]'), error=get('[data-error]'), area=get('[data-preview]');
  /* 归属级别 + 部门：公共组件（摊开式，两张选项卡直接摊在这扇对话框里）。
     部门候选**不自己拉** —— 这里的候选来自协作分组（跟文件侧那套部门数据集不是一套），
     所以走「调用方直接给列表」那条路（departmentSource:'provided'）。 */
  const attribution=mountResourceAttribution(get('[data-resource-attribution]'),{ui,label:'',defaultLevel:'personal',
    levels:[{value:'personal',label:'个人',hint:'这份内容归某一个具体的人。'},{value:'department',label:'部门',hint:'这份内容归某个部门，部门成员可访问。'}],
    departmentLabel:'部门',departmentSource:'provided',onChange:()=>changed()});
  ui.guardModal(dialog,()=>!busy&&!pending);
  ui.guardLeave(()=>!busy&&!pending);
  function state(){owner.disabled=busy||!!pending;attribution.lock(busy||!!pending);button.disabled=busy;button.textContent=pending?'核实原移交结果':preview?'确认移交':'预览影响';get('[data-act="0"]').disabled=busy||!!pending;}
  function changed(){preview=null;area.hidden=true;const level=attribution.getValue().level;get('[data-owner-label]').textContent=level==='department'?'当前管理人':'所有人';owner.options[0].textContent=level==='department'?'无管理人（明确清空）':'请选择人员';state();}
  async function request(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||d.ok===false)throw Object.assign(Error(d.error||'请求失败'),{status:r.status});return d.result||d;}
  async function action(payload,key){return request('/api/platform/actions/platform.org.resource_assign/execute',{payload,confirmed:true,idempotency_key:key});}
  async function submit(){
    if(busy||disposed)return;
    error.textContent='';
    const attr=attribution.read();
    if(!pending&&!attr.ok){error.textContent=attr.reason;return;}
    /* 部门归属可以**明确清空**管理人 ⇒ 只有「个人」级别才必须选人。 */
    if(!pending&&attr.value.level==='personal'&&!owner.value){error.textContent='请选择有效的所有人或部门';return;}
    busy=true;state();
    try{
      if(!preview&&!pending){
        const payload={resource,level:attr.value.level,owner_user:owner.value,...(attr.value.level==='department'?{department:attr.value.department}:{})};
        const result=await action({...payload,dry_run:true},crypto.randomUUID());
        if(result.applied!==false||result.resource!==resource||typeof result.expected_modified!=='string'||!result.expected_modified||!Array.isArray(result.effects))throw Error('预览回执不完整，请重新预览');
        preview={payload,version:result.expected_modified};
        const labels={read:'读取',write:'编辑',structure:'结构',download:'下载',share:'共享',assign:'归属管理'},val=v=>v==='legacy'?'原有规则':v?'允许':'不允许';
        area.innerHTML='<h3>影响预览</h3><p>当前：'+esc(result.current?.level==='department'?'部门 '+(result.current.department||'')+'；管理人 '+(result.current.owner_user||'无'):'个人 '+(result.current?.owner_user||'未设置'))+'</p><p>调整为：'+esc(attr.value.level==='department'?'部门 '+attribution.departmentText()+'；管理人 '+(owner.value?owner.selectedOptions[0].textContent:'无'):owner.selectedOptions[0].textContent)+'</p>'+ (result.effects.length?'<ul>'+result.effects.map(row=>'<li>'+esc(row.user)+'：'+Object.entries(labels).filter(([k])=>row[k]).map(([k,label])=>label+' '+esc(val(row[k].before))+' → '+esc(val(row[k].after))).join('；')+'</li>').join('')+'</ul>':'<p>未发现上述权限变化。</p>');area.hidden=false;
      }else{
        if(!pending)pending={payload:{...preview.payload,dry_run:false,expected_modified:preview.version},key:crypto.randomUUID()};
        const result=await action(pending.payload,pending.key);
        if(result.applied!==true||typeof result.modified!=='string'||!result.modified)throw Error('移交结果不完整，请核实原操作');
        pending=null;preview=null;ui.dispose();
        try{await onSaved?.();}catch(e){window.toast?.('归属已调整，列表刷新失败',e.message);}
      }
    }catch(e){error.textContent=e.message||'操作失败';if(e.status>=400&&e.status<500&&![408,429].includes(e.status)){pending=null;preview=null;area.hidden=true;}}
    finally{busy=false;if(!disposed)state();}
  }
  busy=true;state();
  try{
    const data=await request('/api/platform/services/identity.list_collaboration_people/invoke',{payload:{include_groups:true}});
    if(disposed)return;
    for(const p of data.people||[]){if(!p.user_name)continue;const o=document.createElement('option');o.value=p.user_name;o.textContent=p.display_name||p.user_name;owner.append(o);}
    /* 部门候选：协作分组 —— 跟文件侧那套部门数据集不是一份，交给公共组件吃。 */
    attribution.setDepartments((data.groups||[]).map(d=>({value:d.department_id||d.id||d.name,label:d.department_name||d.display_name||d.department_id||d.id||d.name})).filter(d=>d.value));
  }catch(e){error.textContent='候选读取失败：'+e.message;button.hidden=true;}
  finally{busy=false;if(!disposed)state();}
  return {dispose:()=>ui.dispose(),dialog};
};

})();
