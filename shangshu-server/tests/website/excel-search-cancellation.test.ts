import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './excel-mount-harness.ts';

test('表内新搜索与清空中止旧读，不重建表格，取消不显示查询失败',async()=>{
  const h=setup(),pending:Array<{term:string;signal:AbortSignal;resolve:(value:any)=>void}>=[];
  const open=h.context.openTable;
  h.context.openTable=async(key:string)=>{
    const table=await open(key);
    table.search=(term:string,_limit:number,_page:number,signal:AbortSignal)=>new Promise((resolve,reject)=>{
      pending.push({term,signal,resolve});
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
    return table;
  };
  try{
    await h.mountPage();
    const input=h.host.querySelector('[data-search-input]') as HTMLInputElement;
    const Event=h.context.window.Event;
    input.value='甲';input.dispatchEvent(new Event('input'));
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(pending.length,1);
    input.value='乙';input.dispatchEvent(new Event('input'));
    assert.equal(pending[0].signal.aborted,true);
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(pending.length,2);
    input.value='';input.dispatchEvent(new Event('input'));
    assert.equal(pending[1].signal.aborted,true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.grids.length,1,'搜索不重新创建Univer网格');
    assert.doesNotMatch(h.host.querySelector('[data-search-count]')?.textContent||'',/查询失败/);
  }finally{h.close();}
});
