/* ============ 模块：消息（真实 IM · 2026-08-07） ============
   会话/消息存 im.chats / im.messages；写路径 = im.send 事件 → 投影。
   轮询：只比对指纹，有变才局部刷新；禁止每 5s 整表重绘 + rise 动画（会跳）。 */
const IM_COLORS = ['#2E5E4E', '#8A5A2B', '#4A78B8', '#B45309', '#7A5AA0', '#3E7B9E'];
const imColorOf = (s) => IM_COLORS[Math.abs([...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0)) % IM_COLORS.length];

let imChats = [];
let imUsers = [];
let imCurChat = null;
let imPoll = null;
let imBusy = false;
let imListFp = '';
let imMsgFp = '';
let imGeneration = 0;
let imMessageRequest = 0;
let imOwner = '';
let imQuery = '';
let imUnreadOnly = false;
let imMessageQuery = '';
let imMessages = [];
let imMessagesChat = null;
const imDrafts = new Map();
const imPendingSends = new Map();
const imReplies = new Map();
let imMessageSender = '', imMessageDate = '', imHistoryLimit = 80, imLocatedId = '';
let imWindowed=false,imPageAnchor={},imHasEarlier=false,imHasNewer=false,imMentionOnly=false,imSearchTimer=null;
const imExtras=new Map(),imFileNames=new Map(),imFileCache=new Map(),imForwardKeys=new Map();
let imPicker=null,imModalEpoch=0,imNoticeOwner='',imNoticeSeen=new Map(),imNoticeStarted=false;

/* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：这几处是「数据还在路上」，
 *   **不写看得见的字** ⇒ 换成会呼吸的灰条，形状照最终那一块（几行就是几行）。
 *   ⚠️ 骨架里**不写假内容**（没有假标题、没有假项数、没有假数字）。
 *   ⚠️ 骨架**套在自己的容器里** ⇒ 数据到了把**内层**换掉就行（外层不动 ⇒ 不跳版）。
 *   ⚠️ 读屏的信号用 `aria-busy`（不写字）。 */
/** 一行「标题 ＋ 说明」（收藏那种竖排条目）。 */
const imSkeletonRow = '<div class="platform-skeleton-row" style="flex-direction:column;align-items:flex-start;gap:6px">'
  +'<span class="platform-skeleton-bar platform-skeleton-app-title"></span>'
  +'<span class="platform-skeleton-bar platform-skeleton-app-desc"></span></div>';
/** 收藏列表（`.im-saved-item` 那种一条一条）。 */
const imFavoritesSkeleton = () => '<div class="platform-skeleton" data-skeleton="im-favorites" aria-busy="true">'
  +'<div class="platform-skeleton-list">'+imSkeletonRow.repeat(3)+'</div></div>';
/** 文件中心那几行（`.im-picker-row` 那种一条一条）。 */
const imFileOptionsSkeleton = () => '<div class="platform-skeleton" data-skeleton="im-file-options" aria-busy="true">'
  +'<div class="platform-skeleton-list">'+imSkeletonRow.repeat(4)+'</div></div>';
/** 消息那几条（`.im-msg` 那种一条一条：对方那行带头像位）。 */
const imMessagesSkeleton = () => {
  const bubble = bars => '<div class="im-msg"><div class="im-msg-body"><div class="im-bubble">'+bars+'</div></div></div>';
  const other = bars => '<div class="im-msg"><div class="im-av sm"></div><div class="im-msg-body"><div class="im-bubble">'+bars+'</div></div></div>';
  const one = '<span class="platform-skeleton-bar platform-skeleton-app-desc"></span>';
  /* 两行字之间留一道缝（真消息的行距）⇒ 两根灰条不粘成一块。 */
  const two = '<span style="display:flex;flex-direction:column;gap:8px">'+one+'<span class="platform-skeleton-bar platform-skeleton-label"></span></span>';
  return '<div class="platform-skeleton" data-skeleton="im-messages" aria-busy="true">'+other(two)+bubble(one)+other(two)+'</div>';
};

function imHasMessageFilter(){return !!(imMessageQuery.trim()||imMessageSender||imMessageDate||imMentionOnly);}
function imLocalDay(value){const d=new Date(value);return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function imReplyTo(id){
  if(imPendingSends.has(imCurChat)){toast('请先确认上一条发送结果','回复目标暂时不能修改');return;}
  if(!imMessages.find(m=>m.id===id&&!m.recalled))return;
  imReplies.set(imCurChat,id);imRenderReply();$('#im-input')?.focus();
}
function imCancelReply(){if(imPendingSends.has(imCurChat))return;imReplies.delete(imCurChat);imRenderReply();}
function imRenderReply(){
  const box=$('#im-reply-preview');if(!box)return;
  const id=imReplies.get(imCurChat)||imPendingSends.get(imCurChat)?.replyTo;
  box.hidden=!id;if(!id){box.innerHTML='';return;}
  const original=imMessagesChat===imCurChat?imMessages.find(m=>m.id===id):null;
  box.innerHTML=`<div><b>回复 ${original?esc(imUserName(original.sender_id)):''}</b>${original?`<span>${original.recalled?'原消息已撤回，请取消引用':esc(original.text.slice(0,160))}</span>`:'<span class="platform-skeleton-bar platform-skeleton-desc" data-skeleton="im-reply"></span>'}</div><button class="im-message-action" aria-label="取消回复" onclick="imCancelReply()" ${imPendingSends.has(imCurChat)?'disabled':''}>×</button>`;
}
function imResetMessageFilters(){
  imMessageQuery='';imMessageSender='';imMessageDate='';imMentionOnly=false;
  const mentioned=$('#im-mention-only');if(mentioned)mentioned.checked=false;
  for(const id of ['im-message-search','im-message-sender','im-message-date']){const input=$('#'+id);if(input)input.value='';}
}
function imShowEarlier(){
  if(imWindowed)return imChangeWindow({before:imMessages[0]?.id});
  const el=$('#im-msgs');if(!el)return;
  const height=el.scrollHeight,top=el.scrollTop;imHistoryLimit+=80;imDrawMessages(false);el.scrollTop=top+el.scrollHeight-height;
}
function imLocateMessage(id){
  if(imWindowed){imResetMessageFilters();imLocatedId=id;return imChangeWindow({around:id});}
  const index=imMessages.findIndex(m=>m.id===id);if(index<0){toast('原消息不可用','可能已被移除');return;}
  imResetMessageFilters();imHistoryLimit=Math.max(imHistoryLimit,imMessages.length-index);imLocatedId=id;imDrawMessages(false);
  const el=[...document.querySelectorAll('[data-message-id]')].find(n=>n.dataset.messageId===id);el?.scrollIntoView?.({block:'center'});
}
function imInsertEmoji(value){
  const input=$('#im-input');if(!input)return;
  const start=input.selectionStart,end=input.selectionEnd;input.setRangeText(value,start,end,'end');input.focus();imSaveDraft();
  const menu=$('#im-emoji');if(menu)menu.open=false;
}
async function imSetPreference(key,value){
  const chatId=imCurChat,generation=imGeneration;
  const button=$('#im-pref-'+key);if(button)button.disabled=true;
  try{
    const result=await api(`api/im/chats/${encodeURIComponent(chatId)}`,{method:'PATCH',body:JSON.stringify({preferences:{[key]:value}})}).then(r=>r.json());
    if(!result.ok)throw Error(result.error||'保存失败');
    if(generation!==imGeneration)return;
    await imLoadChats();imRenderList(true);imRenderHeader();if(imCurChat===chatId)imOpenManage();
  }catch(error){toast('设置未保存',error.message);if(button){button.checked=!value;}}finally{if(button?.isConnected)button.disabled=false;}
}
function imPreferencesHtml(chat){return `<section class="im-preferences"><label><span>置顶会话<small>优先显示在你的会话列表</small></span><input id="im-pref-pinned" type="checkbox" ${chat.pinned?'checked':''} onchange="imSetPreference('pinned',this.checked)"></label><label><span>消息免打扰<small>保留未读标记，不计入导航总角标</small></span><input id="im-pref-muted" type="checkbox" ${chat.muted?'checked':''} onchange="imSetPreference('muted',this.checked)"></label></section>`;}

function imDraftExtras(){return imExtras.get(imCurChat)||{mentions:[],files:[]};}
function imCanEditExtras(){if(imPendingSends.has(imCurChat)){toast('请先确认上一条发送结果','引用、提及和文件暂时不能更改');return false;}return !!imCurChat;}
function imAddMention(id){
 if(!imCanEditExtras()||!imChats.find(c=>c.id===imCurChat)?.member_ids.includes(id))return;
 const extras=imDraftExtras();if(!extras.mentions.includes(id))extras.mentions.push(id);imExtras.set(imCurChat,extras);imRenderExtras();
}
function imAddFileDraft(ref,name){
 if(!imCanEditExtras())return;const extras=imDraftExtras();if(extras.files.length>=5){toast('最多添加5个文件','');return;}
 if(!extras.files.some(x=>x.file===ref.file))extras.files.push({ref_name:ref.ref_name,file:ref.file});imFileNames.set(ref.file,name);imExtras.set(imCurChat,extras);imRenderExtras();
}
function imRemoveExtra(kind,index){if(!imCanEditExtras())return;const extras=imDraftExtras();extras[kind].splice(index,1);imExtras.set(imCurChat,extras);imRenderExtras();}
function imRenderExtras(){
 const el=$('#im-extra-drafts');if(!el)return;const extras=imDraftExtras(),disabled=imPendingSends.has(imCurChat)?'disabled':'';
 el.innerHTML=extras.mentions.map((id,i)=>`<button class="im-draft-chip" ${disabled} onclick="imRemoveExtra('mentions',${i})" title="移除提及">@${esc(imUserName(id))} ×</button>`).join('')+extras.files.map((f,i)=>`<button class="im-draft-chip" ${disabled} onclick="imRemoveExtra('files',${i})" title="移除文件引用">${esc(imFileNames.get(f.file)||'固定版本文件')} ×</button>`).join('');
}
function imOpenMentions(){
 if(!imCanEditExtras())return;
 const members=(imChats.find(c=>c.id===imCurChat)?.member_ids||[]).filter(id=>id!==currentUserInfo?.username);
 imModalShow('提及会话成员',members.map(id=>`<button class="im-picker-row" onclick="imAddMention(${esc(JSON.stringify(id))});imCloseNew()">@ ${esc(imUserName(id))}</button>`).join('')||'<p>没有其他成员</p>','<button class="btn btn-ghost" onclick="imCloseNew()">取消</button>');
}
async function imFavorite(id,value){
 const chat=imCurChat,generation=imGeneration;
 try{const result=await api(`api/im/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(id)}/favorite`,{method:'POST',body:JSON.stringify({favorite:value})}).then(r=>r.json());if(!result.ok)throw Error(result.error);if(imCurChat===chat&&generation===imGeneration){const m=imMessages.find(m=>m.id===id);if(m)m.favorite=value;imMsgFp='';imDrawMessages(false);}}
 catch(e){toast('收藏未更新',e.message);}
}
async function imOpenFavorites(){
 imModalShow('我的收藏',imFavoritesSkeleton(),'<button class="btn btn-ghost" onclick="imCloseNew()">关闭</button>');const host=$('#im-modal .im-modal-bd'),generation=imGeneration,epoch=imModalEpoch;
 try{const r=await apiJSON('api/im/favorites');if(!host?.isConnected||generation!==imGeneration||epoch!==imModalEpoch)return;
 host.innerHTML=(r.list||[]).map(m=>`<article class="im-saved-item"><b>${esc(m.chat_name||'私聊')}</b><p>${m.recalled?'原消息已撤回':esc(m.text||'[文件引用]')}</p><small>${esc(imTime(m.created_at))}</small><div><button class="btn btn-ghost btn-sm" onclick="imCloseNew();imOpenChat('${esc(m.chat_id)}');imLocatedId='${esc(m.id)}';imChangeWindow({around:'${esc(m.id)}'})">查看上下文</button><button class="btn btn-ghost btn-sm" onclick="imRemoveFavorite('${esc(m.chat_id)}','${esc(m.id)}')">取消收藏</button></div></article>`).join('')||'<p>尚未收藏消息。消息下方点“收藏”即可保留入口。</p>';
 }catch(e){if(host?.isConnected&&epoch===imModalEpoch)host.textContent='收藏暂不可用：'+e.message;}
}
async function imRemoveFavorite(chat,id){
 try{const r=await api(`api/im/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(id)}/favorite`,{method:'POST',body:JSON.stringify({favorite:false})}).then(r=>r.json());if(!r.ok)throw Error(r.error);await imOpenFavorites();if(chat===imCurChat)imRenderMsgs(false);}catch(e){toast('未取消收藏',e.message);}
}
function imReadDetails(id){
 const m=imMessages.find(m=>m.id===id);if(!m||m.sender_id!==currentUserInfo?.username||!m.read_by)return;
 const members=(imChats.find(c=>c.id===imCurChat)?.member_ids||[]).filter(x=>x!==currentUserInfo.username),unread=members.filter(x=>!m.read_by.includes(x));
 imModalShow('消息阅读状态',`<p class="im-muted">表示对方在前台查看到了该消息，不代表同意或已办理。</p><h4>已读 ${m.read_by.length}</h4><p>${m.read_by.map(imUserName).map(esc).join('、')||'暂无'}</p><h4>未读 ${unread.length}</h4><p>${unread.map(imUserName).map(esc).join('、')||'暂无'}</p>`,'<button class="btn btn-ghost" onclick="imCloseNew()">关闭</button>');
}
function imOpenForward(id){
 const m=imMessages.find(m=>m.id===id&&!m.recalled);if(!m)return;
 const source=imCurChat;
 imModalShow('转发消息',`<p class="im-muted">将生成目标会话中的独立消息。原消息撤回不会删除已转发副本；文件沿用原权限，@不会再次提醒。</p><blockquote class="im-forward-preview">${esc(m.text||'[文件引用]')}</blockquote><label class="im-label" for="im-forward-target">发送到</label><select id="im-forward-target">${imChats.filter(c=>c.id!==source).map(c=>`<option value="${esc(c.id)}">${esc(imChatName(c))}</option>`).join('')}</select>`,'<button class="btn btn-ghost" onclick="imCloseNew()">取消</button>'+`<button id="im-forward-send" class="btn btn-pri" onclick="imForward('${esc(source)}','${esc(id)}')">确认转发</button>`);
}
async function imForward(source,id){
 const target=$('#im-forward-target')?.value;if(!target){toast('请先创建目标会话','');return;}const button=$('#im-forward-send');if(button?.disabled)return;if(button)button.disabled=true;
 const cacheKey=JSON.stringify([source,id,target]),key=imForwardKeys.get(cacheKey)||crypto.randomUUID();imForwardKeys.set(cacheKey,key);
 try{const r=await api(`api/im/chats/${encodeURIComponent(source)}/messages/${encodeURIComponent(id)}/forward`,{method:'POST',body:JSON.stringify({target_chat_id:target,confirmed:true,client_msg_id:key})}).then(r=>r.json());if(!r.ok)throw Error(r.error);imForwardKeys.delete(cacheKey);imCloseNew();await imLoadChats();imRenderList(true);toast('已转发','');}
 catch(e){toast('转发未确认',e.message+'；再次点击会使用原编号重试');}finally{if(button?.isConnected)button.disabled=false;}
}
async function imFileVersion(ref){
 const response=await api('api/platform/services/files.versions/invoke',{method:'POST',body:JSON.stringify({payload:{attachment:ref.file}})}),data=await response.json(),r=data.result||data;
 if(response.ok===false||data.ok===false||r.file?.name!==ref.ref_name)throw Error('文件不可用或无权访问');const version=r.versions?.find(v=>v.source?.file===ref.file);if(!version)throw Error('固定版本不可用');return {name:r.file.file_name,version:version.version_no,size:version.size,source:version.source};
}
async function imHydrateFiles(){
 const generation=imGeneration,owner=currentUserInfo?.username;
 const nodes=[...document.querySelectorAll('#im-msgs [data-im-file]')];
 for(let start=0;start<nodes.length;start+=3)await Promise.all(nodes.slice(start,start+3).map(async el=>{
  const ref={ref_name:el.dataset.refName,file:el.dataset.imFile},cacheKey=JSON.stringify([owner,ref.ref_name,ref.file]);
  let cached=imFileCache.get(cacheKey);
  if(!cached||Date.now()-cached.time>20000){try{cached={time:Date.now(),data:await imFileVersion(ref)};}catch{cached={time:Date.now(),error:true};}if(generation===imGeneration&&owner===currentUserInfo?.username)imFileCache.set(cacheKey,cached);}
  if(!el.isConnected||generation!==imGeneration||owner!==currentUserInfo?.username)return;
  if(cached.error){delete el.dataset.loaded;el.textContent='文件不可用或无权访问（可能已回收或文件域已停用）';return;}
  const m=cached.data,url='/api/platform/file-content?'+new URLSearchParams({ref:m.source.ref_doctype,ref_name:m.source.ref_name,file:m.source.file}),image=/\.(png|jpe?g)$/i.test(m.name);
  const fingerprint=JSON.stringify(m);if(el.dataset.loaded===fingerprint)return;el.dataset.loaded=fingerprint;
  el.innerHTML=`<a href="${esc(url)}" target="_blank" rel="noopener">${image?`<img src="${esc(url)}" alt="${esc(m.name)}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>图片暂不可读</span>`:''}<b>${esc(m.name)}</b><small>第 ${m.version} 版 · ${(m.size/1024).toFixed(1)} KB · 打开 / 下载</small></a>`;
 }));
}
function imOpenFilePicker(){
 if(!imCanEditExtras())return;imPicker={chat:imCurChat,generation:imGeneration,page:1,q:'',sequence:0,rows:[]};
 imModalShow('选择文件中心文件',`<p class="im-muted">发送当前固定版本，不复制文件、不改变权限；接收人须有原文件读权。</p><div class="im-picker-search"><input id="im-file-search" type="search" placeholder="搜索文件名或标签" aria-label="搜索可发送文件"><button class="btn btn-ghost" onclick="imPicker.q=$('#im-file-search').value;imPicker.page=1;imPickerLoad()">搜索</button></div><div id="im-file-options">${imFileOptionsSkeleton()}</div><div id="im-file-pages"></div>`,'<button class="btn btn-ghost" onclick="imCloseNew()">取消</button><a class="btn btn-ghost" href="index.html#/file-center" target="_blank" rel="noopener">去文件中心上传</a>');imPickerLoad();
}
async function imPickerLoad(){
 const p=imPicker,el=$('#im-file-options');if(!p||!el)return;const sequence=++p.sequence;el.innerHTML=imFileOptionsSkeleton();
 try{const params=new URLSearchParams({page:String(p.page),page_length:'20',filters:JSON.stringify({scope:'all',q:p.q})}),r=await apiJSON('api/platform/datasets/files.file/records?'+params);if(r.ok===false)throw Error(r.error);if(p!==imPicker||sequence!==p.sequence||!el.isConnected||p.generation!==imGeneration)return;
 p.rows=r.rows||[];el.innerHTML=p.rows.map((f,i)=>`<button class="im-picker-row" onclick="imChooseFile(${i})"><b>${esc(f.file_name)}</b><small>${esc(f.directory||'/')} · ${(Number(f.current_size||0)/1024).toFixed(1)} KB</small></button>`).join('')||'<p>没有可访问的匹配文件</p>';
 $('#im-file-pages').innerHTML=`<button class="btn btn-ghost btn-sm" ${p.page<=1?'disabled':''} onclick="imPicker.page--;imPickerLoad()">上一页</button><span>第 ${p.page} 页</span><button class="btn btn-ghost btn-sm" ${p.page*20>=Number(r.total||0)?'disabled':''} onclick="imPicker.page++;imPickerLoad()">下一页</button>`;
 }catch(e){if(el.isConnected)el.textContent='文件中心暂不可用或未启用，请稍后重试；文字消息仍可正常使用。';}
}
async function imChooseFile(index){
 const p=imPicker,f=p?.rows[index];if(!f)return;
 try{const response=await api('api/platform/services/files.versions/invoke',{method:'POST',body:JSON.stringify({payload:{file:f.name}})}),d=await response.json(),r=d.result||d;if(response.ok===false||d.ok===false||r.file?.status!=='Active')throw Error(d.error||'文件不可用');const v=r.versions?.find(v=>v.version_no===r.file.version);if(!v)throw Error('当前版本不可用');
 if(imPicker!==p||p.chat!==imCurChat||p.generation!==imGeneration)return;imAddFileDraft({ref_name:f.name,file:v.source.file},r.file.file_name);imCloseNew();
 }catch(e){toast('无法添加文件',e.message);}
}
function imNotificationEnabled(){try{return localStorage.getItem('ss-im-notify:'+currentUserInfo?.username)==='1'&&typeof Notification!=='undefined'&&Notification.permission==='granted';}catch{return false;}}
async function imToggleNotifications(){
 if(typeof Notification==='undefined'||!window.isSecureContext){toast('当前浏览器不支持桌面通知','可继续使用消息内未读标记');return;}
 try{const key='ss-im-notify:'+currentUserInfo?.username;if(imNotificationEnabled()){localStorage.removeItem(key);}else{const permission=await Notification.requestPermission();if(permission!=='granted'){toast('未开启桌面通知','可在浏览器网站设置中调整；不会重复弹窗');return;}localStorage.setItem(key,'1');imNoticeStarted=false;toast('桌面通知已开启','仅网页保持打开时提醒；不显示消息正文。');}
 const button=$('#im-notify-toggle');if(button)button.textContent=imNotificationEnabled()?'关闭桌面通知':'开启桌面通知';}catch{toast('桌面通知不可用','消息本身不受影响');}
}
function imMaybeNotify(chats){
 const owner=currentUserInfo?.username||'';if(owner!==imNoticeOwner){imNoticeOwner=owner;imNoticeSeen.clear();imNoticeStarted=false;}
 for(const c of chats){const id=c.last_msg?.id,previous=imNoticeSeen.get(c.id);imNoticeSeen.set(c.id,id);
  if(!imNoticeStarted||!id||id===previous||!c.unread||c.muted||c.last_msg.recalled||c.last_msg.sender_id===owner||!imNotificationEnabled()||document.visibilityState!=='hidden'&&$('#im-msgs')&&c.id===imCurChat)continue;
  try{const key='ss-im-notified:'+owner+':'+c.id;if(localStorage.getItem(key)===id)continue;localStorage.setItem(key,id);const notice=new Notification('尚书 · 新消息',{body:c.mention_unread?'有同事在会话中提及你':'有新的工作消息，点击查看',tag:'shangshu-im-'+c.id});notice.onclick=()=>{window.focus();if(typeof go==='function')go('im');imCurChat=c.id;if($('#im-msgs'))imOpenChat(c.id);notice.close();};}catch{/* 浏览器或系统不支持时不影响消息 */}
 }imNoticeStarted=true;
}
// 页面离开消息工作面后，仅开启桌面通知的用户继续有界轮询；不新建推送服务。
let imBackgroundPolling=false;
setInterval(async()=>{if(!imNotificationEnabled()||$('#im-msgs')||imBackgroundPolling)return;imBackgroundPolling=true;const owner=currentUserInfo?.username;try{const r=await apiJSON('api/im/chats');if(owner===currentUserInfo?.username){imMaybeNotify(r.list||[]);updateImBadge((r.list||[]).reduce((n,c)=>n+(c.muted?0:c.unread||0),0));}}catch{}finally{imBackgroundPolling=false;}},15000);

function imSaveDraft() {
  const input=$('#im-input');
  if(input&&imCurChat)imDrafts.set(imCurChat,input.value);
}
function imRestoreDraft() {
  const input=$('#im-input');if(input)input.value=imDrafts.get(imCurChat)||'';
  imRenderSendState();
  imRenderReply();
  imRenderExtras();
}
function imComposerKey(event) {
  if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();imSendInput();}
}
window.addEventListener('beforeunload',event=>{
  imSaveDraft();
  if([...imDrafts.values()].some(s=>s.trim())||imPendingSends.size||[...imExtras.values()].some(e=>e.files.length)){event.preventDefault();event.returnValue='';}
});
function imRenderSendState() {
  const button=$('#im-send');if(button)button.disabled=imBusy;
  const state=$('#im-send-state');if(!state)return;
  const pending=imPendingSends.get(imCurChat);
  state.innerHTML=pending?(pending.sending?'正在发送…':`<span>发送未确认 · ${esc(pending.text.slice(0,60))}</span><button class="btn btn-ghost btn-sm" onclick="imRetrySend()" ${imBusy?'disabled':''}>重试发送</button>`):'Enter 发送 · Shift + Enter 换行';
}
function imRetrySend(){const p=imPendingSends.get(imCurChat);if(p&&!p.sending)return imSend(p.text);}
function imFilterChats(){imQuery=$('#im-search')?.value||'';imRenderList(true);}
function imFilterMessages(){imMessageQuery=($('#im-message-search')?.value||'').slice(0,200);imMessageSender=$('#im-message-sender')?.value||'';imMessageDate=$('#im-message-date')?.value||'';imMentionOnly=!!$('#im-mention-only')?.checked;imHistoryLimit=80;imLocatedId='';
 if(!imWindowed)return imDrawMessages(false);clearTimeout(imSearchTimer);++imMessageRequest;imPageAnchor={};imSearchTimer=setTimeout(()=>imRenderMsgs(true),180);
}

function imLoadError(error) {
  const host=document.querySelector('.im-list');if(!host)return;
  let box=host.querySelector('[data-im-error]');
  if(!box){box=document.createElement('div');box.dataset.imError='';box.className='platform-error';box.setAttribute('role','alert');host.prepend(box);}
  box.innerHTML=`<span>消息服务暂时不可用：${esc(error.message||error)}</span><button class="btn btn-ghost btn-sm" type="button">重试</button>`;
  box.querySelector('button').onclick=()=>RENDER.im();
}

// 选人接口刻意排除本人；群成员、头像与 AI 摘要仍需使用会话里的本人姓名。
function imUser(u) { return u === currentUserInfo?.username ? currentUserInfo : imUsers.find(x => x.username === u); }
function imUserName(u) { const x = imUser(u); return x?.display_name || u; }

function imChatsFingerprint(list) {
  return (list || []).map((c) =>
    JSON.stringify([c.id,c.name,c.member_ids,c.unread,c.mention_unread,c.last_msg,c.pinned,c.muted])
  ).join(';');
}
function imMsgsFingerprint(msgs) {
  return (msgs || []).map((m) => JSON.stringify([m.id,m.created_at,m.text,m.recalled,m.reply,m.mentions,m.files,m.favorite,m.forwarded,m.read_by,m.recipient_count])).join(';');
}

async function imLoadUsers() {
  const generation=imGeneration;
  try { const result=await apiJSON('api/im/users');if(generation!==imGeneration)return false;imUsers=result.list||[];return true; } catch(error) { if(generation===imGeneration)imLoadError(error); return false; }
}
async function imLoadChats() {
  const generation=imGeneration;
  try {
    const { list } = await apiJSON('api/im/chats');
    if(generation!==imGeneration)return null;
    imMaybeNotify(list||[]);
    imChats = list || [];
    updateImBadge(imChats.reduce((s, c) => s + (c.muted?0:(c.unread || 0)), 0));
    if (imCurChat && !imChats.find(c => c.id === imCurChat)) {imSaveDraft();imCurChat=null;imMessages=[];imMessagesChat=null;imRestoreDraft();}
    return imChats;
  } catch(error) { if(generation===imGeneration)imLoadError(error); return null; }
}
async function imLoadMessages(chatId) {
  const generation=imGeneration;
  try {const p=new URLSearchParams({page:'1',limit:'80',...imPageAnchor});if(imMessageQuery)p.set('q',imMessageQuery);if(imMessageSender)p.set('sender',imMessageSender);if(imMentionOnly)p.set('mentioned','1');if(imMessageDate){const from=new Date(imMessageDate+'T00:00:00'),to=new Date(from);to.setDate(to.getDate()+1);p.set('from',from.toISOString());p.set('to',to.toISOString());}
    const result=await apiJSON(`api/im/chats/${encodeURIComponent(chatId)}/messages?${p}`);if(result.ok===false)throw Error(result.error||'消息读取失败');return Object.assign(result.list||[],{pageInfo:result});
  } catch(error) { if(generation===imGeneration&&imCurChat===chatId)imLoadError(error); throw error; }
}
// 查看到某条消息即按消息 ID 推进已读游标（服务端只前进不后退，重复提交幂等）
async function imMarkRead(chatId, messageId) {
  try {
    await api(`api/im/chats/${chatId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
    if (imCurChat === chatId) await imLoadChats().then(() => imRenderList(false));
  } catch { /* 已读失败不打断消息查看，下次查看会重试 */ }
}

function imSyncChatPane() {
  const input = document.querySelector('.im-input');
  if (input) input.style.display = imCurChat ? '' : 'none';
  const el = $('#im-msgs');
  if (!imCurChat && el) {
    el.innerHTML = '<div class="im-empty">选择左侧会话，或点右上角 + 发起私聊/建群</div>';
    imMsgFp = '';
  }
}

// 草稿和未知回执分别按会话保存；重试同一条使用原幂等键，不把失败消息塞进另一会话。
async function imSend(text) {
  if (imBusy) return;
  if (!imCurChat) { toast('请先选择会话', ''); return; }
  const chatId=imCurChat, owner=currentUserInfo?.username, generation=imGeneration;
  const prior=imPendingSends.get(chatId);
  if(prior&&prior.text!==text){toast('请先重试上一条消息','草稿已保留，确认上一条的发送结果后再发送下一条。');return;}
  if(navigator.onLine===false){toast('当前离线，内容已保留','网络恢复后再发送');return;}
  imSaveDraft();
  imBusy = true;
  const key=prior?.key||(crypto.randomUUID?crypto.randomUUID():'c-'+Date.now()+'-'+Math.random().toString(36).slice(2));
  const replyTo=prior?.replyTo||imReplies.get(chatId)||'';
  const extras=prior?.extras||JSON.parse(JSON.stringify(imDraftExtras()));
  const pending={text,key,replyTo,extras,sending:true};imPendingSends.set(chatId,pending);
  const input=$('#im-input');
  if(input?.value.trim()===text){input.value='';imDrafts.set(chatId,'');}
  imRenderSendState();imRenderReply();imRenderExtras();
  try {
    const response = await api(`api/im/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', body: JSON.stringify({ text, client_msg_id: key, reply_to:replyTo,...extras }) });
    const r=await response.json();
    if (!r.ok) {const error=new Error(r.error||'服务暂不可用');error.status=response.status;throw error;}
    if(owner!==currentUserInfo?.username)return;
    imPendingSends.delete(chatId);
    imReplies.delete(chatId);imExtras.delete(chatId);imRenderReply();imRenderExtras();
    if(generation!==imGeneration)return;
    imMsgFp = '';
    if(imCurChat===chatId){imPageAnchor={};imLocatedId='';imResetMessageFilters();await imRenderMsgs(true);}
    await imLoadChats();
    imRenderList(true);
  } catch (error) {
    if(owner!==currentUserInfo?.username)return;
    pending.sending=false;
    if([400,403,404,409].includes(error.status))imPendingSends.delete(chatId);
    if(!imDrafts.get(chatId)?.trim())imDrafts.set(chatId,text);
    if(imCurChat===chatId&&generation===imGeneration)imRestoreDraft();
    toast('发送失败，内容已保留', (error && error.message) || '网络异常，请重试');
  } finally { imBusy=false;if(owner===currentUserInfo?.username)imRenderSendState(); }
}

function imAvatarHtml(c) {
  if (c.type === 'group') {
    const members = c.member_ids.slice(0, 3).map(u => {
      const n = imUserName(u);
      return `<span style="display:inline-block;width:14px;height:14px;border-radius:2px;background:${imColorOf(u)};color:#fff;font-size:7px;text-align:center;line-height:14px;">${esc(n.slice(0, 1))}</span>`;
    }).join('');
    return `<div class="im-av-group">${members}</div>`;
  }
  const peer = c.member_ids.find(u => u !== currentUserInfo?.username) || c.member_ids[0];
  const n = imUserName(peer);
  return `<div class="im-av" style="background:${imColorOf(peer)}">${esc(n.slice(0, 1))}</div>`;
}
function imChatName(c) {
  if (c.type === 'group') return c.name;
  const peer = c.member_ids.find(u => u !== currentUserInfo?.username) || c.member_ids[0];
  return imUserName(peer);
}
function imChatSub(c) {
  if (c.type === 'group') return `${c.member_ids.length} 名成员`;
  const peer = c.member_ids.find(u => u !== currentUserInfo?.username) || '';
  return imUser(peer)?.role ? (imUser(peer).role === 'admin' ? '管理员' : imUser(peer).role === 'manager' ? '项目负责人' : imUser(peer).role === 'finance' ? '会计' : '员工') : '';
}
const imTime = (s) => {if(!s)return '';const d=new Date(s),pad=n=>String(n).padStart(2,'0');return Number.isNaN(d.getTime())?'':`${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;};

async function imAskAi() {
  const chat = imChats.find(c => c.id === imCurChat);
  if (!chat || typeof chatAssist !== 'function') return toast('AI 助手未就绪','请先选择会话或刷新页面');
  const generation=imGeneration;
  let msgs;try{msgs=(await apiJSON(`api/im/chats/${encodeURIComponent(chat.id)}/messages?page=1&limit=30`)).list||[];}catch{return;}
  if(generation!==imGeneration||chat.id!==imCurChat)return;
  const transcript = msgs.slice(-30).map(m => `${imUserName(m.sender_id)}：${m.recalled ? '[已撤回]' : m.text}`).join('\n').slice(-6000);
  chatAssist({module:'im',view:'conversation',entity_type:'chat',entity_id:chat.id,label:`会话 · ${imChatName(chat)}`,editable_scope:'总结当前会话；如需派发任务，必须转成 task 对象提案并等待确认'},`请阅读下面这段当前会话，先总结结论、分歧和待办；待办请整理成“结果、负责人、截止时间、验收标准”。不要直接发送消息或派任务，我确认后再通过通用对象动作提案。\n\n${transcript || '（当前会话暂无消息）'}`);
}

/** @param {boolean} [force] 强制重绘；轮询无变则跳过，避免 rise 动画反复播 */
function imRenderList(force) {
  const el = $('#im-list');
  if (!el) return;
  const fp = imChatsFingerprint(imChats) + '|' + (imCurChat || '')+'|'+imQuery+'|'+imUnreadOnly;
  if (!force && fp === imListFp) return;
  imListFp = fp;
  const query=imQuery.trim().toLocaleLowerCase();
  const visible=imChats.filter(c=>(!imUnreadOnly||c.unread>0)&&(!query||[imChatName(c),c.last_msg?.recalled?'':c.last_msg?.text,...c.member_ids.map(imUserName)].some(s=>String(s||'').toLocaleLowerCase().includes(query))));
  el.innerHTML = visible.map((c) => {
    const last = c.last_msg;
    const preview = last ? (last.recalled ? '[已撤回]' : last.text.slice(0, 26) + (last.text.length > 26 ? '…' : '')) : '暂无消息';
    return `
      <button type="button" class="im-item ${c.id === imCurChat ? 'on' : ''}" onclick="imOpenChat('${esc(c.id)}')" aria-label="${esc(imChatName(c))}${c.unread?'，'+c.unread+' 条未读':''}">
        ${imAvatarHtml(c)}
        <div class="im-item-info">
          <div class="im-item-top">
            <span class="im-item-name">${c.pinned?'<span class="im-pin" title="已置顶">置顶</span> ':''}${esc(imChatName(c))}</span>
            <span class="im-item-time">${last ? imTime(last.created_at) : ''}</span>
          </div>
          <div class="im-item-preview">${c.mention_unread?'<span class="im-mention-badge">[有人@我] </span>':''}${c.muted?'<span title="消息免打扰">免打扰 · </span>':''}${esc(preview)}</div>
        </div>
        ${c.unread ? `<span class="im-unread ${c.muted?'muted':''}">${c.unread}</span>` : ''}
      </button>`;
  }).join('') || `<div class="im-empty im-list-empty">${query||imUnreadOnly?'没有符合条件的会话':'还没有会话，点右上角 + 发起私聊或建群'}</div>`;
}

async function imRenderMsgs(force) {
  const el = $('#im-msgs');
  const request=++imMessageRequest;
  const chatId=imCurChat, generation=imGeneration;
  if (!el) return;
  const chat = imChats.find(c => c.id === imCurChat);
  if (!chat) {
    imSyncChatPane();
    return;
  }
  const me = currentUserInfo?.username || '';
  let msgs;
  try { msgs = await imLoadMessages(chatId); } catch { return; }
  if (request!==imMessageRequest || generation!==imGeneration || chatId!==imCurChat || el!==$('#im-msgs')) return;
  imMessages=msgs;imMessagesChat=chatId;
  if(msgs.pageInfo?.window){imWindowed=true;imHasEarlier=imPageAnchor.after?true:!!msgs.pageInfo.has_more;imHasNewer=imPageAnchor.before?true:imPageAnchor.around?!!msgs.pageInfo.has_newer:imPageAnchor.after?!!msgs.pageInfo.has_more:false;}
  imRenderReply();
  const fp = (imCurChat || '') + '|' + imMsgsFingerprint(msgs);
  if (!force && fp === imMsgFp) {imReadVisible();imHydrateFiles();return;}
  imMsgFp = fp;
  imDrawMessages(force);
  if(imLocatedId){const node=[...document.querySelectorAll('[data-message-id]')].find(n=>n.dataset.messageId===imLocatedId);node?.scrollIntoView?.({block:'center'});}
}
function imPaneVisible(){return document.visibilityState!=='hidden'&&(window.innerWidth>768||!!document.querySelector('.im-layout.m-open'));}
function imReadVisible(){
  const el=$('#im-msgs'),chat=imChats.find(c=>c.id===imCurChat);
  if(!el||!chat||imMessagesChat!==imCurChat||imHasMessageFilter()||imLocatedId||imHasNewer||!imPaneVisible()||el.scrollHeight-el.scrollTop-el.clientHeight>48)return;
  const last=imMessages.at(-1);
  if(last&&chat.unread>0)imMarkRead(chat.id,last.id);
  const jump=$('#im-new-messages');if(jump)jump.hidden=true;
}
function imJumpLatest(){imResetMessageFilters();imLocatedId='';imHistoryLimit=80;if(imWindowed)return imChangeWindow({});imDrawMessages(true);}
async function imChangeWindow(anchor){imPageAnchor=anchor;imMsgFp='';await imRenderMsgs(true);}
function imDrawMessages(force){
  const el=$('#im-msgs');if(!el||imMessagesChat!==imCurChat)return;
  const query=imMessageQuery.trim().toLocaleLowerCase();
  const matching=imMessages.filter(m=>(!query||(!m.recalled&&String(m.text||'').toLocaleLowerCase().includes(query)))&&(!imMessageSender||m.sender_id===imMessageSender)&&(!imMessageDate||imLocalDay(m.created_at)===imMessageDate)&&(!imMentionOnly||(m.mentions||[]).includes(currentUserInfo?.username)));
  const msgs=matching.slice(-imHistoryLimit);
  const me=currentUserInfo?.username||'';
  const stickBottom=!imHasMessageFilter()&&!imLocatedId&&(force||el.scrollHeight-el.scrollTop-el.clientHeight<48);
  const previousTop=el.scrollTop;
  let lastDay='';
  const markup = msgs.map((m) => {
    const day=imLocalDay(m.created_at),dateHeading=day&&day!==lastDay?`<div class="im-day">${esc(day)}</div>`:'';lastDay=day;
    const isMe = m.sender_id === me;
    const sender = imUser(m.sender_id);
    // 撤回：仅本人、2 分钟内（与服务端 RECALL_WINDOW_MS 一致）
    const canRecall = isMe && !m.recalled && (Date.now() - new Date(m.created_at).getTime() < 120000);
    return `
      ${dateHeading}<div class="im-msg ${isMe ? 'self' : ''} ${imLocatedId===m.id?'im-highlight':''}" data-message-id="${esc(m.id)}">
        ${!isMe ? `<div class="im-av sm" style="background:${imColorOf(m.sender_id)}">${esc(imUserName(m.sender_id).slice(0, 1))}</div>` : ''}
        <div class="im-msg-body">
          ${!isMe ? `<div class="im-msg-name">${esc(imUserName(m.sender_id))}${sender?.role && sender.role !== 'staff' ? ' · ' + ({ manager: '项目负责人', finance: '会计', admin: '管理员' })[sender.role] : ''}</div>` : ''}
          ${m.recalled
            ? `<div class="im-bubble recalled">${isMe ? '你' : esc(imUserName(m.sender_id))}撤回了一条消息</div>`
            : `<div class="im-bubble">${m.forwarded?'<div class="im-forward-label">转发的消息</div>':''}${m.reply?(m.reply.recalled?'<div class="im-quote unavailable">原消息已撤回或不可用</div>':`<button class="im-quote" onclick="imLocateMessage('${esc(m.reply.id)}')" title="查看原消息"><b>${esc(imUserName(m.reply.sender_id))}</b><span>${esc(m.reply.text)}</span></button>`):''}${(m.mentions||[]).map(id=>`<span class="im-mention-badge">@${esc(imUserName(id))} </span>`).join('')}${esc(m.text)}${(m.files||[]).map(ref=>`<div class="im-file-card" data-im-file="${esc(ref.file)}" data-ref-name="${esc(ref.ref_name)}">正在核对文件权限…</div>`).join('')}</div>`}
          <div class="im-msg-time">${imTime(m.created_at)}${!m.recalled?`<button class="im-message-action" onclick="imReplyTo('${esc(m.id)}')">回复</button><button class="im-message-action" onclick="imCopyMessage('${esc(m.id)}')">复制</button><button class="im-message-action" onclick="imFavorite('${esc(m.id)}',${!m.favorite})">${m.favorite?'已收藏':'收藏'}</button><button class="im-message-action" onclick="imOpenForward('${esc(m.id)}')">转发</button>${imHasMessageFilter()?`<button class="im-message-action" onclick="imLocateMessage('${esc(m.id)}')">查看上下文</button>`:''}`:''}${canRecall ? `<button class="im-message-action" onclick="imRecallMsg('${esc(imCurChat)}','${esc(m.id)}')">撤回</button>` : ''}${!m.recalled&&isMe&&Array.isArray(m.read_by)?`<button class="im-message-action im-read-state" onclick="imReadDetails('${esc(m.id)}')">${m.read_by.length?'已读 '+m.read_by.length+'/'+m.recipient_count:'未读'}</button>`:''}</div>
        </div>
        ${isMe ? `<div class="im-av sm" style="background:${imColorOf(m.sender_id)}">${esc(imUserName(m.sender_id).slice(0, 1))}</div>` : ''}
      </div>`;
  }).join('');
  el.innerHTML=(imWindowed?imHasEarlier:matching.length>msgs.length)?`<button class="im-earlier" onclick="imShowEarlier()">查看更早的${imHasMessageFilter()?'匹配':''}消息</button>`:'';
  el.innerHTML+=(markup||`<div class="im-empty">${imHasMessageFilter()?'没有找到匹配的消息':'还没有消息，说点什么吧'}</div>`)+(imHasNewer?'<button class="im-earlier" onclick="imChangeWindow({after:imMessages.at(-1)?.id})">查看较新的消息</button>':'');
  el.scrollTop=stickBottom?el.scrollHeight:previousTop;
  const jump=$('#im-new-messages');if(jump)jump.hidden=(!imHasNewer&&stickBottom)||!imMessages.length;
  const count=$('#im-search-count');if(count)count.textContent=imHasMessageFilter()?`${matching.length} 条${imWindowed?'本页':''}匹配`:'';
  imHydrateFiles();
  imReadVisible();
}
async function imCopyMessage(id){
  const message=imMessages.find(m=>m.id===id&&!m.recalled);if(!message)return;
  try{await navigator.clipboard.writeText(message.text);toast('已复制','');}catch{toast('无法访问剪贴板','可选中文字后复制');}
}

async function imRenderHeader() {
  const chat = imChats.find(c => c.id === imCurChat);
  const hd = $('#im-hd');
  if (!hd) return;
  if (!chat) { hd.innerHTML = ''; return; }
  hd.innerHTML = `
    <button class="im-back" onclick="imBackToList()" title="返回会话列表" style="display:none">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <div class="im-hd-info">
      <div class="im-hd-name">${esc(imChatName(chat))}</div>
      <div class="im-hd-sub">${imChatSub(chat)}</div>
    </div>
    <button class="btn btn-ghost" onclick="imAskAi()">✦ AI 总结 / 转任务</button>
    ${chat.type === 'group'
      ? `<button class="btn btn-ghost" onclick="imOpenManage()">群管理</button>`
      : `<button class="btn btn-ghost" onclick="imOpenManage()">会话管理</button>`}`;
}

function imOpenChat(id) {
  imSaveDraft();
  imCurChat = id;
  imResetMessageFilters();imPageAnchor={};imHasEarlier=false;imHasNewer=false;imHistoryLimit=80;imLocatedId='';imMessages=[];imMessagesChat=null;
  const search=$('#im-message-search');if(search)search.value='';
  const count=$('#im-search-count');if(count)count.textContent='';
  const jump=$('#im-new-messages');if(jump)jump.hidden=true;
  const chat = imChats.find(c => c.id === id);
  imListFp = '';
  imMsgFp = '';
  imRenderList(true);
  imRenderHeader();
  const senderFilter=$('#im-message-sender');if(senderFilter)senderFilter.innerHTML='<option value="">所有成员</option>'+(chat?.member_ids||[]).map(id=>`<option value="${esc(id)}">${esc(imUserName(id))}</option>`).join('');
  imSyncChatPane();
  imRestoreDraft();
  const msgs=$('#im-msgs');if(msgs)msgs.innerHTML=imMessagesSkeleton();
  imRenderMsgs(true);
  if (chat && typeof chatSetBusinessContext === 'function') chatSetBusinessContext({module:'im',view:'conversation',entity_type:'chat',entity_id:id,label:`会话 · ${imChatName(chat)}`,editable_scope:'当前会话摘要与待办提取；发送消息或创建任务须走确认契约'});
  const layout = $('.im-layout');
  if (layout && window.innerWidth <= 768) layout.classList.add('m-open');
}
function imBackToList() {
  $('.im-layout')?.classList.remove('m-open');
}

async function imSendInput() {
  const input = document.getElementById('im-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text&&!imDraftExtras().files.length) return;
  imSaveDraft();
  await imSend(text);
}

// 弹窗共用：发起会话 / 群管理 都走这一个骨架（#im-modal 根节点在 RENDER.im 里，带点空白关闭）
function imModalShow(hd, bd, ft) {
  ++imModalEpoch;
  const modal = $('#im-modal');
  if (!modal) return;
  modal.innerHTML = `<div class="im-modal-box">
    <div class="im-modal-hd">${hd}</div>
    <div class="im-modal-bd">${bd}</div>
    <div class="im-modal-ft">${ft}</div>
  </div>`;
  modal.style.display = 'flex';
}

function imOpenNew() {
  ++imModalEpoch;imPicker=null;
  imModalShow('发起会话', `
    <label class="im-label">选择成员（选 1 人 = 私聊，多人 = 建群）</label>
    <div class="im-member-list" id="im-new-list">${imUsers.map(u => {
      const n = u.display_name || u.username;
      const roleTxt = ({manager:'项目负责人',finance:'会计',admin:'管理员',staff:'员工'})[u.role] || '';
      return `
        <label class="im-member-check">
          <input type="checkbox" value="${esc(u.username)}">
          <div class="im-av sm" style="background:${imColorOf(u.username)}">${n.slice(0, 1)}</div>
          <span>${esc(n)}</span><span class="im-member-role">${roleTxt}</span>
        </label>`;
    }).join('')}</div>
    <label class="im-label" style="margin-top:12px">群名称（多人时使用）</label>
    <input type="text" id="im-new-name" class="im-input-field" value="新群聊">`,
    `<button class="btn btn-ghost" onclick="imCloseNew()">取消</button>
     <button class="btn btn-pri" onclick="imCreateNew()">发起</button>`);
}
function imCloseNew() { ++imModalEpoch;imPicker=null;const modal=document.getElementById('im-modal');if(modal)modal.style.display = 'none'; }

/* —— 群管理 / 会话管理（2026-08-27） —— */
function imOpenManage() {
  const chat = imChats.find(c => c.id === imCurChat);
  if (!chat) return;
  const me = currentUserInfo?.username || '';
  const isOwner = chat.created_by === me;
  const isAdmin = currentUserInfo?.role === 'admin';
  const canManage = isOwner || isAdmin;
  if (chat.type === 'dm') {
    const peer = chat.member_ids.find(u => u !== me) || '';
    const usr = imUser(peer);
    imModalShow('会话信息', `${imPreferencesHtml(chat)}
      <div class="im-mem-row">
        <div class="im-av sm" style="background:${imColorOf(peer)}">${imUserName(peer).slice(0, 1)}</div>
        <span class="im-mem-name">${esc(imUserName(peer))}</span>
        <span class="im-member-role">${usr ? ({ manager: '项目负责人', finance: '会计', admin: '管理员', staff: '员工' })[usr.role] || '' : ''}</span>
      </div>
      <div style="margin-top:14px;color:var(--fg3);font-size:12px;line-height:1.7">移出后此会话不再出现在你的列表；对方的聊天记录不受影响，重新发起私聊会自动恢复。</div>`,
      `<button class="btn btn-ghost" onclick="imCloseNew()">关闭</button>
       <button class="btn btn-ghost" style="color:var(--red)" onclick="imDeleteDm('${chat.id}')">移出我的列表</button>`);
    return;
  }
  const candidates = imUsers.filter(u => !chat.member_ids.includes(u.username));
  imModalShow(`群管理 · ${esc(chat.name)}`, `${imPreferencesHtml(chat)}
    ${canManage ? `
      <label class="im-label">群名称</label>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input class="im-input-field" id="im-grp-name" value="${esc(chat.name)}">
        <button class="btn btn-ghost" style="flex-shrink:0" onclick="imSaveGroupName('${chat.id}')">保存</button>
      </div>` : ''}
    <label class="im-label">成员（${chat.member_ids.length}）</label>
    <div class="im-member-list">${chat.member_ids.map(u => {
      const n = imUserName(u);
      const usr = imUser(u);
      const ownerTag = u === chat.created_by ? '<span class="im-mem-owner">群主</span>' : '';
      const rmBtn = canManage && u !== chat.created_by
        ? `<button class="btn btn-ghost" style="padding:2px 8px;font-size:11.5px;color:var(--red)" onclick="imRemoveMember('${chat.id}','${esc(u)}','${esc(n)}')">移除</button>` : '';
      return `<div class="im-mem-row">
        <div class="im-av sm" style="background:${imColorOf(u)}">${n.slice(0, 1)}</div>
        <span class="im-mem-name">${esc(n)}${u === me ? '（我）' : ''}</span>
        ${ownerTag}
        <span class="im-member-role">${usr ? ({ manager: '项目负责人', finance: '会计', admin: '管理员', staff: '员工' })[usr.role] || '' : ''}</span>
        ${rmBtn}
      </div>`;
    }).join('')}</div>
    ${candidates.length ? `
      <label class="im-label" style="margin-top:14px">添加成员</label>
      <div class="im-member-list" id="im-add-list">${candidates.map(u => {
        const n = u.display_name || u.username;
        return `<label class="im-member-check">
          <input type="checkbox" value="${esc(u.username)}">
          <div class="im-av sm" style="background:${imColorOf(u.username)}">${n.slice(0, 1)}</div>
          <span>${esc(n)}</span>
        </label>`;
      }).join('')}</div>
      <div style="margin-top:10px"><button class="btn btn-pri" onclick="imAddMembers('${chat.id}')">添加到群</button></div>` : ''}`,
    `<button class="btn btn-ghost" onclick="imLeaveGroup('${chat.id}')">退出群聊</button>
     ${canManage ? `<button class="btn btn-ghost" style="color:var(--red)" onclick="imDisbandGroup('${chat.id}')">解散群聊</button>` : ''}
     <button class="btn btn-ghost" onclick="imCloseNew()">关闭</button>`);
}

// 管理操作后统一刷新；会话被删时清空当前会话
async function imAfterManage(deletedId) {
  imSaveDraft();
  imCloseNew();
  await imLoadChats();
  if(deletedId&&!imCurChat&&imChats.length){imOpenChat(imChats[0].id);return;}
  imListFp = ''; imMsgFp = '';
  imRenderList(true); imRenderHeader(); imSyncChatPane();
  imRestoreDraft();
  if (imCurChat) await imRenderMsgs(true);
  if (imCurChat) {
    const chat = imChats.find(c => c.id === imCurChat);
    if (chat && typeof chatSetBusinessContext === 'function') chatSetBusinessContext({module:'im',view:'conversation',entity_type:'chat',entity_id:imCurChat,label:`会话 · ${imChatName(chat)}`,editable_scope:'当前会话摘要与待办提取；发送消息或创建任务须走确认契约'});
  }
}
async function imSaveGroupName(chatId) {
  const name = document.getElementById('im-grp-name').value.trim();
  if (!name) { toast('群名不能为空', ''); return; }
  const j = await api(`api/im/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then(r => r.json());
  if (j.ok) { toast('群名已更新', name); await imAfterManage(); imOpenManage(); }
  else toast('改名失败', j.error || '');
}
async function imAddMembers(chatId) {
  const checked = Array.from(document.querySelectorAll('#im-add-list input:checked')).map(c => c.value);
  if (!checked.length) { toast('请选择成员', ''); return; }
  const j = await api(`api/im/chats/${chatId}/members`, { method: 'POST', body: JSON.stringify({ member_ids: checked }) }).then(r => r.json());
  if (j.ok) { toast('已添加', checked.map(imUserName).join('、')); await imAfterManage(); imOpenManage(); }
  else toast('添加失败', j.error || '');
}
async function imRemoveMember(chatId, uid, name) {
  if (!confirm(`把「${name}」移出群聊？`)) return;
  const j = await api(`api/im/chats/${chatId}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' }).then(r => r.json());
  if (j.ok) { toast('已移除', name); await imAfterManage(); imOpenManage(); }
  else toast('移除失败', j.error || '');
}
async function imLeaveGroup(chatId) {
  if (!confirm('退出该群聊？退出后不再收到该群消息。')) return;
  const j = await api(`api/im/chats/${chatId}/leave`, { method: 'POST' }).then(r => r.json());
  if (j.ok) { toast('已退出群聊', ''); await imAfterManage(chatId); }
  else toast('操作失败', j.error || '');
}
async function imDisbandGroup(chatId) {
  if (!confirm('解散该群聊？全部成员与聊天记录都会删除，不可恢复。')) return;
  const j = await api(`api/im/chats/${chatId}`, { method: 'DELETE' }).then(r => r.json());
  if (j.ok) { toast('群聊已解散', ''); await imAfterManage(chatId); }
  else toast('解散失败', j.error || '');
}
async function imDeleteDm(chatId) {
  if (!confirm('将此私聊移出你的列表？对方的聊天记录不受影响，重新发起私聊会自动恢复。')) return;
  const j = await api(`api/im/chats/${chatId}`, { method: 'DELETE' }).then(r => r.json());
  if (j.ok) { toast('已移出我的列表', ''); await imAfterManage(chatId); }
  else toast('操作失败', j.error || '');
}
async function imRecallMsg(chatId, msgId) {
  const j = await api(`api/im/chats/${chatId}/messages/${msgId}/recall`, { method: 'POST' }).then(r => r.json());
  if (j.ok) { imMsgFp = ''; await imRenderMsgs(true); }
  else toast('撤回失败', j.error || '');
}

async function imCreateNew() {
  const checked = Array.from(document.querySelectorAll('.im-member-list input:checked')).map((c) => c.value);
  if (!checked.length) { toast('请选择成员', ''); return; }
  if (checked.length === 1) {
    const r = await api('api/im/chats', { method: 'POST', body: JSON.stringify({ type: 'dm', peer_id: checked[0] }) }).then(r => r.json());
    if (!r.ok) { toast('发起失败', r.error || ''); return; }
    imCloseNew();
    await imLoadChats();
    imOpenChat(r.id);
    toast('已发起私聊', imUserName(checked[0]));
  } else {
    const name = document.getElementById('im-new-name').value.trim() || '新群聊';
    const r = await api('api/im/chats', { method: 'POST', body: JSON.stringify({ type: 'group', name, member_ids: checked }) }).then(r => r.json());
    if (!r.ok) { toast('建群失败', r.error || ''); return; }
    imCloseNew();
    await imLoadChats();
    imOpenChat(r.id);
    toast('群聊已创建', name);
  }
}

RENDER.im = async function (page) {
  imSaveDraft();
  if(imOwner!==currentUserInfo?.username){
    imOwner=currentUserInfo?.username||'';imDrafts.clear();imPendingSends.clear();imReplies.clear();imExtras.clear();imFileCache.clear();imForwardKeys.clear();imCurChat=null;imChats=[];imUsers=[];imQuery='';imUnreadOnly=false;
  }
  const generation=++imGeneration;
  if(imPoll){clearInterval(imPoll);imPoll=null;}
  const active=()=>generation===imGeneration&&(!page||page.isActive())&&!!document.getElementById('im-msgs');
  imListFp = '';
  imMsgFp = '';
  mainBox().innerHTML = `
    <div class="im-page">
      <header class="page-hd platform-page-head page-heading im-page-head">
        <h1>消息</h1>
      </header>
      <div class="im-layout">
      <div class="im-list">
        <div class="im-list-tools">
          <div class="im-list-search-row">
            <input id="im-search" type="search" aria-label="搜索会话" placeholder="搜索会话、联系人" value="${esc(imQuery)}" oninput="imFilterChats()">
            <button class="im-add-btn" onclick="imOpenNew()" title="发起会话" aria-label="发起会话">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
          </div>
          <label class="im-unread-filter"><input id="im-unread-filter" type="checkbox" ${imUnreadOnly?'checked':''} onchange="imUnreadOnly=this.checked;imRenderList(true)">只看未读</label>
        </div>
        <div class="im-list-shortcuts"><button class="im-message-action" onclick="imOpenFavorites()">我的收藏</button><button id="im-notify-toggle" class="im-message-action" onclick="imToggleNotifications()">${imNotificationEnabled()?'关闭桌面通知':'开启桌面通知'}</button></div>
        <div id="im-list"></div>
      </div>
      <div class="im-chat">
        <div class="im-hd" id="im-hd"></div>
        <div class="im-history-tools"><input id="im-message-search" type="search" aria-label="查找当前会话消息" placeholder="查找当前会话消息" oninput="imFilterMessages()"><details class="im-history-filters"><summary>筛选</summary><div><select id="im-message-sender" aria-label="按成员查找" onchange="imFilterMessages()"><option value="">所有成员</option></select><input id="im-message-date" type="date" aria-label="按日期查找" onchange="imFilterMessages()"><button class="btn btn-ghost btn-sm" onclick="imResetMessageFilters();imFilterMessages()">重置</button></div></details><span id="im-search-count" aria-live="polite"></span></div>
        <div class="im-msgs" id="im-msgs" onscroll="imReadVisible()"><div class="im-empty">选择左侧会话，或点右上角 + 发起私聊/建群</div></div>
        <button id="im-new-messages" class="btn btn-ghost im-jump" hidden onclick="imJumpLatest()">回到最新消息 ↓</button>
        <div class="im-input" style="display:none">
          <div id="im-reply-preview" class="im-reply-preview" hidden></div>
          <div class="im-input-bar"><details id="im-emoji" class="im-emoji"><summary title="插入表情">☺ 表情</summary><div>${['👍','👌','✅','🙏','😊','🎉','🤝','💪','❤️','👀','📌','❓'].map(emoji=>`<button type="button" aria-label="插入${emoji}" onclick="imInsertEmoji('${emoji}')">${emoji}</button>`).join('')}</div></details><button class="im-message-action" onclick="imOpenMentions()">@ 提及</button><button class="im-message-action" onclick="imOpenFilePicker()">文件 / 图片</button><label class="im-message-action"><input id="im-mention-only" type="checkbox" onchange="imFilterMessages()">只看@我</label></div>
          <div id="im-extra-drafts" class="im-extra-drafts"></div>
          <div class="im-input-box">
            <textarea id="im-input" rows="3" aria-label="消息正文" placeholder="输入消息…" oninput="imSaveDraft()" onkeydown="imComposerKey(event)"></textarea>
            <button id="im-send" class="btn btn-pri" onclick="imSendInput()">发送</button>
          </div>
          <div id="im-send-state" class="im-send-state" role="status"></div>
        </div>
      </div>
      </div>
    </div>
    <div class="im-modal" id="im-modal" style="display:none" onclick="if(event.target===this)imCloseNew()">
      <div class="im-modal-box">
        <div class="im-modal-hd" id="im-modal-hd">发起会话</div>
        <div class="im-modal-bd">
          <label class="im-label">选择成员（选 1 人 = 私聊，多人 = 建群）</label>
          <div class="im-member-list" id="im-new-list"></div>
          <label class="im-label" style="margin-top:12px">群名称（多人时使用）</label>
          <input type="text" id="im-new-name" class="im-input-field" placeholder="新群聊">
        </div>
        <div class="im-modal-ft">
          <button class="btn btn-ghost" onclick="imCloseNew()">取消</button>
          <button class="btn btn-pri" onclick="imCreateNew()">发起</button>
        </div>
      </div>
    </div>`;

  if(!await imLoadUsers()||!active())return;
  if(!await imLoadChats()||!active())return;
  // 有会话才默认选中第一条；空库不要硬选导致「加载中」死循环
  if (!imCurChat && imChats.length) imCurChat = imChats[0].id;
  imResetMessageFilters();imPageAnchor={};imHasEarlier=false;imHasNewer=false;imHistoryLimit=80;imLocatedId='';
  const senderFilter=$('#im-message-sender');if(senderFilter)senderFilter.innerHTML='<option value="">所有成员</option>'+(imChats.find(c=>c.id===imCurChat)?.member_ids||[]).map(id=>`<option value="${esc(id)}">${esc(imUserName(id))}</option>`).join('');
  imRenderList(true);
  imRenderHeader();
  imSyncChatPane();
  imRestoreDraft();
  if (imCurChat) {try{await imRenderMsgs(true);}catch{return;}}
  if(!active())return;
  requestAnimationFrame(() => document.querySelector('.im-layout')?.classList.add('im-settled'));

  if (imPoll) clearInterval(imPoll);
  let polling=false;
  const poll=setInterval(async () => {
    if (!active()) { clearInterval(poll); if(imPoll===poll)imPoll=null; return; }
    if(polling)return;
    polling=true;
    try{
      if(!await imLoadChats()||!active())return;
      const changed=imChatsFingerprint(imChats)+'|'+(imCurChat||'')+'|'+imQuery+'|'+imUnreadOnly!==imListFp;
      imRenderList(false);if(changed)imRenderHeader();
      imSyncChatPane();
      if (document.visibilityState!=='hidden'&&imCurChat && document.getElementById('im-msgs')) await imRenderMsgs(false);
    }finally{polling=false;}
  }, 5000);
  imPoll=poll;
};
