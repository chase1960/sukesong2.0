import type {ActionExecutionContext} from '../core/action-contracts.ts';
import type {StateStore} from '../core/types.ts';
import type {ActorContext} from '../core/actor.ts';
import {validDate} from './finance-domain.ts';
import {collaborationPeople} from '../core/auth/people.ts';
const managers=['admin','finance','manager'];
export function canManageTasks(actor:ActorContext):boolean {return managers.includes(actor.role);}
// 服务端身份目录决定任务范围，部门不等于权限；平台未分配部门默认仅本人。
// 旧 Node 身份保留既有语义。此处不改变对象/字段/流程权限。
export async function taskScopeMembers(store:StateStore,actor:ActorContext):Promise<string[]|null> {
  if(actor.role==='admin') return null;
  const people=await collaborationPeople(store);
  const person=people.find(p=>p.username===actor.id);
  if(!person) return [actor.id];
  if(person.identity_id && person.scope==='company') return null;
  if(person.identity_id && person.scope==='related') return [actor.id];
  const group=person.group;
  if(!group) return person.identity_id ? [actor.id] : null;
  return people.filter(p=>p.group===group).map(p=>p.username);
}
// 派给谁与能查看谁的存量任务是两回事：关联范围允许派单给在职同事，
// 但存量任务仍只读写本人负责/发起的记录；不因部门相同而授权。
export async function taskAssignmentMembers(store:StateStore,actor:ActorContext):Promise<string[]|null> {
  const person=(await collaborationPeople(store)).find(p=>p.username===actor.id);
  if(canManageTasks(actor) && person?.identity_id && person.scope==='related') return null;
  return taskScopeMembers(store,actor);
}
export async function visibleTasks(store:StateStore,actor:ActorContext) {
  const rows=await store.query('process','tasks',actor.role==='staff'?{assignee_id:actor.id}:undefined);
  if(actor.role==='staff') return rows;
  const scope=await taskScopeMembers(store,actor);
  return scope ? rows.filter(row=>scope.includes(String(row.assignee_id||'')) || row.created_by===actor.id) : rows;
}
// 通知带来源跳转与去重键：同一事件重复触发（如事件重放）不重复提醒；dedupeKey 带任务版本时改派往返仍各自提醒。
export async function notifyTask(store:StateStore,recipient:string,taskId:string,message:string,options:{title?:string;dedupeKey?:string}={}):Promise<void> {
  if(!recipient) return;
  if(options.dedupeKey) {
    const existing=await store.query('process','notifications',{recipient,dedupe_key:options.dedupeKey});
    if(existing.length) return;
  }
  await store.insert('process','notifications',{recipient,task_id:taskId,message,title:options.title || '任务提醒',
    entity_type:'task',entity_id:taskId,action_url:`#/task-mgmt?task=${encodeURIComponent(taskId)}`,
    dedupe_key:options.dedupeKey || '',read_at:null,created_at:new Date().toISOString()});
}
async function assigneeId(store:StateStore,name:unknown):Promise<string> {
  if(!name) return '';
  const users=await collaborationPeople(store);
  const matches=users.filter(u=>u.username===name || u.display_name===name);
  if(matches.length!==1) throw new Error('负责人必须为唯一的在职账号（建议从人员列表选择）');
  return matches[0].username;
}
export async function createTask(payload:Record<string,any>,ctx:ActionExecutionContext):Promise<string> {
  if(!canManageTasks(ctx.actor)) throw new Error('无权限派发任务');
  const assignee=await assigneeId(ctx.store,payload.assignee_id || payload.assignee);
  const scope=await taskAssignmentMembers(ctx.store,ctx.actor);
  if(scope && !scope.includes(assignee)) throw new Error('无权限：只能派发本协作分组成员的任务');
  if(!String(payload.title || '').trim()) throw new Error('任务标题不能为空');
  for(const key of ['start_date','end_date']) if(payload[key]) validDate(payload[key]);
  if(payload.start_date && payload.end_date && payload.start_date>payload.end_date) throw new Error('截止日期不能早于开始日期');
  const id=await ctx.store.insert('process','tasks',{title:String(payload.title).trim(),assignee,assignee_id:assignee,created_by:ctx.actor.id,
    status:'待办',pct:0,priority:payload.priority || '中',source:'手动',project:payload.project || '',start_date:payload.start_date || '',end_date:payload.end_date || '',created_at:new Date().toISOString()});
  await notifyTask(ctx.store,assignee,id,`新任务：${payload.title}`,{title:'你收到了一项新任务',dedupeKey:`task-created:${id}`});return id;
}
export async function updateTask(payload:Record<string,any>,ctx:ActionExecutionContext):Promise<void> {
  const [task]=await ctx.store.query('process','tasks',{id:String(payload.id)});
  if(!task) throw new Error('任务不存在');
  const manager=canManageTasks(ctx.actor);
  const owner=task.assignee_id===ctx.actor.id;
  const creator=String(task.created_by||'')===ctx.actor.id;
  if(!manager && !owner && !(creator && payload.status==='已取消')) throw new Error('无权限修改他人任务');
  // 分组范围：被收窄的管理角色只能操作本组成员（含改派目标）的任务；员工本人任务不受影响
  const scope=manager?await taskScopeMembers(ctx.store,ctx.actor):null;
  if(scope && ![String(task.assignee_id||''),String(task.created_by||'')].some(name=>scope.includes(name))) throw new Error('任务不在本协作分组范围内');
  if(payload.expected_version!==undefined && payload.expected_version!==task._version) throw new Error('任务版本已变化，请刷新');
  const patch:Record<string,any>={};
  for(const key of Object.keys(payload)) {
    if(['id','expected_version'].includes(key)) continue;
    if(!['title','project','assignee','assignee_id','priority','start_date','end_date','status','pct','result'].includes(key)) throw new Error(`不可修改任务字段: ${key}`);
    if(!manager && !['status','pct','result'].includes(key)) throw new Error('员工只能反馈自己的任务进度和结果');
    patch[key]=payload[key];
  }
  if(patch.assignee!==undefined || patch.assignee_id!==undefined) {
    patch.assignee=patch.assignee_id=await assigneeId(ctx.store,patch.assignee_id || patch.assignee);
    const assignmentScope=await taskAssignmentMembers(ctx.store,ctx.actor);
    if(assignmentScope && !assignmentScope.includes(patch.assignee_id)) throw new Error('无权限：目标不在派单范围内');
  }
  if(patch.title!==undefined && !String(patch.title).trim()) throw new Error('任务标题不能为空');
  for(const key of ['start_date','end_date']) if(patch[key]) validDate(patch[key]);
  const start=patch.start_date??task.start_date,end=patch.end_date??task.end_date;
  if(start && end && start>end) throw new Error('截止日期不能早于开始日期');
  const status=String(patch.status || task.status);
  // 已取消（2026-09-16 契约）：发起人或具备任务管理权者可取消"待办/进行中"；待验收/已完成与取消后不可再流转；记录保留不物理删除
  const transitions:Record<string,string[]>={'待办':['进行中','已取消'],'进行中':['待验收','已取消'],'待验收':['进行中','已完成'],'已完成':['进行中'],'已取消':[]};
  if(status!==task.status && !(transitions[task.status] || []).includes(status)) throw new Error('无效任务状态流转');
  if(status==='已取消' && !manager && !creator) throw new Error('仅任务管理者或发起人可取消任务');
  if(!manager && (task.status==='待验收' || task.status==='已完成' || status==='已完成')) throw new Error('提交后由任务管理者验收或退回');
  if(status==='待验收' && !String(patch.result || task.result || '').trim()) throw new Error('提交验收必须填写完成结果');
  if(patch.pct!==undefined && (!Number.isFinite(Number(patch.pct)) || Number(patch.pct)<0 || Number(patch.pct)>100)) throw new Error('进度应为 0–100');
  if(patch.pct!==undefined) patch.pct=Number(patch.pct);
  if(status==='待验收' || status==='已完成') patch.pct=100;
  await ctx.store.update('process','tasks',task.id,patch);
  if(task.post_id) await ctx.store.update('process','posts',task.post_id,{status:status==='已完成'?'已完成':status==='待验收'?'待验收':'已认领'});
  // 改派双向通知：新负责人收到“改派给你”，原负责人收到“已移交”；去重键带改派前版本，重放不重复、往返各自提醒。
  const oldAssignee=String(task.assignee_id||''),newAssignee=String(patch.assignee_id??oldAssignee);
  if(newAssignee && newAssignee!==oldAssignee) {
    await notifyTask(ctx.store,newAssignee,task.id,`任务「${task.title}」已改派给你`,{title:'任务改派',dedupeKey:`task-reassigned:${task.id}:${newAssignee}:${task._version}`});
    if(oldAssignee && oldAssignee!==ctx.actor.id) await notifyTask(ctx.store,oldAssignee,task.id,`任务「${task.title}」已移交给 ${newAssignee}`,{title:'任务已移交',dedupeKey:`task-transferred:${task.id}:${oldAssignee}:${task._version}`});
  }
  if(status!==task.status) {
    const recipient=status==='待验收' ? String(task.created_by||'') : newAssignee;
    const title=status==='待验收'?'任务待验收':status==='已完成'?'任务已验收':status==='已取消'?'任务已取消':status==='进行中'&&task.status==='待验收'?'任务被退回':'任务状态更新';
    if(recipient && recipient!==ctx.actor.id) await notifyTask(ctx.store,recipient,task.id,`任务「${task.title}」：${status}`,{title,dedupeKey:`task-status:${task.id}:${status}:${task._version}`});
  }
}
export async function claimPost(payload:Record<string,any>,ctx:ActionExecutionContext):Promise<void> {
  const [post]=await ctx.store.query('process','posts',{id:String(payload.id)});
  if(!post || post.status!=='待认领') throw new Error('帖子不存在或已被认领');
  const taskId=await ctx.store.insert('process','tasks',{title:String(post.content).slice(0,160),post_id:post.id,assignee:ctx.actor.id,assignee_id:ctx.actor.id,created_by:post.created_by || '',status:'待办',pct:0,source:'帖子',priority:'中',created_at:new Date().toISOString()});
  await ctx.store.update('process','posts',post.id,{assignee:ctx.actor.id,assignee_id:ctx.actor.id,status:'已认领',task_id:taskId});
  await notifyTask(ctx.store,post.created_by || '',taskId,`${ctx.actor.id} 已认领：${post.content}`,{title:'任务已被认领',dedupeKey:`post-claimed:${post.id}`});
}
