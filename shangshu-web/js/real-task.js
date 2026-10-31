/* ==========================================================================
   通用任务中心（帖子能力仅做旧数据兼容，不再混入主产品结构）
   process.tasks —— 逾期预警/确认卡产出与手动任务（任务列表/甘特）
   process.posts —— 老板派活 / AI 预警抛帖，员工认领+回复进度（帖子广场）
   写操作均走事件总线（确认卡留痕）。
   ========================================================================== */

let rtTaskTab = 'list';
let rtStatusFilter = 'all';
let rtFilters = {query:'',owner:'all',due:'all',sort:'due'};
let rtHost = null;
let rtPage = null;

function rtToday() {
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function rtFilterTasks(rows, filters={}, me=currentUserInfo?.username, today=rtToday()) {
  const query=String(filters.query||'').trim().toLocaleLowerCase();
  const open=t=>!['已完成','已取消'].includes(t.status);
  const end=new Date(today+'T12:00:00');end.setDate(end.getDate()+7);
  const week=`${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
  return rows.filter(t=>
    (!filters.status||filters.status==='all'||t.status===filters.status)&&
    (filters.owner!=='mine'||t.assignee_id===me)&&(filters.owner!=='created'||t.created_by===me)&&
    (!query||[t.title,t.assignee,t.result,t.project].some(s=>String(s||'').toLocaleLowerCase().includes(query)))&&
    (filters.due!=='overdue'||(open(t)&&t.end_date&&t.end_date<today))&&
    (filters.due!=='today'||(open(t)&&t.end_date===today))&&
    (filters.due!=='week'||(open(t)&&t.end_date>=today&&t.end_date<week))&&
    (filters.due!=='undated'||!t.end_date)
  ).sort((a,b)=>{
    if(filters.sort==='newest')return String(b.created_at||'').localeCompare(String(a.created_at||''));
    const active=Number(!open(a))-Number(!open(b));if(active)return active;
    if(filters.sort==='priority'){
      const rank={高:0,中:1,低:2};const priority=(rank[a.priority]??1)-(rank[b.priority]??1);if(priority)return priority;
    }
    return String(a.end_date||'9999').localeCompare(String(b.end_date||'9999'))||String(b.created_at||'').localeCompare(String(a.created_at||''));
  });
}
function rtRenderCached() {
  if(!rtHost?.isConnected||(rtPage&&!rtPage.isActive()))return;
  rtPaint(rtHost,rtRows);
  // 统一待办把操作按钮放外层，局部刷新需同步插槽，避免重复按钮。
  const actions=$('.platform-hd .acts',rtHost);
  if(actions&&rtPage?.actionsHost)rtPage.actionsHost.replaceChildren(actions);
}
function rtUpdateFilters() {
  if(!rtHost?.isConnected)return;
  rtFilters.query=$('[data-task-search]',rtHost)?.value||'';
  for(const key of ['owner','due','sort'])rtFilters[key]=$(`[data-task-${key}]`,rtHost)?.value||'all';
  rtPaintBody(rtHost,rtRows);
}
function rtClearFilters(){rtFilters={query:'',owner:'all',due:'all',sort:'due'};rtStatusFilter='all';rtRenderCached();}


let rtRows=[];
let rtRequest=0;
const RT_STATUS_TAG = { 待办: 'no', 进行中: '', 待验收:'warn', 已完成: 'ok', 已取消: 'no' };
const RT_SRC_TAG = { 手动: '', 逾期预警: 'warn', 确认卡: 'ok' };
const RT_POST_STATUS = { 待认领: ['待认领', 'no'], 已认领: ['已认领', ''], 待验收:['待验收','warn'], 已完成: ['已完成', 'ok'] };
const rtCanWrite = () => ['admin', 'manager', 'finance'].includes(currentUserInfo?.role || '');

RENDER['task-mgmt'] = async function (page) {
  const main=page?.host || mainBox(), request=++rtRequest;
  const active=()=>request===rtRequest&&main.isConnected&&(!page||page.isActive());
  let list;
  try { ({list}=await apiJSON('api/tasks')); }
  catch(error){
    if(!active())return;
    main.innerHTML=`<div class="page-hd page-heading"><h1>任务</h1></div><div class="platform-error" role="alert"><b>任务暂时无法读取</b><p>${esc(error.message||error)}</p><button class="btn btn-ghost" type="button" data-task-retry>重试</button></div>`;
    $('[data-task-retry]',main).onclick=()=>RENDER['task-mgmt'](page);return;
  }
  if(!active())return;
  const rows = Array.isArray(list) ? list : [];
  rtRows=rows;
  rtHost=main;rtPage=page||null;
  rtPaint(main,rows);
  if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({module:'task-mgmt',view:rtTaskTab,entity_type:'object',entity_id:'task',label:'任务中心',metadata_kind:'object',metadata_key:'task',editable_scope:rtCanWrite()?'任务查询、派发、进度与验收；写操作必须确认':'查询和更新分配给当前用户的任务；不得派发或修改其他人的任务'});
};

function rtPaint(main,rows) {
  const tabs = [['list', '列表'], ['gantt', '时间线']].map(([k, n]) =>
    `<button class="tab ${rtTaskTab === k ? 'on' : ''}" onclick="rtTaskTab='${k}';rtRenderCached()">${n}</button>`).join('');
  const select=(key,label,options)=>`<label>${label}<select data-task-${key} onchange="rtUpdateFilters()">${options.map(([v,n])=>`<option value="${v}" ${rtFilters[key]===v?'selected':''}>${n}</option>`).join('')}</select></label>`;
  main.innerHTML=`
    <div class="page-hd platform-hd page-heading"><h1>任务</h1>
      <div class="acts"><button class="btn btn-ghost" onclick="rtAskAiTasks()">${rtCanWrite() ? '✦ AI 拆解 / 派发' : '✦ AI 分析任务'}</button>${rtCanWrite()?'<button class="btn btn-pri" onclick="rtCreateTaskForm()">＋ 新建任务</button>':''}</div></div>
    <div class="task-viewbar"><div class="tabbar">${tabs}</div><div class="task-status-filters">${[['all','全部'],['待办','待办'],['进行中','进行中'],['待验收','待验收'],['已完成','已完成'],['已取消','已取消']].map(([k,n])=>`<button class="${rtStatusFilter===k?'on':''}" onclick="rtStatusFilter='${k}';rtRenderCached()">${n}<small>${k==='all'?rows.length:rows.filter(t=>t.status===k).length}</small></button>`).join('')}</div></div>
    <div class="task-toolbar"><label class="task-search">搜索<input type="search" data-task-search aria-label="搜索任务" placeholder="搜索任务、负责人或结果" value="${esc(rtFilters.query)}" oninput="rtUpdateFilters()"></label>
      ${select('owner','参与方式',[['all','全部可见'],['mine','我负责的'],['created','我发起的']])}
      ${select('due','截止日期',[['all','不限日期'],['overdue','已逾期'],['today','今天到期'],['week','未来 7 天'],['undated','未设日期']])}
      ${select('sort','排序',[['due','截止日期'],['priority','优先级'],['newest','最新创建']])}
      <button class="btn btn-ghost" onclick="rtClearFilters()">重置</button></div><div data-task-body></div>`;
  rtPaintBody(main,rows);
  $('[data-task-search]',main).oninput=rtUpdateFilters;
}

function rtPaintBody(main,rows) {
  const visibleRows=rtFilterTasks(rows,{...rtFilters,status:rtStatusFilter});
  const filtered=visibleRows.length!==rows.length;
  let body;
  if (rtTaskTab === 'gantt') {
    const dated = visibleRows.filter(t => Number.isFinite(Date.parse(t.start_date)) && Number.isFinite(Date.parse(t.end_date)));
    const d0 = new Date(Math.min(Date.now(),...dated.map(t=>Date.parse(t.start_date)))), span = Math.max(14,Math.ceil((Math.max(Date.now(),...dated.map(t=>Date.parse(t.end_date)))-d0)/864e5)+2);
    const off = (d) => Math.max(0, (new Date(d) - d0) / 864e5) / span * 100;
    const wid = (a, b) => Math.max(1.5, (new Date(b) - new Date(a)) / 864e5 / span * 100);
    const today = Math.min(100, Math.max(0, (Date.now() - d0) / 864e5 / span * 100));
    body = `<div class="card"><div class="card-bd"><div class="gantt-mock">
      ${dated.map(t => `<div class="gantt-row">
        <div class="lbl"><b>${esc(t.title)}</b> <span style="color:var(--fg3)">${esc(t.assignee || '')}</span></div>
        <div class="gantt-track"><div class="gantt-bar ${!['已完成','已取消'].includes(t.status)&&t.end_date<rtToday() ? 'late' : ''}" style="left:${off(t.start_date)}%;width:${wid(t.start_date, t.end_date)}%"><i style="width:${Math.max(0,Math.min(100,Number(t.pct)||0))}%"></i></div><div class="gantt-today" style="left:${today}%"></div></div>
      </div>`).join('') || '<div class="empty-hint">还没有带起止日期的任务</div>'}
    </div></div></div>`;
  } else if (rtTaskTab === 'list') {
    const emptyTaskHint = rtCanWrite()
      ? '点右上角「＋ 新建任务」开始创建'
      : '分配给你的任务会显示在这里';
    body = `<div class="card task-table-scroll"><table class="dtable">
      <tr><th>任务</th><th>优先级</th><th>负责人</th><th>截止日期</th><th style="text-align:right">进度</th><th>状态 / 处理</th></tr>
      ${visibleRows.map(t => `<tr data-ai-entity="task" data-ai-id="${esc(t.id)}">
        <td>${rtCanWrite()||t.assignee_id===currentUserInfo?.username?`<button class="task-title" onclick="rtEditTask('${esc(t.id)}')">${esc(t.title)}</button>`:`<b>${esc(t.title)}</b>`}${t.result?`<div class="task-result" title="${esc(t.result)}">${esc(t.result)}</div>`:''}${t.source&&t.source!=='手动'?`<small>${esc(t.source)}</small>`:''}</td>
        <td><span class="tag ${t.priority==='高'?'warn':''}">${esc(t.priority||'中')}</span></td>
        <td>${esc(t.assignee || '—')}</td>
        <td class="task-date ${t.end_date&&t.end_date<rtToday()&&!['已完成','已取消'].includes(t.status)?'is-overdue':''}" title="开始：${esc(t.start_date||'未设置')}">${esc(t.end_date||'未设日期')}${t.end_date&&t.end_date<rtToday()&&!['已完成','已取消'].includes(t.status)?'<small>已逾期</small>':''}</td>
        <td class="num">${Number(t.pct) || 0}%</td>
        <td>${(rtCanWrite() || t.assignee_id===currentUserInfo?.username) ? `<button class="tag ${RT_STATUS_TAG[t.status] || ''}" style="cursor:pointer;border:none" title="查看结果并处理任务" onclick="rtEditTask('${esc(t.id)}')">${esc(t.status)}</button>` : `<span class="tag ${RT_STATUS_TAG[t.status] || ''}">${esc(t.status)}</span>`}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="task-empty"><div>${filtered?'没有符合条件的任务':'还没有任务'}</div><small>${filtered?'试试其他关键词，或重置筛选':emptyTaskHint}</small></td></tr>`}
    </table></div>`;
  } else {
    body = '';
  }
  $('[data-task-body]',main).innerHTML=`<div class="task-count" aria-live="polite">显示 ${visibleRows.length} / ${rows.length} 项${rtTaskTab==='gantt'?' · 时间线仅显示有起止日期的任务':''}</div>${body}`;
}

function rtAskAiTasks() {
  if (typeof chatAssist !== 'function') return toast('AI 助手未就绪','请刷新页面后重试');
  const canWrite = rtCanWrite();
  chatAssist({module:'task-mgmt',view:rtTaskTab,entity_type:'object',entity_id:'task',label:'任务中心',metadata_kind:'object',metadata_key:'task',editable_scope:canWrite?'先查询任务，再按责任人和截止时间拆解；派发与更新必须使用任务工具生成确认卡，经用户确认后执行':'只分析分配给当前用户的任务，不得派发或修改其他人的任务'},canWrite?'请先查询当前任务，帮我识别逾期、阻塞和负载问题。如果我要派新任务，先把目标拆成可验收的结果、负责人和截止时间，确认后再提交任务提案。':'请查询分配给我的任务，帮我解释优先级、截止时间和当前阻塞；不要派发新任务或修改其他人的任务。');
}

/* —— 帖子广场：发帖 + 帖子卡片流（认领/回复） —— */
async function rtRenderPosts() {
  const { list } = await apiJSON('api/posts').catch(() => ({ list: [] }));
  const posts = Array.isArray(list) ? list : [];
  const meName = currentUserInfo?.display_name || currentUserInfo?.username || '';
  const cards = posts.map(p => {
    const [stName, stTag] = RT_POST_STATUS[p.status] || [p.status, ''];
    const replies = (p.replies || []).map(r => `
      <div class="post-reply"><span class="post-reply-author">${esc(r.author)}</span><span class="post-reply-body">${esc(r.content)}</span><span class="post-reply-time">${rtTime(r.created_at)}</span></div>`).join('');
    return `
    <div class="post-card" data-ai-entity="post" data-ai-id="${esc(p.id)}">
      <div class="post-head">
        <span class="post-ava">${esc((p.author || '?').slice(0, 1))}</span>
        <div class="post-meta">
          <div class="post-author">${esc(p.author)} ${p.author_role === 'agent' ? '<span class="tag ok">AI</span>' : ''}</div>
          <div class="post-time">${rtTime(p.created_at)}</div>
        </div>
        <span class="tag ${RT_SRC_TAG[p.source] || ''}">${esc(p.source || '手动')}</span>
        <span class="tag ${stTag}" style="margin-left:auto">${stName}${p.status === '已认领' && p.assignee ? ' · ' + esc(p.assignee) : ''}</span>
      </div>
      <div class="post-body">${esc(p.content)}</div>
      ${p.status === '待认领' ? `<div class="post-actions">
        <button class="btn btn-sm" onclick="rtClaimPost('${esc(p.id)}')">认领（我来负责）</button>
      </div>` : ''}
      <div class="post-replies">${replies}</div>
      <div class="post-reply-box">
        <input id="pr-${esc(p.id)}" placeholder="回复进度…" onkeydown="if(event.key==='Enter')rtReplyPost('${esc(p.id)}')">
        <button class="btn btn-sm" onclick="rtReplyPost('${esc(p.id)}')">回复</button>
      </div>
    </div>`;
  }).join('');
  return `
    ${rtCanWrite() ? `<div class="card post-composer">
      <span class="post-ava">${esc(meName.slice(0, 1))}</span>
      <div class="post-reply-box" style="flex:1">
        <input id="rt-post-content" placeholder="派个活，或者说一句大家都该看到的话…（也可以直接在对话里吩咐）" onkeydown="if(event.key==='Enter')rtCreatePost()">
        <button class="btn btn-pri btn-sm" onclick="rtCreatePost()">发布</button>
      </div>
    </div>` : ''}
    <div class="post-list">${cards || '<div class="card"><div class="wfail">广场还没有帖子 —— 在对话里派个活试试</div></div>'}</div>`;
}
function rtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
async function rtCreatePost() {
  const content = $('#rt-post-content')?.value?.trim();
  if (!content) { toast('缺内容', '先写一句要派的事'); return; }
  const r = await api('api/posts', { method: 'POST', body: JSON.stringify({ content, source: '手动' }) }).then(x => x.json()).catch(() => null);
  if (r && r.ok) RENDER['task-mgmt']();
  else toast('发布失败', (r && r.error) || '网络错误');
}
async function rtClaimPost(id) {
  const r = await api('api/posts/' + encodeURIComponent(id) + '/claim', { method: 'POST', body: '{}' }).then(x => x.json()).catch(() => null);
  if (r && r.ok) { RENDER['task-mgmt'](); toast('已认领', '这条帖子现在由你负责'); }
  else toast('认领失败', (r && r.error) || '网络错误');
}
async function rtReplyPost(id) {
  const input = $('#pr-' + id);
  const content = input?.value?.trim();
  if (!content) return;
  const r = await api('api/posts/' + encodeURIComponent(id) + '/replies', { method: 'POST', body: JSON.stringify({ content }) }).then(x => x.json()).catch(() => null);
  if (r && r.ok) RENDER['task-mgmt']();
  else toast('回复失败', (r && r.error) || '网络错误');
}

/* —— 任务列表 —— */
function rtAssigneeLabels(people) {
  const names = people.map(u => u.display_name || '未命名员工');
  return people.map((u, i) => {
    if (names.filter(name => name === names[i]).length === 1) return names[i];
    const key = String(u.username || '');
    const short = key.slice(0, 8);
    const collision = people.some((other, j) => j !== i && names[j] === names[i] && String(other.username || '').slice(0, 8) === short);
    return `${names[i]}（${short}${collision ? '·' + (i + 1) : ''}）`;
  });
}
async function rtCreateTaskForm() {
  const {list=[]}=await apiJSON('api/people?scope=tasks');
  openSchemaForm({title:'新建任务',required:['title','assignee_id'],properties:{
    title:{type:'string',title:'任务内容',minLength:1},
    assignee_id:{type:'string',title:'负责人',enum:list.map(u=>u.username),enumNames:rtAssigneeLabels(list)},
    priority:{type:'string',title:'优先级',enum:['中','高','低'],default:'中'},start_date:{type:'string',format:'date',title:'开始日期'},end_date:{type:'string',format:'date',title:'截止日期'}
  },onSubmit:async data=>{await submitJSON('api/tasks',data);await RENDER['task-mgmt']();}});
}
async function rtEditTask(id) {
  const task=rtRows.find(t=>t.id===id);if(!task) return;
  if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({module:'task-mgmt',view:'task-detail',entity_type:'task',entity_id:id,label:`任务 · ${task.title}`,metadata_kind:'object',metadata_key:'task',editable_scope:'当前任务的状态、进度和结果；不得修改他人任务'});
  // 取消：仅发起人/管理员，且只有待办/进行中可取消；取消后记录保留可查
  const canCancel=(rtCanWrite() || task.created_by===currentUserInfo?.username) && ['待办','进行中'].includes(task.status);
  const base={待办:['待办','进行中'],进行中:['进行中','待验收'],待验收:rtCanWrite()?['待验收','进行中','已完成']:['待验收'],已完成:rtCanWrite()?['已完成','进行中']:['已完成'],已取消:['已取消']}[task.status] || [task.status];
  const choices=canCancel?[...base,'已取消']:base;
  const people=rtCanWrite()?(await apiJSON('api/people?scope=tasks')).list:[];
  const management=rtCanWrite()?{title:{type:'string',title:'任务标题'},assignee_id:{type:'string',title:'负责人',enum:people.map(u=>u.username),enumNames:rtAssigneeLabels(people)},priority:{type:'string',title:'优先级',enum:['高','中','低']},start_date:{type:'string',format:'date',title:'开始日期'},end_date:{type:'string',format:'date',title:'截止日期'}}:{};
  openSchemaForm({title:task.title,description:'任务负责人提交结果后，由任务管理者验收或退回；任务管理者或发起人可取消待办、进行中的任务，记录保留可查。',required:['status'],hidden:{expected_version:task._version},values:task,
    properties:{...management,status:{type:'string',title:'状态',enum:choices},pct:{type:'number',minimum:0,maximum:100,title:'进度（%）'},result:{type:'string',title:'完成结果 / 退回说明',multiline:true}},
    onSubmit:async data=>{
      if(data.status==='已取消' && !confirm(`取消任务「${task.title}」？负责人会收到通知，记录保留可查。`)) return;
      await submitJSON('api/tasks/'+encodeURIComponent(id),data,'PATCH');await RENDER['task-mgmt']();
    }});
}
