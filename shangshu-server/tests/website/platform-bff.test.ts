import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../../src/adapters/web/server.ts';
import { createPlatformChatBridge, validateProcessProposal, attachmentFilename, describeActionForModel } from '../../src/adapters/web/platform.ts';
import { platformRoleOf } from '../../src/core/auth/platform-identity.ts';
import type { ExternalServices } from '../../src/core/types.ts';

// —— R967-D01（BASE967-26）：工具用途描述与选择条件 ——
// 测试通过 = 什么成立：单元格写入类动作与整份文件审核类动作的模型描述可区分；
// 改之前（UI035 实测）：files.review 标题「保存文件审核」，模型把改单元格意图塞进 note/relations，
// 未产生原格候选；改之后：描述声明各自适用范围，审核类动作明示「不是单元格写入」。
it('单元格写意图的选择条件：测试通过 = sheet写动作与整份文件审核动作描述可区分，审核类明示不是单元格写入', () => {
  const cellWrite = describeActionForModel({
    id: 'files.sheet_cells_write', title: '写表格单元格', effect: 'write', confirmation: 'required',
    input_schema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, sheet: { type: 'string' }, cells: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, col: { type: 'integer' }, value: {} } } } } },
  });
  const fileReview = describeActionForModel({
    id: 'files.review', title: '保存文件审核', effect: 'write', confirmation: 'required',
    input_schema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, note: { type: 'string' }, relations: { type: 'array', items: { type: 'object', properties: { object_id: { type: 'string' }, values: { type: 'object' } } } } } },
  });
  assert.match(cellWrite, /单元格/);
  assert.match(cellWrite, /修改.*值|写入.*值/);
  assert.match(fileReview, /不是单元格写入/);
  assert.match(fileReview, /审核|备注|关联/);
  assert.doesNotMatch(fileReview, /改单元格值用这类动作/);
});

// BASE967-12 续：单格动作开放给 Agent 后，模型面前同时有「改一格 / 改多格 / 撤回」
// 三个都像改表格的动作——schema 能认出它们是格值类，但**分不出单格与批量**，
// 撤回的 schema 更看不出它是「反向操作」。这三条必须各自说清适用范围。
it('单格/批量/撤回的选择条件：测试通过 = 单格说单格、批量说批量、撤回说撤回（BASE967-12）', () => {
  const single = describeActionForModel({
    id: 'files.cell_write', title: '写一格', effect: 'write', confirmation: 'required',
    input_schema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, row_id: { type: 'string' }, header: { type: 'string' }, value: {} } },
  });
  const batch = describeActionForModel({
    id: 'files.sheet_cells_write', title: '批量写表格单元格', effect: 'write', confirmation: 'required',
    input_schema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, cells: { type: 'array' } } },
  });
  const undo = describeActionForModel({
    id: 'files.sheet_cells_undo', title: '撤回表格写入', effect: 'write', confirmation: 'required',
    input_schema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, op_id: { type: 'string' } } },
  });
  assert.match(single, /一格/, '单格动作应说明用于改一格');
  assert.match(single, /多格|批量/, '单格动作应指向「多格用批量」，否则模型会拿单格包一片');
  assert.match(batch, /批量|多格|一次/, '批量动作应说明一次提交多格');
  assert.match(undo, /撤回/, '撤回动作应说明是反向操作');
  assert.match(undo, /不是单元格写入|不是修改/, '撤回不得被当成改单元格的动作');
});

it('工具说明与真实kind边界一致且不按相似字段猜用途',()=>{
  assert.doesNotMatch(describeActionForModel({id:'files.cell_write',title:'写一格（有字段走数据库、没字段走xlsx）',effect:'write'}),/数据库|xlsx/);
  const write=describeActionForModel({id:'custom.write',effect:'write',confirmation:'none'});
  assert.match(write,/只生成确认提案/);assert.doesNotMatch(write,/只读调用/);
  for(const action of [
    {id:'files.sheet_range_read',effect:'read',input_schema:{properties:{start_row:{},table:{}}}},
    {id:'files.upload',effect:'write',input_schema:{properties:{file:{},note:{}}}},
    {id:'files.sheet_style_write',effect:'write',input_schema:{properties:{cells:{}}}},
  ])assert.doesNotMatch(describeActionForModel(action),/适用于修改表格单元格值|适用于整份文件的审核/);
  assert.match(describeActionForModel({id:'files.sheet_range_read',effect:'read'}),/只读调用/);
  const range=describeActionForModel({id:'files.sheet_paste_apply',effect:'write'});
  assert.match(range,/start_row\/start_col.*从0/);assert.doesNotMatch(range,/row_id取.*header取/);
  const mail=describeActionForModel({id:'mail.save_draft',effect:'write'});
  assert.match(mail,/新建时省略mail和expected_version/);assert.match(mail,/mailbox.*发件身份ID/);assert.match(mail,/不发送/);
});

it('晋升与值写入分开，写提案范围和同名目标约束一致',()=>{
  const promotion=describeActionForModel({id:'files.promotion_define',effect:'write'});
  assert.match(promotion,/列与业务字段的绑定及字段规则/);
  assert.match(promotion,/不是修改已有单元格值/);
  assert.match(promotion,/不能为写值擅自晋升/);
  for(const id of ['files.promotion_define','files.cell_write','mail.save_draft','custom.write']){
    const description=describeActionForModel({id,effect:'write'});
    assert.match(description,/每个confirmation_id仅代表该提案范围/);
    assert.match(description,/不代表同会话其他提案或全部任务完成/);
    assert.match(description,/同名表、邮件或字段须按ID核对/);
    assert.match(description,/无法唯一确定时先澄清/);
  }
  assert.doesNotMatch(describeActionForModel({id:'custom.read',effect:'read'}),/每个confirmation_id|受管结构定义/);
});

describe('平台 BFF 统一身份与票据抽取', () => {
  it('附件名兼容UTF8 filename与标准filename*，非法编码不会伪造新文件名',()=>{
    const name='方舟采购说明.txt';
    assert.equal(attachmentFilename('attachment; filename="'+Buffer.from(name,'utf8').toString('latin1')+'"'),name);
    assert.equal(attachmentFilename("attachment; filename=fallback.txt; filename*=UTF-8''"+encodeURIComponent(name)),name);
    assert.equal(attachmentFilename('attachment; filename="café.txt"'),'café.txt');
    assert.equal(attachmentFilename("attachment; filename=safe.txt; filename*=UTF-8''%ZZ"),'safe.txt');
  });
  it('费用审批角色不自动提升协作管理权限', () => {
    assert.equal(platformRoleOf(['Desk User', 'Expense Approver'], ['expense_approve']), 'staff');
    assert.equal(platformRoleOf(['Desk User', 'Collaboration Manager', 'Expense Approver'], ['collaboration_manage', 'expense_approve']), 'manager');
  });
  let upstream: Server;
  let server: Server;
  let base = '';
  let oldUpstream: string | undefined;
  let oldMode: string | undefined;
  const calls: Array<{ method: string; body: any; cookie: string; query: Record<string, string> }> = [];
  let referenceRevoked=false;
  let largeCatalog=false;
  let actionRevoked=false;

  before(async () => {
    oldUpstream = process.env.FRAPPE_UPSTREAM;
    oldMode = process.env.SHANGSHU_PLATFORM_MODE;
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const path = new URL(req.url || '/', 'http://local');
        const method = decodeURIComponent(path.pathname.replace('/api/method/', ''));
        let body: any = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* no-op */ }
        calls.push({ method, body, cookie: String(req.headers.cookie || ''), query: Object.fromEntries(path.searchParams) });
        res.setHeader('content-type', 'application/json');

        if (method === 'login') {
          assert.equal(body.usr, 'manager1@shangshu.local');
          res.setHeader('set-cookie', ['sid=frappe-test; HttpOnly; Path=/; SameSite=Lax', 'system_user=yes; Path=/']);
          res.end(JSON.stringify({ message: 'Logged In' }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.session') {
          if (!String(req.headers.cookie || '').includes('sid=frappe-test')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ exc_type: 'PermissionError', message: '需要登录' }));
            return;
          }
          res.end(JSON.stringify({ message: { identity_id: 'identity-1', user_name: 'manager1@shangshu.local', display_name: '尚经理', roles: ['Desk User', 'Collaboration Manager', 'Expense Approver'], capabilities: { collaboration_manage: true, expense_approve: true }, enterprise: { id: 'default', name: '当前企业' } } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.csrf') {
          res.end(JSON.stringify({ message: { csrf_token: 'csrf-test' } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.people') {
          res.end(JSON.stringify({message:[]})); return;
        }
        if (method === 'shangshu_core.public_api.http.object_record') {
          if (!String(req.headers.cookie || '').includes('sid=frappe-test') || path.searchParams.get('name')==='denied') {
            res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'无记录权限'}));return;
          }
          res.end(JSON.stringify({message:{object:{...(path.searchParams.get('name')==='leased-record'?{execution_actor_field:'responsible_user'}:{}),source:'managed',revision:1,operations:['read','update'],fields:[{id:'title',type:'text',label:'名称'}],input_schema:{properties:{title:{type:'string'}}}},record:{name:'r1',modified:'m1'}}}));return;
        }
        if(method==='shangshu_core.public_api.http.reference_run'){
          if(body.operation==='check'&&referenceRevoked){res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'来源已交接'}));return;}
          res.end(JSON.stringify({message:{id:'REX-TEST',status:body.operation==='end'?'Completed':'Active'}}));return;
        }
        if (method === 'shangshu_core.public_api.http.file_content') {
          assert.equal(req.headers.cookie,'sid=frappe-test');
          assert.equal(path.searchParams.get('ref_doctype'),'Owned File');
          assert.equal(path.searchParams.get('ref_name'),'f1');
          if (['read.pdf','read.png'].includes(path.searchParams.get('file')||'')) {
            res.setHeader('content-disposition','attachment; filename="'+path.searchParams.get('file')+'"');
            res.end('authorized test bytes');return;
          }
          assert.equal(path.searchParams.get('file'),'v1');
          res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'无原件权限'}));return;
        }
        if (method === 'shangshu_core.public_api.http.applications') {
          res.end(JSON.stringify({ message: [{ id: 'com.shangshu.finance.expense_management', title: '费用管理', enabled: true }] }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.objects') {
          res.end(JSON.stringify({message:{list:[{id:'managed.orders',revision:3,title:'采购台账'}],total:41,page:Number(path.searchParams.get('page')),page_length:Number(path.searchParams.get('page_length'))}}));return;
        }
        if (method === 'shangshu_core.public_api.http.object_definition') {
          res.end(JSON.stringify({message:{id:path.searchParams.get('object_id'),revision:3,input_schema:{type:'object',properties:{amount:{type:'number'}}}}}));return;
        }
        if (method === 'shangshu_core.public_api.http.contributions') {
          res.end(JSON.stringify({message:{datasets:[],services:[{id:'files.versions',effect:'read',purpose:'detail',roles:['Desk User'],input_schema:{type:'object',properties:{file:{type:'string'}}}}]}}));return;
        }
        if (method === 'shangshu_core.public_api.http.domains') {
          res.end(JSON.stringify({message:[{contribution:{tools:[{id:'finance.expense.create_draft'},'document.ocr_extract']}}]}));return;
        }
        if (method === 'shangshu_core.public_api.http.service_read') {
          const payload = req.method === 'POST' ? JSON.parse(body.payload) : JSON.parse(path.searchParams.get('payload') || '{}');
          assert.equal(req.method, body.payload ? 'POST' : 'GET');
          if(req.method==='POST')assert.equal(req.headers['x-frappe-csrf-token'],'csrf-test');
          if(String(payload.file||'').startsWith('denied')){res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'无服务权限'}));return;}
          res.end(JSON.stringify({message:{result:{versions:[],current:{id:'current-version'}}}}));return;
        }
        if (method === 'shangshu_core.public_api.http.application') {
          assert.equal(path.searchParams.get('application_id'), 'com.shangshu.finance.expense_management');
          res.end(JSON.stringify({ message: { id: 'com.shangshu.finance.expense_management', title: '费用管理', datasets: [{ id: 'finance.invoice', name: '发票' }], processes: [] } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.actions') {
          res.end(JSON.stringify({ message: [
            { id: 'platform.object.query', title: '查询业务对象', effect: 'read', confirmation: 'none', executable: true, input_schema: { type: 'object', required: ['object_id'], properties: { object_id: { type: 'string' } } } },
            { id: 'finance.expense.create_draft', title: '创建报销草稿', effect: 'propose', confirmation: 'required', executable: true, input_schema: { type: 'object', required: ['invoice'], properties: { invoice: { type: 'string' } } } },
            { id: 'document.ocr_extract', title: 'OCR', effect: 'extract', confirmation: 'none', executable: false, input_schema: {} },
            { id: 'platform.application.inspect', effect: 'read', confirmation: 'none', executable: true, input_schema: {} },
            { id: 'platform.application.configure', effect: 'write', confirmation: 'required', executable: true, input_schema: {} },
            ...(largeCatalog?[{id:'test.large',effect:'read',confirmation:'none',executable:true,input_schema:{description:'原始契约'.repeat(5000)}}, ...Array.from({length:30},(_,i)=>({id:'test.op'+i,title:'业务查询'+i,effect:'read',confirmation:'none',executable:true,input_schema:{type:'object'}}))]:[]),
          ] }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.identity_list') {
          if (!String(req.headers.cookie || '').includes('sid=frappe-test')) {
            res.statusCode = 403;
            res.end(JSON.stringify({ exc_type: 'PermissionError', message: '需要系统管理员权限' }));
            return;
          }
          res.end(JSON.stringify({ message: [
            { email: 'jzy@shangshu.local', display_name: '江振宇', enabled: true, roles: ['System Manager'], capabilities: ['process_design'], collaboration_group: '管理' },
            { email: 'dev1@shangshu.local', display_name: '开发员工', enabled: true, roles: ['Desk User', 'Collaboration Manager'], capabilities: ['collaboration_manage'], collaboration_group: '开发' },
            { email: 'fin1@shangshu.local', display_name: '财务员工', enabled: false, roles: ['Desk User', 'Finance Approver'], capabilities: ['finance_review'], collaboration_group: '财务' },
          ] }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.conversation_issue') {
          assert.equal(req.method,'POST');assert.equal(req.headers['x-frappe-csrf-token'],'csrf-test');
          res.end(JSON.stringify({message:{conversation_key:'CONV-synthetic',credential:'signed-synthetic'}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_execute') {
          if (actionRevoked) { res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'动作权限已撤回'}));return; }
          if(String(body.action_id||'').startsWith('platform.identity.')){
            res.end(JSON.stringify({message:{action_id:body.action_id,result:{email:body.payload?.email},audit:'ACT-ID-1'}}));return;
          }
          if(body.action_id==='platform.application.inspect'){
            res.end(JSON.stringify({message:{result:{id:body.payload.application_id,draft_revision:3,draft:{title:'采购'}}}}));return;
          }
          assert.equal(body.action_id, 'platform.object.query');
          res.end(JSON.stringify({ message: { action_id: body.action_id, result: { rows: [{ name: 'INV-1' }] }, audit: 'ACT-1' } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.action_propose') {
          if(body.action_id==='platform.application.configure'){
            res.end(JSON.stringify({message:{id:'APROP-D',capability:body.action_id,payload:body.payload,preview:{status:'checked',changes:[{field:'title',before:'采购',after:'采购管理'}]}}}));return;
          }
          assert.equal(body.action_id, 'finance.expense.create_draft');
          res.end(JSON.stringify({ message: { id: 'APROP-1', capability: body.action_id, entity_type: 'finance.expense', entity_id: 'INV-1', payload: body.payload, status: 'proposed', created_via: 'ai-chat' } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposals') {
          if (path.searchParams.get('after') || path.searchParams.get('limit')) {
            res.end(JSON.stringify({ message: { allowed: true, items: [{ id: 'APROP-2', capability: 'mail.send', status: 'proposed', created_via: 'ai-chat' }], next_cursor: 'APROP-2', has_more: false, reason: '' } }));
            return;
          }
          res.end(JSON.stringify({ message: [{ id: 'APROP-1', capability: 'finance.expense.create_draft', status: 'proposed' }] }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_summary') {
          res.end(JSON.stringify({ message: { allowed: true, reason: '', total: 3, pending: 1, confirmed: 1, rejected: 1 } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_units') {
          res.end(JSON.stringify({ message: { allowed: true, proposal: path.searchParams.get('proposal_id'), total: 2, offset: Number(path.searchParams.get('offset') || 0), limit: Number(path.searchParams.get('limit') || 1), items: [{ unit_id: 'u0', label: '金额', target: { header: '金额', row_id: 'r-000001' }, value: { type: 'number', value: 800 }, status: 'pending', cell_index: 0 }], reason: '' } }));
          return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_get') {
          if(path.searchParams.get('proposal_id')==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          assert.equal(req.headers.cookie,'sid=frappe-test');
          res.end(JSON.stringify({message:{id:path.searchParams.get('proposal_id'),status:'Proposed'}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_review') {
          if(path.searchParams.get('proposal_id')==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({message:{id:path.searchParams.get('proposal_id'),status:'proposed',review_revision:'r1',remaining:2,units:[]}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_accept') {
          if(body.proposal_id==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({message:{id:body.proposal_id,status:'proposed',remaining:1,accepted_units:body.units||['remaining'],result:{name:'draft1'}}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_reject_units') {
          if(body.proposal_id==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({message:{id:body.proposal_id,status:'proposed',remaining:1,rejected_units:body.units||[]}}));return;
        }
        // PKG-118-T01：「暂存」这一档的公共口（只标记，正式值一个字都不改）。
        if (method === 'shangshu_core.public_api.http.action_proposal_stage_units') {
          if(body.proposal_id==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({message:{id:body.proposal_id,status:'proposed',review_revision:'r3',remaining:1,staged_count:(body.units||[]).length,staged_units:body.units||[],idempotent:false}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_unstage_units') {
          if(body.proposal_id==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({message:{id:body.proposal_id,status:'proposed',review_revision:'r4',remaining:2,unstaged_units:body.units||[],idempotent:false}}));return;
        }
        if (method === 'shangshu_core.public_api.http.action_proposal_resolve') {
          if(body.proposal_id==='DENIED') {res.statusCode=403;res.end(JSON.stringify({exc_type:'PermissionError',message:'当前无审核权限'}));return;}
          res.end(JSON.stringify({ message: { id: body.proposal_id, status: body.decision, execution_audit: body.decision === 'confirmed' ? 'ACT-1' : null } }));
          return;
        }
        if (method === 'shangshu_finance.api.upload_document') {
          assert.equal(req.headers['x-frappe-csrf-token'], 'csrf-test');
          assert.equal(body.file_name, 'scan.png');
          res.end(JSON.stringify({ message: { extraction: 'EXT-TEST', file: 'FILE-TEST' } }));
          return;
        }
        if (method === 'shangshu_finance.api.extraction_prepare') {
          res.end(JSON.stringify({ message: { extraction: 'EXT-TEST', candidate_tools: ['document.ocr_extract', 'document.vision_extract'] } }));
          return;
        }
        if (method === 'shangshu_finance.api.extraction_succeeded') {
          assert.equal(body.selected_tool, 'document.ocr_extract');
          assert.equal(body.output.fields.invoice_number, 'TEST-001');
          assert.equal(body.output.fields.invoice_date, '2026-08-31');
          res.end(JSON.stringify({ message: { extraction: 'EXT-TEST', invoice: 'INV-TEST', status: 'Succeeded' } }));
          return;
        }
        if (method === 'shangshu_finance.api.extraction_failed') {
          res.end(JSON.stringify({ message: { extraction: 'EXT-TEST', status: 'Failed' } }));
          return;
        }
        res.end(JSON.stringify({ message: {} }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env.FRAPPE_UPSTREAM = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    process.env.SHANGSHU_PLATFORM_MODE = 'frappe';
    const external = {
      ocr: {
        async start() {},
        async extract() {
          return {
            fields: { invoice_no: 'TEST-001', issued_at: '2026-08-31', seller_name: '测试销售方', total_amount: '1130.00' },
            confidence: 1,
            validation_warnings: {},
            raw_text: '扫描票据测试',
            ocr_path: 'text-llm',
          };
        },
        stop() {},
      },
      mail: {} as any,
    } satisfies ExternalServices;
    server = buildApp(external).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => {
    if (oldUpstream === undefined) delete process.env.FRAPPE_UPSTREAM;
    else process.env.FRAPPE_UPSTREAM = oldUpstream;
    if (oldMode === undefined) delete process.env.SHANGSHU_PLATFORM_MODE;
    else process.env.SHANGSHU_PLATFORM_MODE = oldMode;
    // Node fetch 会保留 HTTP keep-alive；先关闭测试专用连接，避免 suite 在 after 中悬挂。
    server.closeAllConnections();
    upstream.closeAllConnections();
    server.close();
    upstream.close();
  });

  // 平台会话：登录一次拿 sid（Frappe 会话）+ 兼容 session cookie，供需要登录的用例复用
  it('平台动作可传输20MiB原件的Base64，超出封包上限明确拒绝且不放宽其他路由',async()=>{
    const content=Buffer.alloc(20*1024*1024,65).toString('base64');
    const start=calls.length;
    const accepted=await fetch(`${base}/api/platform/actions/platform.object.query/execute`,{method:'POST',headers:{'content-type':'application/json',cookie:'sid=frappe-test'},body:JSON.stringify({payload:{content_base64:content},confirmed:true})});
    assert.equal(accepted.status,200);assert.equal(calls.slice(start).find(c=>c.method.endsWith('.action_execute'))?.body.payload.content_base64,content);
    for(const [path,body] of [['/api/platform/actions/platform.object.query/execute',JSON.stringify({payload:'x'.repeat(32*1024*1024)})],['/api/login',JSON.stringify({payload:content})]]){
      const before=calls.length;const rejected=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body});
      assert.equal(rejected.status,413);assert.match((await rejected.json()).error,/请求内容过大/);assert.equal(calls.length,before);
    }
  });
  // ⚠️ 2026-10-22（提交 de27ad9f9，CORE-CANDIDATE「工作台那条路在登录态没了时回 401，不再回 403」）：
  // 上游回 403 时，公共 BFF 会**先探一次会话**（GET public_api.http.session）：
  // 探到「会话没了」⇒ 改抛 401「登录状态已失效，请重新登录」（前端只认 401 才把人送回登录页）；
  // 会话还在 ⇒ 403 原样保留（真的是权限不够）。
  // ⇒ 三种情形的**期望状态码分开写**：没带会话 ⇒ 401；会话还在但没这条记录／没原件 ⇒ 仍 403。
  // 测试通过 = 上面三种情形各自回**该回的状态码与那一句人话**，且拒绝前不调用任何写动作。
  it('文件候选逐次转发会话并检查记录和原件权限，拒绝前不调用写动作',async()=>{
    const source={ref_doctype:'Owned File',ref_name:'f1',file:'v1'};
    // [记录名, 会话 cookie, 上游那句原因, 期望状态码, 页面上的话]
    for(const [name,cookie,upstreamReason,status,expected] of [
      ['r1','','无记录权限',401,'登录状态已失效'],
      ['denied','sid=frappe-test','无记录权限',403,'无记录权限'],
      ['r1','sid=frappe-test','无原件权限',403,'无原件权限'],
    ]){
      const start=calls.length;
      const response=await fetch(`${base}/api/platform/objects/test/records/${name}/file-suggestions`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({source})});
      assert.equal(response.status,status);assert.match((await response.json()).error,new RegExp(expected));
      assert.ok(!calls.slice(start).some(c=>/action_execute|action_propose/.test(c.method)));
      assert.equal(calls.slice(start).filter(c=>c.method.endsWith('.file_content')).length,upstreamReason==='无原件权限'?1:0);
    }
  });
  it('正文只消费明确text-only结果，不把发票抽取路径标签或图片当作原文',async()=>{
    let result:any={ocr_path:'text-rule',raw_text:'[real:text-rule] 级联抽取'};const forms:FormData[]=[];
    const external={ocr:{extract:async(form:FormData)=>{forms.push(form);return result;}}} as ExternalServices;
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any,external);
    const def=bridge.toolDefs.find(item=>item.name==='platform_resource_read')!;
    const read=async(file:string)=>JSON.parse((await bridge.toolExecutor(def,{id:'call1',type:'function',function:{name:def.name,arguments:JSON.stringify({operation:'attachment_text',source:{ref_doctype:'Owned File',ref_name:'f1',file}})}},{})).content as string);
    assert.match((await read('read.pdf')).error,/正文/);
    assert.equal(forms[0].get('doc_type'),'document_text');assert.equal(forms[0].has('api_key'),false);
    assert.equal((forms[0].get('file') as File).type,'application/pdf','真实解析服务按MIME接收PDF，不接受默认octet-stream');
    result={ocr_path:'document-text',raw_text:'方舟公司：采购数量20，原件全文。'};
    assert.equal((await read('read.pdf')).text,result.raw_text);
    const before=forms.length;assert.match((await read('read.png')).error,/扫描|图片/);assert.equal(forms.length,before);
  });
  async function platformSessionCookie(): Promise<string> {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager1@shangshu.local', password: 'only-frappe-knows' }),
    });
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
    const compatibility = cookies.find((value) => value.startsWith('shangshu_token='));
    assert.ok(compatibility, '登录应返回兼容会话 cookie');
    return `sid=frappe-test; ${compatibility!.split(';', 1)[0]}`;
  }

  it('原登录入口由 Frappe 验证并只生成兼容会话，不读取 Node 密码库', async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager1@shangshu.local', password: 'only-frappe-knows' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.ok, true);
    assert.equal(result.user.role, 'manager');
    assert.equal(result.user.username, 'manager');
    assert.equal(result.identity_id, 'identity-1');
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
    assert.ok(cookies.some((value) => value.startsWith('sid=frappe-test')));
    assert.ok(cookies.some((value) => value.startsWith('shangshu_token=')));
    const session=await fetch(`${base}/api/session`,{headers:{cookie:'sid=frappe-test'}}).then(r=>r.json()) as any;
    assert.equal(session.platform.user_name, 'manager1@shangshu.local', '本人设置沿公共原会话显示登录账号，不把协作键当邮箱');
  });

  it('无 Frappe 会话时旧 session 兼容接口也返回未登录', async () => {
    const response = await fetch(`${base}/api/session`);
    assert.deepEqual(await response.json(), { authed: false });
  });

  it('平台模式默认关闭未列入兼容白名单的旧身份、业务、流程和调度接口', async () => {
    for (const path of ['/api/users', '/api/orders', '/api/workflows', '/api/triggers', '/api/ai-tools', '/api/workspaces']) {
      const response = await fetch(`${base}${path}`, { headers: { cookie: 'sid=frappe-test' } });
      assert.equal(response.status, 410, path);
      const body = await response.json() as any;
      assert.equal(body.code, 'LEGACY_SURFACE_DISABLED', path);
    }
  });

  it('Frappe 会话仍有效时自动重建重启后丢失的 Node 兼容会话', async () => {
    const response = await fetch(`${base}/api/session`, { headers: { cookie: 'sid=frappe-test' } });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.authed, true);
    assert.equal(result.user.username, 'manager');
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
    const compatibility = cookies.find((value) => value.startsWith('shangshu_token='));
    assert.ok(compatibility);

    const legacy = await fetch(`${base}/api/me/work`, {
      headers: { cookie: `sid=frappe-test; ${compatibility!.split(';', 1)[0]}` },
    });
    assert.notEqual(legacy.status, 401);
  });

  it('扫描件只在候选集合内选择工具并把结果写回 Frappe', async () => {
    const response = await fetch(`${base}/api/platform/finance/documents`, {
      method: 'POST',
      headers: { cookie: 'sid=frappe-test', 'content-type': 'application/octet-stream', 'x-file-name': 'scan.png' },
      body: Buffer.from('scan-bytes'),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as any;
    assert.equal(result.invoice, 'INV-TEST');
    assert.equal(result.tool.id, 'document.ocr_extract');
    assert.equal(result.tool.selection, 'rule');
    assert.ok(calls.some((call) => call.method === 'shangshu_finance.api.extraction_succeeded'));
  });

  it('应用目录和应用详情由统一 BFF 转发且不暴露 Frappe 路径', async () => {
    const catalog = await fetch(`${base}/api/platform/applications?summary=1`, { headers: { cookie: 'sid=frappe-test' } });
    assert.equal(catalog.status, 200);
    assert.equal(calls.filter(call=>call.method.endsWith('.applications')).at(-1)?.query.summary, '1');
    assert.equal(((await catalog.json()) as any).list[0].title, '费用管理');
    const detail = await fetch(`${base}/api/platform/applications/${encodeURIComponent('com.shangshu.finance.expense_management')}`, { headers: { cookie: 'sid=frappe-test' } });
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as any).application.datasets[0].name, '发票');
  });

  it('AI 工具只来自 Frappe 公共目录，查询直跑而写入只生成确认提案', async () => {
    const bridge = await createPlatformChatBridge({ headers: { cookie: 'sid=frappe-test' } } as any);
    assert.deepEqual(bridge.toolDefs.map((tool) => tool.capability), ['platform.object.query', 'finance.expense.create_draft','platform.application.inspect','platform.application.configure','platform.resource.read']);
    const events: any[] = [];
    const query = bridge.toolDefs.find((tool) => tool.capability === 'platform.object.query')!;
    const payload={object_id:'finance.invoice',filters:{name:'INV-1'},fields:[],read_scope:{mode:'query',purpose:'interactive'},include_definition:false};
    const queried = await bridge.toolExecutor(query, { id: 'call-read', type: 'function', function: { name: query.name, arguments: JSON.stringify(payload) } } as any, { onTool: (event) => events.push(event) });
    assert.deepEqual(calls.filter(c=>c.method.endsWith('action_execute')).at(-1)?.body.payload,payload,'普通常驻动作也原样传递按需字段和范围');
    assert.equal(JSON.parse(String(queried.content)).result.rows[0].name, 'INV-1');

    const write = bridge.toolDefs.find((tool) => tool.capability === 'finance.expense.create_draft')!;
    let confirmation: any;
    const proposed = await bridge.toolExecutor(write, { id: 'call-write', type: 'function', function: { name: write.name, arguments: '{"invoice":"INV-1"}' } } as any, { onConfirm: (event) => { confirmation = event; } });
    assert.equal(JSON.parse(String(proposed.content)).confirmation_id, 'APROP-1');
    assert.equal(confirmation.capability, 'finance.expense.create_draft');
    assert.equal(confirmation.created_via, 'ai-chat', '实时确认卡必须透传后端真实来源');
    assert.ok(!calls.some((call) => call.method === 'shangshu_core.public_api.http.action_execute' && call.body.action_id === 'finance.expense.create_draft'));
  });

  it('一轮多次调用只领一次服务端凭据，凭据随动作和提案传递且不进入模型结果',async()=>{
    const start=calls.length;
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
    const read=bridge.toolDefs.find(tool=>tool.capability==='platform.application.inspect')!;
    const write=bridge.toolDefs.find(tool=>tool.capability==='finance.expense.create_draft')!;
    const audit:any[]=[];const hooks={onAudit:(event:any)=>{audit.push(event);}};
    const first=await bridge.toolExecutor(read,{id:'read-conversation',function:{name:read.name,arguments:'{}'}} as any,hooks);
    const second=await bridge.toolExecutor(write,{id:'write-conversation',function:{name:write.name,arguments:'{"invoice":"INV-1"}'}} as any,hooks);
    assert.equal(calls.slice(start).filter(call=>call.method.endsWith('.conversation_issue')).length,1);
    for(const call of calls.slice(start).filter(call=>/\.(action_execute|action_propose)$/.test(call.method)))
      assert.equal(call.body.conversation_credential,'signed-synthetic');
    assert.deepEqual(audit,[{kind:'conversation_bound',conversation_key:'CONV-synthetic'}]);
    assert.doesNotMatch(JSON.stringify([first,second,audit]),/signed-synthetic/);
  });

  it('超大能力目录按需读取原schema，薄调用仍只读执行/写提案且目录外零调用',async()=>{
    largeCatalog=true;
    try{
      const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
      const schema=bridge.toolDefs.find(t=>t.name==='platform_action_schema'),invoke=bridge.toolDefs.find(t=>t.name==='platform_action_call');
      assert.match(invoke!.description,/每个confirmation_id仅代表该提案/);assert.match(invoke!.description,/稳定ID.*同名目标不能按名称猜选/);
      assert.ok(bridge.toolDefs.some(t=>t.capability==='finance.expense.create_draft'),'域声明可执行工具继续常驻');
      assert.ok(!bridge.toolDefs.some(t=>t.capability==='document.ocr_extract'),'域声明不能恢复未授权动作');
      assert.ok(schema&&invoke,'大目录不能继续把全部schema塞入每轮模型请求');assert.ok(JSON.stringify(bridge.toolDefs).length<12000);
      // ⚠️ 2026-10-21（提交 b114b9a64，PKG-018-T03「按需发现授权动作，不再把全目录塞进常驻描述」）：
      // 常驻描述里**不许**再出现动作目录（目录只按需搜 platform_action_search / 按编号读 platform_action_schema）。
      // ⇒ 判据从「描述里应该出现目录」改成**反向断言**：描述里不该出现任何动作编号。
      assert.doesNotMatch(schema.description,/finance\.expense\.create_draft/,'常驻描述里不该出现动作目录');
      assert.doesNotMatch(schema.description,/test\.large/,'常驻描述里不该出现动作目录');
      assert.doesNotMatch(schema.description,/document\.ocr_extract/,'不投影未授权动作');
      const call=async(def:any,payload:any)=>JSON.parse(String((await bridge.toolExecutor(def,{id:'lazy',type:'function',function:{name:def.name,arguments:JSON.stringify(payload)}} as any,{})).content));
      const inspected=await call(schema,{action_id:'test.large'});assert.equal(inspected.input_schema.description,'原始契约'.repeat(5000));
      assert.equal(inspected.kind,'query');assert.match(inspected.description,/只读调用/);
      const writeSchema=await call(schema,{action_id:'finance.expense.create_draft'});assert.equal(writeSchema.kind,'confirm');assert.match(writeSchema.description,/只生成确认提案/);
      // 目录不许进常驻描述 ⇒ **按需读原 schema 仍要拿到该动作的字段**（否则模型没字段可填）。
      assert.deepEqual(writeSchema.input_schema.required,['invoice'],'按需读原 schema 时必填字段没了');
      assert.ok(writeSchema.input_schema.properties?.invoice,'按需读原 schema 时字段定义没了');
      const listing=await call(schema,{});assert.ok(listing.actions.some((a:any)=>a.id==='test.large'));
      assert.equal(listing.total,35);assert.ok(listing.actions.length<=10);assert.equal(listing.has_more,true);
      assert.ok(listing.actions.every((a:any)=>!a.input_schema&&!a.description));
      assert.ok(listing.actions.every((a:any)=>String(a.title).length<=120));
      assert.match(listing.suggestion,/platform_action_search/);
      const lastPage=await call(schema,{page:4,page_length:10});assert.equal(lastPage.actions.at(-1).id,'test.op29');assert.equal(lastPage.has_more,false);
      const search=bridge.toolDefs.find(t=>t.name==='platform_action_search')!;
      const first=await call(search,{query:'test.op29'}),second=await call(search,{query:'test.op29'});
      assert.deepEqual(first,second);assert.equal(first.candidates[0].action_id,'test.op29');
      for(const wrong of ['{}','']){const rejected=await call(schema,{action_id:wrong});assert.match(rejected.error,/空参数对象.*省略action_id/);}
      assert.match(invoke.description,/版本冲突先重读/);assert.match(invoke.description,/未知结果先查原提案/);

      const start=calls.length;const denied=await call(invoke,{action_id:'document.ocr_extract',payload:{}});assert.ok(denied.error);assert.equal(calls.length,start);
      const readPayload={object_id:'finance.invoice',filters:{status:'Open'},page:2,page_length:20,fields:['amount'],read_scope:{mode:'query',purpose:'interactive'},include_definition:false};
      const read=await call(invoke,{action_id:'platform.object.query',payload:readPayload});assert.equal(read.result.rows[0].name,'INV-1');
      assert.deepEqual(calls.filter(c=>c.method.endsWith('action_execute')).at(-1)?.body.payload,readPayload,'通过原公共Action原样传递按需范围');
      actionRevoked=true;
      try { assert.match((await call(invoke,{action_id:'platform.object.query',payload:readPayload})).error,/撤回/); }
      finally { actionRevoked=false; }
      const proposal=await call(invoke,{action_id:'finance.expense.create_draft',payload:{invoice:'INV-1'}});assert.equal(proposal.confirmation_id,'APROP-1');
      assert.ok(!calls.slice(start).some(c=>c.method.endsWith('action_execute')&&c.body.action_id==='finance.expense.create_draft'));
    }finally{largeCatalog=false;}
  });
  it('平台聊天可通过通用读取取得当前记录版本，失败不回退旧业务工具或创建提案', async () => {
    const bridge = await createPlatformChatBridge({ headers: { cookie: 'sid=frappe-test' } } as any);
    const read = bridge.toolDefs.find(tool => tool.capability === 'platform.resource.read')!;
    assert.ok(read, '平台需要目录/详情读取才能填写已有台账');
    const before = calls.length;
    const call = (name: string) => ({ id: 'read-record', function: { name: read.name,
      arguments: JSON.stringify({ operation: 'record', object_id: 'managed.orders', name }) } }) as any;
    const result = await bridge.toolExecutor(read, call('r1'), {});
    assert.equal(JSON.parse(String(result.content)).record.modified, 'm1');
    const denied = await bridge.toolExecutor(read, call('denied'), {});
    assert.match(JSON.parse(String(denied.content)).error, /权限/);
    assert.ok(!calls.slice(before).some(row => /action_(execute|propose)$/.test(row.method)));
    assert.ok(!calls.slice(before).some(row => /\.(objects|contributions)$/.test(row.method)), '已知记录不先枚举对象或贡献目录');
  });

  it('聊天只读服务沿公共GET读口传递载荷并保留现身份，不走通用服务POST',async()=>{
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
    const def=bridge.toolDefs.find(t=>t.capability==='platform.resource.read')!;
    const start=calls.length;
    const result=JSON.parse(String((await bridge.toolExecutor(def,{id:'service-read',type:'function',function:{name:def.name,arguments:JSON.stringify({operation:'service',service_id:'files.versions',payload:{file:'file1'}})}},{})).content));
    assert.equal(result.result.current.id,'current-version');
    const serviceCalls=calls.slice(start).filter(row=>row.method.includes('.service_'));
    assert.equal(serviceCalls.length,1);assert.equal(serviceCalls[0].method,'shangshu_core.public_api.http.service_read');
    assert.deepEqual(serviceCalls[0].query,{service_id:'files.versions',payload:JSON.stringify({file:'file1'})});
    assert.equal(serviceCalls[0].cookie,'sid=frappe-test');
  });

  it('聊天长只读服务预选同端点POST并保留CSRF、原身份和权限错误',async()=>{
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
    const def=bridge.toolDefs.find(t=>t.capability==='platform.resource.read')!;
    for(const denied of [false,true]){
      const payload={file:(denied?'denied':'file')+'中'.repeat(400)};
      const start=calls.length;
      const result=JSON.parse(String((await bridge.toolExecutor(def,{id:'long-service-read',type:'function',function:{name:def.name,arguments:JSON.stringify({operation:'service',service_id:'files.versions',payload})}},{})).content));
      if(denied)assert.match(result.error,/无服务权限/);
      else assert.equal(result.result.current.id,'current-version');
      const serviceCalls=calls.slice(start).filter(row=>row.method.includes('.service_'));
      assert.equal(serviceCalls.length,1);assert.equal(serviceCalls[0].method,'shangshu_core.public_api.http.service_read');
      assert.deepEqual(serviceCalls[0].query,{});
      assert.deepEqual(serviceCalls[0].body,{service_id:'files.versions',payload:JSON.stringify(payload)});
      assert.equal(serviceCalls[0].cookie,'sid=frappe-test');
      assert.equal(calls.slice(start).filter(row=>row.method.endsWith('.csrf')).length,1);
      assert.equal(calls.slice(start).filter(row=>row.method.endsWith('.contributions')).length,1,'沿Harness既有目录检查，不为长传输重复查询');
    }
  });

  it('聊天未知对象用公共分页摘要，已知对象用精确定义口且沿当前会话',async()=>{
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
    const def=bridge.toolDefs.find(t=>t.capability==='platform.resource.read')!;
    const call=async(payload:any)=>JSON.parse(String((await bridge.toolExecutor(def,{id:'object-read',type:'function',function:{name:def.name,arguments:JSON.stringify(payload)}},{})).content));
    const start=calls.length;
    const page=await call({operation:'catalog',page:3,page_length:2,search:'采购'});
    assert.equal(page.total,41);assert.equal(page.objects.length,1);assert.equal(page.objects[0].input_schema,undefined);
    const upstreamPage=calls.slice(start).find(row=>row.method.endsWith('.objects'))!;
    assert.deepEqual(upstreamPage.query,{page:'3',page_length:'2',summary:'1',search:'采购'});
    const before=calls.length;
    const detail=await call({operation:'definition',object_id:'managed.orders'});
    assert.deepEqual(detail.object.headers,['amount']);
    assert.equal(detail.object.input_schema,undefined,'日常字段目录只给表头，不向模型展开存储结构');
    assert.deepEqual(calls.slice(before).map(row=>row.method),['shangshu_core.public_api.http.object_definition']);
    assert.equal(calls.at(-1)?.cookie,'sid=frappe-test');
  });

  it('平台工具抛错的回执必须带结构化 error 标记：测试通过 = 失败不被记成「已实查」（BASE967-11 平台执行面）', async () => {
    // 判据（测试通过 = 什么成立）：平台执行器底层抛错（403/超时/无权）时，
    // onTool 回执必须带 error 标记——否则回合执行卡会把这次失败算成成功读，
    // 模型再说「已实查」就过了声明-回执对账（BASE967-11 漏洞）。
    const bridge = await createPlatformChatBridge({ headers: { cookie: 'sid=frappe-test' } } as any);
    const read = bridge.toolDefs.find(tool => tool.capability === 'platform.resource.read')!;
    assert.ok(read, '需要平台资源读取工具');
    const events: any[] = [];
    const denied = await bridge.toolExecutor(read, {
      id: 'call-denied', type: 'function',
      function: { name: read.name, arguments: JSON.stringify({ operation: 'record', object_id: 'managed.orders', name: 'denied' }) },
    } as any, { onTool: (event) => events.push(event) });
    // 模型侧看到结构化错误（这条已成立，保留）
    assert.match(JSON.parse(String(denied.content)).error, /权限/);
    // 回执侧：必须留痕这次调用，且带 error 标记（成败判据只认结构化标记，不解析文案）
    assert.equal(events.length, 1, '失败调用也要留回执痕（执行卡要显示工具失败）');
    assert.ok(events[0].error, '失败回执必须带结构化 error 标记；不带就会被记成已实查');
  });

  it('记录上下文沿原桥绑定确认租约，失权后不再创建提案或调用原动作',async()=>{
    referenceRevoked=false;const controller=new AbortController();
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any,undefined,{object_id:'native.record',name:'leased-record',controller});
    const write=bridge.toolDefs.find(tool=>tool.capability==='finance.expense.create_draft')!;
    try{
      await bridge.toolExecutor(write,{id:'leased-proposal',function:{name:write.name,arguments:'{"invoice":"INV-1"}'}} as any,{});
      const last=calls.filter(call=>call.method.endsWith('.action_propose')).at(-1)!;
      assert.equal(last.body.execution_id,'REX-TEST');referenceRevoked=true;
      const before=calls.filter(call=>/action_(execute|propose)$/.test(call.method)).length;
      const denied=await bridge.toolExecutor(write,{id:'stale-proposal',function:{name:write.name,arguments:'{}'}} as any,{});
      assert.match(String(denied.content),/交接/);assert.equal(controller.signal.aborted,true);
      assert.equal(calls.filter(call=>/action_(execute|propose)$/.test(call.method)).length,before);
    }finally{await bridge.close();referenceRevoked=false;}
    assert.ok(calls.some(call=>call.method.endsWith('.reference_run')&&call.body.operation==='end'));
  });

  it('应用 AI 先共用读取动作，再把后端预检完整送入确认卡，不直接写入', async () => {
    const bridge=await createPlatformChatBridge({headers:{cookie:'sid=frappe-test'}} as any);
    const read=bridge.toolDefs.find(t=>t.capability==='platform.application.inspect')!;
    const result=await bridge.toolExecutor(read,{id:'d-read',function:{name:read.name,arguments:'{"application_id":"app-d"}'}} as any,{});
    assert.equal(JSON.parse(String(result.content)).result.draft_revision,3);
    const write=bridge.toolDefs.find(t=>t.capability==='platform.application.configure')!;
    let confirmation:any;
    await bridge.toolExecutor(write,{id:'d-write',function:{name:write.name,arguments:'{"application_id":"app-d","expected_revision":3,"definition":{"title":"采购管理"}}'}} as any,{onConfirm:value=>{confirmation=value;}});
    assert.equal(confirmation.preview.status,'checked');
    assert.equal(confirmation.preview.changes[0].after,'采购管理');
    assert.equal(confirmation.payload.expected_revision,3);
    assert.ok(!calls.some(c=>c.method==='shangshu_core.public_api.http.action_execute'&&c.body.action_id==='platform.application.configure'));
  });

  it('旧确认卡 URL 在 Frappe 模式下解析公共动作提案', async () => {
    const list = await fetch(`${base}/api/confirmations`, { headers: { cookie: 'sid=frappe-test' } });
    const listed=await list.json() as any;
    assert.equal(list.status,200,JSON.stringify(listed));
    assert.equal(listed.list[0].id, 'APROP-1');
    const resolved = await fetch(`${base}/api/confirmations/APROP-1`, {
      method: 'POST',
      headers: { cookie: 'sid=frappe-test', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'confirmed' }),
    });
    assert.equal(((await resolved.json()) as any).execution_audit, 'ACT-1');
  });

  it('正式公共审核列表与裁决复用公共方法，改稿透传且无权不执行', async () => {
    const list = await fetch(`${base}/api/platform/action-proposals?status=Proposed`, {headers:{cookie:'sid=frappe-test'}});
    assert.equal(list.status,200);
    assert.equal(((await list.json()) as any).list[0].id,'APROP-1');
    const edited_value={subject:{type:'text',value:'核对后主题'},body:{type:'text',value:'核对后正文'}};
    const start=calls.length;
    const resolved=await fetch(`${base}/api/platform/action-proposals/APROP-1/resolve`,{
      method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify({decision:'confirmed',edited_value})});
    assert.equal(resolved.status,200);
    assert.equal(((await resolved.json()) as any).status,'confirmed');
    const resolveCall=calls.slice(start).find(c=>c.method==='shangshu_core.public_api.http.action_proposal_resolve');
    assert.deepEqual(resolveCall?.body,{proposal_id:'APROP-1',decision:'confirmed',edited_value});
    assert.equal(resolveCall?.cookie,'sid=frappe-test');
    const denied=await fetch(`${base}/api/platform/action-proposals/DENIED/resolve`,{
      method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify({decision:'rejected'})});
    assert.equal(denied.status,403);
    assert.match(JSON.stringify(await denied.json()),/审核权限/);
    assert.ok(!calls.slice(start).some(c=>c.method==='shangshu_core.public_api.http.action_execute'));
  });

  it('PKG-014-T02 单条提案兼容读取复用受管权限且不缓存、不写入', async()=>{
    const start=calls.length;
    const found=await fetch(`${base}/api/platform/action-proposal-get/APROP-1`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(found.status,200);
    assert.equal(found.headers.get('cache-control'),'private, no-store');
    assert.equal((await found.json()).id,'APROP-1');
    const denied=await fetch(`${base}/api/platform/action-proposal-get/DENIED`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(denied.status,403);
    assert.match(JSON.stringify(await denied.json()),/审核权限/);
    assert.equal(calls.slice(start).filter(c=>c.method.endsWith('.action_proposal_get')).length,2);
    assert.equal(calls.slice(start).filter(c=>/action_(execute|propose|proposal_accept|proposal_resolve)$/.test(c.method)).length,0);
  });

  it('R967-D01（BASE967-44）三读口转发：摘要/units range/列表cursor各走正式口，只读不写', async()=>{
    const start=calls.length;
    const summary=await fetch(`${base}/api/platform/action-proposal-summary?status=Proposed`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(summary.status,200);const s=await summary.json() as any;assert.equal(s.pending,1);assert.equal(s.total,3);
    const units=await fetch(`${base}/api/platform/action-proposals/APROP-1/units?offset=5&limit=20`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(units.status,200);const u=await units.json() as any;
    assert.equal(u.total,2);assert.equal(u.offset,5,'offset/limit 转发到正式口');
    assert.equal(u.items[0].unit_id,'u0');
    const list=await fetch(`${base}/api/platform/action-proposals?status=Proposed&after=APROP-9&limit=50`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(list.status,200);const l=await list.json() as any;
    assert.equal(l.list[0].id,'APROP-2','cursor 分页走新形状 items');
    assert.equal(l.next_cursor,'APROP-2');assert.equal(l.has_more,false);
    assert.ok(calls.slice(start).filter(c=>c.method.endsWith('.action_proposal_summary')).length,1);
    assert.ok(calls.slice(start).filter(c=>c.method.endsWith('.action_proposal_units')).length,1);
    assert.equal(calls.slice(start).filter(c=>/action_(execute|propose|proposal_accept|proposal_resolve)$/.test(c.method)).length,0,'只读不写');
  });

  it('逐项审核走正式公共API，保留op/version/unit edits及会话，不另执行动作', async()=>{
    const start=calls.length;
    const descriptor=await fetch(`${base}/api/platform/action-proposals/PARTIAL/review`,{headers:{cookie:'sid=frappe-test'}});
    assert.equal(descriptor.status,200);assert.match(descriptor.headers.get('cache-control')||'',/no-store/);
    assert.equal(((await descriptor.json()) as any).review_revision,'r1');
    const body={op_id:'one-op',expected_review_revision:'r1',units:['subject'],edited_value:{subject:'edited'}};
    const accepted=await fetch(`${base}/api/platform/action-proposals/PARTIAL/accept`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(accepted.status,200);assert.equal(((await accepted.json()) as any).remaining,1);
    assert.deepEqual(calls.slice(start).find(c=>c.method.endsWith('.action_proposal_accept'))?.body,{proposal_id:'PARTIAL',...body});
    assert.ok(calls.slice(start).filter(c=>c.method.endsWith('.action_proposal_accept')).every(c=>c.cookie==='sid=frappe-test'));
    assert.ok(!calls.slice(start).some(c=>/action_execute|action_proposal_resolve$/.test(c.method)));
  });
  it('逐项全部接受只传remaining意图且无权请求保留后端拒绝',async()=>{
    const start=calls.length;
    const all=await fetch(`${base}/api/platform/action-proposals/PARTIAL/accept`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify({op_id:'all-op',expected_review_revision:'r2'})});
    assert.equal(all.status,200);
    assert.deepEqual(calls.slice(start).find(c=>c.method.endsWith('.action_proposal_accept'))?.body,{proposal_id:'PARTIAL',op_id:'all-op',expected_review_revision:'r2'});
    for(const suffix of ['review','accept']){
      const response=await fetch(`${base}/api/platform/action-proposals/DENIED/${suffix}`,{method:suffix==='accept'?'POST':'GET',headers:{cookie:'sid=frappe-test','content-type':'application/json'},...(suffix==='accept'?{body:JSON.stringify({op_id:'deny',expected_review_revision:'r1',units:['subject']})}:{})});
      assert.equal(response.status,403);assert.match(JSON.stringify(await response.json()),/审核权限/);
    }
  });

  it('逐项放弃只走放弃口，不执行动作也不改正式值；无权请求保留后端拒绝',async()=>{
    const start=calls.length;
    const body={op_id:'drop-op',expected_review_revision:'r1',units:['subject']};
    const dropped=await fetch(`${base}/api/platform/action-proposals/PARTIAL/reject-units`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(dropped.status,200);
    assert.deepEqual(calls.slice(start).find(c=>c.method.endsWith('.action_proposal_reject_units'))?.body,{proposal_id:'PARTIAL',...body});
    assert.ok(!calls.slice(start).some(c=>/action_execute|action_proposal_accept$/.test(c.method)),'放弃不执行任何动作');
    const denied=await fetch(`${base}/api/platform/action-proposals/DENIED/reject-units`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(denied.status,403);assert.match(JSON.stringify(await denied.json()),/审核权限/);
  });

  it('PKG-118-T01 暂存与取消暂存走正式公共口：四个入参一个不少地透传，回执就是审核目录',async()=>{
    const start=calls.length;
    const body={op_id:'stage-op',expected_review_revision:'r1',units:['subject'],edited_value:{subject:{type:'text',value:'核对后主题'}}};
    const staged=await fetch(`${base}/api/platform/action-proposals/PARTIAL/stage-units`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(staged.status,200,'暂存口没通');
    const receipt=(await staged.json()) as any;
    assert.deepEqual(receipt.staged_units,['subject'],'暂存回执没写清暂存了哪几项');
    assert.equal(receipt.staged_count,1);
    assert.equal(receipt.idempotent,false);
    assert.deepEqual(calls.slice(start).find(c=>c.method.endsWith('.action_proposal_stage_units'))?.body,{proposal_id:'PARTIAL',...body},
      '暂存口没把 op_id／版本号／units／edited_value 一个不少地透传');
    const unstage=await fetch(`${base}/api/platform/action-proposals/PARTIAL/unstage-units`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify({op_id:'unstage-op',expected_review_revision:'r3',units:['subject']})});
    assert.equal(unstage.status,200,'取消暂存口没通');
    assert.deepEqual((await unstage.json() as any).unstaged_units,['subject'],'取消暂存回执没写清取消了哪几项');
    assert.deepEqual(calls.slice(start).find(c=>c.method.endsWith('.action_proposal_unstage_units'))?.body,{proposal_id:'PARTIAL',op_id:'unstage-op',expected_review_revision:'r3',units:['subject']});
    /* 暂存**只是标记** ⇒ 不执行动作、也不走采用口（正式值一个字都不该动）。 */
    assert.ok(!calls.slice(start).some(c=>/action_execute|action_proposal_accept$/.test(c.method)),'暂存不该执行动作或采用');
    const denied=await fetch(`${base}/api/platform/action-proposals/DENIED/stage-units`,{method:'POST',headers:{cookie:'sid=frappe-test','content-type':'application/json'},body:JSON.stringify({op_id:'deny',expected_review_revision:'r1',units:['subject']})});
    assert.equal(denied.status,403);assert.match(JSON.stringify(await denied.json()),/审核权限/);
  });

  it('AI 设计提案只能引用动作注册表且 AI 节点只能使用只读候选', () => {
    const actions = [
      { action_id: 'document.ocr_extract', effect: 'extract' },
      { action_id: 'finance.posting.post_expense', effect: 'append-only' },
    ];
    const safe = {
      nodes: [
        { id: 'com.test.start', type: 'ai_select', start: true, candidates: ['document.ocr_extract'] },
        { id: 'com.test.finish', type: 'action', terminal: true, action_id: 'finance.posting.post_expense' },
      ],
      edges: [{ source: 'com.test.start', target: 'com.test.finish' }],
    };
    assert.equal((validateProcessProposal(safe, actions).nodes as any[]).length, 2);
    assert.throws(() => validateProcessProposal({
      ...safe,
      nodes: [{ ...safe.nodes[0], candidates: ['finance.posting.post_expense'] }, safe.nodes[1]],
    }, actions), /只读工具/);
  });

  it('账号清单由内核提供并附带平台角色投影，前端不自己算角色', async () => {
    const cookie = await platformSessionCookie();
    const response = await fetch(`${base}/api/platform/identities`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const { list } = await response.json();
    assert.deepEqual(list.map((row: any) => [row.email, row.platform_role]), [
      ['jzy@shangshu.local', 'admin'],
      ['dev1@shangshu.local', 'manager'],
      ['fin1@shangshu.local', 'finance'],
    ]);
    assert.deepEqual(list.map((row: any) => row.collaboration_group), ['管理', '开发', '财务']);
    assert.equal(list[2].enabled, false, '停用状态必须如实透出');
  });

  it('账号写操作只能经通用动作路由，BFF 不新增身份写口', async () => {
    const cookie = await platformSessionCookie();
    calls.length = 0;
    // 身份写操作没有专用路由：该路径未被平台路由注册，落到旧版能力门禁（410），不是可写的 200
    const direct = await fetch(`${base}/api/platform/identities/jzy@shangshu.local/status`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(direct.status, 410, '不得为身份写操作新开路由');
    assert.equal(calls.filter((item) => item.method === 'shangshu_core.public_api.http.action_execute').length, 0, '未注册路径不得触发任何动作');
    // 走通用动作路由时，确认位与幂等键必须透传
    const executed = await fetch(`${base}/api/platform/actions/platform.identity.status/execute`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { email: 'jzy@shangshu.local', enabled: false }, confirmed: true, idempotency_key: 'idem-1' }),
    });
    assert.equal(executed.status, 200);
    const call = calls.find((item) => item.method === 'shangshu_core.public_api.http.action_execute');
    assert.equal(call?.body.action_id, 'platform.identity.status');
    assert.equal(call?.body.confirmed, 1);
    assert.equal(call?.body.payload.email, 'jzy@shangshu.local');
  });

  it('无平台会话时账号清单拒绝访问', async () => {
    const response = await fetch(`${base}/api/platform/identities`);
    assert.ok(response.status >= 400, '未登录不得读取账号清单');
  });
});
