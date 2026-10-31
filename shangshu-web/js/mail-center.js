/* 邮件工作面：个人邮箱与草稿/收发均由邮件域管理；交互样例永不外发。 */
window.mountMailCenter = function (host, {signal, examples: showExamples = false} = {}) {
  host.classList.add('mail-center-page');
  const icons = {reply:'<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7"/>',all:'<path d="m9 5-6 6 6 6M14 5l-6 6 6 6M9 11h7a5 5 0 0 1 5 5"/>',forward:'<path d="m15 5 6 6-6 6M21 11H11a7 7 0 0 0-7 7"/>',save:'<path d="M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',send:'<path d="m3 3 19 9-19 9 3-9-3-9ZM6 12h16"/>',attach:'<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',compose:'<path d="M13 4H4v16h16v-9M12 12l-1 4 4-1 7-7-3-3-7 7"/>',sync:'<path d="M20 7a9 9 0 0 0-15-2L3 7M3 3v4h4M4 17a9 9 0 0 0 15 2l2-2M21 21v-4h-4"/>'};
  const mailIcon = name => `<svg class="mail-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.compose}</svg>`;
  const actionLabel = (label,icon) => mailIcon(icon)+`<span>${label}</span>`;
  /* —— 骨架（邮件列表还没到时的占位）——
     照**真邮件行**搭：勾选位 ＋ 上面一条（主题／状态）＋ 下面一条（人／日期），
     真外壳留着（`.mail-select-row`／`.mail-item`）⇒ 数据到了原位替换，版式不跳。
     ⚠️ 只表示「正在取数」⇒ 不写假主题、不写假收件人、不写假日期。 */
  const mailListSkeleton=(count=6)=>Array.from({length:count},()=>'<div class="mail-select-row platform-skeleton" data-skeleton="mail-row">'
    +'<span class="mail-row-select"><span class="platform-skeleton-bar" style="width:14px;height:14px;border-radius:3px"></span></span>'
    +'<span class="mail-item"><span class="mail-item-top"><span class="platform-skeleton-bar" style="width:38%;height:13px"></span><span class="platform-skeleton-bar" style="width:56px;height:11px;margin-left:auto"></span></span>'
    +'<span class="mail-item-foot"><span class="platform-skeleton-bar" style="width:84px;height:11px"></span><span class="platform-skeleton-bar" style="width:56px;height:11px"></span></span></span></div>').join('');
  /* 候选卡那一块（待审候选弹窗）的骨架：一张卡＝一行来源 ＋ 一行说明 ＋ 一块差异区。 */
  const reviewCandidatesSkeleton=()=>'<div class="platform-skeleton" data-skeleton="review-candidates">'
    +'<div class="platform-skeleton-list">'+Array.from({length:2},()=>'<div class="platform-skeleton-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 0">'
    +'<span class="platform-skeleton-bar" style="width:34%"></span><span class="platform-skeleton-bar" style="width:72%"></span>'
    +'<span class="platform-skeleton-bar" style="width:100%;height:56px"></span></div>').join('')+'</div></div>';
  host.innerHTML = `
    <header class="mail-heading page-heading">
      <h1>邮箱</h1><select id="mailbox-switch" class="mailbox-switch" aria-label="当前邮箱" disabled title="切换个人邮箱和已获授权的共享邮箱"><option value="">正在读取邮箱…</option></select><span class="preview-label">${showExamples?'交互样例 · 不发送':'正在连接…'}</span>
      <div class="mail-management-actions" role="group" aria-label="邮箱管理">
      <button class="btn btn-ghost" id="accounts-btn" disabled>邮箱设置</button>
      <button class="btn btn-ghost" id="sig-btn" disabled title="设置发信末尾自动带的默认签名">签名</button>
      <button class="btn btn-ghost" id="access-btn" disabled title="设置这个邮箱上各人的阅读、草稿、代发、配置、签名权限">权限</button>
      </div>
      <button class="btn btn-ghost" id="mail-sync" disabled>立即同步</button>
      <button class="btn btn-pri" id="compose" disabled>正在读取…</button>
      <button class="btn btn-ghost" id="examples-toggle">查看交互样例</button>
    </header>
    <div class="mail-body">
      <section class="mail-list-pane" aria-label="邮件列表">
        <div class="mail-tools">
          <label class="mail-search"><input type="search" id="search" placeholder="搜索主题、联系人或正文" aria-label="搜索邮件"></label>
          <select id="mail-box" aria-label="邮件状态"><option value="all">全部邮件</option><option value="inbox">收件箱</option><option value="draft">草稿箱</option><option value="queued">发送中</option><option value="sent">已发送</option><option value="failed">失败待处理</option><option value="trash">已删除</option><option value="candidates">发信候选（待审）</option></select>
          <select id="filter" aria-label="筛选"><option value="">全部</option><option value="unread">未读</option><option value="attach">带附件</option></select>
          <button class="mail-link dim" id="clear">清除筛选</button>
        </div>
        <div class="mail-list-meta"><span class="mail-count" id="result-count" aria-live="polite"></span><button id="sort" aria-label="按时间排序">时间 ↓</button></div>
        <div class="mail-selection-bar" role="group" aria-label="邮件批量操作">
          <label class="mail-select-all"><input type="checkbox" id="mail-select-all" aria-label="选择本页邮件"><span>本页</span></label><span id="mail-selection-count" role="status">未选择</span>
          <button class="btn btn-ghost" type="button" id="mail-batch-recycle" disabled>${actionLabel('批量回收','trash')}</button><button class="mail-link dim" type="button" id="mail-selection-clear" hidden>清除选择</button>
        </div><div id="mail-batch-results" class="mail-batch-results" role="status" aria-live="polite" hidden></div>
        <div class="mail-scroll" id="mail-rows"></div>
        <!-- 「发信候选（待审）」那一档的内容落在这里（邮件域那块填）；
             那一档没选中时整块藏着（不许在别的档里冒出来）。 -->
        <div class="mail-candidates" id="mail-candidates" hidden></div>
        <div class="mail-pagination" id="mail-pagination" hidden><button class="btn btn-ghost" id="mail-prev">上一页</button><span id="mail-page"></span><button class="btn btn-ghost" id="mail-next">下一页</button></div>
      </section>
      <div class="mail-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整邮件列表宽度" aria-valuemin="260" aria-valuemax="560"></div>
      <section id="detail" class="mail-reading-pane" aria-label="邮件内容"></section>
    </div>
    <footer class="preview-footer"><span class="preview-dot"></span>${showExamples?'交互样例仅当前页面有效，不发送真实邮件。':'正在读取邮箱连接与邮件列表…'}</footer>`;
  const ui = window.createToolWorkspace(host, {signal});
  const {$, escape, notify} = ui;
  const dispose = () => ui.dispose();

  const ME = {name: '王子菁', addr: 'wzj@shangshu.local'};
  const uid = () => (crypto.randomUUID?.() || `m-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  // FIX-46（用户 2026-10-20 13:38：「这个 excel 以后会有版本的说法吗？不是只有多种表格吗？」）：
  // 表格**没有版本**，只有多张表 —— 后端 `upload()` 钉着「表格资源同名上传恒为新表：
  // 不追旧版本、不接回原表」（Excel 交互契约 §2）；**普通文件**同名重传才是新增版本。
  // 改之前这里给那个 xlsx 列了「当前版本 / 历史版本」⇒ 把普通文件的版本概念套到了表格上。
  // 现在：**表格只列当前这一条**（表本身），普通文件照旧列版本。
  const lib = [
    {id: 'L1', name: '审查意见答复正文.docx', size: 77824, versions: [{v: '当前版本 · 2026-09-18', tag: 'v3'}]},
    {id: 'L2', name: '权利要求修改对照表.xlsx', size: 46080, versions: [{v: '表格 · 上传于 2026-09-18', tag: ''}]},
    {id: 'L3', name: '授权委托书模板.pdf', size: 1258291, versions: [{v: '当前版本 · 2026-09-01', tag: 'v1'}]},
    {id: 'L4', name: '缴费凭证.png', size: 81920, versions: [{v: '当前版本 · 2026-09-20', tag: 'v1'}]},
    {id: 'L5', name: '审查流程说明.pdf', size: 204800, versions: [{v: '当前版本 · 2026-09-18', tag: 'v2'}, {v: '历史版本 · 2026-09-02', tag: 'v1'}]},
  ];
  const accounts = [
    {addr: 'wzj@shangshu.local', use: '个人邮箱'},
    {addr: 'ip-flow@shangshu.local', use: '共享邮箱 · 流程组'},
  ];
  const samples = [
    {box: 'inbox', from: {name: '张总', addr: 'zhang@acme.example.com'}, subject: '关于CN3024518案件的审查意见答复', body: '王老师：\n\n审查意见通知书已收到，请帮忙评估答复期限和修改幅度。客户希望在缴费前先看一遍答复稿。\n\n张总', date: '2026-09-21 09:12', unread: true, attachments: [{lib: 'L3', name: '审查意见通知书.pdf', size: 2202009, tag: ''}]},
    {box: 'inbox', from: {name: '专利局通知', addr: 'notice@cpoffice.example.gov.cn'}, subject: '补正通知书送达（申请号 202630123456.7）', body: '经审查，该申请存在形式缺陷，请于指定期限内补正。补正文件见附件。', date: '2026-09-20 16:40', unread: true, attachments: [{lib: 'L3', name: '补正通知书.pdf', size: 880640, tag: ''}]},
    {box: 'inbox', from: {name: '李经理', addr: 'li@acme.example.com'}, subject: 'Re: 新申请材料清单', body: '材料清单收到，我们这周内补齐身份证复印件和委托书，其余没有问题。', date: '2026-09-20 11:05', unread: false, attachments: []},
    {box: 'inbox', from: {name: '王工', addr: 'wang@partner.example.com'}, subject: '9月委托批次明细', body: '附件是9月委托批次，共 14 件，请核对后回复确认。', date: '2026-09-19 15:22', unread: true, attachments: [{lib: 'L2', name: '9月委托明细.xlsx', size: 46080, tag: 'v3'}]},
    {box: 'inbox', from: {name: '张总', addr: 'zhang@acme.example.com'}, subject: 'Re: 关于CN3024518案件的审查意见答复', body: '好的，答复稿出来先发我看。', date: '2026-09-19 10:03', unread: false, attachments: []},
    {box: 'inbox', from: {name: '周助理', addr: 'zhou@shangshu.local'}, subject: '周报提醒', body: '本周周报请在周五 17:00 前提交。', date: '2026-09-18 09:00', unread: false, attachments: []},
    /* 这一封带 表格＋合并单元格＋受管内嵌图，用于验收「读信」显示。
       用户实测反馈 5.1「没有这个邮件」—— 此前样例全是纯文本，表格/合并格/内嵌图
       根本没东西可验。金额与日期取自脱敏样例，不代表真实案件。 */
    {box: 'inbox', from: {name: '李经理', addr: 'li@acme.example.com'}, subject: '年费核对表（含合并表头与签章）', bodyFormat: 'HTML',
      body: '<p>王老师：</p><p>本期年费核对如下，请查收。合计与明细见下表。</p>' +
        '<table border="1" cellpadding="4" cellspacing="0"><thead><tr><th colspan="2">案件汇总</th><th>金额</th></tr></thead><tbody>' +
        '<tr><td rowspan="2">A001</td><td>年费</td><td>1,234,567.89</td></tr>' +
        '<tr><td>滞纳金</td><td>0.00</td></tr>' +
        '<tr><td>B002</td><td>年费</td><td>220.00</td></tr>' +
        '</tbody></table>' +
        '<p>缴费截止 2026-10-24，签章见下图。</p>' +
        '<p><img src="cid:sample-seal@shangshu.local" alt="签章"></p>',
      /* 受管内联签章自带字节（64×64 红章）。样例信没有服务端文件可取，
         所以字节直接跟资源走；真实来信走 file → /api/platform/files/content。
         不带字节时用户看到的就是死占位 —— 他说的「图片这块渲染不出来」。 */
      inline: [{
        content_id: 'sample-seal@shangshu.local', mime_type: 'image/png', name: '签章.png',
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWElEQVR42u3aMREAMAgEQeTgXwHOEhHQMOzPGdj+4y1fAAAMAipzRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPYDnLsBBwAfN3jopUhd1FgAAAABJRU5ErkJggg==',
      }],
      date: '2026-09-17 12:00', unread: true, attachments: []},
    {box: 'sent', from: ME, to: [{name: '张总', addr: 'zhang@acme.example.com'}], subject: '审查意见已提交通知（CN3024518）', body: '张总：\n\n审查意见答复已于今日提交，回执见附件。下一期缴费请留意期限。', date: '2026-09-17 17:48', delivery: 'accepted', attachments: [{lib: 'L3', name: '已提交回执.pdf', size: 307200, tag: ''}]},
    {box: 'sent', from: ME, to: [{name: '李经理', addr: 'li@acme.example.com'}], subject: '材料确认与补充说明', body: '收到，请优先补委托书，身份证复印件可后补。', date: '2026-09-17 14:20', delivery: 'partially_accepted', attachments: []},
    {box: 'failed', from: ME, to: [{name: '王工', addr: 'wang@partner.example.com'}], subject: 'Re: 9月委托批次明细（退信）', body: '王工：\n\n9月明细已核对，第 7 件委托人与总表不一致，详见附件标注。', date: '2026-09-18 10:22', delivery: 'bounced', attachments: [{lib: 'L2', name: '9月明细核对标注.xlsx', size: 46080, tag: 'v3'}]},
    {box: 'failed', from: ME, to: [{name: '张总', addr: 'zhang@acme.example.com'}], subject: '缴费提醒（结果待确认）', body: '张总：\n\n下月年缴截止 10 月 15 日，请留意。', date: '2026-09-16 09:05', delivery: 'send_unknown', attachments: []},
    {box: 'draft', from: ME, to: [{name: '张总', addr: 'zhang@acme.example.com'}], subject: '', body: '张总：\n\n第2次审查意见的答复思路如下……', date: '2026-09-21 10:30', attachments: [{lib: 'L1', name: '审查意见答复正文.docx', size: 77824, tag: 'v3'}], required: 2, candidates: {subject: '关于CN3024518案件审查意见的答复（第2次）'}},
    {box: 'draft', from: ME, to: [], subject: '9月账单核对', body: '李经理：\n\n附件是9月账单，请核对。', date: '2026-09-18 16:02', attachments: []},
  ];
  let mails = (showExamples ? samples : []).map((m, i) => ({id: String(i), deletedFrom: 'inbox', ...m, attachments: m.attachments.map(a => ({...a}))}));
  let box = 'all', selected = null, descending = true, canLeave = () => true;
  const mailSelection = new Set(), batchSnapshots = new Map();
  let batchRunning = false, batchConfirmation = '';
  let connected=false, attachmentReady=false, loading=!showExamples, writing=false, page=1, total=0, querySequence=0, detailSequence=0, readError='';
  let account={bound:false},accountError='',mailboxError='',mailboxRetrying=false,accountLoading=true,syncing=false;
  /* N5-1：邮箱有自己的稳定编号；谁能进、能干什么由授权表说了算。
     currentBox 是当前在看的箱，rights 是我在这个箱上有什么权。
     **无权动作前端不提供入口** —— 后端仍逐项拒绝，不靠前端藏起来。 */
  let mailboxes=[], currentBox=null, unreadCounts={mine:0,dept:0},composeSendState=null,composeCanManageDraft=null;
  /* BASE967-35 / UI050：写信窗里正文编辑器的**活句柄**与所在草稿 ——
     同一草稿被重新 openCompose（审核导航）时把撤回栈带过去；关闭才清。 */
  let activeBodyEditor=null, activeComposeKey='';
  /* 拿不到权限信息时**按有权限处理**（= 旧口径，不误锁按钮）：
     后端仍逐项拒绝，这里只是「知道了就收入口」，不是安全边界。
     只有明确拿到 rights 时才按它收 —— 免得服务没起来时整个页面锁死。 */
  const FULL={read:true,edit_draft:true,send:true,manage:true,signature:true};
  const rights=()=>(currentBox&&currentBox.rights)||FULL;
  const canRead=()=>rights().read!==false;
  const canEditDraft=()=>rights().edit_draft!==false;
  const canSendFrom=()=>rights().send!==false;
  const canSign=()=>rights().signature!==false;
  const canManage=()=>rights().manage!==false;
  /* T05「编辑页选哪个获权身份就用哪个」：发件身份下拉列出**我能代发的所有邮箱**
     （自己的个人箱 + 有代发权的部门箱）。没代发权的箱不出现 —— 能读不等于能发。
     返回 [{id, email}]；id 是邮箱编号（草稿住哪个箱），email 是发件地址。 */
  const sendableIdentities=()=>{
    const list=(mailboxes||[]).filter(m=>m&&m.id&&m.enabled!==false&&(m.rights||{}).send!==false)
      /* ★ BASE967-24（req 3）：带上 `display_name` —— 发送核对要显示**邮箱的显示名**，
         跟 worker 实际发的 From 一致（`delivery.py:52` 是 `{display_name} <{email_address}>`）。 */
      .map(m=>({id:m.id,email:m.email||m.id,kind:m.kind||'personal',
                display_name:m.display_name||''}));
    return list;
  };
  const canSend=()=>Boolean(account.bound&&account.enabled&&account.connection_status==='connected');
  const canSync=()=>currentBox?Boolean(currentBox.rights?.read===true&&currentBox.enabled&&currentBox.connection_status==='connected'):canSend();
  /**
   * 当前打开的那封信 → 上下文里的「内容段」（2026-10-21）。
   *
   * 只带**用户屏幕上正在看的那部分**：正文 ＋ 收件人/抄送 ＋ 附件摘要。
   * 有上限（超了截断并标 truncated）；服务端还会**按当前身份再核一遍读权**，
   * 核不过就整段丢弃 —— 所以这里**只报屏幕上有的**，不报别的。
   */
  const MAIL_CONTEXT_MAX_CHARS=1500;
  function mailPlainText(raw){
    return String(raw||'')
      .replace(/<br\s*\/?>/gi,'\n')
      .replace(/<\/p>/gi,'\n')
      .replace(/<[^>]*>/g,' ')
      .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"')
      .replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  }
  function mailContextContent(mail){
    if(!mail||!mail.id)return undefined;
    const bodyText=mailPlainText(mail.body);
    const to=(mail.to||[]).map(p=>p.addr||p.name||'').filter(Boolean);
    const cc=(mail.cc||[]).map(p=>p.addr||p.name||'').filter(Boolean);
    const attachments=(mail.attachments||[]).map(a=>a.name||a.label||'').filter(Boolean);
    /* 可核对条目 = 服务端**按当前身份重读这封信**时必须读得到的东西：
       主题、正文、收件人、抄送。附件名**不**当核对项 ——
       附件在平台侧是子表（编号/标签），字段名与前端标签对不上，对不上就会把整段内容误判成「读不到」。 */
    const items=[mail.subject,bodyText,...to,...cc].map(v=>String(v||'').trim()).filter(Boolean).slice(0,100);
    const lines=['收件人：'+(to.join('、')||'（无）')];
    if(cc.length)lines.push('抄送：'+cc.join('、'));
    if(attachments.length)lines.push('附件：'+attachments.join('、'));
    lines.push('正文：');lines.push(bodyText);
    let text=lines.join('\n');let truncated=false;
    if(text.length>MAIL_CONTEXT_MAX_CHARS){text=text.slice(0,MAIL_CONTEXT_MAX_CHARS);truncated=true;}
    return {kind:'text',text,truncated,items,refs:[{via:'record',entity_type:'mail.message',entity_id:String(mail.id)}]};
  }
  function businessContext(mail=null,view='mail-list'){
    /* 内容段只给**正在读的那封信**（mail-detail）：
       写信窗里的正文**可能还没保存** —— 报上去的话，
       服务端按当前身份重读记录时对不上（记录里是旧的），整段会被丢弃。
       与其报一份注定被丢的内容，不如不报：写信的事走草稿工具与确认链。 */
    if(typeof chatSetBusinessContext==='function')chatSetBusinessContext({module:'mail',view,entity_type:mail?.id?'mail.message':'page',entity_id:mail?.id||'mail',label:mail?.subject||'邮箱',metadata_kind:'object',metadata_key:'mail.message',editable_scope:mail?.id?'先读取最新邮件；草稿写入和真实发送分别由用户确认。不得读取授权码。':view==='mail-compose'?'当前新草稿尚未保存；先确认保存草稿，不能直接发送。':'查询本人邮件；写操作需要确认，不读取或配置邮箱凭据。',content:mail?.id&&view==='mail-detail'?mailContextContent(mail):undefined});
  }
  function accountChrome(){
    if(showExamples||ui.disposed)return;
    const implicit=$('#mailbox-switch option[value=""]');if(implicit)implicit.textContent=accountLoading?'本人邮箱（正在读取连接）':account.bound?'本人邮箱'+(account.email?' · '+account.email:'（已绑定）'):accountError?'本人邮箱（连接状态未确认）':'本人草稿（未绑定邮箱）';
    $('#mail-sync').disabled=!canSync()||syncing;
    $('#mail-sync').innerHTML=actionLabel(syncing?'正在同步…':'立即同步','sync');
    /* 页头标的是**当前在哪个箱**（N5-5「收件列表清楚标当前邮箱」），不是笼统的绑定状态。
       显示**邮箱地址**而不是发件姓名 —— 光写「我」「交付部」看不出是哪个箱。 */
    const boxName=currentBox?(currentBox.email||currentBox.display_name||currentBox.id):'';
    $('.preview-label').textContent=readError||accountError?'读取失败':accountLoading?'正在连接…':currentBox?(boxName+(currentBox.kind==='department'&&currentBox.department?` · ${currentBox.department}`:'')):account.bound?(account.enabled?account.email:'邮箱已暂停'):'未绑定邮箱';
    $('.preview-label').hidden=!readError&&!accountError&&!accountLoading&&!currentBox&&!account.bound;
    $('.preview-footer').textContent=mailboxError||accountError||(accountLoading?'正在读取邮箱连接…':!account.bound?'绑定已有邮箱后可收发，未绑定也可保存草稿。':!account.enabled?'收发已暂停，历史邮件和草稿保留。':'');
    if(mailboxError){const retry=document.createElement('button');retry.type='button';retry.className='mail-link';retry.dataset.mailboxRetry='';retry.textContent='重试读取邮箱';retry.disabled=mailboxRetrying;retry.onclick=async()=>{if(mailboxRetrying)return;mailboxRetrying=true;accountChrome();try{await loadMailboxes();if(!ui.disposed)await load();}finally{mailboxRetrying=false;accountChrome();}};$('.preview-footer').append(' ',retry);}
    /* **能读不等于能发**（N5-2）：写信/发送要代发权，签名要签名管理权。
       只读授权的箱上，这些入口直接不给用。 */
    /* UI-059（用户 2026-10-17 req 2）：「**无 send 但有 edit_draft 可以写草稿，不能代发**」。
       原来 `#compose`（写邮件）被 `canSendFrom()` 控 —— 没有代发权**连草稿都写不了**，
       把「能编辑」误当「能发」的反面。改成按 `canEditDraft()` 控：
       有 edit_draft 就能开写信窗；**能不能发由写信窗里的 `#c-send` 另判**
       （`:150` 走 `composeSendState()`，按选定发件身份的 send 权判）。
       `DEPT_READ_ONLY`（edit_draft=false, send=false）仍然禁用 —— S4 那条判据照样成立。 */
    if($('#compose')){$('#compose').disabled=!connected||!canEditDraft();$('#compose').innerHTML=actionLabel(connected?(canEditDraft()?'写邮件':'本邮箱无写草稿权'):'暂不可用','compose');}
    if($('#sig-btn')){$('#sig-btn').disabled=!canSign();$('#sig-btn').title=canSign()?'设置发信末尾自动带的默认签名':'本邮箱无签名管理权';}
    /* **管理权不等于代发权**（N5-2）：授权设置只有管理权的人能开。
       没管理权就把入口收起来，别点进去才发现什么都改不了。 */
    if($('#access-btn')){$('#access-btn').disabled=!canManage();$('#access-btn').title=canManage()?'设置这个邮箱上各人的阅读、草稿、代发、配置、签名权限':'本邮箱无管理权，不能配置授权';}
    /* 发件身份下拉**不在这里重建** —— 用户可能正在写信、已经选好用哪个身份，
       这里一刷新就把他的选择冲掉。它在打开写信窗时按 sendableIdentities() 建一次；
       这里只兜底：下拉是空的时候才填。 */
    if($('#c-from')&&!$('#c-from').options.length){
      const ids=showExamples?accounts.map(a=>({id:a.addr,email:a.addr})):sendableIdentities();
      $('#c-from').innerHTML=ids.length
        ? ids.map(x=>`<option value="${escape(x.email)}" data-mailbox="${escape(x.id)}">${escape(x.email)}</option>`).join('')
        : `<option>${escape(account.bound?account.email:'发件邮箱尚未配置')}</option>`;
    }
    /* 浏览范围仍由 currentBox 决定；回复可用本人身份发出，不能借用所浏览箱的权限。 */
    if($('#c-send')){const pending=inlineReviewController?.remaining()>0,state=composeSendState?.()||{allowed:false,reason:'请先选择获授权的发件身份'};$('#c-send').disabled=!state.allowed||writing||pending;$('#c-send').title=pending?'先确认或放弃剩余建议，再核对发送':state.allowed?'核对收件人、正文与附件后发送':state.reason;}
    if($('#trash-draft')){const allowed=composeCanManageDraft?.()===true;$('#trash-draft').disabled=writing||!allowed;$('#trash-draft').title=allowed?'将本封草稿移入其所属邮箱的回收站':'当前没有草稿所属邮箱的邮件管理权限，不能删除草稿';}
  }
  async function loadAccount(){
    try{const data=await request('/api/platform/services/mail.account.status/invoke',{payload:{}});if(ui.disposed)return;account=(data.result||data).account||{bound:false};accountError='';if(account.bound){ME.addr=account.email;ME.name=account.display_name||account.email;}}
    catch(error){if(ui.disposed)return;account={bound:false};accountError='无法读取邮箱连接状态；可以保存草稿，请到邮箱设置检查连接。';}
    accountLoading=false;accountChrome();
  }
  /* N5-1：我能进入的邮箱 = 自己的个人箱 + 获授权的部门箱。
     后端 mail.mailboxes 会给每箱的五项权限，前端据此决定**显不显示**入口；
     后端仍逐项拒绝，不靠这里藏。 */
  async function loadMailboxes(){
    if(showExamples)return;
    try{
      const data=await request('/api/platform/services/mail.mailboxes/invoke',{payload:{}});
      if(ui.disposed)return;
      const rows=(data.result||data).mailboxes;
      if(!Array.isArray(rows))throw Error('邮箱目录回包不完整');
      mailboxes=rows;mailboxError='';
    }catch(error){ if(ui.disposed)return; mailboxes=[];mailboxError='邮箱列表读取失败：'+error.message+'；当前仅显示本人邮箱，共享邮箱暂不可选择，请刷新重试。'; }
    const sel=$('#mailbox-switch');
    if(!sel)return;
    const personal=mailboxes.find(m=>m.kind==='personal'&&m.rights?.read!==false);
    const implicitPersonal=personal?'':'<option value="">本人草稿（未绑定邮箱）</option>';
    sel.innerHTML=implicitPersonal+mailboxes.map(m=>`<option value="${escape(m.id)}" data-kind="${escape(m.kind||'personal')}">${escape(m.display_name||m.email||m.id)}${m.kind==='department'&&m.department?` · ${escape(m.department)}`:''}</option>`).join('');
    sel.disabled=sel.options.length<2;
    // 不绑定邮箱仍有本人草稿；仅管理权的共享箱不能冒充默认阅读/编辑范围。
    currentBox=personal||null;sel.value=currentBox?.id||'';
    accountChrome();
  }
  const requestKeys=new Map();
  async function request(url,body){
    let response,data;
    try{
      response=await fetch(url,{cache:'no-store',signal:ui.signal,headers:{'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
      // 后端没接上时，接口可能吐回网页（HTML），拿去当 JSON 解析会漏出技术栈错误给用户。
      // 先判响应类型，给业务语言的提示，并标为「结果未知」——不能当成读到了数据。
      if(typeof response.text==='function'){
        const raw=await response.text();
        if(!/^\s*[\[{]/.test(raw)){
          throw Object.assign(Error('邮件服务未连接，暂时读不到邮件；可在顶部点「查看交互样例」先试编辑'),
            {uncertain:true});
        }
        data=JSON.parse(raw);
      }else{
        data=await response.json();
      }
    }catch(error){throw Object.assign(error,{uncertain:error.uncertain??true});}
    if(!response.ok||data.ok===false||data.error)throw Object.assign(Error(data.error||'邮件操作失败'),{uncertain:response.status>=500||[408,429].includes(response.status)});
    return data;
  }
  const boxFor=status=>({Draft:'draft',Received:'inbox',Queued:'queued',Sending:'queued',Sent:'sent',Partial:'sent',Failed:'failed',Unknown:'failed',Trash:'trash'}[status]||'failed');
  const mapReal=r=>({id:r.name,mailboxId:r.mailbox_id||r.mailbox||'',box:boxFor(r.status),status:r.status,deletedFrom:boxFor(r.previous_status||'Draft'),from:parseRecipients(r.from_address||'').list[0]||{name:r.from_name||account.display_name||'',addr:r.status==='Draft'?account.email||'':''},
    delivery:({Sent:'accepted',Partial:'partially_accepted',Failed:'send_failed',Unknown:'send_unknown',Sending:'sending',Queued:'queued'})[r.status]||'',replyToMail:r.reply_to_mail||'',replyToAddress:r.reply_to_address||'',deliveryError:r.delivery_error||'',rejected:r.rejected||[],
    to:parseRecipients((r.to||[]).join('；')).list,cc:parseRecipients((r.cc||[]).join('；')).list,subject:r.subject||'',body:r.body||'',bodyFormat:r.body_format||'Text',signatureGuard:r.signature_guard||'',
    date:String(r.received_at||r.modified||'').replace('T',' ').slice(0,16),attachments:(r.attachments||[]).map(a=>({...a,tag:a.label||'',reference:{doctype:'Shangshu Mail Message',name:r.name,file:a.file,label:a.label}})),attachmentCount:r.attachment_count||0,version:r.record_version,
    /* 正文里 cid: 引用的受管内联图。丢了它，编辑面就把图当成死占位 ——
       用户实测「图片这块渲染不出来」的根因之一。 */
    inline:r.inline_resources||r.inline||[],
    /* 这封收到的信还没看过 —— 列表小圆点、加粗和「未读」筛选都认它。
       后端字段是「读信时间」：空 = 没读过。 */
    unread: r.unread ?? (r.status === 'Received' && !r.read_at), readAt: r.read_at || '',
    /* 双未读点（N5-4）：**两个点各有各的**，已读后消失、不是换个颜色。
       · myUnread   —— **我**读过没有（别人读了不影响我）
       · deptUnread —— 有没有任一获权部门成员读过（个人箱没这个点） */
    myUnread: r.my_unread ?? (r.status === 'Received' && !r.read_at),
    deptUnread: r.dept_unread ?? false});
  /* ★ BASE967-24（req 4）：「**纯文本阅读入口按原计划补**」。
     HTML 信此前**没有**切纯文本的入口 —— 宽表再也没法用纯文本看，复制也带格式。
     这里把 HTML 转成可读纯文本：表格按「行一行、格之间制表符」展开（不是把格子挤成一串），
     <br> 转换行、块级元素后补换行，连续空行压成一行。**只读，不改库、不回写草稿。** */
  function plainFromHtml(html){
    const template=document.createElement('template');template.innerHTML=String(html||'');
    template.content.querySelectorAll('tr').forEach(tr=>{
      const cells=[...tr.querySelectorAll('td,th')].map(cell=>String(cell.textContent||'').replace(/\s+/g,' ').trim());
      tr.replaceWith(document.createTextNode(cells.join('\t')+'\n'));
    });
    template.content.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    template.content.querySelectorAll('p,div,li,blockquote,h1,h2,h3,h4,h5,h6').forEach(el=>{
      el.append(document.createTextNode('\n'));
    });
    return String(template.content.textContent||'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  /* ★ FIX-29（用户 2026-10-20：「为什么会有《br》」）：正文**按它声明的格式**出站、也按它声明的格式显示。
     编辑器内部**一律是 HTML** —— 纯文本的换行被落成 `<br>`（`mail-editor.js` 的 mountEditor：
     「纯文本转义后换行变 <br>」）；可写信窗报给外头的格式仍按原信记着 `Text`。
     两边一对不上，字面的 `<br>` 就漏出去了：
       · 预览按 Text 走「原样转义显示」⇒ 界面上印出 `张总：<br><br>第2次…`（用户看到的那处）
       · 出站保存带出去的 body 是这段标记、格式标签却是 Text ⇒ 真发出去收信人看到字面 `<br>`
       · 存进库的草稿正文就带着标记（实测：站点那封「测试邮件1」格式 Text、正文 `您好：<br><br>…`）
     声明纯文本 ⇒ 交出去、显示出来的都必须是**纯文本**（换行是换行，不是标记）。
     声明 HTML 的照旧原样 —— 表格、合并格、CID 图一个字节都不许动。
     存量那种「Text 标签 + 带标记正文」的草稿，打开时也按纯文本显示（读侧同一份转换）。 */
  const bodyAsFormat=(body,format)=>{
    const raw=String(body??'');
    if(format==='HTML')return raw;
    return plainFromHtml(raw);
  };
  function bodyView(mail){
    if(mail.bodyFormat!=='HTML')return `<pre class="mail-body-text">${escape(bodyAsFormat(mail.body, mail.bodyFormat)||'（空正文）')}</pre>`;
    /* ★ FIX-57：正文**真的是空的**时**明说**，不留一片空白让人猜
       （列表行里本来就没有正文，正文全靠详情接口给 ⇒ 详情没给正文就是空的）。
       空正文**没有富文本形态**，所以这里给一句纯文本说明 —— 不是「选择文本形式」那个动作。 */
    if(!String(mail.body??'').trim())return `<pre class="mail-body-text">（这封信没有正文）</pre>`;
    /* ★ 读信正文 = **所见即所得的那一个面**（父线 2026-10-21：「我只要所见即所得，不要两个面」）。
       原来这里挂的是**第二个面**：`<iframe sandbox="" srcdoc>` —— 父文档之外的独立文档。
       那个面在有的浏览器/内嵌浏览器里**渲染不出来** ⇒ 详情区只剩一个空边框框，
       里面一个字都没有（用户 2026-10-21 报「读信详情页正文整块空白」；
        而**点「转发」看得到** —— 转发走的是编辑器面，所见即所得那一条路是好的）。
       ⇒ 现在**只留一个面**：跟写信窗同一套编辑器（只读），同一道净化门（safeFragment）。
       脚本/事件/外链照样被剥掉（safeFragment 的黑名单一根没松），
       表格/合并格/受管 CID 图都还在。 */
    if(!globalThis.mailEditor)return `<pre class="mail-body-text">${escape(plainFromHtml(mail.body))}</pre>`;
    return `<div class="mail-body-wysiwyg" data-mail-body-wysiwyg="1"></div>`;
  }
  /* 把正文挂成所见即所得的**只读**编辑面 —— 一个面，不另开渲染窗。
     受管内联图照旧按授权资源解析成 data URI（图要真的看得见，不是死引用）。
     归属是「哪封信的哪个文件」，字节取不到就不显示，不放宽成无鉴权读取。 */
  function mountBodySurface(root, mail){
    const editor = globalThis.mailEditor;
    if(!editor||!root)return;
    for(const host of root.querySelectorAll('[data-mail-body-wysiwyg]')){
      if(host.dataset.mounted==='1')continue;
      host.dataset.mounted='1';
      editor.mountEditor(host,{
        value: mail?.body || '',
        locked: true,
        toolbar: false,
        resources: Array.isArray(mail?.inline) ? mail.inline : [],
        resourceOwner: {ref:'Shangshu Mail Message', ref_name: mail?.id || ''},
      });
    }
  }
  const isHtmlBody=pay=>pay.body_format==='HTML'||(pay.body_format!=='Text'&&/<\/?(?:p|div|table|tr|td|th|span|blockquote|br|img)\b/i.test(String(pay.body||'')));
  function reviewFieldMatches(field,actual,expected,payload){
    const saved=String(actual??''),wanted=String(expected??'');
    if(saved===wanted)return true;
    if(field!=='body'||!isHtmlBody(payload))return false;
    // 惰性、无网络的 template 只用于读回核对，不插入工作面或执行脚本。
    // CSSOM 统一分号、空白和重复声明；仍比较完整结构、文字与实际样式。
    const canonical=value=>{
      const template=document.createElement('template');template.innerHTML=value;
      template.content.querySelectorAll('[style]').forEach(element=>{
        if(element.style)element.setAttribute('style',element.style.cssText);
      });
      return template.innerHTML;
    };
    return canonical(saved)===canonical(wanted);
  }
  /* ★ FIX-55（用户 2026-10-20 19:5x）：「邮件部分转发时，图片转发不了，显示引用的图找不到，
     这个我记得提过，我们需要直接把图片也存到文件中心，用文件中心的路径索引」。

     病根（活站查实，不是猜）：**来信的内联图从来没进过文件中心** ——
     收信只给**附件**排了入库作业（`delivery.py:659` `import_mail_attachments(files=attachments)`），
     内联图的 File 不在其中；于是「链接重接」（`delivery.py:506` `repoint_body_links`）
     拿不到内联图的入库回包 ⇒ 正文里的 `cid:` 永远换不成文件中心的受管地址。
     而 `cid:` 只在**原来那封信**的 MIME 里有意义 —— 转发出去是**另一封**信，
     那些 Content-ID 不再成立 ⇒ 那条引用**原理上就是死的**。

     改法：生成回复/转发草稿时，草稿正文里的每一张内联图都改用**文件中心的路径索引**
     （`/api/platform/file-content?ref=Shangshu File Center File&ref_name=…&file=…`）：
       · 已经在文件中心的（签名插的图）直接用它自己的 `source`；
       · 没在文件中心的（来信内联图）先走**产品现成的 `files.import_attachment` 通道**入库，再取路径索引。
     存回正文时编辑器把 `src` 还原成 `cid:`（`data-managed-cid`）——
     存信与出站两道净化门**只认 `cid:`**（`service.py:323` `_img_attrs` / `transport.py:408` `sanitize_html`），
     正文里的图引用必须保持 `cid:` 形态，收件人那边才看得到图。 */
  const FILE_CENTER_DOCTYPE = 'Shangshu File Center File';
  /* 文件中心的路径索引 —— 与 `file-center.js` / `file-detail.js` 同款受管下载口。
     用**固定版本**的附件（version 的 frappe_file），不是当前版本 ——
     同一目录下同名文件会各占一版，指当前版本会让先来的那张图取到后一张的字节。 */
  const fileCenterPathIndex = source => {
    if (!source || !source.ref_doctype || !source.ref_name || !source.file) return '';
    return '/api/platform/file-content?' + new URLSearchParams({
      ref: source.ref_doctype, ref_name: source.ref_name, file: source.file});
  };
  /* 正文里的 `cid:` 引用 → 文件中心的路径索引。
     留 `data-managed-cid`：编辑器存回正文时靠它还原成 `cid:`（出站净化门只认 cid:）。 */
  function applyInlinePathIndex(html, index) {
    let out = String(html || '');
    for (const [cid, source] of Object.entries(index || {})) {
      const path = fileCenterPathIndex(source);
      if (!path) continue;
      const attr = escape(path);
      for (const q of ['"', "'"]) {
        out = out.split(`src=${q}cid:${cid}${q}`)
                 .join(`src=${q}${attr}${q} data-managed-cid=${q}cid:${cid}${q}`);
      }
    }
    return out;
  }
  /* 把一张内联图送进文件中心 —— 走产品现成的「附件自动入库」**同一个动作**
     （`files.import_attachment`）。`attribution` 省略：文件域对这条动作自动填给
     调用者本人（`shangshu_files/service.py` `AUTO_ATTRIBUTION_ACTIONS`）——
     归属是「谁点的归谁」的业务决定，前端不替人决定。 */
  /* 签名里的内联图 —— 签名是用户自己插的图，它**本来就在文件中心**（`source` 带着那条归属）。 */
  const signaturePathIndex = sig => {
    const index = {};
    for (const resource of (sig?.resources || [])) {
      const cid = String(resource?.content_id || '').replace(/^<|>$/g, '');
      if (cid && resource.source) index[cid] = resource.source;
    }
    return index;
  };
  async function action(id,payload,validate=()=>true){
    const key=JSON.stringify([id,payload]);
    if(!requestKeys.has(key))requestKeys.set(key,uid());
    const data=await request('/api/platform/actions/'+id+'/execute',{payload,confirmed:true,idempotency_key:requestKeys.get(key)});
    const result=data.result||data;
    if(!validate(result))throw Object.assign(Error('保存回执不完整，请核实原请求'),{uncertain:true});
    requestKeys.delete(key);return result;
  }
  /* 每次写完，服务端都会把修订号 +1 随回执发回来。**必须接住它** ——
     下一次写还要拿它当「我手上是哪一版」去核对。
     不接的后果（2026-10-13 用户实测「有圆点，但是点击不能变没掉」第二层）：
     打开未读的信自动标已读，库里版本 1→2，前端还留着 1；
     点「标为未读」拿 1 去写，服务端判「有人改过」拒掉，圆点自然消不掉。 */
  function adoptVersion(mail,receipt){
    if(mail&&receipt&&Number.isInteger(receipt.record_version))mail.version=receipt.record_version;
    return receipt;
  }
  function adoptReadState(mail,receipt,read){
    adoptVersion(mail,receipt);
    mail.myUnread=typeof receipt.my_unread==='boolean'?receipt.my_unread:!read;
    mail.deptUnread=typeof receipt.dept_unread==='boolean'?receipt.dept_unread:(read?false:mail.deptUnread);
    mail.unread=typeof receipt.unread==='boolean'?receipt.unread:mail.myUnread;
    mail.readAt=read?(receipt.read_at||new Date().toISOString().slice(0,19).replace('T',' ')):'';
  }
  /* SIG 默认签名 —— 插在**新正文之后、旧引用之前**（引用块带 data-mail-quote）。

     只在**新开**（新建/回复/转发，还没有草稿 id）时插；**重开已有草稿不插**。
     这不是偷懒 —— 是让两条硬要求**天然成立**，而不是靠事后去重打补丁：
       · 连续保存重开不重复 —— 存进去的就是带签名的那份，重开原样加载，不二次插
       · 旧草稿不随默认设置漂移 —— 旧稿正文里存的是当时的签名快照，改默认不影响它
     本封里可以改、可以删，都不反写默认配置（默认配置只在邮箱设置里改）。 */
  const signatureFor=mailbox=>mailbox?.signature || ((!mailbox||mailbox.kind==='personal')?account?.signature:null);
  function withDefaultSignature(html, editing,mailbox,meta){
    if (editing) return html;
    const sig = signatureFor(mailbox);
    if (!sig || !sig.enabled || !sig.html) return html;
    /* SIG 守卫标记 —— **(a) 挪出正文 HTML**（用户 2026-10-15 原话「签名守卫 a」）。

       旧做法：`<div data-mail-signature="1">` 包住签名，靠「正文里有它」跳过二次插入。
       坏在：存信那道 bleach 净化会把 `data-*` **剥掉**（test-mail-save-sanitize 里核过），
       于是这第二道闸**存不住**，存一次就没了。

       三条出路，用户选 (a)：
         (a) 标记挪出正文（放草稿元数据）—— **净化器一行不动**，守卫在正文外
         (b) 找一个净化器放行的写法继续放正文 —— 要么改净化器、要么赌没用过的属性，脆
         (c) 放开 bleach 属性白名单 —— 代价是**全局的**（所有信正文都多放一类属性），不做

       守卫落在**草稿元数据**上（wire 会带进保存载荷）。
       「重开草稿不重复插入」仍由第一道闸 `editing` 保证；
       这一道闸防的是**同会话内**对已插过签名的正文再插一次会叠成两份。 */
    if (meta && meta.signatureGuard) return html;
    const block = '<div>' + sig.html + '</div>';
    const at = String(html || '').indexOf('<div data-mail-quote');
    const out = at >= 0 ? html.slice(0, at) + block + html.slice(at) : (html || '') + block;
    if (meta) meta.signatureGuard = 'inserted';
    return out;
  }
  /* SIG 签名设置 —— 用户 2026-10-13：「我建议做一个弹窗,在里面设置」，
     随后又补一句：「弹窗里就实时编辑实时预览就行了,要有工具框,
     不要有一个新框叫实时预览」。
     所以这里是**一个带工具栏的富文本编辑区**（复用写信正文那个编辑器，
     自带字体/字号/颜色/列表/链接/插表工具栏），所见即所得 ——
     编辑区里长什么样，发出去就是什么样，**不另开一个「预览」框**。
     走**公共弹窗组件 ui.dialog**（用户 2026-10-12 要求过「抽象成公共组件」）。 */
  function openSignatureDialog(){
    if(!canSign())return;
    const signatureBox=currentBox;
    const cur=signatureFor(signatureBox)||{enabled:false,html:'',resources:[]};
    const profiles=JSON.parse(JSON.stringify(Array.isArray(cur.signatures)&&cur.signatures.length?cur.signatures:
      [{id:'legacy-default',name:'默认签名',html:cur.html||'',resources:cur.resources||[]} ]));
    let defaultID=cur.default_signature_id||profiles[0].id,selectedID=defaultID,sigEditor=null,busy=false;
    if(!profiles.some(item=>item.id===selectedID))defaultID=selectedID=profiles[0].id;
    const selected=()=>profiles.find(item=>item.id===selectedID);
    const capture=()=>{
      const item=selected();if(!item||!sigEditor)return;
      item.name=dlg.querySelector('#sig-name').value;
      item.html=sigEditor.getHtml().trim();item.resources=sigEditor.getInlineResources?.()||[];
    };
    const message=(text,error=false)=>{
      const line=dlg.querySelector('#sig-message');line.textContent=text;line.classList.toggle('is-error',error);
    };
    const renderList=()=>{
      dlg.querySelector('#sig-list').innerHTML=profiles.map(item=>`<button type="button" class="sig-list-item" role="tab" data-signature-id="${escape(item.id)}" aria-selected="${item.id===selectedID}"><span class="sig-list-name">${escape(item.name||'未命名签名')}</span>${item.id===defaultID?'<span class="sig-default-badge">默认</span>':''}</button>`).join('');
      dlg.querySelectorAll('[data-signature-id]').forEach(button=>button.onclick=()=>{
        if(busy||button.dataset.signatureId===selectedID)return;
        capture();selectedID=button.dataset.signatureId;mountSelected();
      });
      dlg.querySelector('#sig-new').disabled=busy||profiles.length>=20;
      const isDefault=selectedID===defaultID,button=dlg.querySelector('#sig-default');
      button.textContent=isDefault?'默认签名':'设为默认';button.setAttribute('aria-pressed',String(isDefault));button.disabled=busy||isDefault;
      dlg.querySelector('#sig-delete').disabled=busy||profiles.length<=1;
    };
    const mountSelected=()=>{
      sigEditor?.destroy?.();sigEditor=null;
      const item=selected();dlg.querySelector('#sig-name').value=item.name;
      sigEditor=globalThis.mailEditor.mountEditor(dlg.querySelector('#sig-editor-host'),{
        value:item.html||'',resources:item.resources||[],onChange:()=>{},onNotice:text=>notify(text),
      });
      renderList();
    };
    const dlg=ui.dialog({
      title:'签名管理',
      body:`<div class="sig-setup">
        <aside class="sig-sidebar" aria-label="已有签名">
          <div class="sig-sidebar-heading"><span>本邮箱签名</span><button type="button" class="btn btn-ghost" id="sig-new" title="新建签名"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新建</span></button></div>
          <div id="sig-list" role="tablist" aria-label="签名列表" aria-orientation="vertical"></div>
          <p class="sig-sidebar-note">最多20个签名。新增后，可自行设为默认。</p>
        </aside>
        <section class="sig-edit-pane" aria-label="编辑签名">
          <div class="sig-edit-heading"><label for="sig-name">签名名称<input id="sig-name" type="text" maxlength="80" autocomplete="off" placeholder="例如：工作签名"></label><button type="button" class="btn btn-ghost" id="sig-delete" aria-label="删除当前签名">删除</button></div>
          <div id="sig-editor-host"></div>
          <div class="sig-default-settings"><button type="button" class="btn btn-ghost" id="sig-default">设为默认</button><label class="dlg-field sig-switch"><input type="checkbox" id="sig-enabled" aria-label="自动插入签名"><span>自动插入默认签名（新建 / 回复 / 转发）</span></label></div>
          <p id="sig-message" class="sig-message" role="status">保存后用于以后新写的邮件；已有草稿保持原样。</p>
        </section></div>`,
      actions:[
        {label:'取消',onClick:()=>{if(!busy)ui.closeModal();}},
        {label:'清空',onClick:()=>{if(!busy)sigEditor?.applyEdit('',{actor:'user'});}},
        {label:'保存',variant:'pri',onClick:async()=>{
          if(busy||!sigEditor)return;
          capture();
          const names=profiles.map(item=>item.name.trim());
          if(names.some(name=>!name)||new Set(names.map(name=>name.toLocaleLowerCase())).size!==names.length){message('请填写不同的签名名称。',true);return;}
          const defaultItem=profiles.find(item=>item.id===defaultID);
          const payload={enabled:Boolean(dlg.querySelector('#sig-enabled').checked),html:defaultItem.html,resources:defaultItem.resources,
            signatures:profiles.map(item=>({...item,name:item.name.trim()})),default_signature_id:defaultID,signature_revision:Number(cur.signature_revision||0),
            ...(signatureBox?.id?{mailbox:signatureBox.id}:{})};
          const frozenControls=[...dlg.querySelectorAll('button,input,select')].map(control=>[control,control.disabled]);
          const rich=dlg.querySelector('[contenteditable]');
          busy=true;frozenControls.forEach(([control])=>control.disabled=true);if(rich)rich.setAttribute('contenteditable','false');message('正在保存…');
          try{
            const result=await action('mail.account.signature',payload,res=>res&&res.signature&&Array.isArray(res.signature.signatures)&&Number.isInteger(res.signature.signature_revision));
            if(ui.disposed)return;
            const savedSignature=result.signature;
            if(signatureBox)signatureBox.signature=savedSignature;
            if(!signatureBox||signatureBox.kind==='personal'){if(!account)account={};account.signature=savedSignature;}
            busy=false;ui.closeModal();notify('签名设置已保存');
          }catch(error){message('签名没保存成功：'+(error?.message||error),true);}
          finally{busy=false;if(dlg.isConnected){frozenControls.forEach(([control,disabled])=>control.disabled=disabled);if(rich)rich.setAttribute('contenteditable','true');renderList();}}
        }},
      ],
      /* fast 那一侧在这段 actions 里多加了「保存」按钮，并把签名里的受管图改成
         `getInlineResourcesForSave?.() ?? getInlineResources()`（只发 4 个 schema 字段）。
         ours 的签名管理器（多签名 / 设为默认）里**同样有保存按钮**，签名里的受管图由
         capture() 收进 item.resources 一起存（payload.resources）—— 行为没丢。
         这里保留 ours 的按钮组；差别只在「保存时发全量资源（含 source）」还是「发 4 字段」，
         待主控复核（签名图重开要靠 source 取回字节，裁掉会显示不出来）。 */
      onClose:()=>sigEditor?.destroy?.(),
    });
    if(!dlg)return;
    dlg.classList.add('mail-signature-dialog');
    ui.guardModal(dlg,()=>!busy);
    if(!globalThis.mailEditor){message('签名编辑器未加载，请关闭后重试。',true);return;}
    dlg.querySelector('#sig-enabled').checked=Boolean(cur.enabled);
    dlg.querySelector('#sig-name').oninput=()=>{
      const item=selected();item.name=dlg.querySelector('#sig-name').value;
      const label=[...dlg.querySelectorAll('[data-signature-id]')].find(node=>node.dataset.signatureId===selectedID)?.querySelector('.sig-list-name');
      if(label)label.textContent=item.name||'未命名签名';
    };
    dlg.querySelector('#sig-new').onclick=()=>{
      if(busy||profiles.length>=20)return;capture();
      let name='新签名',suffix=2;while(profiles.some(item=>item.name.trim()===name))name='新签名 '+suffix++;
      const item={id:uid(),name,html:'',resources:[]};profiles.push(item);selectedID=item.id;mountSelected();
      dlg.querySelector('#sig-name').focus();dlg.querySelector('#sig-name').select();
      message('新签名尚未保存。默认签名未改变。');
    };
    dlg.querySelector('#sig-default').onclick=()=>{if(busy)return;capture();defaultID=selectedID;renderList();message('保存后将默认使用“'+selected().name+'”。已有草稿保持原样。');};
    dlg.querySelector('#sig-delete').onclick=()=>{
      if(busy||profiles.length<=1)return;capture();const index=profiles.findIndex(item=>item.id===selectedID),wasDefault=selectedID===defaultID;
      profiles.splice(index,1);selectedID=profiles[Math.min(index,profiles.length-1)].id;
      if(wasDefault)defaultID=selectedID;mountSelected();message(wasDefault?'已移除原默认签名；保存后默认使用“'+selected().name+'”。':'签名已从本次编辑中移除，保存后生效。');
    };
    mountSelected();
  }

  /* N5-5 / PKG-006-T05：「**设置页由有权者选邮箱和成员、逐项配置权限**」。
     五项**分开勾**（阅读 / 草稿 / 代发 / 配置 / 签名）—— 能读≠能发，
     不能由一项推出另一项（N5-2）。全部取消勾 = 收回这个人的权限。
     走公共弹窗组件 ui.dialog，和签名设置同一条路。 */
  const ACCESS_KEYS = [
    ['read', '阅读'], ['edit_draft', '草稿'], ['send', '代发'],
    ['manage', '配置'], ['signature', '签名'],
  ];
  function openAccessDialog(){
    if (!canManage()) return;   // 前端不提供入口；后端 mail.mailbox.grant/revoke 仍逐项拒
    const manageable = mailboxes.filter(m => m.rights && m.rights.manage);
    if (!manageable.length) { notify('没有你能管理授权的邮箱', 'error'); return; }
    /* 工作副本 —— 弹窗里改的是它，点保存才真发请求，取消就整个丢掉。 */
    let boxId = currentBox && currentBox.rights && currentBox.rights.manage
      ? currentBox.id : manageable[0].id;
    const draft = {};   // boxId -> [{user, read, ...}]
    const loadDraft = id => {
      const src = manageable.find(m => m.id === id);
      draft[id] = (src && src.grantees || []).map(g => ({...g}));
      return draft[id];
    };
    loadDraft(boxId);
    const dlg = ui.dialog({
      title: '邮箱权限',
      body: `
        <div class="access-setup">
          <label class="dlg-field">邮箱
            <select id="access-box" aria-label="要配置的邮箱">
              ${manageable.map(m => `<option value="${escape(m.id)}">${escape(m.display_name || m.email || m.id)}${m.kind === 'department' && m.department ? ' · ' + escape(m.department) : ''}</option>`).join('')}
            </select></label>
          <div class="access-table-scroll" tabindex="0" role="region" aria-label="邮箱成员权限，可横向滚动"><table class="access-table" aria-label="授权名单">
            <thead><tr><th>成员</th>${ACCESS_KEYS.map(([, label]) => `<th>${label}</th>`).join('')}<th></th></tr></thead>
            <tbody id="access-rows"></tbody>
          </table></div>
          <div class="access-add">
            <input type="text" id="access-new" placeholder="员工账号或邮箱" aria-label="要授权的员工">
            <button type="button" class="btn btn-ghost" id="access-add-btn">添加成员</button>
          </div>
          <p class="access-hint">各项权限独立设置：阅读不包含代发。取消全部权限或移除成员，将在保存后收回授权。</p>
        </div>`,
      actions: [
        {label: '取消', onClick: () => ui.closeModal()},
        {label: '保存', variant: 'pri', onClick: async () => {
          const rows = draft[boxId] || [];
          const changed = rows.filter(r => r.__dirty);
          if (!changed.length) { ui.closeModal(); notify('没有改动'); return; }
          try {
            for (const r of changed) {
              const any = ACCESS_KEYS.some(([k]) => r[k]);
              if (any) {
                await action('mail.mailbox.grant', {
                  mailbox: boxId, user: r.user,
                  rights: Object.fromEntries(ACCESS_KEYS.map(([k]) => [k, Boolean(r[k])])),
                }, res => res && typeof res === 'object');
              } else {
                /* 全取消勾 = **收回**，不是 grant 一个全 false ——
                   收回后连这个箱都列不到，语义比「五项都是关的」干净。 */
                await action('mail.mailbox.revoke', {mailbox: boxId, user: r.user},
                             res => res && typeof res === 'object');
              }
              r.__dirty = false;
            }
            /* 回写到 mailboxes，下次打开不用再拉一次。 */
            const src = manageable.find(m => m.id === boxId);
            if (src) src.grantees = (draft[boxId] || []).filter(r => ACCESS_KEYS.some(([k]) => r[k]));
            if (ui.disposed) return;
            ui.closeModal();
            notify('邮箱权限已保存');
          } catch (e) { notify('权限没保存成功：' + (e && e.message || e), 'error'); }
        }},
      ],
    });
    if (!dlg) return;
    dlg.classList.add('mail-access-dialog');
    const boxSel = dlg.querySelector('#access-box');
    if (boxSel) boxSel.value = boxId;
    const draw = () => {
      const host = dlg.querySelector('#access-rows');
      if (!host) return;
      const rows = draft[boxId] || [];
      host.innerHTML = rows.length ? rows.map((r, i) => `
        <tr data-row="${i}">
          <td>${escape(r.user)}</td>
          ${ACCESS_KEYS.map(([k]) => `<td><input type="checkbox" data-key="${k}" data-i="${i}"
              aria-label="${escape(r.user)} 的${ACCESS_KEYS.find(x => x[0] === k)[1]}权限"
              ${r[k] ? 'checked' : ''}></td>`).join('')}
          <td><button type="button" class="btn btn-ghost" data-drop="${i}">移除</button></td>
        </tr>`).join('')
        : `<tr><td colspan="${ACCESS_KEYS.length + 2}">这个邮箱还没有授权给其他人</td></tr>`;
      host.querySelectorAll('input[type=checkbox]').forEach(b => {
        b.onchange = () => {
          const r = rows[Number(b.dataset.i)];
          if (!r) return;
          r[b.dataset.key] = Boolean(b.checked);
          r.__dirty = true;
        };
      });
      host.querySelectorAll('[data-drop]').forEach(b => {
        b.onclick = () => {
          const r = rows[Number(b.dataset.drop)];
          if (!r) return;
          /* 移除 = 五项全关，保存时走 revoke。 */
          ACCESS_KEYS.forEach(([k]) => { r[k] = false; });
          r.__dirty = true;
          draw();
        };
      });
    };
    draw();
    if (boxSel) boxSel.onchange = () => {
      boxId = boxSel.value;
      if (!draft[boxId]) loadDraft(boxId);
      draw();
    };
    const addBtn = dlg.querySelector('#access-add-btn');
    const addInput = dlg.querySelector('#access-new');
    if (addBtn) addBtn.onclick = () => {
      const user = (addInput && addInput.value || '').trim();
      if (!user) { notify('请填要授权的员工账号', 'error'); return; }
      const rows = draft[boxId] || (draft[boxId] = []);
      if (rows.some(r => r.user === user)) { notify('这个人已经在名单里了', 'error'); return; }
      /* 新加的人默认只给「阅读」—— 权限要一项项开，不默认给代发。 */
      rows.push({user, read: true, edit_draft: false, send: false, manage: false, signature: false, __dirty: true});
      if (addInput) addInput.value = '';
      draw();
    };
  }
  /* MAIL-08 写稿审核：人看差异、**改**、采用或拒绝。
     计划 PKG-007 / 用户表第 8 行：「Assistant 起草、改写邮件及整理表格；
     人查看差异、**修改**、采用或拒绝，**写稿与发送分别确认**」。

     提案只记录不执行。分项确认后再拒绝，只放弃剩余建议，已保存的内容保留。
     邮件页复用正式提案解析链；人工修订按 edited_value 在同一提案上确认。
     成功回执之后独立读回草稿；失败或结果未知保留候选和人工输入。 */
  const MAIL_REVIEWABLE = ['mail.save_draft', 'mail.send'];
  let reviewDialog=null,reviewHasEdits=()=>false,reviewNavigation=null,inlineReviewController=null,reviewOpenSequence=0;
  ui.onDispose(()=>inlineReviewController?.destroy());
  async function navigateReviewTarget(target){
    if(showExamples||ui.disposed||!host.isConnected)return;
    if(focusReviewCandidate(target.proposal_id,target.field||''))return;
    const key=JSON.stringify([target.mail||'',target.proposal_id||'']);
    if(reviewNavigation?.key===key){await reviewNavigation.promise;if(!ui.disposed)focusReviewCandidate(target.proposal_id,target.field||'');return;}
    const navigation={key,promise:null};reviewNavigation=navigation;
    navigation.promise=(async()=>{
      if(!ui.canCloseModals())return;
      if(reviewDialog?.isConnected&&reviewHasEdits()){notify('候选里有人工修改，保留在当前审核位置','info');return;}
      if(batchRunning||writing||!canLeave()){notify('当前操作尚未完成，保留在原位置','info');return;}
      if(target.proposal_id)await openReviewDialog(target.proposal_id,target.field||'',target.mail||'');
      else if(target.mail&&selected!==target.mail){await open(target.mail);if(ui.disposed||selected!==target.mail)return;}
      else if(target.field){const control=$('#c-'+target.field);control?.scrollIntoView?.({block:'center'});control?.focus();}
    })().finally(()=>{if(reviewNavigation===navigation)reviewNavigation=null;});
    await navigation.promise;
  }
  function reviewSource(proposal) {
    if(typeof window.shangshuReviewSource==='function'){const source=window.shangshuReviewSource(proposal),kind=source.kind==='automation'?'code':source.kind;return {...source,kind,label:kind==='code'?(String(source.label||'代码自动化').split(/\s*·\s*/)[0]):kind==='assistant'?'Assistant':source.label};}
    const source=String(proposal.created_via||'').trim();
    if(['ai','ai-chat','assistant'].includes(source))return {kind:'assistant',label:'Assistant'};
    if(source==='llm-node')return {kind:'code',label:'LLM节点自动化'};
    if(['automation','code','execution'].includes(source))return {kind:'code',label:'代码自动化'};
    return {kind:'unknown',label:source?'来源未确认 · '+source:'来源未确认'};
  }
  /* fast：确认调用收成一个口子（PKG-014-T03；换口收口另记 PKG-014-T05）——

     旧确认口 `/api/confirmations` 是**过渡，不是终点** —— 它在「最后一批删」
     清单上（legacy-surface-inventory-20261014）。等核心提案公共口定下来就换，
     **别把它当正式口写死**。换的时候只改 CONFIRM_BASE / callResolve 两处，
     上面的采用/拒绝按钮不用动。 */
  const CONFIRM_BASE = '/api/confirmations/';

  /* 回执判定：**HTTP 和业务两道都要过**，缺一不可。
     · HTTP 不是 2xx（403 没权限 / 500 服务端挂）—— body 常常根本不是 JSON
     · HTTP 2xx 但业务回执 ok:false —— 服务端明说没成，原因在 error
     · 连 body 都解析不出 —— **结果未知**，既不算成功也不算失败
     改之前这三样一概不查，直接关窗报成功 —— 用户看见「已拒绝」，
     其实服务端没认。 */
  function receiptOf(res, data, parsed){
    const raw = data && data._raw ? String(data._raw) : '';
    if (res && !res.ok && res.status !== 200) return {state: 'http', status: res.status, reason: raw};
    if (!parsed) return {state: 'unknown', reason: raw};
    if (data && data.ok === false) return {state: 'business', reason: String(data.error || data.reason || '')};
    return {state: 'ok', data: data || {}};
  }

  /** 走确认口办一件事。回执收在 receipt 里，调用方自己判，不替调用方关窗。 */
  async function callResolve(id, decision, editedValue){
    const res = await fetch(CONFIRM_BASE + encodeURIComponent(id),
      {method: 'POST', headers: {'content-type': 'application/json'},
       body: JSON.stringify({decision,...(editedValue ? {edited_value:editedValue} : {})})});
    let data = null, parsed = true;
    try { data = await res.json(); }
    catch (e) {
      parsed = false;
      /* JSON 解析不出就退到纯文本 —— 403 的 body 是 'Forbidden' 这种 */
      try { data = {_raw: await res.text()}; } catch (e2) { data = null; }
    }
    const receipt=receiptOf(res, data, parsed);
    if(receipt.state==='ok' && (!data?.id || data.status!==decision)){
      return {res,data,receipt:{state:'business',reason:'提案状态未确认或已变化，请刷新核对，未重复执行'}};
    }
    return {res, data, receipt};
  }

  /* 失败文案：**三类必须互不相同** —— 用户得知道是「没权限」「服务挂了」
     还是「这候选过期了」，才知道该找谁 / 该重试 / 该重新提。
     样样都是「操作失败」等于没告诉他怎么办。 */
  function failureText(what, receipt){
    const verb = what === 'reject' ? '拒绝'
               : what === 'confirm' ? '采用'
               : what === 'supersede' ? '把助手那份标为被取代'
               : '保存';
    if (receipt.state === 'http') {
      const s = receipt.status;
      if (s === 401 || s === 403)
        return `${verb}没成功（HTTP ${s}：没权限）—— 候选留着没动，换有权限的账号再试，或找人代审`;
      return `${verb}没成功（HTTP ${s}${receipt.reason ? '：' + receipt.reason : '：服务端没响应好'})`
           + ` —— 候选留着没动，稍后可再试`;
    }
    if (receipt.state === 'business') {
      return `${verb}没成功：${receipt.reason || '服务端回执说没成'} —— 候选留着没动`;
    }
    return `结果未知 —— 没拿到${verb}的回执，不知道到底成没成。候选留着没动，`
         + `请刷新核实后再试`;
  }

  /* 决议留痕（谁 / 何时 / 哪条）后端本来就记（shangshu_core/actions.py 的
     decision_by / decision_at），这里只是把它**露到页面上**，让人看得见
     这次是谁办的。「理由」全链路还没有，计下一批（PKG-014-T06）。 */
  function receiptLine(msg, id, data){
    const who = (data && (data.decision_by || data.decisionBy)) || '';
    const when = (data && (data.decision_at || data.decisionAt)) || '';
    const bits = [msg];
    if (id) bits.push('候选 ' + id);
    if (who) bits.push('操作人 ' + who);
    if (when) bits.push(String(when));
    return bits.join(' · ');
  }
  function focusReviewCandidate(proposalId,focusField=''){
    if(inlineReviewController?.id===String(proposalId)){inlineReviewController.focus(focusField);return true;}
    if(!reviewDialog?.isConnected||!proposalId)return false;
    const card=[...reviewDialog.querySelectorAll('[data-proposal-id]')].find(el=>el.dataset.proposalId===String(proposalId));
    if(!card)return false;
    if(reviewDialog.dataset.busy==='true'){notify('正在核实审核回执，请稍候','info');return true;}
    reviewDialog.querySelectorAll('.is-focused').forEach(el=>el.classList.remove('is-focused'));card.classList.add('is-focused');card.scrollIntoView?.({block:'nearest'});
    if(focusField==='body')card.querySelector('[data-review-tab="edit"]:not(:disabled)')?.click();
    const field=['subject','body','to','cc','attachments'].includes(focusField)?card.querySelector(`[data-field="${focusField}"]`):null;(field||card).focus();return true;
  }
  async function loadProposals(){
    const data=await request('/api/platform/action-proposals?status=Proposed');
    /* fast 的提醒：内核可能回**裸数组**，别把裸数组当对象去取 .list（取不到就当空，
       人会以为「没有待审」）。两种回包都认。 */
    const list=Array.isArray(data)?data:data?.list;
    if(!Array.isArray(list))throw Object.assign(Error('候选列表回包不完整'),{uncertain:true});
    return list;
  }
  async function refreshReviewCue(){
    // 待审计数与恢复入口统一由原聊天确认卡维护，不重复查询或创建审核入口。
  }
  /* fast 的旧「待审候选」弹窗（**保留备查**）：ours 已把审核入口改成
     「邮件页逐项核对 + 聊天确认卡」，页面上的「待审」按钮（#review-btn）已撤掉，
     这里改名 openReviewDialogLegacy —— 免得跟后面 ours 的 openReviewDialog 抢名字
     （同名时后声明的赢，这份就成了永远走不到的代码）。
     弹窗里用的 callResolve / failureText / receiptLine 是 fast 的回执口径，保留。
     目前没有调用点，待主控决定是接线还是去留。 */
  function openReviewDialogLegacy(){
    if(typeof chatSetMode==='function'&&typeof chatLoadPendingConfirmations==='function'){
      chatSetMode('split');void chatLoadPendingConfirmations();return;
    }
    const dlg = ui.dialog({
      title: '待审候选',
      body: `<div class="access-setup" id="review-host">${reviewCandidatesSkeleton()}</div>`,
      actions: [{label: '关闭', onClick: () => ui.closeModal()}],
    });
    if (!dlg) return;
    const host = dlg.querySelector('#review-host');
    void (async () => {
      let list = [];
      try { list = (await loadProposals()).filter(p => MAIL_REVIEWABLE.includes(p.capability || p.action_id)); }
      catch (e) { if (host) host.innerHTML = `<p>读不到待审候选：${escape(e && e.message || e)}</p>`; return; }
      if (ui.disposed) return;
      if (!host) return;
      if (!list.length) { host.innerHTML = '<p>现在没有待审候选。</p>'; return; }
      /* 每条候选一张卡：来源 / 差异 / 可改字段 / 两个出口。 */
      host.innerHTML = list.map((p, i) => {
        const isDraft = (p.capability || p.action_id) === 'mail.save_draft';
        const pay = p.payload || {};
        return `
        <section class="review-card" data-i="${i}">
          <p class="review-head"><strong>来源：助手</strong> · ${isDraft ? '保存邮件草稿' : '发送邮件'}
             · <span class="access-hint">候选号 ${escape(p.id || '')}</span></p>
          <p class="access-hint">${isDraft
            ? '<strong>不发送</strong> —— 采用它只写草稿，发信是另一道确认。'
            : '<strong>这是发送请求</strong> —— 采用会真实发往外部邮箱。'}</p>
          <div class="review-diff" data-diff="${i}">正在核对差异…</div>
          ${isDraft ? `
          <label class="dlg-field">主题
            <input type="text" data-field="subject" data-i="${i}" value="${escape(pay.subject || '')}" aria-label="候选主题"></label>
          <label class="dlg-field">正文
            <textarea data-field="body" data-i="${i}" rows="5" aria-label="候选正文">${escape(pay.body || '')}</textarea></label>` : ''}
          <div class="review-actions">
            <button type="button" class="btn btn-ghost" data-reject="${i}">拒绝</button>
            <button type="button" class="btn btn-pri" data-accept="${i}">${isDraft ? '采用' : '采用并发送'}</button>
          </div>
        </section>`;
      }).join('');

      /* 差异走邮件自己的 presenter（mail.send / mail.save_draft 已注册），
         和对话流那张确认卡同一套口径 —— 不另造第二套差异算法。 */
      const registry = window.shangshuConfirmationPresenters || {};
      list.forEach(async (p, i) => {
        const box = host.querySelector(`[data-diff="${i}"]`);
        if (!box) return;
        const kind = p.capability || p.action_id;
        try {
          const view = registry[kind] && registry[kind].prepare
            ? await registry[kind].prepare({payload: p.payload || {}})
            : null;
          if (ui.disposed) return;
          box.innerHTML = view && Array.isArray(view.lines)
            ? `<ul>${view.lines.map(l => `<li>${escape(String(l))}</li>`).join('')}</ul>`
            : '<p class="access-hint">（没有差异行）</p>';
        } catch (e) {
          if (ui.disposed) return;
          /* 核不出来就直说（多半是版本过期），不假装「没问题」。 */
          box.innerHTML = `<p class="access-hint">差异核不出来：${escape(e && e.message || e)}</p>`;
        }
      });

      host.querySelectorAll('[data-reject]').forEach(btn => {
        btn.onclick = async () => {
          const p = list[Number(btn.dataset.reject)];
          try {
            const {data, receipt} = await callResolve(p.id, 'rejected');
            if (ui.disposed) return;
            if (receipt.state !== 'ok') {
              /* 失败：**不关窗、不报成功、候选留着** ——
                 人看得见没成，还能再点一次（重试的入口就是这颗按钮自己）。 */
              notify(failureText('reject', receipt), 'error');
              return;
            }
            ui.closeModal();
            notify(receiptLine('已拒绝，正文一个字没动', p.id, data));
          } catch (e) {
            notify(failureText('reject', {state: 'unknown', reason: String((e && e.message) || e)}), 'error');
          }
        };
      });

      host.querySelectorAll('[data-accept]').forEach(btn => {
        btn.onclick = async () => {
          const i = Number(btn.dataset.accept);
          const p = list[i];
          const pay = {...(p.payload || {})};
          const isDraft = (p.capability || p.action_id) === 'mail.save_draft';
          if (isDraft) {
            const s = host.querySelector(`[data-field="subject"][data-i="${i}"]`);
            const b = host.querySelector(`[data-field="body"][data-i="${i}"]`);
            if (s) pay.subject = s.value;
            if (b) pay.body = b.value;
          }
          /* 不改就确认原提案（来源仍是助手）；改过就**人按改后的那份直接存**，
             原助手候选标为被取代 —— 不能把人的改动冒领成「助手的稿被采用了」。 */
          const edited = isDraft && (
            (pay.subject !== (p.payload || {}).subject) || (pay.body !== (p.payload || {}).body));
          try {
            if (!edited) {
              const {data, receipt} = await callResolve(p.id, 'confirmed');
              if (ui.disposed) return;
              if (receipt.state !== 'ok') {
                notify(failureText('confirm', receipt), 'error');
                return;
              }
              ui.closeModal();
              notify(receiptLine('已采用助手的候选', p.id, data));
              return;
            }
            // 原提案上确认人工修订，保存与留痕同事务；不再先直存、再拒绝原稿两步分裂。
            const {data: supData, receipt: supReceipt} = await callResolve(p.id, 'confirmed',
              {type:'fields',value:{subject:pay.subject,body:pay.body}});
            if (ui.disposed) return;
            if (supReceipt.state !== 'ok') {
              notify(failureText('save', supReceipt), 'error');
              return;
            }
            ui.closeModal();
            notify(receiptLine('已保存人工修订；助手原稿与修改留痕保留，未发送', p.id, supData));
            void load();
          } catch (e) { notify('采用没成功：' + (e && e.message || e), 'error'); }
        };
      });
    })();
  }

  function reviewDescriptor(data,id){
    const value=data?.review||data;
    if(value?.unsupported===true)return null;
    const allowed=['subject','body','to','cc','attachments','mailbox'];
    const statuses=value?.status==='rejected'?['rejected','accepted']:['pending','accepted'];
    if(value?.id!==String(id)||value.capability!=='mail.save_draft'||typeof value.review_revision!=='string'||!value.review_revision||!['proposed','confirmed','rejected'].includes(value.status)||!Array.isArray(value.units)||value.target?.module!=='mail'||!value.units.every(unit=>allowed.includes(unit.unit_id)&&statuses.includes(unit.status)&&Object.hasOwn(unit,'current_value'))||new Set(value.units.map(unit=>unit.unit_id)).size!==value.units.length||!Number.isInteger(value.remaining)||value.remaining!==value.units.filter(unit=>unit.status==='pending').length||value.accepted_count!==value.units.filter(unit=>unit.status==='accepted').length||(value.status!=='proposed'&&value.remaining!==0)||(value.status==='proposed'&&value.remaining===0))throw Error('邮件审核信息不完整，请保留原候选后重试');
    return value;
  }
  function showReviewBlocked(id,message){
    closeDetail();
    $('#detail').innerHTML=`<div class="mail-reading-empty mail-review-blocked" role="alert"><strong>${escape(message)}</strong><p>候选 ${escape(id)} 仍保留，本次未执行确认。请核对该邮箱的草稿编辑权限后，再从待审入口重新打开。</p></div>`;
    host.classList.add('mail-has-selection');
  }
  async function openReviewDialog(proposalId='',focusField='',mailId=''){
    if(focusReviewCandidate(proposalId,focusField))return;
    if(writing||batchRunning||!canLeave()||!ui.canCloseModals())return;
    const sequence=++reviewOpenSequence;
    try{
      const proposals=await loadProposals(),list=proposals.filter(p=>MAIL_REVIEWABLE.includes(p.capability||p.action_id));
      const proposal=proposalId?list.find(p=>String(p.id)===String(proposalId)):list.find(p=>(p.capability||p.action_id)==='mail.save_draft')||list[0];
      if(!proposal){notify('该候选已处理、不存在或无权查看','info');return;}
      if((proposal.capability||proposal.action_id)!=='mail.save_draft'){await window.shangshuOpenReviewCard?.(proposal,{navigate:false});return;}
      const descriptor=reviewDescriptor(await request('/api/platform/action-proposals/'+encodeURIComponent(proposal.id)+'/review'),proposal.id);
      if(ui.disposed||sequence!==reviewOpenSequence||!canLeave())return;
      if(!descriptor){await window.shangshuOpenReviewCard?.(proposal,{navigate:false});return;}
      let formal=null;
      if(descriptor.target.mail){const response=await request('/api/platform/services/mail.detail/invoke',{payload:{mail:descriptor.target.mail}});const raw=(response.result||response).mail;if(raw?.name!==descriptor.target.mail||raw.status!=='Draft')throw Error('只能在正式草稿中核对写稿候选');formal=mapReal(raw);if(formal.mailboxId){currentBox=mailboxes.find(box=>box.id===formal.mailboxId)||null;$('#mailbox-switch').value=currentBox?.id||'';accountChrome();}}
      if(ui.disposed||sequence!==reviewOpenSequence||!canLeave())return;
      const targetBoxId=descriptor.units.find(unit=>unit.unit_id==='mailbox'&&unit.status==='pending')?.value||proposal.payload?.mailbox;
      const targetBox=targetBoxId?mailboxes.find(box=>box.id===targetBoxId):formal?currentBox:mailboxes.find(box=>box.kind==='personal'&&box.rights?.read!==false);
      if((targetBoxId&&!targetBox)||targetBox?.rights?.edit_draft===false||(!targetBoxId&&formal&&!canEditDraft())){showReviewBlocked(proposal.id,'当前邮箱没有可用的草稿编辑权限');return;}
      if(!formal){currentBox=targetBox||null;$('#mailbox-switch').value=currentBox?.id||'';accountChrome();}
      const seed=formal?{...formal,to:[...formal.to],cc:[...formal.cc],attachments:formal.attachments.map(a=>({...a})),inline:[...(formal.inline||[])]}:{box:'draft',from:{...ME},to:[],cc:[],subject:'',body:'',bodyFormat:'Text',attachments:[],inline:[]};
      for(const unit of descriptor.units.filter(unit=>unit.status==='pending')){
        if(unit.unit_id==='to'||unit.unit_id==='cc')seed[unit.unit_id]=parseRecipients((unit.value||[]).join('；')).list;
        else if(unit.unit_id==='attachments'){const labels=proposal.payload?.attachment_labels||[];seed.attachments=(unit.value||[]).map((id,index)=>{const known=formal?.attachments.find(a=>a.file===id),label=labels.find(a=>a.file===id);return known?{...known}:{file:id,name:label?.name||'附件 '+(index+1),tag:label?.label||'',size:0};});}
        else if(unit.unit_id==='mailbox'){const box=mailboxes.find(box=>box.id===unit.value);if(box)seed.from={name:box.display_name||'',addr:box.email||box.id};}
        else seed[unit.unit_id]=String(unit.value??'');
        if(unit.unit_id==='body'){seed.bodyFormat=unit.kind==='html'?'HTML':'Text';seed.inline=proposal.payload?.inline_resources||seed.inline;}
      }
      openCompose(seed,{review:descriptor,formal,proposals:list});inlineReviewController?.focus(focusField);
      await window.shangshuOpenReviewCard?.(proposal,{navigate:false});
    }catch(error){if(!ui.disposed)notify('候选未打开：'+error.message,'error');}
  }


  async function load(){
    if(showExamples)return;
    const sequence=++querySequence;loading=true;readError='';render();
    try{
      /* 「未读」筛选必须**发给后端** —— 列表是后端分页（一次 30 条），
         前端手上只有当前页，自己筛等于骗人。 */
      const filterValue = $('#filter').value;
      // 带上当前箱 —— 不指定的话后端默认查本人个人箱，切到部门箱会「没反应」。
      const filterParams = {scope: box, q: $('#search').value.trim(), order: descending ? 'desc' : 'asc'};
      if(currentBox&&currentBox.id)filterParams.mailbox=currentBox.id;
      if (filterValue === 'unread') filterParams.unread = '1';
      if (filterValue === 'attach') filterParams.attach = '1';
      const params=new URLSearchParams({page:String(page),page_length:'50',filters:JSON.stringify(filterParams)});
      const data=await request('/api/platform/datasets/mail.message/records?'+params);
      if(ui.disposed||sequence!==querySequence)return;
      total=Number(data.total||0);connected=true;
      // 两套未读数（N5-4）：**分开显示，不相加** —— 一封未读信在两套里各算一次。
      unreadCounts=data.unread_counts||{mine:0,dept:0};
      attachmentReady=data.attachment_capability==='fixed_references_v2';
      if(page>Math.max(1,Math.ceil(total/30))){page=Math.max(1,Math.ceil(total/30));return await load();}
      mails=(data.rows||[]).map(mapReal);
    }catch(error){if(ui.disposed||sequence!==querySequence)return;readError=error.message||'读取失败';mails=[];}
    finally{
      if(!ui.disposed&&sequence===querySequence){
        loading=false;
        $('#compose').disabled=!connected;$('#compose').innerHTML=actionLabel(connected?'写邮件':'暂不可用','compose');
        accountChrome();render();
      }
    }
  }
  /* 存完一封草稿后，**这封信该不该出现在列表里**：列表的范围 = 看的箱 × 看的状态。
     · 状态：回执里带着（'all' 时除回收站都算，'draft' 只算草稿）。
     · 箱：当前选定了箱就是它；**没选箱 = 本人箱**（服务端口径：没指定箱 = 本人个人箱，
       service.py 的 query 就是这么写的）。
       本人箱编号前端**不一定拿得到** —— 没绑邮箱的人**没有邮箱目录条目**
       （个人箱编号 = sha256(登录人)[:40]，没有账号行），目录里是空的。
       这时**只有本人箱可选**（发件身份下拉里只有「本人草稿（未绑定邮箱）」），
       所以「拿不到编号」≠「可能属于别的箱」：不拦它。
     旧写法拿回执的 mailbox_id 去比「当前箱编号」，没绑邮箱时那个编号是空串，
     比不上就早退 —— 新草稿不进列表，用户刷新一下才看得到（2026-10-19 在 3870
     试用站真页面量出来的）。 */
  function updateSavedMailInList(saved){
    const index=mails.findIndex(row=>row.id===saved.id),existing=index>=0?mails[index]:null;
    const personalBoxId=mailboxes.find(item=>item.kind==='personal'&&item.rights?.read!==false)?.id||'';
    const scopeBoxId=currentBox?.id||personalBoxId;
    // 拿不到范围编号就不当它出范围（不猜未知新箱）；拿得到就**逐字比**。
    const sameBox=!scopeBoxId||!saved.mailboxId?true:saved.mailboxId===scopeBoxId;
    const inScope=box==='all'?saved.box!=='trash':saved.box===box;
    if(!sameBox||!inScope){if(index>=0){mails.splice(index,1);total=Math.max(0,total-1);}return;}
    // 服务端负责搜索、附件/未读筛选及分页；只在这些范围需要时重读一页。
    if($('#search').value.trim()||$('#filter').value||page>1){void load();return;}
    if(index>=0)mails[index]=saved;else{mails.push(saved);total++;}
    mails.sort((a,b)=>(descending?-1:1)*a.date.localeCompare(b.date));
    if(mails.length>30)mails.length=30;
  }
  const fmt = p => p.name ? (p.addr?`${p.name} <${p.addr}>`:p.name) : p.addr;
  /* ★ 交互样例页用的**演示引用块** —— 只有「查看交互样例」这个页面用得着
     （样例信不在库里，后端那个动作调不通，没有回包可开窗）。
     形状照后端 `shangshu_mail.quoting.build_quote_block`（同一句分隔线、同一组标记、
     同样把尖括号地址转义成字面）—— **产品路径不走这里**：
     人点回复/转发一律调后端动作（`mail.reply` / `mail.forward`），引用块只有那一份。
     形状对不对由判据钉（`mail-quote-style.test.ts`「样例引用块与后端同形」）。 */
  const demoQuote = mail => {
    const head = `发件人: ${escape(fmt(mail.from || {}))}<br>发送时间: ${escape(mail.date || '')}<br>`
      + `收件人: ${escape((mail.to || []).map(fmt).join('；') || '—')}`
      + `${(mail.cc || []).length ? `<br>抄送: ${escape(mail.cc.map(fmt).join('；'))}` : ''}<br>`
      + `主题: ${escape(mail.subject || '')}`;
    /* 原信是纯文本时它的换行要保得住（`white-space:pre-wrap`），别被 HTML 折成空格。 */
    const body = mail.bodyFormat !== 'HTML'
      ? `<div data-mail-quote-body="1" style="white-space:pre-wrap">${escape(mail.body || '')}</div>`
      : `<div data-mail-quote-body="1">${mail.body || ''}</div>`;
    return '<p><br></p>'
      + '<div data-mail-quote="1" style="color:#666">'
      + '<div data-mail-quote-sep="1">---------- 原始邮件 ----------</div>'
      + '<div data-mail-quote-head="1" style="font-size:12px;margin:10px 0 12px;line-height:1.8">'
      + `${head}</div>${body}</div>`;
  };
  const size = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  /* 投递状态文案对齐旧版真实字典：不把“服务商接受”说成“已投递”。 */
  const DELIVERY_TEXT = {accepted: '服务商已接受', partially_accepted: '部分接受', bounced: '退信', send_failed: '发送失败', send_unknown: '发送结果待确认',sending:'发送中',queued:'等待发送'};
  const deliveryText = m => DELIVERY_TEXT[m.delivery] || '';
  /* 重发策略：明确失败可按同一意图重试；结果未知先查状态；已被接受必须新建发送意图。 */
  function resendNote(m) {
    if(!showExamples){
      if(['send_unknown','sending','queued'].includes(m.delivery))return '请刷新状态并核对服务商邮箱；结果未明确前不要重新发送，以免对方重复收到。';
      if(m.delivery==='partially_accepted')return '只有部分收件人被服务商接受。请先核对原邮箱回执，不要直接重发给所有人。';
      if(m.delivery==='send_failed')return '本次发送失败。核对邮箱连接和原邮箱后，如需重新发送，请新建草稿。';
      /* 已被服务商接受 = 这封的发送意图已经用掉了，不能改成可重发的草稿。
         原先只说「服务商接受不代表对方已收到或已读」，没告诉用户**下一步怎么办**，
         与本函数开头那句注释（「已被接受必须新建发送意图」）对不上。补上。 */
      if(m.delivery)return '这封邮件已被服务商接受：不能直接重发。要再发一次请新建草稿。服务商接受不代表对方已收到或已读，请结合对方回复确认。';
    }
    if (m.delivery === 'bounced' || m.delivery === 'send_failed') return '上一次发送未成功（已收到明确失败回执），可以按同一份内容重试。';
    if (m.delivery === 'send_unknown') return '上一次发送结果未知：请先查投递状态，确认未受理后再决定是否重发。';
    if (m.delivery) return '这封邮件已经排队/已被服务商接受：不能直接重发；确认未送达请重新写一封。';
    return '';
  }
  const people = m => (m.box === 'trash' ? m.deletedFrom : m.box) === 'inbox' ? fmt(m.from) : (m.to?.length ? '收件人：' + m.to.map(fmt).join('；') : '（未填收件人）');

  function visible() {
    if(!showExamples)return mails;
    const term = $('#search').value.trim().toLowerCase(), f = $('#filter').value;
    return mails.filter(m => box === 'all' ? m.box !== 'trash' : m.box === box)
      .filter(m => !f || (f === 'unread' ? m.unread : m.attachments.length > 0))
      .filter(m => !term || [m.subject, m.body, m.from?.addr, m.from?.name, ...(m.to || []).map(fmt)].join(' ').toLowerCase().includes(term))
      .sort((a, b) => (descending ? -1 : 1) * a.date.localeCompare(b.date));
  }
  function render() {
    $('#mail-box').value = box;
    /* —— **「发信候选（待审）」那一档**：列表区摆的是**候选卡**（不是邮件）——
       候选卡由邮件域那一块落在这个槽位里（2026-10-24 22:3x 用户原话：「你说呢？」＋
       （指认下拉）「就是这里」⇒ 并进这个下拉，**不再单独摆一个「发信候选 · 待审」区块**）。
       那一档没选中 ⇒ 槽位整块藏着（不许在别的档里冒出来）。 —— */
    const candidatesOn = box === 'candidates';
    const slot = $('#mail-candidates');
    if (slot) slot.hidden = !candidatesOn;
    $('#mail-rows').hidden = candidatesOn;
    const rows = visible();
    // 两套未读数**分开显示、不相加**（N5-4：一封未读信在两套里各算一次）。
    $('#result-count').innerHTML = (loading && !candidatesOn && !showExamples)
      ? '<span class="platform-skeleton-bar" style="display:inline-block;width:64px;height:11px;vertical-align:middle"></span>'
      : escape(candidatesOn
        ? '待审候选'
        : showExamples
        ? `${rows.length} 封 · 未读 ${rows.filter(m => m.unread).length}`
        : `${total} 封 · 本人未读 ${unreadCounts.mine} · 部门未读 ${unreadCounts.dept}`);
    $('#mail-pagination').hidden=showExamples||!connected;
    /* —— 候选那一档：没有「选信／批量回收」这回事（那批动作是对邮件的）⇒ 整条藏起来。 —— */
    const selectionBar=host.querySelector('.mail-selection-bar');
    if(selectionBar)selectionBar.hidden=box==='candidates';
    $('#mail-page').textContent=`${page} / ${Math.max(1,Math.ceil(total/30))}`;
    $('#mail-prev').disabled=loading||page<=1;$('#mail-next').disabled=loading||page*30>=total;
    // 未读样式跟着**点**走（N5-4：两个点都消了就该一个不剩，不许只剩加粗=「换个颜色」）。
    // 没有双未读字段时退回旧口径 `unread` —— 交互样例那批数据只有 unread 一个标记。
    const rowUnread = m => Boolean(m.myUnread ?? m.unread) || Boolean(m.deptUnread);
    $('#mail-rows').innerHTML = rows.map(m => {
      const person=people(m),attachments=m.attachmentCount||m.attachments.length;
      const state=deliveryText(m)||({inbox:'已收到',draft:'草稿',queued:'发送中',trash:'已删除'}[m.box]||'');
      return `<div class="mail-select-row"><label class="mail-row-select"><input type="checkbox" data-mail-select="${escape(m.id)}" aria-label="选择邮件：${escape(m.subject)||'无主题'}" ${mailSelection.has(m.id)?'checked':''} ${batchRunning||!canManage()||m.box==='trash'?'disabled':''}></label><button type="button" data-mail="${escape(m.id)}" data-open="${escape(m.id)}" aria-pressed="${selected === m.id}" class="mail-item ${selected === m.id ? 'is-selected' : ''} ${rowUnread(m) ? 'is-unread' : ''}">
      <span class="mail-item-top"><span class="subject" title="${escape(m.subject)||'（无主题）'}">${escape(m.subject)||'（无主题）'}</span><span class="mail-unread-signals">${(m.myUnread??m.unread)?'<span class="mail-dot mail-dot-mine" title="本人未读" aria-label="本人未读"></span>':''}${m.deptUnread?'<span class="mail-dot mail-dot-dept" title="部门未读" aria-label="部门未读"></span>':''}</span><span class="mail-item-state" data-mail-state="${escape(m.box)}" title="${escape(state)}">${attachments?`<span class="mail-list-attachment" title="附件 ${attachments}">${mailIcon('attach')}<span>附件 ${attachments}</span></span>`:''}<span>${escape(state)}</span></span></span>
      <span class="mail-item-foot"><span class="mail-item-person" title="${escape(person)}">${escape(person)}</span><time class="date" datetime="${escape(m.date.replace(' ','T'))}" title="${escape(m.date)}">${escape(m.date)}</time></span>
    </button></div>`;
    }).join('')
      /* —— **列表还没到** ⇒ 骨架（照真邮件行的形状）；读回来了确实是空 ⇒ 空态（说人话）。 —— */
      || (loading ? mailListSkeleton() : `<div class="empty"><strong>${readError?escape(readError):$('#search').value || $('#filter').value ? '没有匹配的邮件' : box === 'trash' ? '回收站是空的' : box === 'draft' ? '没有草稿' : box === 'failed' ? '没有失败待处理的邮件' : '这里没有邮件'}</strong>${showExamples ? '换个条件，或清除筛选。' : connected?(canSend()?'点击“立即同步”收信，或“写邮件”开始。':'可先创建草稿；绑定邮箱后即可收发。'):'邮件服务尚不可用，清除筛选可重试。'}</div>`);
    /* 入口必须在后端不可用时也能用：connected=false 时唯一能体验界面的路就是样例。
       之前条件写死 connected===true，导致服务没起来时两个入口都进不去。 */
    if(!showExamples&&(connected||readError)&&!loading&&!rows.length&&!$('#search').value&&!$('#filter').value&&box==='all'){
      $('#mail-rows .empty').insertAdjacentHTML('beforeend','<button class="btn" data-mail-examples>查看交互样例</button>');
      $('[data-mail-examples]').onclick=()=>{if(canLeave())ui.toggleExamples(window.mountMailCenter,true);};
    }
    host.querySelectorAll('[data-open]').forEach(b => b.onclick = () => open(b.dataset.open));
    host.querySelectorAll('[data-mail-select]').forEach(control => control.onchange = () => {
      if(control.checked)mailSelection.add(control.dataset.mailSelect);else {mailSelection.delete(control.dataset.mailSelect);batchSnapshots.delete(control.dataset.mailSelect);}
      batchConfirmation='';renderSelection();
    });
    renderSelection();
  }

  function renderSelection() {
    if(ui.disposed)return;
    const controls=[...host.querySelectorAll('[data-mail-select]:not(:disabled)')];
    const all=$('#mail-select-all');all.checked=!!controls.length&&controls.every(control=>control.checked);all.indeterminate=controls.some(control=>control.checked)&&!all.checked;all.disabled=batchRunning||!canManage()||!controls.length;
    $('#mail-selection-count').textContent=mailSelection.size?`已选择 ${mailSelection.size} 封`:'未选择';
    const button=$('#mail-batch-recycle');button.disabled=batchRunning||!canManage()||!mailSelection.size||box==='trash';
    button.title=!canManage()?'当前没有邮件管理权限':!mailSelection.size?'先选择需要回收的邮件':'只移入尚书回收站，原邮箱邮件不变';
    button.innerHTML=actionLabel(batchRunning?'回收中…':batchConfirmation?`确认回收 ${mailSelection.size} 封`:'批量回收','trash');
    $('#mail-selection-clear').hidden=!mailSelection.size;$('#mail-selection-clear').disabled=batchRunning;
    /* —— 候选那一档：搜索/筛选/排序**不适用**（那是对邮件的）⇒ 置灰。 —— */
    for(const name of ['mail-box','filter','search','sort','clear'])$('#'+name).disabled=batchRunning||(box==='candidates'&&name!=='mail-box'&&name!=='clear');
    $('#mailbox-switch').disabled=batchRunning||$('#mailbox-switch').options.length<2;
    $('#compose').disabled=batchRunning||(!showExamples&&(!connected||!canEditDraft()));
    host.querySelectorAll('[data-open]').forEach(button=>button.disabled=batchRunning);
    if(batchRunning){$('#mail-prev').disabled=true;$('#mail-next').disabled=true;}
  }
  function clearMailSelection() {mailSelection.clear();batchSnapshots.clear();batchConfirmation='';$('#mail-batch-results').hidden=true;render();}
  function renderBatchResult(state) {
    if(ui.disposed)return;
    const area=$('#mail-batch-results');area.hidden=false;
    const failures=[...state.failed.map(item=>({...item,state:'失败'})),...state.unknown.map(item=>({...item,state:'结果未知'}))];
    area.innerHTML=`<strong>${state.completed}/${state.counts.total} 封已核对 · 成功 ${state.counts.success} · 失败 ${state.counts.failed} · 结果未知 ${state.counts.unknown}</strong>${failures.length?`<ul>${failures.map(item=>`<li><span>${escape(mails.find(mail=>mail.id===item.id)?.subject||item.id)}</span>：${item.state} · ${escape(item.reason)}</li>`).join('')}</ul><p>失败项仍保留并选中；结果未知时先核状态，重试沿用原请求。</p>`:''}`;
  }
  async function recycleSelection() {
    if(batchRunning||!canManage()||!mailSelection.size||!canLeave())return;
    const ids=[...mailSelection];const marker=JSON.stringify(ids);
    if(batchConfirmation!==marker){batchConfirmation=marker;renderSelection();return;}
    batchRunning=true;batchConfirmation='';render();
    try{
      if(!window.runMailBatch)await import('/js/mail-batch.js');
      const outcome=await window.runMailBatch({ids,invoke:async(id,validateReceipt)=>{
        const mail=mails.find(row=>row.id===id);
        if(!batchSnapshots.has(id)){
          if(!mail)throw Object.assign(Error('邮件已不在当前列表，请刷新后核对'),{uncertain:false});
          batchSnapshots.set(id,{mail:id,expected_version:mail.version});
        }
        if(showExamples){mail.box='trash';return {name:id,status:'Trash',record_version:(mail.version||0)+1};}
        return action('mail.recycle',batchSnapshots.get(id),validateReceipt);
      },onProgress:state=>{
        if(ui.disposed)return;
        for(const item of state.success){mailSelection.delete(item.id);batchSnapshots.delete(item.id);}
        for(const item of state.failed)batchSnapshots.delete(item.id);
        const removed=new Set(state.success.map(item=>item.id));
        if(removed.has(selected))closeDetail();
        mails=mails.filter(mail=>!removed.has(mail.id));render();renderBatchResult(state);
      }});
      if(ui.disposed)return;
      await load();renderBatchResult(outcome);
      notify(outcome.allSucceeded?`已回收 ${outcome.counts.success} 封邮件`:`成功 ${outcome.counts.success} 封，其余请查看逐条结果`,outcome.allSucceeded?'success':'info');
    }catch(error){if(!ui.disposed)notify(`批量回收未完成：${error.message}`,'error');}
    finally{batchRunning=false;if(!ui.disposed)render();}
  }

  function closeDetail() {
    if(writing){notify('正在保存，请等待结果');return;}
    if (!canLeave()) return;
    inlineReviewController?.destroy();inlineReviewController=null;
    composeSendState=null;composeCanManageDraft=null;
    /* 关闭/刷新才清撤回栈（用户拍板）—— 清掉活句柄，下次重开不带历史。 */
    activeBodyEditor=null;activeComposeKey='';
    detailSequence++;
    canLeave = () => true; selected = null;
    businessContext();
    $('#detail').classList.remove('is-composing');
    $('#detail').onkeydown=null;
    $('#detail').replaceChildren();
    host.classList.remove('mail-has-selection'); render();
  }
  const chips = list => (list || []).map(p => `<span class="addr-chip" title="${escape(fmt(p))}">${escape(p.name || p.addr)}</span>`).join('') || '—';
  async function open(id) {
    if(batchRunning){notify('正在逐条回收，请等待核对结果','info');return;}
    if(writing){notify('正在保存，请等待结果');return;}
    let m = mails.find(x => x.id === id);
    if((showExamples&&!m)||!canLeave())return;
    if(!showExamples){
      const sequence=++detailSequence;
      try{
        const data=await request('/api/platform/services/mail.detail/invoke',{payload:{mail:id}});
        if(ui.disposed||sequence!==detailSequence||!canLeave())return;
        const full=mapReal((data.result||data).mail);if(m)Object.assign(m,full);else m=full;
        const actualBox=mailboxes.find(mailbox=>mailbox.id===m.mailboxId);
        /* BASE967-06：深链接打开**另一个邮箱**的信时，列表也要跟着切到那个邮箱。
           原来这里只改 `currentBox` / 下拉 / 权限外观，**没重载列表** ——
           于是详情是部门箱的信、列表还停在个人箱的信，两边对不上。
           对齐用户手动切箱那条（`#mailbox-switch.onchange`）：
           `currentBox = …; clearMailSelection(); page = 1; accountChrome(); refresh();` ——
           这里少了后两截，补上。
           `refresh()` → `load()` → `render()` 只重建**列表**（`#mail-rows`/计数/分页），
           **不碰 `#detail` / `selected`**，所以不会把马上要渲染的详情冲掉。 */
        if(m.mailboxId&&currentBox?.id!==(actualBox?.id||undefined)){currentBox=actualBox||null;$('#mailbox-switch').value=currentBox?.id||'';clearMailSelection();page=1;accountChrome();refresh();}
      }catch(error){
        if(ui.disposed||sequence!==detailSequence)return;
        notify(error.message,'error');
        /* ★ FIX-57（用户 2026-10-20 21:13：「可是这个邮件打卡变成空白了」）：
           取详情失败时，原来只弹一句 toast 就 `return` —— 详情区**留着上一封的内容，
           或者干脆一片空白**（列表行里**本来就没有正文**，正文全靠详情接口给）
           ⇒ 用户看到的就是「一封信只剩抬头、正文空着」。
           现在**明说取不到**，并给一个「再试一次」。 */
        try{
          const p=$('#detail');
          p.classList.remove('is-composing');host.classList.add('mail-has-selection');
          p.innerHTML=`<div class="detail-head"><span>邮件详情</span><button class="detail-close" id="close-detail" aria-label="关闭邮件详情">×</button></div>
            <div class="platform-error wide"><b>这封信暂时读不到</b><p>${escape(error?.message||'读取失败')}</p>
            <button class="btn btn-ghost" id="retry-mail">再试一次</button></div>`;
          const head=p.querySelector('.detail-head');
          if(head&&p.querySelector('h2'))head.querySelector('span').replaceWith(p.querySelector('h2'));
          $('#close-detail').onclick=closeDetail;
          $('#retry-mail').onclick=()=>void open(id);
        }catch(_e){/* 面板都画不出来就算了 —— toast 已经说过一次。 */}
        return;
      }
    }
    if (m.box === 'draft' && (showExamples || canEditDraft())) { openCompose(m); return; }
    if (!canLeave()) return;
    inlineReviewController?.destroy();inlineReviewController=null;
    canLeave = () => true;
    selected = id;
    businessContext(m,'mail-detail');
    if (showExamples&&m.unread) m.unread = false;
    const p = $('#detail'); p.classList.remove('is-composing'); host.classList.add('mail-has-selection');
    p.innerHTML = `<div class="detail-head"><span>邮件详情</span><button class="detail-close" id="close-detail" aria-label="关闭邮件详情">×</button></div>
      <h2>${escape(m.subject) || '（无主题）'}</h2>
      ${m.box === 'draft' && !showExamples ? '<p class="mail-connection-note" role="status">当前没有编辑草稿权限，以下正文仅供查看。</p>' : ''}
      <div class="detail-actions">
        ${m.box === 'trash' ? `<button class="btn btn-pri" id="restore-mail" ${canManage()?'':'disabled title="当前没有邮件管理权限，不能恢复邮件"'}>恢复到原位置</button>` : `
        ${!showExamples&&m.status==='Queued'?`<button class="btn btn-pri" id="continue-mail" ${canSend()?'':'disabled'}>继续发送</button>`:''}
        <button class="btn btn-ghost" id="reply" title="只回给发件人一个人">${actionLabel('回复','reply')}</button>
        <button class="btn btn-ghost" id="reply-all" title="回给这封信的所有人（发件人 + 原收件人 + 抄送），不包括你自己。用在这封信本来是发给一组人、你回的时候要让大家都看到">${actionLabel('回复全部','all')}</button>
        <button class="btn btn-ghost" id="forward" title="把这封信转给别人，原信内容作为引用附在下面">${actionLabel('转发','forward')}</button>
        ${(showExamples ? m.box === 'inbox' : m.status === 'Received') ? `<button class="btn btn-ghost" id="toggle-unread" title="${m.unread ? '把这封标成看过' : '把这封放回未读，留着以后处理'}">${m.unread ? '标为已读' : '标为未读'}</button>` : ''}
        ${!showExamples?'<button class="btn btn-ghost" id="refresh-mail">刷新状态</button>':''}
        ${''}
        <button class="btn btn-ghost" id="trash-mail" ${canManage()?'':'disabled title="当前没有邮件管理权限，不能删除邮件"'}>${actionLabel('移入回收站','trash')}</button>`}
      </div>
      <dl><dt>发件人</dt><dd>${escape(fmt(m.from))}</dd>
      <dt>收件人</dt><dd class="addr-chips">${chips(m.to)}</dd>
      <dt>抄送</dt><dd class="addr-chips">${chips(m.cc)}</dd>
      <dt>时间</dt><dd>${escape(m.date)}</dd>
      ${deliveryText(m) ? `<dt>投递状态</dt><dd><span class="state-chip state-${m.delivery}">${escape(deliveryText(m))}</span></dd>` : ''}
      ${m.deliveryError?`<dt>说明</dt><dd>${escape(m.deliveryError)}</dd>`:''}${m.rejected?.length?`<dt>未接受</dt><dd>${escape(m.rejected.join('；'))}</dd>`:''}
      <dt>状态</dt><dd>${m.box === 'trash' ? `已删除 · 原在${m.deletedFrom === 'inbox' ? '收件箱' : m.deletedFrom === 'sent' ? '已发送' : m.deletedFrom === 'failed' ? '失败待处理' : '草稿箱'}` : m.status === 'Draft' ? '草稿' : showExamples?(m.unread ? '未读' : '已读'):(deliveryText(m)||'已收到')}</dd></dl>
      ${m.attachments.length ? `<div class="att-block"><div class="att-title">附件</div>${m.attachments.map((a,i) => `<div class="att-row"><span class="att-name">${escape(a.name)}</span><span class="att-meta">${size(a.size)}${a.tag ? ` · ${escape(a.tag)}` : ''}</span>${showExamples?`<button class="mail-link" data-archive="${escape(a.name)}">归档到文件库</button>`:`<button class="mail-link" data-saved-preview="${i}">预览</button>${m.status!=='Received'?`<span class="att-meta" data-att-ref="1">已引用文件中心</span>`:a.imported?`<span class="att-meta" data-imported="1">已在文件中心</span>`:`<span class="att-meta" data-imported="0">未入库：${escape(a.import_error || a.import_reason || a.failure_reason || '自动入库尚未完成，可刷新状态；仍未入库请联系管理员核查。')}</span>`}`}</div>`).join('')}</div>` : ''}
      <div class="mail-body-frame">${bodyView(m)}
        <div class="mail-body-grip" data-mail-body-grip role="separator" tabindex="0"
             aria-orientation="horizontal" aria-label="调整正文窗格高度"
             aria-valuemin="200" aria-valuemax="1600"></div>
      </div>

      ${m.box === 'failed' || deliveryText(m) ? `<p class="resend-note">${escape(resendNote(m))}</p>` : ''}`;
    const head=p.querySelector('.detail-head');
    head.querySelector('span').replaceWith(p.querySelector('h2'));
    head.insertBefore(p.querySelector('.detail-actions'),$('#close-detail'));
    $('#close-detail').onclick = closeDetail;
    /* 读信正文 = 所见即所得的**只读编辑面**（跟写信窗同一套编辑器、同一道净化门）。
       收进来的信是外部内容：脚本/事件/外链由 safeFragment 剥掉（黑名单一根没松），
       表格/合并格/受管 CID 图都还在 —— 受管内联图按授权字节解析成 data URI。
       为什么不再挂 `<iframe sandbox srcdoc>` 那个第二面：那个面在有的浏览器里
       渲染不出来 ⇒ 详情区只剩一个空边框框（用户 2026-10-21 报「正文整块空白」，
       点转发却看得到）。现在**只有一个面**。 */
    mountBodySurface(p, m);
    /* 拖柄是这次才画出来的 —— 把记住的高度同步写回去（别用 MutationObserver，
       那是微任务，画完立刻读会读到空的 aria）。 */
    if (typeof setBodyHeight === 'function') setBodyHeight(bodyHeight, false);
    /* 打开看 = 自动标已读（用户 2026-10-13：「已读未读」）。
       看过就该算看过，不该再让人去找按钮点。标不上也不挡读信。 */
    if (!showExamples && m.status === 'Received' && m.unread) {
      const openedFor = id;
      void (async () => {
        try {
          const receipt=await action('mail.set_read', {mail: m.id, expected_version: m.version, read: true});
          if(ui.disposed)return;
          adoptReadState(m,receipt,true);
          // 两点以正式回执为准，当前列表与总计数一起重新读取，覆盖旧的在途查询。
          await load();
          if (ui.disposed || selected !== openedFor) return;
          const b = p.querySelector('#toggle-unread');
          if (b) { b.textContent = '标为未读'; b.title = '把这封放回未读，留着以后处理'; }
        } catch (e) { /* 标已读失败不打断读信 */ }
      })();
    }
    /* 引用块（回复/转发共用）。
       用户 2026-10-12（计划 §6 C2）：「转发正文含可识别的原信来源/日期/主题，支持的 HTML 表格与 CID 都在」。
       改之前取的是 textContent —— **表格和内联图全被剥掉**，转发出去看不出原来长什么样。
       改之后：HTML 原信整段保留（表格/合并格/图原样），来源/日期/主题写在引用头里，
       引用块带 data-mail-quote 标记，好让「新正文」和「原文」边界清楚。 */
    /* 回复/转发的引用样式 —— **照真实邮件客户端，不臆想**（用户 2026-10-12：
       「我建议你去看看真正的邮件软件（比如 foxmail）回复的样式是啥样的，不要自己臆想」）。
       去 GitHub 拉了四家真正生成回复引用的代码，结构一致：
         CompanyEmailSystem/Public/js/edit.js:40   <br>×4 + 「---------原始邮件---------」+ 原文
         miko-email/web/templates/compose.html:432 「-------- 原始邮件 --------」+ 发件人/发送时间/主题
         FOE/.../Email/view.html:182               <br>×6 + 「-----------原始邮件------------」+ blockquote
         ibos/phone/view/mail/mail_edit.html       「———————  原始邮件  ———————」+ 灰底抬头块
       yefch3/erp-go 的 quotedhistory.go（**解析**各家引用，权威清单）还证实：
       切分点在**节点边界** —— 用户新写的字是**兄弟**，引用是下面那半，绝不嵌套；
       识别引用开头靠「横杠 + 原始邮件」或 blockquote，**没有一家用竖线**。
       所以这里：顶部留一个空段落给人写字（**不进任何框**），
       下面才是「----- 原始邮件 -----」分界 + 四项抬头 + 原文。
       ★ 2026-10-21：这段**形状的实现搬到后端那一份**（`shangshu_mail.quoting.build_quote_block`）——
         人点与 agent 拿到的引用块是同一份产物。 */
    /* 抬头里的名字/地址/主题**必须转义**：`fmt()` 出来是「张三 <a@b.com>」，
       直接拼进 HTML 会把 `<a@b.com>` 当成标签 —— 渲染出
       `收件人: 张三 <a@b.com></a@b.com>` 这种多余闭合（实测看见）。
       地址里的 `<` `>` 是邮箱写法，不是标记。
       （产品路径的转义在**后端**那份实现里；本文件里只剩交互样例页那段演示用的。） */
    if (m.box !== 'trash') {
      if($('#continue-mail'))$('#continue-mail').onclick=()=>openSendConfirm(m,m,m,m.attachments);
      /* 回复目标（RFC 5322）：原信写了 Reply-To 就回 Reply-To，否则回原发件人；
         自己发的信点回复，回给原收件人。一律**排除本人地址**。
         To/Cc **一起去重**：同一人不许在两栏各出现一次（会收到两遍）。
         Bcc 刻意不参与 —— 用户 2026-10-12：「不泄露也不推断 Bcc」。 */
      const selfAddresses=new Set([ME.addr,currentBox?.email].filter(Boolean).map(value=>String(value).trim().toLowerCase()));
      const notMe = x => x && x.addr && !selfAddresses.has(String(x.addr).trim().toLowerCase());
      const uniqueAcross = (...lists) => {
        const seen = new Set();
        return lists.map(list => (list || []).filter(x => {
          if (!notMe(x)) return false;
          const key = String(x.addr).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
      };
      const replyTarget = () => {
        const rt = parseRecipients(m.replyToAddress || '').list;
        if (rt.length) return rt;
        return selfAddresses.has(String(m.from.addr).trim().toLowerCase()) ? (m.to || []) : [m.from];
      };
      /* 交互样例页用的**内联图**（产品路径不用：那张图由后端动作带在草稿里）。 */
      const inlineOf = () => ({bodyFormat: 'HTML', inline: (m.inline || []).map(a => ({...a})),
        inlineOwner: {ref: 'Shangshu Mail Message', ref_name: m.id || ''}});
      /* ★ 人点回复/转发 = **调后端那两个动作**（mail.reply / mail.forward）。
         引用块、原信内联图的文件中心路径索引、默认签名，全部由**后端那一份实现**产出
         （`shangshu_mail.quoting`）—— 人点与 agent 拿到的是**同一封草稿**，
         不是两边各拼一遍正文字符串（FIX-55 那套本地入库/改写就此收进后端一份）。
         代价（说清楚）：草稿在**点下去那一刻**就建好了（动作要落库才能带引用块与图），
         以前是写到第一个字、失焦时才建。 */
      /* 收件人对象 → **动作收得的地址串**（后端 `addresses()` 只收字符串：
         「名字 <地址>」认，纯对象会被当格式无效拒掉）。 */
      const addressOf = r => {
        if (!r) return '';
        if (typeof r === 'string') return r.trim();
        const addr = String(r.addr || r.email || '').trim();
        const name = String(r.name || '').trim();
        return name ? `${name} <${addr}>` : addr;
      };
      const addressList = list => (list || []).map(addressOf).filter(Boolean);
      /* 草稿**住在哪个箱** —— 动作要落库，箱必须有编辑草稿权（后端 `require_right` 那一道）。
         当前箱有编辑权就住当前箱；**只读共享箱** ⇒ 住本人有编辑权的那个箱
         （用户 2026-10-17 的口径：只读共享来信可以用本人身份回复）。 */
      const draftBoxId = () => {
        const box = currentBox;
        if (box && box.rights && box.rights.edit_draft === false) {
          const personal = (mailboxes || []).find(item => item.kind === 'personal'
            && (item.rights || {}).edit_draft === true);
          return personal?.id || '';
        }
        return box?.id || '';
      };
      const replyOrForward = async (actionId, seed) => {
        /* 交互样例页没有后端（样例信不在库里）⇒ 自己拼一段**演示用**引用块。
           **产品路径不走这里** —— 见 `demoQuote` 那段注释。 */
        if (showExamples) { openCompose({...seed, body: demoQuote(m)}); return; }
        try {
          const receipt = await action(actionId, {
            reply_to_mail: m.id,
            to: addressList(seed.to), cc: addressList(seed.cc),
            subject: seed.subject || '', body: seed.body || '',
            ...(draftBoxId() ? {mailbox: draftBoxId()} : {}),
          }, r => Boolean(r && r.name) && Number.isInteger(r.record_version));
          /* 打开的**就是后端那封草稿**（正文/主题/收件人都是后端算好的）。
             原信的附件仍列成「可选」—— 附件默认不带走，由人点选（用户 2026-10-12 C2）。 */
          openCompose({...mapReal(receipt),
            ...(seed.forwardAttachments ? {forwardAttachments: seed.forwardAttachments} : {}),
            ...(seed.forwardNote ? {forwardNote: true} : {})});
        } catch (error) {
          /* 动作失败 ⇒ **明说失败**，不静默开出一封空草稿（用户看不到发生了什么）。 */
          notify((error && error.message) || '生成草稿失败', 'error');
        }
      };
      $('#reply').onclick = () => replyOrForward('mail.reply', {box: 'draft', to: uniqueAcross(replyTarget())[0],
        subject: `Re: ${m.subject}`, body: '', attachments: [], replyToMail: showExamples ? '' : m.id,
        ...inlineOf()});
      /* BASE967-05（UI046 根因 D 已确认）：**回复全部直接用了 m.from**，
         没用 `Reply-To`。把第一项改成 `replyTarget()`（它先取 Reply-To，无则回退到 m.from，
         已是正确行为），其它仍按 m.to + m.cc。 */
      $('#reply-all').onclick = () => {
        const [to, cc] = uniqueAcross([...replyTarget(), ...(m.to || [])], m.cc || []);
        replyOrForward('mail.reply', {box: 'draft', to, cc, subject: `Re: ${m.subject}`, body: '',
          attachments: [], replyToMail: showExamples ? '' : m.id, ...inlineOf()});
      };
      /* 转发：引用块带走 HTML 表格与 CID（inline 交给编辑器解析成可显示的图）。
         附件**不默认全带** —— 用户 2026-10-12（C2）：「普通附件显式选择并固定版本」。
         默认一封都不带，原信附件列成「可选」，点一下才加进这封。 */
      $('#forward').onclick = () => replyOrForward('mail.forward', {
        box: 'draft', to: [], subject: `Fwd: ${m.subject}`, body: '',
        bodyFormat: 'HTML', inline: (m.inline || []).map(a => ({...a})),
        attachments: [], forwardAttachments: (m.attachments || []).map(a => ({...a})),
        inlineOwner: {ref: 'Shangshu Mail Message', ref_name: m.id || ''},
        forwardNote: true, replyToMail: showExamples ? '' : m.id,
      });
      const toggleBtn = $('#toggle-unread');
      if (toggleBtn) toggleBtn.onclick = async () => {
        const toUnread = !m.unread;
        /* 点完就关掉读信窗、回到列表看标记变化 —— 这是已经验过的行为，两种模式一致。 */
        if (showExamples) {
          m.unread = toUnread; closeDetail(); notify(toUnread ? '已标为未读' : '已标为已读'); return;
        }
        try {
          const receipt=await action('mail.set_read', {mail: m.id, expected_version: m.version, read: !toUnread});
          if(ui.disposed)return;
          adoptReadState(m,receipt,!toUnread);
          closeDetail();await load();notify(toUnread ? '已标为未读' : '已标为已读');
        } catch (e) { notify(e.message || '标记失败', 'error'); }
      };
      if(!showExamples){$('#refresh-mail').onclick=()=>void open(m.id);if(m.box==='queued'){$('#trash-mail').disabled=true;$('#trash-mail').title='发送中不能回收，请先核对结果';}}
      /* ★ FIX-56（用户 2026-10-20：「查看邮件的时候直接以富文本显示，不要『选择』是什么形式的文本」）：
         原来这里有个**「纯文本」切换按钮**（BASE967-24 req 4 加的），在富文本 iframe 与
         纯文本 <pre> 两套之间切 —— 用户明确要**直接就是富文本**、**没有这个选择** ⇒ 已撤。
         （纯文本格式的信仍按纯文本显示：`bodyView` 里 `bodyFormat!=='HTML'` 那条分支没动。）
      */
      $('#trash-mail').onclick = async e => {
        if(!showExamples&&!canManage()){notify('当前没有邮件管理权限，不能删除邮件','error');return;}
        const b = e.currentTarget;
        if (b.dataset.confirm) {
          if(!showExamples){
            if(writing)return;writing=true;b.disabled=true;
            try{await action('mail.recycle',{mail:m.id,expected_version:m.version});writing=false;if(ui.disposed)return;closeDetail();await load();notify('已移入尚书回收站；原邮箱邮件不变');}
            catch(error){notify(error.message,'error');}finally{writing=false;if(b.isConnected)b.disabled=!canManage()||m.box==='queued';}
            return;
          }
          m.deletedFrom = m.box; m.box = 'trash'; m.unread = false; closeDetail(); notify('已移入回收站；删除不会撤回对方邮箱中的邮件'); }
        else { b.dataset.confirm = '1'; b.textContent = '确认移入？不会撤回对方邮件'; }
      };
    } else $('#restore-mail').onclick = async () => {
      if(!showExamples){
        if(!canManage()){notify('当前没有邮件管理权限，不能恢复邮件','error');return;}
        if(writing)return;writing=true;$('#restore-mail').disabled=true;
        try{await action('mail.restore',{mail:m.id,expected_version:m.version});writing=false;if(ui.disposed)return;closeDetail();await load();notify('已恢复到原位置');}
        catch(error){notify(error.message,'error');}finally{writing=false;if(!ui.disposed&&$('#restore-mail'))$('#restore-mail').disabled=!canManage();}
        return;
      }
      m.box = m.deletedFrom || 'inbox'; closeDetail(); notify('已恢复到原位置');
    };
    p.querySelectorAll('[data-archive]').forEach(b => b.onclick = () => openArchive(b.dataset.archive));
    p.querySelectorAll('[data-saved-preview]').forEach(b=>b.onclick=()=>previewAttachment(m.attachments[Number(b.dataset.savedPreview)]));
    render();
  }

  function previewAttachment(a){
    if(!window.openFileCenterDetail){notify('文件详情组件未加载，请刷新重试','error');return;}
    return window.openFileCenterDetail({ui,file:a.reference?{name:a.name,size:a.size}:{id:a.lib},version:a.version,reference:a.reference||null});
  }

  /* 右侧阅读/撰写共用工作面；只有附件选择、发送核对和设置使用弹层。 */
  const closeModal = () => ui.closeModal();
  const closeAllModals = () => ui.closeAllModals();
  const openModal = html => ui.modal(html, {prefix:'mail'});
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  /* 地址洗干净：剥掉外层引号和 mailto: 前缀，再校验。
     用户 2026-10-12 报「mailto is not a valid Email Address」—— 粘进收件人框的地址
     带着 mailto: 一路存进去、发出去，收件人头就是脏的。带引号那支更隐蔽：
     "mailto:x@y.com" 连引号一起被当成地址。 */
  const cleanAddress = raw => {
    let s = String(raw ?? '').trim();
    if (s.length > 1 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) s = s.slice(1, -1).trim();
    s = s.replace(/^mailto:/i, '').trim();
    return s;
  };
  function parseRecipients(raw) {
    const list = [], bad = [],tokens=[];let token='',quoted=false,angle=0,escaped=false;
    for(const ch of String(raw||'')){
      if(ch==='"'&&!escaped)quoted=!quoted;
      if(!quoted&&ch==='<')angle=1;          // 又一个 `<` = 上一个没关上，重新算，别越积越深
      if(!quoted&&ch==='>')angle=0;
      if(!quoted&&/[,，;；]/.test(ch)){
        /* `<` 没关上时本来不该切分 —— 但一个漏写的 `>` 不能把**后面**所有地址
           一起拖下水（用户粘一串收件人，全报「无法识别」，只能手工拆）。
           里面已经有 `@` 说明地址写完了、只是漏了 `>`，那就照分隔符切开。 */
        const open=token.lastIndexOf('<'),inside=open<0?'':token.slice(open+1);
        if(!angle||inside.includes('@')){if(token.trim())tokens.push(token.trim());token='';angle=0;}
        else token+=ch;
      } else token+=ch;
      escaped=ch==='\\'&&!escaped;
    }
    if(token.trim())tokens.push(token.trim());
    for (const token of tokens) {
      const named = token.match(/^(?:([^<>]+?)\s*)?<([^<>]+)>$/);
      const name = named ? (named[1] || '').trim().replace(/^["']+|["']+$/g, '') : '';
      const addr = cleanAddress(named ? named[2] : token);
      if (EMAIL.test(addr)) list.push({name, addr});
      else bad.push(token);
    }
    return {list, bad};
  }

  function openCompose(seed,{review=null,formal=null,proposals=[]}={}) {
    if(batchRunning){notify('正在逐条回收，请等待核对结果','info');return;}
    if(writing){notify('正在保存，请等待结果');return;}
    /* 编辑权按**这封草稿住在哪个箱**判，不是按「当前在看哪个箱」——
       只读共享箱里点回复，草稿落在本人箱（后端动作建在那里），
       那封草稿本人**有权编辑**（用户 2026-10-17 的口径：只读共享来信可以用本人身份回复）。
       草稿没给箱编号 = 落在**本人自己的箱** ⇒ 本人当然能编辑；
       找不到那个箱就退回原来的口径（当前箱）。 */
    const canEditDraftIn = mailboxId => {
      if (!mailboxId) return true;
      const box = (mailboxes || []).find(item => item.id === mailboxId);
      if (!box) return canEditDraft();
      return (box.rights || {}).edit_draft !== false;
    };
    if(seed?.id&&!showExamples&&!canEditDraftIn(seed.mailboxId)){notify('当前没有编辑草稿权限，不能修改这封草稿','error');return;}
    if (!canLeave())return;
    inlineReviewController?.destroy();inlineReviewController=null;
    detailSequence++;
    // New drafts belong to the currently selected mailbox. Availability of a shared sender is not selection.
    // 只读共享来信可以用本人身份回复；不自动借用其他共享箱。已有草稿仍保留家箱。
    const replyFromReadOnly=!!seed?.replyToMail&&!seed?.id&&currentBox?.rights?.edit_draft===false;
    const defaultBox=replyFromReadOnly?(mailboxes.find(box=>box.kind==='personal'&&box.rights?.edit_draft===true)||null):(currentBox||null);
    const defaultFrom=defaultBox?{name:defaultBox.display_name||defaultBox.email,addr:defaultBox.email||defaultBox.id}:{...ME};
    const m = seed || {box: 'draft', from: defaultFrom, to: [], cc: [], subject: '', body: '', attachments: []};
    let editing = seed?.id ? seed : null;
    composeCanManageDraft=()=>{
      if(!editing)return false;
      const actual=mailboxes.find(mailbox=>mailbox.id===editing.mailboxId);
      // 只以正式草稿所属箱判权，切换尚未保存的发件身份不授予删除权。
      return actual?actual.rights?.manage===true:!editing.mailboxId&&canManage();
    };
    if(!editing&&!review&&!m.from)m.from={...defaultFrom};
    /* 新开的信（新建/回复/转发）在这里把默认签名拼进正文；
       重开已有草稿走 editing 分支，不拼 —— 见 withDefaultSignature 的说明。 */
    if (!editing&&!review) {
      const identity=mailboxes.find(box=>box.email===m.from?.addr)||defaultBox;
      m.body = withDefaultSignature(m.body, editing,identity,m);
      /* 签名里引用的受管图要**跟着一起带过去**（计划 §4.4「本封保存签名内容快照
         及所用图片引用」）。不带的话正文里只剩一个取不到的 cid: —— 就是破图。
         已经在原信资源里的不重复加（回复/转发会把原信的图一起带过来）。 */
      const sig = signatureFor(identity);
      if(sig?.enabled&&sig.html)m.bodyFormat='HTML';
      if (sig && sig.enabled && sig.html && Array.isArray(sig.resources) && sig.resources.length) {
        const have = new Set((m.inline || []).map(r => r.id || r.content_id || ''));
        const extra = sig.resources.filter(r => r && !have.has(r.id || r.content_id || ''));
        if (extra.length) m.inline = [...(m.inline || []), ...extra.map(r => ({...r}))];
      }
      /* ★ FIX-55：草稿正文里的每一张内联图改用**文件中心的路径索引** ——
         引用块里的原信图（回复/转发时已送进文件中心）＋ 签名里那张图（本来就在文件中心）。
         `data-managed-cid` 留着，编辑器存回正文时会还原成 `cid:`（出站净化门只认 cid:）。 */
      if (m.inlinePathIndex) {
        m.body = applyInlinePathIndex(m.body, {...signaturePathIndex(sig), ...m.inlinePathIndex});
      }
    }
    businessContext(editing,'mail-compose');
    const dlg = $('#detail');
    selected = editing?.id || null;
    /* 是否用富文本编辑区承载正文：有 mail-editor 模块就用（含新建纯文本信），
       没有才退回 textarea。必须在渲染模板之前定，模板里要读它。 */
    const mailEditorAvailable = Boolean(globalThis.mailEditor);
    /* BL-21/22（用户 2026-10-17 req 2）：「打开/刷新/改正文不默认变个人；
       只有用户明确选择且获权才切换」。
       打开**已有草稿**时，发件身份必须停在草稿所在的箱 —— **即使这个箱没有 send 权**
       （能编辑草稿 ≠ 能代发）。否则下拉默认落到个人箱，只改一下正文再保存，
       `wire()` 就会带着个人箱的 mailbox 把草稿悄悄搬走（打开即迁箱）。 */
    const composeHome=editing ? (editing.mailboxId||'') : (m.mailboxId||defaultBox?.id||'');
    const draftBox = editing ? (mailboxes || []).find(box => box.id === editing.mailboxId) : null;
    const composeIdentities = (() => {
      if (showExamples) return accounts.map(a => ({id: a.addr, email: a.addr, use: a.use}));
      const list = sendableIdentities();
      /* 草稿的**家箱**（editing.mailboxId）必须出现在身份里 —— 哪怕身份目录里查不到它
         （无权看目录/隔离箱）也要占一格「草稿所在邮箱」。BASE967-18 / UI067：
         查不到就默认退回登录人个人邮箱，预览 From 跟 worker 实际 From（按草稿
         mailbox_id 发）对不上，还会把草稿顺手存去个人箱。 */
      const home = composeHome;
      if (home && !list.some(x => x.id === home)) {
        const known = (mailboxes || []).find(box => box.id === home);
        return [{id: home, email: known?.email || home,
                 display_name: known?.display_name || '', no_send: true}, ...list];
      }
      if(!home)return [{id:'',email:account.bound?account.email:'',personal_draft:true},...list];
      return list;
    })();
    const homeEntry = editing?.mailboxId ? composeIdentities.find(x => x.id === editing.mailboxId) : null;
    const defaultFromEmail = homeEntry ? homeEntry.email : (m.from?.addr || ME.addr);
    dlg.classList.add('is-composing'); host.classList.add('mail-has-selection');
    dlg.innerHTML = `
      <div class="mail-compose-head">
        <label class="mail-compose-subject"><span class="visually-hidden">主题</span><input id="c-subject" value="${escape(m.subject || '')}" placeholder="邮件主题" autocomplete="off" aria-label="主题"></label>
        <span class="state-chip">${editing ? '草稿' : m.forwardNote ? '转发草稿' : '新草稿'}</span>
        <div class="mail-compose-actions"><button class="btn btn-ghost" id="c-save" type="button" aria-label="保存草稿">${actionLabel('存草稿','save')}</button><button class="btn btn-pri" id="c-send" aria-label="发送邮件">${actionLabel('发送','send')}</button><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      </div>
      <div class="dlg-body">
        <label class="dlg-field"><span>发件身份</span><select id="c-from" aria-label="用哪个邮箱发出">${composeIdentities
          .map(x => {
            const label = showExamples ? `${x.email}（${x.use}）`
              : x.personal_draft ? (account.bound?`${x.email}（本人邮箱）`:'本人草稿（未绑定邮箱）') : x.no_send ? `${x.email}（草稿所在邮箱 · 无代发权）` : x.email;
            const value = showExamples ? label : x.email;
            const selected = (showExamples ? value===defaultFromEmail : x.id===composeHome) ? ' selected' : '';
            return `<option value="${escape(value)}" data-mailbox="${escape(x.id)}"${selected}>${escape(label)}</option>`;
          }).join('')}</select></label>
        <div class="dlg-field"><span>收件人</span><div id="c-to-chips" class="dlg-chips"></div><input id="c-to" type="hidden" value="${escape((m.to || []).map(fmt).join('；'))}"></div>
        <div class="dlg-field"><span>抄送</span><div id="c-cc-chips" class="dlg-chips"></div><input id="c-cc" type="hidden" value="${escape((m.cc || []).map(fmt).join('；'))}"></div>
        ${m.candidates?.subject ? `<div class="candidate-row" id="subject-candidate"><span class="candidate-chip">AI 建议：${escape(m.candidates.subject)}</span><button class="mail-link" id="use-subject">采用</button><button class="mail-link dim" id="keep-subject">保留原值</button><span class="candidate-note">采用后待保存草稿才生效</span></div>` : ''}
        <div class="dlg-field"><span class="mail-attachment-label">${mailIcon('attach')}附件</span>
          <div id="c-attachments"></div>
          <div id="c-att-optional"></div>
          <div class="att-actions"><button class="btn btn-ghost" id="pick-lib">从文件库选择</button>${m.required ? `<span class="att-required">模板要求 ${m.required} 个附件，当前 <b id="att-now"></b> 个</span>` : ''}</div>
        </div>
        ${m.bodyFormat==='HTML'&&!mailEditorAvailable?`<div class="dlg-field"><span>正文</span>${bodyView(m)}</div>`:''}
        ${mailEditorAvailable?`<div class="dlg-field"><span>正文</span><div id="c-editor-host"></div><p class="picker-note body-capacity-note" id="body-capacity-note" hidden></p></div>`:''}
        ${mailEditorAvailable?'<textarea id="c-body" hidden></textarea>'
          :`<label class="dlg-field"><span>正文</span><textarea id="c-body" rows="8">${escape(m.body || '')}</textarea></label>`}
      </div>
      <div class="dlg-foot"><span class="dirty-note" id="dirty-note" hidden>有未保存修改</span>${!showExamples?'<button class="btn btn-ghost" id="trash-draft"'+(editing?'':' hidden')+(composeCanManageDraft()?'':' disabled title="当前没有草稿所属邮箱的邮件管理权限，不能删除草稿"')+'>删除草稿</button>':''}<button class="btn btn-ghost" id="c-cancel">关闭</button></div>`;
    const q = s => dlg.querySelector(s);
    /* 正文用可编辑区承载表格与合并格（所有写信路径，不只 HTML 草稿）；
       textarea 只作同步落点，存草稿仍读 #c-body。没有编辑器模块时退回纯 textarea。 */
    /* BASE967-17 容量统一：长度按**实际序列化正文**（normalizeMarkup 后进 #c-body
       的那份）计数 —— 就是发给后端的 body；后端 domain.py 的硬上限 100000 不放宽，
       前端只做**预警**（反馈原话：「统一实际序列化正文容量与前端预警，保留安全上限，
       超限时内容可恢复」）。超限时内容不丢 —— 留在编辑器里，删减后可重存
       （回执缺正文不清本地正文见 receipt.body 那条守卫）。 */
    const BODY_LIMIT = 100000;
    const updateBodyCapacity = (html) => {
      const note = q('#body-capacity-note');
      if (!note) return;
      const used = String(html || '').length;
      if (used <= 90000) { note.hidden = true; note.textContent = ''; return; }
      note.hidden = false;
      note.textContent = used > BODY_LIMIT
        ? `⚠ 正文 ${used} 字符，超出上限 ${used - BODY_LIMIT} 字符，保存会被拒；内容仍在编辑器里，删减后可重新保存`
        : `正文已用 ${used}/${BODY_LIMIT} 字符，接近上限；超限后保存会被拒（内容不丢，删减后可重存）`;
    };
    /* BASE967-35 / UI050：同一草稿被重新 openCompose（审核导航）时，
       把原实例的撤回栈带过新实例 —— 用户 req 5「采用不清本人撤回栈」，
       刷新/关闭才清（closeDetail 清 activeBodyEditor/activeComposeKey）。 */
    const composeKey = String((seed && seed.id) || '');
    const carryHistory = (activeBodyEditor && composeKey && composeKey === activeComposeKey
      && typeof activeBodyEditor.getHistoryState === 'function')
      ? activeBodyEditor.getHistoryState() : null;
    let bodyEditor = null;
    if (mailEditorAvailable && q('#c-editor-host')) {
      bodyEditor = globalThis.mailEditor.mountEditor(q('#c-editor-host'), {
        value: m.body || '',
        resources: m.inline || [],
        /* 取图要带**记录归属**，内核据此判权。转发/回复是从原信带图过来的 ——
           那时写信窗还没 id，归属要用**原信**的，否则取不到字节、图停在 cid: 变破图。 */
        resourceOwner: {ref: 'Shangshu Mail Message', ref_name: (m.inlineOwner && m.inlineOwner.ref_name) || m.id || ''},
        onChange: html => {
          if (q('#c-body')) q('#c-body').value = html;
          updateBodyCapacity(html);
          // 出现表格/格式即正文成为 HTML，否则保持原格式（纯文本仍按纯文本存）
          if (m.bodyFormat !== 'HTML' && /<\/?[a-z][^>]*>/i.test(html)) m.bodyFormat = 'HTML';
          markDirty();
        },
        onNotice: message => notify(message),
        onImagesInserted: () => markDirty(),
        /* 双轨撤回回执（BASE967-35）：**非二值** —— 可能「只撤了本人那段、助手那段留着」。
           拒覆盖要说给人听；完整回执派给 D（对话侧要认这个形状，不是全撤/全不撤）。 */
        onUndoResult: receipt => {
          if (!receipt || typeof window === 'undefined') return;
          if (receipt.undo_state === 'rejected_conflict') notify(receipt.reason || '这段撤不了', 'error');
          window.dispatchEvent(new CustomEvent('shangshu:mail-undo', {detail: receipt}));
        },
      });
      if (q('#c-body')) q('#c-body').value = bodyEditor.getHtml();
      updateBodyCapacity(bodyEditor.getHtml());
      if (carryHistory && typeof bodyEditor.setHistoryState === 'function') bodyEditor.setHistoryState(carryHistory);
      activeBodyEditor = bodyEditor; activeComposeKey = composeKey;
      /* 光标落在**引用块上方那个空段落**，不落进引用里。
         只有结构不够 —— 用户一点正文还是会掉进引用块，字就被框住了
         （用户 2026-10-12：「我写的部分右边会有一个竖杠」）。 */
      const ed = bodyEditor.editor;
      const quote = ed.querySelector('[data-mail-quote]');
      const first = ed.firstElementChild;
      if (quote && first && first !== quote && !first.textContent.trim()) {
        const sel = ed.ownerDocument.getSelection?.();
        const range = ed.ownerDocument.createRange?.();
        if (sel && range) {
          range.selectNodeContents(first);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          ed.focus?.();
        }
      }
    }
    /* N3-B 失焦自动保存（用户 2026-10-11：「存草稿不要用一个显性的按钮，只要失焦就保存」）。
       点到别处 = 这一栏输入完了，就地存一次。新建的草稿第一次失焦会建出来，
       之后再失焦是更新同一封 —— 靠 payload.mail 认同一封，不会变成好几封。 */
    let blurSaveTimer = 0;
    const autosaveOnBlur = (event) => {
      if (writing || pendingSave) return;
      if (!dirty) return;
      /* 焦点还在**同一栏里挪**（比如附件栏里从「选版本」挪到「搜索框」）
         —— 这一栏还没输完，不该存。**离开整栏**才存。
         计划 §6 判据原文：「附件区内选择搜索不保存，离开整区仅保存附件」。
         原来这里不管焦点挪到哪都排一次保存，只是被 120ms 防抖挡住、
         测试又只等 10ms 就下结论，所以一直是假绿。 */
      const from = event && event.target, to = event && event.relatedTarget;
      if (from && to && from.closest && to.closest) {
        for (const sel of ['[data-autosave-group]', '.dlg-field', '.file-reference-picker', '.file-picker']) {
          const group = from.closest(sel);
          if (group && group.contains(to)) return;
        }
      }
      clearTimeout(blurSaveTimer);
      blurSaveTimer = setTimeout(() => { void saveDraft(null, null, true, 'blur'); }, 120);
    };
    /* 未保存语义：任何输入改动即置脏；关闭需二次确认，保存后复位（对齐旧版 R02/T05）。 */
    let dirty = false, revision=0, pendingSave=null,activeSaveCompletion=null;
    const markDirty = () => {
      revision++;
      dirty = true; q('#dirty-note').hidden = false;
    };
    const clearDirty = () => { dirty = false; q('#dirty-note').hidden = true; };
    /* N3-D 关闭确认改**弹窗**（用户 2026-10-11：「这个能不能用一个弹窗？你这个还没有做」）。
       以前是按钮原地换字（点一下变成「确认关闭？未保存修改将丢弃」，4 秒后又换回），
       功能对但观感差。现在用公共壳的 ui.modal —— 干净状态直接关，不弹窗。 */
    const askDiscard = onDiscard => {
      /* 走**公共弹窗组件**（tool-workspace 的 ui.dialog）—— 用户 2026-10-12：
         「你的那个保存/退出弹窗没有加 div 和 padding，导致很丑」+「这个弹窗也抽象成公共组件」。
         以前是裸 h3+p 拼在 .mail-dialog 里，一个 padding 都没有，内容贴着边。 */
      ui.dialog({
        title: '还有未保存的修改',
        body: '<p>关掉会丢掉刚才的改动。</p>',
        actions: [
          {label: '继续编辑', onClick: () => ui.closeModal()},
          {label: '放弃修改并关闭', variant: 'pri', onClick: () => { ui.closeModal(); clearDirty(); onDiscard(); }},
        ],
      });
    };
    const closeGuard = () => () => {
      if(writing){notify('正在保存，请等待结果');return;}
      if(pendingSave){notify('保存结果尚未核实，请先确认上次保存','error');return;}
      if (!dirty) { clearDirty(); closeDetail(); return; }
      askDiscard(() => closeDetail());
    };
    canLeave = () => {
      if(writing){notify('正在保存，请等待结果');return false;}
      if(inlineReviewController?.uncertain()){notify('审核结果尚未核实，请在原位置重试确认','error');return false;}
      if(pendingSave){notify('保存结果尚未核实，请先确认上次保存','error');return false;}
      if (!dirty) return true;
      // N3-B 之后不该再叫人「先存草稿」—— 现在是失焦就存。措辞跟着改。
      notify('还有未保存的修改，点到别处即可保存；点「关闭」可放弃。');
      return false;
    };
    for (const id of ['#c-to', '#c-cc', '#c-subject', '#c-body']) q(id).addEventListener('input', markDirty);
    /* 收件人/抄送用公共胶囊组件（chip-input）：一个人一枚胶囊，+ 号加人，× 或退格删人。
       组件只管「一组字符串」的增删展示，收件人格式仍由 parseRecipients 校验 ——
       胶囊值经「；」串回隐藏输入，collect() 与保存语义一行没变。 */
    const mountChips = (hostId, inputId, placeholder, label, hintText) => {
      const hostEl = q(hostId);
      if (!hostEl || !globalThis.mountChipInput) return null;
      const wireInput = q(inputId);
      const initial = String(wireInput?.value || '').split('；').map(s => s.trim()).filter(Boolean);
      /* 「+ 号」看不见 —— 2026-10-20 @browser-use 走查发现：
         收件人栏只有一颗 28px 的小圆钮「+」，页面上**一句看得见的话**都没有，
         告诉人要点它才能加人（组件自带的 title="添加一个人" 得把鼠标悬上去才冒出来，
         等于没有）。所以这里补一句**看得见的**说明：没人时显示在栏里，添了人就收起来，
         把位置让给胶囊。
         「+ 号跟在胶囊右边、点 + 在它左边开填写位」是用户 2026-10-11 定的交互，一个字没动。 */
      const hint = dlg.ownerDocument.createElement('span');
      hint.className = 'chip-hint';
      hint.setAttribute('data-chip-hint', '');
      hint.textContent = hintText;
      const syncHint = values => { hint.hidden = (values || []).length > 0; };
      const editor = globalThis.mountChipInput(hostEl, {
        values: initial,
        placeholder,
        ariaLabel: placeholder,
        onChange: values => {
          if (wireInput) wireInput.value = values.join('；');
          syncHint(values);
          markDirty();
        },
        /* 认不出的地址**要吭声**，不许一声不吭丢掉（用户 2026-10-12：「不合法的给明确提示」）。
           文案跟 collect() 里的 recipientError 同一口径：说清是哪一栏、哪个地址认不出来。 */
        onReject: typed => notify(`${label}有无法识别的地址：${typed}`, 'error'),
      });
      /* 说明排在胶囊组件**后面**（组件内部那颗「+」在它左边），空栏时读作「+ 点「+」加收件人」。 */
      hostEl.appendChild(hint);
      syncHint(initial);
      /* 整栏都是输入区（FIX-24，2026-10-20 @browser-use 走查发现）：
         收件人栏右边伸出去一大片**点不动的空白**（活站量：栏宽 765px，
         可点的「+」+ 说明只占左边 ~130px，剩下 600 多 px 点下去毫无反应）——
         用户看见一整条横线样的空栏，点了没反应只会以为这栏坏了。
         所以栏里**任何空白**都开填写位：跟点那颗「+」一样。
         公共胶囊组件**一个字没动**（它对外只有 `focus()` 这一个开填写位的口子）：
         这里只是在**组件外面**那片空白上补一个入口，组件内部（胶囊、×、填写位、
         那颗「+」）的行为一律照旧 —— 点组件内部不许被当成「点空白」而误伤。 */
      hostEl.addEventListener('click', event => {
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('.chip-input')) return;
        editor.focus();
      });
      return editor;
    };
    const chipEditors={to:mountChips('#c-to-chips', '#c-to', '输入后回车添加，可填多位', '收件人', '点一下加收件人'),cc:mountChips('#c-cc-chips', '#c-cc', '选填，可填多位', '抄送', '点一下加抄送（选填）')};
    /* T05：「已手改签名切身份时**明确保留/替换**，不暗改正文」。
       人选之前正文一个字都不动 —— 换身份就闷着把签名换了，正是「暗改正文」。 */
    q('#c-from').onchange = () => {
      markDirty();
      accountChrome();
      const bodyEl = q('#c-body');
      const body = (bodyEl && bodyEl.value || '').replace(/\s+$/, '');
      if (!body) return;   // 还没写正文，没什么可保的
      const box = mailboxes.find(x => x.id === pickedBox());
      const newSignature=signatureFor(box),newSig=newSignature?.enabled?(newSignature.html||''):'';
      const oldSigHtml = (() => {
        // 换之前那个身份的签名 —— 从下拉的上一个选项反查（onchange 前值已变，
        // 所以这里按「正文里能不能整段找到」来认，认不出就不动手）。
        for (const m of mailboxes) {
          const s = m && m.signature && m.signature.enabled ? (m.signature.html || '') : '';
          if (s && body.includes(s)) return s;
        }
        return '';
      })();
      ui.dialog({
        title: '发件身份换了',
        body: `<p>正文里有原来那个身份的签名。要<strong>保留原文</strong>，还是<strong>换成新身份的签名</strong>？</p>
               <p class="access-hint">在你选之前，正文不会被改动。</p>`,
        actions: [
          {label: '保留原文', onClick: () => ui.closeModal()},
          {label: '换成新身份的签名', variant: 'pri', onClick: () => {
            const template=document.createElement('template');template.innerHTML=body;
            const marked=[...template.content.querySelectorAll('[data-mail-signature]')].filter(node=>!node.closest('[data-mail-quote]'));
            if(marked.length>1||(!marked.length&&!oldSigHtml)){
              // 认不出原来那段（多半是手改过了）—— **不猜、不动正文**，说清楚。
              notify('正文里的签名改过了，认不出原来的段落；没替你动正文，请自己改。', 'error');
              ui.closeModal();
              return;
            }
            let next;
            if(marked.length){if(newSig)marked[0].innerHTML=newSig;else marked[0].remove();next=template.innerHTML;}
            else next=newSig?body.replace(oldSigHtml,newSig):body.replace(oldSigHtml,'');
            const el = q('#c-body');
            if(bodyEditor){void bodyEditor.applyEdit(next,{actor:'user',resources:newSig?(newSignature.resources||[]):[]});}
            else if (el) {
              Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(el, next);
              el.dispatchEvent(new Event('input', {bubbles: true}));
            }
            markDirty();
            ui.closeModal();
            notify(newSig ? '已换成新身份的签名' : '已去掉原来那段签名');
          }},
        ],
      });
    };
    const attachments = m.attachments.map(a => ({...a}));
    /* 转发带来的「原信附件」—— 默认一封都不带，列成可选，点一下才加进这封（固定版本）。
       用户 2026-10-12（C2）：「普通附件显式选择并固定版本」。 */
    const optional = (m.forwardAttachments || []).map(a => ({...a, versionFixed: true}));
    /* 附件的身份：已落库的用 `file`（文件 id），来自文件库引用的用 `lib`。
       只认一个字段会踩空：点「加入」时 `data-pick-att` 渲染成 undefined，
       认领时 `undefined === "undefined"` 对不上 → 点了没反应（实测踩过）。 */
    const attKey = a => String(a?.file ?? a?.lib ?? a?.name ?? '');
    let refreshPicker=null;
    /* 「原信附件（可选）」永远自己渲染到 `#c-att-optional` —— 不占 `#c-attachments`。
       原因：真实产品里 `#c-attachments` 由附件选择器接管（refreshPicker），
       挤在同一个节点里会被选择器刷掉，转发时用户就**看不到可选附件**了。 */
    const drawOptional = () => {
      const canPick = optional.filter(a => !attachments.some(x => attKey(x) === attKey(a)));
      q('#c-att-optional').innerHTML = canPick.length
        ? `<div class="att-choice"><div class="att-title">原信附件（可选，点一下加入；加入后为固定版本）</div>`
          + canPick.map(a => `<div class="att-row"><span class="att-name">${escape(a.name)}</span><span class="att-meta">${size(a.size)}${a.tag ? ` · ${escape(a.tag)}` : ''}</span><button class="mail-link" data-pick-att="${escape(attKey(a))}">加入</button></div>`).join('')
          + `</div>`
        : '';
      q('#c-att-optional').querySelectorAll('[data-pick-att]').forEach(b => b.onclick = () => {
        const hit = optional.find(x => attKey(x) === b.dataset.pickAtt);
        if (hit && !attachments.some(x => attKey(x) === attKey(hit))) { attachments.push({...hit, versionFixed: true}); markDirty(); drawAttachments(); }
      });
    };
    const drawAttachments = () => {
      /* 已选附件：有选择器时归选择器画，没有时自己画 */
      if (refreshPicker) refreshPicker();
      else {
        const picked = attachments.map((a, i) => `<div class="att-row"><span class="att-name">${escape(a.name)}</span><span class="att-meta">${size(a.size)}${a.tag ? ` · ${escape(a.tag)}` : ''}${a.versionFixed ? ' · 已固定版本' : ''}</span><button class="mail-link dim" data-remove="${i}">移除</button></div>`).join('');
        q('#c-attachments').innerHTML = picked || '<div class="att-empty">未添加附件；移除草稿附件不会删除文件库中的文件</div>';
        dlg.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { attachments.splice(Number(b.dataset.remove), 1); drawAttachments(); markDirty(); });
      }
      drawOptional();
      q('#att-now') && (q('#att-now').textContent = attachments.length);
    };
    drawAttachments();
    q('#dlg-close').onclick = closeGuard(); q('#c-cancel').onclick = closeGuard();
    /* N3-B：点到别处就存。正文用 blur；主题/收件人这些隐藏输入靠 focusout 冒泡。 */
    for (const sel of ['#c-editor-host', '#c-body', '#c-subject', '#c-to', '#c-cc', '#c-from']) {
      const el = q(sel);
      if (!el) continue;
      el.addEventListener('blur', autosaveOnBlur);
      el.addEventListener('focusout', autosaveOnBlur);
    }
    if (dlg.addEventListener) dlg.addEventListener('focusout', autosaveOnBlur);
    if (m.candidates?.subject) {
      q('#use-subject').onclick = () => { q('#c-subject').value = m.candidates.subject; q('#subject-candidate').classList.add('adopted'); markDirty(); };
      q('#keep-subject').onclick = () => q('#subject-candidate')?.remove();
    }
    q('#pick-lib').onclick = () => openPicker(picked => { if (!attachments.some(a => a.lib === picked.lib && a.tag === picked.tag)) { attachments.push(picked); markDirty(); } drawAttachments(); });
    /* 收件人/抄送的报错**只在这里拼一份**，collect() 与 readField() 共用。
       用户 2026-10-12：「收件人报错也放进公共提示组件里面去」—— 走 notify（公共提示），
       不再让收件人栏自己渲染 .dlg-error 红字。
       措辞也钉在这一处：它散着写才会像「多个用分号隔开」那样，交互改成胶囊了文案还停在旧输入框。
       用户同日补充：**只留「收件人……」这一句**，不要再拖「一次填一个人 / 点 + 加下一个人」
       那种说明 —— 报错就说报错，说明书另说。报错要走**错误色**（红）。 */
    const recipientError = (label, bad) => (bad && bad.length)
      ? `${label}有无法识别的地址：${bad.join('、')}`
      : '';
    const collect = () => {
      const to = parseRecipients(reviewPending('to')?(baseline.to||[]).join('；'):q('#c-to').value), cc = parseRecipients(reviewPending('cc')?(baseline.cc||[]).join('；'):q('#c-cc').value);
      const bad = [recipientError('收件人', to.bad), recipientError('抄送', cc.bad)].filter(Boolean);
      if (bad.length) { notify(bad.join('；'), 'error'); return null; }
      /* ★ BASE967-24（req 3）：「**预览与 worker 实际 From 一致**」。
         原来 `{...ME, addr}` —— **name 永远是登录人姓名**，共享箱发信时预览显示「张三」，
         实际发出去却是「业务部 <dept@…>」（`delivery.py:52` 用 `binding.display_name`）。
         改成：**name 取所选发件身份那个邮箱的 display_name**；没选到箱才退回 ME.name。 */
      const _fromBox=(()=>{const _id=q('#c-from').selectedOptions?.[0]?.getAttribute('data-mailbox');
        return _id?(mailboxes||[]).find(box=>box.id===_id)||null:null;})();
      const _fromAddr=q('#c-from').value.split('（')[0];
      const _fromName=_fromBox?(_fromBox.display_name||''):ME.name;
      return {from: {name:_fromName, addr:_fromAddr}, to: to.list, cc: cc.list, subject: q('#c-subject').value, body: bodyAsFormat(q('#c-body').value, m.bodyFormat||'Text'), bodyFormat:m.bodyFormat||'Text',attachments};
    };
    const recipient=p=>p.name?`${p.name} <${p.addr}>`:p.addr;
    /* N3-A：保存要带上正文里的受管内联图（原先只传 body，新插的图资源根本送不出去）。
       列表来自编辑器：初始资源 + 本会话新插的，content_id 与正文 cid: 引用一一对应。 */
    /* T05「编辑页选哪个获权身份就用哪个」：草稿要**住**在选中的那个箱里，
       发信时 From 才是那个箱（N5-3 已按 mailbox 发）。不带 mailbox 走老口径。 */
    const pickedBox=()=>{const s=q('#c-from');return s&&s.selectedOptions&&s.selectedOptions[0]?s.selectedOptions[0].getAttribute('data-mailbox'):null;};
    composeSendState=()=>{
      const id=pickedBox(),identity=mailboxes.find(box=>box.id===id),draftBox=mailboxes.find(box=>box.id===editing?.mailboxId);
      if(draftBox?.rights?.edit_draft===false)return {allowed:false,reason:'当前草稿所属邮箱没有编辑权限，不能准备发送'};
      if(identity){
        if(identity.rights?.send!==true)return {allowed:false,reason:'所选发件身份没有代发权限'};
        if(identity.rights?.edit_draft!==true)return {allowed:false,reason:'所选发件身份没有编辑草稿权限'};
        const ready=identity.enabled!==false&&(identity.connection_status==='connected'||(!identity.connection_status&&identity.kind==='personal'&&identity.email===account.email&&canSend()));
        return {allowed:ready,reason:ready?'':'所选发件邮箱尚未连接或已暂停，请先检查邮箱设置'};
      }
      // 兼容未返回目录的本人自然邮箱；显式未知编号不能借此回退到本人权限。
      const own=!id&&account.bound&&q('#c-from').value===account.email;
      return {allowed:Boolean(own&&canSend()),reason:own?'请先到邮箱设置绑定并启用邮箱':'请先选择获授权的发件身份'};
    };
    /* fast 的 wire 用 `bodyEditor.getInlineResourcesForSave?.() ?? bodyEditor.getInlineResources()`，
       ours 这里是同义写法（先判有没有 ForSave，没有再退回 getInlineResources），行为一致。
       ours 另加两样：body 按**本地格式**换算（bodyAsFormat）、带 signature_guard。 */
    const wire=data=>({subject:data.subject,body:bodyAsFormat(data.body,data.bodyFormat),...(data.bodyFormat==='HTML'?{body_format:'HTML'}:{}),to:data.to.map(recipient),cc:(data.cc||[]).map(recipient),...(m.replyToMail?{reply_to_mail:m.replyToMail}:{}),...(pickedBox()?{mailbox:pickedBox()}:{}),...(attachmentReady?{attachments:data.attachments.map(a=>a.file),attachment_labels:data.attachments.map(a=>({file:a.file,label:a.tag||'',name:a.name}))}:{}),...(bodyEditor&&bodyEditor.getInlineResourcesForSave?{inline_resources:bodyEditor.getInlineResourcesForSave()}:(bodyEditor&&bodyEditor.getInlineResources?{inline_resources:bodyEditor.getInlineResources()}:{})),...(m.signatureGuard?{signature_guard:m.signatureGuard}:{}),});
    /* 基线（上次存下去的那一版）的正文形态必须与**当前值**比得上 —— 当前值是编辑器的形态。
       服务器回执里的 `body_format` 未必带（不带时按 Text 算）⇒ 拿回执的格式换算，
       两边形态会不同（HTML vs 纯文本）⇒「有没有改动」永远判成有，
       草稿卡在「有未保存修改」发不出去（实测：判据 mail-save-send-boundary 的 G 条）。
       基线一律按**本地格式**换算 —— 本地格式就是我们这次发出去的格式。 */
    const baselineOf=saved=>wire({...saved,bodyFormat:m.bodyFormat||saved.bodyFormat});
    const formalWire=saved=>({...baselineOf(saved),mailbox:saved.mailboxId||currentBox?.id||'',inline_resources:saved.inline||[],...(attachmentReady?{attachments:(saved.attachments||[]).map(a=>a.file),attachment_labels:(saved.attachments||[]).map(a=>({file:a.file,label:a.tag||'',name:a.name}))}:{})});
    let baseline=review?formalWire(formal||{subject:'',body:'',bodyFormat:'Text',to:[],cc:[],attachments:[],inline:[],mailboxId:currentBox?.id||''}):wire({...m,cc:m.cc||[]});
    const reviewPending=field=>Boolean(review?.units.some(unit=>unit.unit_id===field&&unit.status==='pending'));
    function onlyFormalPendingValues(payload){
      if(!review)return payload;
      const clean={...payload},groups={subject:['subject'],body:['body','body_format','inline_resources'],to:['to'],cc:['cc'],attachments:['attachments','attachment_labels'],mailbox:['mailbox']};
      for(const field of Object.keys(groups))if(reviewPending(field))for(const key of groups[field]){if(Object.hasOwn(baseline,key))clean[key]=baseline[key];else delete clean[key];}
      return clean;
    }
    const queue=new Map(),fieldNames={to:'收件人',cc:'抄送',subject:'主题',body:'正文',attachments:'附件'};
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    function readField(field,validate=true){
      if(field==='attachments')return {attachments:attachments.map(a=>a.file),attachment_labels:attachments.map(a=>({file:a.file,label:a.tag||'',name:a.name}))};
      if(field==='to'||field==='cc'){
        const parsed=parseRecipients(q('#c-'+field).value);
        // 报错走公共提示组件，不再写 #e-to/#e-cc（那两个元素已随旧交互删掉）。
        // 文案复用 recipientError，和 collect() 那条一模一样 —— 只许有一份。
        if(validate&&parsed.bad.length)notify(recipientError(fieldNames[field],parsed.bad),'error');
        return parsed.bad.length?null:{[field]:parsed.list.map(recipient)};
      }
      if(field==='body')return {[field]:bodyAsFormat(q('#c-body').value, m.bodyFormat||'Text')};
      return {[field]:q('#c-'+field).value};
    }
    function differs(value){return !value||Object.keys(value).some(key=>!equal(value[key],baseline[key]));}
    function syncDirty(){
      dirty=Object.keys(fieldNames).some(field=>(field!=='attachments'||attachmentReady)&&!reviewPending(field)&&differs(readField(field,false)))||Boolean(inlineReviewController?.hasEdits());
      q('#dirty-note').hidden=!dirty;
    }
    function fieldStatus(field,text,failed=false){
      const node=q('[data-field-status="'+field+'"]');if(node){node.textContent=text;node.classList.toggle('is-error',failed);}
    }
    /* `via` = 这次保存**是谁触发的**：button（点了「存草稿」）/ shortcut（⌘S）/
       blur（失焦自动保存）/ send（发送前先存）/ field（离开字段自动存）。
       只有**人明确按了保存**才弹提示 —— 失焦自动保存每敲几个字弹一次就是噪音。 */
    async function saveDraft(field=null,value=null,keepOpen=false,via='auto'){
      if(writing)return;
      if(review&&inlineReviewController?.uncertain()){notify('审核结果尚未核实，请先在原项重试确认','info');return;}
      if(reviewPending(field)){fieldStatus(field,'建议尚未确认：单击采用，双击修改');return;}
      if(review&&!editing){notify('先确认一项建议后才创建草稿；其余建议不会提前保存','info');return;}
      if(field&&pendingSave){fieldStatus(field,'上次保存待核实，本项尚未保存',true);return;}
      if(field&&!differs(value)){fieldStatus(field,'');return;}
      const data = pendingSave||field ? null : collect(); if (!pendingSave&&!field&&!data) return;
      if(field){
        const payload=onlyFormalPendingValues({...baseline,...value});
        if(!editing&&!payload.to.length&&!payload.cc.length&&!payload.subject.trim()&&!payload.body.trim()&&!payload.attachments?.length)return;
        pendingSave={revision,field,payload:{...payload,...(editing?{mail:editing.id,expected_version:editing.version}:{})}};
      }
      if (!pendingSave&&!data.to.length && !data.cc.length && !data.subject.trim() && !data.body.trim()&&!data.attachments.length) { notify('空草稿不保存','error'); return; }
      if(!showExamples){
        // 请求结果未知时重放原快照，先找回记录 ID，不能用后来输入再创建一封。
        pendingSave ||= {revision,payload:{...onlyFormalPendingValues(wire(data)),...(editing?{mail:editing.id,expected_version:editing.version}:{})}};
        const submitted=pendingSave.revision,payload=pendingSave.payload,scoped=pendingSave.field;
        let completeSave,saveSucceeded=false;const saveCompletion=new Promise(resolve=>{completeSave=resolve;});activeSaveCompletion=saveCompletion;
        writing=true;if(q('#c-save'))q('#c-save').disabled=true;
        if(scoped)fieldStatus(scoped,'正在保存…');
        try{
          const receipt=await action('mail.save_draft',payload,r=>Boolean(r.name)&&Number.isInteger(r.record_version)&&(!payload.mail||r.name===payload.mail)&&(!payload.attachments||Array.isArray(r.attachments)&&r.attachment_bindings&&payload.attachments.every(id=>r.attachments.some(a=>a.file===r.attachment_bindings[id]))));
          const saved=mapReal(receipt);
          if(ui.disposed)return;
          // The first personal save returns its actual home identity; keep it selectable for an explicit switch back.
          const personalOption=q('#c-from')?.selectedOptions?.[0];
          if(!payload.mailbox&&saved.mailboxId&&personalOption?.getAttribute('data-mailbox')==='')personalOption.setAttribute('data-mailbox',saved.mailboxId);
          for(const a of attachments){const bound=receipt.attachment_bindings?.[a.file];if(bound){a.file=bound;a.reference={doctype:'Shangshu Mail Message',name:saved.id,file:bound,label:a.tag};}}
          const unique=new Set();for(let i=0;i<attachments.length;){if(unique.has(attachments[i].file))attachments.splice(i,1);else{unique.add(attachments[i].file);i++;}}
          drawAttachments();
          for(const entry of queue.values())if(entry.attachments){entry.attachments=entry.attachments.map(id=>receipt.attachment_bindings?.[id]||id);entry.attachment_labels=entry.attachment_labels.map(a=>({...a,file:receipt.attachment_bindings?.[a.file]||a.file}));}
          baseline=review?formalWire(saved):baselineOf(saved);editing=saved;writing=false;pendingSave=null;businessContext(editing,'mail-compose');
          /* 回执里的正文是服务端净化后的**规范化形态**（service.py:99 的 bleach
             CSSSanitizer 会给 style 属性补结尾分号），和本地发出去的差一个字符。
             存完把本地落点认成库里的形态，才跟 baseline 对得上 —— 否则逐字比永远
             判「有新修改」：点关闭总弹确认、离开页面总弹「要离开吗」（2026-10-11
             在 3830 正式页实测量出，正文差在 border-collapse:collapse 后那个分号）。
             两个前提都得成立才认，不许盖掉用户刚敲的字：
             ① 本次提交的确实是正文（单字段只存别的栏时不碰正文）；
             ② 提交之后没有新输入（有新输入时本地那份就是更新的，认了会丢）。 */
          /* 认的是**回执里真的带正文**（receipt.body），不是 mapReal 之后的 saved.body ——
             mapReal 缺字段会默认成 ''，typeof '' === 'string' 恒真，守卫形同虚设：
             回执一旦不带 body，这里就把本地正文清空（BASE967-47 家族的数据丢失口）。 */
          if(!reviewPending('body')&&revision===submitted&&(!scoped||scoped==='body')&&q('#c-body')&&typeof receipt.body==='string')q('#c-body').value=receipt.body;
          if(scoped||keepOpen){
            syncDirty();q('#trash-draft').hidden=false;
            q('.mail-compose-head>.state-chip').textContent='草稿';
            if(scoped)fieldStatus(scoped,differs(readField(scoped,false))?'已保存提交值；仍有新修改':'已保存');
            updateSavedMailInList(saved);selected=saved.id;render();
            /* 人**明确按了保存**才给说法（右下角公共 toast）；
               失焦自动保存不提示 —— 每敲几个字弹一次就是噪音。
               当前列表看得见草稿时（全部/草稿箱）直接说保存了；
               看不见（正看着收件箱/已发送/回收站）就把**在哪**说清楚，
               免得人以为没存上。 */
            if(!scoped&&(via==='button'||via==='shortcut')){
              const showsDrafts=box==='all'||box==='draft';
              notify(showsDrafts?'草稿已保存':'草稿已保存 · 在草稿箱里');
            }
          }
          else if(revision===submitted){clearDirty();box='draft';page=1;closeDetail();await load();notify('草稿已保存');}
          else{q('#trash-draft').hidden=false;notify('提交的内容已保存，新输入尚未保存');}
          saveSucceeded=true;return saved;
        }catch(error){for(const queued of queue.keys())fieldStatus(queued,'前一项未保存，本项尚未保存',true);queue.clear();if(error.uncertain&&pendingSave)pendingSave.uncertain=true;if(!pendingSave?.uncertain)pendingSave=null;if(scoped)fieldStatus(scoped,'未保存：'+error.message,true);notify(pendingSave?'保存结果待确认：请重试确认上次请求，当前输入已保留。'+error.message:error.message,'error');}
        /* 排队补发和 accountChrome() 不许再包在「存草稿」按钮的判断里 ——
           N3-B 把那个按钮删掉后 q('#c-save') 恒为 null，整块成了死代码：
           上一次保存没回来时改的下一栏永远补发不出去，状态一直亮「有未保存修改」。
           （2026-10-11 由测试报出；改前表现见 C-交付.md 第六批。）
           按钮本身没了就不用碰它，但补发和 chrome 刷新照做。 */
        finally{writing=false;if(activeSaveCompletion===saveCompletion)activeSaveCompletion=null;completeSave(saveSucceeded);if(!ui.disposed){if(q('#c-save')){q('#c-save').disabled=false;q('#c-save').innerHTML=actionLabel(pendingSave?'确认上次保存':'存草稿','save');}accountChrome();if(!pendingSave&&queue.size){const [next,nextValue]=queue.entries().next().value;queue.delete(next);void saveDraft(next,nextValue);}else inlineReviewController?.drainQueue();}}
        return;
      }
      const now = new Date().toLocaleString('sv-SE').slice(0, 16);
      if (editing) Object.assign(editing, data, {date: now});
      else mails.push({id: uid(), box: 'draft', deletedFrom: 'draft', ...data, date: now});
      clearDirty(); box = 'draft'; closeDetail(); notify('已保存到草稿箱（示例：仅当前页面有效）');
    }
    q('#c-save').onclick=()=>{if(!writing)void saveDraft(null,null,true,'button');};
    /** 等在途与排队的保存**全部落地**。
     *  FIX-51（用户 2026-10-20 实测：带附件的转发，界面「发送」间歇性 417
     *  「邮件已更新，请重新核对当前版本后发送」，信没发出去，3 次错 2 次）：
     *  保存一落地 `record_version` 就 +1，而发送用的是**打开核对框那一刻**的版本快照
     *  ⇒ 落后一格 ⇒ 被后端版本闸挡下。
     *  ⚠️ 触发时机很特别：**打开核对框本身**会让附件区失焦 → 触发一次自动保存
     *  ⇒ 那次保存是在核对框**开着**的时候落地的 ⇒ 只在「发之前等」是不够的，
     *  发送那一刻也得用**落地后**的版本（见 `openSendConfirm` 的 `versionOf`）。
     */
    async function settleDraftSaves(){
      /* 等「有保存正在飞」落地 —— 用 `activeSaveCompletion`（保存的完成 promise）判，
         **不看 `writing`**：发送路径里 `writing` 会被**发送自己**置 true，
         等它就**自锁**（发送永远等自己结束）⇒ 会把「发送按钮 1 秒内恢复可用」那条判据打红。
         队列补发会换上**新的** `activeSaveCompletion` ⇒ 循环继续等那一份。 */
      for(let i=0;i<40;i++){
        const completion=activeSaveCompletion;
        if(!completion)return true;
        await Promise.race([Promise.resolve(completion).then(()=>{}).catch(()=>{}),new Promise(r=>setTimeout(r,25))]);
      }
      return !activeSaveCompletion;
    }
    /* 可见存草稿、Ctrl/⌘S 与失焦自动保存复用同一链。 */
    $('#detail').onkeydown=event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){
        event.preventDefault();if(!writing)void saveDraft(null,null,true,'shortcut');
      }
    };
    q('#c-send').onclick = async () => {
      if(review?.remaining){notify('先确认或放弃剩余建议，再核对发送','info');return;}
      if(writing||pendingSave){notify('请先等待保存完成或核实上次保存，再核对发送','error');return;}
      const data = collect(); if (!data) return;
      if (!data.to.length) { notify('发送前请至少填写一位收件人', 'error'); return; }
      if(showExamples){openSendConfirm(data, m, editing, attachments, dirty, clearDirty);return;}
      if(!data.subject.trim()){notify('发送前请填写邮件主题','error');q('#c-subject').readOnly=false;q('#c-subject').focus();return;}
      const sender=composeSendState();if(!sender.allowed){notify(sender.reason,'error');return;}
      if(dirty||!editing){const saved=await saveDraft(null,null,true,'send');if(!saved||ui.disposed)return;if(dirty){notify('还有新修改，请再次核对后发送','error');return;}}
      const savedSender=composeSendState();if(!savedSender.allowed){notify(savedSender.reason,'error');return;}
      openSendConfirm(collect(),m,editing,attachments,false,clearDirty,async()=>{await settleDraftSaves();return editing?editing.version:undefined;});
    };
    if(!showExamples){
      /* 一个可选身份都没有时，发件身份下拉**不给点** —— 空下拉点开是空界面，
         看着能选、实际选不了。「能不能发」照旧由 `composeSendState` 判。 */
      q('#c-from').disabled=!composeIdentities.length||(composeIdentities.length===1&&composeIdentities[0].personal_draft&&!account.bound);accountChrome();
      q('#pick-lib').disabled=true;q('#pick-lib').title='附件服务尚未接入';q('#pick-lib').onclick=null;
      if(!composeSendState().allowed)q('.mail-compose-head').insertAdjacentHTML('afterend',`<div class="mail-connection-note">${escape(composeSendState().reason)}；可以先保存有权编辑的草稿。</div>`);
      if(attachmentReady){
        q('#pick-lib').closest('.att-actions').remove();
        refreshPicker=mountAttachmentPicker(q('#c-attachments'),attachments,()=>{markDirty();drawOptional();},()=>!ui.disposed&&dlg.isConnected);
        drawAttachments(); /* 选择器接管后补一次：把「原信附件（可选）」画出来 */
      }
      q('#c-subject').maxLength=500;q('#c-body').maxLength=100000;
      for(const field of Object.keys(fieldNames)){
        if(field==='attachments'&&!attachmentReady)continue;
        const control=q(field==='attachments'?'#c-attachments':'#c-'+field),block=field==='attachments'?control:control.parentElement;
        const status=document.createElement('span');status.className='mail-field-status';status.dataset.fieldStatus=field;status.setAttribute('role','status');block.append(status);
        block.addEventListener('focusout',event=>{
          if(event.relatedTarget&&block.contains(event.relatedTarget))return;
          // 存草稿/发送会保存完整快照，不抢先发起失焦请求阻断同一次点击。
          if(event.relatedTarget?.closest('#c-save,#c-send'))return;
          if(ui.disposed||!control.isConnected)return;
          const value=readField(field);if(!value){fieldStatus(field,'');return;}
          if(reviewPending(field)){fieldStatus(field,'建议尚未确认：单击采用，双击修改');return;}
          if(pendingSave&&!writing){fieldStatus(field,'上次保存待核实，本项尚未保存',true);return;}
          if(writing){queue.set(field,value);fieldStatus(field,'等待前一项保存…');return;}
          void saveDraft(field,value);
        });
        if(field==='subject'){
          control.title='离开字段自动保存；也可点击存草稿';
          control.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();control.blur();}});
        }
      }
      q('#trash-draft').onclick=async()=>{
        if(!composeCanManageDraft()){notify('当前没有草稿所属邮箱的邮件管理权限，不能删除草稿','error');return;}
        if(writing||pendingSave||!editing)return;
        const btn=q('#trash-draft');
        if(!btn.dataset.confirm){btn.dataset.confirm='1';btn.textContent='确认移入回收站？未保存修改将放弃';return;}
        writing=true;btn.disabled=true;
        try{await action('mail.recycle',{mail:editing.id,expected_version:editing.version});writing=false;if(ui.disposed)return;clearDirty();closeDetail();await load();notify('草稿已移入回收站，可恢复');}
        catch(error){notify(error.message);}finally{writing=false;if(btn.isConnected)btn.disabled=!composeCanManageDraft();}
      };
    }
    if(review){
      const controller=new AbortController(),signal=controller.signal,unitHosts=new Map(),initial=new Map(),editingUnits=new Set(),originalControls=new Map();
      const clickTimers=new Map(),reviewQueue=new Set();let pendingAccept=null,reviewBusy=false,disposed=false;
      const source=reviewSource(review),status=document.createElement('span');
      status.className='mail-inline-review-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      // 只有局部执行状态留在字段旁；总体确认/放弃由原聊天卡负责。
      const statusHost=q('#c-editor-host')?.closest('.dlg-field')||q('#c-subject')?.closest('.mail-compose-subject');
      statusHost?.append(status);
      const alive=()=>!disposed&&!ui.disposed&&dlg.isConnected&&inlineReviewController===api;
      const dependency=review.units.find(unit=>unit.requires_with_content&&unit.dependency_note);if(dependency)status.textContent=dependency.dependency_note;
      const findUnit=id=>review.units.find(unit=>unit.unit_id===id),remaining=()=>review.units.filter(unit=>unit.status==='pending').length;
      const rawValue=id=>id==='mailbox'?pickedBox():readField(id)?.[id];
      const formalEdits=()=>Object.keys(fieldNames).filter(field=>(field!=='attachments'||attachmentReady)&&!reviewPending(field)&&differs(readField(field,false)));
      function restoreControls(block){for(const node of block.querySelectorAll('input,textarea,select,button,[contenteditable]')){const old=originalControls.get(node);if(!old)continue;if('disabled'in node)node.disabled=old.disabled;if('readOnly'in node)node.readOnly=old.readOnly;node.tabIndex=old.tabIndex;if(old.contenteditable!==null)node.setAttribute('contenteditable',old.contenteditable);}}
      function interactivity(unit,block){
        const pending=unit.status==='pending',edit=review.can_accept!==false&&editingUnits.has(unit.unit_id);
        restoreControls(block);
        /* 编辑器工具栏（撤回/重做 + x/3）不按挂载快照恢复 —— 那份快照里撤回按钮
           还是「无可撤回」的禁用态，恢复它会把后来真实存在的历史重新冻住
           （BASE967-35：采用助手建议后撤回栈还在，按钮却被禁用）。以编辑器为准刷一遍；
           下面 pending 分支仍会按审核冻结把它禁用。 */
        if(bodyEditor&&block.contains(bodyEditor.editor))bodyEditor.refreshToolbar?.();
        if(pending&&!edit)for(const node of block.querySelectorAll('input,textarea,select,button,[contenteditable]')){
          if(node.matches('[data-review-accept-unit]'))continue;
          if('readOnly'in node)node.readOnly=true;if(node.matches('button,select,input[type=checkbox]'))node.disabled=true;
          if(node.hasAttribute('contenteditable'))node.setAttribute('contenteditable','false');node.tabIndex=-1;
        }
        if(pending&&edit&&unit.unit_id==='mailbox')q('#c-from').disabled=false;
        block.classList.toggle('is-pending',pending);block.classList.toggle('is-editing',pending&&edit);block.classList.toggle('is-code',source.kind==='code');block.classList.toggle('is-unknown',source.kind==='unknown');
        block.setAttribute('aria-disabled',String(pending&&review.can_accept===false));
        block.tabIndex=pending?0:-1;block.title=pending?`${unit.label}建议：单击采用，双击修改；Enter采用，F2修改`:'';
        if(pending&&review.can_accept===false){block.title=review.accept_unavailable_reason||'当前建议不可确认';status.textContent=block.title;}
        const button=block.querySelector('[data-review-accept-unit]');if(button){button.hidden=!pending||!edit;button.disabled=reviewBusy||review.can_accept===false;}
      }
      function paint(){for(const unit of review.units){const block=unitHosts.get(unit.unit_id);if(block)interactivity(unit,block);}q('#c-save').title=remaining()?'仅保存已确认内容；彩色建议需单独采用':'保存草稿';accountChrome();}
      function focusUnit(id){const block=unitHosts.get(id)||unitHosts.values().next().value;block?.scrollIntoView?.({block:'nearest'});block?.focus();}
      function beginEdit(id){if(review.can_accept===false){status.textContent=review.accept_unavailable_reason||'当前建议不可确认';return;}clearTimeout(clickTimers.get(id));clickTimers.delete(id);if(reviewBusy||pendingAccept){notify('先核实上次确认，再修改候选','info');return;}const unit=findUnit(id),block=unitHosts.get(id);if(!unit||unit.status!=='pending'||!block)return;editingUnits.add(id);interactivity(unit,block);if(id==='to'||id==='cc')chipEditors[id]?.focus();else(id==='body'?bodyEditor?.editor:id==='mailbox'?q('#c-from'):q('#c-'+id))?.focus();}
      const savedValue=(saved,unit)=>unit.unit_id==='mailbox'?saved.mailboxId:unit.unit_id==='attachments'?saved.attachments.map(a=>a.file):unit.unit_id==='to'||unit.unit_id==='cc'?saved[unit.unit_id].map(recipient):saved[unit.unit_id];
      const matchesSaved=(saved,unit)=>unit.unit_id==='body'||unit.unit_id==='subject'?reviewFieldMatches(unit.unit_id,savedValue(saved,unit),unit.current_value,{body_format:unit.kind==='html'?'HTML':'Text',body:unit.current_value}):equal(savedValue(saved,unit),unit.current_value);
      async function readFormal(next,accepted,expectedValues=null,bindings={}){
        if(!next.target.mail)throw Object.assign(Error('确认后没有正式草稿编号'),{uncertain:true});
        const response=await request('/api/platform/services/mail.detail/invoke',{payload:{mail:next.target.mail}}),raw=(response.result||response).mail;
        if(raw?.name!==next.target.mail||raw.status!=='Draft')throw Object.assign(Error('正式草稿读回不完整'),{uncertain:true});
        const saved=mapReal(raw);
        for(const id of accepted){const unit=next.units.find(unit=>unit.unit_id===id);let wanted=expectedValues?.[id];if(id==='attachments'&&Array.isArray(wanted))wanted=wanted.map(file=>bindings[file]||file);if(id==='to'||id==='cc')if(Array.isArray(wanted))wanted=parseRecipients(wanted.join('；')).list.map(recipient);
          if(!unit||unit.status!=='accepted'||!matchesSaved(saved,unit)||(id==='body'&&unit.kind==='html'&&saved.bodyFormat!=='HTML')||(expectedValues&&Object.hasOwn(expectedValues,id)&&!matchesSaved(saved,{...unit,current_value:wanted})))throw Object.assign(Error('正式草稿的'+(unit?.label||id)+'与本次确认值不一致'),{uncertain:true});}
        return saved;
      }
      function applyReadback(next,saved){
        review=next;editing=saved;baseline=formalWire(saved);selected=saved.id;businessContext(saved,'mail-compose');
        for(const unit of next.units.filter(unit=>unit.status==='accepted')){
          const id=unit.unit_id;
          if(id==='body'){q('#c-body').value=saved.body;m.bodyFormat=saved.bodyFormat;}
          else if(id==='subject')q('#c-subject').value=saved.subject;
          else if(id==='to'||id==='cc')q('#c-'+id).value=saved[id].map(recipient).join('；');
          else if(id==='attachments'){attachments.splice(0,attachments.length,...saved.attachments.map(a=>({...a})));drawAttachments();}
          editingUnits.delete(id);initial.set(id,JSON.stringify(rawValue(id)));
          queue.delete(id);fieldStatus(id,'已确认并保存');
        }
        q('#trash-draft').hidden=false;q('.mail-compose-head>.state-chip').textContent='草稿';updateSavedMailInList(saved);paint();syncDirty();render();
      }
      function drainQueue(){if(!alive()||reviewBusy||writing||pendingAccept)return;for(const id of reviewQueue)if(findUnit(id)?.status!=='pending')reviewQueue.delete(id);const id=reviewQueue.values().next().value;if(id){reviewQueue.delete(id);void acceptUnit(id);}}
      const acceptUnit=id=>{if(reviewBusy||writing){reviewQueue.add(id);return null;}return acceptUnits([id]);};
      async function acceptUnits(ids){
        if(review.can_accept===false){status.textContent=review.accept_unavailable_reason||'当前建议不可确认';return null;}
        for(const id of ids){clearTimeout(clickTimers.get(id));clickTimers.delete(id);}if(!alive())return null;
        for(const field of ['to','cc']){const slot=q('#c-'+field+'-chips [data-chip-field]');if(slot?.value.trim()){slot.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));const rest=q('#c-'+field+'-chips [data-chip-field]');if(rest?.value.trim()){notify(fieldNames[field]+'仍有未完成的地址，请核对后再确认','error');return null;}}}
        while(activeSaveCompletion&&!reviewBusy){status.textContent='等待已确认内容保存后，再确认其余建议…';await activeSaveCompletion;if(!alive())return null;}
        if(reviewBusy||writing)return null;
        if(!ids.length||ids.some(id=>findUnit(id)?.status!=='pending'))return null;
        const label=ids.length===1?findUnit(ids[0]).label:'剩余建议';
        if(pendingAccept&&!equal(pendingAccept.body.units,ids)){notify('上次确认结果待核实，请先在原项重试','info');return null;}
        if(pendingSave){notify('先核实普通草稿保存，再确认建议','info');return;}
        if(!pendingAccept&&editing&&formalEdits().length){await saveDraft(null,null,true);const fields=formalEdits();if(!alive()||fields.length||pendingSave||writing){status.textContent='已确认字段仍有未保存修改：'+fields.map(field=>fieldNames[field]).join('、')+'；先保存后再确认其余建议。';return null;}}
        if(!pendingAccept){const edited={},expected={};for(const id of ids){const value=rawValue(id);if(value===undefined||value===null){notify('请先核对'+findUnit(id).label+'内容','error');return null;}if(JSON.stringify(value)!==initial.get(id))edited[id]=value;expected[id]=JSON.parse(JSON.stringify(Object.hasOwn(edited,id)?value:findUnit(id).value));}pendingAccept={expected,body:{op_id:uid(),expected_review_revision:review.review_revision,units:ids,...(Object.keys(edited).length?{edited_value:edited}:{})}};}
        reviewBusy=true;writing=true;dlg.inert=true;status.textContent='正在确认'+label+'并核对正式草稿…';paint();
        try{
          const response=await request('/api/platform/action-proposals/'+encodeURIComponent(review.id)+'/accept',pendingAccept.body),receipt=reviewDescriptor(response,review.id);
          if(!receipt||!Array.isArray(response.accepted_units)||!ids.every(id=>response.accepted_units.includes(id)))throw Object.assign(Error('未取得同一候选的分项确认回执'),{uncertain:true});
          const next=reviewDescriptor(await request('/api/platform/action-proposals/'+encodeURIComponent(review.id)+'/review'),review.id),saved=await readFormal(next,ids,pendingAccept.expected,response.result?.attachment_bindings||{});
          if(!alive())return null;pendingAccept=null;applyReadback(next,saved);status.textContent=next.remaining?'已确认'+label+'；其余建议仍待确认。':'全部建议已确认，草稿已保存，未发送。';
          window.dispatchEvent(new CustomEvent('shangshu:review-progress',{detail:{proposal_id:review.id,descriptor:next,origin:'mail'}}));
          if(!next.remaining&&next.status==='confirmed')window.dispatchEvent(new CustomEvent('shangshu:review-resolved',{detail:{proposal_id:review.id,status:'confirmed',origin:'mail'}}));void refreshReviewCue();
          return next;
        }catch(error){if(alive()){if(error.uncertain===false)pendingAccept=null;status.textContent='本项未确认或结果待核实，输入已保留；请在原项重试。 '+error.message;notify(status.textContent,'error');}return null;}
        finally{reviewBusy=false;writing=false;dlg.inert=false;if(alive()){paint();drainQueue();}}
      }
      for(const unit of review.units){
        const id=unit.unit_id,control=q(id==='body'?'#c-editor-host':id==='attachments'?'#c-attachments':id==='mailbox'?'#c-from':'#c-'+id),block=id==='subject'?control?.closest('.mail-compose-subject'):control?.closest('.dlg-field');if(!block)continue;
        block.dataset.mailReviewUnit=id;unitHosts.set(id,block);initial.set(id,JSON.stringify(rawValue(id)));
        for(const node of block.querySelectorAll('input,textarea,select,button,[contenteditable]'))originalControls.set(node,{disabled:node.disabled,readOnly:node.readOnly,tabIndex:node.tabIndex,contenteditable:node.getAttribute('contenteditable')});
        const accept=document.createElement('button');accept.type='button';accept.className='mail-review-unit-accept';accept.dataset.reviewAcceptUnit=id;accept.setAttribute('aria-label','确认'+unit.label);accept.title='确认'+unit.label+'并保存';accept.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span>确认</span>';accept.hidden=true;block.append(accept);
        accept.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void acceptUnit(id);},{signal});
        block.addEventListener('click',event=>{if(findUnit(id)?.status!=='pending'||event.target.closest('[data-review-accept-unit]')||editingUnits.has(id))return;event.preventDefault();event.stopPropagation();clearTimeout(clickTimers.get(id));clickTimers.delete(id);if(event.detail<2)clickTimers.set(id,setTimeout(()=>{clickTimers.delete(id);void acceptUnit(id);},550));},{capture:true,signal});
        block.addEventListener('dblclick',event=>{if(findUnit(id)?.status!=='pending')return;event.preventDefault();event.stopPropagation();beginEdit(id);},{capture:true,signal});
        block.addEventListener('keydown',event=>{if(findUnit(id)?.status!=='pending')return;if(event.key==='F2'){event.preventDefault();event.stopPropagation();beginEdit(id);}else if(event.key==='Enter'&&(!editingUnits.has(id)||id==='subject'||event.ctrlKey||event.metaKey)){event.preventDefault();event.stopPropagation();void acceptUnit(id);}}, {capture:true,signal});
      }
      async function refreshInline(){
        if(!alive()||reviewBusy||writing)return;
        if(api.hasEdits()||dirty){status.textContent='正式记录或建议已由其他入口处理，本页人工改稿仍保留；请先核实原候选。';return;}
        try{const next=reviewDescriptor(await request('/api/platform/action-proposals/'+encodeURIComponent(review.id)+'/review'),review.id);if(!alive()||!next)return;
          if(next.status==='rejected'){const id=next.target.mail;inlineReviewController=null;api.destroy();if(id)await open(id);else closeDetail();return;}
          if(next.target.mail){const saved=await readFormal(next,next.units.filter(unit=>unit.status==='accepted').map(unit=>unit.unit_id));if(alive())applyReadback(next,saved);}
        }catch(error){if(alive())status.textContent='审核结果尚未核实，输入已保留。 '+error.message;}
      }
      const api={id:String(review.id),module:'mail',remaining,drainQueue,rejectRemaining,refresh:refreshInline,acceptRemaining:()=>{for(const timer of clickTimers.values())clearTimeout(timer);clickTimers.clear();reviewQueue.clear();return acceptUnits(review.units.filter(unit=>unit.status==='pending').map(unit=>unit.unit_id));},uncertain:()=>Boolean(pendingAccept),hasEdits:()=>review.units.some(unit=>unit.status==='pending'&&initial.get(unit.unit_id)!==JSON.stringify(rawValue(unit.unit_id))),focus:focusUnit,destroy(){disposed=true;for(const timer of clickTimers.values())clearTimeout(timer);clickTimers.clear();reviewQueue.clear();controller.abort();status.remove();if(window.shangshuMailInlineReview===api)delete window.shangshuMailInlineReview;if(window.shangshuInlineReviews?.get(api.id)===api)window.shangshuInlineReviews.delete(api.id);}};inlineReviewController=api;window.shangshuMailInlineReview=api;window.shangshuInlineReviews||=new Map();window.shangshuInlineReviews.set(api.id,api);
      dlg.addEventListener('beforeinput',event=>{if(pendingAccept&&!reviewBusy){event.preventDefault();event.stopImmediatePropagation();notify('上次确认结果待核实，输入已保留；先在原项重试','info');}},{capture:true,signal});
      dlg.addEventListener('paste',event=>{if(pendingAccept&&!reviewBusy){event.preventDefault();event.stopImmediatePropagation();}},{capture:true,signal});
      dlg.addEventListener('click',event=>{if(!pendingAccept||reviewBusy)return;const unit=event.target.closest('[data-mail-review-unit].is-pending');if(event.target.closest('#dlg-close,#c-cancel'))return;if(unit&&event.target.closest('[data-review-accept-unit]'))return;event.preventDefault();event.stopImmediatePropagation();if(unit)void acceptUnit(unit.dataset.mailReviewUnit);else notify('先核实原项确认，再继续修改其他内容','info');},{capture:true,signal});
      dlg.addEventListener('keydown',event=>{if(pendingAccept&&!reviewBusy&&!['Tab','Escape'].includes(event.key)&&!(event.key==='Enter'&&event.target.closest('[data-mail-review-unit].is-pending'))){event.preventDefault();event.stopImmediatePropagation();notify('上次确认结果待核实，输入已保留；先在原项重试','info');}},{capture:true,signal});
      async function rejectRemaining(){
        if(reviewBusy||pendingAccept||(writing&&!activeSaveCompletion))throw Error('先核实当前保存或确认结果，再放弃剩余建议');
        clearTimeout(blurSaveTimer);blurSaveTimer=0;
        reviewBusy=true;paint();
        try{
          // 点击前的失焦可能已经启动普通保存；保留本次拒绝意图，等待其结果。
          while(activeSaveCompletion){status.textContent='等待已确认内容保存后，放弃剩余建议…';const succeeded=await activeSaveCompletion;if(!alive())throw Error('审核页面已关闭，未继续放弃');if(!succeeded){status.textContent='已确认内容保存未成功或结果待核实，输入和剩余建议已保留。';throw Error(status.textContent);}}
          if(pendingSave||writing){status.textContent='先核实已确认内容的保存结果，剩余建议仍保留。';throw Error(status.textContent);}
          // 放弃的只是剩余候选，已接受字段后来手改的值仍按普通保存落盘。
          if(editing&&formalEdits().length){await saveDraft(null,null,true);if(!alive()||formalEdits().length||pendingSave||writing){if(alive())status.textContent='已确认内容还有未保存修改，请先保存；剩余建议仍保留。';throw Error(status.textContent);}}
          writing=true;status.textContent='正在放弃剩余建议…';
          const response=await request('/api/platform/action-proposals/'+encodeURIComponent(review.id)+'/resolve',{decision:'rejected'}),receipt=response?.id?response:response?.proposal;
          if(receipt?.id!==review.id||receipt.status!=='rejected')throw Object.assign(Error('放弃建议的回执未核实'),{uncertain:true});
          if(!alive())throw Error('审核页面已关闭，未继续放弃');const id=editing?.id;dirty=false;clearDirty();writing=false;inlineReviewController=null;api.destroy();window.dispatchEvent(new CustomEvent('shangshu:review-resolved',{detail:{proposal_id:review.id,status:'rejected',origin:'mail'}}));if(id)await open(id);else closeDetail();notify('已放弃剩余建议，已保存的内容保留','info');void refreshReviewCue();return {...receipt,remaining_rejected:true,saved_content_preserved:true};
        }catch(error){if(alive()){status.textContent='未能核实放弃结果，当前建议与输入已保留。 '+error.message;notify(status.textContent,'error');}throw error;}finally{reviewBusy=false;if(!activeSaveCompletion)writing=false;if(alive())paint();}
      }
      window.addEventListener('shangshu:review-resolved',async event=>{
        if(event.detail?.proposal_id!==review.id||event.detail?.origin==='mail'||reviewBusy||!alive())return;
        await refreshInline();
      },{signal});
      paint();
      window.dispatchEvent(new CustomEvent('shangshu:review-ready',{detail:{proposal_id:api.id,module:'mail'}}));
    }
    render(); q('#c-to').focus();
  }

  function mountAttachmentPicker(node,attachments,onChange,alive){
    return window.mountFileReferencePicker({ui,node,values:attachments,onChange,alive,preview:previewAttachment,placeholder:'选择附件'});
  }

  function openPicker(onPick) {
    const dlg = openModal(`
      <div class="dlg-head"><span>从文件库选择附件</span><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      <div class="dlg-body">
        <div class="picker-note">示例文件库；普通文件可选不同版本，表格按上传时的表各算一张。</div>
        ${lib.map(f => `<div class="pick-file"><div class="pick-name">${escape(f.name)} <span class="att-meta">${size(f.size)}</span></div>
          ${f.versions.map((v, i) => `<label class="pick-version"><input type="radio" name="pick-version" data-lib="${f.id}" data-vi="${i}" ${f.id === 'L1' && i === 0 ? 'checked' : ''}> ${escape(v.v)}</label>`).join('')}</div>`).join('')}
      </div>
      <div class="dlg-foot"><button class="btn btn-ghost" id="dlg-close2">取消</button><button class="btn btn-pri" id="pick-ok">加入附件</button></div>`);
    const q = s => dlg.querySelector(s);
    q('#dlg-close').onclick = closeModal; q('#dlg-close2').onclick = closeModal;
    q('#pick-ok').onclick = () => {
      const radio = dlg.querySelector('input[name="pick-version"]:checked');
      const f = lib.find(x => x.id === radio.dataset.lib), v = f.versions[Number(radio.dataset.vi)];
      closeModal(); onPick({lib: f.id, name: f.name, size: f.size, tag: v.tag});
    };
  }

  function openSendConfirm(data, seed, editing, attachments, willSaveFirst = false, onSaved = () => {}, versionOf = null) {
    const missing = seed?.required && attachments.length < seed.required;
    const dlg = openModal(`
      <div class="dlg-head"><span>发送前核对</span><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      <div class="dlg-body">
        <dl class="send-list"><dt>发件身份</dt><dd>${escape(data.from.name ? `${data.from.name} <${data.from.addr}>` : data.from.addr)}</dd>
        <dt>收件人</dt><dd class="addr-chips">${chips(data.to)}</dd>
        ${data.cc.length ? `<dt>抄送</dt><dd class="addr-chips">${chips(data.cc)}</dd>` : ''}
        <dt>主题</dt><dd>${escape(data.subject) || '（无主题）'}</dd>
        <dt>附件</dt><dd>${attachments.length ? attachments.map(a => `${escape(a.name)}${a.tag ? `（${escape(a.tag)}）` : ''}`).join('、') : '无'}</dd></dl>
        <div class="send-body-view"><div class="att-title">正文 · 按本次发送内容</div>${bodyView(data)}</div>
        ${willSaveFirst ? '<div class="picker-note">当前有未保存修改：确认发送会先保存这份内容，再按保存后的版本发送。</div>' : '<div class="picker-note">发送以本清单为准；发送后内容固定，不受文件库后续更新影响。</div>'}
        ${missing ? `<label class="send-missing"><input type="checkbox" id="accept-missing"> 模板要求 ${seed.required} 个附件，当前 ${attachments.length} 个；我确认接受缺项</label>` : ''}
        <div class="send-warn">${showExamples?'示例环境未接后端：点击下方按钮也不会实际发送，内容保留在草稿箱。':'确认后将真实发往以上邮箱。内容与附件版本固定，服务商接受不代表对方已收到。'}</div>
      </div>
      <div class="dlg-foot"><button class="btn btn-ghost" id="dlg-close2">返回编辑</button><button class="btn btn-pri" id="send-ok" ${missing ? 'disabled' : ''}>确认发送</button></div>`);
    const q = s => dlg.querySelector(s);
    /* 发送前核对里的正文 = 同一套所见即所得只读面（跟读信、写信窗一个样，不另开渲染窗）。 */
    mountBodySurface(dlg, data);
    q('#dlg-close').onclick = closeModal; q('#dlg-close2').onclick = closeModal;
    q('#accept-missing')?.addEventListener('change', e => { q('#send-ok').disabled = !e.target.checked; });
    let pendingSend=false;
    ui.guardModal(dlg,()=>{if(writing||pendingSend){notify('发送结果尚未核实，请先查询本次请求','error');return false;}return true;});
    q('#send-ok').onclick = async () => {
      if(!showExamples){
        if(writing)return;
        writing=true;q('#send-ok').disabled=true;q('#dlg-close').disabled=true;q('#dlg-close2').disabled=true;
        try{
          /* FIX-51（用户 2026-10-20 实测：带附件的转发点「发送」，间歇性 417
             「邮件已更新，请重新核对当前版本后发送」，信没发出去，3 次错 2 次）：
             **打开核对框本身**会让附件区失焦 → 触发一次自动保存 → record_version +1；
             而这里用的是**打开核对框那一刻**的版本快照 ⇒ 落后一格 ⇒ 被后端版本闸挡下。
             ⇒ 发送时用**落地后**的版本（`versionOf` 会等在途/排队的保存落地再给最新版本）。
             ⚠️ 后端那把版本闸是**对的**（防并发覆盖），不许放宽、也不许在这里重试。 */
          const expectedVersion=versionOf?await versionOf():editing.version;
          const receipt=await action('mail.send',{mail:editing.id,expected_version:expectedVersion},r=>Boolean(r.name)&&r.name===editing.id&&['Queued','Sending','Sent','Partial','Failed','Unknown'].includes(r.status));
          if(ui.disposed)return;pendingSend=false;writing=false;
          closeAllModals();onSaved();closeDetail();box='all';page=1;await load();
          const status=mapReal(receipt);notify(deliveryText(status)||'发送请求已提交，请刷新状态核对');
          if(mails.some(row=>row.id===editing.id))await open(editing.id);
        }catch(error){
          if(ui.disposed)return;
          if(error.uncertain)pendingSend=true;
          q('.send-warn').textContent=pendingSend?'发送请求结果待核实。请点击“核实发送请求”查询原请求，不会新建发送意图。':'本次未发送：'+error.message+'；返回编辑保留草稿。';
          q('#send-ok').textContent=pendingSend?'核实发送请求':'确认发送';
        }finally{writing=false;if(!ui.disposed&&q('#send-ok')){q('#send-ok').disabled=false;q('#dlg-close').disabled=pendingSend;q('#dlg-close2').disabled=pendingSend;}}
        return;
      }
      const now = new Date().toLocaleString('sv-SE').slice(0, 16);
      if (editing) Object.assign(editing, data, {date: now});
      else mails.push({id: uid(), box: 'draft', deletedFrom: 'draft', ...data, date: now});
      closeAllModals(); onSaved(); box = 'draft'; closeDetail();
      notify('示例环境未接后端：未实际发送，未产生“已发送”记录；草稿已保留');
    };
  }

  function openAccounts() {
    const dlg = openModal(`
      <div class="dlg-head"><span>邮箱设置 · 发件身份</span><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      <div class="dlg-body">
        <table class="accounts-table"><thead><tr><th>邮箱</th><th>用途</th><th>授权凭据</th><th>操作</th></tr></thead><tbody id="acc-rows"></tbody></table>
        <div class="picker-note">已保存凭据任何角色均不可查看、复制或导出；忘记时只能更换授权。此为交互样例，未保存任何真实凭据。</div>
        <div class="dlg-field"><span>添加邮箱</span><input id="acc-addr" placeholder="name@company.example.com" autocomplete="off"></div>
        <div class="dlg-field"><span>授权凭据</span><input id="acc-secret" type="password" placeholder="遮蔽输入，保存后不可查看" autocomplete="new-password"></div>
      </div>
      <div class="dlg-foot"><button class="btn btn-ghost" id="dlg-close2">关闭</button><button class="btn btn-pri" id="acc-add">添加</button></div>`);
    const q = s => dlg.querySelector(s);
    const draw = () => {
      q('#acc-rows').innerHTML = accounts.map((a, i) => `<tr><td>${escape(a.addr)}</td><td>${escape(a.use)}</td><td class="masked">已配置 · 不可查看</td><td><button class="mail-link" data-renew="${i}">更换授权</button> <button class="mail-link dim" data-drop="${i}">移除</button></td></tr>`).join('');
      dlg.querySelectorAll('[data-renew]').forEach(b => b.onclick = () => notify('示例：更换授权将要求重新输入凭据，旧凭据随即失效'));
      dlg.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { accounts.splice(Number(b.dataset.drop), 1); draw(); });
    };
    draw();
    q('#dlg-close').onclick = closeModal; q('#dlg-close2').onclick = closeModal;
    q('#acc-add').onclick = () => {
      const addr = q('#acc-addr').value.trim();
      // 校验提示也走 toast 公共件，不再自造 .dlg-error 红字（用户 2026-10-12）。
      if (!EMAIL.test(addr)) { notify('邮箱地址格式不正确', 'error'); return; }
      accounts.push({addr, use: '个人邮箱'});
      q('#acc-addr').value = ''; q('#acc-secret').value = ''; draw();
      notify('已添加（示例）：凭据已按遮蔽方式保存，不可查看');
    };
  }

  function openArchive(name) {
    const dlg = openModal(`
      <div class="dlg-head"><span>归档到文件库</span><button class="detail-close" id="dlg-close" aria-label="关闭">×</button></div>
      <div class="dlg-body">
        <div class="picker-note">附件：${escape(name)} — 归档后文件库保存副本引用，原邮件附件不受影响。</div>
        <label class="dlg-field"><span>目标目录</span><select id="arc-dir"><option>/案件/CN3024518</option><option>/客户/ACME</option><option>/待整理</option></select></label>
        <div class="send-warn">示例环境未接后端：确认后不会实际写入文件库。</div>
      </div>
      <div class="dlg-foot"><button class="btn btn-ghost" id="dlg-close2">取消</button><button class="btn btn-pri" id="arc-ok">确认归档</button></div>`);
    const q = s => dlg.querySelector(s);
    q('#dlg-close').onclick = closeModal; q('#dlg-close2').onclick = closeModal;
    q('#arc-ok').onclick = () => { closeModal(); notify('示例环境：归档动作未接后端，未写入文件库'); };
  }

  host.addEventListener('keydown', e => { if (e.key === 'Escape' && !ui.modalCount) closeDetail(); }, {signal:ui.signal});
  window.addEventListener('shangshu:before-object-change',event=>{
    if(!showExamples&&event.detail?.object_id==='mail.message'&&!canLeave())event.preventDefault();
  },{signal:ui.signal});
  window.addEventListener('shangshu:review-target',async event=>{
    if(event.detail?.module!=='mail'||!event.detail.mail||!canLeave())return;
    await open(event.detail.mail);
    if(ui.disposed)return;
    const field=event.detail.unit?.field;
    const target=field==='body'?document.querySelector('#c-editor-host [contenteditable="true"]'):
      document.querySelector('#c-'+(field||'subject'));
    target?.focus();
  },{signal:ui.signal});
  window.addEventListener('shangshu:object-changed',async event=>{
    if(showExamples||event.detail?.object_id!=='mail.message')return;
    if(inlineReviewController&&event.detail.name===selected){await inlineReviewController.refresh();return;}
    if(!canLeave())return;
    const id=selected,sequence=detailSequence;
    await load();
    if(!ui.disposed&&id&&id===event.detail.name&&id===selected&&sequence===detailSequence&&canLeave())await open(id);
  },{signal:ui.signal});

  $('#examples-toggle').textContent = showExamples ? '退出交互样例' : '查看交互样例';
  $('#examples-toggle').hidden = !showExamples;
  $('.preview-label').textContent = showExamples ? '交互样例 · 不发送' : '正在连接…';
  $('#compose').disabled = !showExamples;
  $('#compose').innerHTML = actionLabel(showExamples ? '写邮件' : '正在读取…','compose');
  $('#accounts-btn').disabled = false;
  /* #sig-btn 的开关归 accountChrome 管 —— 这里只绑动作。
     （原先写死 disabled=false，只读授权的箱上也会给出签名入口。） */
  $('#sig-btn').onclick = () => openSignatureDialog();
  /* #access-btn 的开关归 accountChrome 管（没管理权就收起来）—— 这里只绑动作。 */
  $('#access-btn').onclick = () => openAccessDialog();
  /* 待审候选：审的是**助手提给我的**稿，跟当前箱的权限无关 ——
     后端 `list_action_proposals` 自己按角色/发起人过滤，这里只给入口。 */
  window.addEventListener('shangshu:review-focus',async event=>{
    const target=event.detail||{};if(showExamples||ui.disposed||!host.isConnected||target.module!=='mail')return;
    await navigateReviewTarget(target);
  },{signal:ui.signal});
  /* 切箱：换当前箱 → 重新取这个箱的信；不丢当前草稿（草稿是独立记录）。 */
  $('#mailbox-switch').onchange = () => {
    if(showExamples)return;
    if(batchRunning||!canLeave()){$('#mailbox-switch').value=currentBox?.id||'';return;}
    currentBox = mailboxes.find(m => m.id === $('#mailbox-switch').value) || null;
    clearMailSelection();
    page = 1;
    accountChrome();
    if(canLeave())refresh();
  };
  void loadMailboxes();
  $('#compose').onclick = () => openCompose(null);
  $('#mail-select-all').onchange=event=>{host.querySelectorAll('[data-mail-select]:not(:disabled)').forEach(control=>{control.checked=event.target.checked;if(control.checked)mailSelection.add(control.dataset.mailSelect);else {mailSelection.delete(control.dataset.mailSelect);batchSnapshots.delete(control.dataset.mailSelect);}});batchConfirmation='';renderSelection();};
  $('#mail-selection-clear').onclick=clearMailSelection;
  $('#mail-batch-recycle').onclick=()=>void recycleSelection();
  $('#accounts-btn').onclick = ()=>{if(showExamples){openAccounts();return;}if(canLeave()){if(typeof go==='function')go('mail-settings');else location.hash='/mail-settings';}};
  $('#mail-sync').onclick=async()=>{
    if(syncing||!canSync())return;syncing=true;accountChrome();
    try{const result=await action('mail.sync',currentBox?{mailbox_id:currentBox.id}:{},r=>Number.isInteger(r.added)&&Number.isInteger(r.skipped)&&typeof r.has_more==='boolean');if(ui.disposed)return;await load();const errors=Array.isArray(result.errors)?result.errors:[];notify(`同步${errors.length?'部分完成':'完成'}：新增 ${Number(result.added||0)} 封${errors.length?`；${errors.length} 封未能导入，请在原邮箱查看`:''}${result.has_more?'；还有邮件待同步，请再次点击':''}`,errors.length?'error':'success');}
    catch(error){notify('同步未完成：'+error.message,'error');}finally{syncing=false;if(!ui.disposed)accountChrome();}
  };
  $('#examples-toggle').onclick = () => { if(canLeave()) ui.toggleExamples(window.mountMailCenter, !showExamples); };
  const refresh=()=>{page=1;if(showExamples)render();else void load();};
  $('#mail-box').onchange = () => { box = $('#mail-box').value; clearMailSelection();refresh(); };
  let searchSequence=0;
  $('#search').oninput = ()=>{clearMailSelection();if(showExamples){render();return;}const sequence=++searchSequence;querySequence++;ui.later(()=>{if(sequence===searchSequence)refresh();},200);};
  /* 真实模式的列表是**后端分页**：改筛选必须重新取数，不能只重画当前页。 */
  $('#filter').onchange = () => { clearMailSelection();if (showExamples) { render(); return; } page = 1; refresh(); };
  $('#clear').onclick = () => {clearMailSelection();searchSequence++;$('#search').value = ''; $('#filter').value = ''; box='all';refresh();};
  $('#sort').onclick = () => {clearMailSelection();descending = !descending; $('#sort').textContent = `时间 ${descending ? '↓' : '↑'}`; refresh(); };
  $('#mail-prev').onclick=()=>{clearMailSelection();page--;void load();};$('#mail-next').onclick=()=>{clearMailSelection();page++;void load();};
  if(!showExamples){
    /* 筛选框**不许藏起来**：「未读」和「带附件」都真的接了后端筛选，
       藏掉等于把功能做没了。原来这里是 disabled+hidden，真实模式一个筛选都用不了。 */
    box='all';
  }
  // 与参考工作面保持相同操作：拖动/方向键调整，双击复位，宽度按身份保存。
  const divider = $('.mail-divider'), layout = $('.mail-body');
  const viewUser=typeof currentUserInfo==='undefined'?'':currentUserInfo?.username;
  const widthKey = viewUser?`shangshu.mail.list-width.${viewUser}`:null;
  let width=340, drag=null;
  try { const value=widthKey&&Number(localStorage.getItem(widthKey)); if(value) width=value; } catch {}
  function setWidth(value, persist=true) {
    width=Math.max(260,Math.min(560,value));
    layout.style.setProperty('--mail-list-width',`${width}px`);
    divider.setAttribute('aria-valuenow',String(width));
    if(persist&&widthKey) try{localStorage.setItem(widthKey,String(width));}catch{}
  }
  function endResize(cancel) {
    if(!drag)return;
    const previous=drag;drag=null;
    if(cancel)setWidth(previous.width);else setWidth(width);
    if(divider.hasPointerCapture?.(previous.id))divider.releasePointerCapture(previous.id);
  }
  divider.onpointerdown=e=>{if(e.button!==0||drag)return;drag={x:e.clientX,width,id:e.pointerId};divider.setPointerCapture?.(e.pointerId);divider.focus();e.preventDefault();};
  divider.onpointermove=e=>{if(drag?.id===e.pointerId)setWidth(drag.width+e.clientX-drag.x,false);};
  divider.onpointerup=()=>endResize(false);
  divider.onpointercancel=divider.onlostpointercapture=()=>endResize(true);
  divider.ondblclick=()=>{endResize(true);setWidth(340);};
  divider.onkeydown=e=>{
    if(e.key==='Escape'&&drag){e.stopPropagation();endResize(true);return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();setWidth(e.key==='Home'?260:e.key==='End'?560:width+(e.key==='ArrowLeft'?-16:16));
  };
  /* 正文窗格高度 —— 用户 2026-10-13 批注 1-1：「这个正文可以窗格可以拉长吗？这样都看不到了」。
     改之前写死 340px，2 倍屏上就是截图里那个矮框，引用的原信被裁在半截、下面全是空白。
     改之后：和列表分隔条同一套操作（拖动/方向键/Home/End/双击复位），高度按身份记住。
     拖柄是打开信时才画出来的，所以挂在 #detail 上做事件代理，别在模板里绑一次就没了。 */
  const bodyPane=$('#detail');
  const bodyHeightKey=viewUser?`shangshu.mail.body-height.${viewUser}`:null;
  let bodyHeight=340, bodyDrag=null;
  try{const value=bodyHeightKey&&Number(localStorage.getItem(bodyHeightKey));if(value)bodyHeight=value;}catch{}
  const bodyGrip=()=>bodyPane&&bodyPane.querySelector('[data-mail-body-grip]');
  function setBodyHeight(value,persist=true){
    bodyHeight=Math.max(200,Math.min(1600,value));
    if(bodyPane)bodyPane.style.setProperty('--mail-body-height',`${bodyHeight}px`);
    const grip=bodyGrip();if(grip)grip.setAttribute('aria-valuenow',String(bodyHeight));
    if(persist&&bodyHeightKey)try{localStorage.setItem(bodyHeightKey,String(bodyHeight));}catch{}
  }
  function endBodyResize(cancel){
    if(!bodyDrag)return;
    const previous=bodyDrag;bodyDrag=null;
    if(cancel)setBodyHeight(previous.height);else setBodyHeight(bodyHeight);
    if(previous.el?.hasPointerCapture?.(previous.id))previous.el.releasePointerCapture(previous.id);
  }
  if(bodyPane){
    bodyPane.addEventListener('pointerdown',e=>{
      const grip=e.target&&e.target.closest&&e.target.closest('[data-mail-body-grip]');
      if(!grip||e.button!==0||bodyDrag)return;
      bodyDrag={y:e.clientY,height:bodyHeight,id:e.pointerId,el:grip};
      grip.setPointerCapture?.(e.pointerId);grip.focus();e.preventDefault();
    });
    bodyPane.addEventListener('pointermove',e=>{
      if(bodyDrag?.id!==e.pointerId)return;
      setBodyHeight(bodyDrag.height+e.clientY-bodyDrag.y,false);
    });
    bodyPane.addEventListener('pointerup',()=>endBodyResize(false));
    bodyPane.addEventListener('pointercancel',()=>endBodyResize(true));
    bodyPane.addEventListener('lostpointercapture',()=>endBodyResize(true));
    bodyPane.addEventListener('dblclick',e=>{
      const grip=e.target&&e.target.closest&&e.target.closest('[data-mail-body-grip]');
      if(!grip)return;
      endBodyResize(true);setBodyHeight(340);
    });
    bodyPane.addEventListener('keydown',e=>{
      const grip=e.target&&e.target.closest&&e.target.closest('[data-mail-body-grip]');
      if(!grip)return;
      if(e.key==='Escape'&&bodyDrag){e.stopPropagation();endBodyResize(true);return;}
      if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault();
      setBodyHeight(e.key==='Home'?340:e.key==='End'?1600:bodyHeight+(e.key==='ArrowUp'?-24:24));
    });
  }
  ui.guardLeave(()=>{if(batchRunning){notify('正在逐条回收，请等待核对结果','info');return false;}if(writing){notify('正在保存，请等待结果');return false;}return ui.canCloseModals()&&canLeave();});
  setWidth(width,false);closeDetail();
  if(!showExamples){
    void loadAccount();
    const params=new URLSearchParams(location.search),referenced=params.get('mail'),proposalId=params.get('proposal');
    void load().then(()=>{if(!ui.disposed&&(proposalId||(referenced&&connected)))return navigateReviewTarget({mail:referenced,proposal_id:proposalId});});
    void refreshReviewCue();
  }
  return dispose;
};
RENDER['mail'] = page => {
  return window.mountMailCenter(page.host, {signal: page.signal});
};

// 全局加载即可核对 AI 提案；不要求先打开邮箱，不持有凭据、不执行写入。
(() => {
  const registry=window.shangshuConfirmationPresenters ||= Object.create(null);
  async function read(url,payload){
    const response=await fetch(url,{cache:'no-store',...(payload===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload})})});
    const data=await response.json();
    if(!response.ok||data.ok===false||data.error)throw Error('无法读取邮件或附件，请重新核对后提案。');
    return data.result||data;
  }
  const service=(id,payload)=>read('/api/platform/services/'+id+'/invoke',payload);
  async function detail(name){
    if(typeof name!=='string'||!name)throw Error('缺少邮件引用，请先保存草稿。');
    const {mail}=await service('mail.detail',{mail:name});
    if(!mail||mail.name!==name||!Number.isInteger(mail.record_version)||!Array.isArray(mail.attachments))throw Error('邮件详情不完整，不能确认。');
    return mail;
  }
  function checkVersion(mail,p,statuses){
    if(mail.record_version!==p.expected_version)throw Error('草稿已变化，请读取最新版本并重新提案。');
    if(!statuses.includes(mail.status))throw Error('当前邮件状态不能执行此操作，请核对结果，不能直接重发。');
  }
  function lines(mail){
    if(!Array.isArray(mail.to)||!Array.isArray(mail.cc)||typeof mail.subject!=='string'||typeof mail.body!=='string')throw Error('邮件内容不完整，不能确认。');
    return ['收件人：'+(mail.to.join('；')||'未填写'),'抄送：'+(mail.cc.join('；')||'无'),'主题：'+(mail.subject||'未填写'),
      '正文：'+bodySummary(mail),'附件：'+(mail.attachments.map(a=>{if(!a.file||!a.name)throw Error('附件信息不完整，不能确认。');return a.name+' · '+(a.label||'已固定原件')+' ['+a.file+']';}).join('；')||'无')];
  }
  function bodySummary(mail){
    const body=String(mail.body||'');
    if(mail.body_format==='HTML'||(mail.body_format!=='Text'&&/<\/?(?:table|p|div|blockquote|span|br)\b/i.test(body))){const template=document.createElement('template');template.innerHTML=globalThis.mailEditor?globalThis.mailEditor.safeFragment(body):'';const count=template.content.querySelectorAll('table').length;return `富文本${count?' · '+count+' 张表格':''}，请在正文预览核对`;}
    return body.length>120?body.slice(0,120)+'…':body||'（空正文）';
  }
  const reviewBody=mail=>mail?{id:mail.name||'',body:mail.body||'',bodyFormat:mail.body_format||'Text',inline:mail.inline_resources||mail.inline||[]}:null;
  async function draftAttachments(p,old){
    if(p.attachments===undefined)return old?.attachments||[];
    if(!Array.isArray(p.attachments))throw Error('附件引用格式不正确。');
    const found=new Map((old?.attachments||[]).map(a=>[a.file,a]));
    for(const id of p.attachments){
      if(found.has(id))continue;
      // 按固定 File ID 查询来源，绝不信任 AI 的文件名/版本备注，也不遍历文件目录。
      const result=await service('files.versions',{attachment:id});
      const current=result.current?.frappe_file===id?result.current:null;
      const exact=current||(result.versions||[]).find(v=>v.frappe_file===id&&Number.isInteger(v.version_no));
      if(!exact||!result.file?.file_name)throw Error('附件不是当前授权文件的固定版本，不能确认；请勿使用文件中心业务编号代替附件编号。');
      found.set(id,{file:id,name:result.file.file_name,label:current?'当前内容（确认时固定）':'第 '+exact.version_no+' 版'});
    }
    return p.attachments.map(id=>found.get(id));
  }
  registry['mail.send']={
    async prepare(confirm){
      const p=confirm.payload||{},mail=await detail(p.mail);checkVersion(mail,p,['Draft','Queued']);
      let sender;
      if(mail.mailbox_id){
        const {mailboxes}=await service('mail.mailboxes',{});
        sender=Array.isArray(mailboxes)?mailboxes.find(box=>box.id===mail.mailbox_id):null;
        if(!sender||sender.rights?.send!==true)throw Error('当前没有这封草稿所属邮箱的代发权限，不能确认发送。');
        if(!sender.enabled||sender.connection_status!=='connected'||!sender.email)throw Error('草稿所属发件邮箱尚未连接或已暂停，请先检查邮箱设置。');
      }else{
        // 仅兼容尚未返回 mailbox_id 的旧个人草稿，不能替代一个已知的共享箱。
        const {account}=await service('mail.account.status',{});sender=account;
        if(!sender?.bound||!sender.enabled||sender.connection_status!=='connected')throw Error('请先在邮箱设置绑定并启用本人邮箱。');
      }
      if(!mail.to.length||!mail.subject.trim())throw Error('请先补齐收件人和主题。');
      return {objectId:'mail.message',recordName:mail.name,title:mail.status==='Queued'?'继续发送已排队邮件':'发送邮件',lines:['将向外部邮箱真实发送；服务商接受不代表对方收到或已读。','发件邮箱：'+sender.email,'草稿版本：'+mail.record_version,...lines(mail)]};
    },
    async afterExecution(confirm){
      const mail=await detail(confirm.payload?.mail),states={
        Queued:['等待发送','请求已排队，尚未确认发出。','pending'],Sending:['正在发送','正在交给服务商，不要重复提交。','pending'],
        Sent:['服务商已接受','不代表对方收到或已读。','success'],Partial:['部分收件人未被接受','请核对收件人处理结果，不能当作全部发出。','error'],
        Failed:['发送失败','请核对失败原因，未自动重发。','error'],Unknown:['发送结果待确认','不能确认是否发出，请到原邮箱核对，禁止直接重发。','pending']};
      const state=states[mail.status];if(!state)throw Error('已确认，但当前发送状态暂无法核实，请在邮箱查看。');
      return {title:state[0],lines:[state[1],'主题：'+mail.subject,...(mail.rejected?.length?['未接受：'+mail.rejected.join('；')]:[])],tone:state[2]};
    }
  };
  registry['mail.save_draft']={
    async prepare(confirm){
      const p=confirm.payload||{},old=p.mail?await detail(p.mail):null;
      if(old)checkVersion(old,p,['Draft']);
      const attachments=await draftAttachments(p,old);
      const candidate={...(old||{}),...p,attachments,to:p.to??old?.to??[],cc:p.cc??old?.cc??[],subject:p.subject??old?.subject??'',body:p.body??old?.body??'',body_format:p.body_format??old?.body_format??'Text'};
      const next=lines(candidate),summary=[];
      if(old){const before=lines(old);summary.push('草稿版本：'+old.record_version);for(let i=0;i<3;i++)summary.push(before[i]===next[i]?next[i]:before[i]+' → '+next[i].replace(/^[^：]+：\n?/,''));const rich=candidate.body_format==='HTML';summary.push(old.body!==candidate.body?(rich?'正文有修改 · '+bodySummary(candidate):'正文有修改：'+bodySummary(old)+' → '+bodySummary(candidate)):'正文未修改 · '+bodySummary(candidate));summary.push(next[4]);}
      else summary.push(...next);
      return {objectId:'mail.message',recordName:old?.name,title:old?'更新邮件草稿（不发送） · '+(old.subject||'无主题'):'保存邮件草稿（不发送）',lines:summary,mailReview:{before:reviewBody(old),after:reviewBody({...candidate,name:old?.name||p.mail||''})}};
    },
    async afterExecution(confirm,response){
      const name=response.result?.name||confirm.payload?.mail;
      if(!name)return {title:'草稿已确认',lines:['此次回执未返回草稿引用，请到邮箱草稿箱核对；本操作不发送邮件。'],tone:'pending'};
      const mail=await detail(name);if(mail.status!=='Draft')throw Error('保存已确认，但邮件状态已变化，请到邮箱核对。');
      window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail:{object_id:'mail.message',name:mail.name}}));
      return {title:'草稿已保存（未发送）',lines:['草稿版本：'+mail.record_version,...lines(mail)],tone:'success'};
    }
  };
})();
