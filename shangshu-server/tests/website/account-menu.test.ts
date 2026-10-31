import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/* 判据：岗位侧栏预设 ＋ 账号菜单。
 *
 * **测试通过 =**（一句话）
 *   「四个岗位（admin／staff／manager／finance）的侧栏预设里**都有『审核中心』**、
 *     老入口『文件中心』『邮箱』**一个都没丢**；账号菜单不重复列侧栏里的入口、
 *     个人设置走领域注册投影。」
 */

const source=readFileSync(new URL('../../../shangshu-web/js/app.js',import.meta.url),'utf8');

/* 岗位侧栏预设（`const ROLE_PRESET = {…}`）。
 *
 * ⚠️ **为什么不再把整张清单写死成字面量**（提交 903dcb051 · 2026-10-22 ·
 *    CORE-CANDIDATE fix(web)）：那一笔在侧栏「工作」组里补上了「审核中心」，
 *    四份预设都从 6 项变成 7 项 ⇒ 原来这条
 *    `assert.match(source, /admin: \['dash', 'im', …\]/)` 的**字面量清单**必然过期。
 *    ⇒ 判据改成**按语义断言**：每个岗位的预设里**必须有** 'review-center'，
 *      同时保留原来那层意思（「file-center」／「mail」这些老入口不许丢），
 *      但只用 `includes` 判**成员**——**不钉顺序、不钉整张清单**。
 *      （清单每加一项就会把判据带红一次 ⇒ 那测的是清单，不是行为。）
 *    配套判据（更细，把侧栏真的算出来）：shangshu-web/js/tests/sidebar-review-entry.test.mjs。 */
const presetBlock=source.slice(source.indexOf('const ROLE_PRESET ='),source.indexOf('const GROUPS ='));
/** 取某个岗位的侧栏预设**成员**（只看有没有，不看顺序）。 */
function rolePreset(role:string):string[]{
  const at=presetBlock.indexOf(`${role}: [`);
  assert.ok(at>0,`app.js 的 ROLE_PRESET 里找不到岗位「${role}」的预设`);
  const open=presetBlock.indexOf('[',at);
  const close=presetBlock.indexOf(']',open);
  assert.ok(open>0&&close>open,`岗位「${role}」的预设清单解析不出来`);
  return presetBlock.slice(open+1,close).split(',').map(s=>s.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean);
}
test('常驻导航归一顺序并保留额外模块，不修改旧偏好对象',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'});
  try{
    dom.window.eval(source.slice(source.indexOf('function normalizePrimaryNavigation('),source.indexOf('function syncLegacyModuleKeysFromLayout(')));
    const original=[{sec:'工作',items:['applications','dash','flowdesign']},{sec:'协作',items:['task-mgmt','im','custom']}];
    const before=JSON.stringify(original);
    const result=(dom.window as any).normalizePrimaryNavigation(original);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),[
      {sec:'工作',items:['dash','im','flowdesign']},
      {sec:'业务',items:['applications']},{sec:'协作',items:['custom']},
    ]);
    assert.equal(JSON.stringify(original),before);
  }finally{dom.window.close();}
});
const menuCode=source.slice(source.indexOf('let accountMenuOpen = false;'),source.indexOf('function renderChrome()'));
test('内部工具进入各角色工作侧栏，账号菜单不重复列入口',()=>{
  for(const role of ['admin','staff','manager','finance']){
    const preset=rolePreset(role);
    assert.ok(preset.includes('review-center'),
      `岗位「${role}」的侧栏预设里没有「审核中心」⇒ 默认侧栏缺这一项，用户点不到`);
    for(const keep of ['file-center','mail'])
      assert.ok(preset.includes(keep),`岗位「${role}」的侧栏预设里丢了老入口「${keep}」`);
  }
  assert.match(source,/\{ id: 'file-center', name: '文件中心', ico: 'folder', autoPin: true \}/);
  assert.match(source,/\{ id: 'mail', name: '邮箱', ico: 'mail', autoPin: true \}/);
  assert.match(source,/\{ id: 'sheets', name: '表格', ico: 'sheet', sidebarHidden: true \}/);
  assert.match(source,/currentRole\(\) === 'admin' \? \[findWorkspaceItem\('apps'\)\]/);
  assert.match(source,/filter\(m => m.accountMenu\)/, '个人设置用领域注册投影，不在内核硬编码邮箱');
  assert.doesNotMatch(source,/return \['apps', 'file-center', 'mail'\]/);
});
for(const collapsed of [false,true]) test(`侧栏控制器缺失时账号菜单仍可开关（rail=${collapsed}）`,()=>{
  const dom=new JSDOM(`<aside id="side" class="${collapsed?'rail':''}"><div id="side-account"><div id="side-account-menu" hidden></div><button id="side-user">黄祺峰</button></div></aside>`,{runScripts:'outside-only'});
  const w=dom.window as any;
  w.$=(selector:string)=>w.document.querySelector(selector);
  w.eval(menuCode);
  const menu=w.$('#side-account-menu'),button=w.$('#side-user');
  button.getBoundingClientRect=()=>({left:14,right:42,top:600});
  try{
    assert.doesNotThrow(()=>w.toggleAccountMenu());
    assert.equal(menu.hidden,false);
    assert.equal(menu.style.left,collapsed?'50px':'14px');
    w.toggleAccountMenu();
    assert.equal(menu.hidden,true);
    assert.equal(menu.parentNode,w.$('#side-account'));
  }finally{dom.window.close();}
});
test('侧栏控制器先于产品壳加载；异常提示使用错误语义并按纯文本显示',()=>{
  const html=readFileSync(new URL('../../../shangshu-web/index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('js/sidebar.js')<html.indexOf('js/app.js'));
  /* toast 已抽成独立公共件 js/toast.js（用户 2026-10-12：「notice 是有一个独立的公共组件的」），
     app.js 里不再自带一份 function toast —— 所以这里改成：先装公共件，再挂 app.js 的全局错误兜底。
     兜底排在 app.js 里也要晚于公共件，否则 toast(...) 一调就是 undefined。 */
  assert.ok(html.indexOf('js/toast.js')<html.indexOf('js/app.js'),
      'toast 公共件必须排在 app.js 之前，否则全局错误兜底调不到 toast');
  const dom=new JSDOM('<div id="toast-zone"></div>',{runScripts:'outside-only'});
  const w=dom.window as any;
  w.$=(selector:string)=>w.document.querySelector(selector);
  w.console.error=()=>{};
  w.eval(readFileSync(new URL('../../../shangshu-web/js/toast.js',import.meta.url),'utf8'));
  const guardStart=source.indexOf("window.addEventListener('error'");
  const guardEnd=source.indexOf('let senseTimer');
  assert.ok(guardStart>0&&guardEnd>guardStart,'app.js 里找不到全局错误兜底');
  w.eval(source.slice(guardStart,guardEnd));
  try{
    w.dispatchEvent(new w.ErrorEvent('error',{message:'<img src=x onerror=alert(1)>',filename:'app.js',lineno:617}));
    const t=w.$('.toast');
    assert.ok(t.classList.contains('toast-error'));
    assert.equal(t.getAttribute('role'),'alert');
    assert.equal(t.querySelector('.ti').textContent,'!');
    assert.equal(t.querySelector('img'),null);
    assert.match(t.textContent,/<img src=x/);
  }finally{dom.window.close();}
});
test('控制器缺失时启动链明确降级，不绑定调宽且不阻断后续业务页',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'});
  const w=dom.window as any;
  const notices:any[]=[];
  w.toast=(...args:any[])=>notices.push(args);
  w.console.error=()=>{};
  w.attachSideResize=()=>assert.fail('缺少控制器时不能绑定调宽');
  const start=source.indexOf('  if (window.sidebarLayout) {');
  const end=source.indexOf('  updateSideGlass();',start);
  try{
    assert.ok(start>0 && end>start);
    assert.doesNotThrow(()=>w.eval(source.slice(start,end)));
    assert.equal(notices.length,1);
    assert.equal(notices[0][2],'error');
  }finally{dom.window.close();}
});
for(const width of [1440,900,390]) test(`账号菜单 ${width}px：折叠可打开、不改变布局、内部点击不关闭、Esc/外部/resize 关闭`,()=>{
  const dom=new JSDOM('<div id="side-account"><div id="side-account-menu" hidden><button id="item">应用管理</button></div><button id="side-user">管理员</button></div>',{runScripts:'outside-only'});
  const w=dom.window as any;
  Object.defineProperty(w,'innerWidth',{value:width});
  w.$=(selector:string)=>w.document.querySelector(selector);
  w.sidebarLayout={collapsed:true,expand:()=>assert.fail('不能通过展开侧栏代替菜单')};
  w.eval(menuCode);
  const menu=w.$('#side-account-menu'),button=w.$('#side-user');
  button.getBoundingClientRect=()=>({left:14,right:42,top:600});
  try{
    w.toggleAccountMenu();
    assert.equal(menu.hidden,false);
    assert.equal(menu.parentNode,w.document.body);
    assert.equal(button.getAttribute('aria-expanded'),'true');
    assert.ok(parseFloat(menu.style.left)+parseFloat(menu.style.width)<=width-8);
    w.$('#item').click();assert.equal(menu.hidden,false);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
    assert.equal(menu.hidden,true);assert.equal(w.document.activeElement,button);
    w.toggleAccountMenu();w.document.body.click();assert.equal(menu.hidden,true);
    w.toggleAccountMenu();w.dispatchEvent(new w.Event('resize'));assert.equal(menu.hidden,true);
    w.sidebarLayout.collapsed=false;w.toggleAccountMenu();assert.equal(menu.hidden,false);
    w.toggleAccountMenu();assert.equal(menu.hidden,true);
    assert.equal(menu.parentNode,w.$('#side-account'));
  }finally{dom.window.close();}
});
