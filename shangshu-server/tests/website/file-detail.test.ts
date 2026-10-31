import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';
const pause=()=>new Promise(r=>setTimeout(r,25));
const record=()=>({name:'f1',file_name:'原件.txt',directory:'/',directory_id:'files-root',tags:[],note:'',owner:'a',modified:'2026-09-23 01:00:00',status:'Active',can_edit:true,metadata_revision:true});
const reply=(data:any,status=200)=>({ok:status<400,status,json:async()=>data,blob:async()=>new Blob(['原件内容'])});
it('DOCX确认卡核对普通正文前后值、版本和权限；执行后只认固定新版本原文',async()=>{
  const ctx=await mount();let modified='m2',canEdit=true,stored='数量240',events=0;
  const p={file:'f1',expected_version:2,expected_modified:'m2',changes:[{key:'p0',text:'数量240'}]};
  ctx.w.addEventListener('shangshu:object-changed',()=>events++);
  ctx.w.fetch=async(url:string,init:any)=>{
    assert.ok(!url.includes('/execute'),'预览与读回不执行写操作');
    if(url.endsWith('/actions'))return reply({list:[{id:'files.edit_paragraphs',executable:true}]});
    assert.match(url,/files.paragraphs/);const version=JSON.parse(init.body).payload.version;
    return reply({result:{file:{name:'f1',file_name:'采购.docx',version:2,modified,can_edit:canEdit,status:'Active'},version,editable:true,changes:[{key:'p0',number:1,before:version===2?'数量230':stored,after:'数量240'}]}});
  };
  try{
    const presenter=ctx.w.shangshuConfirmationPresenters['files.edit_paragraphs'];assert.ok(presenter);
    const preview=await presenter.prepare({payload:p});assert.equal(preview.title,'修改DOCX正文');assert.equal(preview.changes[0].before,'数量230');assert.equal(preview.changes[0].after,'数量240');
    assert.equal(preview.objectId,'files.file');assert.equal(preview.recordName,'f1');assert.equal(events,0);
    canEdit=false;await assert.rejects(presenter.prepare({payload:p}),/权限/);canEdit=true;
    modified='m3';await assert.rejects(presenter.prepare({payload:p}),/变化/);modified='m2';
    const receipt=await presenter.afterExecution({payload:p},{result:{file:'f1',version:3}});assert.match(receipt.title,/第3版/);assert.equal(events,1);
    stored='不同内容';await assert.rejects(presenter.afterExecution({payload:p},{result:{file:'f1',version:3}}),/不一致/);assert.equal(events,1);
    await assert.rejects(presenter.afterExecution({payload:p},{result:{file:'other',version:3}}),/未核实/);
  }finally{ctx.close();}
});
it('Agent文件信息修改显示原值和新值；缺修订、失权、未知字段不能确认，成功读回而非猜保存',async()=>{
  const ctx=await mount();let row=record(),writes=0;
  ctx.w.fetch=async(url:string,init:any)=>{
    if(url.includes('/actions/'))writes++;
    return url.endsWith('/actions')?reply({list:[{id:'files.update_meta',executable:true,input_schema:{properties:{file:{title:'文件'},expected_modified:{title:'修订'},note:{title:'备注'}}}}]}):reply({result:{file:row,versions:[]}});
  };
  try{
    const presenter=ctx.w.shangshuConfirmationPresenters?.['files.update_meta'];assert.ok(presenter,'文件修改必须进入原确认卡');
    const confirm={payload:{file:'f1',expected_modified:row.modified,note:'核对完成'}};
    const preview=await presenter.prepare(confirm);assert.match(preview.title,/原件.txt/);assert.ok(preview.lines.includes('备注：空 → 核对完成'));assert.equal(writes,0);
    await assert.rejects(presenter.prepare({payload:{file:'f1',note:'不可盲写'}}),/修订|版本/);
    await assert.rejects(presenter.prepare({payload:{...confirm.payload,status:'Recycled'}}),/字段/);
    row={...row,can_edit:false};await assert.rejects(presenter.prepare(confirm),/权限|修改/);
    row={...row,can_edit:true,modified:'new',note:'实际保存值'};
    await assert.rejects(presenter.prepare(confirm),/变化|修订|版本/);
    const receipt=await presenter.afterExecution(confirm);assert.match(receipt.lines.join(' '),/实际保存值/);assert.equal(writes,0);
  }finally{ctx.close();}
});
it('Agent修改不能覆盖文件详情人工脏输入，干净详情按实际读回同步且关闭后解除守卫',async()=>{
  const ctx=await mount();const field=ctx.w.document.querySelector('[data-property="note"]');
  const before=()=>{const event=new ctx.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:'files.file'}});ctx.w.dispatchEvent(event);return event.defaultPrevented;};
  try{
    field.value='人工尚未保存';assert.equal(before(),true);assert.equal(field.value,'人工尚未保存');
    field.value='';assert.equal(before(),false);
    ctx.w.fetch=async()=>reply({result:{file:{...record(),note:'Agent实际保存'},versions:[]}});
    ctx.w.dispatchEvent(new ctx.w.CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:'f1'}}));await pause();assert.equal(field.value,'Agent实际保存');
    ctx.ui.closeModal(true);assert.equal(before(),false);
  }finally{ctx.close();}
});
it('明确的重命名入口立即编辑名称；Escape 取消零写入',async()=>{
  let writes=0;const ctx=await mount(async()=>{writes++;return reply({});},{editField:'file_name'});
  try{const field=ctx.w.document.querySelector('[data-property="file_name"]');assert.equal(field.readOnly,false);assert.equal(ctx.w.document.activeElement,field);field.value='不保存.md';field.dispatchEvent(new ctx.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause();assert.equal(field.value,'原件.txt');assert.equal(writes,0);}finally{ctx.close();}
});
it('文件恢复先选择原关联，取消零写；解除时携带当前修订且不修改业务记录',async()=>{
  const calls:any[]=[];const ctx=await mount();ctx.ui.closeModal(true);
  ctx.w.fetch=async(url:string,init:any)=>url.includes('/actions/')?(calls.push({url,...JSON.parse(init.body)}),reply({result:{file:'f1',status:'Active'}})):
    url.includes('files.versions')?reply({file:{...record(),status:'Recycled',can_edit:false,can_restore:true,restore_relations:1},versions:[{version_no:2,frappe_file:'v2'}]}):reply({});
  try{
    await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{id:'f1'}});
    ctx.w.document.querySelector('[data-restore]').click();
    assert.ok(ctx.w.document.querySelector('[data-restore-keep]').checked);
    assert.ok(ctx.w.document.querySelector('[data-restore-keep]').closest('.file-access-choice'),'复用既有紧凑复选控件，不能拉成整行输入框');
    ctx.w.document.querySelector('[data-restore-cancel]').click();await pause();assert.equal(calls.length,0);
    ctx.w.document.querySelector('[data-restore]').click();
    ctx.w.document.querySelector('[data-restore-keep]').checked=false;
    ctx.w.document.querySelector('[data-restore-confirm]').click();await pause();
    assert.equal(calls.length,1);assert.deepEqual(calls[0].payload,{file:'f1',expected_modified:record().modified,keep_relations:false});
    assert.match(calls[0].url,/files.restore/);
  }finally{ctx.close();}
});
async function mount(action:(body:any)=>Promise<any>=async()=>reply({}),options:any={}){
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any;
  const requests:string[]=[];
  w.fetch=async(url:string,init:any)=>{requests.push(url);return url.includes('/actions/')?action(JSON.parse(init.body)):url.includes('files.versions')?reply({file:record(),versions:[{version_no:2,frappe_file:'v2'},{version_no:1,frappe_file:'v1'}]}):url.includes('files.directories')?reply({directories:[{name:'files-root',path:'/'}]}):reply({});};
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for(const name of ['tool-workspace','file-detail'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${name}.js`,import.meta.url),'utf8'));
  const ui=w.createToolWorkspace(w.document.querySelector('#host'));ui.guardLeave(()=>ui.canCloseModals());
  const detail=await w.openFileCenterDetail({ui,file:{id:'f1'},...options});
  return {w,dom,ui,detail,requests,close(){ui.dispose();dom.window.close();}};
}
it('详情使用双栏弹窗；单字段保存携带修订，不整份覆盖',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({result:{file:'f1',record:{...record(),file_name:body.payload.file_name,modified:'2026-09-23 02:00:00'}}});});
  try{const {w}=ctx;assert.ok(w.document.querySelector('.file-detail-columns'));const field=w.document.querySelector('[data-property="file_name"]');assert.equal(field.readOnly,true);field.dispatchEvent(new w.MouseEvent('dblclick'));field.value='改名.txt';field.dispatchEvent(new w.Event('blur'));await pause();assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0].payload).sort(),['expected_modified','file','file_name']);assert.equal(w.document.querySelector('.file-detail-dialog h2').textContent,'改名.txt');assert.equal(w.document.querySelector('[data-retry]').hidden,true);}
  finally{ctx.close();}
});
it('文件保存结果未知保留同键同载荷，关闭和离页均阻止',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return calls.length===1?reply({error:'连接不确定'},503):reply({result:{file:'f1',record:{...record(),note:'核实',modified:'2026-09-23 03:00:00'}}});});
  try{const {w}=ctx;const field=w.document.querySelector('[data-property="note"]');field.value='核实';field.dispatchEvent(new w.Event('blur'));await pause();w.document.querySelector('[data-detail-close]').click();assert.ok(w.document.querySelector('.file-detail-dialog'));const leave=new w.CustomEvent('shangshu:before-page-change',{cancelable:true});w.dispatchEvent(leave);assert.equal(leave.defaultPrevented,true);w.document.querySelector('[data-retry]').click();await pause();assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);w.document.querySelector('[data-detail-close]').click();assert.equal(w.document.querySelector('.file-detail-dialog'),null);}
  finally{ctx.close();}
});
it('保存期间新输入不会被旧成功回执清空，下一次使用新修订',async()=>{
  const calls:any[]=[];let release:(value:any)=>void=()=>{};const ctx=await mount(async body=>{calls.push(body);if(calls.length===1)return new Promise(resolve=>{release=resolve;});return reply({result:{file:'f1',record:{...record(),note:'后输入',modified:'2026-09-23 04:00:00'}}});});
  try{const {w}=ctx,field=w.document.querySelector('[data-property="note"]');field.value='先输入';field.dispatchEvent(new w.Event('blur'));await pause();field.value='后输入';field.dispatchEvent(new w.Event('blur'));release(reply({result:{file:'f1',record:{...record(),note:'先输入',modified:'2026-09-23 03:00:00'}}}));await pause();assert.equal(field.value,'后输入');assert.equal(calls.length,2);assert.equal(calls[1].payload.expected_modified,'2026-09-23 03:00:00');assert.equal(calls[1].payload.note,'后输入');}
  finally{ctx.close();}
});
it('引用快照只展示指定版本，没有修改入口，也不偷换最新原件',async()=>{
  const ctx=await mount(undefined,{snapshot:true,version:1});
  try{const {w}=ctx;assert.equal(w.document.querySelectorAll('[data-version-preview]').length,1);assert.match(w.document.querySelector('[data-current-download]').href,/file=v1/);assert.equal(w.document.querySelector('[data-reupload]'),null);assert.equal(w.document.querySelector('[data-property="file_name"]').disabled,true);}
  finally{ctx.close();}
});
it('超长标签在发送前提示，不把服务端截断误判为未知结果',async()=>{
  let calls=0;const ctx=await mount(async()=>{calls++;return reply({});});
  try{const field=ctx.w.document.querySelector('[data-property="tags"]');field.value='标'.repeat(21);field.dispatchEvent(new ctx.w.Event('blur'));await pause();assert.equal(calls,0);assert.match(ctx.w.document.querySelector('[data-save-state]').textContent,/20/);}
  finally{ctx.close();}
});
it('未知写入后重试被拒仍保留原请求，不能当成确定未写入',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({error:calls.length===1?'网关超时':'权限已变化'},calls.length===1?503:403);});
  try{const field=ctx.w.document.querySelector('[data-property="note"]');field.value='待核实';field.dispatchEvent(new ctx.w.Event('blur'));await pause();ctx.w.document.querySelector('[data-retry]').click();await pause();assert.equal(ctx.w.document.querySelector('[data-discard]').hidden,true);ctx.w.document.querySelector('[data-retry]').click();await pause();assert.deepEqual(calls[2],calls[0]);}
  finally{ctx.close();}
});
it('邮件固定引用复用详情但不查询文件中心，也不替换当前版本',async()=>{
  const ctx=await mount(undefined,{reference:{doctype:'Shangshu Mail Message',name:'mail-1',file:'bound-1',label:'第 1 版'},file:{name:'邮件原件.txt',size:10}});
  try{const {w}=ctx;const url=new URL(w.document.querySelector('[data-current-download]').href);assert.equal(url.searchParams.get('ref'),'Shangshu Mail Message');assert.equal(url.searchParams.get('file'),'bound-1');assert.equal(w.document.querySelector('[data-reupload]'),null);assert.match(w.document.querySelector('[data-preview-heading]').textContent,/第 1 版/);assert.equal(w.document.querySelector('[data-property="directory_id"]'),null);assert.equal(ctx.requests.some(url=>url.includes('/services/files.')),false);}
  finally{ctx.close();}
});
it('DOCX附件复用公共引用预览，正文按文本渲染并保留表格和图片限制提示',async()=>{
  const ctx=await mount();ctx.ui.closeModal(true);const calls:any[]=[];
  ctx.w.fetch=async(url:string,init:any)=>{calls.push({url,body:JSON.parse(init.body)});return reply({result:{blocks:[{type:'paragraph',text:'<script>不执行</script>'},{type:'table',rows:[['编号','001']]}],warnings:['图片未显示']}});};
  try{await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{name:'合同.docx'},reference:{doctype:'Shangshu Mail Message',name:'mail',file:'fixed'}});await pause();assert.equal(calls[0].url,'/api/platform/services/platform.file.preview/invoke');assert.equal(calls[0].body.payload.file,'fixed');assert.equal(ctx.w.document.querySelector('[data-file-visual] script'),null);assert.equal(ctx.w.document.querySelector('[data-file-visual] td').textContent,'编号');assert.match(ctx.w.document.querySelector('[data-file-visual]').textContent,/图片未显示/);}
  finally{ctx.close();}
});
it('PDF无论原生插件是否可用都按需加载站内阅读器，换视图释放',async()=>{
  const ctx=await mount();
  try{const surface=ctx.w.document.createElement('div');ctx.w.document.body.append(surface);
    let mounted=0,disposed=0;
    ctx.w.loadFilePdfReader=async()=>({mountPdf(host:any){mounted++;host.textContent='站内PDF';return ()=>disposed++;}});
    Object.defineProperty(ctx.w.navigator,'pdfViewerEnabled',{value:false,configurable:true});
    ctx.w.renderFileMediaPreview(surface,{url:'blob:pdf',name:'验收.pdf',kind:'pdf'});
    await pause();assert.equal(surface.querySelector('iframe'),null);assert.equal(mounted,1);assert.match(surface.textContent,/站内PDF/);
    Object.defineProperty(ctx.w.navigator,'pdfViewerEnabled',{value:true,configurable:true});
    ctx.w.renderFileMediaPreview(surface,{url:'blob:pdf',name:'验收.pdf',kind:'pdf'});
    await pause();assert.equal(mounted,2);assert.equal(disposed,1);
    ctx.w.clearFileMediaPreview(surface);assert.equal(disposed,2);
  }finally{ctx.close();}
});
it('图片默认适应窗口，可缩放和复原；解码失败明确提示且保留下载',async()=>{
  const ctx=await mount();ctx.ui.closeModal(true);const revoked:string[]=[];
  ctx.w.URL.createObjectURL=()=> 'blob:image-test';ctx.w.URL.revokeObjectURL=(url:string)=>revoked.push(url);
  try{
    await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{name:'图片.png'},reference:{doctype:'Shangshu Mail Message',name:'mail',file:'fixed'}});await pause();
    const $=(s:string)=>ctx.w.document.querySelector(s),img=$('[data-file-visual] img');
    assert.equal($('[data-image-zoom="in"]').disabled,true);
    Object.defineProperties(img,{naturalWidth:{value:1200},naturalHeight:{value:800}});img.dispatchEvent(new ctx.w.Event('load'));
    assert.equal($('[data-image-scale]').textContent,'适应窗口');
    $('[data-image-zoom="in"]').click();assert.equal(img.style.width,'1500px');assert.equal($('[data-image-scale]').textContent,'125%');
    $('[data-image-zoom="fit"]').click();assert.equal(img.style.width,'1200px');assert.equal($('[data-image-scale]').textContent,'适应窗口');
    img.dispatchEvent(new ctx.w.Event('error'));assert.match($('[data-file-visual]').textContent,/图片无法解码.*下载原件/);
    assert.equal($('[data-file-visual] img'),null);assert.match($('[data-current-download]').href,/file=fixed/);
    ctx.ui.closeModal(true);assert.deepEqual(revoked,['blob:image-test']);
  }finally{ctx.close();}
});
it('换版本后旧图片的延迟失败不覆盖新预览，旧URL被释放',async()=>{
  const ctx=await mount();ctx.ui.closeModal(true);let count=0;const revoked:string[]=[];
  ctx.w.URL.createObjectURL=()=> 'blob:image-'+(++count);ctx.w.URL.revokeObjectURL=(url:string)=>revoked.push(url);
  ctx.w.fetch=async(url:string)=>url.includes('files.versions')?reply({file:{...record(),file_name:'图片.jpg'},versions:[{version_no:2,frappe_file:'v2'},{version_no:1,frappe_file:'v1'}]}):reply({});
  try{
    await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{id:'f1'}});await pause();const old=ctx.w.document.querySelector('[data-file-visual] img');
    ctx.w.document.querySelector('[data-version-preview="1"]').click();await pause();old.dispatchEvent(new ctx.w.Event('error'));
    assert.equal(ctx.w.document.querySelector('[data-file-visual] img').src,'blob:image-2');assert.deepEqual(revoked,['blob:image-1']);
    ctx.ui.closeModal(true);assert.deepEqual(revoked,['blob:image-1','blob:image-2']);
  }finally{ctx.close();}
});
it('上传与重传共用文件校验：格式、空文件和超20MiB在读取前拒绝',async()=>{
  const ctx=await mount();let reads=0;
  ctx.w.FileReader=class{result='';onload=()=>{};readAsDataURL(){reads++;this.result='data:text/plain;base64,YQ==';this.onload();}};
  try{
    for(const [name,size,message] of [['坏.exe',1,/格式/],['空.txt',0,/为空/],['超限.txt',20*1024*1024+1,/20MB/]] as Array<[string,number,RegExp]>){
      await assert.rejects(ctx.w.readFileCenterContent({name,size}),(error:any)=>error.status===400&&message.test(error.message));
    }
    assert.equal(reads,0);assert.equal(await ctx.w.readFileCenterContent({name:'边界.txt',size:20*1024*1024}),'YQ==');assert.equal(reads,1);
  }finally{ctx.close();}
});

it('详情所有人不使用上传人冒充部门或员工',async()=>{
 const ctx=await mount();try{for(const [kind,subject] of [['Department','dept-42'],['Employee','employee-7'],['Department','']]){ctx.ui.closeModal(true);ctx.w.fetch=async()=>reply({file:{...record(),owner:'uploader@example.invalid',owner_subject_kind:kind,owner_subject:subject},versions:[{version_no:1,frappe_file:'v1'}]});await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{id:'f1'}});const terms=Array.from(ctx.w.document.querySelectorAll('dt')) as any[];const text=terms.find(x=>x.textContent==='所有人').nextElementSibling.textContent;assert.ok(text.includes(subject||'—'));assert.ok(!text.includes('uploader@example.invalid'));}}finally{ctx.close();}
});

it('版本回包无file时仍传递列表已知的归属主体',async()=>{
 const ctx=await mount();try{ctx.ui.closeModal(true);ctx.w.fetch=async()=>reply({versions:[{version_no:1,frappe_file:'v1'}]});await ctx.w.openFileCenterDetail({ui:ctx.ui,file:{id:'f1',name:'部门附件',owner:'uploader@example.invalid',ownerSubjectKind:'Department',ownerSubject:'dept-known'}});const terms=Array.from(ctx.w.document.querySelectorAll('dt')) as any[];assert.equal(terms.find(x=>x.textContent==='所有人').nextElementSibling.textContent.trim(),'部门 dept-known');}finally{ctx.close();}
});
