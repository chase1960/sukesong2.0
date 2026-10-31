import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');

// ⚠️ 2026-10-24 12:5x（PKG-085）：产品 2026-10-22（`c83556c2a`）把「引擎 ＋ 模型」**合成一个栏**：
//   · 模型名不再单独摆一颗胶囊（`#model-pill-label` 这个元素**已经不存在**），
//     它落到引擎栏的第二层 `#engine-model-label`；
//   · 引擎栏是「先选 harness、选完风琴式下拉出模型」⇒ `chatEnginePickerMarkup`／
//     `chatRenderEnginePicker`／`chatMountEnginePicker`／`chatModelState` 得一起在场。
//   切片只取**真实代码**；顶层 let/const 在 eval 里只活在这一次 eval 的词法作用域里
//   （跨切片互相看不见）⇒ 统一转 var，各切片才能共用同一份状态。
const slice=(from:string,to:string)=>{
  const a=source.indexOf(from),b=source.indexOf(to,a);
  if(a<0||b<=a)throw Error(`源码切片定位失败：${from} → ${to}`);
  return source.slice(a,b).replace(/^(let|const)\s+/gm,'var ');
};

it('运行时由服务器选择，员工只显示真实模型且不请求管理员配置：测试通过 = 引擎按服务端清单选中、模型名落在引擎栏第二层、员工侧不碰管理员配置接口',async()=>{
  const dom=new JSDOM('<div class="input-bar"><span class="ib-hint"></span></div>',{runScripts:'outside-only'}),w=dom.window as any;
  w.$=(s:string)=>w.document.querySelector(s);w.chatRunning=false;
  w.esc=(v:any)=>String(v??'').replace(/[&<>"']/g,(x:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  const requests:any[]=[];let engines=[{id:'classic'},{id:'pi'}];
  w.api=async(path:string,...args:any[])=>{requests.push([path,...args]);return {ok:true,json:async()=>({engines,default_engine:'pi',model:'actual-model'})};};
  try{
    w.eval(slice("let chatEngine = 'classic'",'function chatModeButton')+'\nwindow.engineValue=()=>chatEngine;'); // chatEngine/chatEngines/chatLoadEngines
    w.eval(slice('/* —— harness（对话引擎）＋ 模型','/* —— 风琴'));                                       // chatEnginePickerMarkup/chatModelName
    w.eval(slice('/* —— 风琴','let chatSessions = []'));                                              // chatRenderEnginePicker/chatSyncEngineModelLayer/chatMountEnginePicker
    w.eval(slice('/* —— 模型选择（**并进引擎栏的第二层**','/* —— 工具卡'));                            // chatModelState/chatModelSources
    // 引擎栏那一颗胶囊**由产品自己渲染**（判据不手写壳）⇒ 员工看到的就是产品那一版。
    w.document.querySelector('.input-bar')!.innerHTML=w.chatEnginePickerMarkup();

    await w.chatLoadEngines();
    assert.equal(w.engineValue(),'pi','引擎由服务端清单与默认值决定');
    assert.equal(w.$('#engine-model-label').textContent,'actual-model','模型名落在引擎栏第二层');
    assert.equal(w.$('#model-pill-label'),null,'模型不再单独摆一颗胶囊（老胶囊已撤）');
    // 引擎名一律**服务端清单给**（label 缺失时退回 id）——前端不自己编一个「Pi 试用」选项。
    const engineList=w.document.querySelector('#ep-list')!.innerHTML;
    assert.match(engineList,/classic/);assert.match(engineList,/pi/);
    // ⚠️ 「Pi 试用」这三个字现在**只出现在产品的注释里**（real-chat.js:346 说明第一层是引擎），
    //   所以断言改成查**渲染出来的那个胶囊**，不再查整份源码（否则被注释误伤）。
    assert.doesNotMatch(w.chatEnginePickerMarkup(),/Pi 试用/,'界面上不出现前端自造的引擎名');
    assert.doesNotMatch(source,/id="chat-engine"/,'老的独立引擎下拉已移除');
    // 员工侧看模型只读：模型层给的是「由管理员配置」那一行，不给切换按钮。
    const modelList=w.document.querySelector('#mp-list')!.innerHTML;
    assert.match(modelList,/由管理员配置/,'非管理员只读当前模型');
    assert.doesNotMatch(modelList,/mp-manage|管理模型配置/,'员工侧不出现管理模型配置入口');

    engines=[{id:'classic'}];await w.chatLoadEngines();assert.equal(w.engineValue(),'classic');
    assert.ok(requests.every(r=>r[0]==='api/chat/engines'&&r.length===1),'发现和选择不写全局模型或凭据');
    assert.match(source,/conversation_id: conversationId, engine:chatEngine/);
  }finally{dom.window.close();}
});
