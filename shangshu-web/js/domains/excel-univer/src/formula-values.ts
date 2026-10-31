import type {CellValue} from './adapter';
/** Official values only. Formula text is retained separately for editing, never sent to the browser evaluator. */
export function formulaDisplay(cell:CellValue|undefined):string|number|boolean|null{
 if(!cell)return '';
 if(cell.type==='hidden'||cell.hidden)return '无权查看';
 if(cell.type==='formula'&&cell.calculation_pending)return '待计算';
 return cell.value??'';
}
export function editableFormula(cell:CellValue|undefined):string|undefined{
 return cell?.type==='formula'&&!cell.hidden?cell.formula:undefined;
}
/**
 * 这次写进去的东西里**有没有公式**。
 *
 * 活站踩过的坑（2026-10-19 3870）：写进 `=SUM(B2:B3)` 后，
 * 服务端确实存成了公式并算出了缓存值（xlsx 里 `<f>SUM(B2:B3)</f><v>1323.44</v>`），
 * **但界面那格一直停在公式文本** —— 因为「要不要重读公式值」只看了服务端回执，
 * 没看**本次写进去的原文**。
 */
export function wroteFormula(values:unknown[]):boolean{
 return values.some(v=>typeof v==='string'&&v.startsWith('='));
}
/**
 * 写完以后要不要**重读公式值**。
 *
 * 三条依据：服务端说这表有公式 / 回执里的值是类型化公式 / **本次写进了公式原文**。
 */
export function needsFormulaRefresh(hasFormulas:boolean|undefined,values:unknown[]=[]){
 return hasFormulas===true
  ||values.some(v=>!!v&&typeof v==='object'&&(v as {type?:string}).type==='formula')
  ||wroteFormula(values);
}
