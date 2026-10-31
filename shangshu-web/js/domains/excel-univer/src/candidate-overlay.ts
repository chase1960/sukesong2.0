/** 只覆盖可视格的候选文字；不向Univer的v/s写候选，也不逐帧发送格式命令。 */
import type {ReviewDescriptor} from './inline-review';
export interface CandidateOverlayItem {key:string;proposalId:string;unitId:string;row:number;col:number;text:string;source:string;busy:boolean;disabled?:boolean;blockedReason?:string;error?:string;fontSize?:number;bold?:boolean;staged?:boolean;accept():Promise<unknown>;stage():Promise<unknown>;edit(value:string):void;reject?():Promise<unknown>;unstage?():Promise<unknown>}
export interface CandidateOverlayFrame {clip:{left:number;top:number;width:number;height:number};visible:{startRow:number;endRow:number;startCol:number;endCol:number};rect(row:number,col:number):{left:number;top:number;width:number;height:number}|null}
export function mountCandidateOverlay(host:HTMLElement,options:{frame():CandidateOverlayFrame|null;select(row:number,col:number):void;setTimer?:(callback:()=>void,ms:number)=>any;clearTimer?:(id:any)=>void}){
  const doc=host.ownerDocument,win=doc.defaultView!;
  const layer=doc.createElement('div');layer.className='excel-candidate-layer';layer.setAttribute('aria-label','单元格待审核建议');host.appendChild(layer);
  const records=new Map<string,{el:HTMLDivElement;item:CandidateOverlayItem;text:HTMLSpanElement;badge:HTMLButtonElement;status:HTMLSpanElement;drop:HTMLButtonElement;undo:HTMLButtonElement;editor?:HTMLTextAreaElement;editorBox?:HTMLDivElement}>();
  const timers=new Map<string,any>(),choices=new Map<string,number>();let index=new Map<number,Map<number,CandidateOverlayItem[]>>(),editing='',initial='',dead=false,frameId:number|null=null;
  const later=options.setTimer??((callback:()=>void,ms:number)=>win.setTimeout(callback,ms)),cancel=options.clearTimer??((id:any)=>win.clearTimeout(id));
  const clearClick=(key:string)=>{const id=timers.get(key);if(id!==undefined)cancel(id);timers.delete(key);};
  const raf=(callback:()=>void)=>win.requestAnimationFrame?win.requestAnimationFrame(callback):win.setTimeout(callback,0);
  function queue(){if(!dead&&frameId===null)frameId=raf(()=>{frameId=null;paint();});}
  function stopEditing(){editing='';for(const record of records.values())if(record.editor){record.editorBox?.remove();record.editor=undefined;record.editorBox=undefined;record.el.classList.remove('is-editing');}queue();}
  function edit(key:string){
    const record=records.get(key);if(!record||record.item.busy||record.item.disabled)return false;clearClick(key);stopEditing();editing=key;initial=record.item.text;
    const box=doc.createElement('div');box.className='excel-candidate-editor';
    const input=doc.createElement('textarea');input.value=record.item.text;input.setAttribute('aria-label','编辑候选值，尚未保存');input.addEventListener('input',()=>record.item.edit(input.value));
    /* —— 两个明确的动作，不许含糊（用户 2026-10-25：「单击等同于在审核中心暂存」）：
       · 「暂存」＝只存着（**不写正式值**）；改过的字一并存进去。
       · 「采用」＝这就去写正式值。 */
    const stageBtn=doc.createElement('button');stageBtn.type='button';stageBtn.textContent='暂存';stageBtn.title='暂存这一格（只存着，不写正式值）';stageBtn.addEventListener('click',event=>{event.stopPropagation();void record.item.stage();});
    const confirm=doc.createElement('button');confirm.type='button';confirm.textContent='采用';confirm.title='采用这一格（写正式值）';confirm.addEventListener('click',event=>{event.stopPropagation();void record.item.accept();});
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();record.item.edit(initial);box.remove();stopEditing();}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void record.item.accept();}});
    box.addEventListener('pointerdown',event=>event.stopPropagation());box.addEventListener('click',event=>event.stopPropagation());box.addEventListener('dblclick',event=>event.stopPropagation());
    box.append(input,stageBtn,confirm);record.el.append(box);record.editor=input;record.editorBox=box;record.el.classList.add('is-editing');input.focus();input.select();return true;
  }
  function create(item:CandidateOverlayItem){
    const el=doc.createElement('div');el.className='excel-candidate-cell';el.tabIndex=0;el.setAttribute('role','button');
    const text=doc.createElement('span');text.className='excel-candidate-text';const badge=doc.createElement('button');badge.type='button';badge.className='excel-candidate-count';
    const status=doc.createElement('span');status.className='excel-candidate-status';status.setAttribute('role','status');
    // 放弃这一项：只把这格从待采用里拿掉，**不写入正式值**（A17「部分采用、部分拒绝」）。
    const drop=doc.createElement('button');drop.type='button';drop.className='excel-candidate-drop';drop.textContent='×';
    drop.title='放弃这一项（不写入正式值）';drop.setAttribute('aria-label','放弃这一项建议，不写入正式值');
    // 取消暂存：**回到待确认**，正式值一个字都不动（与「放弃」是两件事）。
    const undo=doc.createElement('button');undo.type='button';undo.className='excel-candidate-undo';undo.textContent='↺';
    undo.title='取消暂存（回到待确认，不写入正式值）';undo.setAttribute('aria-label','取消这一项的暂存，回到待确认');
    el.append(text,badge,status,drop,undo);
    const record={el,item,text,badge,status,drop,undo,editor:undefined as HTMLTextAreaElement|undefined,editorBox:undefined as HTMLDivElement|undefined};
    el.addEventListener('pointerdown',event=>{if(!record.editor){event.preventDefault();options.select(record.item.row,record.item.col);}event.stopPropagation();});
    /* —— **单击＝暂存**（不是采用）：
       用户 2026-10-25 原话「在单元格里单击等同于在审核中心暂存」——
       暂存**只标记**，正式值一个字都不改；真要写走「采用」（Enter 或格内「采用」钮）。 */
    el.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(record.editor||record.item.busy||record.item.disabled)return;clearClick(record.item.key);if(event.detail>1)return;
      const key=record.item.key;timers.set(key,later(()=>{timers.delete(key);const current=records.get(key);if(current&&!current.editor&&!current.item.busy&&!current.item.disabled)void current.item.stage();},550));});
    el.addEventListener('dblclick',event=>{event.preventDefault();event.stopPropagation();clearClick(record.item.key);edit(record.item.key);});
    el.addEventListener('keydown',event=>{if(record.editor||record.item.disabled)return;if(event.key==='Enter'){event.preventDefault();clearClick(record.item.key);void record.item.accept();}else if(event.key==='F2'){event.preventDefault();edit(record.item.key);}});
    badge.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();clearClick(record.item.key);const location=record.item.row+':'+record.item.col;choices.set(location,(choices.get(location)??0)+1);stopEditing();queue();});
    drop.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();clearClick(record.item.key);if(record.item.busy||record.item.disabled||typeof record.item.reject!=='function')return;void record.item.reject();});
    undo.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();clearClick(record.item.key);if(record.item.busy||record.item.disabled||typeof record.item.unstage!=='function')return;void record.item.unstage();});
    layer.appendChild(el);return record;
  }
  function paint(){
    if(dead)return;const frame=options.frame();layer.hidden=!frame;if(!frame)return;
    const {clip,visible}=frame;Object.assign(layer.style,{left:clip.left+'px',top:clip.top+'px',width:clip.width+'px',height:clip.height+'px'});
    const wanted=new Set<string>();
    for(let row=visible.startRow;row<=visible.endRow;row++){
      const columns=index.get(row);if(!columns)continue;
      for(const [col,candidates] of columns){if(col<visible.startCol||col>visible.endCol)continue;
        const rectangle=frame.rect(row,col);if(!rectangle)continue;
        const item=candidates[(choices.get(row+':'+col)??0)%candidates.length];wanted.add(item.key);
        const record=records.get(item.key)??create(item);records.set(item.key,record);record.item=item;
        record.el.dataset.proposalId=item.proposalId;record.el.dataset.unitId=item.unitId;record.el.dataset.reviewSource=item.source;
        record.el.setAttribute('aria-disabled',String(!!item.disabled));
        record.el.setAttribute('aria-label',item.disabled?(item.blockedReason||'当前建议不可确认'):item.staged?`已暂存的候选 ${item.text||'清空'}；点右下角取消暂存，双击编辑`:`待审候选 ${item.text||'清空'}；单击暂存，双击编辑`);
        record.el.title=(item.source==='assistant'?'Assistant':item.source==='automation'?'代码/自动化':'来源未确认')+' · 候选 '+item.proposalId+' · '+(item.staged?'已暂存（点右下角 ↺ 取消暂存）':'单击暂存，双击编辑');
        if(item.disabled)record.el.title=item.blockedReason||'当前建议不可确认';
        record.text.textContent=item.text||'（清空）';record.badge.hidden=candidates.length<2;record.badge.textContent=candidates.length+'项';record.badge.title='切换此格其他候选，不会确认';
        record.drop.hidden=typeof item.reject!=='function';
        record.undo.hidden=!item.staged||typeof item.unstage!=='function';
        /* 暂存过的项：**写清「已暂存」**（一眼看得出这一项已经存着了，但还没写正式值）。
           ⚠️ **暂存 ≠ 已核对** —— 状态字样必须让人看见「正式值还没改」
           （用户 2026-10-26 决议①：暂存只是暂时存，要写进正式表得点「全部确认」）。 */
        record.status.textContent=item.disabled?(item.blockedReason||'不可确认'):item.busy?'核实中…':item.staged?'已暂存（还没写进正式表）':item.error?'未保存，请核对候选列表':'';
        record.el.classList.toggle('is-busy',item.busy);record.el.classList.toggle('has-error',!!item.error);record.el.classList.toggle('is-staged',!!item.staged);
        if(record.editor)record.editor.disabled=item.busy||!!item.disabled;record.el.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=item.busy||!!item.disabled);
        Object.assign(record.el.style,{left:rectangle.left-clip.left+1+'px',top:rectangle.top-clip.top+1+'px',width:Math.max(0,rectangle.width-2)+'px',height:Math.max(0,rectangle.height-2)+'px',fontSize:(item.fontSize??9.75)/0.75+'px',fontWeight:item.bold?'700':'400'});
      }
    }
    for(const [key,record] of records)if(!wanted.has(key)){clearClick(key);record.el.remove();records.delete(key);if(editing===key)editing='';}
  }
  const outside=(event:Event)=>{if(editing&&!layer.contains(event.target as Node))stopEditing();};doc.addEventListener('pointerdown',outside,true);
  const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(queue):null;observer?.observe(host);
  return {refresh:queue,edit,setItems(items:CandidateOverlayItem[]){index=new Map();for(const item of items){const row=index.get(item.row)??new Map<number,CandidateOverlayItem[]>();const values=row.get(item.col)??[];values.push(item);row.set(item.col,values);index.set(item.row,row);}queue();},dispose(){dead=true;timers.forEach(id=>cancel(id));timers.clear();if(frameId!==null){if(win.cancelAnimationFrame)win.cancelAnimationFrame(frameId);else win.clearTimeout(frameId);}observer?.disconnect();doc.removeEventListener('pointerdown',outside,true);layer.remove();records.clear();}};
}

/**
 * 「全部确认」审核条（用户 2026-10-26 决议①：暂存只是暂时存，正式值还没改）。
 *
 * **为什么要有这个**：Excel 逐格审核里，**暂存**只标记「我看过、先存着」，
 * **正式值一个字都没改**；「采用」才写正式值。用户要求「不允许部分确认时，
 * 暂存只能作为暂时存，要点击**全部确认**才行」⇒ 页面上必须有一个**一眼看得见**的
 * 「全部确认」入口（不许藏在右键里）。
 *
 * **它做什么**：点一次 ⇒ 把这条提案里**待审 ＋ 暂存过**的项**一次全采用**
 * （走控制器的 `acceptRemaining()`；**暂存时改过的值**由后端连同 `staged_value`
 * 一起写进正式表）。
 *
 * **计数口径**（⚠️ 暂存**不算**「已核对」）：
 * · 待审 ＝ `status==='pending'`；
 * · 暂存 ＝ `status==='staged'`（**正式值还没改**）；
 * · 已核对 ＝ `status==='accepted'||status==='rejected'`（**暂存项不进这一栏**）。
 */
export type ReviewBarEntry={
  /** 这条提案的描述符（三个计数都从这儿数）。 */
  descriptor:ReviewDescriptor;
  /** 控制器在忙（正在核实／保存）⇒ 入口点不动。 */
  busy?:boolean;
  /** 点「全部确认」：把这条提案里**待审 ＋ 暂存过**的一次全采用。 */
  acceptAll():Promise<unknown>|unknown;
};

export type ReviewBar={
  /** 条本身（挂进页面的那个元素）。 */
  element:HTMLElement;
  /** 刷成最新的提案清单（一条提案一组）。 */
  update(entries:ReviewBarEntry[]):void;
  /** 清空（换表／关表时）：连回执一起清掉。 */
  clear():void;
  dispose():void;
};

/** 一条提案的三个计数（⚠️ 暂存**不进**「已核对」）。 */
export function reviewBarCounts(descriptor:ReviewDescriptor):{pending:number;staged:number;closed:number}{
  const units=Array.isArray(descriptor?.units)?descriptor.units:[];
  return {
    pending:units.filter(unit=>unit.status==='pending').length,
    staged:units.filter(unit=>unit.status==='staged').length,
    closed:units.filter(unit=>unit.status==='accepted'||unit.status==='rejected').length,
  };
}

/**
 * 建「全部确认」审核条。
 *
 * 做法沿用候选浮层那一套（`disabled` ＋ `blockedReason`）：**点不动的时候要说清为什么**。
 * 样式用**内联 style**（跟公共壳 `review-batch.js` 的条一个做法）⇒ 不必改公共 CSS。
 */
export function mountReviewBar(host:HTMLElement):ReviewBar{
  const doc=host.ownerDocument;
  const element=doc.createElement('div');
  element.className='excel-review-bar';
  element.setAttribute('data-review-bar','1');
  element.setAttribute('style','display:flex;align-items:center;gap:12px;flex-wrap:wrap');
  host.append(element);
  type Row={root:HTMLElement;count:HTMLElement;hint:HTMLElement;button:HTMLButtonElement;status:HTMLElement;entry:ReviewBarEntry};
  const rows=new Map<string,Row>();
  /** 刚确认完的回执（留着，别被下一次刷新刷掉）。 */
  const receipts=new Map<string,string>();
  let dead=false;
  function build(entry:ReviewBarEntry):Row{
    const root=doc.createElement('div');
    root.className='excel-review-item';
    root.dataset.proposalId=entry.descriptor.id;
    root.setAttribute('style','display:flex;align-items:center;gap:6px');
    const count=doc.createElement('span');
    count.className='excel-review-count';
    count.setAttribute('style','font-size:12px');
    const hint=doc.createElement('span');
    hint.className='excel-review-hint';
    hint.setAttribute('style','font-size:12px;opacity:.75');
    const button=doc.createElement('button');
    button.type='button';
    button.className='btn btn-ghost';
    button.textContent='全部确认';
    button.title='把待审和暂存过的一起写进正式表';
    button.setAttribute('aria-label','全部确认：把待审和暂存过的一起写进正式表');
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void run(entry.descriptor.id);});
    const status=doc.createElement('span');
    status.className='excel-review-status';
    status.setAttribute('role','status');
    status.setAttribute('style','font-size:12px');
    root.append(count,hint,button,status);
    element.append(root);
    const row:Row={root,count,hint,button,status,entry};
    rows.set(entry.descriptor.id,row);
    return row;
  }
  async function run(id:string){
    const row=rows.get(id);if(!row||dead)return;
    const entry=row.entry;
    receipts.delete(id);
    row.button.disabled=true;
    row.status.textContent='正在确认…';
    try{
      await entry.acceptAll();
      if(dead)return;
      const text='已全部确认：待审和暂存过的一起写进正式表了。';
      receipts.set(id,text);
      row.button.textContent='已确认';
      row.button.disabled=true;
      row.status.textContent=text;
    }catch(cause){
      if(dead)return;
      const text=(cause as Error)?.message||'确认没成功，请核对候选列表。';
      receipts.set(id,text);
      row.status.textContent=text;
    }
  }
  return {
    element,
    update(entries:ReviewBarEntry[]){
      if(dead)return;
      const seen=new Set<string>();
      for(const entry of entries){
        const id=entry.descriptor.id;seen.add(id);
        const row=rows.get(id)??build(entry);
        row.entry=entry;
        const counts=reviewBarCounts(entry.descriptor);
        /* ⚠️ **暂存项不进「已核对」那一栏** —— 暂存只是暂时存，正式值还没改。 */
        row.count.textContent=`待审 ${counts.pending} 项 · 暂存 ${counts.staged} 项 · 已核对 ${counts.closed} 项`;
        row.hint.textContent=counts.staged
          ?'暂存只是暂时存，正式值还没改；要把这些值写进正式表，请点「全部确认」'
          :'把待审的项一次写进正式表';
        const receipt=receipts.get(id);
        const blocked=entry.descriptor.can_accept===false;
        const reason=entry.descriptor.accept_unavailable_reason||'当前建议不可确认';
        const nothingLeft=counts.pending+counts.staged===0;
        row.button.textContent=receipt?'已确认':'全部确认';
        row.button.disabled=!!receipt||blocked||!!entry.busy||nothingLeft;
        row.button.title=blocked?reason:'把待审和暂存过的一起写进正式表';
        row.status.textContent=receipt!==undefined?receipt:(blocked?reason:(entry.busy?'正在核实…':''));
      }
      for(const [id,row] of rows)if(!seen.has(id)&&!receipts.has(id)){row.root.remove();rows.delete(id);}
    },
    clear(){if(dead)return;receipts.clear();for(const row of rows.values())row.root.remove();rows.clear();},
    dispose(){dead=true;rows.clear();receipts.clear();element.remove();},
  };
}
