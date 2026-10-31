import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = (name: string) => readFileSync(new URL(`../../../shangshu-web/js/${name}.js`, import.meta.url), 'utf8');
test('消息底部为浮动助手预留空间，发送按钮不被遮挡',()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/collaboration.css',import.meta.url),'utf8');
  assert.match(css,/\.im-input\{[^}]*padding-bottom:64px/);
  assert.match(css,/body:has\(\.im-layout\)>\.ai-fab\{bottom:18px\}/);
});
function setup(name: string) {
  const dom = new JSDOM('<main id="main"></main>', { runScripts: 'outside-only', url: 'https://example.test', pretendToBeVisual: true });
  const w = dom.window as any;
  Object.assign(w, { RENDER: {}, currentUserInfo: { username: 'me', display_name: '本人', role: 'staff' },
    $: (s: string, el = w.document) => el.querySelector(s), mainBox: () => w.document.querySelector('main'),
    esc: (s: unknown) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    toast: () => {}, updateImBadge: () => {}, apiJSON: async () => ({ list: [] }) });
  w.eval(source(name)+(name==='real-im'?`\nwindow.__prepare=()=>{imChats=[{id:'a',type:'group',name:'A',member_ids:['me']},{id:'b',type:'group',name:'B',member_ids:['me']}];imCurChat='a';};
    window.__messages=(messages)=>{imMessages=messages;imMessagesChat=imCurChat;imChats[0].unread=2;};
    window.__query=q=>imMessageQuery=q;`:''));
  return { w, dom };
}

test('工作导航归拢邮件文件，保留其他扩展和禁用状态', () => {
  const { w, dom } = setup('real-task');
  try {
    const s = source('app');
    w.eval(s.slice(s.indexOf('function normalizePrimaryNavigation('), s.indexOf('function syncLegacyModuleKeysFromLayout(')));
    const result = w.normalizePrimaryNavigation([{sec:'工作',items:['dash','im','flowdesign']},{sec:'工具',items:['file-center','mail','custom']},{sec:'业务',items:['applications']}]);
    assert.deepEqual(Array.from(result[0].items), ['dash','im','flowdesign','mail','file-center']);
    assert.equal(result.find((g: any) => g.sec === '工具').items[0], 'custom');
    assert.equal(w.normalizePrimaryNavigation([{sec:'工作',items:['dash']}]).flatMap((g:any)=>g.items).includes('mail'), false);
  } finally { dom.window.close(); }
});

test('任务筛选使用本地日界，已完成不逾期，标题/结果均可搜索', () => {
  const { w, dom } = setup('real-task');
  try {
    const rows = [
      {id:'a',title:'合同核对',assignee_id:'me',status:'进行中',end_date:'2026-10-09',priority:'中'},
      {id:'b',title:'报价',created_by:'me',assignee_id:'other',status:'待办',end_date:'2026-10-10',priority:'高',result:'请核对合同'},
      {id:'c',title:'已归档',assignee_id:'me',status:'已完成',end_date:'2026-10-08'},
      {id:'d',title:'无期限',assignee_id:'me',status:'待办'},
    ];
    const ids = (f: object) => Array.from(w.rtFilterTasks(rows, f, 'me', '2026-10-10'), (r:any)=>r.id);
    assert.deepEqual(ids({due:'overdue'}), ['a']);
    assert.deepEqual(ids({due:'today'}), ['b']);
    assert.deepEqual(ids({owner:'created'}), ['b']);
    assert.deepEqual(ids({query:'合同',sort:'priority'}), ['b','a']);
    assert.deepEqual(ids({owner:'mine',due:'undated'}), ['d']);
  } finally { dom.window.close(); }
});

test('任务筛选只局部更新，不重复读取且保留嵌入式任务宿主', async () => {
  const { w, dom } = setup('real-task'); let calls=0;
  try {
    w.document.querySelector('main').innerHTML='<header id="keep">待办导航</header><section id="tasks"></section>';
    w.apiJSON=async()=>{calls++;return {list:[{id:'a',title:'合同核对',status:'待办',assignee_id:'me'}]};};
    await w.RENDER['task-mgmt']({host:w.document.querySelector('#tasks'),isActive:()=>true});
    const input=w.document.querySelector('[data-task-search]');
    input.value='没有结果';input.dispatchEvent(new w.Event('input'));
    assert.match(w.document.querySelector('#tasks').textContent,/没有符合条件的任务/);
    assert.equal(calls,1);assert.ok(w.document.querySelector('#keep'));
  } finally { dom.window.close(); }
});

test('消息指纹包括撤回、内容与群信息的更改', () => {
  const { w, dom } = setup('real-im');
  try {
    assert.notEqual(w.imMsgsFingerprint([{id:'1',text:'原文'}]),w.imMsgsFingerprint([{id:'1',text:'',recalled:true}]));
    assert.notEqual(w.imChatsFingerprint([{id:'1',name:'旧群'}]),w.imChatsFingerprint([{id:'1',name:'新群'}]));
  } finally { dom.window.close(); }
});

test('中文组字与 Shift+Enter 不发送，普通 Enter 才发送', () => {
  const { w, dom } = setup('real-im'); let sends=0,prevents=0;
  try {
    w.imSendInput=()=>{sends++;};
    const e={key:'Enter',preventDefault:()=>prevents++};
    w.imComposerKey({...e,isComposing:true});w.imComposerKey({...e,keyCode:229});w.imComposerKey({...e,shiftKey:true});
    assert.equal(sends,0);w.imComposerKey(e);assert.equal(sends,1);assert.equal(prevents,1);
  } finally { dom.window.close(); }
});

function prepareMessage(w: any) {
  w.document.querySelector('main').innerHTML='<div class="im-input"><textarea id="im-input"></textarea><button id="im-send"></button><span id="im-send-state"></span></div><div id="im-list"></div>';
  w.__prepare();
  w.imLoadChats=async()=>[]; w.imRenderMsgs=async()=>{};
  w.document.querySelector('#im-input').value='待发送';
}

test('发送失败保留原会话草稿，同会话重试同键，不同会话隔离', async () => {
  const { w, dom } = setup('real-im'); const requests: any[]=[];
  try {
    prepareMessage(w);
    w.api=async(url:string,o:any)=>{requests.push({url,...JSON.parse(o.body)});return {json:async()=>({ok:false,error:'失败'})};};
    await w.imSendInput();assert.equal(w.document.querySelector('#im-input').value,'待发送');
    await w.imSendInput();assert.equal(requests[0].client_msg_id, requests[1].client_msg_id);
    w.imOpenChat('b');assert.equal(w.document.querySelector('#im-input').value,'');
    w.document.querySelector('#im-input').value='待发送';await w.imSendInput();
    assert.notEqual(requests[0].client_msg_id,requests[2].client_msg_id);
    w.imOpenChat('a');assert.equal(w.document.querySelector('#im-input').value,'待发送');
  } finally { dom.window.close(); }
});

test('发送中切会话不串稿，成功不清掉期间输入的新内容', async () => {
  const { w, dom } = setup('real-im'); let finish: any;
  try {
    prepareMessage(w);
    w.api=()=>new Promise(r=>{finish=r;});
    const send=w.imSendInput();
    w.document.querySelector('#im-input').value='下一句';w.imSaveDraft();
    await w.imSendInput();assert.equal(w.document.querySelector('#im-input').value,'下一句');
    w.imOpenChat('b');w.document.querySelector('#im-input').value='B草稿';w.imSaveDraft();
    finish({json:async()=>({ok:true})});await send;
    assert.equal(w.document.querySelector('#im-input').value,'B草稿');
    w.imOpenChat('a');assert.equal(w.document.querySelector('#im-input').value,'下一句');
  } finally { dom.window.close(); }
});

test('失败内容与发送期间输入的下一句分别保留，不覆盖草稿', async () => {
  const { w, dom } = setup('real-im'); let finish:any;
  try {
    prepareMessage(w);w.api=()=>new Promise(r=>finish=r);
    const send=w.imSendInput();w.document.querySelector('#im-input').value='下一句';w.imSaveDraft();
    finish({json:async()=>({ok:false,error:'断线'})});await send;
    assert.equal(w.document.querySelector('#im-input').value,'下一句');
    assert.match(w.document.querySelector('#im-send-state').textContent,/待发送/);
  } finally { dom.window.close(); }
});

test('历史检索、后台与滚动在上方不标新消息已读，底部查看才推进游标', () => {
  const {w,dom}=setup('real-im');const reads:any[]=[];
  try {
    prepareMessage(w);w.document.querySelector('main').insertAdjacentHTML('beforeend','<div id="im-msgs"></div><button id="im-new-messages"></button>');
    w.__messages([{id:'one',sender_id:'other',text:'第一条'},{id:'two',sender_id:'other',text:'第二条'}]);
    w.imMarkRead=(...args:any[])=>reads.push(args);
    const el=w.document.querySelector('#im-msgs');
    Object.defineProperties(el,{scrollHeight:{value:1000},clientHeight:{value:400}});
    el.scrollTop=0;w.imReadVisible();assert.equal(reads.length,0);
    el.scrollTop=600;w.__query('第一条');w.imReadVisible();assert.equal(reads.length,0);
    w.__query('');Object.defineProperty(w.document,'visibilityState',{value:'hidden',configurable:true});w.imReadVisible();assert.equal(reads.length,0);
    Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true});w.imReadVisible();assert.deepEqual(reads,[['a','two']]);
  } finally {dom.window.close();}
});

test('会话检索排除撤回内容，当前消息查找不显示不匹配正文', () => {
  const {w,dom}=setup('real-im');
  try {
    prepareMessage(w);w.document.querySelector('main').insertAdjacentHTML('beforeend','<input id="im-search"><div id="im-msgs"></div>');
    w.document.querySelector('#im-search').value='B';w.imFilterChats();
    assert.equal(w.document.querySelectorAll('#im-list .im-item').length,1);
    w.__messages([{id:'one',sender_id:'me',text:'合同已修改'},{id:'two',sender_id:'me',text:'付款',recalled:true}]);
    w.__query('合同');w.imDrawMessages(false);assert.match(w.document.querySelector('#im-msgs').textContent,/合同已修改/);assert.doesNotMatch(w.document.querySelector('#im-msgs').textContent,/付款/);
  } finally{dom.window.close();}
});
