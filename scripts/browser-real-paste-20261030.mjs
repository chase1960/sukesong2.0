// ⑤-13：浏览器里**实按粘贴**（用户 2026-10-29 原话：「粘贴在浏览器里实按（剪贴板读不到）」）。
//
// 判据（测试通过 = 什么成立）：
//   「人在**真实浏览器**里按 **Ctrl+V**（**真剪贴板**、**真 paste 事件**）
//     ⇒ 表格**真的按剪贴板里的内容**写进去（不是走内部测试口）
//     ⇒ 而且是**成包写**（一次请求带整块，不拆成几十次）
//     ⇒ 写完**重读正式值**能看到刚贴进去的那块内容。」
//
// ⚠️ **为什么必须用真实 Chrome**：
//   · 内置那个浏览器面板**写不了剪贴板**（也没有 clipboard 权限）
//     ⇒ 那边只能「派发一个假 paste 事件」⇒ **不算实按**。
//   · 真实 Chrome 里：`navigator.clipboard.writeText()` 写**系统剪贴板**
//     → `Control+V` 触发**浏览器自己的** paste 事件（带真 `clipboardData`）
//     ⇒ 这才是「人在浏览器里实按粘贴」那条路。
// ⚠️ **为什么不能只走页内 `excelPageDiag().paste()`**：
//   那是**测试专用口**（`handlePaste` 的直调）⇒ 它绕过了「剪贴板 → 事件 → 拦截器」整条链
//   ⇒ 它绿了**不能证明**实按粘贴是通的。
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||
  homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));

const BASE=process.env.ACCEPT_URL||'http://127.0.0.1:3850';
const TABLE=process.env.ACCEPT_TABLE||'7mjs3ppe4u';
const failures=[];
// 必填列（服务端拒空值 ⇒ 擦除时跳过它们）。
const REQUIRED_HEADERS=['案号方向','申请途径'];
function check(name,ok,detail){
  console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`);
  if(!ok)failures.push(`${name} :: ${detail||''}`);
}

const browser=await chromium.launch({
  headless:true,
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context=await browser.newContext({viewport:{width:1500,height:950}});
// —— **给剪贴板权限**（真实浏览器里写剪贴板要这个）——
await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:BASE});
const login=await context.request.post(BASE+'/api/login',{
  data:{username:process.env.ACCEPT_USER||'administrator',password:process.env.ACCEPT_PASS||'lingeringtek2026'},
});
if(!login.ok())throw Error('登录失败 '+login.status());
const state=await context.storageState();
const sid=(state.cookies||[]).find(c=>c.name==='sid'||c.name.startsWith('system_user'));
if(sid)await context.addCookies([sid]);
const page=await context.newPage();
const pageErrors=[];
page.on('pageerror',e=>pageErrors.push(e.message));
const writes=[];
page.on('response',async r=>{
  if(r.url().includes('/actions/files.sheet_cells_write/execute')||r.url().includes('/actions/files.cell_write/execute')){
    let b='';try{b=(await r.text()).slice(0,240);}catch{}
    console.log('  RES',r.status(),r.url().split('/actions/')[1],b);
  }
});
page.on('request',r=>{
  if(r.url().includes('/actions/files.sheet_cells_write/execute')||r.url().includes('/actions/files.cell_write/execute')){
    let n=0;
    try{
      const body=JSON.parse(r.postData()||'{}');
      const p=body.payload||{};
      n=Array.isArray(p.cells)?p.cells.length:(Array.isArray(p.values)?p.values.length:0);
    }catch{}
    writes.push({action:r.url().split('/actions/')[1],cells:n});
  }
});

await page.goto(`${BASE}/index.html?object=${TABLE}&standalone=1&table_source=xlsx#/example-domain.cases`,
  {waitUntil:'domcontentloaded',timeout:90000});
await page.locator('[data-grid] canvas:visible').first().waitFor({timeout:60000});
await page.waitForTimeout(3500);

async function readTable(pageLength=30){
  const r=await context.request.post(BASE+'/api/platform/services/files.sheet_read/invoke',
    {data:{payload:{table:TABLE,page:1,page_length:pageLength}}});
  if(!r.ok())throw Error('读回失败 '+await r.text());
  return await r.json();
}

// —— ① 往**系统剪贴板**里写一段 TSV（真人从 Excel 复制出来的就是这个形状）——
const tag='实按'+Date.now().toString().slice(-6);
const tsv=[`${tag}A\t${tag}B\t${tag}C`,
           `${tag}D\t${tag}E\t${tag}F`,
           `${tag}G\t${tag}H\t${tag}I`].join('\n');
await page.evaluate(async(text)=>{
  await navigator.clipboard.writeText(text);
},tsv);
const clip=await page.evaluate(()=>navigator.clipboard.readText());
check('剪贴板里真的写进去了（系统剪贴板读得到）',clip===tsv,`读到 ${clip.length} 字`);

// —— **写之前记下「哪些格、原本是什么值」** ——
//   ⚠️ **擦除必须按坐标 ＋ 原值还原**（2026-10-30 踩过）：
//   按「值里有没有标记」清 ⇒ 那一格**原本就有真数据**时（标记盖住了它）就再也认不出来
//   ⇒ 那一格的真数据**被抹掉**（真出过）。⇒ 现在：**先读、记下坐标与原值**，擦的时候按坐标写回原值。
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
const pasteWrittenCells=[];
for(const r of beforePaste.rows.slice(0,3)){
  for(const k of Object.keys(r.values||{})){
    pasteWrittenCells.push({row_id:r.row_id,header:k,before:(r.values[k]||{}).value});
  }
}

// —— ② 选中一格（页内探针）＋ **按 Control+V**（真 paste 事件）——
//   ⚠️ **按真键**（不是派发事件）⇒ 浏览器自己生成 paste 事件、带真 clipboardData
//   ⇒ 前端那个 capture 拦截器**真的被走到**。
await page.evaluate(()=>{if(typeof globalThis.excelPageDiag==='function')globalThis.excelPageDiag({row:0,col:0});});
await page.waitForTimeout(500);
await page.keyboard.press('ControlOrMeta+V');
await page.waitForTimeout(4000);

// —— ③ 断言：写请求里带的是**剪贴板那几块**（不是页内测试口）——
const cellWrites=writes.filter(w=>/cells_write|cell_write/.test(w.action));
const maxCells=cellWrites.reduce((m,w)=>Math.max(m,w.cells),0);
check('按 Ctrl+V 触发了成包写（一次请求带整块）',cellWrites.length>0&&maxCells>=6,
  `写了 ${cellWrites.length} 次；单次最多 ${maxCells} 格（3 行 × 3 列 = 9 格）`);

// —— ④ 重读正式值：刚贴进去的那块**真的在表里** ——
const after=await readTable(30);
const hit=after.rows.filter(r=>Object.values(r.values||{}).some(v=>String(v?.value??'').includes(`${tag}A`)));
check('实按粘贴的内容真的落盘了（重读正式值看得到）',hit.length>0,
  hit.length?`行 ${hit.map(r=>r.row_id).join('、')}（标记 ${tag}A）`:'没查到标记');
if(hit.length){
  // ⚠️ **要数**所有行**（3×3 = 9 格**分布在 **3 行**上）
  //   ⇒ 只看第一行 ⇒ 只数到 3 格 ⇒ 会误判成「只贴了第一行」。
  const got=[];
  for(const r of after.rows){
    for(const [k,v] of Object.entries(r.values||{})){
      if(String(v?.value??'').includes(tag))got.push(`${r.row_id}.${k}`);
    }
  }
  check('落进去的是**整块 3×3**（9 格，不是只贴第一行）',got.length>=9,
    `全表 ${got.length} 格带标记：${got.slice(0,12).join('、')}`);
}

// —— ⑤ 走查不留痕迹：把贴进去的**按坐标写回原值** ——
//   ⚠️ **不是「一律置空」**（2026-10-30 踩过）：那一格**原本就有真数据**时
//   （标记盖住了它）就再也认不出来 ⇒ 那一格的真数据**被抹掉**（真出过）。
//   ⇒ 现在：**写之前记下坐标与原值**，擦的时候**按坐标写回原值**。
if(hit.length){
  const t2=await readTable(1);
  const cells=pasteWrittenCells
    // —— ⚠️ **全部坐标都写回**（原本是空的写回空值；原本有值的写回原值）
    //   —— 只写回「原本有值的」⇒ 原本是空的那几格（走查写进去的）**留在表里** ⇒ 痕迹残留；
    //   —— 「一律置空」⇒ 原本有真数据的那格**被抹掉**。
    //   ⇒ **按坐标 ＋ 原值**逐格写回，才既不留痕迹、又不丢真数据。
    //   ⚠️ **必填列不能写空**（2026-10-30 站上实测）：「案号方向」「申请途径」是必填列
    //     ⇒ 服务端**拒空值**（中文错「案号方向：不能为空（你打了 ''）」）⇒ **整批擦除都被拒**
    //     ⇒ 痕迹留在表里。⇒ 擦除时**跳过必填列**（走查本来也没往那两列写过东西）。
    .filter(c=>!REQUIRED_HEADERS.includes(c.header))
    .map(c=>({row_id:c.row_id,header:c.header,value:{type:'text',value:String(c.before??'')}}));
  if(cells.length){
    // ⚠️ **擦除前要重新读版本**（2026-10-30 踩过）：
    //   `t2` 是**擦除之前**读的 ⇒ 粘贴那一写已经把 content_version 顶高了
    //   ⇒ 用旧版本号去擦 ⇒ **版本闸拒**（417）⇒ 痕迹留在表里
    //   ⇒ **先读最新版本，再擦**。
    const t3=await readTable(1);
    const res=await context.request.post(BASE+'/api/platform/actions/files.sheet_cells_write/execute',{
      data:{payload:{table:TABLE,sheet:t3.sheet,expected_content_version:t3.content_version,
        expected_structure_version:t3.structure_version,cells},
        confirmed:true,idempotency_key:'real-paste-clean-'+Date.now(),source:'user'},
    });
    const body=await res.json().catch(()=>({}));
    console.log(`（擦掉 ${cells.length} 格走查痕迹：ok=${body.ok}${body.ok?'':' 失败='+String(body.error).slice(0,120)}）`);
    if(!body.ok)failures.push(`擦除走查痕迹失败 :: ${String(body.error).slice(0,120)}`);
  }
}
check('页面没有未捕获的 JS 异常',pageErrors.length===0,pageErrors.slice(0,3).join(' / '));

console.log(`\n结果：${failures.length?failures.length+' 项没过':'全部通过'}`);
failures.forEach(f=>console.log('  ✗',f));
await browser.close();
process.exit(failures.length?1:0);
