import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('建模编辑器可从表格直接打开，复用原字段迁移链且统一清理弹层',()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window as any;
  w.esc=(v:any)=>String(v??'');w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  try{
    for(const file of ['forms.js','model-designer.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+file,import.meta.url),'utf8'));
    const designer=w.createModelDesigner({id:'app',role_options:[],design_context:{models:[]}},()=>{},()=>true);
    assert.equal(designer.hasOpenDialog(),false);designer.create();assert.equal(designer.hasOpenDialog(),true);
    assert.match(w.document.querySelector('dialog').textContent,/新建数据表/);
    designer.dispose();assert.equal(w.document.querySelectorAll('dialog').length,0);assert.equal(designer.hasOpenDialog(),false);
  }finally{dom.window.close();}
});

it('数据能力使用服务端生效定义，不把草稿、管理员权限或未检查状态冒充员工能力',()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});const w=dom.window as any;
  w.esc=(v:any)=>String(v??'').replaceAll('<','&lt;');
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/model-designer.js',import.meta.url),'utf8'));
    const application={id:'app',role_options:[{id:'Desk User',label:'员工'}],design_context:{models:[
      {id:'table',revision:3,active_revision:2,definition:{title:'供应商草稿',kind:'record',fields:[]},
       capabilities:{status:'checked',revision:2,operations:['read'],reason:'对象迁移尚未完成，暂不可写入',
         deletion:{supported:false},record_scope:'own',read_roles:['Desk User'],write_roles:['Desk User'],
         fields:[{id:'title',label:'公司名称',type:'text',required:true,read_roles:['Desk User'],write_roles:['Desk User']}]}},
      {id:'unbuilt',revision:1,definition:{title:'未生效表',kind:'record',fields:[]}}
    ]}};
    w.mountModelDesigner(w.document.querySelector('main'),application,()=>{},()=>true);
    const rows=w.document.querySelectorAll('[data-model-capabilities]');
    assert.equal(rows.length,2);
    assert.match(rows[0].textContent,/生效版本 2/);
    assert.match(rows[0].textContent,/当前登录账号/);
    assert.match(rows[0].textContent,/不支持删除/);
    assert.match(rows[0].textContent,/公司名称/);
    assert.match(rows[0].textContent,/本人创建/);
    assert.match(rows[0].textContent,/暂不可写入/);
    assert.doesNotMatch(rows[0].textContent,/新建、修改/);
    assert.match(rows[1].textContent,/未检查/);
    assert.equal(w.document.querySelectorAll('table').length,1);
  }finally{dom.window.close();}
});

it('应用内字段配置按类型收敛、生成待确认计划、空预览可退出并取消计划',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});const w=dom.window as any;
  w.esc=(v:any)=>String(v??'');w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  const writes:any[]=[];let reloaded=false;
  const button=(root:any,text:string)=>[...root.querySelectorAll('button')].find((b:any)=>b.textContent===text);
  const submit=async(dialog:any)=>{const form=dialog.querySelector('form');await form.onsubmit({preventDefault(){},target:form});};
  let change:any;
  w.api=async(path:string,options:any)=>{
    if(options){const body=JSON.parse(options.body);writes.push({path,body});
      if(path.endsWith('/object-changes'))change={id:'change-1',status:'Planned',definition:body.definition,
        plan:{operation:'create',changes:[],blocked:[]},input_schema:{properties:{amount:{type:'number',title:'数量'}},required:['amount']}};
    }
    return {ok:true,json:async()=>({change})};
  };
  try{
    for(const file of ['forms.js','model-designer.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+file,import.meta.url),'utf8'));
    w.mountModelDesigner(w.document.querySelector('main'),{id:'app',role_options:[{id:'Desk User',label:'员工'}],design_context:{models:[]}},async()=>{reloaded=true;},()=>true);
    button(w.document,'新建数据表').click();let dialog=w.document.querySelector('dialog');
    dialog.querySelector('[name=title]').value='采购明细';await submit(dialog);
    button(w.document,'添加字段').click();dialog=[...w.document.querySelectorAll('dialog')].at(-1);
    dialog.querySelector('[name=label]').value='数量';
    const type=dialog.querySelector('[name=type]');type.value='2';type.dispatchEvent(new w.Event('change'));
    assert.equal(dialog.querySelector('[data-schema-field=minimum]').hidden,false);
    assert.equal(dialog.querySelector('[data-schema-field=options]').hidden,true);
    assert.equal(dialog.querySelector('details').open,false);
    dialog.querySelector('[name=minimum]').value='1';await submit(dialog);
    await button(w.document,'检查变更').onclick();
    assert.equal(writes[0].body.definition.fields[0].type,'integer');
    assert.equal(writes[0].body.definition.fields[0].constraints.minimum,1);
    assert.ok(w.document.querySelector('[data-change]').textContent.includes('新增字段'));
    button(w.document,'预览录入表单').click();
    button(w.document,'关闭预览').click(); // 不应因预览中的必填字段为空而无法关闭。
    assert.equal(w.document.querySelectorAll('dialog').length,1);
    button(w.document,'取消计划').click();await new Promise(resolve=>setImmediate(resolve));
    assert.ok(writes.at(-1).path.endsWith('/cancel'));assert.equal(reloaded,true);
  }finally{dom.window.close();}
});

it('业务唯一键只允许标量字段，并按声明组合进入待确认定义',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});const w=dom.window as any;
  w.esc=(v:any)=>String(v??'');w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  const button=(root:any,text:string)=>[...root.querySelectorAll('button')].find((b:any)=>b.textContent===text);
  const submit=async(dialog:any)=>{const form=dialog.querySelector('form');await form.onsubmit({preventDefault(){},target:form});};
  const topDialog=()=>[...w.document.querySelectorAll('dialog')].at(-1);
  const writes:any[]=[];
  w.api=async(path:string,options:any)=>{const body=options?JSON.parse(options.body):null;if(options)writes.push({path,body});
    return {ok:true,json:async()=>options?{change:{id:'c1',status:'Planned',definition:body.definition,plan:{operation:'update',changes:[],blocked:[]},input_schema:{properties:{},required:[]}}}:{}};};
  try{
    for(const file of ['forms.js','model-designer.js'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+file,import.meta.url),'utf8'));
    const application={id:'app',role_options:[],design_context:{models:[{id:'table',revision:4,active_revision:1,
      definition:{schema_version:1,title:'合同',kind:'record',access:{read_roles:['Desk User'],write_roles:['Desk User'],record_scope:'own'},
        fields:[{id:'no',label:'编号',type:'text'},{id:'amount',label:'金额',type:'decimal'},
                {id:'linked',label:'关联',type:'reference',target:'other'}]}}]}};
    w.mountModelDesigner(w.document.querySelector('main'),application,()=>{},()=>true);
    button(w.document,'配置字段').click();const editor=topDialog();
    button(editor,'业务唯一键').click();const picker=topDialog();
    const group=picker.querySelector('[data-schema-field=fields]') as any;
    const boxes=[...group.querySelectorAll('input')] as any[];
    assert.equal(boxes.length,2);
    assert.match(group.textContent,/编号/);assert.match(group.textContent,/金额/);assert.doesNotMatch(group.textContent,/关联/);
    boxes.forEach((b:any)=>{b.checked=true;});
    await submit(picker);
    button(topDialog(),'取消').click(); // 关闭重开的唯一键弹层，返回字段编辑器。
    await button(editor,'检查变更').onclick();
    assert.deepEqual(writes[0].body.definition.unique_keys,[['amount','no']]);
  }finally{dom.window.close();}
});
