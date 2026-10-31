import test from 'node:test';
import assert from 'node:assert/strict';
import {createInlineReviewController} from '../src/inline-review';
import type {ReviewDescriptor,ReviewUnit} from '../src/inline-review';

/**
 * FIX-04 / A17：助手建议改两个格子时，要能「部分采用、部分拒绝」。
 * 判据（对用户看得见的现象）：
 *  ① 点候选上的「×」= 这一格**不采用**，正式值一个字都不动（不发写请求）；
 *  ② 采用一格之后，**再放弃另一格不会被「版本已更新」顶掉** —— 这是用户报的
 *     「前项确认导致后项版本过期」；
 *  ③ 放弃的回执写明放弃了哪几项，界面据此把该格从待采用里拿掉。
 */
type Unit = {unit_id:string;value:any;current_value:any;status:string};

function unit(id:string,value:string,current:string,status='pending'):Unit{
  return {unit_id:id,value:{type:'text',value},current_value:{type:'text',value:current},status,
          label:id,kind:'cell',target:{row_id:'r1',header:'金额'}} as unknown as Unit;
}
function descriptor(units:Unit[],revision:string,remaining:number):ReviewDescriptor{
  return {id:'p1',capability:'files.sheet_cells_write',status:'proposed',created_via:'ai-chat',
          review_revision:revision,target:{module:'excel',table:'t1'},
          units:units as unknown as ReviewUnit[],remaining,accepted_count:units.filter(u=>u.status==='accepted').length};
}
function makeController(initial:ReviewDescriptor){
  const calls:{url:string;body:any}[]=[];
  let revision=initial.review_revision;
  let units=initial.units.map(u=>({...u}));
  const fetcher=async(url:string,init?:RequestInit)=>{
    const body=init?.body?JSON.parse(String(init.body)):{};
    calls.push({url,body});
    if(url.endsWith('/accept')){
      const accepted=(body.units??units.filter(u=>u.status==='pending').map(u=>u.unit_id)) as string[];
      units=units.map(u=>accepted.includes(u.unit_id)?{...u,status:'accepted'}:u);
      revision='rev-'+String(calls.length);
      return {ok:true,json:async()=>({ok:true,...descriptor(units as unknown as ReviewUnit[],revision,units.filter(u=>u.status==='pending').length),
        accepted_units:accepted})};
    }
    if(url.endsWith('/reject-units')){
      const dropped=body.units as string[];
      units=units.map(u=>dropped.includes(u.unit_id)?{...u,status:'rejected'}:u);
      revision='rev-'+String(calls.length);
      return {ok:true,json:async()=>({ok:true,...descriptor(units as unknown as ReviewUnit[],revision,units.filter(u=>u.status==='pending').length),
        rejected_units:dropped})};
    }
    return {ok:true,json:async()=>({ok:true,...descriptor(units as unknown as ReviewUnit[],revision,units.filter(u=>u.status==='pending').length)})};
  };
  const controller=createInlineReviewController({
    descriptor:initial,fetcher:fetcher as any,newKey:()=>'op-'+String(calls.length+1),
    blocking:()=>false,coerce:(_u,text)=>({type:'text',value:text}),
    readback:async()=>{},change:()=>{},progress:()=>{},
  });
  return {controller,calls,get units(){return units;}};
}

test('放弃一格只发 reject-units，不发任何写入请求，该格状态变 rejected',async()=>{
  const {controller,calls}=makeController(descriptor([unit('one','A','oldA'),unit('two','B','oldB')],'rev1',2));
  const reply=await controller.rejectUnit('two');
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith('/reject-units'),'放弃走的是放弃口，不是写入口');
  assert.deepEqual(calls[0].body.units,['two']);
  assert.deepEqual(reply?.rejected_units,['two']);
  assert.equal(reply?.units.find(u=>u.unit_id==='two')?.status,'rejected');
  assert.equal(reply?.units.find(u=>u.unit_id==='one')?.status,'pending');
});

test('采用一格后再放弃另一格：第二次请求带的是**刷新后**的审核版本号，不会被顶成版本过期',async()=>{
  const {controller,calls}=makeController(descriptor([unit('one','A','oldA'),unit('two','B','oldB')],'rev1',2));
  await controller.acceptUnit('one');
  assert.equal(calls[0].body.expected_review_revision,'rev1');
  await controller.rejectUnit('two');
  assert.equal(calls.length,2);
  assert.equal(calls[1].body.expected_review_revision,'rev-1','第二格要带第一格之后的版本号');
  assert.deepEqual(calls[1].body.units,['two']);
});

test('放弃过的项不能再被采用（不会把不采用的格写进去）',async()=>{
  const {controller,calls}=makeController(descriptor([unit('one','A','oldA'),unit('two','B','oldB')],'rev1',2));
  await controller.rejectUnit('two');
  const reply=await controller.acceptUnit('two');
  assert.equal(reply,null);
  assert.equal(calls.length,1,'放弃之后不再发第二次请求');
  assert.ok(controller.error);
});
