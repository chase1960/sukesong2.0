import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/sheet.ts',import.meta.url),'utf8');const ast=ts.createSourceFile('sheet.ts',source,ts.ScriptTarget.Latest,true);let declaration;
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='BLOCKED_COMMAND_PATTERNS')declaration=n.initializer.getText(ast);ts.forEachChild(n,visit);}visit(ast);
test('copy remains a browser clipboard command as in the working version; cut and unmanaged paste stay blocked',()=>{
 const patterns=vm.runInNewContext(declaration);const blocked=id=>patterns.some(re=>re.test(id));
 assert.equal(blocked('sheet.command.copy'),false,'复制不能被值写入白名单拦掉');assert.equal(blocked('sheet.command.cut'),true);assert.equal(blocked('sheet.command.paste'),true);
});
