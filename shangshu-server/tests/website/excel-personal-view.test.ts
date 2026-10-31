import test from 'node:test';import assert from 'node:assert/strict';
import {openTable} from '../../../shangshu-web/js/domains/excel-univer/src/backend.ts';
test('persisted personal filtering reads visible IDs, saves revision, and pastes across hidden rows without moving them',async()=>{
 const original=globalThis.fetch,writes:any[]=[],saved:any[]=[];let revision=2,version=1;
 const rows=Array.from({length:6},(_,i)=>({row_id:`r${i}`,row_index:i+2,values:{值:{type:'text',value:String(i)}}}));
 const view={filters:[{column:'值',operator:'contains',value:'x'}],freeze:{rows:1,columns:1}};
 const result=()=>({revision,view,rows:[rows[4],rows[1]].map(({row_id,row_index})=>({row_id,row_index})),source_total_rows:6,total_rows:2,content_version:version,structure_version:1});
 globalThis.fetch=async(url:any,init:any)=>{const path=String(url),p=init?.body?JSON.parse(init.body).payload:JSON.parse(new URL(path,'http://test').searchParams.get('payload')||'{}');const reply=(body:any)=>new Response(JSON.stringify(body));
  if(path==='/api/platform/objects')return reply({list:[]});
  // Public services return the value directly; actions wrap their result.
  if(path.includes('sheet_view_read'))return reply({ok:true,...result()});
  if(path.includes('sheet_view_save')){saved.push(p);revision++;return reply({result:result()});}
  if(path.includes('sheet_read'))return reply({table:'fixture',table_title:'fixture',sheet:'s',sheet_title:'s',content_version:version,structure_version:1,headers:['值'],writable:true,readonly_columns:[],column_widths:{},total_rows:6,rows:p.row_ids?rows.filter(r=>p.row_ids.includes(r.row_id)):rows});
  if(path.includes('sheet_cells_write')){writes.push(p);return reply({result:{content_version:++version,structure_version:1,applied:p.cells.length,cells:p.cells.map((c:any)=>({...c,before:{type:'text',value:'before'},after:c.value}))}});}
  // ★ 合并说明（2026-10-21）：合并后 backend 的粘贴回执**要完整性校验** ——
  //   回执里必须带 `table`（对得上这张表）、整数版本号、逐格回包，缺一项就当「没核实」。
  //   真实服务端 `_write_range` 本来就回表信息，我们这条线的回执契约一直要求表对得上
  //   ⇒ 这里把 `table` 补进 mock（**不是**放宽生产代码的校验）。
  if(path.includes('sheet_paste_apply')){writes.push(p);return reply({result:{table:'fixture',content_version:++version,structure_version:2,rows_added:1,cols_added:0,row_ids:['new'],headers:['值'],cells:[]}});}
  throw Error(path);
 };
 try{const table=await openTable('fixture',undefined,'xlsx');await table.loadPersonalView!();assert.deepEqual((await table.loadPage(1,100)).rows.map(r=>r.name),['r4','r1']);assert.equal(await table.findRowPage('r3',100),-1);
  await table.savePersonalView!(view as any);assert.equal(saved[0].expected_revision,2);assert.equal(saved[0].expected_structure_version,1);
  await table.pasteApply!({startRow:0,startCol:0,matrix:[['first'],['second']],opId:'visible'});assert.deepEqual(writes[0].cells.map((c:any)=>c.row_id),['r4','r1']);
  await table.pasteApply!({startRow:1,startCol:0,matrix:[['last'],['new']],extend:true,opId:'append'});assert.deepEqual(writes[1].target_row_ids,['r1',null]);assert.equal(writes[1].append_at_end,true);
 }finally{globalThis.fetch=original;}
});
