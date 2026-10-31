import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 胶囊式多值输入（公共组件 chip-input）—— 用户 2026-10-10 提出：
 「请把邮件部分的抄送和主送『；』操作搞得直观一点，可以用胶囊形式……
   就是用加号代表增加一个人，删除的逻辑你自己思考，如何要溢出截断，记得把这个升级成公共组件。」

 测试通过 = 下面全部成立：
 1. 给定初值 N 个收件人，渲染出 N 枚胶囊，每枚显示一个收件人、带 × 可删。
 2. 加人两条路都通：输入框里打字回车；输入框里有字时点「+」按钮。
 3. 删除两条路都通：点某枚胶囊的 × 删那一枚；输入框为空时按退格删最后一枚。
 4. 溢出截断两条：单个胶囊名字太长省略号截断且 title 留全文；
    超过显示上限时末尾出「+N」汇总，点开展开全部、再点收起。
 5. getValues 与 onChange 拿到同一份收件人列表，顺序不乱。
*/

const tick = () => new Promise(r => setTimeout(r, 10));

/* 组件跑在 JSDOM 的 realm 里，它返回的数组是那个 realm 的 Array 实例，
   和测试 realm 的 Array.prototype 不是同一个 —— deepStrictEqual 会因原型不同判不等
   （报错原话「Values have same structure but are not reference-equal」）。
   真实浏览器只有一个 realm，不存在这问题；比对前先落到本 realm。 */
const local = (v: any): string[] => Array.from(v as Iterable<string>, s => String(s));

function mount(values: string[] = [], extra: any = {}) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(new URL('../../../shangshu-web/js/chip-input.js', import.meta.url), 'utf8'));
  const host = w.document.querySelector('#host');
  let changedTo: string[] | null = null;
  const api = w.mountChipInput(host, {
    values: [...values],
    placeholder: '输入后回车添加',
    onChange: (v: string[]) => { changedTo = v; },
    ...extra,
  });
  return {
    w,
    api,
    changedTo: () => changedTo,
    chips: () => [...host.querySelectorAll('[data-chip]')],
    field: () => host.querySelector('input'),
    addBtn: () => host.querySelector('[data-chip-add]'),
    more: () => host.querySelector('[data-chip-more]'),
    dispose: () => dom.window.close(),
  };
}

it('给定初值渲染出 N 枚胶囊，每枚带可删的 ×', async () => {
  const t = mount(['张三 <a@x.com>', '李四 <b@x.com>', 'c@x.com']);
  try {
    const chips = t.chips();
    assert.equal(chips.length, 3, '胶囊数量和初值对不上');
    for (const chip of chips) {
      assert.ok(chip.querySelector('[data-chip-remove]'), '胶囊缺删除按钮');
    }
    assert.match(chips[0].textContent, /张三/, '第一枚胶囊没显示收件人');
  } finally { t.dispose(); }
});

it('点「+」开一个填写位，回车收成一枚胶囊；要加第二个人就再点「+」', async () => {
  const t = mount([]);
  try {
    const host = t.w.document.querySelector('.chip-input');

    // 点 + → 开填写位 → 打字回车 → 一枚胶囊
    t.addBtn().click();
    await tick();
    const field = () => host.querySelector('input');
    assert.ok(field(), '点加号没开填写位');
    field().value = '王五 <w@x.com>';
    field().dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 1, '回车没把填写位收成胶囊');
    assert.match(t.chips()[0].textContent, /王五/);
    assert.equal(host.querySelectorAll('input').length, 0, '收成胶囊后填写位该收回');

    // 再点 + → 第二枚
    t.addBtn().click();
    await tick();
    host.querySelector('input').value = '赵六 <z@x.com>';
    host.querySelector('input').dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 2, '再点加号没加第二个人');
    assert.match(t.chips()[1].textContent, /赵六/);
    assert.deepEqual(local(t.api.getValues()), ['王五 <w@x.com>', '赵六 <z@x.com>'], '收件人列表不对');
  } finally { t.dispose(); }
});

it('删除两条路：点 × 删那一枚；空填写位退格删最后一枚', async () => {
  const t = mount(['a@x.com', 'b@x.com', 'c@x.com']);
  try {
    // 点第 2 枚的 ×
    t.chips()[1].querySelector('[data-chip-remove]').click();
    await tick();
    assert.equal(t.chips().length, 2, '点 × 没删掉');
    assert.deepEqual(local(t.api.getValues()), ['a@x.com', 'c@x.com'], '删错对象了');

    // 开填写位，空着按退格 → 删最后一枚
    t.addBtn().click();
    await tick();
    const field = () => t.w.document.querySelector('.chip-input input');
    assert.equal(String(field().value || ''), '', '前置：填写位应为空');
    field().dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Backspace', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 1, '空填写位退格没删最后一枚');
    assert.deepEqual(local(t.api.getValues()), ['a@x.com'], '退格删错对象了');

    // 填写位有字时退格不该删人
    t.addBtn().click();
    await tick();
    field().value = '正在打的字';
    field().dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Backspace', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 1, '填写位有字时退格不该删人');
  } finally { t.dispose(); }
});

it('溢出截断：名字太长省略号且 title 留全文', async () => {
  const long = '这是一个特别特别特别长的收件人姓名真的非常长超出了胶囊宽度 <very-long-address@example.com>';
  const t = mount([long, '短名 <s@x.com>']);
  try {
    const chip = t.chips()[0];
    assert.equal(chip.getAttribute('title'), long, 'title 没留全文，鼠标悬停看不到完整收件人');
    assert.ok(chip.querySelector('[data-chip-text]'), '缺文字容器');
    // 截断靠样式（max-width + ellipsis），这里钉住样式确实挂上了
    const text = chip.querySelector('[data-chip-text]');
    const cls = text.className || '';
    assert.match(cls, /chip-input-text/, '文字容器没挂截断样式类');
  } finally { t.dispose(); }
});

it('溢出截断：超过显示上限末尾出「+N」，点开展开、再点收起', async () => {
  const t = mount(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'], {visibleLimit: 3});
  try {
    // 收起态：只显示 3 枚 + 「+2」
    assert.equal(t.chips().length, 3, `收起态应只显示 3 枚，实际 ${t.chips().length}`);
    const more = t.more();
    assert.ok(more, '超出显示上限没出「+N」汇总');
    assert.match(more.textContent, /\+2/, '「+N」数目不对');

    // 点开展开全部
    more.click();
    await tick();
    assert.equal(t.chips().length, 5, '点「+N」没展开全部');
    assert.ok(t.more(), '展开后缺「收起」，再也收不回去');
    assert.match(t.more().textContent, /收起/, '展开后按钮文案应变成「收起」');

    // 再点收起
    t.more().click();
    await tick();
    assert.equal(t.chips().length, 3, '再点没收回');
    assert.match(t.more().textContent, /\+2/, '收回后该变回「+N」');

    // 收起时删一枚，「+N」要跟着变
    t.chips()[0].querySelector('[data-chip-remove]').click();
    await tick();
    assert.equal(t.chips().length, 3, '收起态删一枚后应补上第 4 枚');
    assert.match(t.more().textContent, /\+1/, '收起态删人后「+N」没跟着减');
  } finally { t.dispose(); }
});

it('getValues 与 onChange 拿到同一份列表，顺序不乱', async () => {
  const t = mount(['第一 <1@x.com>', '第二 <2@x.com>']);
  try {
    t.addBtn().click();
    await tick();
    const field = t.w.document.querySelector('.chip-input input');
    field.value = '第三 <3@x.com>';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.deepEqual(local(t.api.getValues()), ['第一 <1@x.com>', '第二 <2@x.com>', '第三 <3@x.com>'], 'getValues 顺序或内容不对');
    assert.deepEqual(local(t.changedTo()), local(t.api.getValues()), 'onChange 与 getValues 不一致');
  } finally { t.dispose(); }
});

it('不重复加同一个人（按邮箱比，不按整串比）', async () => {
  const t = mount(['张三 <a@x.com>']);
  try {
    t.addBtn().click();
    await tick();
    const field = t.w.document.querySelector('.chip-input input');
    // 打的是裸邮箱，和已有的「张三 <a@x.com>」是同一个人
    field.value = 'a@x.com';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 1, '同一个人被加了两次');
  } finally { t.dispose(); }
});

/* 用户实测反馈（2026-10-11）：
   「表现的很奇怪，我建议是这样，加号跟在『已填写的胶囊右边』，点击加号就在加号左边多一个胶囊
   （只能填一个，如果多的话就再点加号)，要识别其中的邮箱就行……就是一个胶囊一个邮箱」
   所以交互改成：+ 号固定在末尾，点一下开一个**单人**输入位，填一个变一枚胶囊。 */
it('加号跟在已填胶囊右边，点一下在 + 左边开一个单人输入位', async () => {
  const t = mount(['a@x.com', 'b@x.com']);
  try {
    const add = t.addBtn();
    assert.ok(add, '缺加号按钮');
    /* + 号必须排在所有胶囊**之后** —— 按 DOM 顺序数，不看是不是同一层直接子节点。 */
    const host = t.w.document.querySelector('.chip-input');
    const ordered = [...host.querySelectorAll('[data-chip], [data-chip-add]')];
    const lastChipIndex = ordered.reduce((m: number, k: any, i: number) => (k.hasAttribute('data-chip') ? i : m), -1);
    const addIndex = ordered.findIndex((k: any) => k.hasAttribute('data-chip-add'));
    assert.ok(lastChipIndex >= 0, '一个胶囊都没渲染出来，谈不上「跟在胶囊右边」');
    assert.ok(addIndex > lastChipIndex, `加号应排在胶囊右边，实际在第 ${addIndex} 位，胶囊末位 ${lastChipIndex}`);

    // 点 + 之前不该有输入框占着
    assert.equal(host.querySelectorAll('input').length, 0, '没点加号就该没有输入位');

    add.click();
    await tick();
    assert.equal(host.querySelectorAll('input').length, 1, '点加号没开出输入位');
  } finally { t.dispose(); }
});

it('一次只填一个人：填一个变一枚胶囊，输入位收回；多填只认一个邮箱', async () => {
  const t = mount([]);
  try {
    const host = t.w.document.querySelector('.chip-input');
    const add = t.addBtn();

    // 点 + 开一个输入位
    add.click();
    await tick();
    const field = () => host.querySelector('input');
    assert.ok(field(), '点加号没出输入位');

    // 填一个人
    field().value = '王五 <w@x.com>';
    field().dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 1, '填一个该变一枚胶囊');
    assert.equal(host.querySelectorAll('input').length, 0, '填完输入位该收回（要更多再点加号）');
    assert.deepEqual(local(t.api.getValues()), ['王五 <w@x.com>']);

    // 再点 + 加第二个
    add.click();
    await tick();
    host.querySelector('input').value = '李四 <l@x.com>';
    host.querySelector('input').dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 2, '第二次点加号该加第二枚');

    // 一次填多个 → 只认一个邮箱
    add.click();
    await tick();
    host.querySelector('input').value = '甲 <a1@x.com>；乙 <b1@x.com>；c1@x.com';
    host.querySelector('input').dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 3, `一次只该加一枚，实际 ${t.chips().length}`);
    const values = local(t.api.getValues());
    assert.equal(values.length, 3, '一次填多个只该认一个邮箱');
    assert.match(values[2], /a1@x\.com/, '多填时应识别出其中的邮箱');
  } finally { t.dispose(); }
});

it('一个胶囊只装一个邮箱：一串里多个人也只认第一个，要多的再点加号', async () => {
  const t = mount([]);
  try {
    const host = t.w.document.querySelector('.chip-input');
    t.addBtn().click();
    await tick();
    const field = host.querySelector('input');
    // 用户：「只能填一个，如果多的话就再点加号……就是一个胶囊一个邮箱」
    field.value = '张三 <z@x.com> 李四 <l@x.com>';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    const values = local(t.api.getValues());
    assert.equal(values.length, 1, `一次只该认一个人，实际认出 ${values.length} 个：${JSON.stringify(values)}`);
    assert.match(values[0], /z@x\.com/, `该认出第一个邮箱，实际「${values[0]}」`);
    assert.ok(!/l@x\.com/.test(values[0]), `一枚胶囊里塞了两个人：${values[0]}`);

    /* 第二个人：不许被吞掉（2026-10-13 用户批注 3-1「只看到李四」就是它被吞了）。
       剩下的留在填写位里，再按一次回车就进 —— 比让人回过头去点加号再打一遍强。 */
    const leftover = String(host.querySelector('input')?.value || '');
    assert.ok(/l@x\.com/.test(leftover),
        `第二个人不见了（填写位里只剩「${leftover}」）—— 静默丢人`);
    host.querySelector('input').dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    assert.equal(t.chips().length, 2, '再按一次回车该进第二枚');
  } finally { t.dispose(); }
});

/* ---- 用户 2026-10-13 批注 3-1 提出的三条 ----
 原话：「只看到李四，但是没看到后面的邮件名，我建议这里直接做一个这样的操作：
        只认 1@11.com 和 李四 <1@21.com>，一个对话框只能输入一个，
        如果有成型的邮件号就把前面的文字也显示出来」

 查实（不是猜）：
 · 「只看到李四」= extractOne 的正则 `[^<>]+` 跨不过 `<`，匹配不上「张三 <zhang@a.com,
   李四 <li@b.com>」这一整段，于是跳到后面的「李四 <li@b.com>」才匹配上 ——
   前面的 a@b.com **被静默丢掉**，一声不吭。
 · 「没看到后面的邮件名」= displayName(「李四 <li@b.com>」) 只返回「李四」，
   地址只写在 title 里，要鼠标悬停才看得到。*/

it('G 胶囊上名字和地址都看得见 —— 地址不许只藏在悬停提示里', async () => {
  const t = mount(['李四 <li@x.com>', 'a@x.com']);
  try {
    const [named, bare] = t.chips();
    const namedText = String(named.querySelector('[data-chip-text]')?.textContent || '');
    assert.match(namedText, /李四/, `名字没显示：${JSON.stringify(namedText)}`);
    assert.match(namedText, /li@x\.com/,
        `地址没显示，只在悬停提示里 —— 用户「没看到后面的邮件名」：${JSON.stringify(namedText)}`);
    const bareText = String(bare.querySelector('[data-chip-text]')?.textContent || '');
    assert.match(bareText, /a@x\.com/, `裸地址该原样显示：${JSON.stringify(bareText)}`);
  } finally { t.dispose(); }
});

it('H 打进去一串多人的字：一次只收一个，剩下的留在填写位里，不许静默丢掉', async () => {
  const t = mount([]);
  try {
    t.addBtn().click();
    await tick();
    const field = t.field() as any;
    field.value = 'a@x.com, 张三 <z@x.com>, 李四 <l@x.com>';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();

    const values = local(t.api.getValues());
    assert.equal(values.length, 1, `一次只该收一个，实际收了 ${values.length}：${JSON.stringify(values)}`);
    assert.match(values[0], /a@x\.com/,
        `该按顺序收第一个，实际收了「${values[0]}」—— 旧实现跳过前面的只认最后一个`);

    /* 关键：剩下的人不许消失。旧实现把它们一声不吭吞了，
       用户只看到一枚胶囊，另外两个人去哪了没人知道。 */
    const rest = String((t.field() as any)?.value || '');
    assert.ok(rest.includes('z@x.com') && rest.includes('l@x.com'),
        `剩下的两个人不见了（填写位里只剩「${rest}」）—— 静默丢人`);
  } finally { t.dispose(); }
});

it('I 一串里有个坏的：坏的单独提示，好的照收，不连累别人', async () => {
  const rejected: string[] = [];
  const t = mount([], {onReject: (s: string) => rejected.push(String(s))});
  try {
    t.addBtn().click();
    await tick();
    const field = t.field() as any;
    // 用户原串：中间那个故意少写一个「>」
    field.value = 'a@x.com, 张三 <z@x.com, 李四 <l@x.com>';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();
    // 再按一次，收下一个人（顺带把坏的那个报掉）
    (t.field() as any).dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();

    const values = local(t.api.getValues());
    assert.equal(values.length, 2,
        `好的两个都该收进去，实际 ${values.length} 个：${JSON.stringify(values)}`);
    assert.ok(values.some(v => /a@x\.com/.test(v)), `a@x.com 没进去：${JSON.stringify(values)}`);
    assert.ok(values.some(v => /l@x\.com/.test(v)), `李四 没进去：${JSON.stringify(values)}`);
    assert.ok(rejected.length, '坏的那个一声不吭就没了，该提示有问题');
    assert.ok(rejected.some(s => /z@x\.com/.test(s)),
        `提示里该点名那个坏地址：${JSON.stringify(rejected)}`);
  } finally { t.dispose(); }
});

it('J 少一个「>」的不许悄悄降成裸地址 —— 名字丢了也不吭声就是骗人', async () => {
  const rejected: string[] = [];
  const t = mount([], {onReject: (s: string) => rejected.push(String(s))});
  try {
    t.addBtn().click();
    await tick();
    const field = t.field() as any;
    field.value = '张三 <z@x.com';
    field.dispatchEvent(new t.w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    await tick();

    const values = local(t.api.getValues());
    assert.equal(values.length, 0,
        `缺「>」的该报认不出，实际收成了 ${JSON.stringify(values)} —— 名字被悄悄吞掉`);
    assert.ok(rejected.length, '没提示有问题');
  } finally { t.dispose(); }
});
