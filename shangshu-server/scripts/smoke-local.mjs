// 可选完整进程验收：真实本地 Python/PDF 解析，不访问云模型，不使用客户数据。
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
const freePort=()=>new Promise(resolve=>{const server=createServer().listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const root=mkdtempSync(join(tmpdir(),'ss-local-e2e-')),data=join(root,'data');
const password=randomUUID(),env={...process.env,_SS_DATA_DIR:data,HOST:'127.0.0.1',SS_INITIAL_ADMIN_PASSWORD:password};
const python=process.platform==='win32'?'scripts/venv/Scripts/python.exe':'scripts/venv/bin/python';
if(!existsSync(python)) throw new Error('先按本地交付文档安装 scripts/venv 与 OCR 依赖');
const fixture=spawnSync(python,['-c',"import runpy,sys; sys.stdout.buffer.write(runpy.run_path('tests/scripts/ocr_provider.test.py')['_railway_pdf']())"]);
assert.equal(fixture.status,0,fixture.stderr?.toString());
const setup=spawnSync(process.execPath,['--import','tsx','scripts/instance.ts','setup','--data-dir',data],{env,encoding:'utf8'});
assert.equal(setup.status,0,setup.stderr);
const port=await freePort(),ocrPort=await freePort(),configPath=join(data,'runtime_config.json'),cfg=JSON.parse(readFileSync(configPath));
cfg.server.port=port;cfg.ocr.port=ocrPort;cfg.ocr.provider='vllm';cfg.ocr.base_url='http://127.0.0.1:9/v1';cfg.ocr.model='fixture-unused';
cfg.enterprise={name:'测试样例有限公司'};
writeFileSync(configPath,JSON.stringify(cfg),{mode:0o600});
const child=spawn(process.execPath,['--import','tsx','src/main.ts'],{env,stdio:['ignore','pipe','pipe']});
let logs='',passed=false,cookie='';
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const exited=new Promise(resolve=>child.once('exit',resolve));
const url=`http://127.0.0.1:${port}`;
const request=async(path,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(url+path,{method,headers:{cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
};
try {
  let ready=false;
  for(let attempt=0;attempt<60;attempt++) {
    try {const r=await fetch(url+'/api/session');if(r.status<500){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,'启动超时：'+logs);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});
  assert.equal(login.status,200);cookie=login.headers.get('set-cookie');
  assert.ok(existsSync(join(data,'.instance-lock')));
  const health=await request('/api/instance/health');assert.ok(health.ok);
  const upload=await fetch(url+'/api/documents/upload?doctype=invoice_cn_vat&name=fixture.pdf',{method:'POST',headers:{cookie,'Content-Type':'application/octet-stream'},body:fixture.stdout});
  const run=await upload.json();assert.equal(upload.status,200,JSON.stringify(run));assert.equal(run.status,'completed',JSON.stringify(run));
  assert.equal(run.result.extraction_path,'text-rule');assert.equal(run.result.fields.total_amount,123.45);
  const invoice=run.result.invoice_id;assert.ok(invoice);
  assert.equal((await request('/api/invoices/'+invoice)).status,'待审');
  await request('/api/invoices/'+invoice,{status:'已入库'},'PATCH');
  await request('/api/invoices/'+invoice,{status:'已入账'},'PATCH');
  assert.equal((await request('/api/cash')).summary.paid,0);
  const bills=await request('/api/payables');assert.equal(bills.list.length,1);assert.equal(bills.list[0].amount,123.45);
  await request('/api/payables/'+bills.list[0].id+'/pay',{amount:12.34,occurred_on:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())});
  assert.equal((await request('/api/cash')).summary.paid,12.34);
  passed=true;console.log('PASS：新实例启动 → 真实本地 PDF 文字解析 → 待审 → 人工入库 → 入账应付 → 部分付款 → 现金口径一致（无云模型调用）');
} finally {
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),5000);
  child.kill('SIGTERM');await exited;clearTimeout(watchdog);
  assert.equal(existsSync(join(data,'.instance-lock')),false,'正常退出应释放实例锁');
  if(passed) rmSync(root,{recursive:true,force:true});else console.error('隔离失败现场：'+root);
}
