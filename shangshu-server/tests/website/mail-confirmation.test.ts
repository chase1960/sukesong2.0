import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../../../shangshu-web/js/mail-center.js',import.meta.url),'utf8');
const mail={name:'m1',status:'Draft',record_version:2,subject:'报价确认',body:'数量 20\n请确认交期',to:['factory@example.invalid'],cc:[],attachments:[{file:'f1',name:'报价.txt',label:'第 2 版'}]};
function setup(handler:(url:string,p:any)=>any){
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window as any;
  w.RENDER={};w.fetch=async(url:string,options:any)=>({ok:true,json:async()=>handler(url,JSON.parse(options.body||'{}').payload)});
  w.eval(source);return {presenters:w.shangshuConfirmationPresenters,close:()=>dom.window.close()};
}
it('邮件发送卡全局注册，确认前只读取完整草稿和发件账号',async()=>{
  const reads:string[]=[];const t=setup((url)=>{reads.push(url);return {result:url.includes('account.status')?{account:{bound:true,enabled:true,connection_status:'connected',email:'sender@qq.com'}}:{mail}};});
  try{const result=await t.presenters['mail.send'].prepare({payload:{mail:'m1',expected_version:2}});
    assert.match(result.lines.join('\n'),/factory@example.invalid/);assert.match(result.lines.join('\n'),/数量 20/);assert.match(result.lines.join('\n'),/报价.txt.*第 2 版/);assert.match(result.lines.join('\n'),/sender@qq.com/);
    assert.ok(reads.every(url=>url.includes('/services/')));
  }finally{t.close();}
});
it('版本变化、发送中、未知结果、无权读取均禁止邮件发送确认',async()=>{
  for(const bad of [{...mail,record_version:3},{...mail,status:'Sending'},{...mail,status:'Unknown'},null]){
    const t=setup(()=>({result:{mail:bad}}));try{await assert.rejects(()=>t.presenters['mail.send'].prepare({payload:{mail:'m1',expected_version:2}}));}finally{t.close();}
  }
});
it('Agent发送共享草稿核对正式所属邮箱，不借用个人账号身份或连接状态',async()=>{
 const shared={...mail,mailbox_id:'shared-box'},box={id:'shared-box',email:'department@example.invalid',enabled:true,connection_status:'connected',rights:{read:true,send:true}};
 const reads:string[]=[];const t=setup(url=>{reads.push(url);return {result:url.includes('mail.mailboxes')?{mailboxes:[box]}:url.includes('account.status')?{account:{bound:false}}:{mail:shared}};});
 try{const result=await t.presenters['mail.send'].prepare({payload:{mail:shared.name,expected_version:2}});assert.match(result.lines.join('\n'),/发件邮箱：department@example.invalid/);assert.ok(!reads.some(url=>url.includes('account.status')),'共享发件不依赖操作人的个人账号是否连接');}
 finally{t.close();}
});
it('Agent不能确认无代发权、断线或目录缺失的正式邮箱草稿',async()=>{
 for(const box of [null,{id:'shared-box',email:'department@example.invalid',enabled:true,connection_status:'connected',rights:{read:true,send:false}},{id:'shared-box',email:'department@example.invalid',enabled:true,connection_status:'disconnected',rights:{read:true,send:true}}]){
  const t=setup(url=>({result:url.includes('mail.mailboxes')?{mailboxes:box?[box]:[]}:url.includes('account.status')?{account:{bound:true,enabled:true,connection_status:'connected',email:'personal@qq.com'}}:{mail:{...mail,mailbox_id:'shared-box'}}}));
  try{await assert.rejects(()=>t.presenters['mail.send'].prepare({payload:{mail:mail.name,expected_version:2}}));}finally{t.close();}
 }
});
it('发送回执重新读取真实状态，Queued和Unknown不说发送成功，Partial不是全部接受',async()=>{
  for(const status of ['Queued','Sending','Sent','Failed','Unknown','Partial']){
    const t=setup(()=>({result:{mail:{...mail,status}}}));try{const result=await t.presenters['mail.send'].afterExecution({payload:{mail:'m1'}},{result:{status:'Sent'}});
      assert.doesNotMatch(result.title,/发送成功|对方已收到/);assert.equal(result.tone,status==='Sent'?'success':['Failed','Partial'].includes(status)?'error':'pending');
    }finally{t.close();}
  }
});
it('保存草稿卡使用授权文件版本核验附件ID，业务ID或错误固定版本不允许同意',async()=>{
  for(const id of ['fixed-v2','business-file','missing']){
    const t=setup((url,p)=>{assert.match(url,/services\/files.versions/);assert.deepEqual(p,{attachment:id});return {result:{file:{file_name:'报价.txt'},versions:[{frappe_file:'fixed-v2',version_no:2}]}};});
    try{const proposal={payload:{subject:mail.subject,body:mail.body,to:mail.to,cc:[],attachments:[id],attachment_labels:[{file:id,name:'报价.txt',label:'伪造第 99 版'}]}};
      if(id!=='fixed-v2'){await assert.rejects(()=>t.presenters['mail.save_draft'].prepare(proposal));continue;}
      const result=await t.presenters['mail.save_draft'].prepare(proposal);assert.match(result.lines.join('\n'),/第 2 版/);assert.doesNotMatch(result.lines.join('\n'),/第 99 版/);
    }finally{t.close();}
  }
});
it('合法裸File ID不要求AI猜文件名或labels，精确版本服务是唯一附件显示真相',async()=>{
  const t=setup((url,p)=>{assert.match(url,/files.versions/);assert.deepEqual(p,{attachment:'8516e33645'});return {result:{file:{file_name:'工厂采购单.xlsx'},versions:[{frappe_file:'8516e33645',version_no:3}]}};});
  try{const result=await t.presenters['mail.save_draft'].prepare({payload:{subject:'发给工厂',body:'请查收',to:['factory@example.invalid'],cc:[],attachments:['8516e33645']}});
    assert.match(result.lines.join('\n'),/工厂采购单.xlsx.*第 3 版/);
  }finally{t.close();}
});
it('保存已有草稿校验版本，附件省略则核对原固定附件；保存回执重新读回',async()=>{
  const t=setup(()=>({result:{mail}}));try{const proposal={payload:{mail:'m1',expected_version:2,subject:'新主题',body:mail.body,to:mail.to,cc:[]}};
    const result=await t.presenters['mail.save_draft'].prepare(proposal);assert.match(result.lines.join('\n'),/新主题/);assert.match(result.lines.join('\n'),/报价.txt/);
    const receipt=await t.presenters['mail.save_draft'].afterExecution(proposal,{result:{name:'m1'}});assert.equal(receipt.tone,'success');assert.match(receipt.title,/草稿/);
    await assert.rejects(()=>t.presenters['mail.save_draft'].prepare({payload:{...proposal.payload,expected_version:1}}));
  }finally{t.close();}
});
it('已有草稿修改卡显示真实主题前后差异并绑定公共人工保护事件',async()=>{
  const t=setup(()=>({result:{mail}}));
  try{const result=await t.presenters['mail.save_draft'].prepare({payload:{mail:'m1',expected_version:2,subject:'新主题',body:mail.body,to:mail.to,cc:[]}});
    assert.equal(result.objectId,'mail.message');assert.equal(result.recordName,'m1');
    assert.match(result.title,/报价确认/);assert.match(result.lines.join('\n'),/主题：报价确认 → 新主题/);
  }finally{t.close();}
});
