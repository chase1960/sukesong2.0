import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function mount(handler:(id:string,payload:any)=>any){
  const dom=new JSDOM('<div id="host" class="main-scroll"></div>',{url:'http://localhost/#/mail-settings',runScripts:'outside-only'});
  const w=dom.window as any;w.RENDER={};w.shangshuRegisterPages=()=>({ok:true});
  /* 归属是**公共组件**；mail-settings.js 是经典脚本，JSDOM 里没法 dynamic import
     浏览器路径 —— 按公共件留的口子把同一件组件注入进去。 */
  w.mountResourceAttribution=(await import('../../../shangshu-web/js/resource-attribution.mjs')).mountResourceAttribution;
  w.fetch=async(url:string,options:any)=>{const data=await handler(url,JSON.parse(options.body).payload);return {ok:!data.error,status:data.error?400:200,json:async()=>data};};
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for(const file of ['tool-workspace.js','domains/mail/mail-settings.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+file,import.meta.url),'utf8'));
  const dispose=await w.mountMailSettings(w.document.querySelector('#host'));
  return {w,dispose:()=>{dispose();dom.window.close();}};
}
function input(w:any,id:string,value:string){const el=w.document.querySelector(id);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));}

it('员工邮箱设置自动识别QQ，测试并保存只经本人Action，保存后凭据不回显',async()=>{
  const writes:any[]=[];
  const t=await mount((id,payload)=>{if(id.includes('/services/'))return {result:{account:{bound:false}}};writes.push({id,payload});return {result:{account:{bound:true,email:payload.email,provider:payload.provider,enabled:true,connection_status:'connected'}}};});
  try{await tick();input(t.w,'#mail-account-email','demo@qq.com');input(t.w,'#mail-account-password','test-authorization');
    assert.equal(t.w.document.querySelector('#mail-account-provider').value,'qq');
    assert.equal(t.w.document.querySelector('#mail-account-password').type,'password');
    t.w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(writes.length,1);assert.match(writes[0].id,/mail.account.configure/);assert.equal(writes[0].payload.password,'test-authorization');
    assert.equal(t.w.document.querySelector('#mail-account-password').value,'');
    assert.doesNotMatch(t.w.document.body.innerHTML,/test-authorization/);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),true);
  }finally{t.dispose();}
});

it('测试保存失败保留输入并阻止离页；不把错误原文或密钥展示给AI与用户',async()=>{
  const t=await mount(id=>id.includes('/services/')?{result:{account:{bound:false}}}:{error:'授权失败'});
  try{await tick();input(t.w,'#mail-account-email','demo@163.com');input(t.w,'#mail-account-password','keep-secret');
    t.w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(t.w.document.querySelector('#mail-account-password').value,'keep-secret');
    assert.match(t.w.document.querySelector('#mail-account-result').textContent,/未保存/);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    assert.doesNotMatch(t.w.document.body.innerHTML,/keep-secret/);
  }finally{t.dispose();}
});

it('暂停与解除分别走本人账户动作，解除明确二次确认且不删除历史邮件',async()=>{
  const writes:any[]=[];let account:any={bound:true,email:'demo@qq.com',provider:'qq',enabled:true,connection_status:'connected'};
  const t=await mount((id,payload)=>{if(id.includes('/services/'))return {result:{account}};writes.push({id,payload});account=id.includes('disconnect')?{bound:false}:{...account,enabled:payload.enabled};return {result:{account}};});
  try{await tick();t.w.document.querySelector('#mail-account-toggle').click();await tick();assert.equal(writes[0].payload.enabled,false);
    t.w.document.querySelector('#mail-account-disconnect').click();assert.equal(writes.length,1);
    /* 二次确认弹窗走公共壳的 modal：容器类名跟着 prefix 走（默认 'os' → .os-overlay/.os-dialog，
       邮件页显式传 'mail' → .mail-overlay/.mail-dialog）。这里按「装着这个确认按钮的那扇窗」找，
       不钉类名 —— 钉类名会在换前缀时假红，而意图是「解绑前弹窗讲清楚历史邮件不删」。 */
    const dlg=t.w.document.querySelector('[role="dialog"]') as any;
    assert.ok(dlg,'点「解除绑定」没弹出二次确认弹窗');
    assert.match(dlg.textContent||'',/历史邮件/,`确认弹窗没讲清历史邮件是否保留：${(dlg.textContent||'').slice(0,120)}`);
    assert.ok(dlg.querySelector('#mail-account-disconnect-confirm'),'确认按钮不在这个弹窗里（弹窗不是它）');
    assert.ok(dlg.querySelector('#mail-account-disconnect-cancel'),'没有「取消」出口，用户退不出这个确认');
    assert.equal(t.w.document.querySelector('#notice'),null,'页面里又贴回了 #notice');
    t.w.document.querySelector('#mail-account-disconnect-confirm').click();await tick();assert.match(writes[1].id,/mail.account.disconnect/);
  }finally{t.dispose();}
});

it('尚未保存的设置可明确放弃，不强迫用户填写可用授权码才能离页',async()=>{
  const t=await mount(()=>({result:{account:{bound:false}}}));
  try{await tick();input(t.w,'#mail-account-email','unfinished@qq.com');input(t.w,'#mail-account-password','discard-me');
    t.w.document.querySelector('#mail-account-reset').click();assert.equal(t.w.document.querySelector('#mail-account-password').value,'discard-me');
    t.w.document.querySelector('#mail-reset-confirm').click();assert.equal(t.w.document.querySelector('#mail-account-password').value,'');
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),true);
  }finally{t.dispose();}
});

it('网易企业邮箱由用户显式选择，自定义域不推断服务商且企业选择不被后缀覆盖',async()=>{
  const writes:any[]=[];
  const t=await mount((id,payload)=>{if(id.includes('/services/'))return {result:{account:{bound:false}}};writes.push(payload);return {result:{account:{...payload,bound:true,connection_status:'connected'}}};});
  try{await tick();input(t.w,'#mail-account-email','demo@company.example');input(t.w,'#mail-account-password','enterprise-test-code');
    const provider=t.w.document.querySelector('#mail-account-provider');assert.equal(provider.value,'');
    t.w.document.querySelector('#mail-account-save').click();await tick();assert.equal(writes.length,0);assert.match(t.w.document.querySelector('#mail-account-result').textContent,/选择.*服务商/);
    provider.value='netease-enterprise';provider.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    assert.match(t.w.document.querySelector('#mail-account-provider-help').textContent,/设置.*账号与安全.*客户端设置.*进入设置/);
    input(t.w,'#mail-account-email','demo@163.com');assert.equal(provider.value,'netease-enterprise');
    input(t.w,'#mail-account-email','demo@company.example');t.w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(writes.length,1);assert.equal(writes[0].provider,'netease-enterprise');assert.equal(writes[0].email,'demo@company.example');
    assert.equal(t.w.document.querySelector('#mail-account-password').value,'');
  }finally{t.dispose();}
});

it('加载已绑定的网易企业邮箱消费服务商目录，正确回显选择但从不回显授权码',async()=>{
  const account={bound:true,provider:'netease-enterprise',email:'staff@company.example',display_name:'同事',enabled:true};
  const t=await mount(()=>({result:{account,providers:[{id:'qq',label:'QQ 邮箱'},{id:'163',label:'网易 163 邮箱'},{id:'netease-enterprise',label:'网易企业邮箱'}]}}));
  try{await tick();assert.equal(t.w.document.querySelector('#mail-account-provider').value,'netease-enterprise');
    assert.match(t.w.document.querySelector('#mail-account-provider').textContent,/网易企业邮箱/);
    assert.match(t.w.document.querySelector('#mail-account-provider-help').textContent,/IMAP\/SMTP.*授权码/);
    assert.equal(t.w.document.querySelector('#mail-account-password').value,'');
    input(t.w,'#mail-account-email','changed@qq.com');assert.equal(t.w.document.querySelector('#mail-account-provider').value,'netease-enterprise');
  }finally{t.dispose();}
});

it('企业邮箱节点从服务商目录显式选择，不自动切换机房或试用其他节点',async()=>{
  const writes:any[]=[];
  const providers=[{id:'netease-enterprise',label:'网易企业邮箱（北京）'},{id:'netease-enterprise-hz',label:'网易企业邮箱（杭州）'}];
  const t=await mount((id,payload)=>{if(id.includes('/services/'))return {result:{account:{bound:false},providers}};writes.push(payload);return {error:'测试连接未通过'};});
  try{await tick();const select=t.w.document.querySelector('#mail-account-provider');assert.match(select.textContent,/北京/);assert.match(select.textContent,/杭州/);
    input(t.w,'#mail-account-email','staff@company.example');select.value='netease-enterprise-hz';select.dispatchEvent(new t.w.Event('change'));
    input(t.w,'#mail-account-password','only-this-node');t.w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(writes.length,1);assert.equal(writes[0].provider,'netease-enterprise-hz');assert.equal(select.value,'netease-enterprise-hz');
    assert.match(t.w.document.querySelector('#mail-account-provider-help').textContent,/客户端设置/);
    assert.equal(t.w.document.querySelector('#mail-account-password').value,'only-this-node');
  }finally{t.dispose();}
});


// ── G2：建部门邮箱的入口（任务范围「共享邮箱」那条）────────────────────────
// 「两个员工用各自账号进入同一个部门邮箱」—— 进入那半（N5）有了，
// 建/绑这半要有表单入口，不能只靠测试直插行。
it('表单有「归属」，选部门邮箱时填所属部门，提交带 kind/department',async()=>{
  const writes:any[]=[];
  const t=await mount((id,payload)=>{
    if(id.includes('/services/'))return {result:{account:{bound:false}}};
    writes.push({id,payload});
    return {result:{account:{bound:true,email:payload.email,provider:payload.provider,
      kind:payload.kind,department:payload.department,enabled:true,connection_status:'connected'}}};
  });
  try{await tick();
    const w=t.w;
    assert.ok(w.document.querySelector('#mail-account-kind'),'表单里没有「归属」这一项');
    assert.ok(w.document.querySelector('#mail-account-department'),'表单里没有「所属部门」这一项');
    // 选「部门邮箱」后所属部门才要求填
    input(w,'#mail-account-email','shared@qq.com');input(w,'#mail-account-password','stub-pass');
    const kind=w.document.querySelector('#mail-account-kind');
    kind.value='department';kind.dispatchEvent(new w.Event('input',{bubbles:true}));
    kind.dispatchEvent(new w.Event('change',{bubbles:true}));
    await tick();
    w.document.querySelector('#mail-account-save').click();await tick();
    // 没填部门就**别提交**，就地提示 —— 比交上去让后端拒好（用户看得懂为什么）
    assert.equal(writes.length,0,'没填部门不该提交');
    assert.match(w.document.querySelector('#mail-account-result').textContent,/所属部门/,'没填部门该提示');
    // 填上部门再交
    input(w,'#mail-account-department','市场部');
    w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(writes.length,1,'填了部门才该提交（第一次被挡住了，所以总共 1 条）');
    assert.equal(writes[0].payload.kind,'department');
    assert.equal(writes[0].payload.department,'市场部');
  }finally{t.dispose();}
});

it('已绑定的部门箱打开设置页要回填归属，不许被默认成个人箱',async()=>{
  // 投影带 kind/department 时表单得显出来 —— 不显的话一保存就把部门箱
  // 静默改回个人箱，是最糟的那种改坏（改完没有任何提示）。
  const t=await mount(id=>id.includes('/services/')
    ? {result:{account:{bound:true,email:'shared@qq.com',provider:'qq',
        kind:'department',department:'市场部',enabled:true,connection_status:'connected'}}}
    : {result:{account:{bound:true}}});
  try{await tick();
    const w=t.w;
    assert.equal(w.document.querySelector('#mail-account-kind').value,'department','归属没回填成部门邮箱');
    assert.equal(w.document.querySelector('#mail-account-department').value,'市场部','所属部门没回填');
  }finally{t.dispose();}
});

it('个人箱不填所属部门；老口径（不选归属）仍是个人箱',async()=>{
  const writes:any[]=[];
  const t=await mount((id,payload)=>{
    if(id.includes('/services/'))return {result:{account:{bound:false}}};
    writes.push({id,payload});
    return {result:{account:{bound:true,email:payload.email,provider:payload.provider,enabled:true}}};
  });
  try{await tick();
    const w=t.w;
    input(w,'#mail-account-email','me@qq.com');input(w,'#mail-account-password','stub-pass');
    // 不动「归属」，直接提交 —— 老调用照旧
    w.document.querySelector('#mail-account-save').click();await tick();
    assert.equal(writes.length,1);
    assert.equal(writes[0].payload.kind,'personal','不选归属默认是个人邮箱');
  }finally{t.dispose();}
});
