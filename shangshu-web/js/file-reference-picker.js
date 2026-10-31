/* 文件库选择：邮件多选与表格导入单选共用，只读公共目录/版本服务。

   FIX-16 / MAIL-NEXT-01 + MAIL-NEXT-02（用户原话「Excel 是文件的一个分支」）：
   · **一份列表** —— 普通文件与 Excel 表格一起列，不再要求在「普通文件 / Excel」之间切换；
     服务端给的是同一条 files.file 记录，不复制两套文件记录。
   · **公共居中弹窗** —— 走 ui.dialog（tool-workspace 的公共弹窗件），
     不再在邮件正文下方就地展开一大块，把正文挤掉。
   · **确认才写回** —— 选中的先落在弹窗里（暂存），「确认添加」才写回草稿；
     「取消」不动原附件；重新打开不会产生重复附件。
   · 类型按**行**判定，不按列表分模式：Excel 表格行走受管快照
     （files.sheet_snapshot 冻结当前已保存内容），普通文件行走版本选择
     （files.versions 逐版本勾选）。 */
window.mountFileReferencePicker = function({ui,node,values:attachments,onChange,alive=()=>node.isConnected,preview=()=>{},max=20,kind='',extensions=[],placeholder='选择文件',attachMode='current'}) {
  const escape=ui.escape,notify=ui.notify,size=value=>value<1024?value+' B':value<1048576?(value/1024).toFixed(1)+' KB':(value/1048576).toFixed(1)+' MB';
  async function request(url,body){const response=await fetch(url,{signal:ui.signal,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok||data.ok===false){const error=Error(data.error||'文件读取失败');error.status=response.status;throw error;}return data.result||data;}

  node.className='file-reference-picker';
  node.innerHTML=`<button type="button" data-attachment-value aria-haspopup="dialog" aria-expanded="false" title="点击选择文件；Enter 打开选择弹窗"></button>
    <div data-attachment-selected></div>`;
  const q=s=>node.querySelector(s),value=q('[data-attachment-value]');
  const label=a=>a.name+(a.tag?' · '+a.tag:'');
  /* 弹窗打不开必须说一声 —— 原来直接 return，用户只看到「点了没反应」。 */
  const warn=message=>{
    if(typeof notify==='function'){notify(message,'error');return;}
    if(typeof globalThis.toast==='function')globalThis.toast(message,'','error');
  };
  let openDialogEl=null;
  const syncExpanded=()=>value.setAttribute('aria-expanded',openDialogEl&&openDialogEl.isConnected?'true':'false');
  /* Excel 表格按**扩展名**判定（服务端 sheet 口径是 file_kind=表格 且 file_name like %.xlsx），
     两者等价：xlsx 只可能落在「表格」这一类里。 */
  const isTable=file=>/\.xlsx$/i.test(String(file.file_name||''));
  const extOf=file=>{const m=/\.([a-z0-9]+)$/i.exec(String(file.file_name||''));return m?m[1].toLowerCase():'';};
  const kindLabel=file=>isTable(file)?'Excel 表格':({pdf:'PDF',doc:'Word',docx:'Word',txt:'文本',md:'文本',csv:'CSV',xls:'Excel',png:'图片',jpg:'图片',jpeg:'图片',webp:'图片',gif:'图片'}[extOf(file)]||extOf(file)||'文件');

  const draw=()=>{
    value.textContent=attachments.map(label).join('；')||placeholder;
    syncExpanded();
    q('[data-attachment-selected]').innerHTML=attachments.map((a,i)=>`<div class="file-picker-selected-row"><span class="file-picker-name">${escape(label(a))}</span><button class="file-picker-link" type="button" data-attachment-preview="${i}">预览</button><button class="file-picker-link dim" type="button" data-attachment-remove="${i}">移除</button></div>`).join('');
    node.querySelectorAll('[data-attachment-preview]').forEach(b=>b.onclick=()=>preview(attachments[Number(b.dataset.attachmentPreview)]));
    node.querySelectorAll('[data-attachment-remove]').forEach(b=>b.onclick=()=>{attachments.splice(Number(b.dataset.attachmentRemove),1);onChange();draw();});
  };

  /* ---- 弹窗：一份列表 + 暂存选择 ---- */
  function openDialog(){
    /* 已经开着一个就别再叠一层 —— 叠上去的第一层会被顶成 inert，看起来就像「没反应」。 */
    if(openDialogEl&&openDialogEl.isConnected){syncExpanded();return;}
    if(!ui.dialog){warn('附件选择暂不可用，请稍后重试');return;}
    /* 暂存：打开时从当前附件拷一份；确认才写回，取消原样不动。 */
    const staged=attachments.map(a=>({...a}));
    let currentPage=1,sequence=0,found=0,dialog=null;
    const dlg=ui.dialog({
      title:'选择附件',
      body:`<div class="file-reference-picker" data-picker-body>
        <div class="attachment-search"><input type="search" data-attachment-search aria-label="搜索文件库" placeholder="按文件名搜索（普通文件与 Excel 表格一起列）"><a href="index.html#/file-center" target="_blank" rel="noopener">打开文件库</a></div>
        <p class="file-picker-hint" data-pick-hint></p>
        <div class="file-picker-staged"><div class="file-picker-staged-hd">已选（<span data-pick-count>0</span>）</div><div data-pick-staged-list></div></div>
        <div data-attachment-options></div>
        <div class="attachment-pages"><button type="button" class="file-picker-link" data-pick-prev>上一页</button><span data-pick-status role="status"></span><button type="button" class="file-picker-link" data-pick-next>下一页</button></div>
      </div>`,
      actions:[{label:'取消',onClick:()=>ui.closeModal()},
               {label:'确认添加',variant:'pri',onClick:()=>{
                 attachments.length=0;attachments.push(...staged.map(a=>({...a})));
                 onChange();draw();ui.closeModal();
               }}],
    });
    if(!dlg)return;
    dialog=dlg;
    openDialogEl=dlg;
    syncExpanded();
    const get=s=>dlg.querySelector(s);
    const options=get('[data-attachment-options]'),statusEl=get('[data-pick-status]');
    const stagedList=get('[data-pick-staged-list]'),countEl=get('[data-pick-count]'),hint=get('[data-pick-hint]');

    const drawStaged=()=>{
      countEl.textContent=String(staged.length);
      stagedList.innerHTML=staged.length
        ? staged.map((a,i)=>`<div class="file-picker-selected-row"><span class="file-picker-name">${escape(label(a))}</span><button class="file-picker-link" type="button" data-staged-preview="${i}">预览</button><button class="file-picker-link dim" type="button" data-staged-remove="${i}">移除</button></div>`).join('')
        : '<p class="file-picker-empty">还没有选文件</p>';
      dlg.querySelectorAll('[data-staged-preview]').forEach(b=>b.onclick=()=>preview(staged[Number(b.dataset.stagedPreview)]));
      dlg.querySelectorAll('[data-staged-remove]').forEach(b=>b.onclick=()=>{staged.splice(Number(b.dataset.stagedRemove),1);drawStaged();});
    };

    /* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：候选那几行还没到 ⇒ **不写看得见的字**，
     *   换成会呼吸的灰条（形状照最终那一条条候选：类型位 ＋ 文件名位）。
     *   ⚠️ 骨架里**不写假内容**（没有假文件名、没有假项数）。
     *   ⚠️ 读屏的信号用 `aria-busy`（不写字）。 */
    const skeletonRow='<div class="platform-skeleton-row">'
      +'<span class="platform-skeleton-bar platform-skeleton-mark-bar"></span>'
      +'<span class="platform-skeleton-bar platform-skeleton-app-title"></span></div>';
    const setStatus=text=>{statusEl.removeAttribute('aria-busy');statusEl.textContent=text;};
    async function loadChoices(){
      const ticket=++sequence;
      statusEl.innerHTML='<span class="platform-skeleton-bar platform-skeleton-desc" data-skeleton="picker-status"></span>';
      statusEl.setAttribute('aria-busy','true');
      options.innerHTML='<div class="platform-skeleton" data-skeleton="picker-options" aria-busy="true">'
        +'<div class="platform-skeleton-list">'+skeletonRow.repeat(4)+'</div></div>';
      get('[data-pick-prev]').disabled=get('[data-pick-next]').disabled=true;
      try{
        const params=new URLSearchParams({page:String(currentPage),page_length:'20',filters:JSON.stringify({scope:'attachable',q:get('[data-attachment-search]').value.trim(),order:'desc',...(kind?{kind}:{})})});
        const data=await request('/api/platform/datasets/files.file/records?'+params);
        if(!alive()||ticket!==sequence||!dlg.isConnected)return;
        if(!Array.isArray(data.rows))throw Error('文件列表回执不完整');
        found=Number(data.total||0);
        /* extensions 是**落点业务约束**（表格导入只要 xlsx），不是「底层存储方式互斥入口」：
           不匹配的直接不列，而不是列出来再禁掉。 */
        const rows=extensions.length?data.rows.filter(f=>extensions.includes(extOf(f))):data.rows;
        options.innerHTML=rows.length?rows.map((f,i)=>`<div class="attachment-candidate"><button class="file-picker-link" type="button" data-pick-file="${i}"><span class="file-picker-kind">${escape(kindLabel(f))}</span>${escape(f.file_name)}</button><div data-pick-versions></div></div>`).join('')
          : '<p class="file-picker-empty">没有匹配的文件</p>';
        dlg.querySelectorAll('[data-pick-file]').forEach(button=>button.onclick=async()=>{
          const file=rows[Number(button.dataset.pickFile)],target=button.nextElementSibling;button.disabled=true;
          /* 取哪一份字节，**按落点**定，不按文件类型猜：
             · attachMode='current'（发附件）：Excel 表格发**当前已保存的内容** ——
               走受管快照，邮件只引用返回的 `file`（稳定引用），不存路径、不存原表名当内容。
             · attachMode='file'（表格导入等「要读原始文件」的落点）：一律走版本，
               因为那里要的是那个 xlsx 原件本身。 */
          if(attachMode!=='file'&&isTable(file)){
            target.textContent='正在取快照…';
            try{
              /* 快照在文件域里注册的是**动作**（shangshu_files.service.execute），
                 领域**服务**清单里没有它 → 走 /services/.../invoke 必然 404「领域服务不存在」
                 （活站实测：行下红字「取表格快照失败：领域服务不存在」）。 */
              const opId=newOpId();
              const response=await request('/api/platform/actions/files.sheet_snapshot/execute',
                {payload:{table:file.name,op_id:opId},confirmed:true,idempotency_key:opId,source:'user'}),
                result=response.result||response;
              if(!alive()||!target.isConnected||ticket!==sequence||!dlg.isConnected)return;
              if(!result.file||!result.file_name)throw Error('快照回执不完整');
              const entry={file:result.file,lib:result.lib||file.name,name:result.file_name,
                size:result.size||0,version:result.content_version,snapshot:true,
                tag:'快照 v'+(result.content_version||'?')};
              if(staged.some(a=>a.file===entry.file)){target.textContent='已加入：'+entry.file_name;button.disabled=false;return;}
              if(max===1)staged.splice(0);
              else if(staged.length>=max){notify('最多选择'+max+'个文件');button.disabled=false;return;}
              staged.push(entry);drawStaged();
              target.textContent='已加入：'+entry.file_name;
            }catch(error){
              if(alive()&&target.isConnected&&ticket===sequence){
                target.textContent=error.status===403
                  ? '没有下载权限，不能引用这个表格；请先申请下载权限'
                  : '取表格快照失败：'+error.message;
                button.disabled=false;
              }
            }
            return;
          }
          target.textContent='读取版本…';
          try{
            const response=await request('/api/platform/services/files.versions/invoke',{payload:{file:file.name}}),result=response.result||response;
            if(!alive()||!target.isConnected||ticket!==sequence||!dlg.isConnected)return;
            if(!Array.isArray(result.versions)||result.versions.some(v=>!v.frappe_file||!Number.isInteger(v.version_no)))throw Error('版本信息不完整');
            target.innerHTML=result.versions.map(v=>`<label class="pick-version"><input type="checkbox" data-pick-version="${escape(v.frappe_file)}">第 ${v.version_no} 版 · ${size(v.size||0)}</label>`).join('');
            target.querySelectorAll('[data-pick-version]').forEach(input=>{
              const v=result.versions.find(v=>v.frappe_file===input.dataset.pickVersion);
              input.checked=staged.some(a=>a.file===v.frappe_file);
              input.onchange=()=>{
                const index=staged.findIndex(a=>a.file===v.frappe_file);
                if(input.checked&&index<0){
                  if(max===1)staged.splice(0);
                  else if(staged.length>=max){input.checked=false;notify('最多选择'+max+'个文件');return;}
                  staged.push({file:v.frappe_file,lib:file.name,name:file.file_name,size:v.size||0,version:v.version_no,tag:'第 '+v.version_no+' 版'});
                }
                if(!input.checked&&index>=0)staged.splice(index,1);
                drawStaged();
              };
            });
          }catch(error){if(alive()&&target.isConnected&&ticket===sequence){target.textContent=error.message;button.disabled=false;}}
        });
        setStatus(found?`${currentPage} / ${Math.max(1,Math.ceil(found/20))}`:'没有匹配的文件');
        get('[data-pick-prev]').disabled=currentPage<=1;get('[data-pick-next]').disabled=currentPage*20>=found;
        if(extensions.length)hint.textContent='此处仅支持 '+extensions.join('、')+' 格式的文件';
      }catch(error){if(alive()&&ticket===sequence){setStatus(error.message);options.innerHTML='<button type="button" class="file-picker-link" data-pick-retry>重试读取</button>';get('[data-pick-retry]').onclick=loadChoices;}}
    }

    const newOpId=()=> (globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function')
      ? globalThis.crypto.randomUUID()
      : 'snap-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
    get('[data-attachment-search]').oninput=()=>{currentPage=1;const ticket=++sequence;ui.later(()=>{if(alive()&&ticket===sequence&&dlg.isConnected)loadChoices();},180);};
    get('[data-pick-prev]').onclick=()=>{currentPage--;loadChoices();};
    get('[data-pick-next]').onclick=()=>{currentPage++;loadChoices();};
    drawStaged();
    loadChoices();
  }

  value.onclick=openDialog;
  value.ondblclick=openDialog;
  value.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();openDialog();}};
  draw();
  return draw;
};