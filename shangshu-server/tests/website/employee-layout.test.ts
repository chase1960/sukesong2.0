import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const web=new URL('../../../shangshu-web/',import.meta.url);
const css=['workbench','file-center','mail-center','deepseek','platform'].map(name=>readFileSync(new URL(`css/${name}.css`,web),'utf8')).join('\n');
test('数据目录与记录标题共用高度，左右分割线连续',()=>{
  const dom=new JSDOM(`<style>${css}</style><div class="objects-page"><div class="dataset-panel-head" id="left">数据表</div><div class="dataset-head" id="right">发票</div></div>`);
  try{const style=(id:string)=>dom.window.getComputedStyle(dom.window.document.getElementById(id)!);
    assert.equal(style('left').height,'50px');assert.equal(style('right').height,'50px');
    assert.equal(style('left').boxSizing,'border-box');assert.equal(style('right').boxSizing,'border-box');
  }finally{dom.window.close();}
});
test('文件搜索先收缩，布局按钮组不可拆；目录标签和选择器保持同组',()=>{
  const dom=new JSDOM(`<style>${css}</style><div class="file-center-page"><div class="file-tools"><label class="file-search" id="search"></label><div class="file-layouts" id="layouts"></div></div><div class="file-directory-tools"><label id="directory">目录<select></select></label></div></div>`);
  try{const style=(id:string)=>dom.window.getComputedStyle(dom.window.document.getElementById(id)!);
    assert.equal(style('search').flexGrow,'1');assert.equal(style('search').minWidth,'120px');
    assert.equal(style('layouts').flexShrink,'0');assert.equal(style('directory').whiteSpace,'nowrap');
  }finally{dom.window.close();}
});
test('文件信息和预览各有等高标题；邮箱连接状态不是小号按钮',()=>{
  const source=readFileSync(new URL('js/file-detail.js',web),'utf8');
  assert.match(source,/file-properties-heading[^>]*>文件信息/);
  assert.match(source,/file-preview-heading[^>]*><span>文件预览<\/span>/);
  const dom=new JSDOM(`<style>${css}</style><div class="mail-center-page"><span class="preview-label" id="status">未绑定邮箱</span></div>`);
  try{assert.equal(dom.window.getComputedStyle(dom.window.document.getElementById('status')!).borderTopWidth,'0px');}finally{dom.window.close();}
});
test('窄屏文件范围不逐字折行，留在自身横向滚动条',()=>{
  const dom=new JSDOM(`<style>${css}</style><div class="file-center-page"><nav class="file-tabs" id="tabs"><button id="tab">我的上传</button></nav></div>`);
  try{assert.equal(dom.window.getComputedStyle(dom.window.document.getElementById('tabs')!).overflowX,'auto');assert.equal(dom.window.getComputedStyle(dom.window.document.getElementById('tab')!).whiteSpace,'nowrap');}finally{dom.window.close();}
});
