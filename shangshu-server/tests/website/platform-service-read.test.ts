import test from 'node:test';
import assert from 'node:assert/strict';
import {withFrappeUpstream} from '../helpers/frappe-upstream.ts';

const method='shangshu_core.public_api.http.service_read';
test('registered service GET forwards JSON once without CSRF or POST; keeps original errors',async()=>{
  const payload={row_ids:['r1'],headers:['金额'],search:'A & B'};
  await withFrappeUpstream(async(base,seen)=>{
    const query=new URLSearchParams({payload:JSON.stringify(payload)});
    const response=await fetch(`${base}/api/platform/services/example.rows/invoke?${query}`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,rows:[{row_id:'r1'}]});
    for(const [id,status,message] of [['denied',403,'服务拒绝'],['bad-schema',417,'输入不符合规则']] as const){
      const denied=await fetch(`${base}/api/platform/services/${id}/invoke?payload=%7B%7D`);
      assert.equal(denied.status,status);
      assert.equal((await denied.json()).error,message);
    }
    assert.equal(seen.filter(item=>item===`GET ${method}`).length,3);
    assert.equal(seen.filter(item=>item.startsWith('POST ')||item.endsWith('.csrf')).length,0);
  },(name,_body,url)=>{
    if(name!==method)return undefined;
    const values=new URL(url,'http://local').searchParams;
    assert.equal(values.get('service_id'),'example.rows');
    assert.deepEqual(JSON.parse(values.get('payload')||''),payload);
    return {rows:[{row_id:'r1'}]};
  },()=>false,(name,_body,url)=>{
    if(name!==method)return null;
    const id=new URL(url,'http://local').searchParams.get('service_id');
    if(id==='denied')return {status:403,payload:{exc_type:'PermissionError',message:'服务拒绝'}};
    if(id==='bad-schema')return {status:417,payload:{exc_type:'ValidationError',message:'输入不符合规则'}};
    return null;
  });
});

test('cancelled service GET closes upstream request without retrying as POST',{timeout:8000},async()=>{
  let started!:()=>void,closed!:(finished:boolean)=>void;
  const upstreamStarted=new Promise<void>(resolve=>{started=resolve;});
  const upstreamClosed=new Promise<boolean>(resolve=>{closed=resolve;});
  await withFrappeUpstream(async(base,seen)=>{
    const control=new AbortController();
    const request=fetch(`${base}/api/platform/services/example.slow/invoke?payload=%7B%7D`,{signal:control.signal});
    const cancelled=assert.rejects(request);
    await upstreamStarted;
    control.abort();
    await cancelled;
    assert.equal(await upstreamClosed,false,'client cancellation must close upstream before a normal finish');
    assert.deepEqual(seen,[`GET ${method}`]);
  },()=>undefined,(name,_url,res)=>{
    if(name!==method)return false;
    const watchdog=setTimeout(()=>res.end(JSON.stringify({message:{late:true}})),1500);
    res.once('close',()=>{clearTimeout(watchdog);closed(res.writableEnded);});
    started();
    return true;
  });
});

test('500-row bounded read selects POST before the encoded upstream line is too large',async()=>{
  const payload={table:'TABLE-1',row_ids:Array.from({length:500},(_,i)=>`r${String(i).padStart(4,'0')}`),headers:['金额','备注']};
  await withFrappeUpstream(async(base,seen)=>{
    const response=await fetch(`${base}/api/platform/services/files.sheet_read/invoke?${new URLSearchParams({payload:JSON.stringify(payload)})}`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,rows:[{row_id:'r0000'}]});
    assert.deepEqual(seen.filter(item=>item.endsWith('.service_read')),[`POST ${method}`]);
    assert.equal(seen.filter(item=>item.endsWith('.csrf')).length,1);
    assert.ok(!seen.some(item=>item.endsWith('.service_invoke')));
  },(name,body,url)=>{
    if(name!==method)return undefined;
    assert.equal(new URL(url,'http://local').search,'');
    assert.deepEqual(JSON.parse((body as any).payload),payload);
    return {rows:[{row_id:'r0000'}]};
  },(name,url,res)=>{
    if(name===method&&Buffer.byteLength(url)>4094){res.statusCode=400;res.end('Request Line too large');return true;}
    return false;
  });
});

test('service read transport uses encoded URL bytes at 3000, not raw JSON length',async()=>{
  await withFrappeUpstream(async(base,seen)=>{
    const upstreamUrl=(payload:string)=>`${process.env.FRAPPE_UPSTREAM}/api/method/${method}?${new URLSearchParams({service_id:'example.rows',payload})}`;
    for(const length of [3000,3001]){
      const empty=JSON.stringify({text:''});
      const payload=JSON.stringify({text:'a'.repeat(length-Buffer.byteLength(upstreamUrl(empty)))});
      assert.equal(Buffer.byteLength(upstreamUrl(payload)),length);
      const before=seen.length;
      const response=await fetch(`${base}/api/platform/services/example.rows/invoke?${new URLSearchParams({payload})}`);
      assert.equal(response.status,200);
      assert.deepEqual(seen.slice(before).filter(item=>item.endsWith('.service_read')),[`${length===3000?'GET':'POST'} ${method}`]);
    }
    const payload=JSON.stringify({text:'中'.repeat(400)});
    assert.ok(Buffer.byteLength(payload)<3000);
    assert.ok(Buffer.byteLength(upstreamUrl(payload))>3000);
    const before=seen.length;
    assert.equal((await fetch(`${base}/api/platform/services/example.rows/invoke?${new URLSearchParams({payload})}`)).status,200);
    assert.deepEqual(seen.slice(before).filter(item=>item.endsWith('.service_read')),[`POST ${method}`]);
  },name=>name===method?{rows:[]}:undefined);
});

test('long read permission and schema failures return once without GET or invoke retry',async()=>{
  const payload=JSON.stringify({text:'中'.repeat(400)});
  await withFrappeUpstream(async(base,seen)=>{
    for(const [id,status,message] of [['denied',403,'服务拒绝'],['bad-schema',417,'输入不符合规则']] as const){
      const before=seen.length;
      const response=await fetch(`${base}/api/platform/services/${id}/invoke?${new URLSearchParams({payload})}`);
      assert.equal(response.status,status);assert.equal((await response.json()).error,message);
      const calls=seen.slice(before);
      assert.deepEqual(calls.filter(item=>item.endsWith('.service_read')),[`POST ${method}`]);
      assert.equal(calls.filter(item=>item.endsWith('.csrf')).length,1);
      assert.ok(!calls.some(item=>item.endsWith('.service_invoke')));
    }
  },()=>undefined,()=>false,(name,body,url)=>{
    if(name!==method)return null;
    const id=(body as any)?.service_id||new URL(url,'http://local').searchParams.get('service_id');
    return id==='denied'?{status:403,payload:{exc_type:'PermissionError',message:'服务拒绝'}}:
      {status:417,payload:{exc_type:'ValidationError',message:'输入不符合规则'}};
  });
});

test('cancelled long service POST keeps read cancellation and never retries',{timeout:8000},async()=>{
  let started!:()=>void,closed!:(finished:boolean)=>void;
  const upstreamStarted=new Promise<void>(resolve=>{started=resolve;});
  const upstreamClosed=new Promise<boolean>(resolve=>{closed=resolve;});
  await withFrappeUpstream(async(base,seen)=>{
    const control=new AbortController(),payload=JSON.stringify({text:'中'.repeat(400)});
    const request=fetch(`${base}/api/platform/services/example.slow/invoke?${new URLSearchParams({payload})}`,{signal:control.signal});
    const cancelled=assert.rejects(request);
    await upstreamStarted;control.abort();await cancelled;
    assert.equal(await upstreamClosed,false);
    assert.deepEqual(seen.filter(item=>item.endsWith('.service_read')),[`POST ${method}`]);
    assert.equal(seen.filter(item=>item.endsWith('.csrf')).length,1);
  },()=>undefined,(name,_url,res)=>{
    if(name!==method)return false;
    const watchdog=setTimeout(()=>res.end(JSON.stringify({message:{late:true}})),1500);
    res.once('close',()=>{clearTimeout(watchdog);closed(res.writableEnded);});started();return true;
  });
});
