// 明确保留的 Node 协作域适配：只投影既有任务 Action，不放行旧财务/任意工具。
import type { Request } from 'express';
import { withActor, requireActor } from '../../core/actor.ts';
import { compatibilityFields, readPlatformIdentity } from '../../core/auth/platform-identity.ts';
import { withPeopleDirectory, collaborationPeople } from '../../core/auth/people.ts';
import { getActionContract, checkAction } from '../../core/action-contracts.ts';
import { getRuntimeStore } from '../../core/store.ts';
import { requestConfirmation, resolveConfirmation, listPendingConfirmations } from '../../core/confirm.ts';
import { listChats, listMessages } from '../../core/im.ts';
import type { ChatToolDef } from '../../core/chat.ts';
import { visibleTasks } from '../../capabilities/task-domain.ts';

const actions = new Set(['task.create', 'task.update']);
export const COMPAT_CONFIRM_PREFIX = 'collaboration:';

export async function withCollaborationIdentity<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const session = compatibilityFields(await readPlatformIdentity('session', req.headers.cookie || ''));
  return withPeopleDirectory(() => readPlatformIdentity('people', req.headers.cookie || ''), () =>
    withActor({ id: session.username, role: session.role, kind:'human', channel:'chat' }, fn));
}

export function collaborationToolDefs(): ChatToolDef[] {
  // 未初始化旧协作 Action 的隔离消费者不发布假工具。
  const defs: ChatToolDef[] = [];
  for (const id of actions) {
    try {
      const contract = getActionContract(id);
      checkAction(contract, requireActor());
      defs.push({name:`collaboration_${id.replaceAll('.','_')}`,capability:id,
        description:`${id==='task.create'?'派发协作任务':'更新协作任务'}。只生成确认卡；负责人从协作人员目录选取，确认后沿任务 Action 执行。`,
        parameters:contract.inputSchema,kind:'confirm',surface:'sme'});
    } catch { /* 不向无该动作权限的用户提供写工具。 */ }
  }
  if (defs.length) defs.unshift({name:'collaboration_query',capability:'collaboration.query',kind:'query',surface:'sme',
    description:'查询当前用户可访问的协作任务、人员、会话和消息。先查人员再派单，消息仅限本人参与的会话。',
    parameters:{type:'object',additionalProperties:false,required:['resource'],properties:{resource:{type:'string',enum:['tasks','people','chats','messages']},chat_id:{type:'string'},task_id:{type:'string'}}}});
  return defs;
}

export async function executeCollaborationTool(def: ChatToolDef, payload: Record<string, any>, store = getRuntimeStore()) {
  const actor = requireActor();
  if (def.capability === 'collaboration.query') {
    if (payload.resource === 'people') return {list:await collaborationPeople(store)};
    if (payload.resource === 'chats') return {list:await listChats(store,actor.id)};
    if (payload.resource === 'messages') return {list:await listMessages(store,String(payload.chat_id||''),actor.id)};
    if (payload.resource !== 'tasks') throw new Error('不支持的协作资源');
    const rows = await visibleTasks(store,actor);
    return {list:rows.filter(row=>!payload.task_id||row.id===payload.task_id).slice(0,100)};
  }
  if (!def.capability || !actions.has(def.capability)) throw new Error('动作不属于协作兼容范围');
  checkAction(getActionContract(def.capability), actor, payload);
  const id = await requestConfirmation(store,{capability:def.capability,entity_type:'task',entity_id:String(payload.id||'agent:task'),payload,initiator:actor.id});
  return {ok:true,confirmation_id:COMPAT_CONFIRM_PREFIX+id,note:'已生成确认提案，尚未执行'};
}

export async function collaborationConfirmations(store = getRuntimeStore()) {
  const actor=requireActor();
  if (!collaborationToolDefs().length) return [];
  return (await listPendingConfirmations(store)).filter(item=>actions.has(item.capability)&&item.initiator===actor.id)
    .map(item=>({...item,id:COMPAT_CONFIRM_PREFIX+item.id}));
}

export async function resolveCollaborationConfirmation(id: string, decision: string, store = getRuntimeStore()) {
  if (!['confirmed','rejected'].includes(decision)) throw new Error('无效确认操作');
  const raw=id.slice(COMPAT_CONFIRM_PREFIX.length),actor=requireActor();
  const [proposal]=await store.query('execution','events',{id:raw});
  if(!proposal||!actions.has(proposal.capability)||proposal.initiator!==actor.id) throw new Error('无权处理该协作提案');
  await resolveConfirmation(store,raw,decision as 'confirmed'|'rejected',actor);
  return {id,status:decision};
}
