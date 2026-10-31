import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/core/storage/sqlite.ts';
import { registerAllActionHandlers } from '../../src/capabilities/actions.ts';
import { withActor, type ActorContext } from '../../src/core/actor.ts';
import { withPeopleDirectory } from '../../src/core/auth/people.ts';
import { getOrCreateDm } from '../../src/core/im.ts';
import { collaborationToolDefs, executeCollaborationTool, collaborationConfirmations, resolveCollaborationConfirmation } from '../../src/adapters/web/collaboration-tools.ts';

test('AI 协作：查真实人员→提案→刷新确认卡→确认派单，越权与重复不写入',async()=>{
  const store=new SqliteStore(join(mkdtempSync(join(tmpdir(),'ss-collab-tools-')),'state.sqlite'));
  registerAllActionHandlers();
  const manager:ActorContext={id:'new-manager',role:'manager',kind:'human',channel:'chat'};
  const employee:ActorContext={id:'new-employee',role:'staff',kind:'human',channel:'chat'};
  const run=(actor:ActorContext,fn:()=>Promise<void>)=>withPeopleDirectory(async()=>[
    {username:'new-employee',identity_id:'new-employee',display_name:'新员工'},
    {username:'new-manager',identity_id:'new-manager',display_name:'经理',scope:'company'},
  ],()=>withActor(actor,fn));
  let proposal='';
  try {
    await run(manager,async()=>{
      const defs=collaborationToolDefs();assert.ok(!defs.some(item=>item.capability?.startsWith('invoice.')));
      const query=defs.find(item=>item.name==='collaboration_query')!;
      assert.equal((await executeCollaborationTool(query,{resource:'people'},store) as any).list[0].username,'new-employee');
      const result=await executeCollaborationTool(defs.find(item=>item.capability==='task.create')!,{title:'核对客户材料',assignee_id:'new-employee'},store) as any;
      proposal=result.confirmation_id;
      assert.equal((await store.query('process','tasks')).length,0);
      assert.equal((await collaborationConfirmations(store))[0].id,proposal);
    });
    await run(employee,async()=>{
      assert.ok(!collaborationToolDefs().some(item=>item.capability==='task.create'));
      assert.equal((await collaborationConfirmations(store)).length,0);
      await assert.rejects(resolveCollaborationConfirmation(proposal,'confirmed',store),/无权/);
    });
    await run(manager,async()=>{
      await resolveCollaborationConfirmation(proposal,'confirmed',store);
      await assert.rejects(resolveCollaborationConfirmation(proposal,'confirmed',store));
      const tasks=await store.query('process','tasks');assert.equal(tasks.length,1);assert.equal(tasks[0].assignee_id,'new-employee');
      assert.equal((await collaborationConfirmations(store)).length,0);
      const chat=await getOrCreateDm(store,'new-manager','new-employee');
      const query=collaborationToolDefs().find(item=>item.name==='collaboration_query')!;
      assert.equal((await executeCollaborationTool(query,{resource:'chats'},store) as any).list[0].id,chat);
      await withActor({...employee,id:'outsider'},()=>assert.rejects(executeCollaborationTool(query,{resource:'messages',chat_id:chat},store)));
    });
  }finally{await store.close();}
});
