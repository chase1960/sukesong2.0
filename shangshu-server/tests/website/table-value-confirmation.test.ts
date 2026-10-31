import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const chat = readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8');
const moduleUrl = new URL('../../../shangshu-web/js/table-value-confirmation.js', import.meta.url);
const moduleSource = existsSync(moduleUrl) ? readFileSync(moduleUrl, 'utf8') : '';
const ID = 'com.shangshu.app.test.object.cases';
const clone = (value:any) => JSON.parse(JSON.stringify(value));
const waitFor = async (check:()=>boolean) => {
  for (let i=0; i<200; i++) { if (check()) return; await new Promise(r=>setTimeout(r,5)); }
  throw Error('confirmation state did not settle');
};

function setup(options:any={}) {
  const dom = new JSDOM('<div id="body"></div>', {runScripts:'outside-only', url:'http://local/index.html#/dash'});
  const w:any = dom.window, calls:any[]=[];
  const definition:any = {id:ID,title:'案件总表',source:'managed',revision:3,operations:['read','update'],
    fields:[{id:'case_no',label:'我司案号',type:'text'}, {id:'amount',label:'金额',type:'decimal'},
      {id:'memo',label:'备注',type:'text'}, {id:'status',label:'审查状态',type:'choice'}],
    input_schema:{properties:{amount:{type:'number'},memo:{type:'string'},status:{type:'string'}}}, ...options.definition};
  const rows:any[] = options.rows || [{name:'R1',modified:'v1',creation:'c1',case_no:'案一',amount:10,memo:'旧备注',status:'待确认'}];
  const sheet:any = {table:'file-a',table_title:'案件工作簿.xlsx',headers:['我司案号','金额','备注'],
    content_version:7,structure_version:2,writable:true,
    rows:[{row_id:'R1',row_index:2,source_modified:'v1',values:{金额:{type:'number',value:10},备注:{type:'text',value:'旧备注'}}}], ...options.sheet};
  const p = options.payload || {object_id:ID,expected_revision:3,
    records:[{name:'R1',expected_modified:'v1',values:{amount:20,memo:'新备注'}}]};
  const confirm:any = {id:'proposal-1',capability:options.capability || 'platform.object.update_many',created_via:'ai-chat',payload:p};
  if(options.missingPayload)confirm.payload=null;
  w.esc = (x:any) => String(x??'').replace(/[&<>"']/g, (c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  w.money=String; w.toast=()=>{}; w.chatScrollBottom=()=>{}; w.chatUpdateFab=()=>{}; w.chatConfirmFollowUp=async()=>{};
  w.chatSkeleton=()=>'<span data-test-skeleton></span>';
  w.api = async (path:string, init:any={}) => {
    const body=init.body ? JSON.parse(init.body) : null;
    calls.push({path:String(path),method:init.method || 'GET',body});
    let data:any;
    if(path===`api/platform/objects/${ID}`)data={ok:true,object:clone(definition)};
    else if(path.includes('/services/platform.object.values_read/')) {
      const q=body.payload;
      data={ok:true,rows:q.names.map((name:string)=>{
        const row=rows.find(r=>r.name===name);if(!row)throw Error('not found');
        return Object.fromEntries(['name','modified','creation',...q.fields].map(k=>[k,row[k]]));
      })};
    } else if(path.includes('/services/files.sheet_read/'))data={ok:true,...clone(sheet)};
    else if(path.includes('/services/platform.action_proposal.values/'))data={ok:true,id:confirm.id,capability:confirm.capability,payload:clone(p),...options.restore};
    else if(path.endsWith('/resolve')) {
      if(confirm.capability==='platform.object.update_many') {
        for(const item of p.records){const row=rows.find(r=>r.name===item.name);Object.assign(row,item.values,{modified:'v2'});}
        data={ok:true,id:confirm.id,status:'confirmed',result:{object_id:ID,revision:3,written:p.records.length,
          records:p.records.map((r:any)=>r.name),record_version_checked:true}};
      }else {
        for(const cell of p.cells){
          const row=sheet.rows.find((r:any)=>r.row_id===cell.row_id);
          row.values[cell.header]=clone(cell.value);
          if(definition.companion.field_columns.some((c:any)=>c.header===cell.header))row.source_modified='v2';
        }
        sheet.content_version++;
        data={ok:true,id:confirm.id,status:'confirmed',result:{object_id:ID,table:'file-a',
          definition_revision:'bind-v1',content_version:sheet.content_version,structure_version:sheet.structure_version,
          source_versions:Object.fromEntries(sheet.rows.map((r:any)=>[r.row_id,r.source_modified]))}};
      }
    } else if(path.startsWith('api/events?'))data={ok:true,list:[]};
    else throw Error('unexpected request '+path);
    if(options.transform)data=options.transform(path,data);
    return {ok:true,json:async()=>data};
  };
  if(moduleSource&&!options.skipModule)w.eval(moduleSource);
  w.eval(chat.slice(chat.indexOf('const CHAT_CONFIRM_NAMES'),chat.indexOf('/* —— 确认之后')));
  w.chatAddConfirmCard(w.document.querySelector('#body'),confirm);
  const card=()=>w.document.querySelector('[data-confirm-id]');
  const button=()=>card().querySelector('.cf-actions .ok');
  return {w,dom,calls,definition,rows,sheet,p,confirm,card,button,close:()=>dom.window.close()};
}

test('managed batch card has Chinese per-cell before/after and performs two scoped reads',async()=>{
  const t=setup();try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));
    assert.match(t.card().textContent,/案件总表/);assert.match(t.card().textContent,/金额/);
    assert.match(t.card().querySelector('.cf-before').textContent,/10/);
    assert.match(t.card().querySelector('.cf-after').textContent,/20/);
    assert.equal(t.button().disabled,false);
    assert.equal(t.calls.length,2);
    const q=t.calls.find(c=>c.path.includes('values_read')).body.payload;
    assert.deepEqual(q.names,['R1']);assert.deepEqual(new Set(q.fields),new Set(['amount','memo']));
    assert.ok(t.calls.every(c=>!c.path.includes('/records/')));
  }finally{t.close();}
});

test('stale row or definition keeps confirmation disabled without changing old payload',async()=>{
  for(const overrides of [{rows:[{name:'R1',modified:'v9',creation:'c',amount:10,memo:'old'}]}, {definition:{revision:4}}]){
    const t=setup(overrides);try{
      const before=JSON.stringify(t.p);
      await waitFor(()=>/无法确认/.test(t.card().textContent));
      assert.equal(t.button().disabled,true);assert.equal(JSON.stringify(t.p),before);
      t.button().click();assert.ok(!t.calls.some(c=>c.path.endsWith('/resolve')));
    }finally{t.close();}
  }
});

test('101 cells paginate locally through the final cell and preserve the whole proposal',async()=>{
  const rows:any[]=[],records:any[]=[];
  for(let i=0;i<34;i++){
    const name='R'+i;rows.push({name,modified:'v1',creation:'c',case_no:'案'+i,amount:0,memo:'旧',status:'待确认'});
    records.push({name,expected_modified:'v1',values:i===33?{amount:i+1,memo:'新'+i}:{amount:i+1,memo:'新'+i,status:'已受理'}});
  }
  const t=setup({rows,payload:{object_id:ID,expected_revision:3,records}});try{
    const original=JSON.stringify(t.p);
    await waitFor(()=>!!t.card().querySelector('[data-diff-page-next]'));
    const reads=t.calls.length;
    for(let page=0;page<4;page++)t.card().querySelector('[data-diff-page-next]').click();
    assert.match(t.card().textContent,/第 5 \/ 5 页.*101/);
    assert.match(t.card().textContent,/R33/);assert.match(t.card().textContent,/新33/);
    assert.equal(t.card().querySelectorAll('.cf-change').length,1);
    assert.equal(t.w.document.activeElement.hasAttribute('data-diff-page-prev'),true);
    assert.equal(t.calls.length,reads,'local pagination must not reread');
    assert.equal(JSON.stringify(t.p),original);
    assert.equal(t.p.records.reduce((n:number,r:any)=>n+Object.keys(r.values).length,0),101);
  }finally{t.close();}
});

test('restored batch loads one authorized proposal delta and refuses mismatched identity',async()=>{
  const t=setup({missingPayload:true});try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));
    assert.equal(t.calls.filter(c=>c.path.includes('action_proposal.values')).length,1);
    assert.deepEqual(t.calls.find(c=>c.path.includes('action_proposal.values')).body.payload,{proposal_id:'proposal-1'});
  }finally{t.close();}
  const wrong=setup({missingPayload:true,restore:{id:'another'}});try{
    await waitFor(()=>/无法确认/.test(wrong.card().textContent));assert.equal(wrong.button().disabled,true);
  }finally{wrong.close();}
});

test('confirm uses original resolve then independently reads actual saved values',async()=>{
  const t=setup();try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));
    const original=JSON.stringify(t.p);t.button().click();
    await waitFor(()=>t.card().dataset.outcome==='success');
    assert.equal(t.calls.filter(c=>c.path.endsWith('/resolve')).length,1);
    assert.deepEqual(t.calls.find(c=>c.path.endsWith('/resolve')).body,{decision:'confirmed'});
    assert.equal(JSON.stringify(t.p),original);assert.match(t.card().textContent,/已保存/);
  }finally{t.close();}
});

const companionDefinition = () => ({companion:{object_id:ID,file_id:'file-a',definition_revision:'bind-v1',
  field_columns:[{header:'金额',field_id:'amount',type:'decimal'}]}});
const companionPayload = () => ({object_id:ID,file_id:'file-a',expected_revision:3,definition_revision:'bind-v1',
  expected_modified:{R1:'v1'},expected_content_version:7,expected_structure_version:2,op_id:'change-one',
  cells:[{row_id:'R1',header:'金额',value:{type:'number',value:20}},
         {row_id:'R1',header:'备注',value:{type:'text',value:'新备注'}}]});

test('companion card reads only target rows/headers and shows source plus ordinary values',async()=>{
  const t=setup({capability:'platform.object.companion_write',payload:companionPayload(),definition:companionDefinition()});try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));
    assert.match(t.card().textContent,/案件工作簿/);assert.match(t.card().textContent,/第 2 行/);
    assert.equal(t.card().querySelectorAll('.cf-change').length,2);assert.equal(t.button().disabled,false);
    assert.equal(t.calls.length,2);
    assert.deepEqual(t.calls.find(c=>c.path.includes('files.sheet_read')).body.payload,
                     {table:'file-a',row_ids:['R1'],headers:['金额','备注']});
  }finally{t.close();}
});

test('companion content, structure, source version and binding changes all block confirmation',async()=>{
  for(const mutate of [
    (t:any)=>{t.sheet.content_version=8;}, (t:any)=>{t.sheet.structure_version=3;},
    (t:any)=>{t.sheet.rows[0].source_modified='v9';},
    (t:any)=>{t.definition.companion.definition_revision='changed';},
    (t:any)=>{t.sheet.rows[0].values.金额={type:'hidden',hidden:true,value:null};},
  ]) {
    const t=setup({capability:'platform.object.companion_write',payload:companionPayload(),
      definition:companionDefinition(),transform:(path:string,data:any)=>{
        if(path.includes('files.sheet_read'))mutate({sheet:data,definition:{companion:{}}});
        if(path===`api/platform/objects/${ID}`)mutate({definition:data.object,sheet:{rows:[{values:{}}]}});
        return data;
      }});
    try{await waitFor(()=>/无法确认/.test(t.card().textContent));assert.equal(t.button().disabled,true);
      assert.ok(!t.calls.some(c=>c.path.endsWith('/resolve')));
    }finally{t.close();}
  }
});

test('failed saved-value readback remains confirmed but shows pending verification',async()=>{
  let after=false;
  const t=setup({transform:(path:string,data:any)=>{
    if(path.endsWith('/resolve'))after=true;
    if(after&&path.includes('values_read'))data.rows[0].amount=999;
    return data;
  }});try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));t.button().click();
    await waitFor(()=>t.card().dataset.outcome==='pending');
    assert.equal(t.calls.filter(c=>c.path.endsWith('/resolve')).length,1);
    assert.match(t.card().textContent,/已确认.*读取失败/);assert.ok(!t.card().querySelector('.cf-actions .ok'));
  }finally{t.close();}
});

test('companion success is independently read back using returned content and source versions',async()=>{
  const t=setup({capability:'platform.object.companion_write',payload:companionPayload(),definition:companionDefinition()});try{
    await waitFor(()=>!!t.card().querySelector('.cf-change'));const original=JSON.stringify(t.p);
    t.button().click();await waitFor(()=>t.card().dataset.outcome==='success');
    assert.equal(t.calls.filter(c=>c.path.endsWith('/resolve')).length,1);
    assert.equal(t.calls.filter(c=>c.path.includes('files.sheet_read')).length,3,'initial, pre-confirm, independent readback');
    assert.equal(JSON.stringify(t.p),original);assert.match(t.card().textContent,/已保存/);
  }finally{t.close();}
});

test('missing batch module fails closed rather than enabling a generic blank card',async()=>{
  const t=setup({skipModule:true});try{
    await waitFor(()=>/加载失败/.test(t.card().textContent));assert.equal(t.button().disabled,true);
    assert.ok(!t.calls.some(c=>c.path.endsWith('/resolve')));
  }finally{t.close();}
});
