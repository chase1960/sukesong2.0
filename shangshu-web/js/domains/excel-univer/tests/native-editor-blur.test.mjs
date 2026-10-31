import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../../../shangshu-server/package.json',import.meta.url));const {JSDOM}=require('jsdom');
const source=fs.readFileSync(new URL('../src/sheet.ts',import.meta.url),'utf8');const ast=ts.createSourceFile('sheet.ts',source,ts.ScriptTarget.Latest,true);let declaration;
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='endEditOnPointerDown')declaration=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);
function fixture(){
 const dom=new JSDOM('<div id="host"><div data-u-comp="editor" class="univer-absolute"><canvas id="text"></canvas><div id="active" contenteditable="true" tabindex="-1"></div></div><canvas id="other"></canvas></div><button id="toolbar">outside</button>');
 const document=dom.window.document,host=document.querySelector('#host'),editor=host.querySelector('.univer-absolute');document.querySelector('#active').focus();editor.getBoundingClientRect=()=>({width:88,height:25});const commits=[];
 const c={document,host,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,getComputedStyle:dom.window.getComputedStyle,univerAPI:{syncExecuteCommand:(...args)=>commits.push(args)},SetCellEditVisibleOperation:{id:'native-end-edit'},workbookId:'book'};
 vm.createContext(c);vm.runInContext(ts.transpileModule('var '+declaration,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);return {document,editor,commits,down:c.endEditOnPointerDown};
}
test('clicking the native editor canvas to place the caret keeps editing open',()=>{const f=fixture();f.down({target:f.document.querySelector('#text')});assert.equal(f.commits.length,0);});
test('clicking another grid cell commits the native editor before changing cells',()=>{const f=fixture();f.down({target:f.document.querySelector('#other')});assert.equal(f.commits.length,1);assert.equal(f.commits[0][1].visible,false);});
test('clicking the toolbar still commits, and a hidden editor does not submit again',()=>{const f=fixture();f.down({target:f.document.querySelector('#toolbar')});assert.equal(f.commits.length,1);f.editor.getBoundingClientRect=()=>({width:0,height:0});f.down({target:f.document.querySelector('#toolbar')});assert.equal(f.commits.length,1);});

test('zero-height and visibility-hidden native editors never submit residual focus',()=>{const f=fixture();f.editor.getBoundingClientRect=()=>({width:88,height:0});f.down({target:f.document.querySelector('#other')});assert.equal(f.commits.length,0);f.editor.getBoundingClientRect=()=>({width:88,height:25});f.editor.style.visibility='hidden';f.down({target:f.document.querySelector('#other')});assert.equal(f.commits.length,0);});
