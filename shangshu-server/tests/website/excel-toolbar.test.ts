import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildClipboardPayload, readSelectionClipboard, writeSelectionClipboard, workbookShortcutAllowed } from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-toolbar.ts';
import { parseClipboardTsv, serializeClipboardTsv } from '../../../shangshu-web/js/domains/excel-univer/src/clipboard-tsv.ts';
import { exportCurrentTable } from '../../../shangshu-web/js/domains/excel-univer/src/export-helper.ts';

const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 2 };
test('One copy payload preserves literal values and escapes HTML; quoted TSV round-trips', () => {
  const rows = [['00123', '12.50', '甲\n乙'], ['左\t右', '他说"同意"', '<img onerror=bad>']];
  const payload = buildClipboardPayload({ range, getCellText: (r, c) => rows[r][c], isRowLoaded: () => true, serializeTsv: serializeClipboardTsv });
  assert.deepEqual(parseClipboardTsv(payload.tsv), rows);
  assert.match(payload.html, /甲<br>乙/); assert.match(payload.html, /&lt;img onerror=bad&gt;/);
  assert.doesNotMatch(payload.html, /<img /);
});
test('A not-yet-loaded real row refuses the whole copy before reading any cell', () => {
  let reads = 0;
  assert.throws(() => buildClipboardPayload({ range, getCellText: () => { reads++; return ''; }, isRowLoaded: r => r === 0, serializeTsv: serializeClipboardTsv }), /尚未加载/);
  assert.equal(reads, 0);
});
test('Button copy writes both MIME formats and a denied read stays rejected', async () => {
  const payload = buildClipboardPayload({ range, getCellText: () => '00123', isRowLoaded: () => true, serializeTsv: serializeClipboardTsv });
  class Item { values: Record<string, Blob>; constructor(values: Record<string, Blob>) { this.values = values; } }
  let items: Item[] = [];
  const clipboard = { write: async (next: any[]) => { items = next; }, writeText: async () => { throw Error('must not lose rich table'); } };
  assert.equal(await writeSelectionClipboard(payload, clipboard, Item as any), 'rich');
  assert.equal(await items[0].values['text/plain'].text(), payload.tsv); assert.equal(await items[0].values['text/html'].text(), payload.html);
  await assert.rejects(() => readSelectionClipboard({ readText: async () => { throw new DOMException('denied', 'NotAllowedError'); } }), /denied/);
});
test('Workbook shortcuts leave ordinary inputs and disconnected pages alone', () => {
  const target = { closest: () => ({}) }; const event = { target } as unknown as KeyboardEvent;
  const host = { isConnected: true, contains: () => true } as unknown as HTMLElement;
  assert.equal(workbookShortcutAllowed(event, host, false), false);
  assert.equal(workbookShortcutAllowed(event, host, true), true);
  assert.equal(workbookShortcutAllowed(event, { ...host, isConnected: false } as HTMLElement, true), false);
  const body = { closest: () => null };
  const canvasHost = { ...host, contains: () => false, ownerDocument: { body } } as unknown as HTMLElement;
  assert.equal(workbookShortcutAllowed({ target: body } as unknown as KeyboardEvent, canvasHost, false, true), true);
  assert.equal(workbookShortcutAllowed({ target: body } as unknown as KeyboardEvent, canvasHost, false, false), false);
});
test('An in-flight range paste or managed undo blocks export and another managed write', () => {
  const source = readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts', import.meta.url), 'utf8');
  const expression = source.match(/const hasUnsaved = \(\) => ([^;]+);/)?.[1]; assert.ok(expression);
  // ⚠️ `columnPreviewing` 现在也在 `hasUnsaved` 的口径里（main.ts 第 984 行：列预览算「还没弄完」）
  //   ⇒ 抽出来的这个表达式要拿到它，否则沙箱里是 ReferenceError。参数**加在最后**，
  //   前面那些位置参数一个都不动（下面那些 assert 传参的顺序保持原样）。
  const evaluate = new Function('pending', 'pendingWidths', 'pasteApplying', 'undoing', 'pendingStyle', 'headerRename = null', 'inlineControllers = new Map()', 'pendingInput = null', 'savingRowHeights = false', 'structuring = false', 'sorting = false', 'columnPreviewing = false', `return ${expression};`);
  assert.equal(evaluate(new Map(), new Map(), false, false, null), false);
  assert.equal(evaluate(new Map(),new Map(),false,false,null,null,new Map(),null,false,true),true);
  assert.equal(evaluate(new Map(), new Map(), true, false, null), true);
  assert.equal(evaluate(new Map(), new Map(), false, true, null), true);
  assert.equal(evaluate(new Map(),new Map(),false,false,null,{isBusy:()=>true}),true);
  assert.equal(evaluate(new Map(),new Map(),false,false,null,null,new Map([['review',{busy:true}]])),true);
  assert.equal(evaluate(new Map([['edit', {}]]), new Map(), false, false, null), true);
  assert.equal(evaluate(new Map(), new Map(), false, false, {state:'saving'}), true);
  assert.equal(evaluate(new Map(),new Map(),false,false,null,null,new Map(),{state:'failed'}),true);
  // 列预览（拖列改个人视图）也是「还没弄完」⇒ 不许当没事发生（导出／再写都得等它完）。
  assert.equal(evaluate(new Map(),new Map(),false,false,null,null,new Map(),null,false,false,true),true,'列预览还没弄完时也要算「有未保存的东西」');
  const prefix = source.match(/async function runUndo\(\) \{([\s\S]*?)const target =/)?.[1]; assert.ok(prefix);
  const canContinue = new Function('disposed', 'table', 'undoing', 'hasUnsaved', 'notify', `${prefix}return 'continued';`);
  assert.equal(canContinue(false, {}, false, () => true, () => {}), undefined);
  assert.equal(canContinue(false, {}, false, () => false, () => {}), 'continued');
});

const meta = (version = 4, allowed = true) => ({ file: { name: 'test-table', file_name: '最新表.xlsx', status: 'Active', version, can_download: allowed, can_structure: true },
  versions: [{ version_no: version - 1, frappe_file: 'old-file' }, { version_no: version, frappe_file: 'latest-' + version }] });
const json = (value: unknown) => new Response(JSON.stringify({ ok: true, ...value as object }), { headers: { 'content-type': 'application/json' } });
test('Relation export uses authorized snapshot and never falls back to raw workbook on denial',async()=>{
 const calls:string[]=[];
 const fetcher=async(url:string)=>{calls.push(url);if(url.includes('files.versions')){const value=meta();return json({...value,file:{...value.file,has_table_relations:true}});}assert.match(url,/files.table_relation_export/);return json({result:{snapshot:true,content_base64:'UEsBAg==',file_name:'引用.xlsx'}});};
 const result=await exportCurrentTable('test-table','xlsx',{fetcher});assert.deepEqual([...new Uint8Array(result.bytes)],[80,75,1,2]);assert.equal(calls.length,2);
 await assert.rejects(()=>exportCurrentTable('test-table','xlsx',{fetcher:async(url)=>url.includes('files.versions')?fetcher(url):new Response(JSON.stringify({ok:false,error:'源资料不允许导出'}),{status:403})}),/源资料不允许导出/);
 assert.ok(calls.every(url=>!url.includes('file-content')));
});
test('Mutable workbook export uses the current file even when history stays unchanged', async () => {
  const current = { ...meta(9), current: { content_revision: 9, frappe_file: 'same-working-file' },
    versions: [{ version_no: 1, frappe_file: 'original-upload' }] };
  const fetcher = async (url: string) => {
    if (url.includes('files.versions')) return json(current);
    assert.equal(new URL(url, 'https://local.test').searchParams.get('file'), 'same-working-file');
    return new Response(new Uint8Array([80,75,9]));
  };
  const result = await exportCurrentTable('test-table','xlsx',{fetcher});
  assert.deepEqual([...new Uint8Array(result.bytes)],[80,75,9]);
});
test('A changed revision on the same working File still invalidates an in-flight export', async () => {
  let reads = 0;
  const fetcher = async (url: string) => {
    if (!url.includes('files.versions')) return new Response('bytes');
    const revision = ++reads === 1 ? 9 : 10;
    return json({ ...meta(revision), current: {content_revision:revision,frappe_file:'same-working-file'} });
  };
  await assert.rejects(()=>exportCurrentTable('test-table','xlsx',{fetcher}),/文件已更新/);
});
test('The actual adapter download resolves latest authorized attachment, not an empty file argument', async () => {
  const source = readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/adapter.ts', import.meta.url), 'utf8');
  const body = source.match(/async download\(tableId, signal\) \{([\s\S]*?)\n  \},/)?.[1]; assert.ok(body);
  const urls: string[] = []; const fetcher = async (url: string) => {
    urls.push(url); if (url.includes('files.versions')) return json(meta());
    assert.equal(new URL(url, 'https://local.test').searchParams.get('file'), 'latest-4');
    return new Response(new Uint8Array([80, 75, 1, 2]));
  };
  const Async = Object.getPrototypeOf(async () => {}).constructor;
  const invoke = new Async('tableId', 'signal', 'fetch', 'FILE_CONTENT', 'ApiError', 'exportCurrentTable', body);
  const bytes = await invoke('test-table', undefined, fetcher, '/api/platform/file-content', Error,
    (table: string, kind: 'xlsx' | 'db', options: object) => exportCurrentTable(table, kind, { ...options, fetcher }));
  assert.deepEqual([...new Uint8Array(bytes)], [80, 75, 1, 2]); assert.equal(urls.filter(url => url.includes('files.versions')).length, 2);
});
test('Readable without download permission never requests bytes', async () => {
  let bytes = 0; const fetcher = async (url: string) => { if (!url.includes('files.versions')) bytes++; return json(meta(4, false)); };
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher }), /导出权限/); assert.equal(bytes, 0);
});
test('A newer version arriving during download is not handed out as current', async () => {
  let reads = 0; const fetcher = async (url: string) => url.includes('files.versions') ? json(meta(++reads === 1 ? 4 : 5)) : new Response('bytes');
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher }), /文件已更新/);
});
test('Unsaved changes or switching the table stop export before producing a download', async () => {
  let calls = 0; const fetcher = async () => { calls++; return json(meta()); };
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher, hasUnsaved: () => true }), /未保存/); assert.equal(calls, 0);
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher, stillCurrent: () => false }), /切换/); assert.equal(calls, 0);
  let unsaved = false;
  const changed = async () => { calls++; unsaved = true; return json(meta()); };
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher: changed, hasUnsaved: () => unsaved }), /未保存/);
  assert.equal(calls, 1);
});
test('Missing current-version attachment and unsupported objects cannot produce an old or reconstructed export', async () => {
  const missing = meta(); missing.versions = missing.versions.slice(0, 1);
  await assert.rejects(() => exportCurrentTable('test-table', 'xlsx', { fetcher: async () => json(missing) }), /未导出旧版本/);
  let calls = 0;
  await assert.rejects(() => exportCurrentTable('business-object', 'db', { fetcher: async () => { calls++; return json({}); } }), /导出权限/);
  assert.equal(calls, 0);
});
