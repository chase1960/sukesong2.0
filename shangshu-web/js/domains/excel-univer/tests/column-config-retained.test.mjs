import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);let repaint;
function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='repaintColumnOrder')repaint=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);
test('column preview retains dropdown rules and Chinese labels',()=>{
 const column={fieldId:'方向',label:'方向',type:'text',readOnly:false,options:['DD','IN'],optionLabels:{DD:'国内'},allowCustom:false,customLabel:'其他'};let actual;
 const c={columns:[column],grid:{adoptColumns:next=>actual=next,setColumnHeaders:()=>{}},pageCache:new Map(),PAGE_LENGTH:100};vm.createContext(c);vm.runInContext(ts.transpileModule(repaint,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);c.repaintColumnOrder();assert.deepEqual(JSON.parse(JSON.stringify(actual[0])),column);
});
