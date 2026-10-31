import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
function mount(){const dom=new JSDOM('',{runScripts:'outside-only',url:'http://localhost'}),w=dom.window as any;w.eval(readFileSync(new URL('../../../shangshu-web/js/file-detail.js',import.meta.url),'utf8'));return {dom,w};}
test('缩略预览只读原受权版本，文本限长；DOCX用原正文预览服务',async()=>{
  const {dom,w}=mount(),calls:any[]=[];
  w.fetch=async(url:string,init:any)=>{calls.push({url,init});return url.includes('platform.file.preview')?{ok:true,json:async()=>({result:{blocks:[{type:'paragraph',text:'合同摘要'}]}})}:{ok:true,text:async()=>'<script>不执行</script>'+ '正文'.repeat(1000)};};
  try{const text=await w.readFileCenterThumbnail({id:'one',name:'说明.md',currentFile:'v1',size:80});assert.equal(text.kind,'text');assert.ok(text.text.length<=400);assert.match(calls[0].url,/ref_name=one&file=v1/);
    const docx=await w.readFileCenterThumbnail({id:'two',name:'合同.docx',currentFile:'v2',size:100});assert.equal(docx.text,'合同摘要');assert.deepEqual(JSON.parse(calls[1].init.body).payload,{ref_doctype:'Shangshu File Center File',ref_name:'two',file:'v2'});
  }finally{dom.window.close();}
});
test('大文件和不支持格式保留图标，不为缩略图下载全部原件',async()=>{
  const {dom,w}=mount();let calls=0;w.fetch=()=>{calls++;throw Error('不应下载');};
  try{assert.equal(await w.readFileCenterThumbnail({id:'one',name:'大文档.md',size:2*1024*1024}),null);assert.equal(await w.readFileCenterThumbnail({id:'two',name:'预算.xlsx',size:30}),null);assert.equal(calls,0);}finally{dom.window.close();}
});
test('版本不可读取时缩略图拒绝，不猜另一原件或访问裸文件URL',async()=>{
  const {dom,w}=mount(),calls:string[]=[];w.fetch=async(url:string)=>{calls.push(url);return {ok:false,status:403,json:async()=>({error:'没有权限'})};};
  try{await assert.rejects(()=>w.readFileCenterThumbnail({id:'one',name:'说明.md',size:80}),/没有权限/);assert.equal(calls.length,1);assert.match(calls[0],/files.versions\/invoke/);}finally{dom.window.close();}
});
