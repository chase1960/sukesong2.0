import {it} from 'node:test';
import assert from 'node:assert/strict';
import {setup,settled} from './excel-mount-harness.ts';

/*
 FIX-05 / A06：错误输入后的恢复。
 用户原话：「可以，但是如果出错就会导致一个格子改不了的情况，在 sum 的时候，
 我输入了 sum，然后把 sum 删了，出现了一个『只有重试选项，没有直接撤回的按钮』。」

 根因（读代码定位）：失败的输入**留在队列队首**，`drainInputs` 见到队首是
 failed/conflict 就 break —— 后面同一格的新输入既发不出去、也不报错，
 格子里看着是新值、其实没存（静默丢数据）。

 判据：
 1. 同格**改正**（输入无效内容后删掉重填）能直接存下去：
    前一笔失败且**结果确定未写入**时，新输入顶替它发出去，队列清空、值落库。
 2. **结果不明**的失败不能被顶替（那笔可能已经写进库里，丢了就找不回来）：
    同格的新输入必须留在队列里等核实，且界面要说清「先核实原操作」。
 3. 可放弃的失败必须有「放弃修改」出口；结果不明的失败**不**给放弃（会给就丢数据），
    只给「重试原操作」（同一把幂等键，服务端去重，天然是「核实」）。
 4. 失败不污染本人的撤回栈：没写成功的输入不占三步。
*/

const event=(value:string,before='原值')=>({rowIndex:0,colIndex:0,fieldId:'C1',value,before,type:'text'});

it('FIX-05 同格改正能直接存下去：测试通过 = 失败项被新输入顶替并发出，队列清空、值落库',async()=>{
  let attempt=0;
  const h=setup({beforeWrite:async()=>{attempt++;if(attempt<=3)throw Object.assign(Error('permission denied before write'),{status:403});}});
  try{
    const api=await h.mountPage();
    api.onCommit(event('=sum'));                                    // 无效内容被服务端拒
    /* ⚠️ **失败后那一笔的去向变了**（2026-10-30「站上实测的连锁故障」那轮）：
       「结果确定没写进去」的失败**当场从队列里拿掉**（别让它堵着后面那几笔）⇒
       队列里**看不到**那一笔的 failed 状态了。
       ⇒ 这条判据原来等的是「队首那一笔变成 failed」；现在等的是**用户看得见的失败提示**
       （界面说清「这一笔没存进去」），后面那句「改正后的值存下去了」照样要成立。 */
    await settled(()=>h.notifications.length>0,h.errors);
    assert.equal(h.context.excelPageDiag().inputQueue.length,0,'明确没写进去的那一笔不该堵在队列里（后面那几笔要能发出去）');
    api.onCommit(event('改正后的值'));                                // 用户在同一格改正
    await settled(()=>h.context.excelPageDiag().undo.stackSize===1,h.errors);
    assert.equal(h.values.get('one'),'改正后的值','改正后的值应真的存下去了');
    assert.equal(h.context.excelPageDiag().inputQueue.length,0,'失败项应被新输入顶替，不留在队列里');
    assert.equal(h.context.excelPageDiag().undo.stackSize,1,'只记一次成功的写入，失败那笔不占撤回步');
  }finally{h.close();}
});

it('FIX-05 结果不明的失败不能被顶替：测试通过 = 同格新输入留在队列等核实，界面说清先核实',async()=>{
  let attempt=0;
  const h=setup({beforeWrite:async()=>{attempt++;throw Error('network outcome unknown');}});   // 无 status → 结果不明
  try{
    const api=await h.mountPage();
    api.onCommit(event('=sum'));
    await settled(()=>h.context.excelPageDiag().inputQueue[0]?.state==='failed',h.errors);
    const head=h.context.excelPageDiag().inputQueue[0];
    assert.equal(head.uncertain,true,'网络类失败应标成结果不明');
    assert.equal((h.host.querySelector('[data-discard]') as HTMLElement).hidden,true,'结果不明时不能给「放弃修改」（那会丢数据）');
    assert.equal((h.host.querySelector('[data-retry]') as HTMLElement).hidden,false,'结果不明时给「重试原操作」（同一幂等键=核实）');
    api.onCommit(event('改正后的值'));
    await settled(()=>h.context.excelPageDiag().inputQueue.length>=2,h.errors);
    assert.equal(h.context.excelPageDiag().inputQueue.length,2,'结果不明时新输入留在队列里等核实，不能顶替');
    assert.equal(h.context.excelPageDiag().inputQueue[0].state,'failed','队首仍是那笔待核实的');
    assert.equal(h.values.get('one'),'原值','正式值没被偷偷改掉');
  }finally{h.close();}
});

it('FIX-05 可放弃的失败有「放弃修改」出口：测试通过 = 按钮可见，放弃后恢复正式值、撤回栈不涨',async()=>{
  let attempt=0;
  const h=setup({beforeWrite:async()=>{attempt++;if(attempt<=3)throw Object.assign(Error('permission denied before write'),{status:403});}});
  try{
    const api=await h.mountPage();
    api.onCommit(event('=sum'));
    /* ⚠️ **等「放弃修改」按钮出现**（2026-10-30 · PKG-133 · 缺陷③ 修完后的口径）：
       「结果确定没写进去」的那一笔**当场从队列里拿掉**（别让它堵着后面那几笔）
       ⇒ 队列里**看不到**它 ⇒ 等「队首变成 failed」永远等不到。
       ⇒ 现在它**单独记一份**（`lastDiscardableFailure`）⇒ **「放弃修改」的出口还在**
       ⇒ 等的应该是**用户看得见的那个出口**。 */
    await settled(()=>{
      const discard=h.host.querySelector('[data-discard]') as HTMLElement;
      return !!discard&&!discard.hidden;
    },h.errors);
    const discard=h.host.querySelector('[data-discard]') as HTMLButtonElement;
    assert.equal(discard.hidden,false,'明确未写入的失败必须给「放弃修改」出口');
    discard.click();                       // 第一次点：进入「确认放弃」
    assert.match(discard.textContent||'',/确认放弃/,'第一次点应进入确认态');
    discard.click();                       // 第二次点：真的放弃
    await settled(()=>h.context.excelPageDiag().inputQueue.length===0,h.errors);
    assert.equal(h.values.get('one'),'原值','放弃后是正式值');
    assert.equal(h.context.excelPageDiag().undo.stackSize,0,'失败那笔不占本人撤回步');
  }finally{h.close();}
});
