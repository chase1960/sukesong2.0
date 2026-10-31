import {fetchObjectInfo,coerceObjectValue,type ObjectInfo} from './api';
import {getRowViewMetadata,type UnifiedTable,type WriteRequest} from './backend';
/** One visible object; source fields keep the original public action and its authorization. */
export function attachCompanionTable(table:UnifiedTable,info:ObjectInfo,signal?:AbortSignal):UnifiedTable{
 const binding=info.companion!;const source=new Map(binding.field_columns.map(field=>[field.header,field.field_id]));
 let fields=new Map(info.fields.map(field=>[field.id,field]));let writable=new Set(Object.keys(info.input_schema?.properties||{}));
 let canUpdate=info.operations?.includes('update')===true;
 const displayed=new Map<string,Record<string,unknown>>(),positions=new Map<number,string>();
 const original={loadPage:table.loadPage.bind(table),writeCell:table.writeCell.bind(table),writeCells:table.writeCells.bind(table),input:table.inputWrite?.bind(table),paste:table.pasteApply?.bind(table),refresh:table.refreshMeta.bind(table),sort:table.sort?.bind(table),clearSort:table.clearSort?.bind(table)};
 table.resourceId=binding.file_id;table.key=info.id;table.title=info.title||info.id;
 const applyColumns=()=>{for(const column of table.columns){const fieldId=source.get(column.fieldId);if(fieldId){column.readOnly=!canUpdate||!writable.has(fieldId);column.type=fields.get(fieldId)?.type||column.type;}}};
 applyColumns();table.writable=table.writable||(canUpdate&&writable.size>0);
 table.loadPage=async(page,length)=>{const result=await original.loadPage(page,length);result.rows.forEach((row,i)=>{displayed.set(row.name,{...row});positions.set((page-1)*length+i,row.name);});applyColumns();return result;};
 table.refreshMeta=async()=>{
  const visibleColumns=table.columns;
  table.writable=false;canUpdate=false;writable.clear();for(const column of table.columns)column.readOnly=true;
  const fresh=await fetchObjectInfo(info.id,signal);
  if(fresh.companion?.file_id!==binding.file_id||fresh.revision!==info.revision)throw Error('对象绑定或定义已变化，请重新打开表格');
  await original.refresh();visibleColumns.splice(0,visibleColumns.length,...table.columns);table.columns=visibleColumns;info=fresh;fields=new Map(info.fields.map(field=>[field.id,field]));writable=new Set(Object.keys(info.input_schema?.properties||{}));canUpdate=info.operations?.includes('update')===true;
  applyColumns();table.writable=table.writable||(canUpdate&&writable.size>0);table.title=info.title||info.id;
 };
 if(original.sort)table.sort=async spec=>{const result=await original.sort!(spec);positions.clear();return result;};
 if(original.clearSort)table.clearSort=async()=>{const result=await original.clearSort!();positions.clear();return result;};
 const sourceVersions=new Map<string,string>();
 const load=table.loadPage.bind(table);table.loadPage=async(page,length)=>{const result=await load(page,length);for(const row of result.rows){const version=getRowViewMetadata(row)?.sourceModified;if(version)sourceVersions.set(row.name,version);else sourceVersions.delete(row.name);}return result;};
 const commands=new Map<string,Record<string,unknown>>();
 const commandShapes=new Map<string,string>();
 const bundle=async(reqs:WriteRequest[],key:string)=>{
  const shape=JSON.stringify(reqs.map(req=>[req.rowId,req.fieldId,req.fieldType,req.text]));
  if(commandShapes.has(key)&&commandShapes.get(key)!==shape)throw Error('同一操作编号不能修改不同内容');
  let payload=commands.get(key);
  if(!payload){
    const expected:Record<string,string>={};
    const cells=reqs.map(req=>{
      const field=source.get(req.fieldId);let value:Record<string,unknown>;
      if(field){
        if(!canUpdate||!writable.has(field))throw Error('当前字段没有编辑权限');
        if(req.text.startsWith('='))throw Error('原字段不接受公式，请在普通列使用公式');
        const version=sourceVersions.get(req.rowId);if(!version)throw Error('当前记录缺少源版本，请重新加载表格');expected[req.rowId]=version;
        const parsed=coerceObjectValue(fields.get(field)?.type,req.text);
        value={type:parsed===null?'empty':typeof parsed==='number'?'number':typeof parsed==='boolean'?'boolean':fields.get(field)?.type==='date'?'date':'text',value:parsed};
      }else{
        const parsed=req.text.startsWith('=')?null:coerceObjectValue(req.fieldType,req.text);
        value=req.text.startsWith('=')?{type:'formula',formula:req.text,value:null}:{type:req.text===''?'empty':typeof parsed==='number'?'number':typeof parsed==='boolean'?'boolean':req.fieldType==='date'?'date':'text',value:parsed};
      }
      return {row_id:req.rowId,header:req.fieldId,value};
    });
    payload={object_id:info.id,file_id:binding.file_id,cells,expected_modified:expected,expected_revision:info.revision,definition_revision:binding.definition_revision,expected_content_version:table.contentVersion,expected_structure_version:table.structureVersion,op_id:key};commands.set(key,payload);commandShapes.set(key,shape);
  }
  const response=await fetch('/api/platform/actions/platform.object.companion_write/execute',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key,source:'user'}),signal});
  const body=await response.json();if(!response.ok||body.ok===false)throw Error(body.error||body.message||'保存失败');
  const result=body.result;if(!result||!Array.isArray(result.cells)||!Number.isInteger(result.content_version))throw Error('保存回执不完整，请重试原操作');
  table.adoptVersions?.({contentVersion:result.content_version,structureVersion:result.structure_version});
  for(const [row,version]of Object.entries(result.source_versions||{}))if(typeof version==='string')sourceVersions.set(row,version);
  return {actionCount:1,idempotent:!!body.idempotent,rowsAdded:0,colsAdded:0,rowIds:reqs.map(req=>req.rowId),headers:table.columns.map(c=>c.fieldId),cells:result.cells.map((cell:any)=>({rowId:cell.row_id,header:cell.header,before:cell.before,after:cell.after})),contentVersion:result.content_version,structureVersion:result.structure_version,refreshLoaded:true,undoAction:'companion' as const};
 };
 const undoRequests=new Map<string,{path:string;payload:Record<string,unknown>}>();
 table.companionUndoRequest=opId=>{const old=undoRequests.get(opId);if(old)return old;const request={path:'/api/platform/actions/platform.object.companion_undo/execute',payload:{object_id:info.id,file_id:binding.file_id,undo_of:opId,op_id:'undo-'+opId,expected_content_version:table.contentVersion,expected_structure_version:table.structureVersion,definition_revision:binding.definition_revision,expected_revision:info.revision}};undoRequests.set(opId,request);return request;};
 table.writeCell=async req=>{if(!source.has(req.fieldId))return original.writeCell(req);const result=await bundle([req],req.idempotencyKey);return {kind:'success',...result};};
 table.writeCells=async(reqs,key)=>{if(!reqs.some(req=>source.has(req.fieldId)))return original.writeCells(reqs,key);const result=await bundle(reqs,key);return {...result,cellResults:result.cells,applied:result.cells.length};};
 const range=(fallback:NonNullable<UnifiedTable['pasteApply']>|undefined):NonNullable<UnifiedTable['pasteApply']>=>async opts=>{
  const selected=opts.matrix.flatMap((row,r)=>row.map((text,c)=>({text,row:opts.startRow+r,column:table.columns[opts.startCol+c]})));
  if(!selected.some(cell=>cell.column&&source.has(cell.column.fieldId))){if(!fallback)throw Error('当前表不支持此操作');return fallback(opts);}
  const reqs=selected.map(cell=>{const rowId=positions.get(cell.row);if(!rowId||!cell.column)throw Error('混合写入不能隐式扩展原对象，请先建立记录或列');return {rowId,fieldId:cell.column.fieldId,fieldType:cell.column.type,text:cell.text,value:cell.text,idempotencyKey:opts.opId};});
  return bundle(reqs,opts.opId);
 };
 table.inputWrite=range(original.input);table.pasteApply=range(original.paste);

 return table;
}
