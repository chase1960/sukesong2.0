import * as attributionModule from '../../../shangshu-web/js/resource-attribution.mjs';
/** Production directory/create, file-center upload and detail modules → actual HTTP.
 * Navigation is captured; no browser rendering claim. Exact created IDs persist
 * after each response for caller cleanup even when a later assertion fails. */
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {readFileSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import {mountDirectory} from '../../../shangshu-web/js/domains/excel-univer/src/directory.ts';
const {SS_BASE:base,SS_MANUAL_COOKIE:cookie,SS_MANUAL_PREFIX:prefix,SS_MANUAL_DEPT:department,SS_MANUAL_MANIFEST:manifest,SS_MANUAL_XLSX:xlsx}=process.env;
assert.ok(base&&cookie&&prefix&&department&&manifest&&xlsx);
const files=[],calls=[],pass=[],fail=[];writeFileSync(manifest,JSON.stringify({files}));
const check=(label,ok)=>{assert.ok(ok,label);pass.push(label);console.log('PASS '+label);};
async function actualFetch(url,init={}){
 // JSDOM and Node use distinct AbortSignal realms; relay cancellation to native fetch.
 if(init.signal&&!(init.signal instanceof AbortSignal)){const native=new AbortController(),source=init.signal;if(source.aborted)native.abort();else source.addEventListener('abort',()=>native.abort(),{once:true});init={...init,signal:native.signal};}
 const response=await fetch(new URL(url,base),{...init,headers:{...init.headers,cookie}});
 const body=await response.clone().json().catch(()=>null);
 if(!response.ok&&!url.includes('/actions/'))console.log('READ_ERROR',String(url),response.status,body?.error||body?.message||'');
 if(url.includes('/actions/')){calls.push({url,body:init.body&&JSON.parse(init.body),status:response.status,result:body?.result});
  const id=body?.result?.file;if(id&&!files.includes(id)){files.push(id);writeFileSync(manifest,JSON.stringify({files}));}}
 return response;
}
const invoke=async(name,payload)=>{const r=await actualFetch('/api/platform/services/'+name+'/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload})});assert.equal(r.status,200);const b=await r.json();return b.result||b;};
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('production UI wait timed out');}
const dom=new JSDOM('<main id="excel"></main><main id="files"></main>',{url:base,runScripts:'outside-only'}),w=dom.window;
for(const part of cookie.split('; '))dom.cookieJar.setCookieSync(part+'; Path=/',base);
w.attributionModule=attributionModule;w.fetch=actualFetch;w.RENDER={};w.currentRole=()=> 'staff';w.toast=()=>{};
for(const file of ['tool-workspace','file-detail','record-reference-picker','file-center'])w.eval(readFileSync(new URL('../../../shangshu-web/js/'+file+'.js',import.meta.url),'utf8').replace("await import('./resource-attribution.mjs')",'window.attributionModule'));
const originalFetch=globalThis.fetch; // directory uses global fetch; preserve transport before installing it
const notices=[],location={href:base+'/index.html#/excel'};
const source=ts.createSourceFile('main.ts',readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let createNode,uploadNode;const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='createAndOpen')createNode=n;else if(ts.isFunctionDeclaration(n)&&n.name?.text==='uploadAndOpen')uploadNode=n;else ts.forEachChild(n,visit);};visit(source);assert.ok(createNode);
const context={fetch:actualFetch,el:{picker:w.document.querySelector('#excel'),scope:{textContent:''}},signal:new AbortController().signal,notify:m=>notices.push(m),URL,location};
runInNewContext(ts.transpileModule(createNode.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.create=createAndOpen;',context);
context.btoa=btoa;context.Uint8Array=Uint8Array;context.console=console;
context.XMLHttpRequest=class extends w.XMLHttpRequest{send(body){this.addEventListener('load',()=>{const result=JSON.parse(this.responseText).result;calls.push({url:'/api/platform/actions/files.upload/execute',body:JSON.parse(body),status:this.status,result});if(result?.file&&!files.includes(result.file)){files.push(result.file);writeFileSync(manifest,JSON.stringify({files}));}});super.send(body);}};
assert.ok(uploadNode);runInNewContext(ts.transpileModule(uploadNode.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText+';globalThis.upload=uploadAndOpen;',context);
// actualFetch must use captured transport when directory's global fetch is installed.
const transport=originalFetch;globalThis.fetch=(url,init)=>typeof url==='string'&&url.startsWith('/')?actualFetch(url,init):transport(url,init);
let createPromise,uploadPromise;const directory=mountDirectory(w.document.querySelector('#excel'),{load:async()=>({entries:[],total:0,truncated:false}),open(){},upload:(file,attr)=>{uploadPromise=context.upload(file,attr);},create:(name,attr,key)=>{createPromise=context.create(name,attr,key);return createPromise;}});
const controller=new w.AbortController();
try{
 await directory.ready;const d=w.document.querySelector('#excel'),click=s=>d.querySelector(s).click();
 click('[data-new-table]');click('[data-attribution-cancel]');check('UI003 create cancellation zero action requests',calls.length===0);
 click('[data-new-table]');d.querySelector('[data-attribution-name-input]').value=prefix+'-created';click('[data-attribution-confirm]');click('[data-attribution-confirm]');await createPromise;
 const created=new URL(location.href).searchParams.get('object');check('UI003 production create opens returned file and duplicate confirm submits once',!!created&&calls.length===1&&calls[0].result.file===created);
 const replay=await actualFetch(calls[0].url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(calls[0].body)});check('UI003 repeated same key returns same resource',replay.status===200&&(await replay.json()).result.file===created);
 const sheet=await invoke('files.sheet_read',{table:created});check('UI003 newly created sheet independently readable',Array.isArray(sheet.rows));
 await until(()=>d.querySelector('[data-attribution-panel]').hidden);click('[data-new-table]');d.querySelector('[data-attribution-name-input]').value=prefix+'-unknown-department';
 await until(()=>Array.from(d.querySelector('[data-attribution-department]').options).some(o=>o.value===department));
 d.querySelector('[data-attribution-level]').value='department';d.querySelector('[data-attribution-department]').value=department;
 let lost=true;context.fetch=async(...args)=>{const response=await actualFetch(...args);if(lost){lost=false;throw new TypeError('controlled lost response after server commit');}return response;};
 click('[data-attribution-confirm]');await createPromise;await until(()=>!d.querySelector('[data-attribution-confirm]').disabled);
 const uncertain=calls.at(-1),count=files.length;click('[data-attribution-cancel]');check('UI003 unknown create keeps selected department and blocks cancel/new input',!d.querySelector('[data-attribution-panel]').hidden&&d.querySelector('[data-attribution-level]').disabled&&d.querySelector('[data-attribution-department]').value===department);
 click('[data-attribution-confirm]');await createPromise;await until(()=>d.querySelector('[data-attribution-panel]').hidden);
 check('UI003 unknown create retries exact payload/key against actual HTTP without duplicate',JSON.stringify(calls.at(-1).body)===JSON.stringify(uncertain.body)&&files.length===count&&calls.at(-1).result.file===uncertain.result.file);context.fetch=actualFetch;

 w.mountFileCenter(w.document.querySelector('#files'),{signal:controller.signal});await until(()=>{const label=w.document.querySelector('.preview-label');if(label.textContent==='读取失败')throw Error('file-center read failed: '+w.document.querySelector('#file-rows').textContent);return label.textContent==='已连接文件域'&&!w.document.querySelector('#upload').disabled;});
 const picker=w.document.querySelector('#file-picker');
 async function openUpload(name,bytes,attr='personal'){
  Object.defineProperty(picker,'files',{configurable:true,value:[new w.File([bytes],name)]});picker.dispatchEvent(new w.Event('change'));
  await until(()=>w.document.querySelector('.file-operation-dialog'));const modal=w.document.querySelector('.file-operation-dialog');
  modal.querySelector('[data-attribution-level]').value=attr;
  if(attr==='department'){await until(()=>Array.from(modal.querySelector('[data-attribution-department]').options).some(o=>o.value===department));modal.querySelector('[data-attribution-department]').value=department;}
  return modal;
 }
 const submit=m=>m.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));
 let n=calls.length,m=await openUpload(prefix+'-cancel.txt','never');m.querySelector('[data-cancel]').click();check('UI004 file selection then cancel zero writes',calls.length===n);
 m=await openUpload(prefix+'-invalid.exe','invalid');submit(m);await until(()=>m.querySelector('[data-status]').textContent.includes('不支持'));check('UI004 unsupported file rejected locally with zero writes',calls.length===n);m.querySelector('[data-cancel]').click();
 const filename=prefix+'-document.txt';
 m=await openUpload(filename,'original bytes');submit(m);submit(m);await until(()=>!m.isConnected);check('UI004 double submit creates one upload',calls.length===n+1);const documentFile=calls.at(-1).result.file;
 m=await openUpload(filename,'replacement bytes');submit(m);await until(()=>!m.isConnected);check('UI084 ordinary same-name upload increments original resource version',calls.at(-1).result.file===documentFile&&calls.at(-1).result.version===2);
 let versions=await invoke('files.versions',{file:documentFile});assert.equal(versions.versions.length,2);
 for(const v of versions.versions){const r=await actualFetch('/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:documentFile,file:v.frappe_file}));assert.equal(r.status,200);assert.equal(await r.text(),v.version_no===1?'original bytes':'replacement bytes');}
 check('UI084 current and historical bytes independently match both uploads',true);
 m=await openUpload(prefix+'-department.txt','department bytes','department');submit(m);await until(()=>!m.isConnected);const deptFile=calls.at(-1).result.file;const dept=await invoke('files.versions',{file:deptFile});check('UI104 upload selected authorized department persists',dept.file.attribution?.level==='department'&&dept.file.attribution?.department===department);
 const xbytes=readFileSync(xlsx);const beforeExcelUpload=calls.length;click('[data-upload]');d.querySelector('[data-attribution-level]').value='department';d.querySelector('[data-attribution-department]').value=department;click('[data-attribution-confirm]');const excelPicker=d.querySelector('[data-upload-input]');Object.defineProperty(excelPicker,'files',{value:[new File([xbytes],prefix+'-excel-entry.xlsx')]});excelPicker.dispatchEvent(new w.Event('change'));await uploadPromise;
 check('UI004 production Excel XHR upload uses selected department and opens actual file',calls.length===beforeExcelUpload+1&&calls.at(-1).status===200&&new URL(location.href).searchParams.get('object')===calls.at(-1).result.file&&calls.at(-1).body.payload.attribution.department===department);
 const ids=[];
 for(let i=0;i<2;i++){m=await openUpload(prefix+'-same.xlsx',xbytes);submit(m);await until(()=>!m.isConnected);ids.push(calls.at(-1).result.file);}
 check('UI004 same-name XLSX uploads create separate resources',ids[0]!==ids[1]);
 n=files.length;m=await openUpload(prefix+'-corrupt.xlsx','not an xlsx');submit(m);await until(()=>!m.isConnected||m.querySelector('[data-status]').textContent.includes('未完成 1'));if([400,417,422].includes(calls.at(-1).status)&&files.length===n){check('UI004 malformed XLSX fails HTTP without returned resource',true);}else{fail.push('UI004 malformed XLSX accepted');console.log('FAIL UI004 malformed XLSX accepted',calls.at(-1).status);}if(m.isConnected)m.querySelector('[data-cancel]').click();
 const ui=w.createToolWorkspace(w.document.querySelector('#files'));await w.openFileCenterDetail({ui,file:{id:documentFile,name:filename}});const detail=w.document.querySelector('.file-detail-dialog');assert.ok(detail);
 for(const [key,value] of [['file_name',prefix+'-renamed.txt'],['tags','验收；历史'],['note','人工备注保持']]){
  const input=detail.querySelector('[data-property='+key+']');input.ondblclick();input.value=value;input.onblur();await until(()=>detail.querySelector('[data-save-state]').textContent==='已保存');
  const now=await invoke('files.versions',{file:documentFile});assert.deepEqual(now.file[key],key==='tags'?['验收','历史']:value);
 }
 const versionPicker=detail.querySelector('input[type=file]');Object.defineProperty(versionPicker,'files',{value:[new w.File(['third version bytes'],prefix+'-renamed.txt')]});await versionPicker.onchange();await until(()=>!detail.isConnected);
 versions=await invoke('files.versions',{file:documentFile});check('UI084 production detail reupload preserves name tags note directory and history',versions.file.directory==='/'&&versions.versions.length===3&&versions.file.note==='人工备注保持'&&versions.file.file_name===prefix+'-renamed.txt'&&JSON.stringify(versions.file.tags)===JSON.stringify(['验收','历史']));
 for(const v of versions.versions){const r=await actualFetch('/api/platform/file-content?'+new URLSearchParams({ref:'Shangshu File Center File',ref_name:documentFile,file:v.frappe_file}));assert.equal(r.status,200);assert.equal(await r.text(),({1:'original bytes',2:'replacement bytes',3:'third version bytes'})[v.version_no]);}
 check('UI084 detail reupload keeps all three immutable byte versions',true);
 ui.dispose();writeFileSync(manifest,JSON.stringify({files,created,documentFile,deptFile,passes:pass,failures:fail,calls:calls.map(c=>({url:c.url,status:c.status}))}));
 console.log('RESULT',pass.length,'/',pass.length+fail.length);if(fail.length)process.exitCode=1;
}finally{directory.dispose();controller.abort();globalThis.fetch=originalFetch;dom.window.close();}
