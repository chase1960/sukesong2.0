import {type PersonalView} from './personal-view';
type DialogWorkspace = {
 dialog(options:{title:string;body:string;actions:Array<{label:string;variant?:string;onClick:()=>void}>}):HTMLElement|null;
 closeModal():boolean;
 guardModal(element:HTMLElement,guard:()=>boolean):void;
};
/**
 * 筛选可选的列。
 * `readable:false` = 这一列**当前用户读不到**（被升列成了受字段 ACL 保护的正式字段）。
 * ⚠️ 这类列**不给放进筛选下拉**（FIX-47）：后端会拒「无权使用该列配置个人视图」，
 * 而让用户选一个自己都看不到的列、白跑一趟保存，是白让人添堵。
 * 不可读不是「不能筛」——**根本不该出现在选项里**。
 */
export interface FilterableColumn { id: string; label: string; readable: boolean }
export function editPersonalView(columns:FilterableColumn[],current:PersonalView,save:(view:PersonalView)=>Promise<void>,ui:DialogWorkspace){
 let saving=false;
 // 冻结常用的档位：0～20 之间的常用几档 + 「更多」走手输。
 // 原来是两个裸数字框（用户看不出单位），现在收成下拉框并写清单位。
 const FREEZE_CHOICES=[0,1,2,3,5,10,20];
 const dialog=ui.dialog({title:'我的表格视图',
  body:'<div class="excel-personal-view-fields">'
  +'<p>筛选、排序和冻结仅影响本人查看，不移动表格数据。</p>'
  +'<div class="excel-personal-view-block">'
  +'<h4>筛选条件</h4>'
  +'<p class="excel-personal-view-hint">没有条件就是不过滤：下面的每一行是「某列 满足某个条件」，一行一个条件。</p>'
  +'<div data-filters></div>'
  +'<button class="btn" type="button" data-add>增加筛选条件</button>'
  +'</div>'
  +'<div class="excel-personal-view-block">'
  +'<h4>冻结</h4>'
  +'<p class="excel-personal-view-hint">冻结的行和列会一直留在屏幕上，滚动时不动。</p>'
  +'<p class="excel-freeze-fields">'
  +'<label>冻结前 <select data-rows aria-label="冻结行数"></select> 行</label>'
  +'<label>前 <select data-cols aria-label="冻结列数"></select> 列</label>'
  +'</p></div>'
  +'<div role="status" aria-live="polite" data-status></div></div>',
  actions:[{label:'清除筛选和冻结',onClick:()=>{host.replaceChildren();rows.value='0';cols.value='0';}},
   {label:'取消',onClick:()=>{ui.closeModal();}},
   {label:'保存视图',variant:'pri',onClick:()=>{void submit();}}]});
 if(!dialog)return;
 ui.guardModal(dialog,()=>!saving);
 const host=dialog.querySelector('[data-filters]')!,rows=dialog.querySelector('[data-rows]') as HTMLSelectElement,cols=dialog.querySelector('[data-cols]') as HTMLSelectElement,status=dialog.querySelector('[data-status]')!;
 for(const select of [rows,cols]){
  for(const value of FREEZE_CHOICES){const o=document.createElement('option');o.value=String(value);o.textContent=String(value);select.append(o);}
  // 现有值不在常用档位里也要能显示出来（不能被悄悄改成 0）
  const currentValue=select===rows?current.freeze.rows:current.freeze.columns;
  if(!FREEZE_CHOICES.includes(currentValue)){const o=document.createElement('option');o.value=String(currentValue);o.textContent=String(currentValue);select.append(o);}
  select.value=String(currentValue);
 }
 function add(filter?:PersonalView['filters'][number]){
  if(host.children.length>=20)return;const row=document.createElement('div');row.className='excel-view-filter-row';
  // 只给**可读**的列（FIX-47）—— 不可读的列后端会拒（无权使用该列配置个人视图），
  // 让用户选一个自己都看不到的列、白跑一趟保存，是白让人添堵。
  const usable=columns.filter(column=>column.readable!==false);
  const field=document.createElement('select');
  for(const column of usable){const o=document.createElement('option');o.value=column.id;o.textContent=column.label||column.id;field.append(o);}
  field.setAttribute('aria-label','筛选列');
  field.value=filter?.column&&usable.some(c=>c.id===filter.column)?filter.column:(usable[0]?.id??'');
  const op=document.createElement('select');for(const [value,label] of [['contains','包含'],['equals','等于'],['empty','为空'],['not_empty','不为空']]){const o=document.createElement('option');o.value=value;o.textContent=label;op.append(o);}
  // `in`（列头筛选面板勾值清单产生的）**只在这一条本来是 `in` 时才出现** ——
  // 让人在这个弹窗里手选 `in`，手边只有一个输入框，存不出数组。
  const inValue=filter?.operator==='in'&&Array.isArray(filter.value)?filter.value.slice():null;
  if(inValue){const o=document.createElement('option');o.value='in';o.textContent='在值清单里';op.append(o);}
  op.setAttribute('aria-label','匹配方式');op.value=filter?.operator||'contains';
  // `in` 的 value 是数组（列头筛选面板用的），这个弹窗只认**字符串**的那种 ——
  // 数组的改从列头那个面板改，这里显示成空，别把数组塞进输入框。
  const value=document.createElement('input');value.value=typeof filter?.value==='string'?filter.value:'';value.maxLength=1000;value.placeholder='筛选值';
  if(inValue){value.disabled=true;value.placeholder='在值清单里筛的（去列头的小漏斗改）';}
  // 原样带回那一组值：这个弹窗保存时**不能把 `in` 的数组弄丢**（两边存同一份 view）。
  (row as HTMLDivElement & {_inValue?:string[]})._inValue=inValue??undefined;
  const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='移除';remove.onclick=()=>row.remove();row.append(field,op,value,remove);host.append(row);
 }
 current.filters.forEach(add);(dialog.querySelector('[data-add]') as HTMLButtonElement).onclick=()=>add();
 async function submit(){
  if(saving)return;
  const freeze={rows:Number(rows.value),columns:Number(cols.value)};if(Object.values(freeze).some(v=>!Number.isInteger(v)||v<0||v>1000)){status.textContent='冻结数量须为0到1000的整数';return;}
  const filters=[...host.children].map(row=>{const selects=row.querySelectorAll('select');const operator=selects[1].value as PersonalView['filters'][number]['operator'];
   // 仍是 `in` ⇒ 原样带回那一组值；用户改成了别的匹配方式 ⇒ 用输入框里的文字。
   const inValue=(row as HTMLDivElement & {_inValue?:string[]})._inValue;
   return {column:selects[0].value,operator,value:operator==='in'&&inValue?inValue:row.querySelector('input')!.value};});
  saving=true;const controls=dialog!.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select');controls.forEach(b=>b.disabled=true);status.textContent='正在保存个人视图…';
  try{await save({...current,filters,freeze});saving=false;ui.closeModal();}catch(error){status.textContent=(error as Error).message;}finally{saving=false;controls.forEach(b=>b.disabled=false);}
 };
}
