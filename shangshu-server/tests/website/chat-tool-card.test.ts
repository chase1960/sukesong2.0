import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
function mount(payload:any){
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window as any;
  w.esc=(v:any)=>String(v??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  w.chatScrollBottom=()=>{};
  // 合并补注（2026-10-21）：fast 那条线给 `chatAddToolCard` 加了「本轮执行记录」，
  // 里面要读**平台工具目录** `PLATFORM_CHAT_TOOLS`（真实值由服务端带回，挂在 window 上）。
  // 这个符号声明在 real-chat.js 第 2133 行 —— **在「工具卡 → 确认卡」那段切片之外**
  // ⇒ 切进来的代码一跑就 ReferenceError，工具卡**根本生成不出来**（实测 6 条全红）。
  // 这里补上窗口全局：判据只关心工具卡本身长什么样，不需要真实目录，空表即可。
  // （fast 自己的 `chat-workflow-display` 判据也是这么设的：`w.PLATFORM_CHAT_TOOLS=[…]`。）
  w.PLATFORM_CHAT_TOOLS=[];
  w.eval(source.slice(source.indexOf('/* —— 工具卡'),source.indexOf('/* —— 确认卡')));
  w.chatAddToolCard(w.document.querySelector('main'),payload);
  return {w,card:w.document.querySelector('.tool'),close:()=>w.close()};
}
it('long tool arguments are disclosed only on demand; complete details remain inert text',()=>{
  const arg=JSON.stringify({text:'编号00123'.repeat(100),html:'<img src=x onerror=alert(1)>'});
  const t=mount({name:'platform_files_sheet_range_read',arg,result:'{"ok":true,"count":2}'});
  try{
    const header=t.card.querySelector('button');
    assert.equal(header.textContent,'读取表格调用完成▶');
    assert.equal(header.getAttribute('aria-expanded'),'false');
    assert.equal(t.card.querySelector('.tool-bd').hidden,true);
    assert.equal(t.card.querySelector('img'),null);
    header.click();
    assert.equal(header.getAttribute('aria-expanded'),'true');
    assert.equal(t.card.querySelector('.tool-bd').hidden,false);
    assert.equal(JSON.parse(t.card.querySelectorAll('pre')[1].textContent).text,'编号00123'.repeat(100));
    header.click();assert.equal(t.card.querySelector('.tool-bd').hidden,true);
  }finally{t.close();}
});
it('tool error receipts are visibly failed, never given a success check',()=>{
  for(const result of ['{"ok":false,"error":"权限不足"}','{"isError":true}', '{"error":"timeout"}']){
    const t=mount({name:'platform_mail_send',arg:'{}',result});
    try{assert.ok(t.card.classList.contains('failed'));assert.ok(!t.card.classList.contains('done'));assert.match(t.card.querySelector('button').textContent,/调用失败/);}finally{t.close();}
  }
});
it('plain-text and oversized receipts stay readable with an explicit display limit',()=>{
  const t=mount({name:'unknown_tool_name',arg:'plain argument',result:'x'.repeat(13000)});
  try{assert.match(t.card.querySelectorAll('pre')[2].textContent,/仅展示前 12000 个字符/);assert.equal(t.card.querySelectorAll('pre')[1].textContent,'plain argument');}finally{t.close();}
});

// —— R967-D01（BASE967-35 三态）：撤回不是二值——
// 测试通过 = 什么成立：撤回回执带 undo_state 时，三态各渲染出**用户看得懂的不同摘要**：
// 全撤=「已撤回」；部分撤=「部分撤回」并说清撤了几留了几；同段冲突拒撤=「未撤回」并说清
// 原因是那段有助手改动——不是笼统的「调用失败」，也不是假的「调用完成」。
// 字段口径（C 2026-10-19 收紧）：`undone`=本次撤掉的用户段数；`kept`=**合并后归属为助手的段数**
// （不是「所有没被撤的段数」——那会把根本没动过的段落也报成助手改动）。
it('撤回三态回执：全撤/部分撤/同段冲突拒撤各渲染可懂摘要（BASE967-35）',()=>{
  const undo=mount({name:'platform_files_sheet_cells_undo',arg:'{}',result:'{"ok":true,"undo_state":"withdrawn"}'});
  try{assert.match(undo.card.querySelector('button').textContent,/已撤回/);}finally{undo.close();}
  const partial=mount({name:'platform_files_sheet_cells_undo',arg:'{}',result:'{"ok":true,"undo_state":"partial","undone":2,"kept":1}'});
  try{assert.match(partial.card.querySelector('button').textContent,/部分撤回/);assert.match(partial.card.textContent,/2|3/);}finally{partial.close();}
  const conflict=mount({name:'platform_files_sheet_cells_undo',arg:'{}',result:'{"ok":true,"undo_state":"rejected_conflict"}'});
  try{assert.match(conflict.card.querySelector('button').textContent,/未撤回/);assert.match(conflict.card.textContent,/助手/);}finally{conflict.close();}
});
it('撤回三态不被当成失败或普通完成（回执 ok:true 也保留三态摘要）',()=>{
  const t=mount({name:'platform_files_sheet_cells_undo',arg:'{}',result:'{"ok":true,"undo_state":"rejected_conflict"}'});
  try{assert.ok(!t.card.classList.contains('failed'),'拒撤是产品语义，不是调用失败');}finally{t.close();}
});

// —— R967-D01（BASE967-35 · C 的运输口径）：撤回在**编辑器里**发起（工具栏/⌘Z），
//   不进聊天工具回执，C 派 window 事件 `shangshu:mail-undo`，detail 就是回执对象。
// 测试通过 = 什么成立：用户在邮件编辑器里撤回，聊天里也能看到这三态——
// 否则「用户想知道为什么我的操作没撤掉」在编辑器路径上根本没人回答。
it('编辑器里发起的撤回也要在聊天里看得见三态：测试通过 = mail-undo 事件渲染出可懂摘要（BASE967-35）',()=>{
  const dom=new JSDOM('<div id="chat"></div>',{runScripts:'outside-only'}),w=dom.window as any;
  try{
    w.esc=(v:any)=>String(v??'');
    w.chatScrollBottom=()=>{};
    w.chatEnsureMounted=()=>true;
    w.chatCurrentLayer=()=>w.document.querySelector('#chat');
    w.PLATFORM_CHAT_TOOLS=[];
    w.eval(source.slice(source.indexOf('/* —— 工具卡'),source.indexOf('/* —— 确认卡')));
    w.chatBindUndoReceipts();
    const text=()=>w.document.querySelector('#chat').textContent||'';
    w.dispatchEvent(new w.CustomEvent('shangshu:mail-undo',{detail:{ok:true,undo_state:'partial',undone:1,kept:1}}));
    assert.match(text(),/部分撤回/,'编辑器撤回也要上聊天');
    w.dispatchEvent(new w.CustomEvent('shangshu:mail-undo',{detail:{ok:true,undo_state:'rejected_conflict',undone:0,reason:'这段有助手的改动，你撤不了',conflictSegments:1}}));
    assert.match(text(),/未撤回/);
    assert.match(text(),/助手/);
    w.dispatchEvent(new w.CustomEvent('shangshu:mail-undo',{detail:{ok:false,reason:'没有可撤回的本人修改'}}));
    assert.match(text(),/没有可撤回的本人修改/,'无 undo_state 的失败按原样说原因，不编三态');
    assert.doesNotMatch(text(),/已撤回/,'无三态的失败不得被说成已撤回');
  }finally{w.close();}
});
