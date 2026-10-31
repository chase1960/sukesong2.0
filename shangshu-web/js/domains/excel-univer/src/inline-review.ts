/** 同一原提案的逐项审核；候选只存在展示状态，正式值由服务端动作维护。 */
export interface ReviewValue {type:string;value:unknown}
export interface ReviewUnit {unit_id:string;label:string;kind:string;target:{row_id:string;header:string};value:ReviewValue;current_value:ReviewValue;status:string;staged_value?:ReviewValue}
export interface ReviewDescriptor {can_accept?:boolean;accept_unavailable_reason?:string;id:string;capability:string;status:string;created_via:string;review_revision:string;target:{module:string;table:string;sheet?:string};units:ReviewUnit[];remaining:number;accepted_count:number;accepted_units?:string[];rejected_units?:string[];rejected_count?:number;staged_count?:number;staged_units?:string[];unstaged_units?:string[];idempotent?:boolean;result?:unknown;audit?:string}
/** Comparison only; display normalization must never rewrite the actual proposed value. */
export function reviewValuesEqual(actual:ReviewValue,expected:ReviewValue):boolean{
  if(actual.type!==expected.type)return false;
  const normalize=(value:unknown)=>actual.type==='date'&&typeof value==='string'?value.replace(/[T ]00:00:00(?:\.0+)?$/,''):value??null;
  return JSON.stringify(normalize(actual.value))===JSON.stringify(normalize(expected.value));
}
/**
 * 审核项的状态取值集合（内核 §staged_tier）：
 * **暂存（staged）与「采用／放弃」平级** —— 暂存＝在审核中心存着，
 * 既没采用、也没放弃，**正式值一个字都没改**。
 */
export const REVIEW_UNIT_STATUSES:ReadonlyArray<string>=['pending','staged','accepted','rejected'];
/**
 * 还能再动的状态：**待审**与**暂存过**的都还能采用／放弃／改值。
 * ⚠️ 暂存过的项**不是**「已处理」—— 用户在表里点一下暂存之后，
 * 这一项仍能采用、仍能改值（内核把 staged 算成独立一档，不是终态）。
 */
const SUBMITTABLE=new Set<string>(['pending','staged']);
type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
export function checkReviewDescriptor(data:ReviewDescriptor,id:string,table:string):ReviewDescriptor{
  /* ⚠️ `target.module`：**描述符**里写的是**域名**（example 写 `example`），
     **列表项**里才被内核改写成页面模块（`excel`）；域名另存在 `domain_module`。
     ⇒ 这里只要求「模块名非空 ＋ 这一格属于这张表」，不许写死 `excel`。 */
  if(data?.id!==id||typeof data.target?.module!=='string'||!data.target.module||data.target.table!==table||typeof data.review_revision!=='string'||!data.review_revision||!Array.isArray(data.units)||data.units.length>20000||!Number.isInteger(data.remaining)||data.remaining<0)throw Error('审核目录回执不完整，未执行候选');
  const seen=new Set<string>();
  for(const unit of data.units){
    if(!unit||typeof unit.unit_id!=='string'||!unit.unit_id||seen.has(unit.unit_id)||typeof unit.kind!=='string'||!unit.kind||!unit.value||typeof unit.value.type!=='string'||!REVIEW_UNIT_STATUSES.includes(unit.status))throw Error('审核项身份或目标不完整，未执行候选');
    /* 只有**格**的单元才谈得上落在哪一行哪一列；别的单元（如 example 的「材料审核结论」）
       在表格里**画不出来**（不许瞎猜一列）⇒ 不在这里判死。 */
    if(unit.kind==='cell'&&(typeof unit.target?.row_id!=='string'||typeof unit.target?.header!=='string'))throw Error('审核项身份或目标不完整，未执行候选');
    seen.add(unit.unit_id);
  }
  if(data.remaining!==data.units.filter(unit=>unit.status==='pending').length)throw Error('审核剩余数与候选不一致，请重新核对');
  return data;
}
async function json(url:string,options:{fetcher?:Fetcher;signal?:AbortSignal},payload?:unknown):Promise<any>{
  const response=await (options.fetcher??fetch)(url,{credentials:'include',cache:'no-store',signal:options.signal,...(payload?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}:{})});
  const body=await response.json();if(!response.ok||body?.ok===false)throw Error(body?.error||body?.message||`审核请求失败（HTTP ${response.status}）`);return body;
}
export async function fetchReviewDescriptor(id:string,table:string,options:{fetcher?:Fetcher;signal?:AbortSignal}={}):Promise<ReviewDescriptor>{
  return checkReviewDescriptor(await json('/api/platform/action-proposals/'+encodeURIComponent(id)+'/review',options),id,table);
}
export function createInlineReviewController(options:{descriptor:ReviewDescriptor;signal?:AbortSignal;fetcher?:Fetcher;newKey():string;blocking():boolean;coerce(unit:ReviewUnit,text:string):ReviewValue|undefined;readback(descriptor:ReviewDescriptor,expected:Array<{unit:ReviewUnit;value:ReviewValue}>):Promise<void>;change(reason?:'edit'):void;progress(descriptor:ReviewDescriptor):void}){
  let descriptor=options.descriptor,busy=false,error='',dead=false;
  const edits=new Map<string,string>(),attempts=new Map<string,string>();
  /**
   * 这一项**该给人看的值**：
   * 暂存过的项读 `staged_value`（那是人暂存时改过的那个值）—— 不是 `unit.value`。
   * ⚠️ 没暂存过的项**没有** `staged_value` ⇒ 照旧读 `unit.value`。
   */
  const unitValue=(unit:ReviewUnit):ReviewValue=>(unit.status==='staged'&&unit.staged_value&&typeof unit.staged_value.type==='string')?unit.staged_value:unit.value;
  const text=(unit:ReviewUnit)=>{const value=unitValue(unit);return value.value==null?'':String(value.value);};
  const controller={
    id:descriptor.id,module:'excel' as const,
    get descriptor(){return descriptor;},get busy(){return busy;},get error(){return error;},
    value(id:string){const unit=descriptor.units.find(unit=>unit.unit_id===id);return edits.get(id)??(unit?text(unit):'');},
    setEdit(id:string,value:string){if(descriptor.can_accept===false)return;const unit=descriptor.units.find(unit=>unit.unit_id===id&&SUBMITTABLE.has(unit.status));if(!unit||busy||dead)return;if(value===text(unit))edits.delete(id);else edits.set(id,value);options.change('edit');},
    hasEdits(){return edits.size>0;},
    async acceptUnit(id:string){return accept([id]);},
    async acceptRemaining(){return accept(null);},
    /** 逐项放弃：只把这几项标成「不采用」，**不写任何正式值**（A17 的「部分拒绝」）。 */
    async rejectUnit(id:string){return reject([id]);},
    /**
     * **暂存这一项**：只标记「我看过、先存着」，**正式值一个字都不改**。
     * （用户 2026-10-25 原话：「在单元格里单击等同于在审核中心暂存」。）
     */
    async stageUnit(id:string){return stage([id]);},
    /** 暂存其余**待审**项（已暂存的**不再**重发一遍：重发会把暂存时改过的值抹回原候选）。 */
    async stageRemaining(){const pending=descriptor.units.filter(unit=>unit.status==='pending').map(unit=>unit.unit_id);return stage(pending);},
    /** 取消暂存：这一项回到「待确认」，**正式值一个字都不改**。 */
    async unstageUnit(id:string){return unstage([id]);},
    dispose(){dead=true;},
  };
  async function accept(requested:string[]|null):Promise<ReviewDescriptor|null>{
    if(dead||busy||options.signal?.aborted)return null;
    if(descriptor.can_accept===false){error=descriptor.accept_unavailable_reason||'当前建议不可确认';options.change();return null;}
    if(options.blocking()){error='请先完成当前输入和保存，再确认候选';options.change();return null;}
    /* 「采用其余」＝**待审 ＋ 暂存过**的都算（暂存≠已处理）；点名单项时只认还能动的。 */
    const units=requested===null?descriptor.units.filter(unit=>SUBMITTABLE.has(unit.status)):requested.map(id=>descriptor.units.find(unit=>unit.unit_id===id));
    if(!units.length||units.some(unit=>!unit||!SUBMITTABLE.has(unit.status))){error='候选已处理或不存在，请刷新核对';options.change();return null;}
    const selected=units as ReviewUnit[],edited:Record<string,ReviewValue>={};
    try{for(const unit of selected){const changed=edits.get(unit.unit_id);if(changed!==undefined){const value=options.coerce(unit,changed);if(value)edited[unit.unit_id]=value;}}}
    catch(cause){error=(cause as Error).message;options.change();return null;}
    const shape={expected_review_revision:descriptor.review_revision,units:requested,edited_value:edited};
    const fingerprint=JSON.stringify(shape);let op=attempts.get(fingerprint);if(!op){op=options.newKey();attempts.set(fingerprint,op);}
    const payload={op_id:op,expected_review_revision:descriptor.review_revision,...(requested?{units:requested}:{}),...(Object.keys(edited).length?{edited_value:edited}:{})};
    /* 期望写进去的值：**本地改过的**优先；否则**暂存时改过的那个值**（staged_value）。 */
    const expected=selected.map(unit=>({unit,value:edited[unit.unit_id]??unitValue(unit)}));
    busy=true;error='';options.change();
    try{
      const reply=checkReviewDescriptor(await json('/api/platform/action-proposals/'+encodeURIComponent(descriptor.id)+'/accept',options,payload),descriptor.id,descriptor.target.table);
      const accepted=new Set(reply.accepted_units);
      if(!Array.isArray(reply.accepted_units)||accepted.size!==selected.length||selected.some(unit=>!accepted.has(unit.unit_id)||reply.units.find(next=>next.unit_id===unit.unit_id)?.status!=='accepted'))throw Error('未取得全部目标审核项的保存回执，请核实原操作');
      await options.readback(reply,expected);
      if(dead||options.signal?.aborted)return null;
      descriptor=reply;selected.forEach(unit=>edits.delete(unit.unit_id));options.progress(reply);return reply;
    }catch(cause){error='结果尚未核实，候选与人工修改已保留。'+((cause as Error).message||String(cause));return null;}
    finally{busy=false;if(!dead)options.change();}
  }
  /** 逐项放弃。放弃**不写正式值**，所以只认还没处理过的项（**暂存过的也算还没处理**）；回执要写清放弃了几项。 */
  async function reject(requested:string[]):Promise<ReviewDescriptor|null>{
    if(dead||busy||options.signal?.aborted)return null;
    const units=requested.map(id=>descriptor.units.find(unit=>unit.unit_id===id));
    if(!units.length||units.some(unit=>!unit||!SUBMITTABLE.has(unit.status))){error='候选已处理或不存在，请刷新核对';options.change();return null;}
    const selected=units as ReviewUnit[];
    const fingerprint=JSON.stringify({kind:'reject',units:requested});let op=attempts.get(fingerprint);if(!op){op=options.newKey();attempts.set(fingerprint,op);}
    const payload={op_id:op,expected_review_revision:descriptor.review_revision,units:selected.map(unit=>unit.unit_id)};
    busy=true;error='';options.change();
    try{
      const reply=checkReviewDescriptor(await json('/api/platform/action-proposals/'+encodeURIComponent(descriptor.id)+'/reject-units',options,payload),descriptor.id,descriptor.target.table);
      const dropped=new Set(Array.isArray(reply.rejected_units)?reply.rejected_units:[]);
      if(!dropped.size||selected.some(unit=>!dropped.has(unit.unit_id)||reply.units.find(next=>next.unit_id===unit.unit_id)?.status!=='rejected'))throw Error('未取得全部目标审核项的放弃回执，请核实原操作');
      if(dead||options.signal?.aborted)return null;
      descriptor=reply;selected.forEach(unit=>edits.delete(unit.unit_id));options.progress(reply);return reply;
    }catch(cause){error='放弃结果尚未核实，候选与人工修改已保留。'+((cause as Error).message||String(cause));return null;}
    finally{busy=false;if(!dead)options.change();}
  }
  /**
   * **暂存**（只标记，不写正式值）：
   * · `units` **总是显式给** —— 内核省略 `units` 时选的是「没关闭的全部项」，
   *   **连暂存过的也算** ⇒ 会把暂存时改过的值抹回原候选（重发一遍就改了字）。
   * · 暂存过的项再暂存一次 ⇒ 把 `staged_value` 一并带上（别把人改过的字弄丢）。
   */
  async function stage(requested:string[]):Promise<ReviewDescriptor|null>{
    if(dead||busy||options.signal?.aborted)return null;
    if(descriptor.can_accept===false){error=descriptor.accept_unavailable_reason||'当前建议不可确认';options.change();return null;}
    if(options.blocking()){error='请先完成当前输入和保存，再确认候选';options.change();return null;}
    const units=requested.map(id=>descriptor.units.find(unit=>unit.unit_id===id));
    if(!units.length||units.some(unit=>!unit||!SUBMITTABLE.has(unit.status))){error='候选已处理或不存在，请刷新核对';options.change();return null;}
    const selected=units as ReviewUnit[],edited:Record<string,ReviewValue>={};
    try{for(const unit of selected){
      const changed=edits.get(unit.unit_id);
      if(changed!==undefined){const value=options.coerce(unit,changed);if(value)edited[unit.unit_id]=value;}
      else if(unit.status==='staged'&&unit.staged_value)edited[unit.unit_id]=unit.staged_value;
    }}
    catch(cause){error=(cause as Error).message;options.change();return null;}
    const fingerprint=JSON.stringify({kind:'stage',units:selected.map(unit=>unit.unit_id),edited_value:edited});
    let op=attempts.get(fingerprint);if(!op){op=options.newKey();attempts.set(fingerprint,op);}
    const payload={op_id:op,expected_review_revision:descriptor.review_revision,units:selected.map(unit=>unit.unit_id),...(Object.keys(edited).length?{edited_value:edited}:{})};
    busy=true;error='';options.change();
    try{
      const reply=checkReviewDescriptor(await json('/api/platform/action-proposals/'+encodeURIComponent(descriptor.id)+'/stage-units',options,payload),descriptor.id,descriptor.target.table);
      const staged=new Set(Array.isArray(reply.staged_units)?reply.staged_units:[]);
      if(!staged.size||selected.some(unit=>!staged.has(unit.unit_id)||reply.units.find(next=>next.unit_id===unit.unit_id)?.status!=='staged'))throw Error('未取得全部目标审核项的暂存回执，请核实原操作');
      if(dead||options.signal?.aborted)return null;
      descriptor=reply;selected.forEach(unit=>edits.delete(unit.unit_id));options.progress(reply);return reply;
    }catch(cause){error='暂存结果尚未核实，候选与人工修改已保留。'+((cause as Error).message||String(cause));return null;}
    finally{busy=false;if(!dead)options.change();}
  }
  /** 取消暂存：回到「待确认」，正式值一个字都不动。 */
  async function unstage(requested:string[]):Promise<ReviewDescriptor|null>{
    if(dead||busy||options.signal?.aborted)return null;
    const units=requested.map(id=>descriptor.units.find(unit=>unit.unit_id===id));
    if(!units.length||units.some(unit=>!unit||unit.status!=='staged')){error='候选已处理或不存在，请刷新核对';options.change();return null;}
    const selected=units as ReviewUnit[];
    const fingerprint=JSON.stringify({kind:'unstage',units:selected.map(unit=>unit.unit_id)});let op=attempts.get(fingerprint);if(!op){op=options.newKey();attempts.set(fingerprint,op);}
    const payload={op_id:op,expected_review_revision:descriptor.review_revision,units:selected.map(unit=>unit.unit_id)};
    busy=true;error='';options.change();
    try{
      const reply=checkReviewDescriptor(await json('/api/platform/action-proposals/'+encodeURIComponent(descriptor.id)+'/unstage-units',options,payload),descriptor.id,descriptor.target.table);
      const unstaged=new Set(Array.isArray(reply.unstaged_units)?reply.unstaged_units:[]);
      if(!unstaged.size||selected.some(unit=>!unstaged.has(unit.unit_id)||reply.units.find(next=>next.unit_id===unit.unit_id)?.status!=='pending'))throw Error('未取得全部目标审核项的取消暂存回执，请核实原操作');
      if(dead||options.signal?.aborted)return null;
      descriptor=reply;options.progress(reply);return reply;
    }catch(cause){error='取消暂存结果尚未核实，候选与人工修改已保留。'+((cause as Error).message||String(cause));return null;}
    finally{busy=false;if(!dead)options.change();}
  }
  return controller;
}
export type InlineReviewController=ReturnType<typeof createInlineReviewController>;

/**
 * 这条提案**能不能进表格页的逐格审核**（PKG-118-T01）：
 * · **域声明了 `review_handler`**（内核列表项给的 `review_supported`）⇒ 能；
 *   （example 那条 `example.notice.project_to_case` 以前被能力白名单挡在门外。）
 * · 文件域那几个写格子的能力照旧能（老白名单，别丢）。
 * ⚠️ 「单元是不是格」拿到描述符之后才认（example 那条里还夹着一个「材料审核结论」单元）。
 */
export function proposalSupportsInlineReview(proposal:Record<string,unknown>):boolean{
  if(proposal.review_supported===true)return true;
  return ['files.sheet_cell_write','files.sheet_cells_write'].includes(String(proposal.capability||proposal.action||''));
}
/**
 * 这条提案**落在哪张表**？（列表项的 `target.table`）
 * ⚠️ **内核给的两个模块名不是一回事**：`target.module` 说的是**页面模块**（`excel`），
 * **域名另存在 `target.domain_module`** ⇒ 归属**只看表**，不许拿模块名当归属。
 */
export function proposalTargetTable(proposal:Record<string,unknown>):string{
  const target=(proposal.target&&typeof proposal.target==='object')?proposal.target as Record<string,unknown>:null;
  const payload=(proposal.payload&&typeof proposal.payload==='object')?proposal.payload as Record<string,unknown>:null;
  return String(target?.table??proposal.table??payload?.table??'');
}
/**
 * 这一格落在表的**哪一行哪一列**？
 * ⚠️ **口径**：example 那类提案的 `header` 是**中文表头**（如「审查状态」）⇒ **先按 `label` 找**，
 * 找不到再按 `fieldId` 找；**都对不上就返回 null（这一格不画）** —— 不许瞎猜一列。
 */
export function resolveCandidateCell(unit:ReviewUnit,rows:ReadonlyMap<string,number>,columns:ReadonlyArray<{fieldId:string;label:string}>):{row:number;col:number}|null{
  if(unit.kind!=='cell')return null;
  const row=rows.get(unit.target?.row_id??'');if(row===undefined)return null;
  const header=unit.target?.header??'';
  const byLabel=columns.findIndex(column=>column.label===header);
  const col=byLabel>=0?byLabel:columns.findIndex(column=>column.fieldId===header);
  if(col<0)return null;
  return {row,col};
}
