/* 同一私人提案的逐项审核。值只写原文件／草稿，未知回执保留原请求核实。 */
(() => {
  const plain=value=>value && typeof value==='object' && 'type' in value ? String(value.value??'')
    : typeof value==='string' ? value : JSON.stringify(value??'');
  window.mountProposalReview=(host,proposal)=>{
    const card=document.createElement('section');card.className='cf-card business-confirm office-review';
    card.dataset.confirmId=proposal.id;host.append(card);
    let view,busy=false,uncertain=null,edits={};
    /* 这条提案是不是已经**全部处理完并落定**：回执里 remaining=0 且状态 confirmed。
       只认回执 —— 没拿到回执就不落定（不许乐观更新）。 */
    const settled=()=>!!view&&view.remaining===0&&view.status==='confirmed';
    const request=async(path,body)=>{
      const response=await api('api/platform/action-proposals/'+encodeURIComponent(proposal.id)+path,
        body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
      let result;try{result=await response.json();}catch{throw Object.assign(Error('回执无法读取，请用原编号核实'),{uncertain:true});}
      if(!response.ok||result.ok===false)throw Object.assign(Error(result.error||result.message||'操作未完成'),
        {known:!body||(Number(response.status)<500&&Number(response.status)!==408)});
      if(result.id!==proposal.id||!result.target||!Array.isArray(result.units)||typeof result.review_revision!=='string')
        throw Object.assign(Error('审核回执不完整，请用原编号核实'),{uncertain:true});
      return result;
    };
    const node=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
    const say=message=>{card.querySelector('[data-review-status]').textContent=message;};
    const guard=()=>{
      const object_id=view.target.module==='mail'?'mail.message':'files.file';
      if(!window.dispatchEvent(new CustomEvent('shangshu:before-object-change',{cancelable:true,
        detail:{object_id,name:view.target.table||view.target.file||view.target.mail}})))throw Object.assign(Error('当前记录有人工编辑，请先保存或处理草稿'),{known:true});
    };
    const changed=()=>window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{
      object_id:view.target.module==='mail'?'mail.message':'files.file',name:view.target.table||view.target.file||view.target.mail}}));
    /* 2026-10-21（agent 建表一线）：**落表后直接跳到那张表** ——
       回执里带得出 file_id（建表动作的回执本来就带），这一帧就跳：
       `index.html?object=<file_id>#/excel`。
       没有 file_id 的回执（格值那几支）**一个字都不动** —— 不许乱跳。 */
    const openCreated=()=>{
      const fileId=String((view&&view.result&&view.result.file_id)||'');
      if(!fileId)return;
      if(!window.dispatchEvent(new Event('shangshu:before-page-change',{cancelable:true})))return;
      const url=new URL(location.href);
      url.searchParams.set('object',fileId);
      url.hash='#/excel';
      location.href=url.toString();
    };
    async function accept(units,retry=false){
      if(busy)return;
      let submitted=false;
      try{
        guard();
        const body=retry?uncertain:{units,edited_value:Object.fromEntries(Object.entries(edits).filter(([key])=>!units||units.includes(key))),
          // **字段名跟内核对齐**：逐项审核口读的是 `expected_review_revision`（邮件那条、表格域那条都是这个名）。
          // 之前这里发的是 `review_revision` → 口里拿不到版本 → 回执读不出来 → 停在「结果尚未核实」，
          // 计数永远卡在「已保存 0 · 待审 N」（用户 2026-10-21 实测截图）。
          expected_review_revision:view.review_revision,op_id:'review-'+crypto.randomUUID()};
        if(!body)return;
        busy=true;uncertain=body;render();say('正在保存并读取正式结果…');
        submitted=true;view=await request('/accept',body);uncertain=null;edits={};changed();render();
        say(settled()?`已保存 ${view.accepted_count} 项，本提案已确认；以下原值已从正式记录读回。`:`已保存 ${view.accepted_count} 项，待审 ${view.remaining} 项；以下原值已从正式记录读回。`);
        openCreated();
      }catch(error){
        if(error.known&&submitted)uncertain=null;
        render();say(uncertain?'结果尚未核实。请用原编号重试，不要另建提案；已保存的结果不会重复执行。':error.message);
      }finally{busy=false;renderButtons();}
    }
    function renderButtons(){
      card.querySelectorAll('button,textarea').forEach(el=>{el.disabled=busy||!!uncertain;});
      const retry=card.querySelector('[data-review-retry]');if(retry)retry.disabled=busy;
    }
    const button=(label,handler,cls='ghost')=>{const el=node('button',label,'cf-btn '+cls);el.type='button';el.onclick=handler;return el;};
    /* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：回执还没到 ⇒ **不写看得见的字**。
     *   ⚠️ 状态位**不摆那个琥珀色的药丸**（药丸＝一种**状态**，回执没到就没有状态 ⇒ 那是假的）
     *   ⇒ 换成一条会呼吸的灰条；标题位同理。回执到了 ⇒ 换回真的状态与标题（**原位替换**，不跳版）。 */
    const skeletonBar=(cls,shape)=>{const bar=node('span','','platform-skeleton platform-skeleton-bar '+cls);bar.setAttribute('data-skeleton',shape);return bar;};
    function render(){
      card.replaceChildren();
      /* 计数与状态点：还有待审项 → 「已保存 N · 待审 M」；全部处理完 → 「已确认」。
         状态点跟着回执走，不靠猜（没回执就不落定）。 */
      const allDone=settled();
      const heading=node('div','','cf-heading');heading.append(node('span','修改审核'));
      heading.append(view?node('span',allDone?'已确认':`已保存 ${view.accepted_count} · 待审 ${view.remaining}`,'cf-tag'):skeletonBar('platform-skeleton-desc','review-state'));
      card.append(heading);
      if(allDone){card.classList.add('resolved');card.dataset.outcome='success';}
      if(view)card.append(node('h4',view.target.name,'cf-title'));
      else{const title=node('h4','','cf-title');title.append(skeletonBar('platform-skeleton-app-title','review-title'));card.append(title);}
      if(view){
        const locate=button('打开原件',()=>void locateTarget());card.append(locate);
        for(const unit of view.units){
          const row=node('div','','office-review-unit');row.dataset.reviewUnit=unit.unit_id;
          /* 「已暂存」是**自己的一档**（PKG-118-T01）—— 暂存 ≠ 采用 ≠ 保存。
             暂存过的项在表格工作面与审核中心里都写着「已暂存」，
             聊天这张卡也要写同一句（不许露出英文 `staged`）。 */
          row.append(node('strong',unit.label),node('span',{accepted:'已保存',rejected:'未采用',pending:'待审核',staged:'已暂存'}[unit.status]||unit.status,'cf-tag'));
          const before=node('div','','office-review-before');before.append(node('span','原值'),node('pre',plain(unit.original_value??unit.current_value)));row.append(before);
          if(unit.status==='pending' && unit.editable){
            const label=node('label','建议值');const input=document.createElement('textarea');input.rows=unit.kind==='html'?5:2;
            input.value=plain(edits[unit.unit_id]??unit.value);input.setAttribute('aria-label',unit.label+'建议值');
            input.oninput=()=>{
              const original=unit.value;
              if(original && typeof original==='object' && 'type' in original){
                if(input.value==='')edits[unit.unit_id]={type:'empty',value:null};
                else if(original.type==='number'){
                  const number=Number(input.value);input.setCustomValidity(Number.isFinite(number)?'':'请输入有效数字');
                  edits[unit.unit_id]={type:'number',value:number};
                }else if(original.type==='boolean'){
                  input.setCustomValidity(['true','false'].includes(input.value)?'':'请输入true或false');
                  edits[unit.unit_id]={type:'boolean',value:input.value==='true'};
                }else edits[unit.unit_id]={type:original.type,value:input.value};
              }else edits[unit.unit_id]=input.value;
            };
            label.append(input);row.append(label);
          }else{
            /* **暂存过的项显示的是 `staged_value`** —— 那是暂存时人改过的那个值
               （内核 `proposal_review.py` 明写：少了这个键，前端会把暂存的那一格
               显示成没改过的候选 ⇒ 人看到的是**假值**）。
               ⚠️ `staged_value` 缺了就回落 `unit.value`（没暂存改过值时两者相同）。 */
            const shown=unit.status==='staged'?(unit.staged_value??unit.value):(unit.adopted_value??unit.value);
            row.append(node('span',unit.status==='accepted'?'采用值':unit.status==='staged'?'暂存值':'建议值'),node('pre',plain(shown),'office-review-proposed'));
            if(unit.status==='accepted')row.append(node('span','当前正式值'),node('pre',plain(unit.current_value)));
          }
          /* 暂存过的项**也能采用**（内核 `/accept` 会带上暂存时那个值）——
             不许把它卡成「看得见、采用不了」。 */
          if(unit.status==='pending'||unit.status==='staged'){
            const one=button('保存此项',()=>{if(card.querySelector('textarea:invalid')){say('请先修正无效的建议值');return;}void accept([unit.unit_id]);},'ok');
            one.dataset.acceptUnit=unit.unit_id;row.append(one);
          }
          card.append(row);
        }
        const actions=node('div','','cf-actions');
        if(view.remaining){
          actions.append(button('保存全部待审项',()=>{if(!card.querySelector('textarea:invalid'))void accept(null);},'ok'));
          actions.append(button('不采用剩余建议',async()=>{
            if(busy||uncertain)return;busy=true;renderButtons();
            try{const result=await resolveConfirmation(proposal.id,'rejected');if(!result.ok)throw Error(result.error||'未能拒绝');
              view=await request('/review');changed();render();say('剩余建议已拒绝，之前保存的修改保留。');
            }catch(error){say('状态未确认：'+error.message+'；请重新读取核实。');}
            finally{busy=false;renderButtons();}
          },'no'));
        }
        if(uncertain){const retry=button('用原编号核实',()=>void accept(null,true),'ok');retry.dataset.reviewRetry='';actions.append(retry);}
        if(!uncertain)actions.append(button('重新核对',()=>void load()));
        card.append(actions);
      }
      const status=node('p','','office-review-status');status.dataset.reviewStatus='';status.setAttribute('role','status');card.append(status);renderButtons();
    }
    async function locateTarget(){
      if(!window.dispatchEvent(new Event('shangshu:before-page-change',{cancelable:true})))return;
      const url=new URL(location.href);url.searchParams.delete('application');url.searchParams.delete('dataset');
      if(view.target.table)url.searchParams.set('object',view.target.table);else url.searchParams.delete('object');
      history.replaceState(null,'',url);
      await go(view.target.module);
      if(typeof chatSetMode==='function')chatSetMode('split');
      window.dispatchEvent(new CustomEvent('shangshu:review-target',{detail:{...view.target,unit:view.units.find(u=>u.status==='pending')?.target}}));
    }
    async function load(){
      if(busy||uncertain)return;busy=true;renderButtons();
      try{view=await request('/review');edits={};render();}
      catch(error){say(error.message);if(!view){
        card.append(button('重试读取',()=>void load()),button('放弃此建议',async()=>{
          if(busy)return;busy=true;renderButtons();
          try{
            const result=await resolveConfirmation(proposal.id,'rejected');if(!result.ok)throw Error(result.error||'未能处理');
            card.replaceChildren(node('p',result.status==='rejected'?'已拒绝剩余建议；之前保存的事实保留。':'提案状态已变化，请核对原记录。'));
            card.classList.add('resolved');
          }catch(failure){say('拒绝状态未确认：'+failure.message+'；可用同一提案重试。');}
          finally{busy=false;renderButtons();}
        },'no'));
      }}
      finally{busy=false;renderButtons();}
    }
    /* 目标页（表格那条）把同一提案处理完了 → 这块面板重新读回一次，
       计数和「已确认」跟事实一致（不许停在「已保存 0 · 待审 1」）。
       只听**终态**事件：进度事件会打断人正在填的建议值。 */
    window.addEventListener('shangshu:review-resolved',event=>{
      if(event.detail?.proposal_id!==proposal.id)return;
      if(busy||uncertain)return;
      void load();
    });
    render();void load();return card;
  };
})();