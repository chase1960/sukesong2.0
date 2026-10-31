import test from 'node:test';
import assert from 'node:assert/strict';
import {withFrappeUpstream} from '../helpers/frappe-upstream.ts';

test('单对象读口按精确ID转发，保留companion；拒绝和不存在不读取全目录或文件', async()=>{
  const method='shangshu_core.public_api.http.object_definition';
  await withFrappeUpstream(async(base,seen)=>{
    const id='orders.order';
    const response=await fetch(`${base}/api/platform/objects/${encodeURIComponent(id)}`,{headers:{cookie:'sid=test-employee'}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,object:{id,fields:[],companion:{object_id:id,file_id:'source-file'}}});
    for(const [target,status] of [['denied',403],['missing',404]] as const){
      const result=await fetch(`${base}/api/platform/objects/${target}`);
      assert.equal(result.status,status);assert.equal((await result.json()).ok,false);
    }
    assert.deepEqual(seen.filter(item=>!item.endsWith('.session')&&!item.endsWith('.people')),[`GET ${method}`,`GET ${method}`,`GET ${method}`]);
  },(name,_body,url)=>{
    if(name!==method)return undefined;
    const id=new URL(url,'http://local').searchParams.get('object_id');
    assert.equal(id,'orders.order');
    return {id,fields:[],companion:{object_id:id,file_id:'source-file'}};
  },()=>false,(name,_body,url)=>{
    if(name!==method)return null;
    const id=new URL(url,'http://local').searchParams.get('object_id');
    if(id==='denied')return {status:403,payload:{exc_type:'PermissionError',message:'拒绝读取'}};
    if(id==='missing')return {status:404,payload:{exc_type:'DoesNotExistError',message:'对象不存在'}};
    return null;
  });
});
