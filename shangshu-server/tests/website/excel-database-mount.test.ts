import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './excel-mount-harness.ts';

test('没有文件绑定的数据库空表完成挂载，不读取文件晋升服务', async () => {
  const h = setup({empty:true});
  const paths:string[]=[];
  const originalOpen=h.context.openTable;
  h.context.openTable=async(key:string)=>{
    const table=await originalOpen(key);
    table.kind='db';
    table.objectInfo={id:key,fields:[],operations:['read']};
    return table;
  };
  h.context.fetch=async(path:string)=>{
    paths.push(String(path));
    return {ok:true,status:200,json:async()=>({items:[],counts:{Proposed:0},has_more:false})};
  };
  try{
    await h.mountPage();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.context.excelPageDiag().totalRows,0);
    assert.equal((h.host.querySelector('[data-open-loading]') as HTMLElement).hidden,true);
    assert.equal(h.host.getAttribute('aria-busy'),'false');
    assert.equal(paths.some(path=>/files\.promotion_(definition|status)/.test(path)),false,paths.join('\n'));
  }finally{h.close();}
});

test('已知数据库表按列筛选只读取该表定义，不扫描对象目录',async()=>{
  const h=setup(),paths:string[]=[];
  const originalOpen=h.context.openTable,oldFetch=globalThis.fetch;
  const info={id:'one',title:'表一',revision:1,fields:[{id:'C1',label:'字段一',type:'text'}],
    operations:['read'],query:{filterable_fields:['C1']},input_schema:{properties:{}}};
  h.context.openTable=async(key:string)=>{const table=await originalOpen(key);table.kind='db';table.objectInfo=info;return table;};
  globalThis.fetch=async(path)=>{
    paths.push(String(path));
    if(String(path)==='/api/platform/actions')return Response.json({list:[]});
    if(String(path)==='/api/platform/objects/one')return Response.json({object:info});
    throw Error('不应读取：'+path);
  };
  try{
    await h.mountPage();
    const button=h.host.querySelector('[data-db-filter]') as HTMLButtonElement;
    assert.equal(button.disabled,false);
    button.click();await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(paths.includes('/api/platform/objects/one'));
    assert.equal(paths.includes('/api/platform/objects'),false);
  }finally{h.close();globalThis.fetch=oldFetch;}
});
