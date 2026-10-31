/**
 * 筛选条件的匹配方式。
 *
 * `contains` / `equals` / `empty` / `not_empty` —— 老四个，语义一个字不许改。
 * `in` —— 「值在这几个里」（列头筛选面板勾值清单用），value 是**字符串数组**。
 */
export type FilterOperator='contains'|'equals'|'empty'|'not_empty'|'in';
export interface PersonalViewFilter{column:string;operator:FilterOperator;value:string|string[]}
export interface PersonalView {filters:PersonalViewFilter[];freeze:{rows:number;columns:number};columns?:string[];sort?:{column:string;direction:'asc'|'desc'}}
export interface PersonalViewResult {revision:number;view:PersonalView;columns?:string[];rows:Array<{row_id:string;row_index:number}>;total_rows:number;source_total_rows:number;content_version:number;structure_version:number;invalid_reason?:string}
export const emptyPersonalView=():PersonalView=>({filters:[],freeze:{rows:0,columns:0}});

/** 个人列序只投影显示位置；原始列与字段身份保持不变。 */
export function personalColumnOrder(headers:readonly string[],order:readonly string[]=[]):string[]{
 if(new Set(headers).size!==headers.length||new Set(order).size!==order.length||order.some(header=>!headers.includes(header)))throw Error('个人视图列序与当前表头不一致，请重新打开');
 const selected=new Set(order);return [...order,...headers.filter(header=>!selected.has(header))];
}

/**
 * 某一列**整列**的去重值（列头筛选面板的「值清单」）。
 *
 * 空值在清单里是空字符串 `''`（界面上显示成「(空白)」）——
 * 与后端筛选口径**完全对得上**（空格的文本也是 `''`）。
 */
export interface ColumnValues{column:string;values:string[];has_blank:boolean;total:number;truncated:boolean}

/** 「值在这几个里」的上限 —— 与后端 `sheet_view.py` 的同名常量一致（改一处要改两处）。 */
export const MAX_IN_VALUES=500;
export const MAX_IN_VALUE_LENGTH=32767;
export const MAX_IN_TOTAL_LENGTH=100000;

/** 取某一列整列的去重值（只读服务，不写库）。 */
export async function requestColumnValues(table:string,column:string,signal?:AbortSignal):Promise<ColumnValues>{
 const query=new URLSearchParams({payload:JSON.stringify({table,column})});
 const response=await fetch('/api/platform/services/files.sheet_column_values/invoke?'+query,{credentials:'include',signal});
 const body=await response.json();if(!response.ok||body.ok===false)throw Error(body.error||'取不到这一列的值');
 const values=body?.values;if(!Array.isArray(values)||values.some((v:any)=>typeof v!=='string'))throw Error('值清单回执不完整');
 return {column:String(body.column??column),values,has_blank:!!body.has_blank,total:Number.isInteger(body.total)?body.total:values.length,truncated:!!body.truncated};
}

export async function requestPersonalView(table:string,signal?:AbortSignal,save?:{view:PersonalView;revision:number;structureVersion:number}):Promise<PersonalViewResult>{
 const response=save
  ?await fetch('/api/platform/actions/files.sheet_view_save/execute',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{table,view:save.view,expected_revision:save.revision,expected_structure_version:save.structureVersion},confirmed:true,source:'user',idempotency_key:globalThis.crypto.randomUUID()})})
  :await fetch('/api/platform/services/files.sheet_view_read/invoke?'+new URLSearchParams({payload:JSON.stringify({table})}),{credentials:'include',signal});
 const body=await response.json();if(!response.ok||body.ok===false)throw Error(body.error||'个人视图未保存');const data=save?body.result:body;
 if(!data||!Array.isArray(data.rows)||!Number.isInteger(data.revision)||!data.view?.freeze||!Array.isArray(data.view.filters))throw Error('个人视图回执不完整');
 if(data.columns!==undefined&&(!Array.isArray(data.columns)||data.columns.some((header:any)=>typeof header!=='string')||new Set(data.columns).size!==data.columns.length))throw Error('个人视图列序回执不完整');
 const ids=data.rows.map((r:any)=>r.row_id);if(new Set(ids).size!==ids.length||data.rows.some((r:any)=>typeof r.row_id!=='string'||!Number.isInteger(r.row_index)))throw Error('个人视图行身份无效');return data;
}
