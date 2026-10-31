/**
 * 列头筛选（Excel 的**表现形式**）。
 *
 * 用户 2026-10-20 14:20：「我选中某列，点击工具栏上的筛选，就可以在列上有一个小图标，
 * 点击就能筛选了」；同日 19:33：「b，就像excel一样，他是在列这边的一个小的弹窗，
 * 而现在的是居中的，有点不好操作，懂我意思吧」
 *
 * ⇒ 面板是**贴在列头下面的小浮层**（像 Excel），**不是**居中的大弹窗。
 * 理由是「不好操作」：筛某一列时，视线和鼠标不用离开那一列。
 *
 * 四步（用户定死的）：
 *   ① 选中某列 → ② 点工具栏「筛选」→ ③ 那一列表头出现小漏斗 → ④ 点小漏斗弹出面板。
 *
 * 三条规矩：
 *  · 面板是**域内自己的浮层**（`position:fixed` ＋ 按漏斗按钮的**视口**坐标定位）——
 *    不是公共模态弹窗：点外面就关、Esc 只关面板、**页面不被锁住**；
 *  · 筛选结果存**个人视图**（`files.sheet_view_save` 同一件）⇒ 刷新还在、别人不受影响；
 *  · 值清单是**整列**的去重值（不是当前页），不可读的列**压根不给**（FIX-47 同一条闸）。
 *
 * 筛选的**语义一个字没改**（匹配方式、值清单勾选、排序、应用/清除）——
 * 这一版改的只是「**怎么摆**」。
 */
import {createDropdown,closeDropdowns,hasOpenDropdown,type DropdownHandle} from './dropdown';
import {
  MAX_IN_TOTAL_LENGTH,MAX_IN_VALUES,MAX_IN_VALUE_LENGTH,
  type ColumnValues,type FilterOperator,type PersonalView,type PersonalViewFilter,
} from './personal-view';

/** 可筛选的列。`readable:false` = 这一列当前用户读不到（不该出现在选项里）。 */
export interface FilterableColumn{id:string;label:string;readable:boolean}

/** 空值在清单里的样子（界面上显示成「(空白)」，存的是空字符串）。 */
export const BLANK_LABEL='(空白)';
export function valueLabel(value:string):string{return value===''?BLANK_LABEL:value;}

/**
 * 把「这一列的新条件」并进**整份**个人视图。
 *
 * 别的列的条件**原样留着** —— 列与列之间是 AND（与 Excel 一致）。
 * 同一列只留一条：后写的覆盖先写的。
 */
export function mergeColumnFilter(view:PersonalView,column:string,filter:PersonalViewFilter|null):PersonalView{
  const filters=view.filters.filter(item=>item.column!==column);
  if(filter){
    // 原来有这一列的条件就**原地换掉**（列表不跳位），没有就加在末尾。
    const at=view.filters.findIndex(item=>item.column===column);
    if(at>=0)filters.splice(at,0,filter);else filters.push(filter);
  }
  return {...view,filters};
}

/* ——————— 浮层摆在哪儿（纯算式，好测） ——————— */

/** 浮层挂在哪儿（那一列漏斗按钮的**视口**矩形）。 */
export interface ColumnFilterAnchor{left:number;top:number;right:number;bottom:number;width:number;height:number}

/** 面板该摆哪儿。 */
export interface ColumnFilterPlacement{left:number;top:number;maxHeight:number;up:boolean}

/** 面板宽度（CSS 里也是这个值；量不到时用它兜底）。 */
export const COLUMN_FILTER_PANEL_WIDTH=280;
/** 面板与漏斗按钮之间的缝。 */
const COLUMN_FILTER_GAP=4;
/** 离视口边至少留这么多。 */
const COLUMN_FILTER_MARGIN=8;
/** 面板最高多高（再高就内部滚动）。 */
const COLUMN_FILTER_MAX_HEIGHT=600;

/**
 * 算面板该摆哪儿（视口坐标）。
 *
 * 规矩（用户 2026-10-20 19:33「像 excel 一样」）：
 *  · 默认**贴在漏斗按钮下方**，左边跟那一列对齐；
 *  · **下方放不下就往上翻**（这时面板底边贴着列头上沿 —— 与 Excel 一致）；
 *  · 两边都放不下 ⇒ 限高（内部滚动），不许跑出视口。
 */
export function placeColumnFilterPanel(anchor:ColumnFilterAnchor,size:{width:number;height:number},viewport:{width:number;height:number}):ColumnFilterPlacement{
  const width=Math.max(120,Math.min(size.width||COLUMN_FILTER_PANEL_WIDTH,Math.max(120,viewport.width-COLUMN_FILTER_MARGIN*2)));
  const height=Math.max(0,size.height||0);
  const below=Math.max(0,viewport.height-anchor.bottom-COLUMN_FILTER_GAP-COLUMN_FILTER_MARGIN);
  const above=Math.max(0,anchor.top-COLUMN_FILTER_GAP-COLUMN_FILTER_MARGIN);
  /* 下方放得下就往下；放不下、而上方更宽 ⇒ 往上翻。 */
  const up=height>below&&above>below;
  const room=Math.max(120,Math.min(up?above:below,COLUMN_FILTER_MAX_HEIGHT));
  const top=up
    ?Math.max(COLUMN_FILTER_MARGIN,anchor.top-COLUMN_FILTER_GAP-Math.min(height,room))
    :anchor.bottom+COLUMN_FILTER_GAP;
  /* 横向：跟那一列对齐；右边顶到视口就往里收。 */
  let left=anchor.left;
  if(left+width>viewport.width-COLUMN_FILTER_MARGIN)left=Math.max(COLUMN_FILTER_MARGIN,viewport.width-width-COLUMN_FILTER_MARGIN);
  return {left,top,maxHeight:room,up};
}

/* ——————— 列头上的小漏斗（浮层画在域内，不动 Univer） ——————— */

export interface ColumnFilterFrame{
  clip:{left:number;top:number;width:number;height:number};
  /** 某一列表头在宿主坐标里的矩形；不在可视区就 null。 */
  headerRect(colIndex:number):{left:number;top:number;width:number;height:number}|null;
}

/** 打开筛选面板后拿到的东西（域内自己用；`main.ts` 只管把它造出来）。 */
export interface ColumnFilterPanelHandle{
  /** 浮层元素。 */
  element:HTMLElement;
  /** 浮层还开着没有。 */
  isOpen():boolean;
  /** 关掉浮层。 */
  close():void;
  /** 关掉时回调一次。 */
  onClose(handler:()=>void):void;
  /** 锚点挪了（那一列滚走了）⇒ 面板跟着挪。 */
  reposition(anchor:ColumnFilterAnchor):void;
}

export interface ColumnFilterOverlayOptions{
  frame():ColumnFilterFrame|null;
  /** 当前表的列（数组下标 = 列在表里的位置）。 */
  columns():Array<{id:string;label?:string}>;
  /** 哪些列要画小图标（用户点过「筛选」的列 ＋ 当前真有筛选条件的列）。 */
  marked():Set<string>;
  /** 造这一列的筛选面板（浮层）；返回 null = 不给开（如不可读的列）。 */
  panel(columnId:string,anchor:ColumnFilterAnchor,trigger:HTMLElement|null):ColumnFilterPanelHandle|null;
}

const FUNNEL_SIZE=18;

export function mountColumnFilterOverlay(host:HTMLElement,options:ColumnFilterOverlayOptions){
  const doc=host.ownerDocument,win=doc.defaultView!;
  const layer=doc.createElement('div');
  layer.className='excel-column-filter-layer';
  layer.setAttribute('aria-label','列头筛选');
  host.appendChild(layer);
  const buttons=new Map<string,HTMLButtonElement>();
  let frameId:number|null=null,dead=false;
  let openHandle:ColumnFilterPanelHandle|null=null,openColumn='';
  const raf=(callback:()=>void)=>win.requestAnimationFrame?win.requestAnimationFrame(callback):win.setTimeout(callback,0);
  function queue(){if(!dead&&frameId===null)frameId=raf(()=>{frameId=null;paint();});}
  function create(column:{id:string;label?:string}){
    const button=doc.createElement('button');
    button.type='button';
    button.className='excel-column-filter-button';
    button.setAttribute('aria-label',`筛选「${column.label||column.id}」`);
    button.setAttribute('aria-haspopup','dialog');
    button.setAttribute('aria-expanded','false');
    button.title=`筛选「${column.label||column.id}」`;
    button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>';
    /* 别让这个点落到 Univer 的选区上 —— 用户点的是漏斗，不是选单元格。 */
    button.addEventListener('pointerdown',event=>event.stopPropagation());
    button.addEventListener('mousedown',event=>event.stopPropagation());
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();toggle(column.id);});
    layer.appendChild(button);
    return button;
  }
  /**
   * 那一列漏斗按钮的**视口**矩形（面板贴着它展开）。
   *
   * 漏斗已经画出来了 ⇒ 直接量它（最准）。
   * 还没画出来（工具栏那条路刚点完）⇒ 按列头矩形算它**该在哪儿**。
   */
  function anchorOf(columnId:string):ColumnFilterAnchor|null{
    const index=options.columns().findIndex(column=>column.id===columnId);
    if(index<0)return null;
    const button=buttons.get(columnId);
    if(button){
      const rect=button.getBoundingClientRect();
      if(rect.width>0||rect.height>0)return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};
    }
    const frame=options.frame();
    const rect=frame?frame.headerRect(index):null;
    if(!rect)return null;
    const hostRect=host.getBoundingClientRect();
    const left=hostRect.left+rect.left+rect.width-FUNNEL_SIZE-3;
    const top=hostRect.top+rect.top+Math.max(0,(rect.height-FUNNEL_SIZE)/2);
    return {left,top,right:left+FUNNEL_SIZE,bottom:top+FUNNEL_SIZE,width:FUNNEL_SIZE,height:FUNNEL_SIZE};
  }
  /** 打开某一列的筛选面板（浮层）。 */
  function openPanel(columnId:string):boolean{
    const anchor=anchorOf(columnId);
    if(!anchor)return false;
    const trigger=buttons.get(columnId)??null;
    const handle=options.panel(columnId,anchor,trigger);
    if(!handle)return false;
    openHandle=handle;openColumn=columnId;
    trigger?.setAttribute('aria-expanded','true');
    handle.onClose(()=>{
      if(openHandle!==handle)return;
      openHandle=null;openColumn='';
      buttons.get(columnId)?.setAttribute('aria-expanded','false');
    });
    return true;
  }
  /** 点漏斗：开着就收，收着就开。 */
  function toggle(columnId:string){
    if(openHandle&&openHandle.isOpen()){
      openHandle.close();
      if(openColumn===columnId)return;
    }
    openPanel(columnId);
  }
  function paint(){
    if(dead)return;
    const frame=options.frame();layer.hidden=!frame;if(!frame)return;
    const marked=options.marked(),wanted=new Set<string>();
    options.columns().forEach((column,index)=>{
      if(!marked.has(column.id))return;
      const rect=frame.headerRect(index);if(!rect)return;
      wanted.add(column.id);
      const button=buttons.get(column.id)??create(column);buttons.set(column.id,button);
      Object.assign(button.style,{left:Math.round(rect.left+rect.width-FUNNEL_SIZE-3)+'px',top:Math.round(rect.top+Math.max(0,(rect.height-FUNNEL_SIZE)/2))+'px',width:FUNNEL_SIZE+'px',height:FUNNEL_SIZE+'px'});
      /* 工具栏那条路是**先开面板、后画漏斗** ⇒ 画出来时把 aria 补上。 */
      if(openHandle&&openHandle.isOpen()&&openColumn===column.id)button.setAttribute('aria-expanded','true');
    });
    for(const [id,button] of buttons)if(!wanted.has(id)){button.remove();buttons.delete(id);}
    /* 那一列滚走了 ⇒ 面板跟着挪。 */
    if(openHandle&&openHandle.isOpen()){
      const anchor=anchorOf(openColumn);
      if(anchor)openHandle.reposition(anchor);
    }
  }
  return {
    refresh:queue,
    paint,
    /** 打开某一列的筛选面板（工具栏「筛选」那条路用）。 */
    openPanel:(columnId:string)=>openPanel(columnId),
    dispose(){
      dead=true;
      if(frameId!==null){if(win.cancelAnimationFrame)win.cancelAnimationFrame(frameId);else win.clearTimeout(frameId);}
      openHandle?.close();
      layer.remove();buttons.clear();
    },
  };
}

/* ——————— 筛选面板（贴在列头下面的小浮层） ——————— */

export interface ColumnFilterPanelOptions{
  column:FilterableColumn;
  /** 打开面板时的个人视图（用来还原这一列现在的条件）。 */
  view:PersonalView;
  /** 这一列现在的排序方向（null = 不按这一列排）。 */
  sortDirection:'asc'|'desc'|null;
  /** 取这一列整列的去重值。 */
  loadValues():Promise<ColumnValues>;
  /** 应用这一列的新条件（null = 这一列不过滤）。 */
  applyFilter(filter:PersonalViewFilter|null):Promise<void>;
  /** 排序（null = 取消排序）。 */
  applySort(direction:'asc'|'desc'|null):Promise<void>;
  /** 清除这一列的筛选条件。 */
  clearFilter():Promise<void>;
  /** 挂在哪儿（那一列漏斗按钮的**视口**矩形）。不给就贴在视口左上角。 */
  anchor?:ColumnFilterAnchor|null;
  /** 触发它的那颗漏斗按钮（点它不算「点外面」）。 */
  trigger?:HTMLElement|null;
}

const OPERATORS:Array<{value:FilterOperator;label:string}>=[
  {value:'contains',label:'包含'},{value:'equals',label:'等于'},{value:'empty',label:'为空'},{value:'not_empty',label:'不为空'},
];

/**
 * 打开某一列的筛选面板 —— **贴在那一列漏斗按钮下面的小浮层**。
 *
 * 不是公共弹窗：点**外面**就关，**Esc** 只关面板（不动表格），页面**不被锁住**。
 * 内容（排序/筛选器/值清单/应用/清除）与原来**一模一样**。
 *
 * 返回值：面板**开了没有**（null = 没开）。
 * 不可读的列（FIX-47 同一条闸）**直接不开**：后端会拒「无权使用该列配置个人视图」，
 * 让用户点完才知道自己看不了这一列，是白让人添堵。
 */
export function openColumnFilterPanel(options:ColumnFilterPanelOptions):ColumnFilterPanelHandle|null{
  if(options.column.readable===false)return null;
  const doc=document,win=doc.defaultView??window;
  const current=options.view.filters.find(item=>item.column===options.column.id)??null;
  let operator:FilterOperator=current&&current.operator!=='in'?current.operator:'contains';
  let criteriaValue=current&&current.operator!=='in'&&typeof current.value==='string'?current.value:'';
  /** 勾中的值（存的是**真实值**，空值是空字符串）。 */
  const checked=new Set<string>();
  if(current&&current.operator==='in'&&Array.isArray(current.value))for(const value of current.value)checked.add(value);
  let values:string[]=[];let loaded=false;let loadError='';let saving=false;let closed=false;
  let sortDirection=options.sortDirection;
  let anchor:ColumnFilterAnchor=options.anchor??{left:8,top:8,right:26,bottom:26,width:18,height:18};
  /** 清单里每个值对应的勾选框（不重建清单 ⇒ 勾选框不会在用户手底下被换掉）。 */
  const boxes=new Map<string,HTMLInputElement>();
  const closeHooks:Array<()=>void>=[];

  /* —— 骨架（静态部分，动态部分下面填） —— */
  const panel=doc.createElement('div');
  panel.className='excel-column-filter-pop';
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-modal','false');
  panel.setAttribute('aria-label',`筛选「${options.column.label||options.column.id}」`);
  panel.tabIndex=-1;
  const head=doc.createElement('header');head.className='excel-column-filter-head';
  const title=doc.createElement('h3');title.className='excel-column-filter-title';title.textContent=`筛选「${options.column.label||options.column.id}」`;
  const closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='excel-column-filter-close';
  closeButton.setAttribute('aria-label','关闭筛选面板');closeButton.title='关闭';closeButton.textContent='×';
  head.append(title,closeButton);
  const body=doc.createElement('div');body.className='excel-column-filter-body';
  /* 提示可省 —— 用户 2026-10-20 21:2x：「勾中的值就是要留下的行。全选＝这一列不按值筛 把这个删除」
     ⇒ 「值」那一段**不给提示**（不给就不生成那个 <p>，不留空行）。
     排序／筛选器两段的提示**照旧**（用户只让删「值」这一句）。 */
  const section=(titleText:string,hint?:string)=>{
    const box=doc.createElement('section');box.className='excel-column-filter-block';
    const heading=doc.createElement('h4');heading.textContent=titleText;
    box.append(heading);
    if(hint){
      const note=doc.createElement('p');note.className='excel-column-filter-hint';note.textContent=hint;
      box.append(note);
    }
    body.append(box);return box;
  };
  const sortBlock=section('排序','按这一列排。再点同一个按钮就取消排序。');
  const sortRow=doc.createElement('div');sortRow.className='excel-column-filter-actions';
  const asc=doc.createElement('button');asc.type='button';asc.className='btn';asc.textContent='升序';
  const desc=doc.createElement('button');desc.type='button';desc.className='btn';desc.textContent='降序';
  sortRow.append(asc,desc);sortBlock.append(sortRow);

  const criteriaBlock=section('筛选器','一行就是「这一列 满足某个条件」。不填就是这一列不用条件。');
  const criteriaRow=doc.createElement('div');criteriaRow.className='excel-column-filter-criteria';
  const operatorHost=doc.createElement('span');operatorHost.className='excel-column-filter-operator';
  const criteria=doc.createElement('input');
  criteria.type='text';criteria.maxLength=1000;criteria.placeholder='筛选值';
  criteria.setAttribute('aria-label','筛选值');
  criteriaRow.append(operatorHost,criteria);criteriaBlock.append(criteriaRow);

  const valuesBlock=section('值');
  const search=doc.createElement('input');
  search.type='search';search.placeholder='搜索值';search.setAttribute('aria-label','搜索值');
  const allLabel=doc.createElement('label');allLabel.className='excel-column-filter-all';
  const all=doc.createElement('input');all.type='checkbox';all.setAttribute('aria-label','全选');
  const allText=doc.createElement('span');allText.textContent='全选';
  allLabel.append(all,allText);
  const list=doc.createElement('div');list.className='excel-column-filter-values';list.setAttribute('role','group');list.setAttribute('aria-label','值清单');
  const valuesHint=doc.createElement('p');valuesHint.className='excel-column-filter-hint';
  valuesBlock.append(search,allLabel,list,valuesHint);

  const status=doc.createElement('div');status.className='excel-column-filter-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  body.append(status);

  const foot=doc.createElement('footer');foot.className='excel-column-filter-foot';
  const clearButton=doc.createElement('button');clearButton.type='button';clearButton.className='btn';clearButton.textContent='清除筛选器';
  const applyButton=doc.createElement('button');applyButton.type='button';applyButton.className='btn btn-pri';applyButton.textContent='应用筛选器';
  foot.append(clearButton,applyButton);

  panel.append(head,body,foot);

  const dropdown:DropdownHandle=createDropdown(OPERATORS.map(item=>({value:item.value,label:item.label})),operator,value=>{
    operator=value as FilterOperator;syncCriteria();
  });
  operatorHost.append(dropdown.root);
  criteria.value=criteriaValue;

  function syncCriteria(){
    criteria.disabled=operator==='empty'||operator==='not_empty';
    if(criteria.disabled)criteria.value='';
  }
  function syncSort(){
    asc.setAttribute('aria-pressed',String(sortDirection==='asc'));
    desc.setAttribute('aria-pressed',String(sortDirection==='desc'));
    asc.classList.toggle('is-on',sortDirection==='asc');
    desc.classList.toggle('is-on',sortDirection==='desc');
  }
  /** 清单里要显示的值：服务端给的 ＋ 勾着但已经不在这一列里的（数据变了也不悄悄改掉筛选）。 */
  function displayed():string[]{
    const list=values.slice();
    for(const value of checked)if(!list.includes(value))list.push(value);
    return list;
  }
  function renderValues(){
    list.replaceChildren();
    boxes.clear();
    if(loadError){valuesHint.textContent='取不到这一列的值：'+loadError;return;}
    if(!loaded){valuesHint.textContent='正在取这一列的值…';return;}
    const all_=displayed();
    const term=search.value.trim().toLowerCase();
    const shown=all_.filter(value=>!term||valueLabel(value).toLowerCase().includes(term));
    for(const value of shown){
      const label=doc.createElement('label');label.className='excel-column-filter-value';
      const box=doc.createElement('input');box.type='checkbox';box.checked=checked.has(value);
      box.dataset.value=value;box.setAttribute('aria-label',valueLabel(value));
      const text=doc.createElement('span');text.textContent=valueLabel(value);
      label.append(box,text);list.append(label);boxes.set(value,box);
    }
    syncChecks();
  }
  /** 只更新「全选」和提示 —— **不重建清单**。
   * 重建会把用户刚点的那个勾选框换掉（点第二个时第一个已经不在文档里了）。 */
  function syncChecks(){
    if(loadError||!loaded)return;
    const all_=displayed();
    const selected=all_.filter(value=>checked.has(value)).length;
    all.checked=all_.length>0&&selected===all_.length;
    all.indeterminate=selected>0&&selected<all_.length;
    valuesHint.textContent=all_.length?`共 ${all_.length} 个值，已勾 ${selected} 个${all_.length>values.length?'（有些是已不在这一列里的旧值）':''}`:'这一列没有可勾的值';
  }
  list.addEventListener('change',event=>{
    const box=event.target as HTMLInputElement;
    if(box.type!=='checkbox')return;
    if(box.checked)checked.add(box.dataset.value??'');else checked.delete(box.dataset.value??'');
    syncChecks();
  });
  all.addEventListener('change',()=>{
    const all_=displayed();
    for(const value of all_){if(all.checked)checked.add(value);else checked.delete(value);const box=boxes.get(value);if(box)box.checked=all.checked;}
    syncChecks();
  });
  search.addEventListener('input',()=>renderValues());
  criteria.addEventListener('input',()=>{criteriaValue=criteria.value;});

  /** 这一列最后到底是哪个条件（值清单优先 —— 与 Excel 一致：勾了清单就按清单走）。 */
  function effectiveFilter():PersonalViewFilter|null{
    const all_=displayed();
    if(checked.size>0&&checked.size<all_.length){
      const ordered=all_.filter(value=>checked.has(value));
      return {column:options.column.id,operator:'in',value:ordered};
    }
    if(operator==='empty'||operator==='not_empty')return {column:options.column.id,operator,value:''};
    if(criteriaValue!=='')return {column:options.column.id,operator,value:criteriaValue};
    return null;
  }

  /** 摆位置：贴在漏斗按钮下方；下方放不下就往上翻。 */
  function place(){
    const viewport={width:win.innerWidth||1024,height:win.innerHeight||768};
    const width=panel.offsetWidth||COLUMN_FILTER_PANEL_WIDTH;
    const height=panel.offsetHeight||0;
    let spot=placeColumnFilterPanel(anchor,{width,height},viewport);
    panel.style.maxHeight=spot.maxHeight+'px';
    /* 限高后面板可能变矮 ⇒ 再量一次，按真实高度贴上去。 */
    const actual=panel.offsetHeight||height;
    if(actual!==height)spot=placeColumnFilterPanel(anchor,{width,height:actual},viewport);
    panel.style.left=spot.left+'px';
    panel.style.top=spot.top+'px';
    panel.classList.toggle('is-up',spot.up);
  }

  /* —— 关面板 —— */
  function close():boolean{
    if(closed)return false;
    if(saving)return false;   // 正在存 ⇒ 不许关（跟原来的 guardModal 一个意思）
    closed=true;
    closeDropdowns();
    doc.removeEventListener('pointerdown',onPointerDown,true);
    doc.removeEventListener('keydown',onKeyDown,true);
    panel.remove();
    const trigger=options.trigger;
    if(trigger&&trigger.isConnected)trigger.focus();
    for(const hook of closeHooks)hook();
    return true;
  }
  /** 点浮层**外面** ⇒ 关。点那颗漏斗不算（漏斗自己管开关）。 */
  function onPointerDown(event:Event){
    const target=event.target as Node|null;
    if(!target)return;
    if(panel.contains(target))return;
    const el=target as Element;
    if(typeof el.closest==='function'&&el.closest('.excel-column-filter-button'))return;
    const trigger=options.trigger;
    if(trigger&&trigger.contains(target))return;
    close();
  }
  /** Esc ⇒ **只关面板**（底下的下拉自己先收；表格不动）。 */
  function onKeyDown(event:KeyboardEvent){
    if(event.key!=='Escape')return;
    if(hasOpenDropdown())return;   // 筛选器下拉开着 ⇒ 让它自己先收
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  doc.body.appendChild(panel);
  doc.addEventListener('pointerdown',onPointerDown,true);
  doc.addEventListener('keydown',onKeyDown,true);
  closeButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();close();});
  /* 点面板内部不算「点外面」。 */
  panel.addEventListener('pointerdown',event=>event.stopPropagation());
  syncCriteria();syncSort();renderValues();
  place();
  /* 键盘：焦点进面板（Tab 就能走到里面的控件）。 */
  panel.focus({preventScroll:true});

  async function setSort(direction:'asc'|'desc'){
    if(saving)return;
    const next=sortDirection===direction?null:direction;
    saving=true;setBusy(true);
    try{await options.applySort(next);sortDirection=next;syncSort();}
    catch(error){status.textContent='排序没成功：'+(error as Error).message;}
    finally{saving=false;setBusy(false);}
  }
  asc.addEventListener('click',()=>{void setSort('asc');});
  desc.addEventListener('click',()=>{void setSort('desc');});

  async function applyFilter(){
    if(saving)return;
    const filter=effectiveFilter();
    if(filter&&filter.operator==='in'){
      const list_=filter.value as string[];
      if(list_.length>MAX_IN_VALUES){status.textContent=`最多只能选 ${MAX_IN_VALUES} 个值，请少选几个`;return;}
      if(list_.some(value=>value.length>MAX_IN_VALUE_LENGTH)){status.textContent='有值太长，选不了（单条上限 '+MAX_IN_VALUE_LENGTH+' 字）';return;}
      if(list_.reduce((sum,value)=>sum+value.length,0)>MAX_IN_TOTAL_LENGTH){status.textContent='选中的值太长了，请少选几个';return;}
    }
    saving=true;setBusy(true);status.textContent='正在应用…';
    try{await options.applyFilter(filter);saving=false;close();}
    catch(error){status.textContent=(error as Error).message;}
    finally{saving=false;setBusy(false);}
  }
  async function clearFilter(){
    if(saving)return;
    saving=true;setBusy(true);status.textContent='正在清除…';
    try{await options.clearFilter();saving=false;close();}
    catch(error){status.textContent=(error as Error).message;}
    finally{saving=false;setBusy(false);}
  }
  function setBusy(busy:boolean){
    for(const control of panel.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input'))control.disabled=busy;
    criteria.disabled=busy||operator==='empty'||operator==='not_empty';
  }
  applyButton.addEventListener('click',()=>{void applyFilter();});
  clearButton.addEventListener('click',()=>{void clearFilter();});

  void (async()=>{
    try{const result=await options.loadValues();values=result.values??[];loaded=true;renderValues();}
    catch(error){loadError=(error as Error).message;loaded=true;renderValues();}
  })();

  return {
    element:panel,
    isOpen:()=>!closed,
    close:()=>{close();},
    onClose:(handler:()=>void)=>{if(closed)handler();else closeHooks.push(handler);},
    reposition:(next:ColumnFilterAnchor)=>{anchor=next;if(!closed)place();},
  };
}
