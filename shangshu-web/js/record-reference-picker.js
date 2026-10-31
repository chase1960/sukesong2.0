/* 文件审核与文件检索共用记录选择；只读公共对象接口，不缓存另一份业务数据。 */
window.mountRecordReferencePicker = function({ui,node,onPick,onCancel=()=>{},alive=()=>node.isConnected}){
  const esc=ui.escape,definitions=new Map(),pageLength=20;
  let ticket=0,page=1,objectPage=1,busy=false,disposed=false,controller=null;
  node.classList.add('record-reference-picker');
  const active=()=>!disposed&&!ui.disposed&&!ui.signal?.aborted&&alive()&&node.isConnected;
  function dispose(){disposed=true;ticket++;controller?.abort();ui.signal?.removeEventListener('abort',dispose);}
  function begin(){controller?.abort();controller=new AbortController();return {seq:++ticket,signal:controller.signal};}
  const current=read=>active()&&read.seq===ticket&&!read.signal.aborted;
  async function request(url,signal){const r=await fetch(url,{signal}),d=await r.json();if(!r.ok||d.ok===false)throw Error(d.error||'记录读取失败');return d;}
  ui.signal?.addEventListener('abort',dispose,{once:true});
  /* 目录只读当前页摘要；定义在选中对象后读取，记录页只取名称列。
     目录尚无 managed/read 筛选参数：总数与翻页按完整目录，本页资格仍沿原规则。 */
  node.innerHTML=`<div class="record-picker-tools"><input type="search" data-object-search aria-label="搜索关联数据表" placeholder="搜索数据表"><button type="button" class="btn" data-object-find>查找数据表</button></div><div class="record-picker-tools"><button type="button" class="btn" data-object-prev>上一页数据表</button><span data-object-page role="status"></span><button type="button" class="btn" data-object-next>下一页数据表</button></div><div class="record-picker-tools"><select aria-label="关联数据表"></select><input type="search" aria-label="搜索关联记录" placeholder="搜索记录"><button type="button" class="btn" data-record-find>搜索</button></div><div data-record-options role="status"></div><div class="record-picker-tools"><button type="button" class="btn" data-record-prev>上一页</button><span data-record-page></span><button type="button" class="btn" data-record-next>下一页</button><button type="button" class="btn" data-record-close>取消选择</button></div>`;
  const $=s=>node.querySelector(s),select=$('select'),search=$('[aria-label="搜索关联记录"]'),objectSearch=$('[data-object-search]');
  function clearRecords(message){
    $('[data-record-options]').textContent=message;$('[data-record-page]').textContent='';
    $('[data-record-prev]').disabled=$('[data-record-next]').disabled=true;
  }
  async function loadObjects(){
    if(!active()||busy)return;
    const read=begin(),requestedPage=objectPage,selectedId=select.value;
    select.disabled=true;select.innerHTML='';search.disabled=$('[data-record-find]').disabled=true;
    $('[data-object-prev]').disabled=$('[data-object-next]').disabled=true;
    $('[data-object-page]').textContent='正在读取可用数据表…';clearRecords('');
    try{
      const params=new URLSearchParams({page:String(requestedPage),page_length:String(pageLength),summary:'1',search:objectSearch.value.trim()});
      const data=await request('/api/platform/objects?'+params,read.signal);if(!current(read))return;
      if(!Array.isArray(data.list)||!Number.isInteger(data.total)||data.total<0)throw Error('数据表目录回执不完整');
      const objects=data.list.filter(o=>o.source==='managed'&&o.operations?.includes('read'));
      $('[data-object-page]').textContent=`目录第 ${requestedPage} 页 · 共 ${data.total} 项 · 本页可关联 ${objects.length} 张表`;
      $('[data-object-prev]').disabled=requestedPage===1;$('[data-object-next]').disabled=requestedPage*pageLength>=data.total;
      select.innerHTML=objects.map(o=>`<option value="${esc(o.id)}">${esc(o.title||o.name)}</option>`).join('');
      if(!objects.length){clearRecords(data.total?'本页暂无可关联数据表，请继续翻页或搜索。':'暂无可访问数据表，请先在表格中建表和录入记录。');return;}
      if(objects.some(o=>o.id===selectedId))select.value=selectedId;
      select.disabled=false;search.disabled=$('[data-record-find]').disabled=false;
      page=1;await loadRecords();
    }catch(e){if(current(read))$('[data-object-page]').textContent=e.message;}
  }
  async function loadRecords(){
    if(!active()||busy||!select.value)return;
    const read=begin(),id=select.value,requestedPage=page;
    clearRecords('正在读取…');
    try{
      let obj=definitions.get(id);
      if(!obj){
        const data=await request('/api/platform/objects/'+encodeURIComponent(id),read.signal);if(!current(read))return;
        obj=data.object;
        if(obj?.id!==id||!Array.isArray(obj.fields))throw Error('数据表定义回执不完整');
        definitions.set(id,obj);
      }
      const label=obj.fields.find(f=>f.type==='text')?.id,term=search.value.trim();
      const filters=term?(obj.query?.version===1?{$search:term}:label?{[label]:term}:{}):{};
      const params=new URLSearchParams({page:String(requestedPage),page_length:String(pageLength),filters:JSON.stringify(filters),fields:JSON.stringify(label?[label]:[]),include_definition:'0'});
      const d=await request('/api/platform/objects/'+encodeURIComponent(id)+'/records?'+params,read.signal);
      if(!current(read))return;
      if(!Array.isArray(d.rows)||!Number.isInteger(d.total)||d.total<0)throw Error('记录列表回执不完整');
      $('[data-record-options]').innerHTML=d.rows.map((r,i)=>`<button type="button" class="record-picker-row" data-record-pick="${i}">${esc(String(r[label]||r.name))}</button>`).join('')||'<p>没有匹配记录</p>';
      $('[data-record-page]').textContent=`第 ${requestedPage} 页 · ${d.total} 条`;
      $('[data-record-prev]').disabled=requestedPage===1;$('[data-record-next]').disabled=requestedPage*pageLength>=d.total;
      node.querySelectorAll('[data-record-pick]').forEach(b=>b.onclick=async()=>{
        if(busy||!current(read))return;busy=true;
        const selected=d.rows[Number(b.dataset.recordPick)];
        const controls=Array.from(node.querySelectorAll('button,input,select'),el=>[el,el.disabled]);
        controls.forEach(([el])=>el.disabled=true);
        try{
          /* 选择时仍重读完整记录，供原关联/审核消费；不把列表投影当成完整业务事实。 */
          const ref=await request('/api/platform/objects/'+encodeURIComponent(id)+'/records/'+encodeURIComponent(selected.name),read.signal);
          if(!current(read))return;
          await onPick({object_id:id,name:selected.name,object:ref.object,record:ref.record});
        }catch(e){if(current(read))ui.notify(e.message);}
        finally{busy=false;if(current(read))controls.forEach(([el,disabled])=>el.disabled=disabled);}
      });
    }catch(e){if(current(read))$('[data-record-options]').textContent=e.message;}
  }
  $('[data-object-find]').onclick=()=>{objectPage=1;loadObjects();};
  objectSearch.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();objectPage=1;loadObjects();}};
  $('[data-object-prev]').onclick=()=>{objectPage--;loadObjects();};$('[data-object-next]').onclick=()=>{objectPage++;loadObjects();};
  $('[data-record-find]').onclick=()=>{page=1;loadRecords();};select.onchange=()=>{page=1;loadRecords();};
  search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();page=1;loadRecords();}};
  $('[data-record-prev]').onclick=()=>{page--;loadRecords();};$('[data-record-next]').onclick=()=>{page++;loadRecords();};
  $('[data-record-close]').onclick=()=>{dispose();onCancel();};
  loadObjects();return {dispose,isBusy:()=>busy};
};
