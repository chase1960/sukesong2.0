import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const script = (name: string) => readFileSync(new URL(`../../../shangshu-web/js/${name}.js`, import.meta.url), 'utf8');

it('应用内受管对象改走 Excel 工作面（表格中心这一批空出来）；域自己的数据集留在原来的表格形态', async () => {
  /* ⚠️ **地址里不带 `?dataset=`**：带了 ⇒ 产品走**直达路**（real-objects.js：
     「显式 && selected.object_id ⇒ 直接去 Excel 工作面」，那一路**不画数据集清单**）
     ⇒ 清单上的表点不到。这条判据要验的是「数据目录这一页上受管对象与域数据集的分工」，
     ⇒ 从**数据总目录**进（不带 dataset）—— 这时清单画出来，默认选中的就是第一张表。 */
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'https://shangshu.local/?application=procurement#/objects' });
  const w = dom.window as any, mounted: any[] = []; let disposed = 0, guarded = true;
  /* ⚠️ **域自己的数据集没有 `object_id`**（它是数据集投影，不是受管对象）⇒
     产品才让它**留在数据页**上；带 `object_id` 的（受管对象）一律直达 Excel 工作面
     （real-objects.js：「显式 && selected.object_id ⇒ 直达那一页」）。
     ⇒ 夹具按产品的口径写：受管对象 orders 带 object_id，域数据集 invoices 不带。 */
  const datasets = [{ id: 'orders', object_id: 'orders', name: '采购订单', columns: [] }, { id: 'invoices', name: '发票', columns: [] }];
  Object.assign(w, { RENDER: {}, mainBox: () => w.document.querySelector('main'), $: (s: string, r?: any) => (r || w.document).querySelector(s), $$: (s: string, r?: any) => [...(r || w.document).querySelectorAll(s)], esc: (v: any) => String(v ?? ''), ICONS: { spark: '' }, currentUserInfo: { role: 'staff' }, chatAssist() {}, go() {} });
  w.api = async (path: string) => {
    // 域自己的数据集（invoices）**对象记录口不通** ⇒ 它留在数据页上。
    // （受管对象直接交给 Excel 工作面，不走这条。）
    if (path.includes('/objects/')) return { ok: false, status: 417, json: async () => ({ ok: false, error: '对象缺少受管 DocType 或字段定义' }) };
    return { ok: true, json: async () => path.includes('/applications/') ? { application: { title: '采购管理', datasets } } : { rows: [], total: 0, object: { id: path.includes('orders') ? 'orders' : 'invoices', source: path.includes('orders') ? 'managed' : 'domain', operations: ['read'] } } };
  };
  w.mountSheetCenter = (host: any, options: any) => { mounted.push(options); host.textContent = '采购订单编辑器'; return () => disposed++; };
  /* ⚠️ `shangshuOpenTable` 是**应用外壳**提供的全局（app.js 第 456 行：开 Excel 工作面那一跳）。
     产品侧「点一张带 object_id 的表 ⇒ 直达 Excel 工作面」这条路要靠它
     （real-objects.js：`window.shangshuOpenTable?.(...)`）⇒ 沙箱里没有它 ⇒ 直接抛错 ⇒ 页面空掉。
     这里照 app.js 的口径给一个最小替身：换页到 excel 工作面并回报 `{ok:true,pageId}`。 */
  const opened: string[] = [];
  w.shangshuOpenTable = (tableId: string) => { opened.push(tableId); return { ok: true, pageId: 'excel' }; };
  const guard = (e: any) => { if (guarded) e.preventDefault(); };
  try {
    w.eval(script('real-objects'));
    const controller = new w.AbortController();
    await w.RENDER.objects({ signal: controller.signal, isActive: () => true });
    // 受管对象（orders）⇒ 整页交给 Excel 工作面：**表格中心不再被挂起来**。
    assert.equal(mounted.length, 0, '受管对象还挂表格中心 —— 表格中心这一批没空出来');
    assert.equal(w.document.querySelector('.dataset-table'), null, '受管对象还在数据页里渲染旧形态的表格');
    assert.deepEqual(opened, [], '刚进目录不自动跳走（人先看见清单）');
    assert.ok(w.document.querySelector('[data-open-excel]'), '受管对象要给出「打开表格」的入口（不再画旧形态的表格）');
    // 切表前先保护未保存修改（这一条没变）。
    w.addEventListener('shangshu:before-page-change', guard);
    await w.document.querySelector('[data-dataset="invoices"]').onclick();
    assert.equal(new w.URLSearchParams(w.location.search).get('dataset'), null, '切表被拦 ⇒ 地址不许跟着换');
    guarded = false;
    await w.document.querySelector('[data-dataset="invoices"]').onclick();
    // 域自己的数据集（invoices）⇒ 留在原来的表格形态（不误用可编辑通用网格）。
    assert.equal(mounted.length, 0, '财务不误用可编辑通用网格');
    assert.equal(w.document.querySelector('.dataset-head h2').textContent, '发票');
    assert.equal(disposed, 0, '表格中心没有挂过 ⇒ 不用卸载');
    controller.abort();
  } finally { w.close(); }
});

it('独立表格入口退出侧栏，保留兼容路由', () => {
  const app = script('app');
  assert.match(app, /id: 'sheets'[^\n]+sidebarHidden: true/);
  assert.doesNotMatch(app.slice(app.indexOf('const ROLE_PRESET'), app.indexOf('const GROUPS')), /'sheets'/);
  const css=readFileSync(new URL('../../../shangshu-web/css/sheet-center.css',import.meta.url),'utf8');
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.sheet-heading-actions \.btn(?:,|$)/.test(rule[1].trim()))
      assert.doesNotMatch(rule[2], /(?:^|;)\s*background(?:-color)?\s*:/, '通用按钮尺寸可复用，但背景不能覆盖绿色主按钮');
  }
});

it('旧表格链接按可见应用绑定进入同一对象，不重开独立工具', async () => {
  const dom = new JSDOM('<main></main>', {runScripts:'outside-only',url:'https://shangshu.local/#/sheets'}), w=dom.window as any;
  let route='';Object.assign(w,{RENDER:{},currentUserInfo:{username:'lisa'},go:(value:string)=>{route=value;}});
  w.localStorage.setItem('shangshu.sheet.last.lisa','orders');
  w.api=async()=>({ok:true,json:async()=>({list:[{id:'finance',source:'domain',datasets:[{id:'invoices'}]},{id:'procurement',source:'managed',datasets:[{id:'orders',object_id:'orders'}]}]})});
  try{
    w.eval(script('sheet-center'));await w.RENDER.sheets({host:w.document.querySelector('main'),isActive:()=>true});
    assert.equal(route,'objects');assert.equal(new w.URLSearchParams(w.location.search).get('application'),'procurement');assert.equal(new w.URLSearchParams(w.location.search).get('dataset'),'orders');
  }finally{w.close();}
});
