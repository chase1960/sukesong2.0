// 仅操作本轮 ACCEPTANCE_ONLY 本地站；不复用公网员工账号。
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ||
  homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'});
const context=await browser.newContext({viewport:{width:1280,height:800}});
const page=await context.newPage();const errors=[];const requests=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
const base=process.env.OFFICE_ACCEPTANCE_URL||'http://127.0.0.1:14921';
try {
  await page.goto(base+'/login.html');
  await page.locator('#un').fill('office-a@example.invalid');
  await page.locator('#pw').fill('Office-acceptance-2026!');
  await page.getByRole('button',{name:'进入工作台'}).click();
  await page.waitForURL('**/index.html**');
  await page.waitForTimeout(1200);
  console.log('dashboard',await page.locator('#main').innerText());
  if(requests.some(url=>url.includes('/excel-univer-entry.js')))throw Error('其他页面提前加载大编辑器');
  await page.goto(base+'/index.html#/excel');
  await page.locator('button.file-open[title="客户报价.xlsx"]').waitFor({timeout:30000});
  await page.screenshot({path:'/private/tmp/shangshu-office-excel-directory-20261014.png'});
  await page.locator('button.file-open[title="客户报价.xlsx"]').click();
  await page.locator('[data-grid] canvas:visible').first().waitFor({timeout:30000});
  await page.waitForTimeout(1500);
  console.log('editor',await page.locator('#main').innerText());
  await page.screenshot({path:'/private/tmp/shangshu-office-excel-editor-20261014.png'});
  const table=new URL(page.url()).searchParams.get('object');
  const read=async()=>{
    const r=await context.request.post(base+'/api/platform/services/files.sheet_read/invoke',
      {data:{payload:{table}}});
    if(!r.ok())throw Error('读回失败 '+await r.text());
    return await r.json();
  };
  const initial=await read();console.log('read shape',Object.keys(initial));
  const box=await page.locator('[data-grid]').boundingBox();
  await page.mouse.dblclick(box.x+178,box.y+34);
  await page.keyboard.press('Meta+A');await page.keyboard.type('160');
  const saved=page.waitForResponse(r=>r.url().includes('/actions/files.sheet_cell_write/execute')&&r.request().method()==='POST');
  await page.keyboard.press('Enter');
  const response=await saved;console.log('cell_save',response.status(),await response.json());
  await page.waitForTimeout(500);
  const edited=await read();
  if(edited.rows[0].values['数量'].value!==160)throw Error('实际单元格未保存160');
  await page.locator('[data-undo]').click();await page.waitForTimeout(800);
  if((await read()).rows[0].values['数量'].value!==initial.rows[0].values['数量'].value)throw Error('页面撤回未落盘');
  console.log('PASS actual UI cell edit, server readback and undo');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
  const narrow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  if(narrow.width!==narrow.scroll)throw Error('表格页面窄屏溢出');
  await page.screenshot({path:'/private/tmp/shangshu-office-excel-mobile-20261014.png'});
  await page.setViewportSize({width:1280,height:800});
  for(const hash of ['#/file-center','#/mail','#/task-mgmt','#/im']){
    await page.goto(base+'/index.html'+hash);await page.waitForTimeout(1500);
    console.log('page',hash,(await page.locator('#main').innerText()).slice(0,900));
    await page.screenshot({path:'/private/tmp/shangshu-office-'+hash.slice(2)+'-20261014.png'});
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    console.log('mobile',hash,geometry);
    if(geometry.scroll>geometry.width)throw Error('窄屏页面溢出 '+hash);
    await page.setViewportSize({width:1280,height:800});
  }
  await page.goto(base+'/index.html#/mail');
  const draft=page.locator('button.mail-item').filter({hasText:'客户报价确认'}).first();
  await draft.waitFor();const mail=await draft.getAttribute('data-mail');await draft.click();
  await page.locator('#c-subject').waitFor();
  const editor=page.locator('#c-editor-host [contenteditable="true"]').first();
  await editor.waitFor();
  if(await editor.locator('table').count()!==1)throw Error('重开草稿丢失表格');
  await page.locator('#c-subject').fill('客户报价确认（人工复核）');
  await editor.click();await page.waitForTimeout(1200);
  const detail=await context.request.post(base+'/api/platform/services/mail.detail/invoke',
    {data:{payload:{mail}}});const savedMail=(await detail.json()).mail;
  if(savedMail.subject!=='客户报价确认（人工复核）'||!savedMail.body.includes('<table'))throw Error('草稿自动保存或表格保留失败');
  console.log('PASS actual UI HTML draft reopen, subject edit and autosave without send');
  await page.screenshot({path:'/private/tmp/shangshu-office-mail-compose-20261014.png'});
  await page.locator('#dlg-close').click();
  console.log('page_errors',errors);
  if(errors.length)throw Error(errors.join('; '));
} catch(error) {
  console.log('failed_url',page.url(),'content',(await page.locator('#main').innerText()).slice(0,1800),'errors',errors);
  await page.screenshot({path:'/private/tmp/shangshu-office-browser-failure-20261014.png'});
  throw error;
} finally {await browser.close();}
