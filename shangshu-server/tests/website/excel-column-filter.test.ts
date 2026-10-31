import test from 'node:test';import assert from 'node:assert/strict';
import {setup,settled} from './excel-mount-harness.ts';

/**
 * 列头筛选（FIX-49/FIX-54）—— 用户 2026-10-20 14:20 原话：
 * 「我选中某列，点击工具栏上的筛选，就可以在列上有一个小图标，点击就能筛选了」
 * 19:33 补充：「**b，就像excel一样，他是在列这边的一个小的弹窗，而现在的是居中的，有点不好操作**」
 *
 * 这里跑的是**生产挂载**（`main.ts` 的 `mountExcelPage` 原样执行），
 * 判据钉的是**看得见的现象**，不是实现写法。
 *
 * 测试通过 = 下面全部成立：
 *  1. 工具栏上有「筛选」入口；点它 ⇒ **那一列**的列头出现小漏斗，**别的列没有**；
 *  2. 弹出来的是**贴在列头下面的小浮层**（**不是** `dialog.os-dialog` 那种居中模态）——
 *     浮层的顶部落在那颗漏斗按钮的**下方**，横向跟那一列对齐（**不居中**）；
 *  3. 面板里有：排序两枚、筛选器条件行、搜索框、值清单（全选 + 逐项）、应用筛选器/清除筛选器；
 *  4. **Esc** 只关浮层（不连带关别的东西）；点**小漏斗**能再开一次；
 *  5. 勾两个值 ⇒ 应用 ⇒ **行数真的变少**；清除 ⇒ 恢复；
 *  6. 排序两枚真能改顺序。
 */

const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};

function seed(h:any){
  // 用 ASCII 值：排序断言要**确定**（中文的排序规则随 ICU 变，不能拿来判「顺序变了」）。
  h.headers.set('one',['C1','C2']);
  h.data.set('one',[['C','x'],['A','y'],['B','z']]);
  h.values.set('one','C');
}

/** 浮层面板（域内浮层，不是公共弹窗）。 */
const panelOf=(h:any)=>h.context.document.querySelector('.excel-column-filter-pop') as HTMLElement|null;

test('列头筛选：工具栏「筛选」→ 那一列出现小漏斗 → 弹出**贴在列头下面的小浮层** → 勾值真筛 → 清除恢复',async()=>{
  const h=setup({personal:true,headerFrame:true,columnValues:['A','B','C']});
  try{
    seed(h);
    await h.mountPage();
    const scope=()=>h.host.querySelector('[data-scope]')?.textContent||'';
    assert.match(scope(),/共 3 行/,`挂载后行数不对：${scope()}`);

    // ① 工具栏上有一个「筛选」入口。
    const tool=h.host.querySelector('[data-column-filter]') as HTMLButtonElement;
    assert.ok(tool,'工具栏上没有「筛选」入口');
    assert.equal(tool.textContent?.trim(),'筛选');
    assert.equal(tool.disabled,false,'「筛选」入口被挡住了（应当能用）');

    // ② 点它 ⇒ **那一列**的列头有小漏斗，**别的列没有**。
    tool.click();
    await tick();
    assert.equal(h.errors.length,0,`点「筛选」报错：${h.errors.join(' | ')}`);
    const icons=[...h.host.querySelectorAll('.excel-column-filter-button')] as HTMLElement[];
    assert.equal(icons.length,1,`小漏斗该只有一个，实际 ${icons.length} 个`);
    assert.match(icons[0].getAttribute('aria-label')||'',/C1/,'小漏斗画在错的列上了');
    // 工具栏这条路开的面板 ⇒ 漏斗的 aria-expanded 也要跟上（浮层开着就是 true）。
    assert.equal(icons[0].getAttribute('aria-expanded'),'true',`浮层开着，漏斗的 aria-expanded 没跟上（实际 ${icons[0].getAttribute('aria-expanded')}）`);

    // ③ 弹出来的是**浮层**，不是居中的模态弹窗。
    assert.equal(h.context.document.querySelectorAll('dialog').length,0,'面板用了居中模态弹窗（<dialog>）');
    assert.equal(h.context.document.querySelectorAll('dialog.os-dialog').length,0,'面板用了公共弹窗（dialog.os-dialog）');
    const panel=panelOf(h);
    assert.ok(panel,'点「筛选」没弹出浮层面板');
    assert.equal(panel.getAttribute('aria-modal'),'false','浮层不该是模态');
    // ④ 浮层的**顶部**落在那颗漏斗按钮的下方，横向跟那一列对齐（不居中）。
    const funnelLeft=parseFloat(icons[0].style.left),funnelTop=parseFloat(icons[0].style.top);
    const panelTop=parseFloat(panel.style.top),panelLeft=parseFloat(panel.style.left);
    assert.ok(panelTop>=funnelTop+18&&panelTop<=funnelTop+18+16,`浮层顶部(${panelTop})没落在漏斗按钮下方(${funnelTop+18})附近`);
    assert.ok(Math.abs(panelLeft-funnelLeft)<=2,`浮层左边(${panelLeft})没跟那一列(${funnelLeft})对齐`);
    assert.ok(Math.abs(panelLeft-h.context.window.innerWidth/2)>100,'浮层还是居中的（没贴在那一列边）');

    // ⑤ 面板里有这些东西。
    const buttons=[...panel.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
    assert.ok(buttons.includes('升序'),'面板里没有「升序」');
    assert.ok(buttons.includes('降序'),'面板里没有「降序」');
    assert.ok(buttons.includes('应用筛选器'),'面板里没有「应用筛选器」');
    assert.ok(buttons.includes('清除筛选器'),'面板里没有「清除筛选器」');
    assert.ok(panel.querySelector('input[type="search"]'),'面板里没有搜索框');
    assert.ok(panel.querySelector('.excel-column-filter-all input[type="checkbox"]'),'面板里没有「全选」');
    assert.ok(panel.querySelector('.excel-column-filter-operator .excel-dropdown-trigger'),'面板里没有筛选器条件行');
    const boxes=[...panel.querySelectorAll('.excel-column-filter-value input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(boxes.length,3,`值清单该有 3 项，实际 ${boxes.length}`);

    // ⑥ Esc ⇒ 只关浮层（表格不动，也没有多出/少掉别的弹窗）。
    h.context.document.dispatchEvent(new h.context.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await tick();
    assert.equal(h.context.document.querySelectorAll('.excel-column-filter-pop').length,0,'Esc 没关掉浮层');
    assert.equal(h.context.document.querySelectorAll('dialog').length,0,'Esc 之后冒出模态弹窗');
    // 点**小漏斗**也能再开一次（列头上的入口是常驻的）。
    icons[0].dispatchEvent(new h.context.window.MouseEvent('click',{bubbles:true}));
    await tick();
    const again=panelOf(h);
    assert.ok(again,'点小漏斗没弹出浮层');
    assert.equal(h.context.document.querySelectorAll('.excel-column-filter-pop').length,1,'弹了两层');

    // ⑦ 勾两个值 ⇒ 应用 ⇒ **行数真的变少**。
    const pick=[...again.querySelectorAll('.excel-column-filter-value input[type="checkbox"]')] as HTMLInputElement[];
    pick[0].checked=true;pick[0].dispatchEvent(new h.context.window.Event('change',{bubbles:true}));
    pick[1].checked=true;pick[1].dispatchEvent(new h.context.window.Event('change',{bubbles:true}));
    const apply=[...again.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='应用筛选器') as HTMLButtonElement;
    apply.click();
    await settled(()=>h.viewRequests.length===1,h.errors);
    await settled(()=>/筛选显示 2 行/.test(h.host.querySelector('[data-scope]')?.textContent||''),h.errors);
    assert.match(scope(),/筛选显示 2 行/,`应用后行数没变少：${scope()}`);
    assert.deepEqual(h.viewRequests[0].filters,[{column:'C1',operator:'in',value:['A','B']}]);

    // ⑧ 清除 ⇒ 恢复。
    const icon=h.host.querySelector('.excel-column-filter-button') as HTMLElement;
    assert.ok(icon,'筛完列头上的小漏斗还在吗');
    icon.dispatchEvent(new h.context.window.MouseEvent('click',{bubbles:true}));
    await tick();
    const third=panelOf(h);
    assert.ok(third,'点小漏斗没弹出浮层');
    const clear=[...third.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='清除筛选器') as HTMLButtonElement;
    clear.click();
    await settled(()=>h.viewRequests.length===2,h.errors);
    await settled(()=>/共 3 行/.test(h.host.querySelector('[data-scope]')?.textContent||''),h.errors);
    assert.match(scope(),/共 3 行/,`清除后没恢复：${scope()}`);
    assert.deepEqual(h.viewRequests[1].filters,[]);
  }finally{h.close();}
});

test('列头筛选：排序两枚真能改顺序',async()=>{
  const h=setup({personal:true,headerFrame:true,columnValues:['A','B','C']});
  try{
    seed(h);
    await h.mountPage();
    (h.host.querySelector('[data-column-filter]') as HTMLButtonElement).click();
    await tick();
    const panel=panelOf(h);
    assert.ok(panel,'没弹出浮层面板');
    const desc=[...panel.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='降序') as HTMLButtonElement;
    desc.click();
    await settled(()=>h.sortRequests.length===1,h.errors);
    // 夹具在沙箱里造的对象，跨 realm 不能直接 deepEqual ⇒ 逐个字段核。
    assert.equal(h.sortRequests[0].column,'C1');
    assert.equal(h.sortRequests[0].direction,'desc');
    await settled(()=>h.grids.at(-1).lastRows.map((row:any)=>row.values[0]).join(',')==='C,B,A',h.errors);
    const values=h.grids.at(-1).lastRows.map((row:any)=>row.values[0]);
    assert.deepEqual(values,['C','B','A'],'降序没把行顺序改掉');
    // 再点同一枚 ⇒ 取消排序。
    const desc2=[...(panelOf(h) as HTMLElement).querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='降序') as HTMLButtonElement;
    desc2.click();
    await settled(()=>h.sortRequests.length===2,h.errors);
    assert.equal(h.sortRequests[1].clear,true,'再点一次降序没有取消排序');
  }finally{h.close();}
});
