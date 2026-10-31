import { it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
it('单元格确认卡从固定原件显示前后值；失权/冲突不执行，成功后读回固定新版本',async()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window as any;
  let version=2,editable=true,wrong=false,writes=0,changed=0;
  const change={sheet:'采购',row:2,column:3,value:{t:'n',v:180}};
  const confirm={payload:{file:'f1',expected_version:2,expected_modified:'m2',changes:[change]}};
  w.fetch=async(url:string,init:any)=>{
    if(url.includes('/actions/'))writes++;
    const p=JSON.parse(init?.body||'{}').payload;
    const result=url.endsWith('/actions')?{list:[{id:'files.edit_cells',executable:editable}]}:
      {result:{file:{name:'f1',file_name:'采购.xlsx',version,modified:'m'+version,can_edit:editable,status:'Active'},version:p.version,editable:true,
        changes:[{sheet:'采购',row:2,column:3,before:{t:'n',v:p.version===2?150:wrong?999:180},after:change.value}]}};
    return {ok:true,json:async()=>result};
  };
  w.addEventListener('shangshu:object-changed',()=>changed++);
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/file-detail.js',import.meta.url),'utf8'));
    const presenter=w.shangshuConfirmationPresenters['files.edit_cells'];assert.ok(presenter);
    const summary=await presenter.prepare(confirm);assert.match(summary.lines.join(' '),/150.*180/);assert.equal(summary.recordName,'f1');assert.equal(writes,0);
    assert.equal(summary.resource.name,'采购.xlsx');assert.equal(summary.resource.version,2);
    assert.equal(summary.changes[0].label,'采购 · C2');assert.equal(summary.changes[0].before,'150');assert.equal(summary.changes[0].after,'180');
    editable=false;await assert.rejects(presenter.prepare(confirm),/权限|修改/);editable=true;
    version=3;await assert.rejects(presenter.prepare(confirm),/版本|修订/);
    const receipt=await presenter.afterExecution(confirm,{result:{file:'f1',version:3}});assert.match(receipt.title,/3/);assert.equal(changed,1);
    wrong=true;await assert.rejects(presenter.afterExecution(confirm,{result:{file:'f1',version:3}}),/一致|核实/);assert.equal(changed,1);assert.equal(writes,0);
  }finally{dom.window.close();}
});
