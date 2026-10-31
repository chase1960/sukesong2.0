import {mountResourceAttribution, type AttributionWorkspace} from '../../../resource-attribution.mjs';
import {createLatestRead} from '../../../lib/latest-read.mjs';
import type { TableEntry } from './backend';
export interface DirectoryState { term: string; page: number; scroll: number }
type Result = { entries: TableEntry[]; total: number; truncated: boolean; errors?: string[] };
/** 只复用文件中心的展示样式；数据、授权及打开动作由 Excel 适配层提供。 */
export function mountDirectory(host: HTMLElement, options: {
  initial?: Partial<DirectoryState>;
  load: (term: string, page: number, attributionLevel: string, signal?: AbortSignal) => Promise<Result>;
  open: (key: string, state: DirectoryState, source: TableEntry['kind']) => void;
  upload: (file: File, attribution: { level: 'personal' | 'department'; department?: string }) => void;
  create?: (name: string, attribution: { level: 'personal' | 'department'; department?: string },key?:string, extra?:{headers?:string[];placeholder?:string}) => void | Promise<void | {ok:boolean;uncertain?:boolean;error?:string}>;
  /**
   * 调用方的工作面（ui.dialog / ui.closeModal）。归属弹窗**必须**跟它共用同一个
   * 模态栈 —— 组件自己另起一个工作面，Esc 会关错层（FIX-38 实踩）。
   * 没给就退回到宿主所在页面的 createToolWorkspace（拿不到就只读不选）。
   */
  ui?: AttributionWorkspace | null;
}) {
  const doc = host.ownerDocument;
  const assignmentLifecycle = new AbortController();
  const reads = createLatestRead(assignmentLifecycle.signal);
  const state: DirectoryState = { term: '', page: 1, scroll: 0, ...options.initial };
  const pageSize = 20;
  let result: Result = {entries:[],total:0,truncated:false};
  let generation = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing=false;
  /* R5 归属面板 —— 新建/上传共用。
     **FIX-59**：这块表单搬进**公共弹窗**（不再摊在页面顶部）。
     ⚠️ 原来这里套了个 fieldset + legend「归属设置」，**但归属组件自己就带「文件归属」标签**
     ⇒ 弹窗里那两个字**出现两次**；而且 file-attribution-* 这些类**本来就没有样式**，
     看到的那个框是 fieldset 的浏览器默认边框 ⇒ 一并去掉。 */
  host.innerHTML = `
    <header class="file-heading page-heading"><h1>Excel</h1>
      <button type="button" class="btn btn-ghost" data-upload>上传表格</button>
      <button type="button" class="btn btn-pri" data-new-table>新建</button>
      <input type="file" accept=".xlsx" data-upload-input hidden>
      <p data-upload-status role="status" aria-live="polite" hidden></p>
    </header>
    <!-- R5: 归属选择面板 —— 新建/上传共用（FIX-59：这块表单搬进公共弹窗） -->
    <div class="file-attribution-panel" data-attribution-panel hidden>
      <!-- 用**公共**的 .attribution-field 排版（标签在上、控件在下）——
           跟文件中心「上传文件」弹窗一个观感（用户 2026-10-20 22:31 的要求）。 -->
      <label class="attribution-field" data-attribution-name hidden>
        <span>表名</span>
        <input type="text" data-attribution-name-input placeholder="输入表格名称" maxlength="100">
      </label>
      <!-- 2026-10-21（agent 建表一线）：**人和 agent 走同一条路** ——
           人工建表也把「表头」和「占位提示」摆出来，走**同一个动作**
           （files.create，带 headers / placeholder）⇒ 人和 agent 拿到的是同一种表。
           归属那块**一个字没动**（还是那个公共归属组件）。 -->
      <label class="attribution-field" data-attribution-headers hidden>
        <span>表头（逗号分隔，如「客户,金额」）</span>
        <input type="text" data-attribution-headers-input placeholder="留空＝默认一列" maxlength="500">
      </label>
      <label class="attribution-field" data-attribution-placeholder hidden>
        <span>占位提示（写进前两行第一格）</span>
        <input type="text" data-attribution-placeholder-input placeholder="这是占位，请改" maxlength="200">
      </label>
      <div class="attribution-field">
        <span>文件归属</span>
        <div data-resource-attribution></div>
      </div>
      <p class="file-attribution-file" data-attribution-file hidden></p>
      <p class="file-attribution-error" data-attribution-error role="alert" hidden></p>
      <div class="file-attribution-actions">
        <button type="button" class="btn btn-ghost" data-attribution-cancel>取消</button>
        <button type="button" class="btn btn-pri" data-attribution-confirm>确认</button>
      </div>
    </div>
    <section class="file-tools" aria-label="搜索与筛选">
      <div class="file-filter-row">
      <label class="file-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
        <input type="search" data-picker-search placeholder="搜索表名" aria-label="搜索表名"></label>
      <select data-attribution-filter aria-label="按归属筛选">
        <option value="">全部归属</option>
        <option value="personal">个人</option>
        <option value="department">所属部门</option>
      </select>
      <button type="button" class="btn btn-ghost" data-clear-filter>清除筛选</button>
      <span class="file-count" data-count aria-live="polite"></span>
      </div>
    </section>
    <div class="file-content"><section class="file-table-area" aria-label="表格列表">
      <div class="file-table-scroll" tabindex="0" aria-label="可滚动的表格列表"><table class="file-table">
        <thead><tr><th scope="col">表名</th><th scope="col">归属</th><th scope="col">更新时间</th><th scope="col">权限</th><th scope="col">操作</th></tr></thead>
        <tbody data-picker-list></tbody></table></div>
      <div class="file-pagination"><span data-page-info aria-live="polite"></span>
        <button type="button" class="btn btn-ghost" data-picker-prev>上一页</button>
        <button type="button" class="btn btn-ghost" data-picker-next>下一页</button></div>
    </section></div>`;
  const find = <T extends Element>(selector: string) => host.querySelector<T>(selector)!;
  const search = find<HTMLInputElement>('[data-picker-search]');
  const body = find<HTMLTableSectionElement>('tbody');
  const scroll = find<HTMLElement>('.file-table-scroll');
  const prev = find<HTMLButtonElement>('[data-picker-prev]');
  const next = find<HTMLButtonElement>('[data-picker-next]');
  const info = find<HTMLElement>('[data-page-info]');
  const count = find<HTMLElement>('[data-count]');
  const attrFilter = find<HTMLSelectElement>('[data-attribution-filter]');
  search.value = state.term;
  /** 归属筛选级别（'' = 全部） */
  let attributionFilter = '';
  /** 行节点缓存（key → 行元素）。增量更新靠它**复用 DOM**，不重建整张表。 */
  const rowCache = new Map<string, HTMLTableRowElement>();
  function note(title: string, detail = '', retry = false) {
    const tr = doc.createElement('tr'), td = doc.createElement('td'), strong = doc.createElement('strong');
    td.colSpan = 5; td.className = 'empty'; strong.textContent = title; td.append(strong);
    const message = doc.createElement('span'); message.textContent = detail; td.append(message);
    if (retry) {const button=doc.createElement('button');button.type='button';button.className='btn btn-ghost';button.textContent='重试';button.addEventListener('click',()=>void load());td.append(doc.createElement('br'),button);}
    tr.append(td);
    // 空态/错误态 ⇒ 列表确实空了，缓存一并清掉（这时重建是对的）
    rowCache.clear();
    body.replaceChildren(tr);
  }
  /** 造一行（第一次见到这个 key 时才造）。 */
  function buildRow(entry: TableEntry): HTMLTableRowElement {
    const tr=doc.createElement('tr');tr.dataset.table=entry.key;
    const name=doc.createElement('td'), open=doc.createElement('button');
    open.type='button';open.className='file-open';open.title=entry.title;open.setAttribute('aria-label',entry.title);
    const symbol=doc.createElement('span');symbol.className='file-symbol sheet';symbol.setAttribute('aria-hidden','true');
    symbol.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M4 9h16M4 15h16M10 9v12"/></svg>';
    const title=doc.createElement('span');title.className='file-name';title.textContent=entry.title;
    // ★ fast 那边加的来源角标：业务数据（库表）／文件工作簿（xlsx）。
    const source=doc.createElement('small');source.textContent=entry.kind==='db'?'业务数据':'文件工作簿';
    source.className='file-type';
    open.append(symbol,title,source);name.append(open);tr.append(name);
    for (const value of [entry.ownership,entry.updatedAt,entry.permission]) {const td=doc.createElement('td');td.textContent=value||'—';td.title=value||'未设置';tr.append(td);}
    const actions=doc.createElement('td'), link=doc.createElement('button');link.type='button';link.className='file-link';link.textContent='打开';actions.append(link);tr.append(actions);
    if(entry.canAssign && entry.kind==='xlsx'){const assign=doc.createElement('button');assign.className='file-link';assign.textContent='调整归属';assign.type='button';assign.addEventListener('click',()=>{const w=window as unknown as {openResourceAssignment?:(o:{host:HTMLElement;resource:string;title:string;onSaved:()=>Promise<void>;signal:AbortSignal})=>Promise<unknown>};void w.openResourceAssignment?.({host,resource:entry.key,title:entry.title,onSaved:load,signal:assignmentLifecycle.signal});});actions.append(assign);}
    const select=()=>{const current=result.entries.find(item=>item.key===entry.key)??entry;options.open(current.key,{...state,scroll:scroll.scrollTop},current.kind);};open.addEventListener('click',select);link.addEventListener('click',select);
    return tr;
  }
  /** 只改**变了的那几个字**，其余 DOM 原地不动。 */
  function updateRow(tr: HTMLTableRowElement, entry: TableEntry) {
    const cells=tr.querySelectorAll('td');
    const open=tr.querySelector<HTMLButtonElement>('.file-open');
    if(open){open.title=entry.title;open.setAttribute('aria-label',entry.title);const t=open.querySelector('.file-name');if(t)t.textContent=entry.title;
      const s=open.querySelector('.file-type');if(s)s.textContent=entry.kind==='db'?'业务数据':'文件工作簿';}
    const values=[entry.ownership,entry.updatedAt,entry.permission];
    values.forEach((value,i)=>{const td=cells[i+1];if(!td)return;const text=value||'—';if(td.textContent!==text)td.textContent=text;const title=value||'未设置';if(td.title!==title)td.title=title;});
  }
  function paint() {
    // ⚠️ **页码决定实际读取范围**（2026-10-28 · PKG-132 · 审查报告 R11）：
    //   `result.entries` **就是这一页**（服务端分页读回来的）⇒ 这里**不再浏览器切片**；
    //   归属筛选也**在服务端**做了 ⇒ 这里**不再前端筛**（以前筛的是「手头那一批」，
    //   计数与总数对不上 ⇒ 会骗人）。
    const filtered = result.entries;
    const pages=Math.max(1,Math.ceil((result.total||0)/pageSize));
    state.page=Math.max(1,Math.min(pages,Math.floor(state.page)||1));
    // FIX-39（用户 2026-10-20：「把所有 dom 的刷新去掉」）：
    // 改之前每次都 `body.replaceChildren()` **整表重建** ⇒ 点一下「刷新」整张表
    // 消失再出现，**滚动位置、hover 状态、键盘焦点全丢**。
    // 改后：**按行 key 增量更新** —— 数据没变的行**复用同一个 DOM 节点**，
    // 只改变了的那几个字；离开本页的行才移除。
    // ★ 合并说明：fast 那边的「整表重建」写法换成上面的增量写法（FIX-39 保留），
    //   但 fast 加的两处**行内信息**补进了 buildRow/updateRow：
    //   ① 打开按钮的 `aria-label`（读屏用）② `file-type` 角标（业务数据/文件工作簿）。
    // ⚠️ **只保留「最多一页」的安全上限**，**不按页码再切**（R11）：
    //   页码已由**服务端**决定读取范围 ⇒ 这里再按 (page-1)*pageSize 切就会切错。
    //   但 loader 仍可能给回**多于一页** ⇒ 保留上限，页面永远只显示一页。
    // ⚠️ **「服务端给了多少」与「渲染了多少」要分开算**：
    //   「已加载 N / 共 M」里的 N 是**服务端这一批给的条数**（不是渲染出来的条数）。
    const loaded=filtered.length;
    const pageEntries=filtered.slice(0,pageSize);
    const wanted=new Set(pageEntries.map(e=>e.key));
    for(const [key,tr] of [...rowCache])if(!wanted.has(key)){tr.remove();rowCache.delete(key);}
    let anchor=body.querySelector<HTMLTableRowElement>('tr');
    for(const entry of pageEntries){
      let tr=rowCache.get(entry.key);
      if(!tr){tr=buildRow(entry);rowCache.set(entry.key,tr);}
      else updateRow(tr,entry);
      if(anchor!==tr){body.insertBefore(tr,anchor);}
      else anchor=anchor.nextElementSibling as HTMLTableRowElement|null;
    }
    if (!filtered.length) {if(result.errors?.length)note('表格列表未完整加载',result.errors.join('；'),true);else note(state.term?'没有匹配的表格':'还没有可打开的表格',state.term?'换个表名搜索，或清除筛选。':'上传一张 Excel 表格开始使用。');}
    count.textContent=result.truncated?`已加载 ${loaded} / 共 ${result.total} 张，搜索可缩小范围`:`共 ${result.total||loaded} 张表格`;
    if(result.errors?.length){count.textContent+=` · 部分列表未加载：${result.errors.join('；')}`;}
    info.textContent=`第 ${state.page} / ${pages} 页 · ${result.truncated?'已加载':'共'} ${result.total||loaded} 张`;
    prev.disabled=state.page<=1;next.disabled=state.page>=pages;
    // 滚动位置**不重设** —— 之前那句 `scroll.scrollTop=state.scroll` 会在每次重绘时
    // 把用户滚到的位置拉回去（state.scroll 是进页时记的旧值）。
  }
  async function load() {
    clearTimeout(timer);const mine=++generation;host.setAttribute('aria-busy','true');prev.disabled=next.disabled=true;
    const request=reads.begin();
    // FIX-39：改之前这里 `note('正在加载表格…')` **把列表清空** ——
    // 于是点一下「刷新」，整张表先消失、加载完再出现（滚动位置/hover/焦点全丢）。
    // 改后：**加载中不清空**，旧行留在原地，状态写在计数/页码那一行。
    count.textContent='正在加载表格…';info.textContent='';
    try {const loaded=await options.load(state.term,state.page,attributionFilter,request.signal);if(disposed||mine!==generation||!request.isCurrent())return;result=loaded;paint();}
    catch(error){if(disposed||mine!==generation)return;note('表格列表加载失败',error instanceof Error?error.message:String(error),true);}
    finally{if(!disposed&&mine===generation)host.removeAttribute('aria-busy');}
  }
  const scheduleSearch=()=>{clearTimeout(timer);reads.cancel();generation++;state.term=search.value.trim();state.page=1;state.scroll=0;timer=setTimeout(()=>void load(),250);};
  search.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);reads.cancel();generation++;});
  search.addEventListener('compositionend',()=>{composing=false;scheduleSearch();});
  search.addEventListener('input',()=>{if(!composing)scheduleSearch();});
  // ⚠️ 归属筛选**在服务端**做 ⇒ 要**重新读**（R11），不是本地重画。
  attrFilter.addEventListener('change',()=>{attributionFilter=attrFilter.value;state.page=1;state.scroll=0;void load();});
  find('[data-clear-filter]').addEventListener('click',()=>{search.value='';state.term='';attributionFilter='';attrFilter.value='';state.page=1;state.scroll=0;void load();});
  // ⚠️ **翻页要重新读**（R11）：以前是「本地切片重画」⇒ 页码根本不决定网络读取范围。
  prev.addEventListener('click',()=>{state.page=Math.max(1,state.page-1);state.scroll=0;void load();});
  next.addEventListener('click',()=>{state.page=state.page+1;state.scroll=0;void load();});
  const input=find<HTMLInputElement>('[data-upload-input]');
  const attrPanel=find<HTMLElement>('[data-attribution-panel]');
  const attrNameDiv=find<HTMLElement>('[data-attribution-name]');
  const attrNameInput=find<HTMLInputElement>('[data-attribution-name-input]');
  const attrHeadersDiv=find<HTMLElement>('[data-attribution-headers]');
  const attrHeadersInput=find<HTMLInputElement>('[data-attribution-headers-input]');
  const attrPlaceholderDiv=find<HTMLElement>('[data-attribution-placeholder]');
  const attrPlaceholderInput=find<HTMLInputElement>('[data-attribution-placeholder-input]');
  const attrConfirmBtn=find<HTMLButtonElement>('[data-attribution-confirm]');
  const attrCancelBtn=find<HTMLButtonElement>('[data-attribution-cancel]');
  const attrActionRow=find<HTMLElement>('.file-attribution-actions');
  const attrError=find<HTMLElement>('[data-attribution-error]');
  const attrFileLine=find<HTMLElement>('[data-attribution-file]');
  /* ★ FIX-59（用户 2026-10-20 21:2x，附截图：「如果你用浏览器点击新建，仍然会是这个样子」）：
     「新建表格」那块表单原来**摊在页面顶部**（表单挤在左上、取消/创建在最右、中间一大片空白）
     ⇒ 改成**公共弹窗**（`ui.dialog`），与归属弹窗**同一个工作面**
     —— 否则 Esc 会关错层（FIX-38 实踩过：组件自建工作面，Esc 关的是另一层）。
     面板本体搬进弹窗；「取消/创建」搬进弹窗底部（公共弹窗的 footer 就是干这个的）。 */
  let panelDialog: HTMLElement | null = null;
  /** 弹窗关掉时把面板和两个按钮搬回页面 —— 下次还能再开（弹窗元素本身已被移除）。 */
  const restorePanel = () => {
    if (attrActionRow && attrActionRow.parentElement !== attrPanel) attrPanel.appendChild(attrActionRow);
    if (attrPanel.parentElement !== host) host.appendChild(attrPanel);
    attrPanel.hidden = true;
    panelDialog = null;
  };
  /** 打开那块表单（弹窗形态）。没有工作面 ⇒ 退回行内（老样子，不至于没法用）。 */
  const openPanelDialog = (title: string, confirmLabel: string) => {
    attrConfirmBtn.textContent = confirmLabel;
    attrPanel.hidden = false;
    if (!workspace || typeof workspace.dialog !== 'function') return;
    const dialog = workspace.dialog({title, body: attrPanel, actions: [], onClose: () => restorePanel()});
    if (!dialog) return;
    panelDialog = dialog;
    const footer = dialog.querySelector('footer');
    if (footer) { footer.append(attrCancelBtn, attrConfirmBtn); }
  };
  /** 确认按钮那一步校验通过的归属。用户从面板走到系统文件对话框要一会儿，
   *  中途面板已 hidden —— 上传该带的是**他确认过的那份**，不是那一刻的 DOM 快照。 */
  // FIX-12（2026-10-19 用户 A04 原话「点击上传-选择文件-选择归属-确认-上传」）：
  // 先选文件，文件选定后才弹归属面板，确认后才上传。pendingFile 就是「已选但还没确认」的文件。
  let pendingFile:File|null=null;
  /** BASE967-10：归属不合法时的面板内提示。改之前用裸 alert()——弹窗挡住整个面板，
   *  用户看不到自己刚才选了什么，改完还得重新开一次面板。 */
  function showAttrError(message:string,focus?:HTMLElement|null){
    attrError.textContent=message;
    attrError.hidden=false;
    focus?.focus();
    return false;
  }
  function clearAttrError(){
    attrError.hidden=true;
    attrError.textContent='';
  }
  /** 归属是否可用。**前置拦一道**：后端 E 也会拒（417「不传归属不能建文件」），
   *  但那时文件已经选完、进度条已经走过一轮，用户白等。 */
  type Attribution={level:'personal'|'department';department?:string};
  /* 归属走**公共组件**（弹窗式，全站共用同一件）：ui 由调用方给，
     弹窗跟页面共用同一个模态栈 —— Esc 只关最上层那扇。 */
  const workspace=options.ui ?? (globalThis as any).createToolWorkspace?.(host,{signal:assignmentLifecycle.signal}) ?? null;
  /* 归属标签由**弹窗里那块 markup**自己写（跟文件中心「上传文件」弹窗一样）⇒
     组件这边 label 传空，免得「文件归属」出现两次。
     ★ FIX-59（用户 2026-10-20 22:4x：「把图二的那个选项直接和图一的弹窗合并，
       放在文件归属下面」）⇒ 这里摊开：两张选项卡（本人／获权部门）**直接摊在
       「文件归属」下面**，**不再叠第二扇窗**。
     ★ PKG-016（用户 2026-10-21：「**不要用重叠弹窗，直接摊出来**」）⇒ 公共组件**只剩摊开
       一种形态**，`inline` 这个开关整个没了 —— 全站写法统一成这一行。 */
  const attributionPicker=mountResourceAttribution(find('[data-resource-attribution]'),
    {defaultLevel:'personal',fetcher:fetch,ui:workspace,label:''});
  const readAttribution=()=>attributionPicker.read();
  let panelMode: 'upload'|'create' = 'upload';
  let creating=false,createAttempt:{name:string;attribution:Attribution;key:string;extra?:{headers?:string[];placeholder?:string}}|null=null;
  const lockCreate=(locked:boolean)=>{attributionPicker.lock(locked);attrNameInput.disabled=locked;attrHeadersInput.disabled=locked;attrPlaceholderInput.disabled=locked;};

  // R3: 点新建 → 弹**新建表格弹窗**（FIX-59：不再是页面顶部一块）
  find('[data-new-table]').addEventListener('click',()=>{
    if(creating||createAttempt){openPanelDialog('新建表格','创建');return;}
    panelMode='create';
    attributionPicker.reset('personal');
    attrNameDiv.hidden=false;
    attrNameInput.value='';
    // 2026-10-21（agent 建表一线）：表头/占位两块只在**新建**时摊出来（上传用不到），
    // 占位默认写「这是占位，请改」—— 跟 agent 那条路**同一句**。
    attrHeadersDiv.hidden=false;
    attrHeadersInput.value='';
    attrPlaceholderDiv.hidden=false;
    attrPlaceholderInput.value='这是占位，请改';
    pendingFile=null;
    attrFileLine.hidden=true;
    clearAttrError();
    openPanelDialog('新建表格','创建');
    void loadDepartments();
  });
  // R4（FIX-12）：点上传 → **第一步选文件**（不是先弹归属面板）。
  // 用户 2026-10-19 A04 原话：「点击上传-选择文件-选择归属-确认-上传」。
  find('[data-upload]').addEventListener('click',()=>{
    if(creating||createAttempt){openPanelDialog('上传表格','确认上传');return;}
    pendingFile=null;
    attrFileLine.hidden=true;
    attrHeadersDiv.hidden=true;
    attrPlaceholderDiv.hidden=true;
    input.click();
  });
  // 取消：关掉弹窗（不写任何数据）
  attrCancelBtn.addEventListener('click',()=>{if(creating||createAttempt){showAttrError('创建结果待核实，请重试原操作');return;}
    pendingFile=null;attrFileLine.hidden=true;clearAttrError();
    if(panelDialog)workspace?.closeModal?.();else attrPanel.hidden=true;});
  // 确认归属 → 新建或打开文件选择（必填归属：不填不让过）
  attrConfirmBtn.addEventListener('click',async()=>{
    if(creating)return;
    const attr=readAttribution();
    if(!attr.ok){showAttrError(attr.reason,attr.focus);return;}
    if(panelMode==='create'){
      const name=attrNameInput.value.trim();
      if(!name){showAttrError('请输入表格名称',attrNameInput);return;}
      // 2026-10-21（agent 建表一线）：**表头/占位跟 agent 走同一个动作**（files.create 的
      // headers / placeholder）⇒ 人和 agent 拿到的是同一种表，不是两条路。
      const headers=attrHeadersInput.value.split(/[,，]/).map(item=>item.trim()).filter(Boolean);
      const placeholder=attrPlaceholderInput.value.trim();
      createAttempt??={name,attribution:attr.value,key:'excel-new-'+crypto.randomUUID(),
        extra:{...(headers.length?{headers}:{}),...(placeholder?{placeholder}:{})}};
      creating=true;lockCreate(true);attrConfirmBtn.disabled=true;
      try{
        const outcome=await options.create?.(createAttempt.name,createAttempt.attribution,createAttempt.key,createAttempt.extra);
        if(outcome&&outcome.ok===false){
          showAttrError(outcome.error||'创建失败，请重试');
          if(!outcome.uncertain){createAttempt=null;lockCreate(false);}
          attrConfirmBtn.textContent=outcome.uncertain?'核实并重试原创建':'创建';
        }else{createAttempt=null;lockCreate(false);if(panelDialog)workspace?.closeModal?.();else attrPanel.hidden=true;}
      }catch(error){showAttrError('创建结果待核实，请重试原操作：'+String(error));attrConfirmBtn.textContent='核实并重试原创建';}
      finally{creating=false;attrConfirmBtn.disabled=false;}
    }else{
      // FIX-12：文件已经在第一步选好了，这里只差确认；没有文件就不许上传。
      const file=pendingFile;
      if(!file){showAttrError('请先选择要上传的文件',attrPanel);return;}
      clearAttrError();
      if(panelDialog)workspace?.closeModal?.();else attrPanel.hidden=true;
      pendingFile=null;
      attrFileLine.hidden=true;
      options.upload(file,attr.value);
    }
  });
  const loadDepartments=()=>attributionPicker.load();
  // 文件选择后：带上**确认按钮那一步已校验过**的归属调 upload。
  // 改之前这里重新读一遍 DOM：面板已经 hidden，用户看不到自己选了什么，
  // 出错也只有裸 alert。改之后归属在确认时就定下，这里只做兜底复核（防止绕过面板直接塞文件）。
  input.addEventListener('change',()=>{
    const file=input.files?.[0];input.value='';
    if(!file)return;
    // FIX-12：选完文件才弹归属面板（第二步），并把已选文件名写出来，
    // 用户知道自己要上传的是哪个文件；此时**还没上传**。
    pendingFile=file;
    panelMode='upload';
    attrNameDiv.hidden=true;
    // 上传用不到表头/占位两块（新建才摊出来）—— 跟「新建」那次的状态隔开。
    attrHeadersDiv.hidden=true;
    attrPlaceholderDiv.hidden=true;
    clearAttrError();
    attrFileLine.textContent='已选文件：'+file.name;
    attrFileLine.hidden=false;
    openPanelDialog('上传表格','确认上传');
    void loadDepartments();
  });
  const ready=load();
  return {ready,dispose(){assignmentLifecycle.abort();disposed=true;generation++;clearTimeout(timer);}};
}
