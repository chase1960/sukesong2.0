import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {localStore as store} from '../../src/core/store.ts';
import {ensureBootstrap,createUser} from '../../src/core/auth/users.ts';
import {buildApp} from '../../src/adapters/web/server.ts';
import {businessDate} from '../../src/capabilities/finance-domain.ts';
import {parseCSV,encodeCSV} from '../../src/capabilities/business-transfer.ts';
describe('单企业日常工作闭环',()=>{
  let server:Server,base:string;const cookies:Record<string,string>={};
  async function request(path:string,body?:any,user='admin',method=body===undefined?'GET':'POST') {
    const r=await fetch(base+path,{method,headers:{cookie:cookies[user] || '', 'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  }
  beforeEach(async()=>{
    process.env._SS_DATA_DIR=mkdtempSync(join(tmpdir(),'ss-sme-ready-'));
    await ensureBootstrap(store);
    for(const [username,role] of [['alice','staff'],['bob','staff'],['boss','manager']] as const) await createUser(store,{username,password:'test123',role});
    server=buildApp().listen(0);await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as any).port}`;
    for(const username of ['admin','alice','bob','boss']) {
      const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:username==='admin'?'admin':'test123'})});cookies[username]=r.headers.get('set-cookie')!;
    }
  });
  afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
  it('发票入账不算到账；部分收款阻止撤回，冲回后可撤回重入账且不重复债务',async()=>{
    const customer=await store.insert('business','customers',{name:'甲'});
    const invoice=await store.insert('business','invoices',{invoice_no:'12345678901234567890',invoice_direction:'出项',status:'已入库',customer_id:customer,total_amount:100,amount_ex_tax:100,tax_amount:0,seller_name:'本企业',buyer_name:'甲'});
    assert.equal((await request('/api/invoices/'+invoice,{status:'已入账'},'admin','PATCH')).status,200);
    assert.equal((await request('/api/cash')).data.summary.received,0);
    const [bill]=await store.query('business','receivables');
    assert.equal((await request('/api/receivables/'+bill.id+'/pay',{amount:40,occurred_on:businessDate()})).status,200);
    assert.equal((await request('/api/cash')).data.summary.received,40);
    assert.equal((await request('/api/invoices/'+invoice+'/unbook',{reason:'科目录入错误'})).status,400);
    const [move]=await store.query('business','cash_movements');
    assert.equal((await request('/api/cash/'+move.id+'/reverse',{reason:'重复登记'})).status,200);
    assert.equal((await request('/api/cash/'+move.id+'/reverse',{reason:'再冲'})).status,400);
    assert.equal((await request('/api/cash')).data.summary.received,0);
    assert.equal((await request('/api/invoices/'+invoice+'/unbook',{reason:'科目录入错误'})).status,200);
    assert.equal((await request('/api/invoices/'+invoice,{status:'已入账'},'admin','PATCH')).status,200);
    const ledger=await store.query('business','ledger');assert.equal(ledger.length,3);assert.equal(ledger.reduce((s,r)=>s+r.total_amount,0),100);
    const bills=await store.query('business','receivables');assert.equal(bills.filter(r=>r.status!=='已撤销').length,1);assert.equal(bills.reduce((s,r)=>s+r.amount,0),100);
  });
  it('任务派发、员工反馈、经理验收；他人不可见也不可改，帖子竞争只认领一次',async()=>{
    assert.equal((await request('/api/tasks',{title:'核对合同',assignee_id:'alice'},'boss')).status,200);
    const task=(await request('/api/tasks',undefined,'alice')).data.list[0];
    assert.equal((await request('/api/tasks',undefined,'bob')).data.list.length,0);
    assert.notEqual((await request('/api/tasks/'+task.id,{status:'进行中'},'bob','PATCH')).status,200);
    assert.equal((await request('/api/tasks/'+task.id,{status:'进行中',expected_version:task._version},'alice','PATCH')).status,200);
    assert.notEqual((await request('/api/tasks/'+task.id,{status:'已完成'},'alice','PATCH')).status,200);
    assert.notEqual((await request('/api/tasks/'+task.id,{status:'待验收'},'alice','PATCH')).status,200);
    assert.equal((await request('/api/tasks/'+task.id,{status:'待验收',result:'已核对 12 份，差异已标注'},'alice','PATCH')).status,200);
    const selfAcceptance=await request('/api/tasks/'+task.id,{status:'已完成'},'alice','PATCH');
    assert.notEqual(selfAcceptance.status,200);
    assert.match(String(selfAcceptance.data.error || ''),/任务管理者/);
    assert.equal((await request('/api/tasks/'+task.id,{status:'已完成'},'boss','PATCH')).status,200);
    const notice=(await request('/api/me/work',undefined,'boss')).data.notifications;
    assert.ok(notice.some((n:any)=>n.message.includes('待验收')));
    assert.equal((await request('/api/me/notifications/'+notice[0].id+'/read',{},'alice')).status,404);
    assert.equal((await request('/api/me/notifications/'+notice[0].id+'/read',{},'boss')).status,200);
    await request('/api/posts',{content:'整理样本'},'boss');const [post]=await store.query('process','posts');
    const claims=await Promise.all(['alice','bob'].map(user=>request('/api/posts/'+post.id+'/claim',{},user)));
    assert.equal(claims.filter(r=>r.status===200).length,1);assert.equal((await store.query('process','tasks',{post_id:post.id})).length,1);
  });
  it('任务通知带回源跳转；改派双向通知新旧负责人，重复改派请求不重复提醒',async()=>{
    assert.equal((await request('/api/tasks',{title:'提醒链检查',assignee_id:'alice'},'boss')).status,200);
    const task=(await request('/api/tasks',undefined,'alice')).data.list[0];
    const aliceWork=(await request('/api/me/work',undefined,'alice')).data;
    const created=aliceWork.notifications.find((n:any)=>n.message.includes('新任务'));
    assert.ok(created,'派单后负责人应收到新任务提醒');
    assert.equal(created.entity_type,'task');assert.equal(created.entity_id,task.id);
    assert.ok(String(created.action_url).includes('task-mgmt?task='),'提醒必须能跳回任务');
    // 改派 alice → bob：bob 收到“改派给你”，alice 收到“已移交”
    assert.equal((await request('/api/tasks/'+task.id,{assignee_id:'bob'},'boss','PATCH')).status,200);
    const bobWork=(await request('/api/me/work',undefined,'bob')).data;
    assert.ok(bobWork.notifications.some((n:any)=>n.message.includes('已改派给你')));
    assert.ok((await request('/api/me/work',undefined,'alice')).data.notifications.some((n:any)=>n.message.includes('已移交给 bob')));
    // 同一改派请求重放（同 assignee 再 PATCH）不产生新提醒
    assert.equal((await request('/api/tasks/'+task.id,{assignee_id:'bob'},'boss','PATCH')).status,200);
    assert.equal((await request('/api/me/work',undefined,'bob')).data.notifications.length,bobWork.notifications.length);
    // 改派通知也带跳转
    for(const n of bobWork.notifications) assert.ok(String(n.action_url).includes('task-mgmt?task='));
  });
  it('任务取消：发起人/管理员可取消待办与进行中，负责人被通知且记录保留；负责人与他人不可取消',async()=>{
    assert.equal((await request('/api/tasks',{title:'取消契约检查',assignee_id:'alice'},'boss')).status,200);
    const task=(await request('/api/tasks',undefined,'alice')).data.list[0];
    // 负责人（员工）不可取消
    assert.notEqual((await request('/api/tasks/'+task.id,{status:'已取消'},'alice','PATCH')).status,200);
    // 发起人取消待办任务
    assert.equal((await request('/api/tasks/'+task.id,{status:'已取消'},'boss','PATCH')).status,200);
    assert.equal((await store.query('process','tasks',{id:task.id})).length,1,'取消不物理删除记录');
    const notice=(await request('/api/me/work',undefined,'alice')).data.notifications;
    assert.ok(notice.some((n:any)=>n.message.includes('已取消')),'负责人应收到取消通知');
    // 已取消为终态：不可再流转；重复提交同状态是无变化的幂等操作，不产生新通知
    assert.notEqual((await request('/api/tasks/'+task.id,{status:'进行中'},'boss','PATCH')).status,200);
    const before=(await request('/api/me/work',undefined,'alice')).data.notifications.length;
    assert.equal((await request('/api/tasks/'+task.id,{status:'已取消'},'boss','PATCH')).status,200,'同状态提交为无变化幂等');
    assert.equal((await store.query('process','tasks',{id:task.id}))[0].status,'已取消');
    assert.equal((await request('/api/me/work',undefined,'alice')).data.notifications.length,before,'重复取消不重复通知');
    // 待验收不可取消
    assert.equal((await request('/api/tasks',{title:'验收后不可取消',assignee_id:'alice'},'boss')).status,200);
    const t2=(await request('/api/tasks',undefined,'alice')).data.list.find((t:any)=>t.title==='验收后不可取消');
    assert.equal((await request('/api/tasks/'+t2.id,{status:'进行中'},'alice','PATCH')).status,200);
    assert.equal((await request('/api/tasks/'+t2.id,{status:'待验收',result:'已完成'},'alice','PATCH')).status,200);
    assert.notEqual((await request('/api/tasks/'+t2.id,{status:'已取消'},'boss','PATCH')).status,200,'待验收不可取消');
  });
  it('停用员工返回其在途任务清单；任务记录保留、改派后方可推进',async()=>{
    assert.equal((await request('/api/tasks',{title:'停用告警检查A',assignee_id:'alice'},'boss')).status,200);
    assert.equal((await request('/api/tasks',{title:'停用告警检查B',assignee_id:'alice'},'boss')).status,200);
    assert.equal((await request('/api/tasks',{title:'停用告警检查C',assignee_id:'alice'},'boss')).status,200);
    const aliceTasks=(await request('/api/tasks',undefined,'alice')).data.list;
    const tA=aliceTasks.find((t:any)=>t.title==='停用告警检查A');
    const tB=aliceTasks.find((t:any)=>t.title==='停用告警检查B');
    const tC=aliceTasks.find((t:any)=>t.title==='停用告警检查C');
    assert.equal((await request('/api/tasks/'+tA.id,{status:'进行中'},'alice','PATCH')).status,200);
    assert.equal((await request('/api/tasks/'+tB.id,{status:'进行中'},'alice','PATCH')).status,200);
    assert.equal((await request('/api/tasks/'+tB.id,{status:'待验收',result:'完成'},'alice','PATCH')).status,200);
    const [aliceUser]=await store.query('cognition','users',{username:'alice'});
    const deactivate=await request('/api/users/'+aliceUser.id+'/status',{status:'停用'},'admin','PATCH');
    assert.equal(deactivate.status,200);
    assert.deepEqual(deactivate.data.open_tasks.map((t:any)=>t.status).sort(),['待办','待验收','进行中'],'三项在途任务全部返回');
    assert.equal((await store.query('process','tasks',{id:tA.id})).length,1,'停用不删除任务记录');
    assert.equal((await request('/api/tasks/'+tC.id,{assignee_id:'bob'},'boss','PATCH')).status,200,'管理员仍可将任务改派给在职同事');
  });
  it('协作分组收窄：分组管理者只见/只派本组，admin 与未分组者保持全公司',async()=>{
    await createUser(store,{username:'dev1',password:'test123',role:'staff',display_name:'开发甲',collaboration_group:'开发'});
    const users=await store.query('cognition','users');
    const idOf=(username:string)=>users.find((u:any)=>u.username===username)!.id;
    for(const [username,group] of [['boss','开发'],['alice','财务'],['bob','财务']] as const)
      assert.equal((await request('/api/users/'+idOf(username)+'/group',{group},'admin','PATCH')).status,200);
    // 非法分组被拒
    assert.notEqual((await request('/api/users/'+idOf('bob')+'/group',{group:'人事'},'admin','PATCH')).status,200);
    // admin 派给财务组 alice；开发组 boss 看不到该任务，也不能派给/改派给 alice
    assert.equal((await request('/api/tasks',{title:'财务月结',assignee_id:'alice'},'admin')).status,200);
    assert.equal((await request('/api/tasks',{title:'开发联调',assignee_id:'dev1'},'admin')).status,200);
    const bossView=(await request('/api/tasks',undefined,'boss')).data.list.map((t:any)=>t.title);
    assert.ok(bossView.includes('开发联调'),'本组任务可见');
    assert.ok(!bossView.includes('财务月结'),'他组任务不可见');
    assert.notEqual((await request('/api/tasks',{title:'越组派单',assignee_id:'alice'},'boss')).status,200,'不能派给他组成员');
    assert.equal((await request('/api/tasks',{title:'组内派单',assignee_id:'dev1'},'boss')).status,200);
    const devTask=(await request('/api/tasks',undefined,'boss')).data.list.find((t:any)=>t.title==='开发联调');
    assert.notEqual((await request('/api/tasks/'+devTask.id,{assignee_id:'alice'},'boss','PATCH')).status,200,'不能改派给他组成员');
    // 选人候选：boss 只见本组；admin 全量；消息目录不收窄
    const bossPeople=(await request('/api/people?scope=tasks',undefined,'boss')).data.list.map((p:any)=>p.username);
    assert.deepEqual(bossPeople.sort(),['boss','dev1']);
    assert.ok((await request('/api/people?scope=tasks',undefined,'admin')).data.list.length>=5,'admin 候选不受限');
    assert.ok((await request('/api/im/users',undefined,'boss')).data.list.some((u:any)=>u.username==='alice'),'跨组私聊不受影响');
    // admin 未收窄：全公司任务可见
    const adminView=(await request('/api/tasks',undefined,'admin')).data.list.map((t:any)=>t.title);
    assert.ok(adminView.includes('财务月结')&&adminView.includes('开发联调'));
  });
  it('CSV 预览无业务副作用、重复导入幂等、期初不冒充现金、旧预览冲突整批拒绝',async()=>{
    const customers='external_key,name,kind,phone\nC1,甲,客户,123\nC2,乙,供应商,456\n';
    const p=await request('/api/data/import/preview',{kind:'customers',csv:customers});assert.equal(p.data.ok,true);assert.equal((await store.query('business','customers')).length,0);
    assert.equal((await request('/api/data/import/'+p.data.id+'/commit',{})).status,200);
    assert.equal((await request('/api/data/import/'+p.data.id+'/commit',{})).status,200);assert.equal((await store.query('business','customers')).length,2);
    const csv='external_key,party_key,amount,settled,as_of,due_date\nR1,C1,1000,300,2026-01-01,2026-02-01\n';
    const opening=await request('/api/data/import/preview',{kind:'receivables',csv});assert.equal(opening.data.ok,true);
    await request('/api/data/import/'+opening.data.id+'/commit',{});
    const cash=(await request('/api/cash')).data.summary;assert.equal(cash.received,0);assert.equal(cash.unreceived,700);assert.deepEqual(cash.warnings,[]);
    const invalid=await request('/api/data/import/preview',{kind:'receivables',csv:csv.replace('300','1001').replace('R1','R2')});assert.equal(invalid.data.ok,false);assert.match(invalid.data.errors[0],/第 2 行/);
    const conflict=await request('/api/data/import/preview',{kind:'customers',csv:'external_key,name,kind,phone\nC3,丙,客户,\nC4,丁,客户,\n'});
    await store.insert('business','customers',{external_key:'C4',name:'别人先导入'});
    assert.equal((await request('/api/data/import/'+conflict.data.id+'/commit',{})).status,409);
    assert.equal((await store.query('business','customers',{external_key:'C3'})).length,0);
    assert.equal((await request('/api/data/import/preview',{kind:'customers',csv:customers},'alice')).status,403);
  });
  it('员工只能查看本人发票，不能读他人原件或资金接口',async()=>{
    await store.insert('business','invoices',{id:'own',submitted_by:'alice',file_token:'own.pdf'});
    await store.insert('business','invoices',{id:'other',submitted_by:'bob',file_token:'other.pdf'});
    assert.deepEqual((await request('/api/invoices',undefined,'alice')).data.map((r:any)=>r.id),['own']);
    assert.equal((await request('/api/invoices/other',undefined,'alice')).status,403);
    assert.equal((await request('/api/files/other.pdf',undefined,'alice')).status,404);
    assert.equal((await request('/api/cash',undefined,'alice')).status,403);
  });
});
it('CSV 引号、换行和公式注入处理',()=>{
  assert.deepEqual(parseCSV('\uFEFFa,b\r\n"a,b","两\n行"\r\n'),[['a','b'],['a,b','两\n行']]);
  assert.throws(()=>parseCSV('a\n"未闭合'),/引号/);
  assert.match(encodeCSV([{name:'=1+1',amount:-1}],['name','amount']),/"'=1\+1","-1"/);
});
