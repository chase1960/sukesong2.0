import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountDirectory} from '../src/directory.ts';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

test('目录新搜索取消旧HTTP，页面退出取消当前读', async()=>{
  const dom=new JSDOM('<div id="host"></div>');
  const host=dom.window.document.querySelector('#host') as HTMLElement;
  const calls:Array<{term:string;signal:AbortSignal}>=[];
  const directory=mountDirectory(host,{
    load:(term,_page,_level,signal)=>new Promise((_resolve,reject)=>{
      calls.push({term,signal:signal!});
      signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});
    }),open:()=>{},upload:()=>{},
  });
  try{
    const input=host.querySelector('[data-picker-search]') as HTMLInputElement;
    input.value='甲';input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(calls[0].signal.aborted,true);
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(calls.length,2);assert.equal(calls[1].term,'甲');
    directory.dispose();assert.equal(calls[1].signal.aborted,true);
    await directory.ready;
  }finally{directory.dispose();dom.window.close();}
});

test('目录点击把已知来源作为第三参传给开表，不按 ID 外形重猜', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const opened: Array<{key: string; state: unknown; source: string}> = [];
  const directory = mountDirectory(host, {
    load: async () => ({entries: [
      {key: 'looks.like.object', title: '文件表', kind: 'xlsx' as const},
      {key: 'akr6lm8fo1', title: '受管表', kind: 'db' as const},
    ], total: 2, truncated: false}),
    open: (key, state, source) => opened.push({key, state, source}),
    upload: () => {},
  });
  try {
    await directory.ready;
    const rows = [...host.querySelectorAll<HTMLTableRowElement>('tbody tr[data-table]')];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const button = [...row.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '打开');
      assert.ok(button, '每张表有打开入口');
      button.click();
    }
    assert.deepEqual(opened.map(({key, source}) => ({key, source})), [
      {key: 'looks.like.object', source: 'xlsx'},
      {key: 'akr6lm8fo1', source: 'db'},
    ]);
    assert.ok(opened.every(item => (item.state as any).page === 1), '原列表返回位置继续传递');
  } finally { directory.dispose(); dom.window.close(); }
});
