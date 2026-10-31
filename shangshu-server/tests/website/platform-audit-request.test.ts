import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createPlatformChatBridge} from '../../src/adapters/web/platform.ts';
test('公共工具HTTP使用服务器运行时request id，模型payload里的同名值不能成为幂等键',async()=>{
 const posted:any[]=[];const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');
 if(req.method==='POST'){let body='';for await(const part of req)body+=part;posted.push(JSON.parse(body));res.end(JSON.stringify({message:{id:'P',capability:'mail.draft',entity_type:'draft',entity_id:'D'}}));return;}
 res.end(JSON.stringify({message:req.url?.includes('csrf')?{csrf_token:'test'}:[{id:'mail.draft',executable:true,effect:'write',confirmation:'required',input_schema:{type:'object',properties:{subject:{type:'string'}}}}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const previous=process.env.FRAPPE_UPSTREAM;process.env.FRAPPE_UPSTREAM=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const bridge=await createPlatformChatBridge({headers:{cookie:'sid=test'}} as any);const def=bridge.toolDefs.find(d=>d.capability==='mail.draft')!;
 assert.ok(!JSON.stringify(def.parameters).includes('requestId'));
 const call={id:'call',type:'function' as const,function:{name:def.name,arguments:JSON.stringify({subject:'draft',request_id:'model-forged'})}};
 await bridge.toolExecutor(def,call,{}, {requestId:'server-durable-id'});
 assert.equal(posted.length,1);assert.equal(posted[0].idempotency_key,'server-durable-id');assert.equal(posted[0].payload.request_id,'model-forged');
 }finally{if(previous===undefined)delete process.env.FRAPPE_UPSTREAM;else process.env.FRAPPE_UPSTREAM=previous;await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
