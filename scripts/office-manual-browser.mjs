// 本轮人工结构/格式/清空链；实际点击画布与菜单，API仅用于独立读回。
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const base=process.env.OFFICE_ACCEPTANCE_URL,file=process.env.OFFICE_FILE;
if(base!=='http://127.0.0.1:14941'||!file)throw Error('仅用于本轮本地ACCEPTANCE_ONLY站');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'});
const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base+'/login.html');await page.locator('#un').fill('office-a@example.invalid');await page.locator('#pw').fill('Office-acceptance-2026!');
 await page.getByRole('button',{name:'进入工作台'}).click();await page.waitForURL('**/index.html**');
 await page.goto(base+'/index.html?object='+file+'#/excel');await page.locator('[data-grid] canvas:visible').first().waitFor();
 await page.waitForTimeout(500);
 const read=async()=>{const r=await context.request.post(base+'/api/platform/services/files.sheet_read/invoke',{data:{payload:{table:file}}});if(!r.ok())throw Error(await r.text());return r.json();};
 // 重跑前只准备本验收文件的两条已知虚构数据；不冒充页面操作证据。
 const seed=await read();
 const prepared=await context.request.post(base+'/api/platform/actions/files.sheet_cells_write/execute',{data:{confirmed:true,
   source:'user',idempotency_key:crypto.randomUUID(),payload:{table:file,expected_content_version:seed.content_version,
   expected_structure_version:seed.structure_version,cells:seed.rows.map(row=>({row_id:row.row_id,header:'数量',
     value:{type:'number',value:row.values['客户'].value==='海星'?100:150}}))}}});
 if(!prepared.ok())throw Error('合成夹具准备失败 '+await prepared.text());
 await page.reload();await page.locator('[data-grid] canvas:visible').first().waitFor();await page.waitForTimeout(500);
 const select=async()=>{const box=await page.locator('[data-grid]').boundingBox();await page.mouse.click(box.x+178,box.y+34);await page.waitForTimeout(160);};
 const operate=async(operation,action)=>{
   await select();await page.locator('[data-structure-toggle]').click();
   const response=page.waitForResponse(r=>r.url().endsWith('/actions/files.sheet_'+action+'/execute')&&r.request().method()==='POST');
   await page.locator('[data-file-operation="'+operation+'"]').click();
   if(operation.startsWith('delete-'))await page.getByRole('button',{name:'确认删除',exact:true}).click();
   const r=await response;if(!r.ok())throw Error(await r.text());console.log('UI_OPERATION',operation,JSON.parse(r.request().postData()).payload,(await r.json()).result);
   await page.waitForTimeout(700);
 };
 await operate('bold','style');let data=await read();if(!data.rows[0].styles?.['数量']?.bold)throw Error('加粗未落盘');
 await operate('sort-asc','sort');data=await read();if(data.rows[0].values['客户'].value!=='海星')throw Error('排序未带整行');
 const originalIds=data.rows.map(r=>r.row_id);await operate('insert-row','structure');data=await read();
 if(data.rows.length!==3||data.rows[1].row_id!==originalIds[0])throw Error('插行错位');
 await operate('delete-rows','structure');data=await read();if(data.rows.length!==2||data.rows[0].row_id!==originalIds[0])throw Error('删行错位');
 const beforeClear=await read(),bodies=[];
 if(process.env.OFFICE_DROP_PASTE_AFTER_COMMIT)await page.route('**/api/platform/actions/files.sheet_paste_apply/execute',async route=>{
   bodies.push(route.request().postData());
   if(bodies.length===1){const upstream=await route.fetch();if(!upstream.ok())throw Error(await upstream.text());
     await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({ok:false,error:'受控丢回执'})});
   }else await route.continue();
 });
 await select();const cleared=page.waitForResponse(r=>r.url().endsWith('/actions/files.sheet_paste_apply/execute')&&r.request().method()==='POST');
 await page.keyboard.press('Backspace');const clearResponse=await cleared;
 if(process.env.OFFICE_DROP_PASTE_AFTER_COMMIT){
   if(clearResponse.status()!==502)throw Error('没有触发受控回执丢失');
   await page.locator('[data-retry]').waitFor();
   await page.locator('[data-discard]').click();if(!await page.locator('[data-retry]').isVisible())throw Error('未知操作被放弃');
   const retried=page.waitForResponse(r=>r.url().endsWith('/actions/files.sheet_paste_apply/execute')&&r.request().method()==='POST');
   await page.locator('[data-retry]').click();if(!(await retried).ok())throw Error('原编号核实失败');
   if(bodies[0]!==bodies[1])throw Error('核实时换了请求内容/版本');
   if((await read()).content_version!==beforeClear.content_version+1)throw Error('丢回执后发生重复版本写入');
   console.log('PASS actual server committed before injected 502; retry identical body and exactly one file version');
 }else if(!clearResponse.ok())throw Error(await clearResponse.text());
 if((await read()).rows[0].values['数量'].type!=='empty')throw Error('清空未保存为空值');
 await page.reload();await page.locator('[data-grid] canvas:visible').first().waitFor();
 if((await read()).rows[0].values['数量'].type!=='empty')throw Error('刷新丢清空');
 const download=page.waitForEvent('download');await page.locator('[data-download]').click();
 await (await download).saveAs('/private/tmp/office-ui-download-20261020.xlsx');
 for(const width of [1280,843,390]){
   await page.setViewportSize({width,height:800});await page.locator('[data-structure-toggle]').click();
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
     menu:document.querySelector('[data-structure-dropdown]').getBoundingClientRect().toJSON()}));
   if(geometry.scroll>geometry.width||geometry.menu.bottom>800)throw Error('结构菜单越出视口 '+JSON.stringify(geometry));
   await page.screenshot({path:'/private/tmp/office-structure-'+width+'-20261020.png'});
   await page.locator('[data-structure-toggle]').click();
 }
 console.log('PASS manual style/sort/insert/delete/clear/reload/download at 1280/843/390',errors);if(errors.length)throw Error(errors.join(';'));
}catch(error){console.log('FAIL',error.message,(await page.locator('#main').innerText()).slice(-2000));await page.screenshot({path:'/private/tmp/office-manual-failure-20261020.png'});throw error;}
finally{await browser.close();}
