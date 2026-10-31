import {readRelations,relationCommand,relationErrorText,type RelationDefinition} from './table-relations';
import {ApiError} from './api';
type UI={dialog(options:{title:string;body:string;actions:Array<{label:string;variant?:string;onClick:()=>void}>}):HTMLElement|null;closeModal():boolean;guardModal(el:HTMLElement,guard:()=>boolean):void};
type Choice={id:string;label:string};
export interface RelationDialogContext {
 table:string;header:string;rowId?:string;structureVersion:number;canStructure:boolean;
 targets:Choice[];
 /** 源列（要配关联的那一列）已有值 → 不能当关联列（后端会拒「请使用空白列配置关联」）。 */
 sourceColumnHasValues?:boolean;
 loadTarget:(id:string,query?:string,page?:number)=>Promise<{resourceId:string;columns:Choice[];rows:Choice[];total:number}>;
 saved:()=>Promise<void>;
}
export async function editTableRelation(context:RelationDialogContext,ui:UI){
 let busy=true,targetResource='',page=1,total=0,pending:{execute:()=>Promise<unknown>}|null=null,definition:RelationDefinition|undefined;
 // Excel 的做法：一个弹窗里**主行动只有一个**，其余动作收进一个「操作」下拉，
 // 用户不用在一排按钮里猜哪个是主行动、哪个是危险的（解绑整列会清掉整列的关联）。
 const dialog=ui.dialog({title:'单元格关联',body:'<p data-caption></p>'
  +'<div class="excel-relation-fields">'
  +'<label class="excel-relation-field">目标表 <select data-table aria-label="目标表"></select></label>'
  +'<label class="excel-relation-field">目标列 <select data-column aria-label="目标列"></select></label>'
  +'<label class="excel-relation-field excel-relation-field-wide">查找记录 <span class="excel-relation-search">'
  +'<input data-query aria-label="查找记录" placeholder="按关键字找目标记录">'
  +'<button type="button" class="btn" data-search>查找</button></span></label>'
  +'<label class="excel-relation-field excel-relation-field-wide">目标记录 <select data-row aria-label="目标记录"></select></label>'
  +'<label class="excel-relation-field excel-relation-field-wide">操作 <select data-action aria-label="操作"></select></label>'
  +'<div class="excel-relation-pager">'
  +'<button type="button" class="btn btn-sm" data-prev>上一页</button>'
  +'<button type="button" class="btn btn-sm" data-next>下一页</button>'
  +'<span class="excel-relation-page" data-page></span></div>'
  +'</div><p role="status" data-status></p>',actions:[
  {label:'取消',onClick:()=>{ui.closeModal();}},
  {label:'执行',variant:'pri',onClick:()=>{void run();}},
 ]});if(!dialog)return;
 const status=dialog.querySelector('[data-status]')!,target=dialog.querySelector<HTMLSelectElement>('[data-table]')!,column=dialog.querySelector<HTMLSelectElement>('[data-column]')!,row=dialog.querySelector<HTMLSelectElement>('[data-row]')!;
 const action=dialog.querySelector<HTMLSelectElement>('[data-action]')!;
 const pageLabel=dialog.querySelector('[data-page]')!;
 // 四种动作：默认落在「保存本行关联」上（最常用），其余在下拉里。
 for(const [value,label] of [['set','保存本行关联'],['define','配置关系列'],['clear','清除本行关联'],['remove','解绑整列']] as const){
  const o=document.createElement('option');o.value=value;o.textContent=label;action.append(o);
 }
 action.value='set';
 // FIX-17：把两条产品规则**提前说清**，别让用户点完才知道被拒：
 // ① 关联列必须是一列**空白**列；② 只能关联到你有权的表，不允许向上/跨管理范围关联非公共资料。
 const caption=dialog.querySelector('[data-caption]')!;
 caption.textContent=`列：${context.header}${context.rowId?'；记录：'+context.rowId:''}。引用只读取目标，不修改目标记录。`
  +'关联列必须是一列空白列；目标表只列你有权访问的表格。';
 if(context.sourceColumnHasValues)caption.textContent+='当前这一列已有值，不能配关联——请换一列空白列。';
 ui.guardModal(dialog,()=>!busy&&!pending);
 function options(select:HTMLSelectElement,choices:Choice[]){select.replaceChildren();for(const c of choices){const o=document.createElement('option');o.value=c.id;o.textContent=c.label;select.append(o);}}
 function lock(){dialog!.querySelectorAll<HTMLButtonElement|HTMLSelectElement|HTMLInputElement>('button,select,input').forEach(e=>e.disabled=busy);}
 async function load(){busy=true;targetResource='';lock();try{const data=await context.loadTarget(target.value,(dialog!.querySelector('[data-query]') as HTMLInputElement).value.trim(),page);targetResource=data.resourceId;total=data.total;const prior=column.value;options(column,data.columns);if(data.columns.some(c=>c.id===prior))column.value=prior;options(row,[{id:'',label:'不关联（清除本行引用）'},...data.rows]);if(definition?.target_table===targetResource)column.value=definition.target_header||'';pageLabel.textContent=`第 ${page} 页，共 ${total} 条有权记录`;}catch(e){options(column,[]);options(row,[]);pageLabel.textContent='';status.textContent=relationErrorText(e);}finally{busy=false;lock();}}
 target.onchange=()=>{page=1;void load();};
 (dialog.querySelector('[data-search]') as HTMLButtonElement).onclick=()=>{page=1;void load();};
 (dialog.querySelector('[data-prev]') as HTMLButtonElement).onclick=()=>{if(page>1){page--;void load();}};
 (dialog.querySelector('[data-next]') as HTMLButtonElement).onclick=()=>{if(page*100<total){page++;void load();}};
 /**
  * 「执行」按「操作」下拉里选的那一项去做。
  * 破坏性动作（清除本行关联 / 解绑整列）要先确认一句 ——
  * 以前它们是各自独立的按钮，点错的机会小；现在收进一个下拉 + 一个主按钮，
  * 「选了危险项再点绿色按钮」的组合更容易误触，所以这里补一道确认。
  */
 function run(){
  const kind=action.value;
  if(kind==='remove'){
   if(!globalThis.confirm('解绑整列会清掉这一列上的所有关联记录，确定继续？'))return;
   void write('remove');return;
  }
  if(kind==='clear'){
   if(!globalThis.confirm('清除本行关联会去掉这一行指向目标记录的引用，确定继续？'))return;
   void write('set',true);return;
  }
  if(kind==='define')void write('define');
  else void write('set');
 }
 async function write(kind:'define'|'set'|'remove',clear=false){
  if(busy)return;
  if(!pending){
   if(kind!=='set'&&!context.canStructure){status.textContent='没有配置表结构的权限';return;}
   if(kind==='define'&&context.sourceColumnHasValues){status.textContent='关联列必须是一列空白列：当前这一列已有值，请换一列空白列再配置';return;}
   if(kind==='set'&&(!context.rowId||!definition)){status.textContent='请先配置关系列并选择一条已保存的源记录';return;}
   if(kind!=='remove'&&!clear&&!targetResource){status.textContent='请先选择可用的目标表';return;}
   if(kind==='set'&&!clear&&(targetResource!==definition?.target_table||column.value!==definition?.target_header)){status.textContent='请先保存新的关系列配置，再选择记录';return;}
   const payload:Record<string,unknown>={table:context.table,header:context.header};
   if(kind==='define')Object.assign(payload,{target_table:targetResource,target_header:column.value,expected_structure_version:context.structureVersion,...(definition?{expected_revision:definition.revision}:{})});
   else {if(!definition){status.textContent='此列尚未配置关联';return;}payload.expected_revision=definition.revision;}
   if(kind==='set')Object.assign(payload,{row_id:context.rowId,...(!clear&&row.value?{target_row_id:row.value}:{})});
   pending=relationCommand(kind,payload);
  }
  busy=true;lock();status.textContent='正在保存关联…';
  try{await pending.execute();pending=null;await context.saved();busy=false;ui.closeModal();}
  catch(e){
   if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408){pending=null;status.textContent=relationErrorText(e)+'；请关闭并重新打开以核对最新配置。';}
   else status.textContent=relationErrorText(e)+'；再次操作将重试同一请求。';
  }
  finally{busy=false;lock();}
 }
 try{const snapshot=await readRelations(context.table,context.rowId?[context.rowId]:[]);definition=snapshot.definitions.find(d=>d.header===context.header);options(target,context.targets);if(definition?.target_table&&!context.targets.some(t=>t.id===definition!.target_table)){const o=document.createElement('option');o.value=o.textContent=definition.target_table;target.append(o);}if(definition?.target_table)target.value=definition.target_table;await load();const linked=snapshot.values.find(v=>v.row_id===context.rowId&&v.header===context.header);if(linked?.direct_target){const id=linked.direct_target.row_id;if(![...row.options].some(o=>o.value===id)){const o=document.createElement('option');o.value=id;o.textContent='Current: '+id;row.append(o);}row.value=id;}if(definition?.status==='unavailable')status.textContent='原关联目标当前不可读，请先恢复授权或解绑整列。';}
 catch(e){status.textContent=relationErrorText(e);busy=false;lock();}
}
