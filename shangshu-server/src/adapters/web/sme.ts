import {Router} from 'express';
import {getRuntimeStore} from '../../core/store.ts';
import {requireAuth,requireRole,currentUser} from '../../core/auth/guard.ts';
import {requireActor} from '../../core/actor.ts';
import {requestConfirmation,resolveConfirmation} from '../../core/confirm.ts';
import {cashSummary} from '../../capabilities/finance-domain.ts';
import {previewImport,importColumns,exportColumns,encodeCSV} from '../../capabilities/business-transfer.ts';
import {instanceHealth} from '../../core/infra/instance-health.ts';
import {collaborationPeople} from '../../core/auth/people.ts';
import {taskAssignmentMembers} from '../../capabilities/task-domain.ts';

export function smeRouter():Router {
  const router=Router();
  router.use(requireAuth);
  router.get('/instance/health',requireRole('admin'),async(_req,res)=>{res.json(await instanceHealth(getRuntimeStore()));});
  router.get('/data/templates/:kind',requireRole('finance'),(req,res)=>{
    const columns=Object.hasOwn(importColumns,req.params.kind)?importColumns[req.params.kind]:null;if(!columns) return res.status(404).end();
    res.type('text/csv').attachment(`${req.params.kind}-template.csv`).send(encodeCSV([],columns));
  });
  router.get('/data/export/:kind',requireRole('finance','manager'),async(req,res)=>{
    const columns=Object.hasOwn(exportColumns,req.params.kind)?exportColumns[req.params.kind]:null;if(!columns) return res.status(404).end();
    const rows=await getRuntimeStore().query('business',req.params.kind);
    res.type('text/csv').attachment(`${req.params.kind}.csv`).send(encodeCSV(rows,columns));
  });
  router.post('/data/import/preview',requireRole('finance'),async(req,res)=>{
    try {res.json(await previewImport(getRuntimeStore(),String(req.body.kind),String(req.body.csv || ''),requireActor().id));}
    catch(error){res.status(400).json({ok:false,error:(error as Error).message});}
  });
  router.post('/data/import/:id/commit',requireRole('finance'),async(req,res)=>{
    try {
      const store=getRuntimeStore(),actor=requireActor();
      const id=await requestConfirmation(store,{capability:'data.import',entity_type:'import',entity_id:req.params.id,payload:{preview_id:req.params.id},initiator:actor.id});
      await resolveConfirmation(store,id,'confirmed',actor);res.json({ok:true});
    }catch(error){res.status(409).json({ok:false,error:(error as Error).message});}
  });
  router.get('/people',async(req,res)=>{
    const list=await collaborationPeople(getRuntimeStore());
    // scope=tasks：任务派发表单的选人候选。被收窄的管理角色只拿到本组成员；其余保持全量。
    if(req.query.scope==='tasks'){
      const scope=await taskAssignmentMembers(getRuntimeStore(),requireActor());
      return res.json({list:scope?list.filter(person=>scope.includes(person.username)):list});
    }
    res.json({list});
  });
  router.get('/me/work',async(req,res)=>{
    const user=currentUser(req)!;
    const [tasks,notifications]=await Promise.all([getRuntimeStore().query('process','tasks',{assignee_id:user.username}),getRuntimeStore().query('process','notifications',{recipient:user.username})]);
    res.json({tasks,notifications:notifications.filter(n=>!n.read_at)});
  });
  router.post('/me/notifications/:id/read',async(req,res)=>{
    const store=getRuntimeStore();const [row]=await store.query('process','notifications',{id:req.params.id,recipient:currentUser(req)!.username});
    if(!row) return res.status(404).json({error:'通知不存在'});
    await store.update('process','notifications',row.id,{read_at:new Date().toISOString()});res.json({ok:true});
  });
  router.get('/cash',requireRole('finance','manager'),async(req,res)=>{
    try {
      const store=getRuntimeStore();const summary=await cashSummary(store,req.query);
      const rows=await store.query('business','cash_movements',undefined,{sort:{key:'created_at',dir:'desc'}});
      const list=rows.filter(row=>{const date=String(row.occurred_on || row.created_at).slice(0,10);return date>=summary.period.from && date<=summary.period.to;});
      res.json({summary,list:list.map(row=>({...row,reversed:rows.some(r=>r.reversal_of===row.id)}))});
    } catch(error) {res.status(400).json({error:(error as Error).message});}
  });
  for(const [path,action] of [['/cash','cash.record'],['/cash/:id/reverse','cash.reverse'],['/invoices/:id/unbook','invoice.unbook']]) router.post(path,requireRole('finance'),async(req,res)=>{
    try {
      const payload=action==='cash.record'?req.body:{...req.body,[action==='cash.reverse'?'movement_id':'invoice_id']:req.params.id};
      const store=getRuntimeStore(),actor=requireActor();
      const id=await requestConfirmation(store,{capability:action,entity_type:action.split('.')[0],entity_id:req.params.id || 'manual:cash',payload,initiator:actor.id});
      await resolveConfirmation(store,id,'confirmed',actor);res.json({ok:true,id});
    } catch(error) {res.status(400).json({ok:false,error:(error as Error).message});}
  });
  return router;
}
