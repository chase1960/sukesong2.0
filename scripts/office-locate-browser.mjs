// 独立受控提案验证原件定位/脏稿守卫；不是自然语言模型成功证据。
import {homedir} from 'node:os';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const base='http://127.0.0.1:14941';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'});
const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();
let accepts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/accept'))accepts++;});
try{
 await page.goto(base+'/login.html');await page.locator('#un').fill('office-a@example.invalid');await page.locator('#pw').fill('Office-acceptance-2026!');
 await page.getByRole('button',{name:'进入工作台'}).click();await page.waitForURL('**/index.html**');await page.locator('#ai-fab').click();
 const card=page.locator('.office-review');await card.getByRole('button',{name:'打开原件'}).waitFor();
 await card.getByRole('button',{name:'打开原件'}).click();await page.locator('[data-grid] canvas:visible').first().waitFor();
 await page.waitForFunction(()=>!!window.excelPageDiag?.().highlight);
 const diag=await page.evaluate(()=>window.excelPageDiag());if(diag.highlight.colIndex!==1||diag.highlight.rowIndex!==1)throw Error('没有定位原稳定行/列 '+JSON.stringify(diag.highlight));
 await page.waitForTimeout(450); // 等分栏布局过渡结束后再按真实画布坐标点选。
 await page.screenshot({path:'/private/tmp/office-review-locate-20261020.png'});
 const box=await page.locator('[data-grid]').boundingBox();await page.mouse.dblclick(box.x+178,box.y+58);
 await page.waitForTimeout(200);
 if(!await page.evaluate(()=>window.excelPageDiag().editing))throw Error('夹具未进入真实编辑态');
 await page.keyboard.press('Meta+A');await page.keyboard.type('201');
 await card.locator('[data-accept-unit]').click();await page.waitForTimeout(700);
 const status=await card.locator('[data-review-status]').innerText();console.log('DIRTY_STATUS',status);
 if(!/人工编辑|更新|预览已变化|原始记录|未保存/.test(status))throw Error('没有阻断脏稿/过期提案');
 const file=new URL(page.url()).searchParams.get('object');const r=await context.request.post(base+'/api/platform/services/files.sheet_read/invoke',{data:{payload:{table:file}}});
 const values=(await r.json()).rows.find(row=>row.values['客户'].value==='方舟').values['数量'];if(accepts)throw Error('脏稿仍发送了AI确认');
 console.log('PASS actual original navigation/highlight and dirty/stale rejection, final',values);
 await page.keyboard.press('Escape');
}catch(error){console.log('FAIL',error.message);await page.screenshot({path:'/private/tmp/office-locate-failure-20261020.png'});throw error;}
finally{await browser.close();}
