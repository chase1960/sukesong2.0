import {test} from 'node:test';
import assert from 'node:assert/strict';
import {xlsxSource} from '../../../shangshu-web/js/domains/excel-univer/src/adapter.ts';
/**
 * ★ 合并说明（2026-10-21）：**下载现在走公共导出通道**（exportCurrentTable），
 *   不再是 fast 那套「自己读一次 files.versions 再下载」。
 *   新契约（导出通道的口径，比旧的更严）：
 *   ① 下载权 = `can_download` **且**文件状态 `Active`；固定引用（frappe_file）拿不到 ⇒ 明确拒；
 *   ② 顺序是「读一次版本 ⇒ 按固定引用取字节 ⇒ **再读一次版本核对**」
 *      （下载期间撤权/换版 ⇒ 不交旧内容）；只发**一次**字节请求。
 *   下面的断言按这条新契约重钉（旧口径「读一次版本 + 一次下载 = 2 个请求」已不成立）。
 */
test('导出先取当前固定文件引用，不发缺file的下载请求',async()=>{
 const original=globalThis.fetch,calls:string[]=[];
 try{
  globalThis.fetch=async(input:any)=>{const url=String(input);calls.push(url);
   if(url.includes('files.versions'))return Response.json({ok:true,file:{name:'file-one',version:3,can_download:true,status:'Active'},
     versions:[{version_no:3,frappe_file:'fixed-v3',source:{ref_doctype:'Shangshu File Center File',ref_name:'file-one',file:'fixed-v3'}}]});
   const q=new URL(url,'http://localhost').searchParams;
   assert.equal(q.get('file'),'fixed-v3','下载请求必须带固定引用，不许缺 file');
   assert.equal(q.get('ref_name'),'file-one','下载请求必须指明是哪张表');
   return new Response('PK-test');
  };
  assert.equal(new TextDecoder().decode(await xlsxSource.download('file-one')),'PK-test');
  // 新契约：读版本 → 下载字节 → **再读一次版本核对**（3 个请求；旧口径是 2 个）。
  assert.equal(calls.length,3);
  assert.equal(calls.filter(url=>url.includes('files.versions')).length,2,'下载前后各核一次版本与权限');
  assert.equal(calls.filter(url=>url.includes('file-content')).length,1,'字节只取一次');
 }finally{globalThis.fetch=original;}
});
test('下载授权撤回或固定引用缺失，不请求字节或退回最新版',async()=>{
 const original=globalThis.fetch;
 try{
  // ① 授权撤回（固定引用还在）：导出通道判「没有下载权」⇒ 明确拒，不发字节请求。
  {const calls:string[]=[];
   globalThis.fetch=async(input:any)=>{const url=String(input);calls.push(url);return Response.json({ok:true,file:{name:'file-one',version:3,can_download:false,status:'Active'},versions:[{version_no:3,frappe_file:'fixed-v3'}]});};
   await assert.rejects(xlsxSource.download('file-one'),/权限/);
   assert.equal(calls.length,1,'只读了一次版本元数据，不许发字节请求');
   assert.equal(calls.some(url=>url.includes('file-content')),false,'没有下载权就不许取字节');
  }
  // ② 固定引用缺失：导出通道判「拿不到固定引用」⇒ 明确拒，**不许退回最新版**（旧内容不假称当前）。
  {const calls:string[]=[];
   globalThis.fetch=async(input:any)=>{const url=String(input);calls.push(url);return Response.json({ok:true,file:{name:'file-one',version:3,can_download:true,status:'Active'},versions:[]});};
   await assert.rejects(xlsxSource.download('file-one'),/未导出旧版本/,'缺固定引用时不许退回最新版');
   assert.equal(calls.length,1,'只读了一次版本元数据，不许发字节请求');
   assert.equal(calls.some(url=>url.includes('file-content')),false,'没有固定引用就不许取字节');
  }
 }finally{globalThis.fetch=original;}
});
test('写操作遇到502或不可解析的成功回执属于未知，不能当作明确未写',async()=>{
 const original=globalThis.fetch;
 const args={tableId:'f1',sheetId:'S-1',rowId:'r-000001',header:'金额',value:{type:'number' as const,value:2},expectedContentVersion:1,expectedStructureVersion:1,opId:'one'};
 try{
   globalThis.fetch=async()=>Response.json({ok:false,error:'gateway'},{status:502});
   assert.equal((await xlsxSource.writeCell(args)).kind,'unknown');
   globalThis.fetch=async()=>new Response('broken',{status:200});
   assert.equal((await xlsxSource.writeCell(args)).kind,'unknown');
   globalThis.fetch=async()=>Response.json({ok:true,result:{}});
   assert.equal((await xlsxSource.writeCell(args)).kind,'unknown');
   assert.equal((await xlsxSource.writeLayout({...args,columnWidths:{0:120}})).kind,'unknown');
 }finally{globalThis.fetch=original;}
});
