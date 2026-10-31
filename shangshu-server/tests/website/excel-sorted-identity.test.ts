import test from 'node:test';
import assert from 'node:assert/strict';
import {openTable} from '../../../shangshu-web/js/domains/excel-univer/src/backend.ts';

test('sorted pagination and cross-page paste preserve row identity', async () => {
 const original=globalThis.fetch,writes:any[]=[],heightWrites:any[]=[],expansions:any[]=[];let version=1;
 const rows=Array.from({length:205},(_,i)=>({row_id:`r-${i}`,row_index:i+2,values:{值:{type:'text',value:String(i)}}}));
 globalThis.fetch=async(url:any,init:any)=>{
  const path=String(url),p=init?.body?JSON.parse(init.body).payload:JSON.parse(new URL(path,'http://test').searchParams.get('payload')||'{}');
  const reply=(body:any)=>new Response(JSON.stringify(body),{status:200});
  if(path==='/api/platform/objects')return reply({list:[]});
  if(path.includes('files.sheet_sort')){assert.equal(p.identity_only,true);return reply({ok:true,result:{rows:[...rows].reverse().map(({row_id,row_index})=>({row_id,row_index})),total_rows:205,content_version:version,structure_version:1}});}
  if(path.includes('files.sheet_read'))return reply({ok:true,table:'fixture',table_title:'fixture',sheet:'s',sheet_title:'s',content_version:version,structure_version:1,headers:['值'],writable:true,readonly_columns:[],column_widths:{},total_rows:205,rows:p.row_ids?rows.filter(r=>p.row_ids.includes(r.row_id)):rows.slice((p.page-1)*p.page_length,p.page*p.page_length)});
  if(path.includes('files.sheet_row_heights_write')){heightWrites.push(p);version++;return reply({ok:true,result:{applied:true,content_version:version,structure_version:1}});}
  // ★ 合并说明（2026-10-21）：合并后 backend 的粘贴回执**要完整性校验** ——
  //   回执里必须带 `table`（对得上这张表）、整数版本号、逐格回包，缺一项就当「没核实」。
  //   真实服务端 `_write_range` 本来就回表信息，我们这条线的回执契约一直要求表对得上
  //   ⇒ 这里把 `table` 补进 mock（**不是**放宽生产代码的校验）。
  if(path.includes('files.sheet_paste_apply')){expansions.push(p);version++;return reply({ok:true,result:{table:'fixture',content_version:version,structure_version:2,rows_added:1,cols_added:0,row_ids:['r-new'],headers:['值'],cells:[]}});}
  if(path.includes('files.sheet_cells_write')){writes.push(p);version++;return reply({ok:true,result:{content_version:version,structure_version:1,applied:p.cells.length,cells:p.cells.map((c:any)=>({...c,before:{type:'text',value:'old'},after:c.value}))}});}
  throw Error('Unexpected request '+path);
 };
 try{
  const table=await openTable('fixture',undefined,'xlsx');await table.sort!({column:'值',direction:'desc'});
  const first=await table.loadPage(1,100),second=await table.loadPage(2,100);
  assert.equal(first.rows[0].name,'r-204');assert.equal(first.rows[99].name,'r-105');
  assert.equal(second.rows[0].name,'r-104');assert.equal(second.rows[99].name,'r-5');
  assert.equal(await table.findRowPage('r-4',100),3);
  const saved=await table.pasteApply!({startRow:99,startCol:0,matrix:[['00123'],['next']],opId:'paste-one'});
  assert.equal(writes.length,1);assert.deepEqual(writes[0].cells.map((c:any)=>c.row_id),['r-105','r-104']);
  assert.equal(writes[0].op_id,'paste-one');assert.equal(writes[0].cells[0].value.value,'00123');assert.equal(saved.cells[0].rowId,'r-105');
  await table.writeRowHeights!({0:40,100:60},'height-one');
  assert.deepEqual(heightWrites[0].row_heights,{'206':30,'106':45});
  await table.pasteApply!({startRow:204,startCol:0,matrix:[['old-last'],['new']],extend:true,opId:'extend'});
  assert.deepEqual(expansions[0].target_row_ids,['r-0',null]);
  assert.equal(expansions[0].op_id,'extend');assert.equal(expansions.length,1);assert.equal(writes.length,1);
  await table.clearSort!();
  assert.equal((await table.loadPage(1,100)).rows[0].name,'r-0');
 }finally{globalThis.fetch=original;}
});
