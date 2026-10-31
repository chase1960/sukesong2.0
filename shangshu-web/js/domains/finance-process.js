/* 旧 Node 财务页退出默认产品面；旧收藏/直链统一落到领域数据页。 */
RENDER.review = () => { sessionStorage.setItem('shangshu.dataset.open','finance.invoice'); go('objects'); };
RENDER.accounting = () => { sessionStorage.setItem('shangshu.dataset.open','finance.ledger_entry'); go('objects'); };
RENDER.payables = () => { sessionStorage.setItem('shangshu.dataset.open','finance.payable'); go('objects'); };

// 财务办理界面归领域；公共流程页仅根据注册的 adapter ID 调度。
window.shangshuProcessAdapters=window.shangshuProcessAdapters||{};
window.shangshuProcessAdapters['finance.expense']=function({main,platformJSON,submitJSON,renderCenter,renderExecution,shortTime,key,beginView}) {
  const stateLabels = {
    'SS Draft':'草稿', 'SS Pending Manager Approval':'待经理审批', 'SS Needs Supplement':'待补充材料',
    'SS Pending Finance Review':'待财务复核', 'SS Pending Posting':'待过账',
    'SS Pending Payment':'待付款', 'SS Completed':'已完成'
  };
  const actionLabels = {
    submit:'提交审批', resubmit:'重新提交', manager_approve:'经理通过', manager_return:'退回补充',
    finance_approve:'财务通过', finance_return:'退回补充', post:'确认过账', pay:'确认付款'
  };
  const stateText=value=>stateLabels[value]||value||'—';
  function openExpenseWizard() {
    const dialog = document.createElement('dialog');
    dialog.className = 'schema-dialog pf-upload-dialog';
    dialog.innerHTML = `<form class="schema-form">
      <h2>发起费用报销</h2><p class="cell-sub">上传发票后，核对识别结果，再填写报销申请。</p>
      <label class="pf-file-drop"><input type="file" required accept=".pdf,.png,.jpg,.jpeg"><b>选择发票 PDF 或图片</b><span>文件私有保存，上传后先识别、再由你核对字段</span></label>
      <div class="pf-upload-status" hidden></div><p class="schema-error" role="alert"></p>
      <div class="schema-actions"><button type="button" class="btn btn-ghost" data-cancel>取消</button><button type="submit" class="btn btn-pri">上传并识别</button></div>
    </form>`;
    const close = () => dialog.remove();
    $('[data-cancel]', dialog).onclick = close;
    $('form', dialog).onsubmit = async event => {
      event.preventDefault();
      const file = $('input[type=file]', dialog).files[0];
      if (!file) return;
      const errorBox = $('.schema-error', dialog);
      const status = $('.pf-upload-status', dialog);
      errorBox.textContent = ''; status.hidden = false; status.textContent = '正在安全上传并识别票据，请稍候…';
      $$('button,input', dialog).forEach(control => control.disabled = true);
      try {
        const response = await fetch('/api/platform/finance/documents', {
          method:'POST', credentials:'include', headers:{ 'content-type':'application/octet-stream', 'x-file-name':encodeURIComponent(file.name) }, body:file
        });
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || '票据识别失败');
        close(); renderInvoiceCheck(data);
      } catch (error) {
        errorBox.textContent = error.message || String(error); status.hidden = true;
        $$('button,input', dialog).forEach(control => control.disabled = false);
      }
    };
    document.body.append(dialog); dialog.showModal?.();
  }

  function renderInvoiceCheck(result) {
    const invoice = result.invoice_data || {};
    openSchemaForm({
      title:'核对发票信息',
      description:'请核对识别出的发票信息。确认后继续填写报销单，系统不会自动入账。',
      submitLabel:'确认字段，继续填写报销单',
      required:['invoice_number','invoice_date','seller_name','total_amount'],
      values:invoice,
      properties:{
        invoice_number:{type:'string',title:'发票号码'}, invoice_date:{type:'string',format:'date',title:'开票日期'},
        seller_name:{type:'string',title:'销售方'}, seller_tax_id:{type:'string',title:'销售方税号'},
        buyer_name:{type:'string',title:'购买方'}, total_amount:{type:'number',title:'价税合计'},
        tax_amount:{type:'number',title:'税额'}, direction:{type:'string',title:'发票方向',enum:['Input','Output'],enumNames:['进项','销项']}
      },
      onSubmit:async fields => {
        await submitJSON(`/api/platform/finance/invoices/${encodeURIComponent(result.invoice)}/confirm`, {
          expected_version:Number(invoice.record_version || 1), fields, confirmed:true, idempotency_key:key('invoice-confirm')
        });
        openClaimForm(result.invoice, fields);
      }
    });
  }

  function openClaimForm(invoiceId, invoice) {
    openSchemaForm({
      title:'填写报销申请', description:`已核对发票 ${invoice.invoice_number || invoiceId}，金额 ${money(invoice.total_amount)}。创建后仍是草稿，由你确认提交。`,
      submitLabel:'创建报销草稿', required:['subject','department','cost_center','purpose'],
      values:{subject:`${invoice.seller_name || ''}费用报销`},
      properties:{
        subject:{type:'string',title:'报销事项'}, department:{type:'string',title:'所属部门'},
        cost_center:{type:'string',title:'成本中心'}, purpose:{type:'string',title:'费用用途',multiline:true}
      },
      onSubmit:async values => {
        const data = await submitJSON('/api/platform/finance/claims', { invoice:invoiceId, ...values, confirmed:true, idempotency_key:key('claim-create') });
        toast('报销草稿已创建','请在实例页确认后提交审批'); await renderInstance(data.claim);
      }
    });
  }

  /* —— **加载态＝会呼吸的骨架**（契约 `loading-state-v1.json`）：
     这一页还没到的是**流程实例页** ⇒ 骨架照那一页的**真形状**搭：
     上面一条头（返回键位 ＋ 标题位 ＋ 副标题位 ＋ 状态位），
     下面左右两栏（左栏三块卡：报销与发票／票据识别记录／执行时间线；右栏两块卡：当前办理／流程信息）。
     ⚠️ **真外壳留着**（`.pf-instance-head`／`.pf-instance-grid`／`.pf-card` 这些真布局类照旧用），
        只有「文字」换成灰底块 ⇒ 数据回来在**同一个容器**里原位替换，版式不跳。
     ⚠️ 骨架里**不写假标题、假金额、假状态**（真有的栏目名照留，值一律是灰条）。 —— */
  const instanceSkeleton = () => {
    const bar = (w, h, style = '') => `<span class="platform-skeleton-bar" style="display:block;width:${w}px;height:${h}px;${style}"></span>`;
    const fact = (label, w) => `<div><dt>${label}</dt><dd>${bar(w, 13)}</dd></div>`;
    return `<div class="platform-skeleton" data-skeleton="finance-instance" aria-busy="true">
      <div class="pf-instance-head">
        <span class="platform-skeleton-bar" style="display:inline-block;width:56px;height:22px;border-radius:6px"></span>
        <div>${bar(190, 15)}${bar(250, 11, 'margin-top:7px')}</div>
        <span class="platform-skeleton-bar" style="display:inline-block;width:64px;height:20px;border-radius:999px"></span>
      </div>
      <div class="pf-instance-grid">
        <main class="pf-instance-main">
          <section class="pf-card">
            <div class="pf-card-title"><h3>报销与发票</h3>${bar(58, 12, 'display:inline-block')}</div>
            <dl class="pf-facts">
              ${fact('发票号码', 108)}${fact('开票日期', 84)}${fact('销售方', 128)}
              ${fact('税额', 62)}${fact('部门', 76)}${fact('成本中心', 92)}
              <div class="wide"><dt>用途</dt><dd>${bar(180, 13)}</dd></div>
            </dl>
          </section>
          <section class="pf-card">
            <div class="pf-card-title"><h3>票据识别记录</h3>${bar(66, 14, 'display:inline-block;border-radius:999px')}</div>
            ${bar(150, 12, 'margin-bottom:9px')}${bar(96, 12)}
          </section>
          <section class="pf-card">
            <div class="pf-card-title"><h3>执行时间线</h3>${bar(46, 12, 'display:inline-block')}</div>
            ${bar(120, 12, 'margin-bottom:9px')}${bar(88, 12)}
          </section>
        </main>
        <aside class="pf-instance-side">
          <section class="pf-card pf-action-card">
            <h3>当前办理</h3>
            ${bar(140, 12, 'margin-bottom:11px')}
            <span class="platform-skeleton-btn" style="width:104px;height:28px"></span>
            <small>${bar(190, 10)}</small>
          </section>
          <section class="pf-card">
            <h3>流程信息</h3>
            <dl class="pf-side-facts">
              <div><dt>发起人</dt><dd>${bar(60, 13)}</dd></div>
              <div><dt>实例</dt><dd>${bar(84, 13)}</dd></div>
              <div><dt>当前节点</dt><dd>${bar(70, 13)}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </div>`;
  };

  async function renderInstance(id) {
    const isCurrent=beginView();
    const surface = $('#pf-surface', main);
    surface.className = 'pf-surface';
    surface.innerHTML = instanceSkeleton();
    try {
      const data = await platformJSON(`/api/platform/finance/claims/${encodeURIComponent(id)}`);
      if(!isCurrent())return;
      const claim = data.claim || {}, invoice = data.invoice || {}, extraction = data.extraction || {};
      if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({
        module:'flowdesign', view:'instance', entity_type:'expense_claim', entity_id:id,
        label:`报销实例 · ${claim.subject || id}`,
        editable_scope:'解释当前报销、票据、节点和执行记录；审批、过账与付款必须经过确认',
      });
      surface.innerHTML = `
        <div class="pf-instance-head"><button class="btn btn-ghost btn-sm" type="button" data-back>← 待办</button>
          <div><h2>${esc(claim.subject || id)}</h2><p>${esc(id)} · ${esc(stateText(claim.workflow_state))} · 流程版本 ${esc(data.process?.definition_version || '—')}</p></div>
          <span class="pf-state pf-state-lg">${esc(stateText(claim.workflow_state))}</span>
        </div>
        <div class="pf-instance-grid">
          <main class="pf-instance-main">
            <section class="pf-card"><div class="pf-card-title"><h3>报销与发票</h3><span>${money(claim.amount)}</span></div>
              <dl class="pf-facts">
                <div><dt>发票号码</dt><dd>${esc(invoice.invoice_number || '—')}</dd></div><div><dt>开票日期</dt><dd>${esc(invoice.invoice_date || '—')}</dd></div>
                <div><dt>销售方</dt><dd>${esc(invoice.seller_name || '—')}</dd></div><div><dt>税额</dt><dd>${money(invoice.tax_amount)}</dd></div>
                <div><dt>部门</dt><dd>${esc(claim.department || '—')}</dd></div><div><dt>成本中心</dt><dd>${esc(claim.cost_center || '—')}</dd></div>
                <div class="wide"><dt>用途</dt><dd>${esc(claim.purpose || '—')}</dd></div>
              </dl>
            </section>
            <section class="pf-card"><div class="pf-card-title"><h3>票据识别记录</h3><span class="pf-tag">${esc(extraction.selected_tool || '未选择')}</span></div>
              <p class="pf-explain">${esc(extraction.selection_reason || '按流程规则执行')}</p>
              ${extraction.candidate_tools?.length ? `<p class="pf-muted">候选工具：${extraction.candidate_tools.map(esc).join('、')}</p>` : ''}
            </section>
            ${renderFinance(data.finance)}
            <section class="pf-card"><div class="pf-card-title"><h3>执行时间线</h3><span>${(data.executions || []).length} 个节点</span></div>${renderExecution(data.executions || [])}</section>
          </main>
          <aside class="pf-instance-side">
            <section class="pf-card pf-action-card"><h3>当前办理</h3><p>${esc(nextHint(claim.workflow_state))}</p>
              <div class="pf-action-list">${(data.actions || []).length ? data.actions.map(action => `<button class="btn ${['manager_return','finance_return'].includes(action) ? 'btn-ghost' : 'btn-pri'}" type="button" data-instance-action="${action}">${esc(actionLabels[action] || action)}</button>`).join('') : '<span class="pf-muted">当前账号没有可执行操作</span>'}</div>
              <small>所有写操作都需在确认卡中明确确认，并写入审计记录。</small>
            </section>
            <section class="pf-card"><h3>流程信息</h3><dl class="pf-side-facts"><div><dt>发起人</dt><dd>${esc(claim.applicant || '—')}</dd></div><div><dt>实例</dt><dd>${esc(data.process?.name || '—')}</dd></div><div><dt>当前节点</dt><dd>${esc(data.process?.current_node || '—')}</dd></div></dl></section>
          </aside>
        </div>`;
      $('[data-back]', surface).onclick = () => renderCenter('pending');
      $$('[data-instance-action]', surface).forEach(button => button.onclick = () => handleAction(id, button.dataset.instanceAction, data));
    } catch (error) { if(!isCurrent())return; surface.innerHTML = `<div class="pf-empty pf-error">实例加载失败：${esc(error.message || error)}</div>`; }
  }

  function nextHint(state) {
    return ({
      'SS Draft':'核对内容后提交经理审批。', 'SS Pending Manager Approval':'经理核对费用真实性和归属。',
      'SS Needs Supplement':'根据退回原因补充说明并重新提交。', 'SS Pending Finance Review':'财务核对发票、科目和金额。',
      'SS Pending Posting':'确认借贷影响后生成不可变账务分录。', 'SS Pending Payment':'确认收款人、金额和付款账户。',
      'SS Completed':'该流程已经完成，账务与付款记录可追溯。'
    })[state] || '等待流程继续。';
  }

  function renderFinance(finance) {
    if (!finance) return '';
    const batches = finance.batches || [], entries = finance.entries || [], payable = finance.payable;
    return `<section class="pf-card"><div class="pf-card-title"><h3>财务结果</h3><span>${batches.length} 个凭证批次</span></div>
      ${batches.map(batch => `<div class="pf-posting"><div><b>${batch.batch_type === 'Payment' ? '付款凭证' : '费用凭证'}</b><small>${esc(batch.name)} · ${money(batch.total_amount)}</small></div>
        <div>${entries.filter(row => row.posting_batch === batch.name).map(row => `<span><i>${row.direction === 'Debit' ? '借' : '贷'}</i>${esc(row.account)} <b>${money(row.amount)}</b></span>`).join('')}</div>
        <em>${finance.balance?.[batch.name]?.balanced ? '借贷平衡' : '待核对'}</em></div>`).join('') || '<p class="pf-muted">尚未过账</p>'}
      ${payable ? `<div class="pf-payable"><span>应付状态：<b>${payable.status === 'Paid' ? '已结清' : '待支付'}</b></span><span>余额：<b>${money(payable.balance_amount)}</b></span></div>` : ''}
    </section>`;
  }

  function handleAction(claimId, action, context) {
    const requiresNote = ['manager_return','finance_return'].includes(action);
    const isPost = action === 'post', isPay = action === 'pay';
    const description = isPost
      ? `将生成不可变分录：借 管理费用—办公费 ${money(context.claim.amount)}；贷 其他应付款—员工 ${money(context.claim.amount)}。确认后只能红冲纠错。`
      : isPay ? `将支付 ${money(context.finance?.payable?.balance_amount)} 给 ${context.finance?.payable?.recipient || context.claim.payment_recipient}，并生成银行存款贷方分录。`
      : `${actionLabels[action] || action}将推进当前流程并写入审计记录。`;
    openSchemaForm({
      title:actionLabels[action] || '确认操作', description, submitLabel:`确认${actionLabels[action] || '执行'}`,
      required:requiresNote ? ['note'] : (isPay ? ['account'] : []),
      values:isPay ? {account:'基本户'} : {},
      properties:{
        ...(requiresNote || action === 'resubmit' ? {note:{type:'string',title:requiresNote ? '退回原因' : '补充说明',multiline:true}} : {}),
        ...(isPay ? {account:{type:'string',title:'付款账户'}} : {})
      },
      onSubmit:async values => {
        await submitJSON(`/api/platform/finance/claims/${encodeURIComponent(claimId)}/actions`, {
          action, ...values, confirmed:true, payable:context.finance?.payable?.name,
          expected_version:Number(context.finance?.payable?.record_version || 1), idempotency_key:key(action)
        });
        toast(`${actionLabels[action] || '操作'}已完成`,'流程状态和审计记录已更新'); await renderInstance(claimId);
      }
    });
  }

  return {launch:openExpenseWizard,renderInstance:item=>renderInstance(item.business_name)};
};
