import {it} from 'node:test';
import assert from 'node:assert/strict';
import {suggestRecordFields} from '../../src/adapters/web/record-file-suggestions.ts';

const source={ref_doctype:'Owned File',ref_name:'f1',file:'v1'};
const context={object:{source:'managed',revision:2,operations:['read','update'],fields:[{id:'title',label:'名称',type:'text'},{id:'date',label:'日期',type:'date'},{id:'secret',label:'只读',type:'text'}],input_schema:{properties:{title:{type:'string',maxLength:20},date:{type:'string'}}}},record:{name:'r1',modified:'m1',title:'不可发送的原值'}};
function fixture(){
  let calls=0;const reads:any[]=[];let result:any=[{field:'title',value:'采购甲',evidence:'名称：采购甲'}];let sent:any;
  const deps={getRecord:async()=>structuredClone(context),readFile:async(ref:any,verify?:boolean)=>{reads.push({ref,verify});return {name:'原件.txt',bytes:Buffer.from('名称：采购甲\n日期：2026-09-23')}} ,previewDocx:async()=>({blocks:[]}),recognize:async()=>'',generate:async(input:any)=>{calls++;sent=input;return result;}};
  return {deps,reads,get calls(){return calls;},get sent(){return sent;},set result(v:any){result=v;}};
}
it('候选只发送原件与可写字段，带来源/版本并且不写正式值',async()=>{
  const f=fixture(),r=await suggestRecordFields(source,f.deps);
  assert.equal(r.candidates[0].value,'采购甲');assert.equal(r.expected_modified,'m1');assert.equal(r.expected_revision,2);
  assert.doesNotMatch(JSON.stringify(f.sent),/不可发送的原值|secret/);assert.deepEqual(r.source,source);assert.equal(f.reads.length,2);assert.equal(f.reads[1].verify,true);
});
it('越权/只读记录在模型调用前拒绝，模型结束再检查权限及版本',async()=>{
  const f=fixture();f.deps.getRecord=async()=>{throw Error('无权限');};await assert.rejects(suggestRecordFields(source,f.deps),/权限/);assert.equal(f.calls,0);
  const g=fixture();let count=0;g.deps.getRecord=async()=>({...structuredClone(context),record:{...context.record,modified:++count===1?'m1':'m2'}});await assert.rejects(suggestRecordFields(source,g.deps),/变化/);
  const h=fixture();h.deps.getRecord=async()=>({...structuredClone(context),object:{...context.object,operations:['read']}});await assert.rejects(suggestRecordFields(source,h.deps),/编辑/);assert.equal(h.calls,0);
});
it('拒绝无原文证据、越界字段、非法类型日期、重复候选及超限，不猜值',async()=>{
  for(const result of [[{field:'secret',value:'泄漏',evidence:'名称：采购甲'}],[{field:'title',value:'伪造',evidence:'不存在'}],[{field:'title',value:42,evidence:'名称：采购甲'}],[{field:'date',value:'2026-02-31',evidence:'日期：2026-09-23'}],Array(2).fill({field:'title',value:'甲',evidence:'名称：采购甲'})]){
    const f=fixture();f.result=result;await assert.rejects(suggestRecordFields(source,f.deps));
  }
  const f=fixture();f.deps.readFile=async()=>({name:'原件.txt',bytes:Buffer.from('字'.repeat(20001))});await assert.rejects(suggestRecordFields(source,f.deps),/20000/);assert.equal(f.calls,0);
});
it('DOCX与扫描件共用原文候选，未提取出正文不调用模型',async()=>{
  const f=fixture();f.deps.readFile=async()=>({name:'原件.docx',bytes:Buffer.alloc(0)});f.deps.previewDocx=async()=>({blocks:[{type:'paragraph',text:'名称：采购甲'}]}) as any;assert.equal((await suggestRecordFields(source,f.deps)).candidates.length,1);
  const g=fixture();g.deps.readFile=async()=>({name:'扫描.pdf',bytes:Buffer.from('pdf')});await assert.rejects(suggestRecordFields(source,g.deps),/正文/);assert.equal(g.calls,0);
});
