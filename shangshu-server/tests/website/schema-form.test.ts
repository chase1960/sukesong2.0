import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('通用枚举表单提交保持数字、布尔与字符串类型',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'});
  const w=dom.window as any;
  w.esc=(value:any)=>String(value??'');
  let saved:any;
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    const dialog=w.openSchemaForm({title:'字段测试',properties:{amount:{type:'number',enum:[10,20]},flag:{type:'boolean',enum:[false,true]},code:{type:'string',enum:['10','20']}},values:{amount:20,flag:false,code:'10'},onSubmit:async(value:any)=>{saved=value;}});
    const form=dialog.querySelector('form');
    assert.equal(form.elements.amount.value,'1');
    await form.onsubmit({preventDefault(){},target:form});
    assert.equal(saved.amount,20);assert.equal(saved.flag,false);assert.equal(saved.code,'10');
  }finally{dom.window.close();}
});

it('分存储金额在表单里按元填写，提交仍是精确整数分',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'});
  const w=dom.window as any;w.esc=(value:any)=>String(value??'');let saved:any;
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    const dialog=w.openSchemaForm({title:'拨款申请',required:['amount_cents'],properties:{amount_cents:{type:'integer',title:'拨款金额（分）',minimum:1,maximum:1000000000}},values:{amount_cents:12345},onSubmit:async(value:any)=>{saved=value;}});
    const input=dialog.querySelector('[name="amount_cents"]');
    assert.match(dialog.querySelector('[data-schema-field="amount_cents"] span').textContent,/拨款金额（元）/);
    assert.equal(input.value,'123.45');assert.equal(input.step,'0.01');
    input.value='0.29';const form=dialog.querySelector('form');await form.onsubmit({preventDefault(){},target:form});
    assert.equal(saved.amount_cents,29);
    assert.throws(()=>w.yuanToCents('1.001'),/两位小数/);
    assert.throws(()=>w.yuanToCents('999999999999999'),/超出可填写范围/);
  }finally{dom.window.close();}
});

it('明细逐行填写、取消不留空行；角色多选与必填 false 保持真实类型',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'});
  const w=dom.window as any;w.esc=(value:any)=>String(value??'');let saved:any;
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    const dialog=w.openSchemaForm({title:'采购申请',required:['flag','lines'],properties:{
      flag:{type:'boolean'},roles:{type:'array',items:{enum:['Desk User','System Manager']},minItems:1},
      lines:{title:'采购明细',type:'array',minItems:1,items:{type:'object',required:['quantity'],properties:{quantity:{type:'integer',minimum:1}}}}
    },values:{roles:['Desk User']},onSubmit:async(value:any)=>{saved=value;}});
    assert.equal(dialog.querySelector('[name=flag]').required,false);
    const add=dialog.querySelector('.schema-detail > button');add.click();
    const cancelled=w.document.querySelectorAll('dialog')[1];cancelled.querySelector('[data-cancel]').click();
    assert.equal(dialog.querySelectorAll('.schema-detail-row').length,0);
    add.click();const child=w.document.querySelectorAll('dialog')[1];const childForm=child.querySelector('form');
    childForm.elements.quantity.value='2';await childForm.onsubmit({preventDefault(){},target:childForm});
    assert.equal(dialog.querySelectorAll('.schema-detail-row').length,1);
    const form=dialog.querySelector('form');await form.onsubmit({preventDefault(){},target:form});
    assert.equal(saved.flag,false);assert.equal(saved.lines[0].quantity,2);assert.equal(saved.roles[0],'Desk User');
  }finally{dom.window.close();}
});

it('关联记录使用公共分页选择，不把第一页之外的记录静默遗漏',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'});const w=dom.window as any;
  w.esc=(value:any)=>String(value??'');const calls:any[]=[];let saved:any;
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    const dialog=w.openSchemaForm({title:'关联',required:['supplier'],properties:{supplier:{type:'string',title:'供应商',
      lookup:async(query:any)=>{calls.push(query);return {total:125,options:[{value:'supplier-'+query.page,label:'第'+query.page+'页供应商'}]};}}},onSubmit:async(value:any)=>{saved=value;}});
    await new Promise(resolve=>setImmediate(resolve));
    const next=Array.from(dialog.querySelectorAll('button')).find((b:any)=>b.textContent==='下一页') as any;
    next.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls[1].page,2);
    const select=dialog.querySelector('select');select.value='supplier-2';select.onchange();
    const form=dialog.querySelector('form');await form.onsubmit({preventDefault(){},target:form});
    assert.equal(saved.supplier,'supplier-2');
  }finally{dom.window.close();}
});
