import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText} from '../helpers/toast.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
/** 等写请求**静下来**再数条数。
 *  失焦自动保存是 120ms 防抖（mail-center.js 的 blurSaveTimer），而这里原来只等
 *  10ms 就数 —— 机器一忙就抖：有时还没发（0），有时叠成两次（2）。
 *  等到条数连续 250ms 不变再断言；**真有重复保存照样会被数成 2**，不会被这个掩盖。 */
async function settleWrites(writes:any[],quietMs=250,limitMs=3000){
  let last=-1,lastChange=Date.now();
  for(const start=Date.now();Date.now()-start<limitMs;){
    await new Promise(r=>setTimeout(r,20));
    if(writes.length!==last){last=writes.length;lastChange=Date.now();}
    else if(Date.now()-lastChange>=quietMs)break;
  }
  return writes.length;
}
const seed={name:'mail-one',subject:'已存草稿',body:'真实正文',to:['reader@example.invalid'],cc:[],status:'Draft',record_version:1,owner:'owner@example.invalid',modified:'2026-09-22 10:00:00'};
/* 本轮按新目标补可见存草稿按钮；历史失焦与快捷键保存链保持。
   本文件的历史保存边界继续使用原两个入口验证：
   - triggerSave = **失焦**自动存（120ms 防抖）。只派发 blur、不派发 focusout ——
     focusout 会顺带触发「单字段失焦保存」，多发一个只含单字段的请求，测的就不是整封信了。
   - pressSave = Ctrl/⌘S 手存。失焦在「上次保存结果待核实」时会被 autosaveOnBlur 拦掉，
     只有手存能重放原请求 —— 所以凡断言「重放原请求 / 幂等键不变」的地方都用手存。 */
async function triggerSave(w:any){
  const ed=w.document.querySelector('.mail-body-editor')||w.document.querySelector('#c-body');
  if(ed){ed.blur?.();ed.dispatchEvent(new w.FocusEvent('blur',{bubbles:true}));}
  await new Promise(r=>setTimeout(r,320)); // 比 120ms 防抖长
}
function pressSave(w:any){
  const event=new w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true});
  w.document.querySelector('#detail').dispatchEvent(event);
  return event;
}
it('空邮箱明确进入独立示例，示例阅读不调用真实写口，退出重读原空邮箱',async()=>{
  const calls:string[]=[];const t=mount(url=>{calls.push(url);return {rows:[],total:0};});
  try{await tick();const button=t.w.document.querySelector('[data-mail-examples]');assert.ok(button);button.click();assert.match(t.w.document.querySelector('.preview-label').textContent,/样例.*不发送/);assert.ok(t.w.document.querySelectorAll('[data-mail]').length>0);
    const before=calls.length;t.w.document.querySelector('[data-mail]').click();assert.equal(calls.length,before);assert.equal(calls.some(url=>url.includes('/actions/')),false);
    t.w.document.querySelector('#examples-toggle').click();await tick();assert.equal(t.w.document.querySelectorAll('[data-mail]').length,0);
  }finally{t.dispose();}
});
function mount(handler:(url:string,body:any)=>any,examples=false,url='http://localhost/index.html#/mail'){
  const dom=new JSDOM('<div id="host"></div>',{url,runScripts:'outside-only'});
  const w=dom.window as any;w.RENDER={};w.currentRole=()=> 'admin';
  w.fetch=async(url:string,options:any={})=>{
    if(url.includes('/services/mail.account.status/'))return {ok:true,status:200,json:async()=>({result:{account:{bound:false}}})};
    // 页面现在会读一次「我能进哪些邮箱」（共享邮箱切换器 + 按权限收入口）。
    // 这条与本文件各用例断言的**详情读/写**无关，预接掉，免得污染每条的调用列表。
    if(url.includes('/services/mail.mailboxes/'))return {ok:true,status:200,json:async()=>({result:{mailboxes:[]}})};
    // 新待审信号是独立只读查询；不交给各保存/详情用例的写入handler。
    if(url.includes('/api/platform/action-proposals')&&!options.method)return {ok:true,status:200,json:async()=>({ok:true,list:[]})};
    const result=await handler(url,options.body?JSON.parse(options.body):null);
    return {ok:!result.error,status:result.status||(!result.error?200:400),json:async()=>result};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for(const file of ['tool-workspace','file-reference-picker','mail-center'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8'));
  const dispose=w.mountMailCenter(w.document.querySelector('#host'),{examples});
  return {w,dispose:()=>{dispose();dom.window.close();}};
}

it('未绑定邮箱身份只显示一次，管理动作有独立工具区且保留写邮件入口',async()=>{
  const t=mount(()=>({rows:[],total:0}));
  try{await tick();await tick();const $=(s:string)=>t.w.document.querySelector(s);
    /* 文案按现行口径：未绑定邮箱时这一格说的是「本人草稿（未绑定邮箱）」——
       要跟「已绑定本人邮箱」「连接状态未确认」区分开（旧断言写的裸「未绑定邮箱」
       是老口径，早已不是产品文案）。断言仍钉住「未绑定」这层意思。 */
    assert.match($('#mailbox-switch').textContent||'',/未绑定邮箱/,
      `未绑定邮箱时邮箱切换器该说清是未绑定，实际：${$('#mailbox-switch').textContent}`);
    assert.equal($('.preview-label').hidden,true,'与邮箱切换器重复的状态应收起');
    assert.ok($('#accounts-btn').closest('.mail-management-actions'),'设置、签名和权限需在同一管理区');
    assert.ok($('#compose').closest('.mail-heading'));
  }finally{t.dispose();}
});

it('邮件选择有独立点击热区，不打开邮件；主题收件人日期和附件状态仍可核对',async()=>{
 let detailReads=0;const row={...seed,subject:'很长的合成验收主题用于截断但可通过提示核对完整内容',attachment_count:2};
 const t=mount(url=>{if(url.includes('/datasets/'))return {rows:[row],total:1};if(url.includes('mail.detail'))detailReads++;return {result:{mail:row}};});try{await tick();await tick();const d=t.w.document,check=d.querySelector('[data-mail-select]'),hit=check.closest('label');
  assert.ok(hit,'选择框应有独立label热区，不只允许点14px的小方框');assert.equal(hit.querySelector('[data-open]'),null,'选择与打开不能套在同一个点击热区');
  hit.click();assert.equal(check.checked,true);assert.match(d.querySelector('#mail-selection-count').textContent,/已选择 1 封/);assert.equal(detailReads,0,'点选择热区不能误开或标记已读');
  const item=d.querySelector('[data-open]');assert.equal(item.querySelector('.subject').title,row.subject);assert.match(item.querySelector('.mail-item-person').title,/reader@example.invalid/);assert.match(item.querySelector('.date').textContent,/2026-09-22 10:00/);assert.match(item.textContent,/附件 2/);assert.match(item.textContent,/草稿/);
 }finally{t.dispose();}
});

it('邮件引用落点读取本人详情，不要求目标在第一页，不按主题搜索猜邮件',async()=>{
  const reads:any[]=[];
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[],total:0};reads.push(body);return {result:{mail:seed}};},false,'http://localhost/index.html?mail=mail-one#/mail');
  try{await tick();await tick();assert.equal(t.w.document.querySelector('#c-subject')?.value,seed.subject);assert.deepEqual(reads,[{payload:{mail:'mail-one'}}]);}
  finally{t.dispose();}
});

it('邮件引用被拒绝不能打开草稿、猜测数据或发起写入',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[],total:0};if(url.includes('/actions/'))writes.push(body);return {error:'只能访问自己的邮件',status:403};},false,'http://localhost/index.html?mail=private-other#/mail');
  try{await tick();await tick();assert.equal(t.w.document.querySelector('#c-subject'),null);assert.equal(writes.length,0);
    // 读取被拒的提示走右下角 toast 公共件，且是错误色（红）+ alert 语义
    const toast=t.w.document.querySelector('#toast-zone .toast') as any;
    assert.ok(toast,'读取被拒没走右下角 toast 公共件');
    assert.match(toast.textContent||'',/只能访问自己的邮件/);
    assert.ok(toast.classList.contains('toast-error'),`读取被拒没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'),'alert','错误提示该用 alert 语义');
    assert.equal(t.w.document.querySelector('#notice'),null,'页面里又贴回了 #notice');
  }
  finally{t.dispose();}
});

it('HTML草稿沿原邮件编辑和保存，默认预览表格且格式不因改主题丢失',async()=>{
  const html={...seed,body_format:'HTML',body:'<table><tr><td>案件A001</td><td>150.00</td></tr></table>'};
  const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/'))return {rows:[html],total:1};
    if(url.includes('/services/'))return {result:{mail:html}};
    writes.push(body);return {result:{...html,...body.payload,record_version:2}};
  });
  try{
    await tick();t.w.document.querySelector('[data-open]').click();await tick();
    /* ★ 2026-10-21：正文面不再另挂「渲染窗」（iframe）—— 父线：「我只要所见即所得，不要两个面」。
       本夹具**没装**邮件域的编辑器模块 ⇒ 正文面走**纯文本**兜底（HTML 一个字节都不注入工作面）。 */
    assert.equal(t.w.document.querySelector('iframe[title="邮件正文预览"]'),null,'不该再挂第二个渲染窗');
    const field=t.w.document.querySelector('#c-body') as any;
    assert.ok(field,'草稿没有可编辑的正文位');
    assert.match(field.value,/<table>/,'草稿正文里的表格丢了');
    input(t.w,'#c-subject','核对后的主题');leaveField(t.w,'#c-subject');await tick();
    assert.equal(writes.length,1);assert.equal(writes[0].payload.body_format,'HTML');
    assert.equal(writes[0].payload.body,html.body);
  }finally{t.dispose();}
});

/* ★ 2026-10-21（父线定方向：「我只要所见即所得，不要两个面」「读信的时候是快照哦」）：
   读信正文改成**所见即所得的只读快照**（父文档里渲染，跟写信窗同一个面），
   不再挂 `<iframe sandbox srcdoc>` 那个第二面 ——
   那个面在渲染不出来的浏览器里只剩一个空边框框（用户 2026-10-21 报「读信正文整块空白」）。
   **护栏的实质一条没松**：外部内容进 DOM 前照样过净化门 ——
   脚本/事件属性/外链图一律不许进工作面，外部请求照旧不发起。 */
it('已发送HTML正文在所见即所得只读快照里展示，外部内容的危险部分不进工作面',async()=>{
  const html={...seed,status:'Sent',body_format:'HTML',
    body:'<table><tr><td>核对结果</td></tr></table><script>window.__pwned=1</script>'
      +'<p onclick="window.__clicked=1">带事件的段落</p><img src="https://tracker.invalid/pixel.png">'
      +'<p>正常文字</p>'};
  const t=mount(url=>url.includes('/datasets/')?{rows:[html],total:1}:{result:{mail:html}});
  try{
    await tick();t.w.document.querySelector('[data-open]').click();await tick();
    /* 本夹具**没装**邮件域的编辑器模块 ⇒ 正文面走**纯文本**兜底：
       原 HTML 一个字节都不进工作面（连表格都不注入），危险部分更进不来。
       线上（有编辑器模块）时正文面是所见即所得的只读快照，
       那条口径由 mail-body-blank-fallback / mail-html-table-cid 钉。 */
    const surface=t.w.document.querySelector('#detail');
    assert.ok(surface,'详情区没画出来');
    assert.equal(t.w.document.querySelector('#detail table'),null,'原HTML被注入工作面了');
    assert.equal(surface.querySelector('script'),null,'script 进了工作面');
    assert.equal(surface.querySelector('[onclick]'),null,'事件属性进了工作面');
    assert.equal(surface.querySelector('img[src^="http"]'),null,'外链图进了工作面（会发外部请求）');
    const text=(surface.textContent||'').replace(/\s+/g,' ');
    assert.match(text,/正常文字/,'正文文字不该被误伤');
    assert.match(text,/核对结果/,'正文没显示');
  }finally{t.dispose();}
});
function input(w:any,id:string,value:string){const el=w.document.querySelector(id);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));}
function leaveField(w:any,id:string,relatedTarget:any=null){w.document.querySelector(id).dispatchEvent(new w.FocusEvent('focusout',{bubbles:true,relatedTarget}));}

it('写信直接输入主题，Ctrl/Cmd S 复用存草稿；失焦后仍可直接继续输入',async()=>{
  const writes:any[]=[];const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[],total:0};writes.push(body);return {result:{...seed,...body.payload,record_version:2}};});
  try{await tick();t.w.document.querySelector('#compose').click();const subject=t.w.document.querySelector('#c-subject');assert.equal(subject.readOnly,false);input(t.w,'#c-subject','键盘草稿');input(t.w,'#c-to','reader@example.invalid');input(t.w,'#c-body','待核对正文');const event=new t.w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true});subject.dispatchEvent(event);await tick();assert.equal(event.defaultPrevented,true);assert.equal(writes.length,1);assert.equal(writes[0].payload.subject,'键盘草稿');assert.equal(writes[0].payload.body,'待核对正文');assert.equal(subject.readOnly,false);assert.ok(t.w.document.querySelector('#c-subject'),'保存不退出写信');}finally{t.dispose();}
});

it('姓名和地址一起保存，刷新重开仍分别显示，不把显示名丢掉',async()=>{
  let stored:any={...seed};const writes:any[]=[];
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[stored],total:1};if(url.includes('/services/'))return {result:{mail:stored}};writes.push(body);stored={...stored,...body.payload,record_version:2};return {result:stored};});
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();input(t.w,'#c-to','张工 <zhang@example.invalid>；王工 <wang@example.invalid>');leaveField(t.w,'#c-to');await tick();assert.deepEqual(writes[0].payload.to,['张工 <zhang@example.invalid>','王工 <wang@example.invalid>']);t.w.document.querySelector('#c-cancel').click();t.w.document.querySelector('[data-open]').click();await tick();assert.match(t.w.document.querySelector('#c-to').value,/张工 <zhang@example.invalid>/);assert.doesNotMatch(t.w.document.querySelector('#c-to').value,/<<|>>/);}
  finally{t.dispose();}
});

it('附件区内选择搜索不保存，离开整区仅保存附件，不夹带正文；主题支持键盘编辑',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/mail'))return {rows:[seed],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('mail.detail'))return {result:{mail:seed}};
    if(url.includes('/datasets/files'))return {rows:[{name:'lib',file_name:'附件.txt'}],total:1};
    if(url.includes('files.versions'))return {versions:[{frappe_file:'file-v1',version_no:1,size:10}]};
    writes.push(body);return {result:{...seed,record_version:2,attachments:[{file:'bound',name:'附件.txt',label:'第 1 版'}],attachment_bindings:{'file-v1':'bound'}}};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    const subject=t.w.document.querySelector('#c-subject');assert.equal(subject.readOnly,false);
    input(t.w,'#c-body','不应随附件提交');t.w.document.querySelector('[data-attachment-value]').click();await tick();
    /* FIX-16：附件选择改走**公共居中弹窗**（.os-dialog），不再在正文旁就地展开。 */
    const dlg=t.w.document.querySelector('dialog.os-dialog');assert.ok(dlg,'附件选择应开公共弹窗');
    dlg.querySelector('[data-pick-file]').click();await tick();dlg.querySelector('[data-pick-version]').click();await tick();
    /* 暂存阶段（还没点「确认添加」）不写库 */
    assert.equal(writes.length,0,'选中的暂存阶段不该写库');
    dlg.querySelector('[data-act="1"]').click();await tick();
    assert.equal(writes.length,0,'确认添加本身不写库（离开整区才保存）');
    leaveField(t.w,'[data-attachment-value]',subject);await settleWrites(writes);assert.equal(writes.length,1);assert.equal(writes[0].payload.body,seed.body);assert.deepEqual(writes[0].payload.attachments,['file-v1']);
    assert.equal(t.w.document.querySelector('#c-body').value,'不应随附件提交');assert.equal(t.w.document.querySelector('#dirty-note').hidden,false);
  }finally{t.dispose();}
});

it('附件选择器可选 Excel 表格：走受管快照，只引用返回的 file（BASE967-15 / req 6）',async()=>{
  const writes:any[]=[];const snapshots:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/mail'))return {rows:[seed],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('mail.detail'))return {result:{mail:seed}};
    if(url.includes('/datasets/files')){
      /* FIX-16：普通文件与 Excel 表格**同一份列表**（scope=attachable），
         不再需要切「普通文件 / Excel」下拉 —— 两种都在这一页里。 */
      return {rows:[{name:'lib',file_name:'附件.txt'},{name:'SHEET1',file_name:'晋升表.xlsx',file_kind:'表格'}],total:2};
    }
    if(url.includes('files.sheet_snapshot')){
      snapshots.push(body);
      return {result:{file:'snap-file',lib:'snap-lib',file_name:'晋升表-v12-20261017.xlsx',
                      content_version:12,sha256:'abc',size:1234,
                      snapshot_of:'SHEET1',snapshot_version:12}};
    }
    if(url.includes('files.versions'))return {versions:[{frappe_file:'file-v1',version_no:1,size:10}]};
    writes.push(body);
    return {result:{...seed,record_version:2,
      attachments:[{file:'snap-file',name:'晋升表-v12-20261017.xlsx',label:'快照 v12'}],
      attachment_bindings:{'snap-file':'snap-file'}}};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    t.w.document.querySelector('[data-attachment-value]').click();await tick();
    const dlg=t.w.document.querySelector('dialog.os-dialog');assert.ok(dlg,'附件选择应开公共弹窗');
    /* 一份列表：普通文件与 Excel 表格同时在列（不再切下拉） */
    const names=[...dlg.querySelectorAll('[data-pick-file]')].map(b=>b.textContent||'');
    assert.ok(names.some(n=>/附件\.txt/.test(n)),'普通文件应在同一份列表里');
    assert.ok(names.some(n=>/晋升表\.xlsx/.test(n)),'Excel 表格应在同一份列表里');
    const row=[...dlg.querySelectorAll('[data-pick-file]')].find(b=>/晋升表\.xlsx/.test(b.textContent||'')) as any;
    assert.ok(row,'列表里应能找到 xlsx 那行');
    row.click();await tick();await tick();
    /* 取快照：带 table + op_id；不取 versions */
    assert.equal(snapshots.length,1,`应调用一次 files.sheet_snapshot，实际 ${snapshots.length}`);
    assert.equal(snapshots[0].payload.table,'SHEET1');
    assert.ok(String(snapshots[0].payload.op_id||'').length>=8,'快照必须带幂等键 op_id');
    /* 确认添加后：选中项显示快照名；保存载荷只带 file 引用 */
    dlg.querySelector('[data-act="1"]').click();await tick();
    assert.match(t.w.document.querySelector('[data-attachment-selected]')?.textContent||'',/晋升表-v12-20261017\.xlsx/);
    leaveField(t.w,'[data-attachment-value]',t.w.document.querySelector('#c-subject'));await tick();await tick();
    assert.equal(writes.length,1,'选完附件离开应触发一次保存');
    assert.deepEqual(writes[0].payload.attachments,['snap-file'],'保存载荷只能带快照返回的 file，不带路径/库名');
  }finally{t.dispose();}
});

it('没有下载权时选 Excel 表格：给可读提示，不加入任何附件（BASE967-15）',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/mail'))return {rows:[seed],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('mail.detail'))return {result:{mail:seed}};
    if(url.includes('/datasets/files'))return {rows:[{name:'SHEET1',file_name:'晋升表.xlsx',file_kind:'表格'}],total:1};
    if(url.includes('files.sheet_snapshot'))return {error:'无权下载该文件',status:403};
    writes.push(body);return {result:{...seed,record_version:2}};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    t.w.document.querySelector('[data-attachment-value]').click();await tick();
    const dlg=t.w.document.querySelector('dialog.os-dialog');assert.ok(dlg,'附件选择应开公共弹窗');
    (dlg.querySelector('[data-pick-file]') as any).click();await tick();await tick();
    const text=(dlg.textContent||'');
    assert.match(text,/下载|权限/,`403 要给能看懂的提示，实际：${text.slice(0,120)}`);
    assert.doesNotMatch(t.w.document.querySelector('[data-attachment-selected]')?.textContent||'',/晋升表/);
  }finally{t.dispose();}
});

it('字段失焦只保存这一项，其他非法/未完成输入不提交，不重绘正在编辑的控件',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[seed],total:1};if(url.includes('/services/'))return {result:{mail:seed}};writes.push(body);return {result:{...seed,...body.payload,record_version:2}};});
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    const body=t.w.document.querySelector('#c-body');input(t.w,'#c-to','未填写完的地址');input(t.w,'#c-body','单字段正文');leaveField(t.w,'#c-body');await tick();
    assert.equal(writes.length,1);assert.equal(writes[0].payload.body,'单字段正文');assert.deepEqual(writes[0].payload.to,seed.to);
    assert.equal(t.w.document.querySelector('#c-body'),body);assert.equal(t.w.document.querySelector('#c-to').value,'未填写完的地址');
    assert.equal(t.w.document.querySelector('#dirty-note').hidden,false);
    leaveField(t.w,'#c-body');await tick();assert.equal(writes.length,1);
  }finally{t.dispose();}
});

it('快速跨字段失焦串行保存且承接新记录ID/版本，回执不丢保存期间新输入',async()=>{
  const writes:any[]=[];let finish:(v:any)=>void=()=>{};
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[],total:0};writes.push(body);if(writes.length===1)return new Promise(resolve=>{finish=resolve;});return {result:{...seed,...body.payload,record_version:2}};});
  try{await tick();t.w.document.querySelector('#compose').click();input(t.w,'#c-body','提交正文');leaveField(t.w,'#c-body');await tick();
    input(t.w,'#c-subject','提交主题');leaveField(t.w,'#c-subject');input(t.w,'#c-body','后续未离开的正文');await tick();assert.equal(writes.length,1);
    finish({result:{...seed,subject:'',to:[],body:'提交正文'}});await tick();await tick();
    /* 排队的那一项由产品自己补发（mail-center.js 的 finally 里按队列发下一项）。
       这里**不许**再手动失焦一次把值发出去 —— 那等于替产品干活，会把
       「补发死了」这个真毛病测成绿的。 */
    assert.equal(writes.length,2,JSON.stringify(writes));assert.equal(writes[1].payload.mail,seed.name);assert.equal(writes[1].payload.expected_version,1);
    assert.equal(writes[1].payload.body,'提交正文');assert.equal(writes[1].payload.subject,'提交主题');
    assert.equal(t.w.document.querySelector('#c-body').value,'后续未离开的正文');assert.equal(t.w.document.querySelector('#dirty-note').hidden,false);
  }finally{t.dispose();}
});

it('字段保存未知后即使重试403也保留原请求，不能顺带提交其他字段或丢弃关闭',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{if(url.includes('/datasets/'))return {rows:[seed],total:1};if(url.includes('/services/'))return {result:{mail:seed}};writes.push(body);if(writes.length===1)throw Error('断线');if(writes.length===2)return {error:'权限暂不可用',status:403};return {result:{...seed,...body.payload,record_version:2}};});
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();input(t.w,'#c-body','原正文');leaveField(t.w,'#c-body');await tick();
    input(t.w,'#c-subject','未保存主题');leaveField(t.w,'#c-subject');await tick();assert.equal(writes.length,1);
    pressSave(t.w);await tick();t.w.document.querySelector('#c-cancel').click();t.w.document.querySelector('#c-cancel').click();
    assert.ok(t.w.document.querySelector('#c-body'));pressSave(t.w);await tick();assert.deepEqual(writes[1],writes[0]);assert.deepEqual(writes[2],writes[0]);
    assert.equal(t.w.document.querySelector('#c-subject').value,'未保存主题');assert.equal(t.w.document.querySelector('#dirty-note').hidden,false);
  }finally{t.dispose();}
});

it('真实草稿从公共数据集与详情加载；发送和示例发件身份不冒充可用',async()=>{
  const calls:string[]=[];
  const t=mount((url)=>{calls.push(url);return url.includes('/services/')?{result:{mail:seed}}:{rows:[seed],total:1};});
  try{await tick();assert.equal(t.w.document.querySelector('#compose').disabled,false);
    t.w.document.querySelector('[data-open]').click();await tick();
    assert.equal(t.w.document.querySelector('#c-body').value,'真实正文');
    assert.equal(t.w.document.querySelector('#c-send').disabled,true);
    assert.equal(t.w.document.querySelector('#c-from').disabled,true);
    assert.doesNotMatch(t.w.document.querySelector('#c-from').textContent,/wzj@|ip-flow@/);
    assert.ok(calls.some(x=>x.includes('/services/mail.detail/invoke')));
  }finally{t.dispose();}
});

it('保存失败保留输入与幂等键；保存期间新输入不能被成功回执清除',async()=>{
  const writes:any[]=[];let finish:(value:any)=>void=()=>{};
  const t=mount((url,body)=>{
    if(url.includes('/datasets/'))return {rows:[],total:0};
    writes.push(body);if(writes.length===1)return {error:'暂时断线'};
    return new Promise(resolve=>{finish=resolve;});
  });
  try{await tick();t.w.document.querySelector('#compose').click();input(t.w,'#c-body','第一版');
    pressSave(t.w);await tick();
    assert.equal(t.w.document.querySelector('#c-body').value,'第一版');
    assert.match(toastText(t.w),/暂时断线/);
    // 保存失败是错误：要红底 + alert，不是绿色成功色
    {const toast=t.w.document.querySelector('#toast-zone .toast') as any;
     assert.ok(toast.classList.contains('toast-error'),`保存失败没走错误色（红），现在是：${toast.className}`);
     assert.equal(toast.getAttribute('role'),'alert','错误提示该用 alert 语义');}
    pressSave(t.w);await tick();
    assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    input(t.w,'#c-body','保存期间新输入');finish({result:{...seed,body:'第一版'}});await tick();
    assert.equal(t.w.document.querySelector('#c-body').value,'保存期间新输入');
    assert.equal(t.w.document.querySelector('#dirty-note').hidden,false);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    pressSave(t.w);await tick();
    assert.equal(writes[2].payload.mail,seed.name);assert.equal(writes[2].payload.expected_version,1);
  }finally{t.dispose();}
});

it('回收和恢复只走版本化动作，分页不截断；列表正文搜索不再前端误过滤',async()=>{
  let trash=false;const writes:any[]=[];const reads:string[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/')){reads.push(url);return {rows:[{...seed,status:trash?'Trash':'Draft',body:undefined}],total:35};}
    if(url.includes('/services/'))return {result:{mail:{...seed,status:trash?'Trash':'Draft'}}};
    writes.push({url,...body});trash=url.includes('recycle');return {result:{...seed,status:trash?'Trash':'Draft'}};
  });
  try{await tick();assert.equal(t.w.document.querySelector('#mail-next').disabled,false);
    t.w.document.querySelector('#mail-next').click();await tick();assert.ok(reads.at(-1)?.includes('page=2'));
    input(t.w,'#search','仅在正文匹配');await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(t.w.document.querySelectorAll('[data-open]').length,1);
    t.w.document.querySelector('[data-open]').click();await tick();
    t.w.document.querySelector('#trash-draft').click();t.w.document.querySelector('#trash-draft').click();await tick();
    assert.equal(writes[0].payload.expected_version,1);assert.match(writes[0].url,/mail.recycle/);
    const select=t.w.document.querySelector('#mail-box');select.value='trash';select.dispatchEvent(new t.w.Event('change'));await tick();
    t.w.document.querySelector('[data-open]').click();await tick();t.w.document.querySelector('#restore-mail').click();await tick();
    assert.match(writes[1].url,/mail.restore/);
  }finally{t.dispose();}
});

it('显式交互样例不读写真实邮箱',async()=>{
  let requests=0;const t=mount(()=>{requests++;return {};},true);
  try{await tick();t.w.document.querySelector('#compose').click();input(t.w,'#c-body','样例');await triggerSave(t.w);assert.equal(requests,0);}
  finally{t.dispose();}
});

it('新草稿响应丢失后先确认原请求，后来输入不得另造第二封草稿',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/'))return {rows:[seed],total:1};
    writes.push(body);if(writes.length===1)throw Error('连接中断');
    return {result:seed};
  });
  try{await tick();t.w.document.querySelector('#compose').click();input(t.w,'#c-body','原请求');
    pressSave(t.w);await tick();input(t.w,'#c-body','后来输入');
    pressSave(t.w);await tick();
    assert.equal(writes[1].payload.body,'原请求');assert.equal(writes[1].idempotency_key,writes[0].idempotency_key);
    assert.equal(t.w.document.querySelector('#c-body').value,'后来输入');
    pressSave(t.w);await tick();
    assert.equal(writes[2].payload.mail,seed.name);assert.equal(writes[2].payload.body,'后来输入');
  }finally{t.dispose();}
});
it('附件在字段内双击选择确切版本，选择后预览复用详情，保存不发送邮件',async()=>{
  const writes:any[]=[];const previews:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/mail'))return {rows:[],total:0,attachment_capability:'fixed_references_v2'};
    if(url.includes('/datasets/files'))return {rows:[{name:'file-1',file_name:'协议.txt',version_count:2}],total:1};
    if(url.includes('files.versions'))return {versions:[{version_no:2,frappe_file:'v2',size_bytes:20},{version_no:1,frappe_file:'v1',size_bytes:10}]};
    writes.push(body);return {result:{...seed,attachments:[{file:'bound-1',name:'协议.txt',size:10,label:'第 1 版'}],attachment_bindings:{v1:'bound-1'}}};
  });
  t.w.openFileCenterDetail=async(options:any)=>previews.push(options);
  try{await tick();t.w.document.querySelector('#compose').click();input(t.w,'#c-body','不得丢失的正文');
    const field=t.w.document.querySelector('[data-attachment-value]');assert.ok(field);field.dispatchEvent(new t.w.MouseEvent('dblclick'));await tick();
    const dlg=t.w.document.querySelector('dialog.os-dialog');assert.ok(dlg,'附件选择应开公共弹窗');
    dlg.querySelector('[data-pick-file]').click();await tick();
    const choice=dlg.querySelector('[data-pick-version="v1"]');choice.click();await tick();
    dlg.querySelector('[data-act="1"]').click();await tick();
    assert.match(field.textContent,/协议.txt.*第 1 版/);assert.equal(t.w.document.querySelector('#c-body').value,'不得丢失的正文');
    t.w.document.querySelector('[data-attachment-preview]').click();await tick();assert.equal(previews[0].version,1);
    pressSave(t.w);await tick();assert.equal(writes.length,1);assert.deepEqual(writes[0].payload.attachments,['v1']);assert.deepEqual(writes[0].payload.attachment_labels,[{file:'v1',label:'第 1 版',name:'协议.txt'}]);
  }finally{t.dispose();}
});
it('既有邮件附件无需文件域在线即可预览；未知保存不能关闭丢弃或变更请求',async()=>{
  const writes:any[]=[];const previews:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('/datasets/'))return {rows:[seed],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('mail.detail'))return {result:{mail:{...seed,attachments:[{file:'bound-1',name:'原件.txt',label:'第 1 版',size:8}],attachment_capability:'fixed_references_v2'}}};
    writes.push(body);throw Error('连接中断');
  });
  t.w.openFileCenterDetail=async(options:any)=>previews.push(options);
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();t.w.document.querySelector('[data-attachment-value]').dispatchEvent(new t.w.MouseEvent('dblclick'));t.w.document.querySelector('[data-attachment-preview]').click();await tick();assert.equal(previews[0].reference.file,'bound-1');
    input(t.w,'#c-body','修改');pressSave(t.w);await tick();t.w.document.querySelector('#c-cancel').click();t.w.document.querySelector('#c-cancel').click();assert.ok(t.w.document.querySelector('#c-body'));
    input(t.w,'#c-body','新输入');pressSave(t.w);await tick();assert.deepEqual(writes[1],writes[0]);
  }finally{t.dispose();}
});

it('真实邮件多选批量回收三封，部分失败逐条可见且只保留失败项供重试',async()=>{
 const rows=['m1','m2','m3'].map(name=>({...seed,name,status:'Received',subject:name,body:'正文',from_address:'sender@example.invalid',read_at:'2026-10-15 10:00:00'}));const writes:any[]=[];let deny=true;
 const t=mount((url,body)=>{
  if(url.includes('/datasets/')){const visible=rows.filter(r=>r.status!=='Trash');return {rows:visible,total:visible.length};}
  if(url.includes('/actions/mail.recycle/')){writes.push(body);const id=body.payload.mail;if(id==='m3'&&deny)return {error:'这封邮件无管理权限',status:403};const row=rows.find(r=>r.name===id)!;row.status='Trash';row.record_version++;return {result:{name:id,status:'Trash',record_version:row.record_version}};}
  return {};
 });try{
  await tick();await tick();t.w.eval(readFileSync(new URL('../../../shangshu-web/js/mail-batch.js',import.meta.url),'utf8'));
  const $=(s:string)=>t.w.document.querySelector(s);const boxes=t.w.document.querySelectorAll('[data-mail-select]');assert.equal(boxes.length,3);
  for(const box of boxes){box.checked=true;box.dispatchEvent(new t.w.Event('change',{bubbles:true}));}
  const recycle=$('#mail-batch-recycle');assert.equal(recycle.disabled,false);recycle.click();assert.equal(writes.length,0,'首次需要显示回收范围');recycle.click();await tick();await tick();await tick();
  assert.equal(writes.length,3);assert.equal($('#mail-rows').querySelectorAll('[data-mail]').length,1);assert.equal($('#mail-rows [data-mail="m3"]')!==null,true);
  assert.match($('#mail-batch-results').textContent,/成功.*2/);assert.match($('#mail-batch-results').textContent,/m3.*无管理权限/);
  assert.equal($('#mail-rows [data-mail-select="m3"]').checked,true,'失败项不能误清选择');
  deny=false;recycle.click();recycle.click();await tick();await tick();assert.equal(writes.length,4);assert.equal(writes[3].payload.mail,'m3');
 }finally{t.dispose();}
});

it('多选回收结果未知保留选中及原幂等请求，重试不再提交已成功邮件',async()=>{
 const rows=['u1','u2','u3'].map(name=>({...seed,name,status:'Received',subject:name,from_address:'sender@example.invalid',read_at:'2026-10-15 10:00:00'}));const calls:any[]=[];let lost=true;
 const t=mount((url,body)=>{
  if(url.includes('/datasets/')){const visible=rows.filter(r=>r.status!=='Trash');return {rows:visible,total:visible.length};}
  if(url.includes('/actions/mail.recycle/')){calls.push(body);if(body.payload.mail==='u2'&&lost)return {error:'等待确认服务器结果',status:503};const row=rows.find(r=>r.name===body.payload.mail)!;row.status='Trash';row.record_version++;return {result:{name:row.name,status:'Trash',record_version:row.record_version}};}
  return {};
 });try{
  await tick();await tick();t.w.eval(readFileSync(new URL('../../../shangshu-web/js/mail-batch.js',import.meta.url),'utf8'));
  const $=(s:string)=>t.w.document.querySelector(s);$('#mail-select-all').checked=true;$('#mail-select-all').dispatchEvent(new t.w.Event('change',{bubbles:true}));
  $('#mail-batch-recycle').click();$('#mail-batch-recycle').click();await tick();await tick();assert.match($('#mail-batch-results').textContent,/结果未知.*1/);assert.equal($('[data-mail-select="u2"]').checked,true);assert.equal(calls.length,3);
  lost=false;$('#mail-batch-recycle').click();$('#mail-batch-recycle').click();await tick();await tick();assert.equal(calls.length,4);assert.deepEqual(calls[3],calls[1],'未知重试须沿原参数、原幂等键');
 }finally{t.dispose();}
});
it('新建回复转发均提供存草稿和正文三步撤回，撤回不改主题或收件人',async()=>{
 for(const mode of ['compose','reply','forward']){
  const t=mount(()=>({}),true);try{
   t.w.eval(readFileSync(new URL('../../../shangshu-web/js/domains/mail/mail-editor.js',import.meta.url),'utf8'));
   const $=(s:string)=>t.w.document.querySelector(s);
   if(mode==='compose')$('#compose').click();else {$('#mail-box').value='inbox';$('#mail-box').dispatchEvent(new t.w.Event('change'));$('[data-mail]').click();$('#'+mode).click();}
   const editor=$('.mail-body-editor');assert.ok(editor);assert.ok($('#c-save').querySelector('svg'));const undo=$('[data-editor-undo]');assert.ok(undo);
   const before=editor.innerHTML,subject=$('#c-subject').value,to=$('#c-to').value;const paste=new t.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:(key:string)=>key==='text/plain'?'本次新增':''}});editor.dispatchEvent(paste);
   assert.equal(undo.disabled,false);undo.click();assert.equal(editor.innerHTML,before);assert.equal($('#c-subject').value,subject);assert.equal($('#c-to').value,to);
  }finally{t.dispose();}
 }
});
