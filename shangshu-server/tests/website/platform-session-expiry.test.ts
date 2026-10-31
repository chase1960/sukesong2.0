import assert from 'node:assert/strict';
import {after, before, it} from 'node:test';
import {createServer, type Server} from 'node:http';
import {buildApp} from '../../src/adapters/web/server.ts';
import type {ExternalServices} from '../../src/core/types.ts';

let upstream:Server, server:Server, base='';
const oldMode=process.env.SHANGSHU_PLATFORM_MODE, oldUpstream=process.env.FRAPPE_UPSTREAM;
const calls:string[]=[];
before(async()=>{
  upstream=createServer((req,res)=>{
    const method=new URL(req.url!,'http://local').pathname.split('/').at(-1)!;
    const cookie=String(req.headers.cookie||'');calls.push(method+':'+cookie);
    res.setHeader('content-type','application/json');
    if(method.endsWith('.session')){
      if(cookie==='sid=expired'){res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'需要登录'}));return;}
      if(cookie==='sid=offline'){res.statusCode=502;res.end('{}');return;}
      if(cookie==='sid=malformed'){res.end('not-json');return;}
      res.end(JSON.stringify({message:{user_name:'staff@example.test',identity_id:'i1',roles:['Desk User']}}));return;
    }
    if(method.endsWith('.csrf')){res.end(JSON.stringify({message:{csrf_token:'c1'}}));return;}
    if(cookie==='sid=ok'){res.end(JSON.stringify({message:[]}));return;}
    res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'没有权限'}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  process.env.FRAPPE_UPSTREAM=`http://127.0.0.1:${(upstream.address() as any).port}`;
  process.env.SHANGSHU_PLATFORM_MODE='frappe';
  server=buildApp({} as ExternalServices).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as any).port}`;
});
after(async()=>{
  await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);
  if(oldMode===undefined)delete process.env.SHANGSHU_PLATFORM_MODE;else process.env.SHANGSHU_PLATFORM_MODE=oldMode;
  if(oldUpstream===undefined)delete process.env.FRAPPE_UPSTREAM;else process.env.FRAPPE_UPSTREAM=oldUpstream;
});
it('正常应用目录不增加身份探针',async()=>{
  calls.length=0;const response=await fetch(base+'/api/platform/applications',{headers:{cookie:'sid=ok'}});
  assert.equal(response.status,200);assert.equal(calls.filter(c=>c.includes('.session:')).length,0);
});
it('会话失效才返回401，不再把员工留在空白工作台',async()=>{
  const response=await fetch(base+'/api/platform/applications',{headers:{cookie:'sid=expired'}});
  assert.equal(response.status,401);assert.equal((await response.json()).code,'AUTH_REQUIRED');
});
it('有效身份的真正越权仍返回403',async()=>{
  const response=await fetch(base+'/api/platform/applications',{headers:{cookie:'sid=denied'}});
  assert.equal(response.status,403);assert.equal((await response.json()).code,'PERMISSION_DENIED');
});
for(const sid of ['offline','malformed'])it(`身份探针${sid}不能误判登出`,async()=>{
  const response=await fetch(base+'/api/platform/applications',{headers:{cookie:'sid='+sid}});
  assert.equal(response.status,403);
});
it('写动作会话失效返回401且不自动重放写请求',async()=>{
  calls.length=0;
  const response=await fetch(base+'/api/platform/actions/files.edit_cells/execute',{method:'POST',headers:{cookie:'sid=expired','content-type':'application/json'},body:JSON.stringify({payload:{},confirmed:true,idempotency_key:'one-request'})});
  assert.equal(response.status,401);assert.equal(calls.filter(c=>c.includes('.action_execute:')).length,1);
});
it('身份口失效本身直接归为401，没有递归身份探针',async()=>{
  calls.length=0;const response=await fetch(base+'/api/platform/session',{headers:{cookie:'sid=expired'}});
  assert.equal(response.status,401);assert.equal(calls.filter(c=>c.includes('.session:')).length,1);
});
