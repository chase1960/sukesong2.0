type UI={dialog(o:{title:string;body:string;actions:Array<{label:string;variant?:string;onClick:()=>void}>}):HTMLElement|null;closeModal():boolean;guardModal(e:HTMLElement,g:()=>boolean):void};
export type StructureChoice={kind:'row_insert'|'row_move'|'row_delete'|'row_restore'|'column_insert'|'column_move'|'column_delete';position:number;count:number;header:string;restore:string};
export function editStructure(ui:UI,selected:{row:number;column:string},deleted:Array<{rowId:string;rowIndex:number}>,save:(choice:StructureChoice)=>Promise<void>,canClose:()=>boolean=()=>true){
 let busy=false;
 const dialog=ui.dialog({title:'行列操作',body:'<div><p data-target></p><label>操作 <select data-kind aria-label="行列操作类型"></select></label><p><label>目标行号（移动到该行之前；留空为末尾）<input data-position type="number" min="1" aria-label="目标行号"></label></p><p><label>插入行数 <input data-count type="number" min="1" value="1" aria-label="插入行数"></label></p><p><label>列名（插列时为新名称；移列时为目标列名，留空为末尾）<input data-header aria-label="列名"></label></p><p><label>恢复行 <select data-restore aria-label="恢复行"></select></label></p><p>删除行会隐藏并保留原值。删除列会移除该列；绑定字段或公式引用冲突时不会执行。成功后可用“撤回”撤销本人最近三步。</p><div data-status role="status"></div></div>',actions:[{label:'取消',onClick:()=>{ui.closeModal();}},{label:'执行',variant:'pri',onClick:()=>{void submit();}}]});
 if(!dialog)return;ui.guardModal(dialog,()=>!busy&&canClose());
 dialog.querySelector('[data-target]')!.textContent=`当前选中：第 ${selected.row+1} 行，${selected.column||'未选中列'}`;
 const kind=dialog.querySelector('[data-kind]') as HTMLSelectElement,restore=dialog.querySelector('[data-restore]') as HTMLSelectElement;
 for(const [value,label] of [['row_insert','在选中行前插行'],['row_move','移动选中行'],['row_delete','删除选中行'],['row_restore','恢复已删除行'],['column_insert','在选中列前插列'],['column_move','调整我的列顺序（只影响我）'],['column_delete','删除选中列']]){const o=document.createElement('option');o.value=value;o.textContent=label;kind.append(o);}
 for(const row of deleted){const o=document.createElement('option');o.value=row.rowId;o.textContent=`原第 ${row.rowIndex-1} 行 (${row.rowId})`;restore.append(o);}
 async function submit(){if(busy)return;const input=(key:string)=>(dialog!.querySelector('[data-'+key+']') as HTMLInputElement).value;
 const choice:StructureChoice={kind:kind.value as StructureChoice['kind'],position:input('position')?Number(input('position')):0,count:Number(input('count')),header:input('header').trim(),restore:restore.value};
 const status=dialog!.querySelector('[data-status]')!;
 if(!Number.isInteger(choice.position)||choice.position<0||!Number.isInteger(choice.count)||choice.count<1){status.textContent='行号与数量必须是有效整数';return;}
 busy=true;const controls=dialog!.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select');controls.forEach(c=>c.disabled=true);
 try{await save(choice);busy=false;ui.closeModal();}catch(e){status.textContent=(e as Error).message;}finally{busy=false;controls.forEach(c=>c.disabled=false);}
 }
}
