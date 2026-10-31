/** Univer 1.0.3 在未冻结时也画3px冻结手柄。只调整这两个公开Rect的外观。 */
const ROW_HANDLE='__SpreadsheetFreezeRowHeaderName__';
const COLUMN_HANDLE='__SpreadsheetFreezeColumnHeaderName__';
interface Subscription {unsubscribe():void}
interface Observable {subscribe(handler:()=>void):Subscription}
interface Shape {left:number;top:number;width:number;height:number;fill?:unknown;setProps(props:Record<string,unknown>):unknown;transformByState(props:Record<string,unknown>):unknown}
export interface HeaderScene {getObject(key:string):unknown;beforeRender$?:Observable;addObject$?:Observable}
export interface HeaderChromeDiag {status:'ready'|'missing'|'frozen'|'unavailable'|'disposed';matched:number;reason?:string}
interface Freeze {startRow?:number;startColumn?:number;xSplit?:number;ySplit?:number}
function shape(value:unknown):value is Shape{
  const item=value as Shape|null;return !!item&&typeof item.setProps==='function'&&typeof item.transformByState==='function'&&[item.left,item.top,item.width,item.height].every(Number.isFinite);
}
export function flattenIdleHeaderHandles(scene:HeaderScene,freeze:Freeze|undefined,color:string):HeaderChromeDiag{
  if(!freeze)return {status:'unavailable',matched:0,reason:'冻结状态尚未就绪'};
  if((freeze.startRow??-1)>0||(freeze.startColumn??-1)>0||(freeze.xSplit??0)>0||(freeze.ySplit??0)>0)return {status:'frozen',matched:0};
  let matched=0;
  const row=scene.getObject(ROW_HANDLE);
  if(shape(row)){
    matched++;
    if(row.height!==1)row.transformByState({height:1,top:row.top+row.height-1});
    if(row.fill!==color)row.setProps({fill:color});
  }
  const column=scene.getObject(COLUMN_HANDLE);
  if(shape(column)){
    matched++;
    if(column.width!==1)column.transformByState({width:1,left:column.left+column.width-1});
    if(column.fill!==color)column.setProps({fill:color});
  }
  return {status:matched===2?'ready':'missing',matched,...(matched===2?{}:{reason:'未找到完整的未冻结表头手柄'})};
}
/** Scene事件覆盖skeleton新对象、缩放及主题重绘；无变化时不setProps，避免逐帧变脏。 */
export function installFlatHeaderChrome(scene:HeaderScene,readFreeze:()=>Freeze|undefined,color:string,report:(diag:HeaderChromeDiag)=>void):{dispose():void}{
  let disposed=false;const subscriptions:Subscription[]=[];
  const refresh=()=>{if(disposed)return;try{report(flattenIdleHeaderHandles(scene,readFreeze(),color));}catch{report({status:'unavailable',matched:0,reason:'未能读取表头画布对象'});}};
  if(!scene?.getObject){report({status:'unavailable',matched:0,reason:'表头画布尚未就绪'});return {dispose(){}};}
  for(const event of [scene.beforeRender$,scene.addObject$])if(event)subscriptions.push(event.subscribe(refresh));
  refresh();
  return {dispose(){if(disposed)return;disposed=true;subscriptions.forEach(subscription=>subscription.unsubscribe());report({status:'disposed',matched:0});}};
}
