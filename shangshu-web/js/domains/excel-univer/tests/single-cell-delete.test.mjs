import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const src=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',src,ts.ScriptTarget.Latest,true);let fn;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='clearSelection')fn=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);
test('delete one existing cell uses ordinary silent save and keeps its preimage',()=>{
 const commits=[];const c={grid:{getSelectionRange:()=>({startRow:0,endRow:0,startCol:0,endCol:0}),isEditing:()=>false,getRowValue:()=> '原值'},totalRows:1,columns:[{fieldId:'备注',type:'text'}],onCommit:e=>commits.push(e),handlePaste:()=>{throw Error('不能弹批量粘贴遮罩');},notify:()=>{}};
 vm.createContext(c);vm.runInContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);c.clearSelection();assert.equal(commits.length,1);assert.equal(commits[0].before,'原值');assert.equal(commits[0].value,'');
});
