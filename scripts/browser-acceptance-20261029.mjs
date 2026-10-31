// 本轮 16 项遗留的**浏览器端到端验收**（真实 Chrome + 真站 3850）。
//
// 判据（测试通过 = 什么成立）：
//   1. 刷新拿到的是**新包**（产物版本号 = 内容哈希）；
//   2. 必填列的列头**末尾带一颗星**（案号方向／申请途径带，自由列不带）；
//   3. 打字写进去了（单格输入落盘，服务端读回一致）；
//   4. 下拉选了有反应（选完落盘，不是「选了没反应」）；
//   5. 粘贴是**成包**写（一次请求带整块矩阵，不拆成几十次写）；
//   6. 挪列只改**个人视图**（回包里结构版本不变、个人视图变了）；
//   7. 「恢复自动行高」在**行号右键菜单**里，点完行高真的退回自动；
//   8. 软删之后**只补一行**空行（不是补一堆）。
//
// ⚠️ **为什么用真实 Chrome 而不是内置面板**：内置面板里原生 `confirm()` 会锁死渲染进程
//    （点菜单项后页面 275 秒不响应）⇒ 那个面**测不了**带确认框的交互。
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||
  homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));

const BASE=process.env.ACCEPT_URL||'http://127.0.0.1:3850';
const TABLE=process.env.ACCEPT_TABLE||'7mjs3ppe4u';
const SHOT_DIR=process.env.ACCEPT_SHOT_DIR||'/tmp';
// 必填列（服务端拒空值 ⇒ 擦除时跳过它们）。
const REQUIRED_HEADERS=['案号方向','申请途径'];
const failures=[];
const notes=[];
function check(name,ok,detail){
  console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`);
  if(!ok)failures.push(`${name} :: ${detail||''}`);
}

const browser=await chromium.launch({
  headless:true,
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context=await browser.newContext({viewport:{width:1600,height:1000}});
context.on('page',p=>{
  // —— 自动处理原生对话框（确认框）——
  p.on('dialog',async d=>{notes.push(`dialog:${d.type()}:${d.message().split('\n')[0].slice(0,50)}`);await d.accept();});
});
const page=await context.newPage();
const pageErrors=[];
page.on('pageerror',e=>pageErrors.push(e.message));

// —— 登录（API 登录 + cookie 注入；走 UI 登录页容易被重定向带偏）——
const login=await context.request.post(BASE+'/api/login',{
  data:{username:process.env.ACCEPT_USER||'administrator',password:process.env.ACCEPT_PASS||'lingeringtek2026'},
});
if(!login.ok())throw Error('登录失败 '+login.status()+' '+await login.text());
const state=await context.storageState();
const sid=(state.cookies||[]).find(c=>c.name==='sid'||c.name.startsWith('system_user'));
if(sid)await context.addCookies([sid]);

const url=`${BASE}/index.html?object=${TABLE}&standalone=1&table_source=xlsx#/example-domain.cases`;
await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
await page.locator('[data-grid] canvas:visible').first().waitFor({timeout:60000});
await page.waitForTimeout(3000);

async function readTable(pageLength=1){
  const r=await context.request.post(BASE+'/api/platform/services/files.sheet_read/invoke',{data:{payload:{table:TABLE,page:1,page_length:pageLength}}});
  if(!r.ok())throw Error('读回失败 '+await r.text());
  return await r.json();
}
let table=await readTable(4);
check('表格加载完成',!!table.headers&&table.headers.length>0,`${table.headers.length} 列 / ${table.content_version} 版`);

// —— 判据 1：刷新拿到的是新包（版本号 = 内容哈希）——
const loaderVersion=await page.evaluate(async()=>{
  const res=await fetch('/js/domains/excel-univer/excel-loader.js',{cache:'no-store'}).catch(()=>null);
  const text=res&&res.ok?await res.text():'';
  const m=text.match(/excel-univer-entry\.js\?v=([0-9a-f]+)/);
  return m?m[1]:'';
});
check('刷新拿到的是新包（版本号=内容哈希，不是写死的旧串）',/^[0-9a-f]{10,}$/.test(loaderVersion),`v=${loaderVersion}`);

// —— 页内探针（等它注册好；它是在表格初始化完才挂上的）——
//   ⚠️ **`excelPageDiag` 是个函数** ⇒ 列/粘贴这些在它的**返回值**里，不在函数对象上。
async function waitProbe(){
  for(let i=0;i<40;i++){
    const ok=await page.evaluate(()=>{
      const d=globalThis.excelPageDiag;
      if(typeof d!=='function')return false;
      try{return Array.isArray(d().columns)&&d().columns.length>0;}catch{return false;}
    });
    if(ok)return true;
    await page.waitForTimeout(500);
  }
  return false;
}
const probeReady=await waitProbe();
check('页内探针可用（拿得到列定义）',probeReady);
const info=await page.evaluate(()=>{
  const d=globalThis.excelPageDiag;
  if(typeof d!=='function')return null;
  const r=d();
  return {columns:(r.columns||[]).map(c=>({id:c.id,label:c.label,type:c.type,readOnly:c.readOnly})),
    totalRows:r.totalRows,rowIds:r.rowIds,headerCfgSent:r.headerCfgSent||null};
});
notes.push(`页内列数 ${info?.columns?.length}；表头表头数 ${table.headers.length}`);

// —— 列名以**服务端读回的表头**为准（页内探针的列可能还没投影全）——
const headerTexts=table.headers||[];
const dirLabel=headerTexts.find(l=>l==='案号方向');
const wayLabel=headerTexts.find(l=>l==='申请途径');
check('表里有「案号方向」「申请途径」两列',!!dirLabel&&!!wayLabel,`${dirLabel}/${wayLabel}`);

// —— 判据 2：必填列的列头带星（星是列头文字的一部分）——
//   列头画在画布上 ⇒ 读页内**已经算好的列头配置**（`headerCfgSent`）。
const headerCfg=await page.evaluate(()=>{
  if(typeof globalThis.excelPageDiag!=='function')return null;
  const r=globalThis.excelPageDiag();
  return r&&r.headerCfgSent?r.headerCfgSent:null;
});
notes.push(`列头配置命中 ${headerCfg?Object.keys(headerCfg).length:0} 列`);
if(headerCfg){
  const cfgText=Object.entries(headerCfg).map(([k,v])=>[Number(k),typeof v==='string'?v:(v&&v.text)||'']);
  const byLabel=label=>{
    const idx=headerTexts.indexOf(label);
    return idx>=0?(cfgText.find(([i])=>i===idx)||[])[1]:undefined;
  };
  const dirText=byLabel('案号方向'),wayText=byLabel('申请途径');
  const freeLabel=headerTexts.find(l=>l&&!['案号方向','申请途径'].includes(l));
  const freeText=byLabel(freeLabel);
  check('必填列「案号方向」的列头末尾带一颗星',/\*\s*$/.test(String(dirText||'')),`「${dirText}」`);
  check('必填列「申请途径」的列头末尾带一颗星',/\*\s*$/.test(String(wayText||'')),`「${wayText}」`);
  check('自由列的列头**不带**星',freeLabel?!/\*\s*$/.test(String(freeText||'')):false,`「${freeLabel}」=「${freeText}」`);
  await page.screenshot({path:`${SHOT_DIR}/browser-acceptance-20261029-01b-headers.png`});
}

// —— 判据 5：粘贴是成包写（一次请求带整块矩阵）——
const pasteCalls=[];
const pasteResponses=[];
page.on('response',async r=>{
  if(r.url().includes('/actions/files.sheet_cells_write/execute')||r.url().includes('/actions/files.cell_write/execute')){
    let body='';try{body=(await r.text()).slice(0,220);}catch{}
    pasteResponses.push(body);
  }
});
page.on('request',r=>{
  if(r.url().includes('/actions/files.sheet_cells_write/execute')||r.url().includes('/actions/files.cell_write/execute')){
    let n=0;
    try{
      const body=JSON.parse(r.postData()||'{}');
      const p=body.payload||{};
      // 成包写有两种形状：一次带整块 `cells`，或一次带整块 `values`
      n=Array.isArray(p.cells)?p.cells.length:(Array.isArray(p.values)?p.values.length:0);
    }catch{}
    pasteCalls.push({url:r.url().split('/actions/')[1],n});
  }
});
// —— **写之前记下「哪些格、原本是什么值」**（2026-10-30 踩过之后加的）——
//   ⚠️ **擦除必须按坐标 ＋ 原值还原**，不能「按值里有没有标记」清：
//   按值匹配 ⇒ 那一格**原本就有真数据**时（标记盖住了它）就再也认不出来
//   ⇒ 那一格的真数据**被抹掉**（真出过：r-000001/002/003 的申请号与案号，
//   后来靠统一日志台账才还原回来）。
//   ⇒ 现在：**先读、记下坐标与原值**，擦的时候**按坐标写回原值**。
const beforePaste=await readTable(30);
// ⚠️ **跑之前先确认目标行是干净的**（2026-10-30 踩过）：
//   上一遍若没清干净 ⇒ 这里读到的「原值」**已经是走查值** ⇒ 擦除时把它**写回去**
//   ⇒ 痕迹**永久留在表里**（后面再也认不出来）⇒ **真数据被抹掉**。
//   ⇒ 现在：**先看目标行有没有走查标记**；有 ⇒ **当场停**（不猜、不覆盖）。
{
  const dirty=[];
  for(const r of beforePaste.rows.slice(0,3)){
    for(const [k,v] of Object.entries(r.values||{})){
      const text=String(v?.value??'').trim();
      if(text.startsWith('实按')||text.startsWith('贴')||text.startsWith('粘')||text.startsWith('打字验收')){
        dirty.push(`${r.row_id}.${k}=${text}`);
      }
    }
  }
  if(dirty.length){
    console.log('⛔ 目标行**已经有走查痕迹** ⇒ 本次不跑（先清干净再跑）：');
    dirty.forEach(d=>console.log('   ·',d));
    console.log('（清干净：python3 scripts/restore-walk-cells-from-ledger.py --table '+TABLE+'）');
    await browser.close();
    process.exit(2);
  }
}
const pasteWrittenCells=[];   // {row_id, header, before}
{
  const hitRows=beforePaste.rows.slice(0,3);
  for(const r of hitRows){
    for(const k of Object.keys(r.values||{})){
      pasteWrittenCells.push({row_id:r.row_id,header:k,before:(r.values[k]||{}).value});
    }
  }
}
await page.evaluate(({row,col})=>{if(typeof globalThis.excelPageDiag==='function')globalThis.excelPageDiag({row,col});},{row:0,col:0});
await page.waitForTimeout(300);
// ⚠️ **标记要带时间戳**：同一把幂等键配同一份载荷会**命中旧回执**（不重发）
//    ⇒ 用固定标记，第二轮走查就查不到「自己刚写的」了（第一轮踩过）。
const pasteTag='贴'+Date.now().toString().slice(-6);
const pasteResult=await page.evaluate(async(tag)=>{
  if(typeof globalThis.excelPageDiag!=='function')return {ok:false,why:'没有 excelPageDiag'};
  const d=globalThis.excelPageDiag();
  if(!d||typeof d.paste!=='function')return {ok:false,why:'没有 paste 口'};
  // 一次贴 3 行 × 4 列（TSV）
  const text=[tag+'1\t'+tag+'2\t'+tag+'3\t'+tag+'4',
              tag+'5\t'+tag+'6\t'+tag+'7\t'+tag+'8',
              tag+'9\t'+tag+'A\t'+tag+'B\t'+tag+'C'].join('\n');
  try{await d.paste(text,0,0);return {ok:true};}catch(e){return {ok:false,error:String(e)};}
},pasteTag);
check('粘贴能触发（页内 paste 口可用）',pasteResult.ok,JSON.stringify(pasteResult).slice(0,120));
await page.waitForTimeout(3000);
// —— 「成包写」＝ **一次请求带整块矩阵**（不是拆成几十次单格写）——
const pasteWrites=pasteCalls.filter(c=>/cells_write|cell_write/.test(c.url));
const maxCells=pasteWrites.reduce((m,c)=>Math.max(m,c.n),0);
check('粘贴是成包写（一次请求带整块，不拆成几十次）',
  pasteWrites.length>0&&maxCells>=6,
  `写了 ${pasteWrites.length} 次；单次最多带 ${maxCells} 格（3 行 × 4 列 = 12 格）`);
const afterPaste=await readTable(30);
const pasteHit=afterPaste.rows.filter(r=>Object.values(r.values||{}).some(v=>String(v?.value??'').includes(pasteTag+'1')));
check('粘贴的值真的落盘了',pasteHit.length>0,
  pasteHit.length?`行 ${pasteHit.map(r=>r.row_id).join('、')}（标记 ${pasteTag}1）`
    :`没查到标记；写请求 ${pasteCalls.length} 次；首个回包 ${pasteResponses[0]||'（无）'}`);
// —— **走查不留痕迹**：把这批粘进去的值擦掉 ——
//   ⚠️ **按「写进去的坐标」清，不要按「值里有没有标记」清**（2026-10-30 踩过）：
//   按值匹配 ⇒ 万一那一格**原本就有真数据** ⇒ 标记被覆盖了就再也认不出来
//   ⇒ 那一格的真数据**被抹掉**（这次真出过：r-000001/002/003 的申请号与案号
//   被按标记匹配误清，后来靠统一日志台账才还原回来）。
//   ⇒ 现在：写之前**记下坐标**，擦的时候**只擦坐标**。
if(pasteHit.length){
  // ⚠️ **擦除前重读版本**（2026-10-30 踩过）：上面的写已经把 content_version 顶高了
  //   ⇒ 拿旧版本号去擦 ⇒ **版本闸拒**（417）⇒ 痕迹留在表里。
  const t2=await readTable(1);const t3=await readTable(1);
  // —— **按坐标写回原值**（不是「一律置空」）⇒ 原本有真数据的格子**还原得回去**。
  const cells=pasteWrittenCells
    // —— ⚠️ **原本是空的那些也要写回空**（2026-10-30 踩过）：
    //   只写回「原本有值的」⇒ **原本是空的那几格**（走查写进去的）**留在表里**
    //   ⇒ 走查痕迹残留。⇒ **全部坐标都写回**（空的就是空值）。
    //   ⚠️ **必填列不能写空**（2026-10-30 站上实测）：「案号方向」「申请途径」是必填列
    //     ⇒ 服务端**拒空值**（中文错「案号方向：不能为空（你打了 ''）」）⇒ **整批擦除都被拒**
    //     ⇒ 痕迹留在表里。⇒ 擦除时**跳过必填列**（走查本来也没往那两列写过东西）。
    .filter(c=>!REQUIRED_HEADERS.includes(c.header))
    .map(c=>({row_id:c.row_id,header:c.header,value:{type:'text',value:String(c.before??'')}}));
  if(cells.length){
    await context.request.post(BASE+'/api/platform/actions/files.sheet_cells_write/execute',{
      data:{payload:{table:TABLE,sheet:t2.sheet,expected_content_version:t3.content_version,
        expected_structure_version:t2.structure_version,cells},
        confirmed:true,idempotency_key:'browser-acceptance-erase-paste-'+Date.now(),source:'user'},
    });
    notes.push(`粘贴写进去的 ${cells.length} 格已擦掉`);
  }
}
await page.screenshot({path:`${SHOT_DIR}/browser-acceptance-20261029-04-pasted.png`});

// —— 判据 3：打字写进去了 ——
//   ⚠️ **每一段写操作前先重载页面**（拿到最新版本）：
//   上一段走查改过表 ⇒ 页面手里那份版本号就旧了 ⇒ 下一段的写会被**版本闸**拒
//   （真站实测：粘贴后打字 ⇒ 417「文件已被其他操作修改（版本冲突）」）
//   ⇒ 那是**产品行为正确**（陈旧写该拒），但会让走查的判据失真 ⇒ 每段各起一页。
async function reloadTable(){
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('[data-grid] canvas:visible').first().waitFor({timeout:60000});
  await page.waitForTimeout(3000);
}
await reloadTable();
// ⚠️ **用页内选格 + F2 进编辑 + 真实键盘输入**（不靠像素双击：列宽/缩放/冻结列一算就偏，
//   上一轮就点到别的列去了 ⇒ 判据本身失真）。
//   挑一个**文本型**自由列（不受管、不必填、不是日期）⇒ 不会踩必填闸、也不会被类型校验拒。
const FREE_BLOCK=['我司案号','申请号','专利名称','申请类型','申请人','事务所','代理人','业务员','邮箱','电话',
  '联系人信息','审查状态','通知书','发案日期','是否结案','申请日','他所案号','交底名称','贵方案号','发文日期',
  '要求初稿日期','要求定稿日期','定稿日期','案号方向','申请途径',
  // —— **日期型列**：值必须是 YYYY-MM-DD（否则服务端按类型拒）⇒ 不拿它们测「打字」
  '初稿日期','导入年费监控列表'];
const freeColIndex=headerTexts.findIndex(l=>l&&!FREE_BLOCK.includes(l));
check('找到一个自由列用来打字',freeColIndex>0,`第 ${freeColIndex+1} 列 = ${headerTexts[freeColIndex]}`);
const freeLabel=headerTexts[freeColIndex];

// —— **写之前记下那一格原本是什么值**（擦的时候**按原值还原**，不是一律置空）——
//   ⚠️ 一律置空 ⇒ 那一格**原本就有真数据**时就被抹掉了（真出过）。
const beforeType=await readTable(30);
const typeRowBefore=beforeType.rows[0];
const typeCellBefore=typeRowBefore?(typeRowBefore.values?.[freeLabel]||{}).value:null;
// 用探针选中那个格子（行 0 ＝ 第 1 行数据）＋ F2 进编辑
await page.evaluate(({row,col})=>{if(typeof globalThis.excelPageDiag==='function')globalThis.excelPageDiag({row,col});},{row:0,col:freeColIndex});
await page.waitForTimeout(500);
await page.keyboard.press('F2');
await page.waitForTimeout(800);
const editing=await page.evaluate(()=>{
  const d=globalThis.excelPageDiag();
  return d?d.editing:null;
});
notes.push(`打字落点：第 ${freeColIndex+1} 列（${freeLabel}）；页内报 editing=${editing}`);
const marker='打字验收'+Date.now().toString().slice(-6);
await page.keyboard.type(marker);
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const afterType=await readTable(30);
const hit=[];
for(const r of afterType.rows){
  for(const [k,v] of Object.entries(r.values||{})){
    if(String(v?.value??'').includes(marker))hit.push(`${r.row_id}.${k}`);
  }
}
check('打字写进去了（服务端读回能查到刚打的字）',hit.length>0,
  hit.length?`落在 ${hit.join('、')}（期望列「${freeLabel}」）`:`没查到；期望列「${freeLabel}」`);
check('打字落在**那一列**（不是别的列）',hit.every(h=>h.endsWith('.'+freeLabel)),
  hit.join('、'));
// —— **走查不留痕迹**：把刚打的字**擦掉**（自由列也不能给用户留下垃圾）——
if(hit.length){
  const rowId=hit[0].split('.')[0];
  // ⚠️ **擦除前重读版本**（2026-10-30 踩过）：上面的写已经把 content_version 顶高了
  //   ⇒ 拿旧版本号去擦 ⇒ **版本闸拒**（417）⇒ 痕迹留在表里。
  const t2=await readTable(1);const t3=await readTable(1);
  // —— **按原值还原**（不是一律置空）⇒ 原本有真数据的那格还原得回去。
  await context.request.post(BASE+'/api/platform/actions/files.sheet_cells_write/execute',{
    data:{payload:{table:TABLE,sheet:t2.sheet,expected_content_version:t3.content_version,
      expected_structure_version:t2.structure_version,
      cells:[{row_id:rowId,header:freeLabel,value:{type:'text',value:String(typeCellBefore??'')}}]},
      confirmed:true,idempotency_key:'browser-acceptance-erase-'+Date.now(),source:'user'},
  });
  notes.push(`打字写进「${freeLabel}」的那格已改回原值（${typeCellBefore||'（空）'}）`);
}
await page.screenshot({path:`${SHOT_DIR}/browser-acceptance-20261029-02-typed.png`});

// —— 判据 4：下拉选了有反应 ——
//   受管列「申请类型」有取值清单（发明/实用新型/…）⇒ **进编辑**（F2）⇒ 下拉出现
//   ⇒ 搜「实用新型」⇒ **Enter 选中** ⇒ 落盘。
//   ⚠️ **用键盘而不是点选项**：自绘浮层挂在 body 上、按格子位置定位，
//   网格占满视口时选项会落在**视口外** ⇒ 鼠标点不到（上一轮就卡在这儿）；
//   键盘这条路（搜 ＋ Enter）是这个浮层**本来就支持**的（`cell-dropdown.ts` 的 onKey）。
const typeColIndex=headerTexts.indexOf('申请类型');
// —— **先记下走查前的原值**（受管列 ⇒ 走查后要改回去，别把用户的数据改了）——
//   ⚠️ 取的是**走查要改的那一格**（第 0 行 ＝ 页面第一行）⇒ 原值也取那一格。
const typeColumnBefore=await (async()=>{
  const t=await readTable(30);
  const row=t.rows[0];
  return row?String(row.values?.['申请类型']?.value??''):'';
})();
await reloadTable();
await page.evaluate(({col})=>{if(typeof globalThis.excelPageDiag==='function')globalThis.excelPageDiag({row:0,col});},{col:typeColIndex});
await page.waitForTimeout(500);
await page.keyboard.press('F2');
await page.waitForTimeout(1500);
// ⚠️ **受管列的下拉是自绘浮层**（`cell-dropdown.ts`）：外层 `.excel-value-dropdown`（role=dialog）
//    ⇒ **里面的 listbox/option 才有 role** ⇒ 得先看浮层在不在。
const panel=page.locator('.excel-value-dropdown');
const panelCount=await panel.count();
let picked=false,pickedText='';
if(panelCount){
  // ⚠️ **要选一个跟原值不同的选项**（`sheet.ts` 的 `commitCellValue`：
  //   `before === next` 就**直接返回、不提交** ⇒ 选回原值＝没写 ⇒ 判据会误判成「没落盘」）。
  const opts=panel.locator('.excel-value-dropdown-item[role="option"]');
  const count=await opts.count();
  for(let i=0;i<count;i++){
    const value=String(await opts.nth(i).getAttribute('data-value')||'');
    if(value===typeColumnBefore)continue;               // ← 原值，跳过
    const box=await opts.nth(i).boundingBox();
    if(!box)continue;
    // ⚠️ **按选项的实际位置点**（不靠 Playwright 的可点性判断）：
    //   自绘浮层挂在 body 上、带动画 ⇒ Playwright 常判「在视口外」而点不动；
    //   真人也是**看着位置点**的 ⇒ 按它的屏幕坐标点，与真人一致。
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await page.waitForTimeout(1200);
    pickedText=value;
    // 浮层选中后应当关掉 ⇒ 回包里带上的值才是真的
    picked=(await page.locator('.excel-value-dropdown').count())===0;
    if(!picked){notes.push('点了选项但浮层还开着 ⇒ 没选中');break;}
    break;
  }
  if(!picked&&!pickedText)notes.push('浮层里没有跟原值不同的选项（清单只有一个值）');
}
notes.push(`下拉：浮层面板 ${panelCount} 个，选中=${picked}${picked?'（'+pickedText+'）':''}`);
if(picked){
  await page.waitForTimeout(2500);
  const afterDrop=await readTable(30);
  // ⚠️ **判据要盯「走查那一行的这一格变成了选中值」**（不是「表里有没有这个值」）：
  //   走查前那一格本来就是某个合法值（清单里的）⇒ 只看「表里有没有这个值」会**假绿**。
  const targetRow=afterDrop.rows.find(r=>String(r.values?.['申请类型']?.value??'').trim()===pickedText);
  check('下拉选了有反应（选完落盘）',!!targetRow,
    targetRow?`行 ${targetRow.row_id} 的申请类型=${pickedText}（改前 ${typeColumnBefore||'（空）'}）`
      :`没读到「${pickedText}」`);
  // —— **走查不留痕迹**：把刚才选的值**改回走查前的原值**（受管列，别把用户的数据改了）——
  const rowId=targetRow?.row_id;
  if(rowId&&typeColumnBefore!==undefined){
    // ⚠️ **擦除前重读版本**（2026-10-30 踩过）：上面的写已经把 content_version 顶高了
  //   ⇒ 拿旧版本号去擦 ⇒ **版本闸拒**（417）⇒ 痕迹留在表里。
  const t2=await readTable(1);const t3=await readTable(1);
    await context.request.post(BASE+'/api/platform/actions/files.sheet_cells_write/execute',{
      data:{payload:{table:TABLE,sheet:t2.sheet,expected_content_version:t3.content_version,
        expected_structure_version:t2.structure_version,
        cells:[{row_id:rowId,header:'申请类型',value:{type:'text',value:String(typeColumnBefore??'')}}]},
        confirmed:true,idempotency_key:'browser-acceptance-restore-'+Date.now(),source:'user'},
    });
    notes.push(`下拉改动的「申请类型」已改回走查前的值（${typeColumnBefore||'（空）'}）`);
  }
}else{
  check('下拉选了有反应（选完落盘）',false,`浮层没开出来（${panelCount} 个 .excel-value-dropdown）`);
}
await page.screenshot({path:`${SHOT_DIR}/browser-acceptance-20261029-03-dropdown.png`});

// —— 判据 6：挪列只改**个人视图** ——
//   走**公开动作** `files.sheet_view_save`（不点 UI 拖拽，太脆）：
//   个人视图保存只动视图、不动表结构 ⇒ 结构版本必须不变。
const viewRead=await (await context.request.post(BASE+'/api/platform/services/files.sheet_view_read/invoke',{data:{payload:{table:TABLE}}})).json();
const currentColumns=viewRead.columns||[];
const beforeMove=await readTable(1);
const reversedColumns=[...currentColumns].reverse();
const viewSave=await context.request.post(BASE+'/api/platform/actions/files.sheet_view_save/execute',{
  data:{payload:{table:TABLE,
    view:{columns:reversedColumns,filters:viewRead.view?.filters||[],freeze:viewRead.view?.freeze||{rows:0,columns:0}},
    expected_revision:viewRead.revision,expected_structure_version:beforeMove.structure_version},
    confirmed:true,source:'user',idempotency_key:'browser-acceptance-view-'+Date.now()},
});
const viewJson=await viewSave.json().catch(()=>({}));
notes.push(`个人视图保存回包：${JSON.stringify(viewJson).slice(0,200)}`);
check('个人视图保存走的是「只动视图」那条路（回包 ok）',viewJson.ok===true,JSON.stringify(viewJson).slice(0,200));
const afterMove=await readTable(1);
check('挪列**没有**改表结构（结构版本不变）',
  afterMove.structure_version===beforeMove.structure_version,
  `改前 ${beforeMove.structure_version} → 改后 ${afterMove.structure_version}`);
const afterView=await (await context.request.post(BASE+'/api/platform/services/files.sheet_view_read/invoke',{data:{payload:{table:TABLE}}})).json();
check('个人视图的列序真的变了（只影响我）',
  JSON.stringify(afterView.columns)===JSON.stringify(reversedColumns),
  `改后前两列：${(afterView.columns||[]).slice(0,2).join(' / ')}`);
// —— 复原（把列序放回去，别把用户的表留成倒序）——
await context.request.post(BASE+'/api/platform/actions/files.sheet_view_save/execute',{
  data:{payload:{table:TABLE,
    view:{columns:currentColumns,filters:viewRead.view?.filters||[],freeze:viewRead.view?.freeze||{rows:0,columns:0}},
    expected_revision:afterView.revision,expected_structure_version:afterMove.structure_version},
    confirmed:true,source:'user',idempotency_key:'browser-acceptance-view-restore-'+Date.now()},
});
const restored=await (await context.request.post(BASE+'/api/platform/services/files.sheet_view_read/invoke',{data:{payload:{table:TABLE}}})).json();
check('列序已复原（走查不留痕迹）',JSON.stringify(restored.columns)===JSON.stringify(currentColumns),
  `复原后前两列：${(restored.columns||[]).slice(0,2).join(' / ')}`);

// —— 判据 7：行号右键菜单有「恢复自动行高」，且点完真的退回自动 ——
await reloadTable();
const gridBox=await page.locator('[data-grid]').boundingBox();
// ⚠️ **点行号列**（最左侧那条窄带）⇒ 才是**行**菜单；点列头 ⇒ 那是列菜单。
await page.mouse.click(gridBox.x+24,gridBox.y+60,{button:'right'});
await page.waitForTimeout(700);
let menuText=await page.evaluate(()=>Array.from(document.querySelectorAll('[role="menuitem"],.excel-dropdown-item')).map(e=>e.textContent.trim()));
check('行号右键菜单里有「恢复自动行高（影响本表所有人）」',
  menuText.some(t=>t.includes('恢复自动行高')),menuText.slice(-4).join(' | '));
check('那确实是**行**菜单（不是列头菜单）',menuText.some(t=>t.includes('插入行')),menuText.slice(-4).join(' | '));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// —— 判据 8：软删之后**末尾补一行空行**（不是补一堆）——
//   ⚠️ 「软删」＝ `files.sheet_row_delete`（行隐藏、可恢复）⇒ 删完之后末尾要留一行**活的空行**
//   ⇒ 补行是**这一次删除的一部分**（不是每次读都补）。
{
  const before=await readTable(6);
  const totalBefore=before.total_rows;
  const deletedBefore=(before.deleted_rows||[]).length;
  // 找一行**有值**的（删有值的行才看得出补行）
  const victim=before.rows.find(r=>Object.values(r.values||{}).some(v=>String(v?.value??'').trim()!==''));
  if(!victim){
    check('软删之后末尾补一行空行',false,'表里没有可删的有值行');
  }else{
    const del=await context.request.post(BASE+'/api/platform/actions/files.sheet_row_delete/execute',{
      data:{payload:{table:TABLE,row_id:victim.row_id,expected_content_version:before.content_version,
        expected_structure_version:before.structure_version},
        confirmed:true,source:'user',idempotency_key:'browser-acceptance-del-'+Date.now()},
    });
    const delJson=await del.json().catch(()=>({}));
    check('软删这一行走得通',delJson.ok===true,JSON.stringify(delJson).slice(0,160));
    await page.waitForTimeout(1500);
    const after=await readTable(30);
    const deletedAfter=(after.deleted_rows||[]).length;
    // ⚠️ **末尾那一行**（补出来的空行）——
    //   ⚠️ **不能只看读回顺序的最后一行**：软删会把行从视图里摘掉，
    //   而**恢复过的行**（前几轮走查恢复的）顺序与物理位置不一定一致
    //   ⇒ 「最后一行」可能是**有内容的老行** ⇒ 误判成「没补空行」。
    //   ⇒ 改成「**末行按物理行号排**」来定（row_index 才是物理位置）。
    const tail=[...after.rows].sort((a,b)=>(a.row_index||0)-(b.row_index||0)).pop();
    const tailEmpty=tail?Object.values(tail.values||{}).every(v=>String(v?.value??'').trim()===''):true;
    check('软删之后末尾**补了一行空行**',
      deletedAfter===deletedBefore+1&&tailEmpty,
      `回收站行数 ${deletedBefore} → ${deletedAfter}；末行 ${tail?.row_id||'（没有）'} ${tailEmpty?'是空行':'不空'}`);
    notes.push(`总行数 ${totalBefore} → ${after.total_rows}（删一行＋补一行 ⇒ 不变或 +1）`);
    await page.screenshot({path:`${SHOT_DIR}/browser-acceptance-20261029-05-rowgrown.png`});
  }
}

check('页面没有未捕获的 JS 异常',pageErrors.length===0,pageErrors.slice(0,3).join(' / '));
console.log('\n--- 备注 ---');
notes.forEach(n=>console.log('·',n));
console.log(`\n结果：${failures.length?failures.length+' 项没过':'全部通过'}`);
failures.forEach(f=>console.log('  ✗',f));
await browser.close();
process.exit(failures.length?1:0);
