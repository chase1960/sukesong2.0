import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 FIX-16 / MAIL-NEXT-01 + MAIL-NEXT-02：附件选择用公共居中弹窗，Excel 与其它文件**同一份列表**。

 用户原话（细则）：「Excel 是文件的一个分支……附件选择默认列出当前用户有权选作附件的
 所有文件，包括 Excel，不再要求在『普通文件』和『Excel』之间切换才能找到文件」。

 测试通过 = 下面全部成立：
 1. 打开的是**公共居中弹窗**（tool-workspace 的 .os-dialog，挂在 body 上），
    不再在邮件正文下方就地展开一大块（正文不被挤掉）。
 2. 弹窗里**没有**「普通文件 / Excel」互斥下拉；列表请求用统一范围（scope=attachable）。
 3. 每行带类型标识；**按行**分流：Excel 表格走受管快照，普通文件走版本选择。
 4. 选中先落在弹窗里（暂存）：确认添加才写回草稿。
 5. 取消不改变原附件。
 6. 重新打开不产生重复附件。
 7. 搜索与分页可用。
*/

const toolWorkspace = readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../../../shangshu-web/js/file-reference-picker.js', import.meta.url), 'utf8');

const tick = () => new Promise(r => setTimeout(r, 10));

type Row = {name?: string; file_name: string};

function mount(options: {rows: Row[]; total?: number; versions?: any[]; snapshot?: any; attachMode?: string; withoutDialog?: boolean} = {}) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(toolWorkspace);
  w.eval(picker);
  const host = w.document.querySelector('#host');
  const node = w.document.createElement('div');
  host.append(node);
  const ui = w.createToolWorkspace(host, {});
  /* 弹窗件不可用时的提示要能看见 —— 先装好探针再挂选择器（选择器在挂载时就把 notify 抓走了）。 */
  const notices: string[] = [];
  ui.notify = (message: string) => { notices.push(String(message)); };
  if (options.withoutDialog) delete (ui as any).dialog;
  const requests: {url: string; body: any}[] = [];
  /* 文件库列表行的真实形状：files.file 记录同时有 name（记录身份=表身份）与 file_name（展示名）。 */
  const rows = options.rows ?? [
    {name: '季度台账.xlsx', file_name: '季度台账.xlsx'},
    {name: '说明.pdf', file_name: '说明.pdf'},
    {name: '预算表.xlsx', file_name: '预算表.xlsx'},
  ];
  w.fetch = async (url: string, opts: any) => {
    requests.push({url: String(url), body: opts?.body ? JSON.parse(opts.body) : null});
    const u = String(url);
    if (u.includes('/datasets/files.file/records')) {
      return {ok: true, json: async () => ({ok: true, rows, total: options.total ?? rows.length})};
    }
    if (u.includes('files.sheet_snapshot')) {
      return {ok: true, json: async () => ({ok: true, result: options.snapshot ?? {file: 'snap-1', file_name: '季度台账.xlsx', lib: 'lib-x', content_version: 5, size: 1024}})};
    }
    if (u.includes('files.versions/invoke')) {
      return {ok: true, json: async () => ({ok: true, result: {versions: options.versions ?? [{frappe_file: 'ver-1', version_no: 1, size: 2048}]}})};
    }
    return {ok: true, json: async () => ({ok: true})};
  };
  const values: any[] = [];
  let changed = 0;
  w.mountFileReferencePicker({ui, node, values, onChange: () => { changed++; }, placeholder: '选择附件', attachMode: options.attachMode});
  return {w, node, ui, values, requests, notices, changedCount: () => changed, dispose: () => dom.window.close()};
}

async function openDialog(t: ReturnType<typeof mount>) {
  t.node.querySelector('[data-attachment-value]').click();
  await tick();
  return t.w.document.querySelector('dialog.os-dialog');
}

// —— FIX-16 判据 1：公共居中弹窗 ——
it('FIX-16 附件选择用公共居中弹窗：测试通过 = 弹出 .os-dialog 挂在 body 上，正文旁不再就地展开', async () => {
  const t = mount();
  try {
    const dlg = await openDialog(t);
    assert.ok(dlg, '没有弹出公共弹窗（dialog.os-dialog）');
    assert.equal(dlg.parentElement, t.w.document.body, '公共弹窗应挂在 body 上，不被邮件正文区裁切');
    assert.equal(t.node.querySelector('[data-attachment-editor]'), null, '正文旁不该再就地展开一大块选择面板');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 2：一份列表，没有互斥下拉 ——
// 测试通过 = 弹窗里没有「普通文件/Excel」切换；列表请求走统一范围（scope=attachable）。
it('FIX-16 Excel 与其它文件同一份列表：测试通过 = 没有互斥下拉，请求 scope=attachable', async () => {
  const t = mount();
  try {
    const dlg = await openDialog(t);
    assert.equal(dlg.querySelector('[data-pick-kind]'), null, '不该再有「普通文件 / Excel」互斥下拉');
    const listRequest = t.requests.find(r => r.url.includes('/datasets/files.file/records'));
    assert.ok(listRequest, '没有发出文件列表请求');
    const filters = JSON.parse(new URL(listRequest.url, 'http://x').searchParams.get('filters') || '{}');
    assert.equal(filters.scope, 'attachable', '列表要走统一范围（普通文件 + Excel 表格一起列）');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 3：按行分流 ——
// 测试通过 = 每行带类型标识；点 Excel 行走受管快照，点普通文件行走版本选择。
it('FIX-16 按行分流：测试通过 = Excel 行走快照、普通文件行走版本，行上有类型标识', async () => {
  const t = mount();
  try {
    const dlg = await openDialog(t);
    const rows = [...dlg.querySelectorAll('[data-pick-file]')];
    assert.equal(rows.length, 3, '三个文件都该在列表里');
    assert.match(rows[0].textContent || '', /Excel 表格/, 'xlsx 行要有类型标识');
    assert.match(rows[1].textContent || '', /PDF/, 'pdf 行要有类型标识');

    rows[0].click();                       // 季度台账.xlsx → 快照
    await tick();
    assert.ok(t.requests.some(r => r.url.includes('files.sheet_snapshot')), 'Excel 行应走受管快照');

    rows[1].click();                       // 说明.pdf → 版本
    await tick();
    assert.ok(t.requests.some(r => r.url.includes('files.versions/invoke')), '普通文件行应走版本选择');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 3b：取哪份字节按落点分清 ——
// 测试通过 = 「发附件」落点对 Excel 表走受管快照（发它现在的样子）；
// 「要读原始文件」落点（表格导入）一律走版本 —— 不靠文件类型猜。
it('FIX-16 取字节按落点分清：测试通过 = 发附件走快照、表格导入走版本', async () => {
  const t = mount({attachMode: 'file'});
  try {
    const dlg = await openDialog(t);
    dlg.querySelectorAll('[data-pick-file]')[0].click();   // 季度台账.xlsx
    await tick();
    assert.ok(t.requests.some(r => r.url.includes('files.versions/invoke')), '导入落点应走版本');
    assert.ok(!t.requests.some(r => r.url.includes('files.sheet_snapshot')), '导入落点不该走快照');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 4 + 5：确认才写回，取消不动原附件 ——
it('FIX-16 确认添加才写回、取消不写回：测试通过 = 暂存阶段草稿不变，确认后写回，取消后原样', async () => {
  const t = mount();
  try {
    const dlg = await openDialog(t);
    const rows = [...dlg.querySelectorAll('[data-pick-file]')];
    rows[1].click();                       // 说明.pdf → 取版本
    await tick();
    const box = dlg.querySelector('[data-pick-version]');
    assert.ok(box, '版本列表没出来');
    box.checked = true;
    box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();
    assert.equal(t.values.length, 0, '暂存阶段不该改草稿附件');

    // 取消
    dlg.querySelector('[data-act="0"]').click();
    await tick();
    assert.equal(t.values.length, 0, '取消不改变原附件');

    // 重新打开 → 选 → 确认
    const dlg2 = await openDialog(t);
    const rows2 = [...dlg2.querySelectorAll('[data-pick-file]')];
    rows2[1].click();
    await tick();
    const box2 = dlg2.querySelector('[data-pick-version]');
    box2.checked = true;
    box2.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();
    dlg2.querySelector('[data-act="1"]').click();
    await tick();
    assert.equal(t.values.length, 1, '确认添加后应写回草稿');
    assert.equal(t.values[0].file, 'ver-1', '写回的是选中的那个版本');
    assert.equal(t.changedCount(), 1, '写回才通知一次变更');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 6：重新打开不产生重复附件 ——
it('FIX-16 重新打开不产生重复附件：测试通过 = 再次打开时同一版本已选中，不会再加一份', async () => {
  const t = mount();
  try {
    let dlg = await openDialog(t);
    dlg.querySelectorAll('[data-pick-file]')[1].click();
    await tick();
    const box = dlg.querySelector('[data-pick-version]');
    box.checked = true;
    box.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();
    dlg.querySelector('[data-act="1"]').click();
    await tick();
    assert.equal(t.values.length, 1, '第一次确认写回一份');

    dlg = await openDialog(t);
    dlg.querySelectorAll('[data-pick-file]')[1].click();
    await tick();
    const again = dlg.querySelector('[data-pick-version]');
    assert.equal(again.checked, true, '再次打开时同一版本应显示为已选');
    again.checked = true;
    again.dispatchEvent(new t.w.Event('change', {bubbles: true}));
    await tick();
    dlg.querySelector('[data-act="1"]').click();
    await tick();
    assert.equal(t.values.length, 1, '重新打开又选一次，不该产生重复附件');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 7：搜索与分页 ——
it('FIX-16 搜索与分页可用：测试通过 = 搜索进查询条件，翻页换页码', async () => {
  const t = mount({rows: [{file_name: 'a.xlsx'}], total: 60});
  try {
    const dlg = await openDialog(t);
    const search = dlg.querySelector('[data-attachment-search]');
    search.value = '台账';
    search.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await new Promise(r => setTimeout(r, 260));
    const listRequest = t.requests.filter(r => r.url.includes('/datasets/files.file/records')).pop();
    const filters = JSON.parse(new URL(listRequest.url, 'http://x').searchParams.get('filters') || '{}');
    assert.equal(filters.q, '台账', '搜索词没进查询条件');

    const next = dlg.querySelector('[data-pick-next]');
    assert.equal(next.disabled, false, '还有下一页时不该禁用');
    next.click();
    await tick();
    const paged = t.requests.filter(r => r.url.includes('/datasets/files.file/records')).pop();
    assert.equal(new URL(paged.url, 'http://x').searchParams.get('page'), '2', '翻页没换页码');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 8：附件控件**看得出是按钮**，且不被正文编辑器压到折叠线以下 ——
// 用户原话（实测）：「点『选择附件』没反应」—— 真因是附件区排在长正文编辑器**下面**，
// 首屏根本看不到（连 hover 都命中不了），而按钮本身又被样式成透明无框的文字块。
// 测试通过 = 附件按钮有边框/底色/pointer（不是伪装成文字）；写信窗里附件区排在正文之前。
it('FIX-16 附件控件是按钮且不被正文压到折叠线以下：测试通过 = 有边框底色与 pointer，附件区排在正文之前', () => {
  const css = readFileSync(new URL('../../../shangshu-web/css/file-reference-picker.css', import.meta.url), 'utf8');
  const rule = css.split('\n').find(line => line.includes('[data-attachment-value]')) || '';
  assert.ok(rule, '找不到附件按钮的样式');
  assert.match(rule, /cursor\s*:\s*pointer/, '附件按钮的鼠标指针不是 pointer（看起来像一段普通文字）');
  assert.doesNotMatch(rule, /border\s*:\s*0\b/, '附件按钮没有边框（看起来像一段普通文字）');
  assert.doesNotMatch(rule, /background\s*:\s*transparent/, '附件按钮是透明底（看起来像一段普通文字）');

  const mailSource = readFileSync(new URL('../../../shangshu-web/js/mail-center.js', import.meta.url), 'utf8');
  const att = mailSource.indexOf('id="c-attachments"');
  const editor = mailSource.indexOf('id="c-editor-host"');
  assert.ok(att > -1 && editor > -1, '写信窗模板里找不到附件区或正文区');
  assert.ok(att < editor, '附件区排在正文编辑器之后 → 被长编辑器压到折叠线以下，用户看不到也点不到');
});

// —— FIX-16 判据 9：弹窗打不开必须告诉用户，不能静默无反应 ——
// 测试通过 = 公共弹窗件不可用时给出提示（原来直接 return，用户只看到"点了没反应"）。
it('FIX-16 选择弹窗打不开时必须提示：测试通过 = 弹窗件不可用时给出提示，不静默', async () => {
  const t = mount({withoutDialog: true});
  try {
    t.node.querySelector('[data-attachment-value]').click();
    await tick();
    assert.equal(t.notices.length, 1, '弹窗打不开却一声不吭（用户看到的就是"点了没反应"）');
    assert.match(t.notices[0], /附件|文件/, '提示要说清是附件/文件选择不可用');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 10：一次操作只弹一个选择窗 ——
// 测试通过 = 连点/双击不会叠出两层弹窗（第二层会把第一层顶成 inert，看起来像"没反应"）。
it('FIX-16 一次操作只弹一个选择窗：测试通过 = 重复触发不会叠出多层弹窗', async () => {
  const t = mount();
  try {
    const btn = t.node.querySelector('[data-attachment-value]') as any;
    btn.dispatchEvent(new t.w.MouseEvent('click', {bubbles: true}));
    btn.dispatchEvent(new t.w.MouseEvent('dblclick', {bubbles: true}));
    await tick();
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 1, '一次操作叠出了多个选择弹窗');
  } finally { t.dispose(); }
});

// —— FIX-16 判据 11：快照走**动作口**（服务口没注册，实测 404「领域服务不存在」）——
// 活站实测（3870）：写信窗里点 Excel 表那一行 → 行下红字「取表格快照失败：领域服务不存在」。
// 真因：`files.sheet_snapshot` 在文件域里只注册成**动作**（shangshu_files.service.execute），
// 领域**服务**清单里没有它 → 走 /services/.../invoke 必然 404。
// 测试通过 = 快照请求打在 /api/platform/actions/files.sheet_snapshot/execute 上，
// 且带 confirmed、幂等键、source=user；payload 带 table 与 op_id。
it('FIX-16 表格快照走动作口：测试通过 = 打在 actions/.../execute，带 confirmed 与幂等键，不走未注册的服务口', async () => {
  const t = mount();
  try {
    const dlg = await openDialog(t);
    dlg.querySelectorAll('[data-pick-file]')[0].click();   // 季度台账.xlsx（Excel 表格）
    await tick();
    const snap = t.requests.find(r => r.url.includes('files.sheet_snapshot'));
    assert.ok(snap, '没发出取快照请求');
    assert.match(snap.url, /\/api\/platform\/actions\/files\.sheet_snapshot\/execute$/,
      '快照要打动作口：服务口没注册，走 /services/.../invoke 必然 404「领域服务不存在」');
    assert.equal(snap.body.confirmed, true, '动作要带 confirmed');
    assert.ok(snap.body.idempotency_key, '动作要带幂等键');
    assert.equal(snap.body.source, 'user', '动作要标明来源是用户操作');
    assert.equal(snap.body.payload.table, '季度台账.xlsx', '动作要带表身份');
    assert.ok(snap.body.payload.op_id, '动作要带操作编号（重放不重复建快照）');
  } finally { t.dispose(); }
});
