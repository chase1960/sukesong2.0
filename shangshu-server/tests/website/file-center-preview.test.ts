import {it} from 'node:test';
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('吸顶表头必须有不透明底层，不能让文件行透出',()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/file-center.css',import.meta.url),'utf8');
  const rule=css.match(/\.file-table th\{([^}]+)\}/)?.[1]||'';
  assert.match(rule,/background-color:var\(--card\)/);
  assert.match(rule,/background-image:linear-gradient/);
});

it('审核工作面：修改待确认值自动勾选，整批确认校验空值且不假写正式记录',async()=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/file-center',runScripts:'outside-only'}),w=dom.window as any;
  w.fetch=()=>{throw new Error('建设页不得访问业务接口');};
  w.RENDER={};w.currentRole=()=> 'admin';
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  w.eval(readFileSync(new URL('../../../shangshu-web/js/file-detail.js',import.meta.url),'utf8'));
  w.eval(browserModuleSource(w,readFileSync(new URL('../../../shangshu-web/js/file-center.js',import.meta.url),'utf8')));
  const controller=new w.AbortController();
  w.RENDER['file-center']({host:w.document.querySelector('#host'),signal:controller.signal});
  try{
    // 首次连接完成（本例失败）后才允许操作范围，不能点击暂时禁用的控件。
    await new Promise(resolve=>setTimeout(resolve,25));
    // 默认空态
    w.document.querySelector('[data-view="review"]').click();
    assert.match(w.document.querySelector('#review-area').textContent,/当前没有待核对事项/);
    assert.equal(w.document.querySelector('#review-footer').hidden,true);
    // 开样例后进入审核
    w.document.querySelector('[data-view="all"]').click();
    w.document.querySelector('#examples-toggle').click();
    w.document.querySelector('[data-view="review"]').click();
    assert.equal(w.document.querySelectorAll('.cr-case-card').length,2);
    assert.match(w.document.querySelector('#review-count').textContent,/2/);
    // 修改待确认值 → 自动勾选
    const field=w.document.querySelector('[data-review-value="R1.official_title"]');
    field.value='挡雨板连接机构（修订）';
    field.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelector('[data-review-check="R1.official_title"]').checked,true);
    assert.match(w.document.querySelector('#review-selected').textContent,/已选 1 项/);
    // 卡片全选覆盖本卡 3 项；顶部全选覆盖两卡 4 项
    w.document.querySelector('[data-card-check]').click();
    assert.match(w.document.querySelector('#review-selected').textContent,/已选 3 项/);
    w.document.querySelector('#review-select-all').click();
    assert.match(w.document.querySelector('#review-selected').textContent,/已选 4 项/);
    // 清空一个已勾选值 → 确认被空值校验拦下
    field.value='';
    w.document.querySelector('#review-confirm').click();
    assert.match(w.document.querySelector('#review-result').textContent,/请先补全已选项的待确认值/);
    // 恢复值 → 确认给出未接后端的诚实回执，且保留勾选不冒充已写入
    field.value='挡雨板连接机构';
    w.document.querySelector('#review-confirm').click();
    assert.match(w.document.querySelector('#review-result').textContent,/未连接保存服务/);
    assert.equal(w.document.querySelectorAll('[data-review-check]:checked').length,4,'不悄悄清空勾选');
    // 预览附件弹层可开可关
    w.document.querySelector('[data-review-preview]').click();
    assert.ok(w.document.querySelector('dialog.cr-preview'));
    w.document.querySelector('dialog.cr-preview [data-close]').click();
    assert.equal(w.document.querySelector('dialog.cr-preview'),null);
    // 切回全部文件，列表视图恢复
    w.document.querySelector('[data-view="all"]').click();
    assert.equal(w.document.querySelector('#review-area').hidden,true);
    assert.equal(w.document.querySelector('.file-table').hidden,false);
  }finally{controller.abort();dom.window.close();}
});

it('真实链：files 域可用时接管列表/详情/回收，动作走公共路由',async()=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/file-center',runScripts:'outside-only'}),w=dom.window as any;
  w.RENDER={};w.currentRole=()=> 'admin';
  const calls:any[]=[];
  const rows=[
    {name:'FC-0001',file_name:'验收合同.txt',directory:'/验收',tags:'合同；重要',owner:'wzj@shangshu.local',status:'Active',note:'',version_count:2,current_size:12,modified:'2026-09-21T10:00:00',current_file:'FILE-1'},
    {name:'FC-0002',file_name:'旧版截图.png',directory:'/验收',tags:'',owner:'wzj@shangshu.local',status:'Recycled',note:'',version_count:1,current_size:4096,modified:'2026-09-20T09:00:00',current_file:'FILE-2'},
  ];
  w.fetch=async(url:string,init?:any)=>{
    calls.push({url:String(url),method:init?.method||'GET',body:init?.body});
    if(String(url).startsWith('/api/session'))return {ok:true,json:async()=>({authed:true,user:{username:'wzj'}})} as any;
    if(String(url).includes('/datasets/files.file/records')){
      const filters=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}');
      const selected=rows.filter(row=>row.status===(filters.scope==='trash'?'Recycled':'Active'));
      return {ok:true,json:async()=>({ok:true,rows:selected,total:selected.length,page:1,page_length:20})} as any;
    }
    if(String(url).includes('/services/files.versions/invoke'))return {ok:true,json:async()=>({ok:true,file:{...rows[0],tags:['合同','重要'],can_edit:true,metadata_revision:true},versions:[{version_no:2,size:12,uploaded_at:'2026-09-21',frappe_file:'FILE-1'},{version_no:1,size:10,uploaded_at:'2026-09-20',frappe_file:'FILE-0'}]})} as any;
    if(String(url).includes('/actions/files.recycle/execute'))return {ok:true,json:async()=>({ok:true,result:{file:'FC-0001',status:'Recycled'}})} as any;
    if(String(url).includes('/file-content'))return {ok:true,json:async()=>({}),text:async()=>'文本内容（示例）'} as any;
    return {ok:true,json:async()=>({ok:true}),text:async()=>''} as any;
  };
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  w.eval(readFileSync(new URL('../../../shangshu-web/js/file-detail.js',import.meta.url),'utf8'));
  w.eval(browserModuleSource(w,readFileSync(new URL('../../../shangshu-web/js/file-center.js',import.meta.url),'utf8')));
  const controller=new w.AbortController();
  w.RENDER['file-center']({host:w.document.querySelector('#host'),signal:controller.signal});
  await new Promise(r=>setTimeout(r,20));
  try{
    // 真实链接管：上传可用、样例入口隐藏、只列在库文件
    assert.equal(w.document.querySelector('#upload').disabled,false);
    assert.equal(w.document.querySelector('#upload').textContent,'上传文件');
    assert.equal(w.document.querySelector('#examples-toggle').hidden,true);
    assert.equal(w.document.querySelectorAll('tr[data-file]').length,1);
    assert.match(w.document.querySelector('tbody').textContent,/验收合同/);
    assert.match(w.document.querySelector('tbody').textContent,/\/验收/);
    // 回收站列出已回收
    w.document.querySelector('[data-view="trash"]').click();
    await new Promise(r=>setTimeout(r,20));
    assert.equal(w.document.querySelectorAll('tr[data-file]').length,1);
    assert.match(w.document.querySelector('tbody').textContent,/旧版截图/);
    w.document.querySelector('[data-view="all"]').click();
    await new Promise(r=>setTimeout(r,20));
    // 详情：版本历史 + 下载链接 + 回收两步走真实动作
    await w.document.querySelector('[data-open]').click();
    await new Promise(r=>setTimeout(r,30));
    const detail=w.document.querySelector('.file-detail-dialog');
    assert.match(detail.textContent,/第 2 版/);
    assert.match(detail.textContent,/第 1 版/);
    assert.ok(detail.querySelector('[data-current-download]')?.getAttribute('href').includes('file-content'));
    const trash=detail.querySelector('[data-recycle]');
    trash.click();
    assert.match(trash.textContent,/确认移入回收站/);
    trash.click();
    await new Promise(r=>setTimeout(r,20));
    const recycleCall=calls.find(c=>c.url.includes('/actions/files.recycle/execute'));
    assert.ok(recycleCall,'回收动作必须走公共动作路由');
    assert.match(recycleCall.body,/FC-0001/);
    assert.match(recycleCall.body,/confirmed/);
  }finally{controller.abort();dom.window.close();}
});

it('文件中心原型：筛选、详情、回收恢复均在当前页面完成，不请求业务接口',()=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/file-center',runScripts:'outside-only'}),w=dom.window as any;
  w.fetch=()=>{throw new Error('原型不得访问业务接口');};
  w.RENDER={};w.currentRole=()=> 'admin';
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  w.eval(browserModuleSource(w,readFileSync(new URL('../../../shangshu-web/js/file-center.js',import.meta.url),'utf8')));
  const controller=new w.AbortController();
  w.RENDER['file-center']({host:w.document.querySelector('#host'),signal:controller.signal});
  try{
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,0);
    assert.equal(w.document.querySelector('#upload').disabled,true);
    w.document.querySelector('#examples-toggle').click();
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,8);
    w.document.querySelector('[data-layout="grid"]').click();
    assert.equal(w.document.querySelectorAll('.file-tile').length,8);
    w.document.querySelector('[data-layout="groups"]').click();
    assert.ok(w.document.querySelector('details.file-group'));
    w.document.querySelector('[data-layout="list"]').click();
    const limit=w.document.querySelector('#page-size');limit.insertAdjacentHTML('beforeend','<option value="2">2</option>');limit.value='2';limit.dispatchEvent(new w.Event('change'));
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,2);
    w.document.querySelector('#select-page').click();
    assert.match(w.document.querySelector('#selection-count').textContent,/已选 2/);
    w.document.querySelector('#next-page').click();
    assert.match(w.document.querySelector('#page-info').textContent,/第 2/);
    w.document.querySelector('[data-layout="grid"]').click();
    assert.equal(w.document.querySelectorAll('.file-tile').length,2);
    w.document.querySelector('#batch-change').click();
    w.document.querySelector('[data-view="trash"]').click();
    w.document.querySelector('#select-page').click();w.document.querySelector('#batch-change').click();
    w.document.querySelector('[data-view="all"]').click();
    limit.value='20';limit.dispatchEvent(new w.Event('change'));
    w.document.querySelector('[data-layout="list"]').click();
    const search=w.document.querySelector('#search');search.value='入职';search.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,1);
    w.document.querySelector('[data-open]').click();
    assert.equal(w.document.querySelector('#details').hidden,false);
    assert.match(w.document.querySelector('#details').textContent,/入职/);
    w.document.querySelector('#trash-file').click();
    search.value='';search.dispatchEvent(new w.Event('input'));
    w.document.querySelector('[data-view="trash"]').click();
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,1);
    w.document.querySelector('[data-open]').click();w.document.querySelector('#restore-file').click();
    assert.match(w.document.querySelector('tbody').textContent,/回收站是空的/);
    w.document.querySelector('[data-view="all"]').click();
    assert.equal(w.document.querySelectorAll('tbody tr[data-file]').length,8);
    search.value='<script>';search.dispatchEvent(new w.Event('input'));
    assert.match(w.document.querySelector('tbody').textContent,/没有找到/);
    assert.equal(w.document.querySelectorAll('tbody script').length,0);
  }finally{controller.abort();dom.window.close();}
});
