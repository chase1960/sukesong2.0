import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listTables} from '../src/backend.ts';
import type {ObjectInfo} from '../src/api.ts';

/**
 * 目录的**混合分页**：业务表在前、文件在后，**一页只放 pageLength 条**
 * （2026-10-28 · PKG-132 · 审查报告 R11）。
 *
 * 踩过的坑：第一版把**全部业务表**都塞进这一页 ⇒ 一页渲染了 317 行
 * （页面只显示 20 条，其余在下面）⇒ 「页码决定实际读取范围」是假的。
 *
 * 测试通过 = 下面全部成立：
 *  1. **一页只放 pageLength 条**（业务表在前、文件在后）
 *  2. **总数**是服务端给的（业务表数 ＋ 文件数）
 *  3. **翻到后一页**：业务表用完了才开始出现文件，且仍是 pageLength 条
 *  4. **文件请求的页码**跟着页面走（不是每次都读第 1 页）
 */

const OBJECTS = '/api/platform/objects';
const FILES = '/api/platform/datasets/files.file/records';

function object(id: string): ObjectInfo {
  return {id, title: id, revision: 3, operations: ['read'],
    fields: [{id: 'amount', label: '金额', type: 'decimal'}], input_schema: {properties: {amount: {}}}};
}

async function fixture(run: () => Promise<void>, handler: (path: string) => Response) {
  const previous = globalThis.fetch;
  const shared = (globalThis as any).shangshuPlatformCatalog;
  const calls: string[] = [];
  delete (globalThis as any).shangshuPlatformCatalog;
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    return handler(path);
  };
  try { await run(); }
  finally { globalThis.fetch = previous; (globalThis as any).shangshuPlatformCatalog = shared; }
}

function filePage(path: string, all: Record<string, unknown>[], length: number) {
  const query = new URL(path, 'http://test').searchParams;
  const page = Number(query.get('page') || '1');
  const size = Number(query.get('page_length') || String(length));
  const rows = all.slice((page - 1) * size, page * size);
  return Response.json({rows, total: all.length});
}
function objectPage(path:string,objects:ObjectInfo[]){
  const params=new URL(path,'http://test').searchParams;
  assert.equal(params.get('summary'),'1','目录只能读取摘要');
  const page=Number(params.get('page')),length=Number(params.get('page_length'));
  return Response.json({list:objects.slice((page-1)*length,page*length),total:objects.length,page,page_length:length});
}

test('一页只放 pageLength 条：业务表在前、文件在后', async () => {
  const objects = Array.from({length: 317}, (_, i) => object(`obj.${i}`));
  const files = Array.from({length: 50}, (_, i) => ({name: `F${i}`, file_name: `文件${i}.xlsx`}));
  await fixture(async () => {
    const result = await listTables(undefined, {page: 1, pageLength: 20});
    assert.equal(result.entries.length, 20, `一页不该超过 20 条（实际 ${result.entries.length}）`);
    assert.equal(result.total, 317 + 50, '总数不对');
    assert.equal(result.entries.filter(e => e.kind === 'db').length, 20, '这一页应当全是业务表');
  }, path => {
    if (path.startsWith(OBJECTS)) return objectPage(path,objects);
    if (path.startsWith(FILES)) return filePage(path, files, 20);
    throw Error('不应读取：' + path);
  });
});

test('业务表用完以后，文件才出现；仍是 pageLength 条', async () => {
  const objects = Array.from({length: 25}, (_, i) => object(`obj.${i}`));
  const files = Array.from({length: 50}, (_, i) => ({name: `F${i}`, file_name: `文件${i}.xlsx`}));
  await fixture(async () => {
    const first = await listTables(undefined, {page: 1, pageLength: 20});
    assert.equal(first.entries.length, 20);
    assert.equal(first.entries.filter(e => e.kind === 'db').length, 20, '第 1 页应当全是业务表');
    const second = await listTables(undefined, {page: 2, pageLength: 20});
    assert.equal(second.entries.length, 20, '第 2 页也不该超过 20 条');
    const db = second.entries.filter(e => e.kind === 'db').length;
    const xlsx = second.entries.filter(e => e.kind === 'xlsx').length;
    assert.equal(db, 5, '第 2 页应当有 5 个业务表（25 个里的后 5 个）');
    assert.equal(xlsx, 15, '第 2 页应当有 15 个文件');
  }, path => {
    if (path.startsWith(OBJECTS)) return objectPage(path,objects);
    if (path.startsWith(FILES)) return filePage(path, files, 20);
    throw Error('不应读取：' + path);
  });
});

test('文件请求的页码跟着页面走', async () => {
  const objects: ObjectInfo[] = [];
  const files = Array.from({length: 500}, (_, i) => ({name: `F${i}`, file_name: `文件${i}.xlsx`}));
  const seen: number[] = [];
  await fixture(async () => {
    await listTables(undefined, {page: 3, pageLength: 20});
  }, path => {
    if (path.startsWith(OBJECTS)) return objectPage(path,objects);
    if (path.startsWith(FILES)) {
      seen.push(Number(new URL(path, 'http://test').searchParams.get('page') || '1'));
      return filePage(path, files, 20);
    }
    throw Error('不应读取：' + path);
  });
  assert.ok(seen.length >= 1, '没读文件');
  assert.ok(seen.some(page => page >= 2), `文件请求的页码没有跟着页面走（读了 ${seen.join(',')}）`);
});

test('混合目录跨多页对象后仍按真实文件偏移取页，不漏跨页的5条文件',async()=>{
  const objects=Array.from({length:25},(_,i)=>object('O'+i));
  const files=Array.from({length:60},(_,i)=>({name:'F'+i,file_name:'文件'+i+'.xlsx'}));
  const filePages:number[]=[];
  await fixture(async()=>{
    const page=await listTables(undefined,{page:3,pageLength:20});
    assert.deepEqual(page.entries.map(row=>row.key),Array.from({length:20},(_,i)=>'F'+(i+15)));
    assert.deepEqual(filePages,[1,2]);
  },path=>{
    if(path.startsWith(OBJECTS))return objectPage(path,objects);
    if(path.startsWith(FILES)){filePages.push(Number(new URL(path,'http://test').searchParams.get('page')));return filePage(path,files,20);}
    throw Error('不应读取：'+path);
  });
});
