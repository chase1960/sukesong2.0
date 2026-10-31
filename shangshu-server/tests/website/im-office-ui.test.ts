import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
function setup(){
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://example.test',pretendToBeVisual:true});
  const w=dom.window as any;
  Object.assign(w,{RENDER:{},currentUserInfo:{username:'me',display_name:'本人',role:'staff'},$: (s:string)=>w.document.querySelector(s),mainBox:()=>w.document.querySelector('main'),esc:(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),toast:()=>{},updateImBadge:()=>{},apiJSON:async()=>({list:[]})});
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-im.js',import.meta.url),'utf8')+`\nwindow.testTime=imTime;window.testMentionKey=key=>imChats[0].member_ids.push(key);window.seed=(rows)=>{imCurChat='a';imChats=[{id:'a',type:'group',name:'A',member_ids:['me','peer']},{id:'b',type:'group',name:'B',member_ids:['me']}];imMessages=rows;imMessagesChat='a';};`);
  w.document.querySelector('main').innerHTML='<div id="im-list"></div><div id="im-msgs"></div><textarea id="im-input"></textarea><div id="im-reply-preview"></div><div id="im-send-state"></div><span id="im-search-count"></span><input id="im-message-search"><select id="im-message-sender"><option value="">全部</option><option value="peer">同事</option></select><input id="im-message-date" type="date">';
  w.originalLoadChats=w.imLoadChats;w.imLoadChats=async()=>[];w.imRenderMsgs=async()=>{};
  return {w,dom};
}
const original={id:'original',sender_id:'peer',text:'请核对合同',created_at:'2026-10-10T01:00:00Z'};
test('聊天只有消息区滚动，点击回复不能卷走会话标题',()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/collaboration.css',import.meta.url),'utf8');
  /* ⚠ **2026-10-24 16:45 口径变更**（用户：「消息这一页的样式怎么和工作台的样式不一致，包括标题位置这些」）：
     消息页**加了页头条** ⇒ 挂在滚动容器上的外壳从「`.im-layout`」改成「`.im-page`（页头条 ＋ 聊天区）」。
     ⚠ **要保的规矩一条没变**：宿主容器**不滚动**（只有消息区滚）＋ 聊天区**占满宿主剩下的高度**。 */
  assert.match(css,/\.main-scroll:has\(>\.im-page\)\{padding:0;overflow:hidden/);
  assert.match(css,/\.im-page \.im-layout\{flex:1;min-height:0;height:auto;margin:0/);
  assert.match(css,/\.im-msg \.im-bubble\{max-width:100%/);
});
test('回复按会话存草稿，失败重试携带同一原文ID，恢复后不串另一会话',async()=>{
  const {w,dom}=setup();const requests:any[]=[];
  try{
    w.seed([original]);w.imReplyTo('original');
    assert.match(w.document.querySelector('#im-reply-preview').textContent,/请核对合同/);
    w.document.querySelector('#im-input').value='已核对';
    w.api=async(_url:string,o:any)=>{requests.push(JSON.parse(o.body));return {json:async()=>({ok:false,error:'网络异常'})};};
    await w.imSendInput();await w.imRetrySend();
    assert.equal(requests[0].reply_to,'original');assert.equal(requests[1].reply_to,'original');assert.equal(requests[0].client_msg_id,requests[1].client_msg_id);
    w.imOpenChat('b');assert.equal(w.document.querySelector('#im-reply-preview').hidden,true);
  }finally{dom.window.close();}
});
test('历史默认有界展开，引用定位恢复上下文；成员与本地日期组合筛选',()=>{
  const {w,dom}=setup();
  try{
    const rows=Array.from({length:110},(_,i)=>({id:'m'+i,sender_id:i%2?'peer':'me',text:'记录'+i,created_at:'2026-10-10T01:00:00Z'}));
    w.seed(rows);w.imDrawMessages(true);assert.equal(w.document.querySelectorAll('.im-msg').length,80);
    w.imShowEarlier();assert.equal(w.document.querySelectorAll('.im-msg').length,110);
    w.document.querySelector('#im-message-sender').value='peer';w.document.querySelector('#im-message-date').value='2026-10-10';w.imFilterMessages();
    assert.equal(w.document.querySelectorAll('.im-msg').length,55);
    w.imLocateMessage('m0');assert.ok(w.document.querySelector('[data-message-id="m0"]'));assert.match(w.document.querySelector('[data-message-id="m0"]').className,/im-highlight/);
    assert.equal(w.document.querySelector('#im-message-sender').value,'');
  }finally{dom.window.close();}
});
test('明确拒绝引用后保留正文，可取消引用重发，不困在未知回执状态',async()=>{
  const {w,dom}=setup();
  try{
    w.seed([original]);w.imReplyTo(original.id);w.document.querySelector('#im-input').value='保留这条正文';
    w.api=async()=>({status:400,json:async()=>({ok:false,error:'引用已撤回'})});
    await w.imSendInput();assert.equal(w.document.querySelector('#im-input').value,'保留这条正文');
    w.imCancelReply();assert.equal(w.document.querySelector('#im-reply-preview').hidden,true);
    assert.doesNotMatch(w.document.querySelector('#im-send-state').textContent,/发送未确认/);
  }finally{dom.window.close();}
});
test('已撤回引用不输出正文或活动链接；表情在光标插入且不发送',()=>{
  const {w,dom}=setup();
  try{
    w.seed([{...original,reply:{id:'x',text:'保密',recalled:true}}]);w.imDrawMessages(true);
    assert.doesNotMatch(w.document.querySelector('#im-msgs').textContent,/保密/);assert.match(w.document.querySelector('#im-msgs').textContent,/原消息已撤回/);
    const input=w.document.querySelector('#im-input');input.value='前后';input.setSelectionRange(1,1);w.imInsertEmoji('👍');assert.equal(input.value,'前👍后');
  }finally{dom.window.close();}
});
test('会话免打扰影响总角标但保留会话未读，置顶和引用状态进入指纹',async()=>{
  const {w,dom}=setup();let badge=-1;
  try{
    w.apiJSON=async()=>({list:[{id:'a',type:'group',member_ids:['me'],unread:5,muted:true},{id:'b',type:'group',member_ids:['me'],unread:2}]});
    w.updateImBadge=(n:number)=>badge=n;await w.originalLoadChats();assert.equal(badge,2);
    assert.notEqual(w.imChatsFingerprint([{id:'a',pinned:false}]),w.imChatsFingerprint([{id:'a',pinned:true}]));
    assert.notEqual(w.imMsgsFingerprint([{...original,reply:{id:'x',recalled:false}}]),w.imMsgsFingerprint([{...original,reply:{id:'x',recalled:true}}]));
  }finally{dom.window.close();}
});

test('结构化@和文件草稿切会话隔离，重试保留原载荷；已读与转发标记来自回执',async()=>{
 const {w,dom}=setup();const requests:any[]=[];
 try{w.seed([original]);w.imAddMention('peer');w.imAddFileDraft({ref_name:'f',file:'fixed'},'报价.xlsx');
 w.api=async(_u:string,o:any)=>{requests.push(JSON.parse(o.body));return {json:async()=>({ok:false,error:'网络异常'})};};
 w.document.querySelector('#im-input').value='请查收';await w.imSendInput();await w.imRetrySend();assert.deepEqual(requests[0].mentions,['peer']);assert.deepEqual(requests[0].files,[{ref_name:'f',file:'fixed'}]);assert.deepEqual(requests[1],requests[0]);
 w.imOpenChat('b');assert.deepEqual(JSON.parse(JSON.stringify(w.imDraftExtras())),{mentions:[],files:[]});
 w.seed([{...original,sender_id:'me',read_by:['peer'],recipient_count:1,forwarded:true}]);w.imDrawMessages(true);assert.match(w.document.querySelector('#im-msgs').textContent,/已读/);assert.match(w.document.querySelector('#im-msgs').textContent,/转发/);
 }finally{dom.window.close();}
});

test('桌面通知默认不弹权限，内容不泄漏；初次加载、免打扰、本人发送均不通知',()=>{
 const {w,dom}=setup();const notices:any[]=[];let requests=0;
 try{
 class FakeNotification{static permission='granted';static requestPermission(){requests++;return Promise.resolve('granted');}constructor(title:string,options:any){notices.push([title,options]);}close(){}}
 w.Notification=FakeNotification;w.localStorage.setItem('ss-im-notify:me','1');Object.defineProperty(w.document,'visibilityState',{value:'hidden',configurable:true});
 const c={id:'c',unread:1,muted:false,last_msg:{id:'m1',sender_id:'peer',text:'秘密',created_at:'2026-10-10T01:00:00Z'}};
 w.imMaybeNotify([c]);assert.equal(notices.length,0);w.imMaybeNotify([{...c,last_msg:{...c.last_msg,id:'m2'}}]);assert.equal(notices.length,1);assert.doesNotMatch(JSON.stringify(notices),/秘密/);
 w.imMaybeNotify([{...c,muted:true,last_msg:{...c.last_msg,id:'m3'}}]);w.imMaybeNotify([{...c,last_msg:{...c.last_msg,id:'m4',sender_id:'me'}}]);assert.equal(notices.length,1);assert.equal(requests,0);
 }finally{dom.window.close();}
});

test('文件卡只用受权固定源，没有权限时不使用伪造文件名或外部URL',async()=>{
 const {w,dom}=setup();try{
 w.seed([{...original,files:[{ref_name:'f',file:'v'}]}]);w.api=async()=>({ok:false,json:async()=>({ok:false,error:'无权访问'})});w.imDrawMessages(true);await w.imHydrateFiles();
 assert.equal(w.document.querySelectorAll('#im-msgs img').length,0);assert.match(w.document.querySelector('#im-msgs').textContent,/文件不可用或无权访问/);
 }finally{dom.window.close();}
});

test('文件选择沿真实版本协议，卡片固定原件；无文件域只给简明退路',async()=>{
 const {w,dom}=setup();try{
  w.document.querySelector('main').insertAdjacentHTML('beforeend','<div id="im-modal"></div>');
  w.seed([original]);
  const ref={ref_doctype:'Shangshu File Center File',ref_name:'document',file:'blob-v2'};
  w.apiJSON=async()=>({rows:[{name:'document',file_name:'项目图.png',directory:'/项目',current_size:1024}],total:1});
  w.api=async()=>({ok:true,json:async()=>({ok:true,result:{file:{name:'document',file_name:'项目图.png',status:'Active',version:2},versions:[{version_no:2,size:1024,frappe_file:'blob-v2',source:ref}]}})});
  w.imOpenFilePicker();await w.imPickerLoad();await w.imChooseFile(0);
  assert.deepEqual(JSON.parse(JSON.stringify(w.imDraftExtras().files)),[{ref_name:'document',file:'blob-v2'}]);
  w.seed([{...original,files:[{ref_name:'document',file:'blob-v2'}]}]);w.imDrawMessages(true);await w.imHydrateFiles();
  const link=w.document.querySelector('#im-msgs a');assert.match(link.href,/ref_name=document&file=blob-v2/);assert.match(link.textContent,/第 2 版/);assert.equal(w.document.querySelector('#im-msgs img').src,link.href);
  w.apiJSON=async()=>{throw new SyntaxError('Unexpected token <');};w.imOpenFilePicker();await w.imPickerLoad();assert.doesNotMatch(w.document.querySelector('#im-file-options').textContent,/Unexpected/);
 }finally{dom.window.close();}
});

test('消息时间遵循浏览器本地时区；含引号的成员键按原值提及',()=>{
 const before=process.env.TZ;process.env.TZ='Asia/Shanghai';const {w,dom}=setup();
 try{
  assert.equal(w.testTime('2026-10-10T01:34:00Z'),'10-10 09:34');
  w.seed([original]);w.document.querySelector('main').insertAdjacentHTML('beforeend','<div id="im-modal"></div>');
  w.testMentionKey("peer'name");w.imOpenMentions();
  const button=[...w.document.querySelectorAll('#im-modal button')].find((b:any)=>b.textContent.includes("peer'name")) as any;
  w.eval(button.getAttribute('onclick'));
  assert.ok(w.imDraftExtras().mentions.includes("peer'name"));
 }finally{dom.window.close();if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});
