import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {CellValueType} from '@univerjs/core';
const src=fs.readFileSync(new URL('../src/sheet.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('sheet.ts',src,ts.ScriptTarget.Latest,true);
function find(name){let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(found);return found;}
const constants=src.match(/const CELL_STRING = [^;]+;\s*const CELL_NUMBER = [^;]+;/)[0];
const ctx={defaultStyle:{},CellValueType,wrapped:new Set(),fontStyleToUniver:s=>({...s})};vm.createContext(ctx);
vm.runInContext(ts.transpileModule([constants,find('toText'),find('displayCellText'),find('cellFor')].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
test('text storage type does not ask editor to synthesize an apostrophe',()=>{
 for(const value of ['2','00123','12345678901234567890',"'real", "''two", '=literal', ' spaced ']){
  const c=ctx.cellFor(value,{fieldId:'a'},'text');assert.equal(c.v,value);assert.equal(c.t,CellValueType.STRING);assert.notEqual(c.t,CellValueType.FORCE_STRING);assert.equal(c.s.n.pattern,'@');
 }
});
test('numbers keep numeric type and dates retain display normalization',()=>{
 assert.equal(ctx.cellFor(2,{fieldId:'a'},'number').t,CellValueType.NUMBER);
 const canonical='2026-10-15T00:00:00';
 const date=ctx.cellFor(canonical,{fieldId:'a'},'date');
 assert.equal(date.t,CellValueType.NUMBER,'only the engine projection uses a date serial');
 assert.equal(date.v,(Date.UTC(2026,9,15)-Date.UTC(1899,11,30))/86400000);
 assert.equal(date.s.n.pattern,'yyyy-mm-dd','the serial must carry the calendar display format');
 assert.equal(ctx.displayCellText(canonical,'date'),'2026-10-15','canonical copy/display normalization remains unchanged');
 assert.equal(canonical,'2026-10-15T00:00:00','projection must not replace the source value');
 const time=ctx.cellFor('2026-10-15T13:20:00',{fieldId:'a'},'date');
 assert.equal(time.v,date.v+800/1440);assert.equal(time.s.n.pattern,'yyyy-mm-dd hh:mm:ss');
 assert.equal(ctx.displayCellText('2026-10-15T13:20:00','date'),'2026-10-15T13:20:00');
 const literal=ctx.cellFor(canonical,{fieldId:'a'},'text');
 assert.equal(literal.v,canonical);assert.equal(literal.t,CellValueType.STRING);assert.equal(literal.s.n.pattern,'@');
});
