import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('申请表、列表列和审批只修改同一份应用草稿，保留稳定标识',async()=>{
  const dom=new JSDOM('<main><div data-app-pages></div><div data-app-flows></div></main>',{runScripts:'outside-only'});
  const w=dom.window as any;let dialog:any,changes=0;
  Object.assign(w,{esc:(v:any)=>String(v??''),toast:()=>{},openSchemaForm:(value:any)=>{dialog=value;}});
  const application={
    draft:{pages:[{id:'request',object_id:'purchase',title:'采购申请',fields:['title','amount'],columns:1}],workflows:[],overview:false},
    role_options:[{id:'Manager',label:'经理'}],
    design_context:{models:[{id:'purchase',active_revision:1,definition:{kind:'record',title:'采购单'},input_schema:{properties:{title:{type:'string',title:'事项'},amount:{type:'number',title:'金额'}}}}]},
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/application-pages.js',import.meta.url),'utf8'));
    const get=w.mountApplicationPages(w.document.querySelector('main'),application,()=>changes++);
    w.document.querySelector('[data-page]').click();
    assert.equal(dialog.properties.columns.enum.length,2);
    assert.equal(dialog.properties.list_fields.items.enum.length,2);
    await dialog.onSubmit({title:'采购审批表',fields:['title','amount'],list_fields:['title'],columns:2});
    assert.equal(get().pages[0].id,'request');assert.equal(get().pages[0].columns,2);
    assert.equal(application.draft.pages[0].columns,1);
    w.document.querySelector('[data-add-flow]').click();
    await dialog.onSubmit({title:'采购审批',form_id:'request',approver_role:'Manager',amount_field:'amount',threshold:5000,escalation_role:'Manager'});
    assert.equal(get().workflows[0].form_id,'request');
    assert.equal(get().workflows[0].threshold,5000);
    w.document.querySelector('[data-remove-page]').click();
    assert.equal(get().pages.length,1,'被流程引用的申请表不可直接移除');
    const toggle=w.document.querySelector('[data-app-overview]');toggle.checked=true;toggle.dispatchEvent(new w.Event('change'));
    assert.equal(get().overview,true);assert.equal(changes,3);
  }finally{dom.window.close();}
});

it('双列表单复用原弹窗，提交失败保留填写内容',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only',url:'http://localhost'});const w=dom.window as any;
  Object.assign(w,{esc:(v:any)=>String(v??''),toast:()=>{}});
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    w.openSchemaForm({title:'申请',columns:2,properties:{title:{type:'string'},amount:{type:'number'}},required:['title','amount'],values:{title:'打印纸',amount:5000},onSubmit:async()=>{throw Error('稍后重试');}});
    assert.ok(w.document.querySelector('.schema-two-columns'));
    const form=w.document.querySelector('form');await form.onsubmit({preventDefault(){},target:form});
    assert.equal(w.document.querySelector('[name="title"]').value,'打印纸');
    assert.equal(w.document.querySelector('[name="amount"]').value,'5000');
    assert.match(w.document.body.textContent,/稍后重试/);
  }finally{dom.window.close();}
});
