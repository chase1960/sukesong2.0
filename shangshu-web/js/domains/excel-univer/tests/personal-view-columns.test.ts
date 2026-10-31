import test from 'node:test';
import assert from 'node:assert/strict';
import {openTable} from '../src/backend.ts';
import type {SheetReadResult} from '../src/adapter.ts';
import type {PersonalViewResult} from '../src/personal-view.ts';

// Only HTTP is substituted: production view adoption, page decoding and write planning run unchanged.
async function fixture(run:(ctx:{sheet:SheetReadResult;view:PersonalViewResult;writes:Array<{path:string;payload:any}>})=>Promise<void>){
 const previous=globalThis.fetch,writes:Array<{path:string;payload:any}>=[];
 const sheet:SheetReadResult={table:'column-view',table_title:'个人列序',sheet:'S-1',sheet_title:'Sheet1',content_version:7,structure_version:3,
  headers:['编号','方向','备注'],column_types:{编号:'text',方向:'text',备注:'text'},writable:true,readonly_columns:[],column_widths:{'1':10,'2':20,'3':30},total_rows:2,
  column_options:{方向:{options:['DD','IN'],option_labels:{DD:'国内',IN:'国际'},allow_custom:false,custom_label:'自填'}},
  rows:[0,1].map(i=>({row_id:'row-'+i,row_index:i+2,record_version:'v'+i,values:{编号:{type:'text',value:'001'+i},方向:{type:'text',value:'DD'},备注:{type:'text',value:'备注'+i}}}))};
 const view:any={revision:2,view:{filters:[],freeze:{rows:0,columns:0},columns:['备注','编号','方向']},columns:['备注','编号','方向'],rows:sheet.rows.map(r=>({row_id:r.row_id,row_index:r.row_index})),total_rows:2,source_total_rows:2,content_version:7,structure_version:3};
 globalThis.fetch=async(url,init)=>{
  const path=String(url);
  if(path.startsWith('/api/platform/services/files.sheet_view_read/invoke?'))return Response.json(view);
  if(path.startsWith('/api/platform/services/files.sheet_read/invoke?')){const p=JSON.parse(new URL(path,'http://test').searchParams.get('payload')!);return Response.json({...sheet,rows:p.row_ids?sheet.rows.filter(r=>p.row_ids.includes(r.row_id)):sheet.rows});}
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body)),p=body.payload;writes.push({path,payload:p});
   if(path.includes('sheet_view_save')){view.view=structuredClone(p.view);view.columns=[...(p.view.columns??sheet.headers)];view.revision++;return Response.json({ok:true,result:view});}
   if(path.includes('sheet_layout_write'))return Response.json({ok:true,result:{applied:true,content_version:++sheet.content_version,column_widths:p.column_widths}});
   const added=path.includes('paste_apply')||path.includes('input_write');
   return Response.json({ok:true,result:{table:sheet.table,content_version:++sheet.content_version,structure_version:sheet.structure_version,headers:sheet.headers,rows_added:added?1:0,cols_added:0,row_ids:added?['new-row']:[],cells:[]}});
  }
  throw Error('Unexpected '+path);
 };
 try{await run({sheet,view,writes});}finally{globalThis.fetch=previous;}
}

test('personal column order projects headers, widths and complete dropdown metadata without changing physical order',()=>fixture(async({sheet})=>{
 const table=await openTable('column-view',undefined,'xlsx');const original=table.columns;
 await table.loadPersonalView!();
 assert.equal(table.columns,original,'existing grid references must remain current');
 assert.deepEqual(table.columns.map(c=>c.fieldId),['备注','编号','方向']);
 assert.deepEqual(table.columns[2].options,['DD','IN']);assert.deepEqual(table.columns[2].optionLabels,{DD:'国内',IN:'国际'});assert.equal(table.columns[2].allowCustom,false);
 assert.ok(table.columnWidths[0]>table.columnWidths[1]);
 const page=await table.loadPage(1,100);assert.deepEqual(page.meta!.columns.map(c=>c.header),['备注','编号','方向']);assert.equal(page.rows[0]['编号'],'0010');assert.deepEqual(sheet.headers,['编号','方向','备注']);
}));

test('multi-row paste over existing reordered columns writes each stable header once in one action',()=>fixture(async({writes})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();
 await table.pasteApply!({startRow:0,startCol:0,matrix:[['备注甲','00101'],['备注乙','00102']],opId:'reordered-existing'});
 assert.equal(writes.length,1);assert.match(writes[0].path,/sheet_cells_write/);
 assert.deepEqual(writes[0].payload.cells.map((c:any)=>[c.row_id,c.header,c.value.value]),[['row-0','备注','备注甲'],['row-0','编号','00101'],['row-1','备注','备注乙'],['row-1','编号','00102']]);
}));

test('expansion after reordering sends one official header-mapped package including new extra columns',()=>fixture(async({writes})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();
 await table.pasteApply!({startRow:2,startCol:1,matrix:[['00103','DD','extra']],opId:'reordered-new-row'});
 assert.equal(writes.length,1);assert.match(writes[0].path,/sheet_paste_apply/);assert.deepEqual(writes[0].payload.target_headers,['编号','方向',null]);assert.deepEqual(writes[0].payload.target_row_ids,[null]);assert.equal(writes[0].payload.start_col,1);
}));

test('single-cell new row entry maps the displayed column to the same physical header',()=>fixture(async({writes})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();await table.inputWrite!({startRow:2,startCol:0,matrix:[['新增备注']],opId:'new-note'});
 assert.deepEqual(writes[0].payload.target_headers,['备注']);assert.equal(writes[0].payload.value.value,'新增备注');
}));

test('resizing a displayed column stores the width against its physical column and projects the receipt back',()=>fixture(async({writes})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();await table.writeLayout({0:210},'width');
 assert.deepEqual(Object.keys(writes[0].payload.column_widths),['3']);assert.equal(table.columnWidths[0],210);
}));

test('saving only column order uses personal-view action and a fresh reopen restores it',()=>fixture(async({writes,view,sheet})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();
 await table.savePersonalView!({...view.view,columns:['方向','备注','编号']});
 assert.equal(writes.length,1);assert.match(writes[0].path,/sheet_view_save/);assert.equal(writes[0].payload.expected_revision,2);assert.deepEqual(sheet.headers,['编号','方向','备注']);
 const fresh=await openTable('column-view',undefined,'xlsx');await fresh.loadPersonalView!();assert.deepEqual(fresh.columns.map(c=>c.fieldId),['方向','备注','编号']);
}));

test('column reordering and row sorting together preserve both stable identities for a mixed paste',()=>fixture(async({view,writes})=>{
 view.rows.reverse();view.view.sort={column:'编号',direction:'desc'};
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();const page=await table.loadPage(1,100);
 assert.deepEqual(page.rows.map(row=>row.name),['row-1','row-0']);
 await table.pasteApply!({startRow:0,startCol:1,matrix:[['00111','IN'],['00122','DD']],opId:'sorted-and-reordered'});
 assert.deepEqual(writes[0].payload.cells.map((c:any)=>[c.row_id,c.header,c.value.value]),[['row-1','编号','00111'],['row-1','方向','IN'],['row-0','编号','00122'],['row-0','方向','DD']]);
}));

test('metadata refresh preserves ordered dropdown labels and adopts current permissions',()=>fixture(async({sheet})=>{
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();await table.loadPage(1,100);
 sheet.readonly_columns=['方向'];sheet.column_options!.方向.option_labels={DD:'国内新名称',IN:'国际'};
 await table.loadPage(1,100);
 assert.deepEqual(table.columns.map(c=>c.fieldId),['备注','编号','方向']);assert.equal(table.columns[2].optionLabels!.DD,'国内新名称');assert.equal(table.columns[2].readOnly,true);assert.equal(table.columns[2].allowCustom,false);
}));

test('advanced fill maps a contiguous physical slice and refuses a non-contiguous slice before writing',()=>fixture(async({view,writes})=>{
 view.view.columns=['方向','备注','编号'];(view as any).columns=[...view.view.columns];
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();
 await table.fillSeries!({opId:'contiguous-fill',payload:{start_row:0,end_row:0,start_col:0,end_col:1,series_type:'list',values:['a','b']}});
 assert.equal(writes[0].payload.start_col,1);assert.equal(writes[0].payload.end_col,2);
 const before=writes.length;
 await assert.rejects(table.fillSeries!({opId:'non-contiguous-fill',payload:{start_row:0,end_row:0,start_col:1,end_col:2,series_type:'list',values:['a','b']}}),/不是连续原位置/);
 assert.equal(writes.length,before,'不能把不连续的显示范围偷偷当成物理矩形写入');
}));

test('paste-special maps existing source and target columns and rejects non-contiguous advanced ranges',()=>fixture(async({view,writes})=>{
 view.view.columns=['方向','备注','编号'];(view as any).columns=[...view.view.columns];
 const table=await openTable('column-view',undefined,'xlsx');await table.loadPersonalView!();
 await table.pasteSpecial!({opId:'special',payload:{source_row:0,source_col:0,source_rows:1,source_cols:1,target_row:1,target_col:2,mode:'values',skip_empty:false}});
 assert.equal(writes[0].payload.source_col,1);assert.equal(writes[0].payload.target_col,0);
 const before=writes.length;
 await assert.rejects(table.pasteSpecial!({opId:'special-non-contiguous',payload:{source_row:0,source_col:1,source_rows:1,source_cols:2,target_row:1,target_col:0,mode:'values',skip_empty:false}}),/不是连续原位置/);assert.equal(writes.length,before);
}));

test('invalid personal column mapping fails closed rather than replacing the display with unknown fields',()=>fixture(async({view})=>{
 (view as any).columns=['备注','不存在','编号'];
 const table=await openTable('column-view',undefined,'xlsx');await assert.rejects(table.loadPersonalView!(),/列序与当前表头不一致/);
}));
