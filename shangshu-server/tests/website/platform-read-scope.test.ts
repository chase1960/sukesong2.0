import test from 'node:test';
import assert from 'node:assert/strict';
import {withFrappeUpstream} from '../helpers/frappe-upstream.ts';

test('公共记录查询传递行页、字段和范围，不改写搜索条件或附带全目录读取', async()=>{
  const method='shangshu_core.public_api.http.object_records';
  const filters={$search:'客户%_', $sort:'title', $direction:'asc'};
  const fields=['title'];
  const readScope={mode:'query',purpose:'interactive'};
  await withFrappeUpstream(async(base,seen)=>{
    const query=new URLSearchParams({filters:JSON.stringify(filters),fields:JSON.stringify(fields),
      read_scope:JSON.stringify(readScope),include_definition:'0',page:'2',page_length:'20'});
    const response=await fetch(`${base}/api/platform/objects/test.object/records?${query}`);
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).rows,[{name:'row-21',modified:'v1',title:'客户'}]);
    assert.deepEqual(seen.filter(item=>item.includes('object_')),['GET '+method]);
  },(name,_body,url)=>{
    if(name!==method)return undefined;
    const q=new URL(url,'http://local').searchParams;
    assert.equal(q.get('object_id'),'test.object');
    assert.deepEqual(JSON.parse(q.get('filters')!),filters);
    assert.deepEqual(JSON.parse(q.get('fields')!),fields);
    assert.deepEqual(JSON.parse(q.get('read_scope')!),readScope);
    assert.equal(q.get('include_definition'),'0');
    assert.equal(q.get('page'),'2');assert.equal(q.get('page_length'),'20');
    return {rows:[{name:'row-21',modified:'v1',title:'客户'}],total:43,page:2,page_length:20};
  });
});

test('对象目录分页回包保留真实total并下推搜索、归属和摘要参数',async()=>{
  const method='shangshu_core.public_api.http.objects';
  await withFrappeUpstream(async(base)=>{
    const q=new URLSearchParams({search:'费用',page:'2',page_length:'20',summary:'1',attribution_level:'personal'});
    const response=await fetch(`${base}/api/platform/objects?${q}`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,list:[{id:'a',title:'费用'}],total:25,page:2,page_length:20});
  },(name,_body,url)=>{
    if(name!==method)return undefined;
    const q=new URL(url,'http://local').searchParams;
    assert.equal(q.get('search'),'费用');assert.equal(q.get('page'),'2');
    assert.equal(q.get('page_length'),'20');assert.equal(q.get('summary'),'1');
    assert.equal(q.get('attribution_level'),'personal');
    return {list:[{id:'a',title:'费用'}],total:25,page:2,page_length:20};
  });
});

test('无来源表格直链按完整身份定位，错误不换存储或遍历目录',async()=>{
  const method='shangshu_core.public_api.http.table_resource';
  await withFrappeUpstream(async(base,seen)=>{
    const response=await fetch(`${base}/api/platform/table-resources/exact-table`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,table:'exact-table',source:'xlsx'});
    const denied=await fetch(`${base}/api/platform/table-resources/denied`);
    assert.equal(denied.status,403);
    assert.deepEqual(seen.filter(item=>!item.endsWith('.session')&&!item.endsWith('.people')),
      ['GET '+method,'GET '+method]);
  },(name,_body,url)=>{
    if(name!==method)return undefined;
    assert.equal(new URL(url,'http://local').searchParams.get('resource_id'),'exact-table');
    return {table:'exact-table',source:'xlsx'};
  },()=>false,(name,_body,url)=>name===method&&new URL(url,'http://local').searchParams.get('resource_id')==='denied'
    ?{status:403,payload:{exc_type:'PermissionError',message:'拒绝读取'}}:null);
});
