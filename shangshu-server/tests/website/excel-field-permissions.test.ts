import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {editFieldPermissions,editTablePermissions} from '../../../shangshu-web/js/domains/excel-univer/src/field-permissions.ts';

/**
 * 「字段权限」面板 ＋ 「表权限」面板（PKG-117-T01）。
 *
 * ⚠️ **口径变过（2026-10-26／10-27，前端那半）**：面板上的操作从**五个**收成**三个**
 *   ——「**筛**」并进了「读」（`access-scope.ts`：`LEGACY_OPERATION_KEYS=['assistant','filter']`
 *   「读的时候当作没有，写的时候也不再产出它们」），「**助手**」那一档整个去掉。
 *   ⇒ 这条判据原来钉的是**旧口径**（五行、筛／助手可「跟随读」）；
 *   现在改钉**当前口径**（三行：读／写／下载；旧两键既不出现也不落库）。
 *   口径本身的判据在公共件那边：`shangshu-web/js/domains/excel-univer/tests/access-scope.test.ts`。
 *
 * **测试通过 = 下面全部成立**：
 *  1. **三个操作 × 主体三档**：面板能分别设定并保存，保存载荷是**新形状**
 *     （`access.read/write/download` ＝ `{scope}` ＋ 选中的对象）；
 *  2. **旧两键（筛／助手）不再出现在面板上**，保存时也**不落库**；读回来仍不认它们；
 *  3. **选「部门」却没选具体部门 ⇒ 保存被拒**，并且**报出人话**（说了是哪一列）；
 *  4. **旧三键（`read_roles`／`write_roles`／`download_roles`）不再被面板产出**；
 *  5. **表级面板**：三行（读／写／下载），保存落在 `definition.access`
 *     上，`record_scope` 原样保留，**列不动**；
 *  6. **闸**：没有管理权 / 没有已晋升列 / 没有 `definition_sha` ⇒ 不开面板、不写。
 */

/** 一张已经按新规则声明过的表。 */
const base=()=>({
  table:'t',definition_version:1,structure_version:4,definition_sha:'v1',
  can_manage_field_permissions:true,
  access:{read:{scope:'global'},write:{scope:'global'},download:{scope:'global'},record_scope:'all'},
  subject_options:{
    departments:[{id:'财务',label:'财务部'},{id:'法务',label:'法务部'}],
    users:[{id:'a@b.com',label:'张三（a@b.com）'},{id:'c@d.com',label:'李四（c@d.com）'}],
  },
  columns:[
    // ⚠️ 故意留着旧三键：面板落库时要把它们**剥掉**（判据 4）。
    {header:'金额',promoted:true,field:'amount',type:'number',rules:{min:1},
     read_roles:['Desk User'],write_roles:['Desk User'],download_roles:['Desk User'],
     access:{read:{scope:'global'},write:{scope:'global'},download:{scope:'global'}}},
    {header:'备注',promoted:false},
  ],
});

function harness(conflict=false){
  const dom=new JSDOM('<div id="host"></div>');
  let state:any=base(),closed=false;const calls:any[]=[];
  const ui={dialog(o:any){const box=dom.window.document.createElement('section');box.innerHTML=o.body;for(const a of o.actions){const b=dom.window.document.createElement('button');b.textContent=a.label;b.onclick=a.onClick;box.append(b);}dom.window.document.body.append(box);return box;},closeModal(){closed=true;return true;},guardModal(){}};
  const fetcher:any=async(url:string,init:any)=>{const body=JSON.parse(init.body);calls.push({url,body});
    if(url.includes('/execute')){
      if(conflict)return new Response(JSON.stringify({error:'字段定义已变化'}),{status:409});
      state={...state,columns:body.payload.definition.columns,access:body.payload.definition.access,definition_sha:'v2'};
      return Response.json({ok:true,result:{definition:state}});
    }
    return Response.json({result:state});
  };
  return {dom,ui,fetcher,calls,closed:()=>closed,state:()=>state};
}

async function settle(){await new Promise(r=>setTimeout(r,10));}

/** 选一档（全局／部门／个人／跟随读）。 */
function pick(dialog:any,operation:string,value:string){
  const radio=dialog.querySelector(`[data-operation="${operation}"] input[value="${value}"]`);
  assert.ok(radio,`面板上找不到「${operation}」的「${value}」那一档`);
  radio.checked=true;
  radio.dispatchEvent(new (dialog.ownerDocument.defaultView as any).Event('change'));
}
/** 勾一个部门或一个人。 */
function tick(dialog:any,operation:string,attr:'data-department'|'data-user',value:string){
  const box=dialog.querySelector(`[data-operation="${operation}"] input[${attr}="${value}"]`);
  assert.ok(box,`面板上找不到「${operation}」的 ${value}`);
  box.checked=true;
}
function save(dialog:any){Array.from(dialog.querySelectorAll('button')).find(b=>b.textContent==='保存')!.click();}

test('列级面板：三个操作（读／写／下载）× 三档分别设定 ⇒ 保存载荷是新形状',async()=>{
  const h=harness();
  try{
    const d=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:()=> 'one'}))!;
    assert.deepEqual(d.querySelectorAll('.access-row').length,3,'面板上不是三行（读／写／下载）');
    pick(d,'read','global');
    pick(d,'write','department');tick(d,'write','data-department','财务');
    pick(d,'download','global');
    save(d);
    await settle();
    const saved=h.calls.find(c=>c.url.includes('/execute'))!.body;
    assert.equal(saved.payload.expected_definition_sha,'v1');
    assert.equal(saved.payload.expected_structure_version,4);
    assert.deepEqual(saved.payload.definition.columns[0].access,{
      read:{scope:'global'},
      write:{scope:'department',departments:['财务']},
      download:{scope:'global'},
    },'三个操作没有按各自那一档落库');
    // 表级声明：面板**没动**它，但要**原样带回去**（不把整张表的权限抹掉）。
    assert.deepEqual(saved.payload.definition.access,{read:{scope:'global'},write:{scope:'global'},download:{scope:'global'},record_scope:'all'});
    assert.equal(h.calls.length,3,'保存后要独立重读一次定义');
    assert.equal(h.closed(),true);
  }finally{h.dom.window.close();}
});

test('旧两键（筛／助手）：面板上不再有这一档，保存时也不落库；读回来仍不认它们',async()=>{
  const h=harness();
  try{
    const d=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:()=> 'follow'}))!;
    // ⚠️ 「筛」并进了「读」、「助手」那一档整个去掉（2026-10-26／10-27）⇒
    //   面板上**不再有**这两行（不是「默认落在跟随读」，是**根本没有这一档**）。
    for(const op of ['filter','assistant']){
      assert.equal(d.querySelector(`[data-operation="${op}"]`),null,`面板上还有「${op}」这一行（那一档已经没有了）`);
    }
    assert.deepEqual(Array.from(d.querySelectorAll('.access-row')).map(row=>row.getAttribute('data-operation')),['read','write','download']);
    pick(d,'read','global');pick(d,'write','global');pick(d,'download','global');
    save(d);
    await settle();
    const saved=h.calls.find(c=>c.url.includes('/execute'))!.body;
    assert.equal('filter' in saved.payload.definition.columns[0].access,false,'「筛」被落成了声明');
    assert.equal('assistant' in saved.payload.definition.columns[0].access,false,'「助手」被落成了声明');
    // 读回来：定义里没有 filter/assistant ⇒ 面板上还是没有这两行。
    const again=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:()=> 'again'}))!;
    assert.equal(again.querySelector('[data-operation="filter"]'),null,'读回来又冒出「筛」这一行');
    assert.equal(again.querySelector('[data-operation="assistant"]'),null,'读回来又冒出「助手」这一行');
  }finally{h.dom.window.close();}
});

test('选了「部门」却没选具体部门 ⇒ 保存被拒，报出人话（说了是哪一列），并且一个写请求都没发',async()=>{
  const h=harness();
  try{
    const d=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:() => 'empty'}) )!;
    pick(d,'read','global');pick(d,'write','department');pick(d,'download','global');
    save(d);
    await settle();
    assert.match(d.textContent!,/金额/,'报错没有点名是哪一列');
    assert.match(d.textContent!,/部门/,'报错没有说清要选具体部门');
    assert.equal(h.calls.filter(c=>c.url.includes('/execute')).length,0,'没选具体部门却发了写请求');
    assert.equal(h.closed(),false,'被拒之后不该关掉面板（人要改输入）');
  }finally{h.dom.window.close();}
});

test('回归：旧三键（read_roles／write_roles／download_roles）不再被面板产出',async()=>{
  const h=harness();
  try{
    const d=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:() => 'old'}) )!;
    pick(d,'read','global');pick(d,'write','global');pick(d,'download','global');
    save(d);
    await settle();
    const saved=h.calls.find(c=>c.url.includes('/execute'))!.body;
    for(const column of saved.payload.definition.columns){
      for(const key of ['read_roles','write_roles','download_roles']){
        assert.equal(key in column,false,`面板还在产出旧键 ${key}`);
      }
    }
    assert.ok(saved.payload.definition.columns[0].access,'新形状的 access 没落库');
  }finally{h.dom.window.close();}
});

test('表级面板：三行（读／写／下载）落在 definition.access 上，record_scope 原样保留，列不动',async()=>{
  const h=harness();
  try{
    const d=(await editTablePermissions(h.ui,'t',{fetcher:h.fetcher,newKey:() => 'table'}) )!;
    assert.deepEqual(Array.from(d.querySelectorAll('.access-row')).map(row=>row.getAttribute('data-operation')),
      ['read','write','download'],'表级面板不是那三行');
    pick(d,'read','department');tick(d,'read','data-department','法务');
    pick(d,'write','global');
    pick(d,'download','global');
    save(d);
    await settle();
    const saved=h.calls.find(c=>c.url.includes('/execute'))!.body;
    assert.deepEqual(saved.payload.definition.access,{
      read:{scope:'department',departments:['法务']},
      write:{scope:'global'},
      download:{scope:'global'},
      record_scope:'all',
    },'表级声明没有按新形状落库');
    // 列**不动**：列自己的声明原样带回。
    assert.deepEqual(saved.payload.definition.columns[0].access,{read:{scope:'global'},write:{scope:'global'},download:{scope:'global'}});
    assert.equal(h.closed(),true);
  }finally{h.dom.window.close();}
});

test('闸：没有管理权 / 没有已晋升列 / 没有 definition_sha ⇒ 不开面板、不写',async()=>{
  for(const overrides of [{can_manage_field_permissions:false},{columns:[]},{definition_sha:undefined}]){
    let mounted=0,writes=0;
    await assert.rejects(editFieldPermissions({dialog(){mounted++;return null;},closeModal(){return true;},guardModal(){}},'t',
      {fetcher:(async(url:any)=>{if(String(url).includes('/execute'))writes++;return Response.json({...base(),...overrides});}) as any}));
    assert.equal(mounted,0);assert.equal(writes,0);
  }
  // 表级面板：**不必有已晋升列**（有 definition_sha 就能定整张表的权限）。
  const h=harness();
  h.state().columns=[];
  let mounted=0;
  await editTablePermissions({dialog(){mounted++;return null;},closeModal(){return true;},guardModal(){}},'t',
    {fetcher:(async(url:any)=>Response.json({result:{...base(),columns:[]}})) as any});
  assert.equal(mounted,1,'表级面板被「没有已晋升列」挡住了');
});

test('冲突（字段定义已变化）：保留输入、不关面板、不用新定义重试',async()=>{
  const h=harness(true);
  try{
    const d=(await editFieldPermissions(h.ui,'t',{fetcher:h.fetcher,newKey:()=> 'same'}))!;
    pick(d,'read','global');pick(d,'write','global');pick(d,'download','global');
    save(d);
    await settle();
    assert.match(d.textContent!,/字段定义已变化/);
    assert.equal(h.closed(),false);
    save(d);
    await settle();
    const writes=h.calls.filter(c=>c.url.includes('/execute'));
    assert.deepEqual(writes[0].body,writes[1].body,'冲突后换了输入重试');
  }finally{h.dom.window.close();}
});
