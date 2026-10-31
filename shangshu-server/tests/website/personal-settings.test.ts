import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const web=new URL('../../../shangshu-web/',import.meta.url);
test('个人设置属于公共已实现页，员工可进入但账号管理仍被拒绝',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window as any;
  try{w.eval(readFileSync(new URL('js/page-registry.js',web),'utf8'));for(const role of ['staff','manager','finance']){assert.equal(w.shangshuResolvePlatformPage('personal-settings',role),'personal-settings');assert.equal(w.shangshuResolvePlatformPage('accounts',role),null);}
    assert.match(readFileSync(new URL('js/app.js',web),'utf8'),/id: 'personal-settings'.*accountMenu: true/);
  }finally{dom.window.close();}
});
test('个人设置只读自己的会话，安全文本显示姓名，不调用管理员接口',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window as any,calls:string[]=[],routes:string[]=[];
  w.RENDER={};w.accountMenuModules=()=>[{id:'personal-settings',name:'个人设置'},{id:'mail-settings',name:'邮箱设置'}];w.go=(id:string)=>routes.push(id);
  w.fetch=async(url:string)=>{calls.push(url);return {ok:true,json:async()=>({authed:true,user:{display_name:'<img src=x>',role:'staff',username:'uuid-key'},platform:{mode:'frappe',user_name:'worker@example.invalid',enterprise:{name:'企业甲'}}})};};
  try{for(const file of ['tool-workspace','personal-settings'])w.eval(readFileSync(new URL(`js/${file}.js`,web),'utf8'));
    await w.mountPersonalSettings(w.document.querySelector('main'));assert.deepEqual(calls,['/api/session']);assert.equal(w.document.querySelector('img'),null);assert.match(w.document.body.textContent,/worker@example.invalid/);assert.doesNotMatch(w.document.body.textContent,/uuid-key/);
    w.document.querySelector('[data-setting="mail-settings"]').click();assert.deepEqual(routes,['mail-settings']);assert.match(w.document.body.textContent,/系统管理员.*重置/);
  }finally{dom.window.close();}
});
