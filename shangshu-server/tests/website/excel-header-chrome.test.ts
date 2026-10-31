import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenIdleHeaderHandles,installFlatHeaderChrome} from '../../../shangshu-web/js/domains/excel-univer/src/header-chrome.ts';
const idle={startRow:-1,startColumn:-1,xSplit:0,ySplit:0};
// The real Rect.setProps ignores BaseObject geometry; it must use transformByState.
const rect=(props:any)=>({...props,calls:0,setProps(next:any){for(const [key,value] of Object.entries(next))if(!['left','top','width','height'].includes(key))this[key]=value;this.calls++;},transformByState(next:any){Object.assign(this,next);return this;}});
function scene(){const objects:any={__SpreadsheetFreezeRowHeaderName__:rect({left:0,top:25,width:46,height:3,fill:'#aab0b9'}),__SpreadsheetFreezeColumnHeaderName__:rect({left:43,top:0,width:3,height:28,fill:'#aab0b9'}),__SpreadsheetHeaderResizeControllerShapeColumn__:rect({left:210,top:0,width:4,height:28,fill:'green'}),selection:rect({left:46,top:28,width:100,height:24,fill:'green'})};return {objects,getObject:(key:string)=>objects[key]};}
test('The actual 3px idle handle shape becomes one flat pixel aligned to the same header boundary; resize/selection stay intact',()=>{
  const s=scene();const before=JSON.stringify([s.objects.selection,s.objects.__SpreadsheetHeaderResizeControllerShapeColumn__]);
  assert.equal(s.objects.__SpreadsheetFreezeRowHeaderName__.height,3);assert.equal(s.objects.__SpreadsheetFreezeColumnHeaderName__.width,3);
  assert.deepEqual(flattenIdleHeaderHandles(s,idle,'#e5e7eb'),{status:'ready',matched:2});
  const row=s.objects.__SpreadsheetFreezeRowHeaderName__,column=s.objects.__SpreadsheetFreezeColumnHeaderName__;
  assert.equal(row.height,1);assert.equal(row.top+row.height,28);assert.equal(column.width,1);assert.equal(column.left+column.width,46);assert.equal(row.fill,'#e5e7eb');
  flattenIdleHeaderHandles(s,idle,'#e5e7eb');assert.equal(row.calls,1);assert.equal(column.calls,1);
  assert.equal(JSON.stringify([s.objects.selection,s.objects.__SpreadsheetHeaderResizeControllerShapeColumn__]),before);
});
test('Active freeze, missing objects and absent state are explicit safe no-ops',()=>{
  const s=scene();assert.equal(flattenIdleHeaderHandles(s,{...idle,ySplit:1},'#eee').status,'frozen');assert.equal(s.objects.__SpreadsheetFreezeRowHeaderName__.height,3);
  assert.equal(flattenIdleHeaderHandles(s,undefined,'#eee').status,'unavailable');
  assert.equal(flattenIdleHeaderHandles({getObject:()=>null},idle,'#eee').status,'missing');
});
test('New skeleton handles and zoom/theme redraws are corrected again, and dispose detaches both public observers',()=>{
  const s=scene();const events=new Set<()=>void>();let removed=0;const event={subscribe(fn:()=>void){events.add(fn);return {unsubscribe(){events.delete(fn);removed++;}};}};
  const statuses:string[]=[];const handle=installFlatHeaderChrome({...s,beforeRender$:event,addObject$:event},()=>idle,'#eee',diag=>statuses.push(diag.status));
  const replacement=rect({left:0,top:25,width:46,height:3,fill:'#aab0b9'});s.objects.__SpreadsheetFreezeRowHeaderName__=replacement;events.forEach(fn=>fn());assert.equal(replacement.height,1);
  replacement.setProps({fill:'#777'});events.forEach(fn=>fn());assert.equal(replacement.fill,'#eee');
  handle.dispose();assert.equal(removed,2);assert.equal(events.size,0);assert.equal(statuses.at(-1),'disposed');
});
