import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const settle=()=>new Promise(r=>setTimeout(r,25));
function mount(workbooks=false){
  const dom=new JSDOM('<div id="host"><header class="file-heading"><h1>文件中心</h1></header><div class="file-tools">搜索</div><section class="file-content">文件列表</section><div id="notice" hidden></div></div>',{runScripts:'outside-only',url:'http://localhost/index.html#/file-center'}),w=dom.window as any;
  w.TextDecoder=TextDecoder;w.TextEncoder=TextEncoder;w.URL.createObjectURL=()=> 'blob:preview';w.URL.revokeObjectURL=()=>{};
  const rows:any={a:{name:'a',file_name:'合同说明.md',status:'Active',can_edit:true,metadata_revision:true,content_edit_revision:1,modified:'m1',version:1},b:{name:'b',file_name:'报价备注.md',status:'Active',can_edit:true,metadata_revision:true,content_edit_revision:1,modified:'m1',version:1}};
  const texts:any={a:'第一份\r\n原文',b:'第二份原文'},writes:any[]=[],readCounts:any={};let fail=0;
  const books:any={a:{revision:1,editable:true,reason:'',sheets:[{key:'s0',title:'采购',rows:2,columns:2,cells:[[{t:'s',v:'编号'},{t:'s',v:'数量'}],[{t:'s',v:'00123'},{t:'n',v:150}]]}]}};
  if(workbooks){rows.a.file_name='采购.xlsx';rows.a.workbook_edit_revision=1;texts.a=JSON.stringify(books.a);}
  w.fetch=async(url:string,init:any={})=>{
    const body=init.body?JSON.parse(init.body):null;
    if(url.includes('files.workbook')){
      const p=body.payload;
      if(p.operation==='blank')return reply({result:{...books.a,sheets:[{...books.a.sheets[0],title:'工作表1',cells:[[null,null],[null,null]]}]}});
      if(p.operation==='open')return reply({result:JSON.parse(texts[p.file])});
      if(p.operation==='encode')return reply({result:{revision:1,content_base64:Buffer.from(JSON.stringify(p.workbook)).toString('base64')}});
      if(p.operation==='import')return reply({result:books.a});
    }
    if(url.includes('files.versions')){
      const id=body.payload.file;readCounts[id]=(readCounts[id]||0)+1;
      return reply({file:{...rows[id]},versions:[{version_no:rows[id].version,frappe_file:id+'-v'+rows[id].version,size:20}]});
    }
    if(url.includes('/actions/')){
      writes.push(body);
      if(fail)return reply({error:'网关超时'},fail);
      if(url.includes('files.upload')){
        rows.new={...rows.a,name:'new',file_name:body.payload.file_name,modified:'m1',version:1};texts.new=Buffer.from(body.payload.content_base64,'base64').toString('utf8');
        return reply({result:{file:'new',version:1}});
      }
      const p=body.payload,row=rows[p.file];
      if(p.expected_version!==row.version||p.expected_modified!==row.modified)return reply({error:'版本已变化'},409);
      row.version++;row.modified='m'+row.version;texts[p.file]=Buffer.from(p.content_base64,'base64').toString('utf8');
      return reply({result:{file:p.file,version:row.version}});
    }
    if(url.includes('file-content')){
      const id=new URL(url,'http://localhost').searchParams.get('ref_name');
      return {ok:true,status:200,blob:async()=>new Blob([texts[id]])};
    }
    return reply({});
  };
  for(const name of ['tool-workspace','file-detail',...(workbooks?['file-workbook']:[]),'file-editor'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${name}.js`,import.meta.url),'utf8'));
  const controller=new w.AbortController(),ui=w.createToolWorkspace(w.document.querySelector('#host'),{signal:controller.signal});
  const editor=w.mountFileEditingWorkspace({ui,host:w.document.querySelector('#host'),getDirectories:()=>[{name:'采购',label:'/采购'}],onChanged:async()=>{},onInfo:()=>{}});
  ui.guardLeave(()=>editor.canLeave());
  return {dom,w,ui,editor,rows,texts,writes,readCounts,setFail:(status:number)=>{fail=status;},close:()=>{controller.abort();dom.window.close();}};
}
const reply=(data:any,status=200)=>({ok:status<400,status,json:async()=>data});
const change=(ctx:any,value:string)=>{const input=ctx.w.document.querySelector('[data-editor-panel]:not([hidden]) [data-editor-text]');input.value=value;input.dispatchEvent(new ctx.w.Event('input',{bubbles:true}));return input;};

it('文本和表格撤销回原内容时状态与保存按钮一致',async()=>{
  for(const workbook of [false,true]){
    const t=mount(workbook);try{
      await t.editor.open({id:'a'});
      if(workbook){
        const cell=t.w.document.querySelector('[data-cell="1:1"]');cell.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));
        const input=cell.querySelector('[contenteditable]');input.textContent='240';input.dispatchEvent(new t.w.Event('input'));
        t.w.document.querySelector('[data-grid-action="undo"]').click();
      }else{change(t,'草稿');change(t,'第一份\n原文');}
      assert.equal(t.w.document.querySelector('[data-editor-save]').disabled,true);
      assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/与已保存.*一致/);
      assert.equal(t.editor.canLeave(),true);
    }finally{t.close();}
  }
});

it('明确离线不发送也不锁草稿；联网后快速连按保存只写一次',async()=>{
  const t=mount(),original=t.w.fetch;let release:()=>void=()=>{};try{
    await t.editor.open({id:'a'});change(t,'离线草稿');
    Object.defineProperty(t.w.navigator,'onLine',{configurable:true,value:false});
    t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.equal(t.writes.length,0);assert.equal(t.w.document.querySelector('textarea').disabled,false);
    assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/离线.*草稿/);
    Object.defineProperty(t.w.navigator,'onLine',{configurable:true,value:true});
    t.w.fetch=async(url:string,init:any)=>{if(url.includes('/actions/'))await new Promise<void>(r=>{release=r;});return original(url,init);};
    t.w.document.querySelector('[data-editor-save]').click();
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true}));
    await settle();release();await settle();
    assert.equal(t.writes.length,1);assert.equal(t.rows.a.version,2);assert.equal(t.editor.canLeave(),true);
  }finally{t.close();}
});

it('两窗口共用服务端版本：后保存者保留草稿，不能覆盖先保存者',async()=>{
  const first=mount(),second=mount();try{
    second.w.fetch=first.w.fetch;
    await first.editor.open({id:'a'});await second.editor.open({id:'a'});
    change(first,'窗口一');change(second,'窗口二');
    first.w.document.querySelector('[data-editor-save]').click();await settle();
    second.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.equal(first.texts.a,'窗口一');assert.equal(first.rows.a.version,2);
    assert.equal(second.w.document.querySelector('textarea').value,'窗口二');
    assert.match(second.w.document.querySelector('[data-editor-status]').textContent,/草稿.*变化/);
    assert.equal(second.editor.canLeave(),false);
  }finally{first.close();second.close();}
});

it('多个文件标签去重；切回列表或另一文件不丢人工输入',async()=>{
  const t=mount();try{
    await t.editor.open({id:'a'});change(t,'尚未保存');await t.editor.open({id:'b'});await t.editor.open({id:'a'});
    assert.equal(t.w.document.querySelectorAll('[data-document-tab]').length,2);assert.equal(t.readCounts.a,1);
    assert.equal(t.w.document.querySelector('[data-editor-panel="a"] textarea').value,'尚未保存');
    t.w.document.querySelector('[data-file-list-tab]').click();assert.equal(t.w.document.querySelector('.file-list-pane').hidden,false);
    t.w.document.querySelector('[data-document-tab="a"]').click();assert.equal(t.w.document.querySelector('[data-editor-panel="a"] textarea').value,'尚未保存');
  }finally{t.close();}
});

it('DOCX正文修改沿原版本动作保存，编码失败保留草稿，禁止覆盖人工稿',async()=>{
  const t=mount(),original=t.w.fetch;let failEncode=true;try{
    t.rows.a.file_name='采购说明.docx';t.rows.a.document_edit_revision=1;
    t.w.fetch=async(url:string,init:any={})=>{
      if(url.includes('files.document')){
        const p=JSON.parse(init.body).payload;
        if(p.operation==='open')return reply({result:{revision:1,editable:true,notice:'只修改普通正文',paragraphs:[{key:'p0',text:t.texts.a,editable:true},{key:'p1',text:'复杂段落',editable:false}]}});
        if(failEncode)return reply({error:'编码暂时不可用'},503);
        assert.deepEqual(p.changes,[{key:'p0',text:'数量230'}]);
        return reply({result:{revision:1,content_base64:Buffer.from('数量230').toString('base64')}});
      }
      return original(url,init);
    };
    await t.editor.open({id:'a'});
    const input=t.w.document.querySelector('[data-document-paragraph="p0"]');assert.ok(input);
    assert.equal(t.w.document.querySelector('[data-document-paragraph="p1"]'),null);
    input.value='数量230';input.dispatchEvent(new t.w.Event('input'));
    const event=new t.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:'files.file',name:'a'}});t.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
    t.w.document.querySelector('[data-editor-save]').click();await settle();assert.equal(t.writes.length,0);assert.equal(input.value,'数量230');
    failEncode=false;t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.equal(t.writes.length,1);assert.equal(t.writes[0].payload.expected_version,1);assert.equal(t.editor.canLeave(),true);assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/已保存.*2/);
  }finally{t.close();}
});

it('图片标签复用阅读工具，旋转和缩放不发任何写入',async()=>{
  const t=mount();try{
    t.rows.a.file_name='凭证.png';await t.editor.open({id:'a'});
    const img=t.w.document.querySelector('.file-image-viewport img');assert.ok(img);
    Object.defineProperties(img,{naturalWidth:{value:800},naturalHeight:{value:600}});img.dispatchEvent(new t.w.Event('load'));
    t.w.document.querySelector('[data-image-rotate]').click();assert.match(img.style.transform,/90deg/);
    t.w.document.querySelector('[data-image-zoom="actual"]').click();assert.equal(img.style.width,'800px');
    assert.equal(t.writes.length,0);assert.equal(t.editor.canLeave(),true);
  }finally{t.close();}
});

it('XLSX单元格修改与新增工作表经原文件版本动作保存，不建业务表',async()=>{
  const t=mount(true);try{
    await t.editor.open({id:'a'});
    const cell=t.w.document.querySelector('[data-cell="1:1"]');assert.ok(cell);
    cell.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));const input=cell.querySelector('[contenteditable]');input.textContent='180';input.dispatchEvent(new t.w.Event('input'));
    t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.equal(t.writes.length,1);assert.equal(t.writes[0].payload.file,'a');assert.equal(t.writes[0].payload.expected_version,1);
    assert.equal(JSON.parse(t.texts.a).sheets[0].cells[1][1].v,180);assert.equal(t.editor.canLeave(),true);
    assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/已保存.*2/);
  }finally{t.close();}
});
it('新建自由表格先明确文件名和目录，取消零写，首次保存复用upload',async()=>{
  const t=mount(true);try{
    const pending=t.editor.createWorkbook();await settle();
    assert.ok(t.w.document.querySelector('[data-workbook-name]'));assert.ok(t.w.document.querySelector('[data-workbook-directory]'));
    t.w.document.querySelector('[data-workbook-cancel]').click();await pending;assert.equal(t.writes.length,0);
    const next=t.editor.createWorkbook();await settle();
    t.w.document.querySelector('[data-workbook-name]').value='客户跟进';t.w.document.querySelector('[data-workbook-directory]').value='采购';
    t.w.document.querySelector('[data-workbook-confirm]').click();await next;assert.equal(t.writes.length,0);
    assert.equal(t.w.document.querySelector('[data-editor-versions]').hidden,true);
    assert.equal(t.w.document.querySelector('[data-editor-reload]').hidden,true);
    assert.equal(t.editor.canLeave(),false);t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.equal(t.writes.length,1);assert.equal(t.writes[0].payload.file_name,'客户跟进.xlsx');assert.equal(t.writes[0].payload.directory_id,'采购');
    assert.equal(t.writes[0].payload.file,undefined);assert.equal(t.editor.canLeave(),true);assert.ok(t.w.document.querySelector('[data-document-tab="new"]'));
    assert.equal(t.w.document.querySelector('[data-editor-versions]').hidden,false);
  }finally{t.close();}
});
it('XLSX未知结果锁定原草稿与幂等键，确认回执后只读回，不另写',async()=>{
  const t=mount(true),original=t.w.fetch;let failRead=true;try{
    await t.editor.open({id:'a'});const cell=t.w.document.querySelector('[data-cell="1:1"]');cell.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));const input=cell.querySelector('[contenteditable]');input.textContent='0';input.dispatchEvent(new t.w.Event('input'));
    t.w.fetch=async(url:string,init:any)=>url.includes('file-content')&&t.writes.length&&failRead?reply({},503):original(url,init);
    t.w.document.querySelector('[data-editor-save]').click();await settle();assert.equal(t.writes.length,1);assert.equal(t.w.document.querySelector('[data-grid-action="insert_row"]').disabled,true);
    failRead=false;t.w.document.querySelector('[data-editor-save]').click();await settle();assert.equal(t.writes.length,1);assert.equal(t.editor.canLeave(),true);
  }finally{t.close();}
});

it('XLSX撤权或高级格式保持只读；CSV导入另建文件且取消零写',async()=>{
  const t=mount(true);try{
    t.rows.a.can_edit=false;await t.editor.open({id:'a'});assert.equal(t.w.document.querySelector('[data-editor-save]').hidden,true);assert.equal(t.w.document.querySelector('[data-grid-action="insert_row"]').disabled,true);
    const operation=t.editor.importWorkbook(new t.w.File(['编号,数量\n001,150'],'补充.csv',{type:'text/csv'}));await settle();t.w.document.querySelector('[data-workbook-cancel]').click();await operation;assert.equal(t.writes.length,0);assert.equal(t.w.document.querySelectorAll('[data-document-tab]').length,1);
  }finally{t.close();}
});
it('Ctrl/⌘S复用原确认动作，携带固定版本和修订；真实读回后才标记已保存',async()=>{
  const t=mount();try{
    await t.editor.open({id:'a'});change(t,'修改后\n第二行');
    t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true}));await settle();
    assert.equal(t.writes.length,1);assert.equal(t.writes[0].confirmed,true);
    assert.equal(t.writes[0].payload.expected_version,1);assert.equal(t.writes[0].payload.expected_modified,'m1');
    assert.equal(Buffer.from(t.writes[0].payload.content_base64,'base64').toString(),'修改后\r\n第二行');
    assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/已保存.*2/);assert.equal(t.editor.canLeave(),true);
  }finally{t.close();}
});
it('脏文件阻止离页与Agent覆盖；关标签先明确选择，取消和放弃不写',async()=>{
  const t=mount();try{
    await t.editor.open({id:'a'});change(t,'人工草稿');assert.equal(t.editor.canLeave(),false);
    const event=new t.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:'files.file',name:'a'}});t.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
    const unrelated=new t.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:'files.file',name:'b'}});t.w.dispatchEvent(unrelated);assert.equal(unrelated.defaultPrevented,false);
    t.w.document.querySelector('[data-close-document="a"]').click();assert.ok(t.w.document.querySelector('[data-close-cancel]'));
    t.w.document.querySelector('[data-close-cancel]').click();assert.equal(t.writes.length,0);
    t.w.document.querySelector('[data-close-document="a"]').click();t.w.document.querySelector('[data-close-discard]').click();
    assert.equal(t.w.document.querySelector('[data-document-tab]'),null);assert.equal(t.writes.length,0);
  }finally{t.close();}
});
it('外部换版后保存明确失败并保留输入，不覆盖新版本',async()=>{
  const t=mount();try{
    await t.editor.open({id:'a'});change(t,'我的草稿');t.rows.a.version=2;t.rows.a.modified='m2';t.texts.a='别人已保存';
    t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/变化|冲突/);assert.equal(t.texts.a,'别人已保存');
    assert.equal(t.w.document.querySelector('textarea').value,'我的草稿');assert.equal(t.editor.canLeave(),false);
  }finally{t.close();}
});
it('未知回执锁定原请求，同键重试，不允许放弃后盲目另发',async()=>{
  const t=mount();try{
    await t.editor.open({id:'a'});change(t,'保存不明');t.setFail(503);t.w.document.querySelector('[data-editor-save]').click();await settle();
    assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/待核实/);assert.equal(t.w.document.querySelector('textarea').disabled,true);
    t.w.document.querySelector('[data-editor-save]').click();await settle();assert.deepEqual(t.writes[1],t.writes[0]);
    t.w.document.querySelector('[data-close-document="a"]').click();assert.equal(t.w.document.querySelector('[data-close-discard]'),null);
  }finally{t.close();}
});
it('Office与无权/旧服务文件只读，不把格式转换为文本写回',async()=>{
  const t=mount();try{
    t.rows.a.file_name='报价.xlsx';await t.editor.open({id:'a'});assert.equal(t.w.document.querySelector('[data-editor-text]'),null);assert.equal(t.w.document.querySelector('[data-editor-save]').hidden,true);
    t.rows.b.content_edit_revision=undefined;await t.editor.open({id:'b'});assert.equal(t.w.document.querySelector('[data-editor-panel="b"] textarea'),null);assert.equal(t.writes.length,0);
  }finally{t.close();}
});

it('保存成功而读回失败只重试读取，不追加第二个版本',async()=>{
  const t=mount(),original=t.w.fetch;let failRead=true;
  try{
    await t.editor.open({id:'a'});change(t,'已写但待核对');
    t.w.fetch=async(url:string,init:any)=>url.includes('file-content')&&t.writes.length&&failRead?reply({error:'下载暂不可用'},503):original(url,init);
    t.w.document.querySelector('[data-editor-save]').click();await settle();assert.equal(t.writes.length,1);assert.match(t.w.document.querySelector('[data-editor-status]').textContent,/待核实/);
    failRead=false;t.w.document.querySelector('[data-editor-save]').click();await settle();assert.equal(t.writes.length,1);assert.equal(t.editor.canLeave(),true);
  }finally{t.close();}
});
it('无权及CSV不提供内容写入；BOM和空文本可保留',async()=>{
  const t=mount();try{
    t.rows.a.can_edit=false;await t.editor.open({id:'a'});assert.equal(t.w.document.querySelector('[data-editor-panel="a"] textarea'),null);
    t.rows.b.file_name='报价.csv';await t.editor.open({id:'b'});assert.equal(t.w.document.querySelector('[data-editor-panel="b"] textarea'),null);
    t.w.document.querySelector('[data-close-document="a"]').click();t.rows.a.can_edit=true;t.texts.a='\uFEFF含中文';await t.editor.open({id:'a'});change(t,'');
    t.w.document.querySelector('[data-editor-panel="a"] [data-editor-save]').click();await settle();assert.equal(t.texts.a,'\uFEFF');
    t.w.document.querySelector('[data-close-document="a"]').click();t.texts.a='';await t.editor.open({id:'a'});change(t,'补充');t.w.document.querySelector('[data-editor-panel="a"] [data-editor-save]').click();await settle();assert.equal(t.texts.a,'补充');
  }finally{t.close();}
});

it('非UTF8、混合换行和超大文本不冒充无损编辑；原件下载仍可用',async()=>{
  const t=mount(),original=t.w.fetch;let contentReads=0;
  try{
    t.w.fetch=async(url:string,init:any)=>{
      if(url.includes('file-content')){contentReads++;return {ok:true,status:200,blob:async()=>new Blob([new Uint8Array([0xff,0xfe,0x41])])};}
      return original(url,init);
    };
    await t.editor.open({id:'a'});assert.match(t.w.document.querySelector('.file-editor-surface').textContent,/UTF-8/);assert.equal(t.w.document.querySelector('textarea'),null);assert.ok(t.w.document.querySelector('[data-editor-download]').href.includes('a-v1'));
    t.w.document.querySelector('[data-close-document="a"]').click();
    t.w.fetch=async(url:string,init:any)=>{if(url.includes('files.versions'))return reply({file:t.rows.a,versions:[{version_no:1,frappe_file:'a-v1',size:2*1024*1024}]});return original(url,init);};
    await t.editor.open({id:'a'});assert.equal(contentReads,1);assert.match(t.w.document.querySelector('.file-editor-surface').textContent,/1MB/);
    t.w.document.querySelector('[data-close-document="a"]').click();t.w.fetch=original;t.texts.a='一行\r\n二行\n';await t.editor.open({id:'a'});assert.equal(t.w.document.querySelector('textarea'),null);assert.match(t.w.document.querySelector('.file-editor-surface').textContent,/混合/);
  }finally{t.close();}
});
