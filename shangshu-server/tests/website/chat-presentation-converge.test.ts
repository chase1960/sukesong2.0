import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8');

function mountTools() {
  const dom = new JSDOM('<main></main>', {runScripts: 'outside-only'}), w = dom.window as any;
  w.esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c: string) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  w.chatScrollBottom = () => {};
  // 合并补注（2026-10-21）：fast 那条线给 `chatAddToolCard` 加了「本轮执行记录」，
  // 里面要读**平台工具目录** `PLATFORM_CHAT_TOOLS`（真实值由服务端带回、挂在 window 上）。
  // 这个符号声明在 real-chat.js 第 2133 行 —— **在「工具卡 → 确认卡」那段切片之外**
  // ⇒ 切进来的代码一跑就 ReferenceError，工具卡**根本生成不出来**（实测 2 条红）。
  // 补上窗口全局：判据只关心卡片长相，不需要真实目录，空表即可。
  w.PLATFORM_CHAT_TOOLS = [];
  w.eval(source.slice(source.indexOf('/* —— 工具卡'), source.indexOf('/* —— 确认卡')));
  const body = w.document.querySelector('main');
  return {w, body, close: () => w.close()};
}

// —— CHAT-NEXT-03：默认界面不外露内部工具名 ——
// 测试通过 = 什么成立：无论工具名**在不在已注册表里**，卡片默认标题都是一句人能懂的动作；
// **原始标识一个字符都不出现在默认态**；原始名只允许出现在「按需展开的详情」里。
it('CHAT-NEXT-03 默认标题不外露内部工具名（已注册与未知名称回退都不外露）', () => {
  const {w, body, close} = mountTools();
  try {
    w.chatAddToolCard(body, {name: 'platform_platform_object_query', arg: '{}', result: '{"ok":true}'});
    const card = body.querySelector('.tool')!;
    const header = card.querySelector('button')!;
    assert.doesNotMatch(header.textContent!, /platform_platform_object_query/,
      '已注册工具：默认标题不得出现原始标识');
    assert.match(header.textContent!, /查询/, '默认标题要说人话（查询…）');

    // 未知名称回退：同样不得把原始标识印在默认态
    const dom2 = new JSDOM('<main></main>', {runScripts: 'outside-only'}), w2 = dom2.window as any;
    w2.esc = (v: any) => String(v ?? '');
    w2.chatScrollBottom = () => {};
    w2.PLATFORM_CHAT_TOOLS = [];
    w2.eval(source.slice(source.indexOf('/* —— 工具卡'), source.indexOf('/* —— 确认卡')));
    const body2 = w2.document.querySelector('main');
    w2.chatAddToolCard(body2, {name: 'platform_internal_thing_v2', arg: '{}', result: '{"ok":true}'});
    const header2 = body2.querySelector('.tool button')!;
    assert.doesNotMatch(header2.textContent!, /platform_internal_thing_v2/,
      '未知名称回退：默认标题也不得出现原始标识');
    assert.ok(header2.textContent!.trim().length > 0, '未知名称也要给一句人能懂的标题');
    dom2.window.close();

    // 展开详情里**允许**出现原始名（技术标识只在按需展开处）
    header.click();
    const expanded = card.querySelector('.tool-bd')!.textContent!;
    assert.match(expanded, /platform_platform_object_query/,
      '展开详情里应当仍能查到技术标识与参数');
  } finally { close(); }
});

// —— CHAT-NEXT-02：连续只读调用默认折叠为一条「查询过程」 ——
// 测试通过 = 什么成立：连续 7 次读取在**默认态**只占一条紧凑入口（不 7 张大卡）；
// 展开后**每次调用与失败**都查得到；日志仍逐次保留（7 条调用都在详情里）。
it('CHAT-NEXT-02 连续只读调用默认只留一条「查询过程」入口，展开能逐次查（含失败）', () => {
  const {w, body, close} = mountTools();
  try {
    for (let i = 0; i < 7; i++) {
      const failed = i === 3;
      w.chatAddToolCard(body, {
        name: failed ? 'platform_resource_read' : 'platform_platform_object_query',
        arg: JSON.stringify({i}),
        result: failed ? '{"ok":false,"error":"读取失败"}' : JSON.stringify({ok: true, i}),
      });
    }
    // 默认态：只读调用不该铺成 7 张卡
    const cards = body.querySelectorAll('.tool');
    assert.equal(cards.length, 1, `连续只读调用应折叠成一条入口，实际 ${cards.length} 条`);
    const header = cards[0].querySelector('button')!;
    assert.match(header.textContent!, /查询过程/, '默认入口文案应是「查询过程」');
    assert.match(header.textContent!, /7/, '默认入口要说明发生了几次');
    assert.equal(cards[0].querySelector('.tool-bd')!.hasAttribute('hidden'), true,
      '默认态详情应收起');
    // 展开后：每次调用与失败都查得到（逐次保留，不合并审计事实）
    header.click();
    const detail = cards[0].querySelector('.tool-bd')!.textContent!;
    assert.match(detail, /读取失败/, '展开后要能看到那一次失败');
    const callCount = cards[0].querySelectorAll('.tool-call').length;
    assert.equal(callCount, 7, `展开后应保留 7 次调用，实际 ${callCount}`);
    // 写类工具**不**被折叠进去
    w.chatAddToolCard(body, {name: 'platform_files_sheet_cells_write', arg: '{}', result: '{"ok":true}'});
    assert.equal(body.querySelectorAll('.tool').length, 2,
      '写操作不能混进「查询过程」，要单独成条');
  } finally { close(); }
});

// —— CHAT-NEXT-01：黄色执行状态汇总块不再生成 ——
// 测试通过 = 什么成立：源码里不再存在那块黄色汇总卡（类名/标题/「本轮实际查询」串都没有），
// 所以待确认、成功、失败、历史恢复四种场景**都不可能**再出现它。
it('CHAT-NEXT-01 黄色执行状态汇总块整体移除（不再有那张卡、也不再有「本轮实际查询」串）', () => {
  assert.doesNotMatch(source, /chat-turn-status/, '不得再生成执行状态汇总块');
  assert.doesNotMatch(source, /执行状态/, '不得再出现「执行状态」块');
  assert.doesNotMatch(source, /本轮实际查询/, '不得再把内部查询工具名串印给用户');
});

// —— CHAT-NEXT-07：确认卡不再有「查看并审核」按钮 ——
// 测试通过 = 什么成立：确认卡里没有「查看并审核」这个按钮；
// 但**已确认后的定位入口「查看目标位置」保留**，原位确认能力不受影响。
it('CHAT-NEXT-07 确认卡不再显示「查看并审核」，但已确认后的定位入口保留', () => {
  assert.doesNotMatch(source, /查看并审核/, '不得再出现「查看并审核」按钮');
  assert.match(source, /查看目标位置/, '已确认后的定位入口必须保留');
  assert.match(source, /'确认'|已确认/, '原位人工确认能力不受影响');
});
