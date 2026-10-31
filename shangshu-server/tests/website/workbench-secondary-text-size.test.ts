import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

/*
  工作台首页的**小字**要看得清（FIX-35）—— 2026-10-20 全站对比度扫描实况：

  全站七个页面都量了一遍「小于 10px 的可见文字」，结果**只有工作台首页有**（17 处），
  其它六个页面（邮件 / 文件中心 / 全部数据 / Excel 表格 / 消息 / 待办）一处都没有。

  工作台这 17 处是**真缺陷**，不是「够不着的样式」：
    · 「需要我办理的流程」「查看流程进度」「分配给我的协作任务」—— 8.5px（流程待办三张卡的说明）
    · 「业务应用」「从票据识别、费用报销到过账付款，在一个应用内完成」—— 8.5px（应用名与说明）
    · 「进入」—— 8.5px（每个应用卡片的入口按钮标签）
    · 「财务」—— 9px（业务应用分类名）
    · 「反馈进度和验收结果」「与同事继续沟通」—— 9px（协作区的两张卡说明）
    · 「需要当前角色审批、过账或付款」「已核对并确认字段」—— 9.5px（应用卡片的说明）

  8.5px 的中文字在真实屏幕上**已经糊了**——这不是「小一点没关系」的装饰字号，
  它是用户读流程待办、认应用、理解卡片含义的唯一文字。
  （FIX-32 已经把侧栏分组标记从 10px 提到 11px，理由相同。）

  修法：只动**工作台首页真实渲染**的那几条公共规则，把字号收到 **11px** 下限。
  落点收敛在 `platform.css` 的六条规则里 —— 不逐个页面改，改公共规则。

  为什么不一次性把 `platform.css` 里 90 多条 8～9.5px 全收：
  那些多数在**这个账号状态下够不着**（流程设计器、应用配置向导等），
  活站量不到就说明用户此刻看不见 —— 按既定口径「够不着的只记不改」，
  等它们真的出现在用户眼前时再单独处理。**不拿「看着小」当缺陷。**

  测试通过 = 下面全部成立：
  1. 工作台首页**渲染出来的**次要说明文字（说明/分类/入口标签）字号 **≥ 11px**
  2. **护栏**：正文与标题字号不许被这次改动碰到（`.platform-kpi>b` 12px、`.platform-kpi>strong` 23px 不许变）
  3. **护栏**：`.workbench-status b`（22px 的大数字）不许被这次改动碰到
  4. **护栏**：颜色不许变 —— 本批只动字号
*/

const CSS_DIR = new URL('../../../shangshu-web/css/', import.meta.url);
const CSS_FILES = readdirSync(CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => [name, readFileSync(new URL(name, CSS_DIR), 'utf8')] as const);

/* 取某个文件里、某个选择器的声明（按出现次序，后者覆盖后者）
   注意：选择器可能是逗号组合（如 `.workbench-app-list small,.workbench-recent-list small`），
   要按逗号切分后逐个比对 —— 整串相等才算就找不到组合选择器里的那一条 */
function declsOf(file: string, selector: string): Record<string, string> {
  const css = CSS_FILES.find(([name]) => name === file)?.[1] ?? '';
  const out: Record<string, string> = {};
  const wanted = selector.split(',').map((s) => s.trim());
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, '')))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel.split(',').some((s) => wanted.includes(s.trim()))) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

const sizeOf = (rule: Record<string, string>, sel: string) =>
  parseFloat((rule['font-size'] || '').replace('px', '')) || 0;

/* 工作台首页真实渲染出小字的那些规则（活站 2026-10-20 实测） */
const CASES: [string, string, string][] = [
  ['platform.css', '.workbench-status small', '流程待办卡的说明（「需要我办理的流程」）'],
  ['platform.css', '.workbench-app-list small,.workbench-recent-list small', '应用名/应用说明'],
  ['platform.css', '.workbench-app-list i,.workbench-recent-list i', '应用卡片的「进入」标签'],
  ['platform.css', '.platform-kpi-domain', '业务应用分类名（「财务」）'],
  ['platform.css', '.platform-kpi>p', '应用卡片的说明'],
  ['platform.css', '.platform-quick small', '协作区卡片的说明'],
];

it('工作台首页的次要说明文字字号 ≥ 11px：8.5px 的中文在真实屏幕上已经糊了', () => {
  for (const [file, sel, what] of CASES) {
    const rule = declsOf(file, sel);
    const size = sizeOf(rule, sel);
    assert.ok(size >= 11,
      `${what}（${sel}）的字号是 ${size || '（没写死）'}px —— 至少 11px，`
      + `这是用户读懂流程待办、认应用、知道卡片是什么的唯一文字`);
  }
});

it('护栏：正文与标题的字号不许被这次改动碰到', () => {
  const kpiB = declsOf('platform.css', '.platform-kpi>b');
  assert.equal(sizeOf(kpiB, '.platform-kpi>b'), 12, `.platform-kpi>b（应用名）的字号被改了`);

  const strong = declsOf('platform.css', '.platform-kpi>strong');
  assert.equal(sizeOf(strong, '.platform-kpi>strong'), 23, '.platform-kpi>strong（数字）的字号被改了');

  const kpi = declsOf('platform.css', '.platform-kpi');
  assert.ok(!kpi['font-size'], '.platform-kpi 本体不该有字号改动');
});

it('护栏：流程待办卡的大数字不许被这次改动碰到', () => {
  const b = declsOf('platform.css', '.workbench-status b');
  assert.equal(sizeOf(b, '.workbench-status b'), 22, '.workbench-status b（待办数量）的字号被改了');
  const span = declsOf('platform.css', '.workbench-status span');
  assert.equal(sizeOf(span, '.workbench-status span'), 10.5, '.workbench-status span 的字号被改了');
});

it('护栏：本批只动字号，颜色不许变', () => {
  /* 这些规则本来就有颜色（`color:var(--fg3)`）—— 护栏钉的是「颜色不许被这次改动动过」，
     不是「不许有颜色」 */
  const EXPECTED: [string, string][] = [
    ['.workbench-status small', 'var(--fg3)'],
    ['.workbench-app-list small,.workbench-recent-list small', 'var(--fg3)'],
    ['.workbench-app-list i,.workbench-recent-list i', 'var(--fg3)'],
    ['.platform-kpi-domain', 'var(--fg3)'],
    ['.platform-kpi>p', 'var(--fg3)'],
    ['.platform-quick small', 'var(--fg3)'],
  ];
  for (const [sel, want] of EXPECTED) {
    const rule = declsOf('platform.css', sel);
    assert.equal((rule['color'] || '').replace(/\s+/g, ''), want.replace(/\s+/g, ''),
      `${sel} 的颜色被改了 —— 本批只动字号`);
  }
});
