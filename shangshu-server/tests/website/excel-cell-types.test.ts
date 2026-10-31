import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toTypedValue,pasteValueTypes,createXlsxTable} from '../../../shangshu-web/js/domains/excel-univer/src/backend.ts';
test('清空数值和日期不会变成0或无效日期，文本前导零保留',()=>{
 assert.deepEqual(toTypedValue('decimal',''),{type:'empty',value:null});
 assert.deepEqual(toTypedValue('date',''),{type:'empty',value:null});
 assert.deepEqual(toTypedValue('text','00123'),{type:'text',value:'00123'});
 assert.throws(()=>toTypedValue('decimal','不是数字'),/数字/);
});
test('粘贴502后的同编号重试冻结原矩阵和版本，不拿后来输入另写',async()=>{
 const original=globalThis.fetch,bodies:string[]=[];
 try{
   const table=createXlsxTable({tableId:'f1',sheetId:'S-1',title:'test',columns:[{header:'金额',type:'decimal',readOnly:false}],
     contentVersion:1,structureVersion:1,writable:true,columnWidths:{}} as any);
   globalThis.fetch=async(_url:any,init:any)=>{bodies.push(init.body);
     return bodies.length===1?Response.json({ok:false},{status:502}):Response.json({ok:true,result:{table:'f1',content_version:2,structure_version:1,
       action_count:1,rows_added:0,cols_added:0,cells:[]}});
   };
   const request={startRow:0,startCol:0,matrix:[['2']],opId:'same-paste',extend:false};
   await assert.rejects(table.pasteApply(request),/未知/);request.matrix[0][0]='999';
   await table.pasteApply(request);assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[1]).payload.matrix[0][0],'2');
 }finally{globalThis.fetch=original;}
});
test('粘贴按已有列约束提供类型，空值不推为零，新文字列不丢前导零',()=>{
 assert.deepEqual(pasteValueTypes([['','00123','false','2026-10-20','18.5']],0,
   [{type:'decimal'},{type:'text'},{type:'boolean'},{type:'date'},{type:'decimal'}]),
   [['empty','text','boolean','date','number']]);
});
