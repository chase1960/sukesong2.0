// 真实自然语言 → 已配置模型 → 原提案 → 页面逐项确认。仅本轮本地验收站。
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(homedir()+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const base=process.env.OFFICE_ACCEPTANCE_URL;
if(!base?.startsWith('http://127.0.0.1:14941'))throw Error('仅允许本轮ACCEPTANCE_ONLY本机站');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'});
const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('response',async r=>{if(r.url().endsWith('/api/chat'))console.log('CHAT_SSE',(await r.body().catch(()=>Buffer.from(''))).toString('utf8'));});
try{
 await page.goto(base+'/login.html');await page.locator('#un').fill('office-a@example.invalid');await page.locator('#pw').fill('Office-acceptance-2026!');
 await page.getByRole('button',{name:'进入工作台'}).click();await page.waitForURL('**/index.html**');
 await page.locator('#ai-fab').click();
 const send=async message=>{await page.locator('#input').fill(message);await page.locator('#send-btn').click();};
 if(!process.env.OFFICE_REVIEW_MAIL_ONLY){
 await send('请读取客户报价.xlsx，把客户“方舟”这一行的数量改成180，备注改成“已与客户确认”。先生成修改建议，由我确认保存。');
 await page.locator('.office-review [data-accept-unit]').first().waitFor({timeout:120000});
 const card=page.locator('.office-review').last();console.log('EXCEL_REVIEW',await card.innerText());
 const editor=card.locator('[data-review-unit]').filter({hasText:'数量'}).locator('textarea');
 if(await editor.count())await editor.fill('185');
 await card.locator('[data-accept-unit]').first().click();await card.locator('[data-review-status]').filter({hasText:'已保存 1 项'}).waitFor();
 await page.screenshot({path:'/private/tmp/office-review-excel-partial-20261020.png'});
 await card.getByRole('button',{name:'保存全部待审项'}).click();
 await card.locator('[data-review-status]').filter({hasText:'待审 0 项'}).waitFor();
 console.log('EXCEL_SAVED',await card.innerText());
 }
 await page.reload();await page.waitForTimeout(500);
 if(await page.locator('#ai-fab').isVisible())await page.locator('#ai-fab').click();
 await page.getByRole('button',{name:'新建对话',exact:true}).click();
 await send('请读取主题为“客户报价确认（人工复核）”的邮件草稿，把主题改为“客户报价确认｜待客户回复”，正文改成“您好，报价已复核，请确认数量及交期，谢谢。”。只生成建议，不要发送邮件。');
 await page.waitForFunction(()=>!document.querySelector('#send-btn')?.classList.contains('stopping'),{timeout:120000});
 if(!await page.locator('.office-review [data-accept-unit]').count()){
   await send('确认把正文全部替换成刚才那句话，原表格不保留，收件人不变。请生成更新草稿的确认卡，不发送邮件。');
 }
 await page.locator('.office-review [data-accept-unit]').first().waitFor({timeout:120000});
 const mail=page.locator('.office-review').last();console.log('MAIL_REVIEW',await mail.innerText());
 await mail.getByRole('button',{name:'保存全部待审项'}).click();await mail.locator('[data-review-status]').filter({hasText:'待审 0 项'}).waitFor();
 await page.screenshot({path:'/private/tmp/office-review-mail-20261020.png'});
 console.log('MAIL_SAVED',await mail.innerText());if(errors.length)throw Error(errors.join(';'));
}catch(error){console.log('FAIL',error.message,await page.locator('#chat').innerText().catch(()=>''));await page.screenshot({path:'/private/tmp/office-review-failure-20261020.png'});throw error;}
finally{await browser.close();}
