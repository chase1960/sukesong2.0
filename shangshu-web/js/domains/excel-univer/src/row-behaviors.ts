/** Table lifecycle supplied to optional domain contributions. Business conditions stay in their domain. */
export interface ExcelCellCandidateAction {
  actionId: string;
  payload: Record<string, unknown>;
}

export interface ExcelRowBehaviorContext {
  frame(): {
    clip: {left:number;top:number;width:number;height:number};
    visible: {startRow:number;endRow:number;startCol:number;endCol:number};
    rect(row:number,col:number): {left:number;top:number;width:number;height:number}|null;
    fontSize?(row:number,col:number):number;
  }|null;
  /**
   * **现在开着的是哪张表**（域用它判断「这张表是不是我的表」）。
   *
   * ⚠️ **为什么给这个**：域的登记（哪张表归 example 管）**是域的事**，
   *   通用表格层不该替它猜 ⇒ 这里只把「当前表身份」如实给出去，
   *   域自己拿它去比自己的登记。
   */
  table(): {key:string;kind:'db'|'xlsx';resourceId?:string}|null;
  columns(): Array<{fieldId:string;label:string}>;
  cellText(row:number,col:number):string;
  isRowLoaded(row:number):boolean;
  rowIdentity(row:number):{table:string;row_id:string}|null;
  accept(row:number,col:number,text:string,action?:ExcelCellCandidateAction):Promise<boolean>;
  /**
   * **格上的装饰**（2026-10-30 用户口径：「这个自动化能不能也走渲染层的样式呢？」）——
   * 域把它要装饰的格交给宿主 ⇒ 宿主用 Univer 原生的**渲染层形状**画
   * ⇒ **被网格裁剪**（DOM 浮层会盖住格线、也会溢出格子）。
   * ⚠️ **同一组名 ⇒ 同一份形状** ⇒ 域每轮把**全部**要装饰的格交上来即可
   *   （宿主内部按「变没变」判断 ⇒ 没变就不重画）。
   */
  decorate?(group:string, cells:Array<{row:number;col:number}>, style:{fill:string;stroke?:string;strokeWidth?:number}):void;
  notify(message:string,kind?:'info'|'success'|'error'):void;
}

export interface ExcelRowBehaviorHandle {
  refresh():void|Promise<void>;
  cellsChanged(changes:Array<{rowIndex:number;fieldId:string}>,options:{saved:boolean}):void|Promise<void>;
  dispose():void;
}

export interface ExcelRowBehaviorProvider {
  id:string;
  mount(host:HTMLElement,context:ExcelRowBehaviorContext):ExcelRowBehaviorHandle|null;
}

const REGISTRY_KEY='shangshuExcelRowBehaviors';
const REGISTRY_EVENT='shangshu-excel-row-behaviors-changed';

/** Same early-registration model as the table's domain toolbar actions. */
export function mountExcelRowBehaviors(host:HTMLElement,context:ExcelRowBehaviorContext):ExcelRowBehaviorHandle {
  const scope=globalThis as unknown as Record<string,unknown>;
  const active=new Map<string,{provider:ExcelRowBehaviorProvider;handle:ExcelRowBehaviorHandle}>();
  let dead=false;
  function report(error:unknown){if(!dead)context.notify(`业务候选暂时不可用：${error instanceof Error?error.message:String(error)}`,'info');}
  function invoke(run:()=>void|Promise<void>){try{void Promise.resolve(run()).catch(report);}catch(error){report(error);}}
  function sync(){
    if(dead)return;
    const registry=scope[REGISTRY_KEY];
    const providers=registry instanceof Map?[...registry.values()] as ExcelRowBehaviorProvider[]:[];
    for(const [id,entry] of active){if(!providers.includes(entry.provider)){entry.handle.dispose();active.delete(id);}}
    for(const provider of providers){
      if(!provider?.id||typeof provider.mount!=='function'||active.has(provider.id))continue;
      try{const handle=provider.mount(host,context);if(handle){active.set(provider.id,{provider,handle});invoke(()=>handle.refresh());}}
      catch(error){report(error);}
    }
  }
  const win=host.ownerDocument.defaultView;
  win?.addEventListener(REGISTRY_EVENT,sync);
  sync();
  return {
    refresh(){sync();for(const {handle} of active.values())invoke(()=>handle.refresh());},
    cellsChanged(changes,options){for(const {handle} of active.values())invoke(()=>handle.cellsChanged(changes,options));},
    dispose(){dead=true;win?.removeEventListener(REGISTRY_EVENT,sync);for(const {handle} of active.values())handle.dispose();active.clear();},
  };
}
