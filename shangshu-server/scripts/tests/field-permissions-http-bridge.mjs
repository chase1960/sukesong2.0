import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {editFieldPermissions,readFieldPermissionContext} from '../../../shangshu-web/js/domains/excel-univer/src/field-permissions.ts';
const base=process.env.SS_BASE,table=process.env.SS_FIELD_TABLE,cookie=process.env.SS_FIELD_COOKIE;
assert.ok(base&&table&&cookie,'explicit fixture environment required');
const requests=[];const fetcher=async(url,init={})=>{const response=await fetch(base+url,{...init,headers:{...init.headers,cookie}});requests.push({url,status:response.status});return response;};
const initial=await readFieldPermissionContext(table,fetcher);assert.equal(initial.can_manage_field_permissions,true);assert.ok(initial.definition_sha);assert.ok(initial.role_options.some(r=>r.id==='Desk User'));
const dom=new JSDOM('<main></main>');let closed=false;const ui={dialog(o){const d=dom.window.document.createElement('section');d.innerHTML=o.body;for(const action of o.actions){const b=dom.window.document.createElement('button');b.textContent=action.label;b.onclick=action.onClick;d.append(b);}dom.window.document.body.append(d);return d;},closeModal(){closed=true;return true;},guardModal(){}};
const button=d=>Array.from(d.querySelectorAll('button')).find(b=>b.textContent==='保存');
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('production dialog response timed out');}
try{
 const dialog=await editFieldPermissions(ui,table,{fetcher,newKey:()=>crypto.randomUUID()});
 const field=dialog.querySelector('fieldset'),header=field.querySelector('legend').textContent;
 field.querySelector('[data-permission=read_roles]').value='inherit';field.querySelector('[data-permission=write_roles]').value='none';field.querySelector('[data-permission=download_roles]').value='roles';
 field.querySelectorAll('[data-role-choices=download_roles] input').forEach(b=>b.checked=b.value==='Desk User');button(dialog).click();await until(()=>closed||(!button(dialog).disabled&&dialog.querySelector('[data-status]').textContent!=='正在保存…'));
 assert.equal(closed,true,dialog.querySelector('[data-status]').textContent);
 const after=await readFieldPermissionContext(table,fetcher),col=after.columns.find(c=>c.header===header),prior=initial.columns.find(c=>c.header===header);
 assert.equal(Object.hasOwn(col,'read_roles'),false);assert.deepEqual(col.write_roles,[]);assert.deepEqual(col.download_roles,['Desk User']);
 for(const key of ['field','type','rules','promoted'])assert.deepEqual(col[key],prior[key]);assert.deepEqual(after.columns.filter(c=>c.header!==header),initial.columns.filter(c=>c.header!==header));
 console.log('PASS production field dialog → actual HTTP → independent persisted read; three modes and other definitions retained');
 closed=false;const stale=await editFieldPermissions(ui,table,{fetcher,newKey:()=>crypto.randomUUID()});stale.querySelector('[data-permission=write_roles]').value='roles';stale.querySelectorAll('[data-role-choices=write_roles] input').forEach(b=>b.checked=b.value==='Desk User');
 const changed=structuredClone(after.columns);changed.find(c=>c.header===header).download_roles=[];
 const update=await fetcher('/api/platform/actions/files.promotion_define/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{table,expected_structure_version:after.structure_version,expected_definition_sha:after.definition_sha,definition:{definition_version:after.definition_version,columns:changed}},confirmed:true,idempotency_key:crypto.randomUUID()})});assert.equal(update.status,200);
 button(stale).click();await until(()=>!button(stale).disabled&&stale.querySelector('[data-status]').textContent!=='正在保存…');
 assert.equal(closed,false);assert.match(stale.querySelector('[data-status]').textContent,/字段定义已变化/);assert.equal(stale.querySelector('[data-permission=write_roles]').value,'roles');assert.deepEqual((await readFieldPermissionContext(table,fetcher)).columns,changed);
 console.log('PASS stale production dialog rejected after intervening ACL change; input retained and latest definition unchanged');
 console.log('HTTP',JSON.stringify(requests));
}finally{dom.window.close();}
