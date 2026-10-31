import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);let helper;
function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='moveColumnInPersonalView')helper=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);
test('moving columns saves a personal order and does not modify file structure or add structure undo',async()=>{
 assert.ok(helper,'missing personal order persistence');let saved,rebuilds=0;const columns=[{fieldId:'A'},{fieldId:'B'},{fieldId:'C'}];
 const destination={columns,personalView:{view:{filters:[],freeze:{rows:0,columns:0},columns:[]}},savePersonalView:async v=>saved=v};
 const c={table:destination,disposed:false,columns,columnDragOrder:columns.slice(),columnPreviewBackup:columns.slice(),columnPreviewing:true,sorting:false,
  el:{grid:{inert:false}},grid:{getViewState:()=>({range:null,scroll:null}),restoreViewState:()=>{}},
  emptyPersonalView:()=>({filters:[],columns:[],freeze:{rows:0,columns:0}}),unreadableColumns:()=>new Set(),
  reorderByMove:(ids,h,b)=>{const next=ids.filter(id=>id!==h);next.splice(b?next.indexOf(b):next.length,0,h);return next;},
  retrySave:async fn=>fn(),rebuildAfterStructure:async()=>rebuilds++,updateToolbar:()=>{},restoreColumnOrder:()=>{},notify:()=>{}};
 vm.createContext(c);vm.runInContext(ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 await c.moveColumnInPersonalView('C','A');assert.deepEqual(Array.from(saved.columns),['C','A','B']);assert.equal(rebuilds,1);
 assert.equal(c.columnPreviewing,false);assert.equal(c.columnPreviewBackup,null);assert.equal(c.columnDragOrder,null);assert.equal(c.el.grid.inert,false);
 assert.doesNotMatch(helper,/structureAction|rememberStructure/);assert.doesNotMatch(source,/structureAction\('column_move'/);
});
test('a lost personal-view save receipt is reconciled through the official view read',async()=>{
 let reads=0,rebuilds=0;const columns=[{fieldId:'A'},{fieldId:'B'},{fieldId:'C'}];
 const destination={columns,personalView:{view:{filters:[],freeze:{rows:0,columns:0}}},savePersonalView:async()=>{throw Error('connection lost after commit');},loadPersonalView:async()=>{reads++;columns.splice(0,3,{fieldId:'C'},{fieldId:'A'},{fieldId:'B'});return {view:{columns:['C','A','B']}};}};
 const c={table:destination,disposed:false,columns,columnDragOrder:columns.slice(),columnPreviewBackup:columns.slice(),columnPreviewing:true,sorting:false,
 el:{grid:{inert:false}},grid:{getViewState:()=>null},emptyPersonalView:()=>({filters:[],freeze:{rows:0,columns:0}}),unreadableColumns:()=>new Set(),
 reorderByMove:()=>['C','A','B'],retrySave:async fn=>fn(),rebuildAfterStructure:async()=>rebuilds++,updateToolbar:()=>{},restoreColumnOrder:()=>{throw Error('must not restore stale preview after reconciliation');},notify:()=>{}};
 vm.createContext(c);vm.runInContext(ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 await c.moveColumnInPersonalView('C','A');assert.equal(reads,1);assert.equal(rebuilds,1);assert.deepEqual(c.columns.map(x=>x.fieldId),['C','A','B']);assert.equal(c.columnPreviewing,false);
});
