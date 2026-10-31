import test from 'node:test';import assert from 'node:assert/strict';import {openTable} from '../src/backend.ts';
test('formula input emits formula field; sorted writes preserve same formula and refresh metadata',async()=>{
 const original=globalThis.fetch,requests:any[]=[];let version=2;
 globalThis.fetch=async(url:any,init:any)=>{const path=String(url),payload=init?.body?JSON.parse(init.body).payload:{};const reply=(v:any)=>new Response(JSON.stringify(v));
 if(path==='/api/platform/objects')return reply({list:[]});
 if(path.includes('files.sheet_read'))return reply({ok:true,table:'F',table_title:'F',sheet:'S',sheet_title:'S',content_version:version,structure_version:1,headers:['备注'],writable:true,readonly_columns:[],column_widths:{},total_rows:1,has_formulas:true,rows:[{row_id:'r-1',row_index:2,values:{备注:{type:'formula',formula:'=SUM(B2:B3)',value:30.5,result_version:version}}}]});
 if(path.includes('files.sheet_sort'))return reply({ok:true,result:{rows:[{row_id:'r-1',row_index:2}],total_rows:1,content_version:version,structure_version:1}});
 if(path.includes('files.sheet_input_write')||path.includes('files.sheet_cells_write')){requests.push(payload);version++;const value=payload.value??payload.cells[0].value;return reply({ok:true,result:{has_formulas:true,content_version:version,structure_version:1,headers:['备注'],cells:[{row_id:'r-1',header:'备注',before:{type:'formula',formula:'=SUM(B2:B3)',value:30.5},after:{...value,value:31.5,result_version:version}}]}});}
 throw Error(path);};
 try{const table=await openTable('F',undefined,'xlsx');const opts={startRow:0,startCol:0,matrix:[['=SUM(B2:B3)+1']],matrixTypes:[['formula']],opId:'input-1'};
 const first=await table.inputWrite!(opts);assert.deepEqual(requests[0].value,{type:'formula',formula:'=SUM(B2:B3)+1',value:null});assert.equal(first.hasFormulas,true);
 await table.sort!({column:'备注',direction:'asc'});const second=await table.inputWrite!({...opts,opId:'input-2'});assert.equal(requests[1].cells[0].row_id,'r-1');assert.deepEqual(requests[1].cells[0].value,{type:'formula',formula:'=SUM(B2:B3)+1',value:null});assert.equal(second.hasFormulas,true);
 }finally{globalThis.fetch=original;}
});
