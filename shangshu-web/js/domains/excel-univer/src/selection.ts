/** Univer facade返回FSelection，不是坐标对象；无法确定目标时绝不默认A1。 */
export function selectionRange(selection:any):{startRow:number;endRow:number;startCol:number;endCol:number}|null{
  if(!selection)return null;
  const blocks=selection.getActiveRangeList?.();
  if(Array.isArray(blocks)&&blocks.length!==1)return null;
  if(Array.isArray(selection)&&selection.length!==1)return null;
  const active=selection.getActiveRange?.()??(Array.isArray(selection)?selection[0]:selection);
  const range=active?.getRange?.()??active?.range??active;
  const sr=range?.startRow,sc=range?.startColumn,er=range?.endRow??sr,ec=range?.endColumn??sc;
  if(![sr,sc,er,ec].every(value=>Number.isInteger(value)&&value>=0))return null;
  return {startRow:Math.min(sr,er),endRow:Math.max(sr,er),startCol:Math.min(sc,ec),endCol:Math.max(sc,ec)};
}
