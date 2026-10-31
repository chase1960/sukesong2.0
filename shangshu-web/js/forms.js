/* 通用表单：契约字段、行绑定、错误保留，业务页面复用同一交互。 */
function yuanToCents(value) {
  const raw=String(value).trim();
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('金额最多填写两位小数');
  const sign=raw.startsWith('-')?-1:1,[whole,fraction='']=raw.replace(/^-/, '').split('.');
  const cents=sign*(Number(whole)*100+Number(fraction.padEnd(2,'0')));
  if(!Number.isSafeInteger(cents))throw new Error('金额超出可填写范围');
  return cents;
}
function openSchemaForm({title,description='',properties={},required=[],values={},hidden={},columns,submitLabel='提交',onSubmit}) {
  const dialog=document.createElement('dialog');
  dialog.className='schema-dialog';
  dialog.innerHTML=`<form class="schema-form"><h2>${esc(title)}</h2><p class="cell-sub">${esc(description)}</p><div class="schema-fields"></div><p class="schema-error" role="alert"></p><div class="schema-actions"><button type="button" class="btn btn-ghost" data-cancel>取消</button><button type="submit" class="btn btn-pri">${esc(submitLabel)}</button></div></form>`;
  const fields=dialog.querySelector('.schema-fields'),controls=new Map();
  if(columns===2){dialog.classList.add('schema-two-columns');fields.classList.add('schema-fields-two-columns');}
  if(columns===1)fields.classList.add('schema-fields-one-column');
  for(const [key,spec] of Object.entries(properties)) {
    if(key in hidden) continue;
    const centsField=key.endsWith('_cents')&&spec.type==='integer'&&!spec.enum;
    const fieldTitle=centsField?(spec.title||key).replace(/（分）$/, '').replace(/（元）$/, '')+'（元）':(spec.title||key);
    const label=document.createElement(spec.type==='array'?'div':'label');label.className='fld';label.dataset.schemaField=key;
    if(spec.type==='array'){label.setAttribute('role','group');label.setAttribute('aria-label',spec.title||key);}
    const caption=document.createElement('span');caption.textContent=fieldTitle+(required.includes(key)?' *':'');label.append(caption);
    if(spec.lookup){
      const select=document.createElement('select');select.name=key;select.setAttribute('aria-label',(spec.title||key)+(required.includes(key)?' *':''));
      const search=document.createElement('input');search.placeholder='按名称精确查找';search.setAttribute('aria-label','查找'+(spec.title||key));
      const toolbar=document.createElement('div');toolbar.className='schema-lookup-actions';
      const status=document.createElement('small');status.setAttribute('role','status');
      const buttons=['查找','上一页','下一页'].map(text=>{const b=document.createElement('button');b.type='button';b.className='btn btn-ghost';b.textContent=text;toolbar.append(b);return b;});
      let selected=values[key]||'',page=1,total=0,loading=false;
      select.onchange=()=>{selected=select.value;};
      const load=async()=>{
        loading=true;buttons.forEach(b=>b.disabled=true);
        /* —— **加载态＝会呼吸的骨架**（契约 `loading-state-v1.json`）：这一格还在取数
           ⇒ 摆一条呼吸的灰条，**不写看得见的加载文字**；读完仍是同一个 status 里那一行字
           （灰条被换掉 ⇒ 不跳版）。 —— */
        status.setAttribute('aria-busy','true');
        status.innerHTML='<span class="platform-skeleton-bar" data-skeleton="lookup-status" style="display:inline-block;width:64px;height:11px"></span>';
        try{
          const result=await spec.lookup({page,search:search.value,selected});
          if(!dialog.isConnected)return;
          total=result.total;select.replaceChildren(new Option('请选择',''));
          result.options.forEach(item=>select.add(new Option(item.label,item.value)));
          select.value=selected;status.removeAttribute('aria-busy');status.textContent=`第 ${page} / ${Math.max(1,Math.ceil(total/30))} 页`;
          const compact=total<=30&&!search.value&&page===1;search.hidden=compact;toolbar.hidden=compact;status.hidden=compact;
        }catch(error){status.removeAttribute('aria-busy');status.hidden=false;toolbar.hidden=false;status.textContent=error.message||'关联记录读取失败';}
        finally{loading=false;buttons[0].disabled=false;buttons[1].disabled=page<=1;buttons[2].disabled=page*30>=total;}
      };
      buttons[0].onclick=()=>{page=1;load();};buttons[1].onclick=()=>{page--;load();};buttons[2].onclick=()=>{page++;load();};
      search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();page=1;load();}};
      label.append(select,search,toolbar,status);fields.append(label);
      controls.set(key,{read:()=>{if(loading)throw Error('请等待关联记录加载');if(required.includes(key)&&!selected)throw Error((spec.title||key)+'不能为空');return selected||null;}});
      queueMicrotask(load);continue;
    }
    if(spec.type==='array' && spec.items?.type==='object') {
      const group=document.createElement('div');group.className='schema-detail';
      const rows=document.createElement('div');group.append(rows);
      const rowForms=[];
      const add=document.createElement('button');add.type='button';add.className='btn btn-ghost';add.textContent='添加明细';
      const addRow=(value={})=>{
        if(rowForms.length >= (spec.maxItems??1000))return;
        const row=document.createElement('div');row.className='schema-detail-row';
        const summary=document.createElement('span');
        const entry={value,element:row};
        const paint=()=>{summary.textContent=Object.entries(spec.items.properties||{}).map(([k,s])=>(s.title||k)+'：'+(entry.value[k]??'—')).join(' · ');};
        const edit=document.createElement('button');edit.type='button';edit.className='btn btn-ghost';edit.textContent='编辑';
        edit.onclick=()=>openSchemaForm({title:spec.title||key,properties:spec.items.properties,required:spec.items.required||[],values:entry.value,submitLabel:'保留明细',onSubmit:async data=>{entry.value={...Object.fromEntries(Object.keys(spec.items.properties||{}).map(k=>[k,data[k]??null])),...(entry.value._row_id?{_row_id:entry.value._row_id}:{})};paint();}});
        const remove=document.createElement('button');remove.type='button';remove.className='btn btn-ghost';remove.textContent='移除';
        remove.onclick=()=>{rowForms.splice(rowForms.indexOf(entry),1);row.remove();add.disabled=false;};
        row.append(summary,edit,remove);rows.append(row);rowForms.push(entry);paint();
        add.disabled=rowForms.length >= (spec.maxItems??1000);
        return edit;
      };
      (values[key]||spec.default||[]).forEach(value=>addRow(value));
      add.onclick=()=>{
        // 先填后加，取消子表单不留下空行。
        openSchemaForm({title:spec.title||key,properties:spec.items.properties,required:spec.items.required||[],submitLabel:'添加明细',onSubmit:async data=>{addRow(data);}});
      };
      group.append(add);label.append(group);fields.append(label);
      controls.set(key,{read:()=>{
        if(rowForms.length < (spec.minItems??(required.includes(key)?1:0)))throw Error((spec.title||key)+'的明细行数不足');
        return rowForms.map(row=>Object.fromEntries(Object.entries(row.value).filter(([key])=>key==='_row_id'||key in (spec.items.properties||{}))));
      }});
      continue;
    }
    if(spec.type==='array' && spec.items?.enum) {
      const group=document.createElement('div');group.className='schema-options';
      const checked=[];
      spec.items.enum.forEach((value,index)=>{
        const option=document.createElement('label'),input=document.createElement('input');input.type='checkbox';
        input.checked=(values[key]||spec.default||[]).includes(value);checked.push({input,value});
        option.append(input,document.createTextNode(spec.items.enumNames?.[index]||String(value)));group.append(option);
      });
      label.append(group);fields.append(label);
      controls.set(key,{read:()=>{const selected=checked.filter(item=>item.input.checked).map(item=>item.value);if(selected.length<(spec.minItems??0))throw Error((spec.title||key)+'至少选择一项');return selected;}});
      continue;
    }
    const structured=['array','object'].includes(spec.type);
    const control=document.createElement(spec.enum?'select':structured || spec.multiline?'textarea':'input');
    control.name=key;control.required=required.includes(key);
    if(spec.enum) {
      if(!control.required) control.add(new Option('请选择',''));
      spec.enum.forEach((v,i)=>control.add(new Option(spec.enumNames?.[i] || String(v),String(i))));
    } else if(control.tagName==='INPUT') {
      control.type=spec.type==='boolean'?'checkbox':['number','integer'].includes(spec.type)?'number':spec.format==='date' || spec.pattern==='^\\d{4}-\\d{2}-\\d{2}$'?'date':'text';
      if(control.type==='checkbox') control.required=false; // 必填表示必须提交布尔值，不表示必须选“是”。
      if(control.type==='number') {control.step=centsField?'0.01':spec.type==='integer'?'1':'any';if(spec.minimum!=null) control.min=centsField?spec.minimum/100:spec.minimum;if(spec.maximum!=null) control.max=centsField?spec.maximum/100:spec.maximum;}
      if(spec.minLength!=null) control.minLength=spec.minLength;
      if(spec.maxLength!=null) control.maxLength=spec.maxLength;
      if(spec.pattern && control.type==='text') control.pattern=spec.pattern;
    }
    if(control.tagName==='TEXTAREA' && !structured){
      if(spec.minLength!=null)control.minLength=spec.minLength;
      if(spec.maxLength!=null)control.maxLength=spec.maxLength;
    }
    const value=values[key] ?? spec.default;
    if(control.type==='checkbox') control.checked=Boolean(value);
    else if(value!==undefined && (spec.enum || value!==null)) control.value=spec.enum?String(spec.enum.findIndex(item=>JSON.stringify(item)===JSON.stringify(value))):structured?JSON.stringify(value,null,2):centsField?String(Number(value)/100):String(value);
    if(structured) control.rows=10;
    label.append(control);
    if(spec.suggestions) {
      const list=document.createElement('datalist');list.id='suggest-'+Math.random().toString(36).slice(2);control.setAttribute('list',list.id);
      for(const item of spec.suggestions) {const option=document.createElement('option');option.value=item.id;option.label=item.label;list.append(option);}label.append(list);
    }
    if(spec.description) {const hint=document.createElement('small');hint.textContent=spec.description;label.append(hint);}
      fields.append(label);controls.set(key,{control,spec,structured,centsField});
  }
  const close=()=>{dialog.remove();};
  dialog.querySelector('[data-cancel]').onclick=close;
  dialog.addEventListener('cancel',e=>{if(dialog.dataset.busy) e.preventDefault();else close();});
  dialog.querySelector('form').onsubmit=async e=>{
    e.preventDefault();if(dialog.dataset.busy || !e.target.reportValidity()) return;
    const error=dialog.querySelector('.schema-error');error.textContent='';
    try {
      const data={...hidden};
      for(const [key,{control,spec,structured,read,centsField}] of controls) {
        if(read){data[key]=read();continue;}
        if(control.value==='' && control.type!=='checkbox' && !required.includes(key)) continue;
        data[key]=spec.enum?spec.enum[Number(control.value)]:control.type==='checkbox'?control.checked:structured?JSON.parse(control.value):centsField?yuanToCents(control.value):['number','integer'].includes(spec.type)?Number(control.value):control.value;
      }
      dialog.dataset.busy='1';dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
      await onSubmit(data);close();
    } catch(err) {error.textContent=err.message || String(err);}
    finally {delete dialog.dataset.busy;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
  document.body.append(dialog);if(dialog.showModal) dialog.showModal();else dialog.setAttribute('open','');
  dialog.querySelector('input,select,textarea,button')?.focus();return dialog;
}
async function submitJSON(path,body,method='POST') {
  const r=await api(path,{method,body:JSON.stringify(body)});const data=await r.json();
  if(r.ok===false || data.ok===false || data.error) throw new Error(data.error || '提交失败');return data;
}
function localBusinessDate() {return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());}
