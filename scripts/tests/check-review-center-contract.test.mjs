import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * 「**审核中心是平台的一道闸门，独立的公共能力**」（用户 2026-10-22 18:15 原话：
 * 「审核中心他不应该归属于知识产权域……他是一道判断闸门，以来的 uc 都会用到它」）。
 *
 * 为什么要有这份判据：文档里的要求**不等于已实现**（`fde/设计/契约/用例清单.md` §8 与
 * `fde/开发/计划/执行计划.md` 顶部是**设计说明**）—— 所以要有一份**成文的内核契约**把口径钉住，
 * 判据断的是**契约本身**（存在 ＋ 内容写对了），再由实现批次的判据断**行为**。
 *
 * 本判据断的是内核契约文件 `contracts/review-center-v1.json`。
 *
 * 测试通过 = 下面全部成立：
 *  1. 契约存在且 JSON 合法；
 *  2. **归属**：页面 owner ＝ 核心域、页面 id 不带域前缀、静态注册、侧栏「工作」组；
 *     域只注册声明与来源、**不许注册页面本体**；
 *  3. **准入规则**：三档（凭据对照型进／就地可判型给指路／上游结果型不进）＋ 默认按 kind ＋ 域可显式改；
 *  4. **十类核心声明**都在（缺一类就有一类业务判断没地方放，内核就得猜）；
 *  5. **两栏槽位**：一套渲染器两个槽位 ＋ 格式表 ＋ **定位必填** ＋ 凭据走文件中心受管引用；
 *  6. **交互**：凭据级卡片 ＋ 左右分栏大弹窗 ＋ 呼吸/单击采用/双击编辑/显式保存 ＋ 无差异不展示；
 *  7. **保存策略**：不允许部分保存时**必须写清整组范围** ＋ 前后端共同执行 ＋ 视图不改变提交集合；
 *     允许部分保存时写清最小独立单元；
 *  8. **公共规则不许各业务覆盖** ＋ 声明注册时校验（不许空白降级）；
 *  9. **责任边界**四行（内核／既有能力／域／FDE）；
 * 10. **验收清单**在（每条都要有实跑证据，文档不算证据）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_PATH = path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core/contracts/review-center-v1.json');
const PAGE_REGISTRY_PATH = path.join(ROOT, 'shangshu-web/js/page-registry.js');
const SHELL_PATH = path.join(ROOT, 'shangshu-web/js/review-center.js');

const readContract = () => JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

it('① 内核契约文件存在且 JSON 合法', () => {
  assert.ok(fs.existsSync(CONTRACT_PATH), `内核契约不存在：${CONTRACT_PATH}`);
  const contract = readContract();
  assert.equal(contract.contract, 'review-center-v1', '契约 id 不对');
});

it('② 归属：页面归核心域 ＋ 静态注册 ＋ 侧栏「工作」组 ＋ 域只挂声明与来源', () => {
  const contract = readContract();
  const own = contract.ownership;
  assert.ok(own, '契约没写归属');
  assert.equal(own.page_owner, 'com.shangshu.core', '审核中心这一页不该归任何业务域');
  assert.equal(own.page_id, 'review-center', '页面 id 不该带域前缀（它是公共页）');
  assert.match(String(own.page_registration), /静态|page-registry/,
    '没说清页面走静态注册表（公共页自己登记）');
  assert.match(JSON.stringify(own.nav), /工作/, '侧栏项没定在「工作」组');
  assert.match(JSON.stringify(own.domain_role), /声明/, '没说域要注册声明');
  assert.match(JSON.stringify(own.domain_role), /来源/, '没说域要挂来源');
  assert.match(JSON.stringify(own.domain_role), /不许注册页面/,
    '没写「域不许注册页面本体」—— 归内核这条就漏了');
  assert.match(String(own.independence), /example/, '没写公共能力对业务域的独立性');
});

it('③ 准入规则：三档 ＋ 默认按 kind ＋ 域可显式改', () => {
  const contract = readContract();
  const adm = contract.admission;
  assert.ok(adm, '契约没写准入规则');
  assert.match(String(adm.rule), /摆到眼前|原件/, '准入规则没写成「必须看到原件才能判断」');
  for (const kind of ['evidence', 'context', 'derived']) {
    assert.ok(adm.kinds && adm.kinds[kind], `准入规则缺 ${kind} 这一档`);
  }
  assert.equal(adm.kinds.evidence.in_page, true, '凭据对照型必须进这一页');
  assert.equal(adm.kinds.context.in_page, false, '就地可判型不进这一页');
  assert.equal(adm.kinds.derived.in_page, false, '上游结果型不进这一页');
  assert.match(JSON.stringify(adm.kinds.context), /跳助手|指路/, '就地可判型没写指路去哪');
  assert.ok(adm.default_by_kind && adm.default_by_kind.assistant === 'context',
    '默认按 kind 映射里，assistant 那一档没落到 context');
  assert.ok(adm.override, '没写「域可以显式改」');
  assert.match(String(adm.never), /来源不决定准入/, '没写「来源不决定准入、也不决定权限」');
});

it('④ 十类核心声明都在（缺一类就有一类业务判断没地方放）', () => {
  const contract = readContract();
  const ten = contract.declaration && contract.declaration.ten;
  assert.ok(ten, '契约没写十类核心声明');
  const expected = [
    '1_identity', '2_left_slot', '3_right_slot', '4_evidence_binding', '5_editable',
    '6_save_policy', '7_precondition', '8_audience', '9_handling', '10_execution',
  ];
  for (const key of expected) {
    assert.ok(ten[key], `十类声明缺 ${key}`);
    assert.ok(ten[key].must_state && ten[key].must_state.length > 0,
      `十类声明 ${key} 没写「必须明确什么」`);
  }
  // 第 6 类是这次最要紧的一条：整组范围
  assert.match(JSON.stringify(ten['6_save_policy']), /整组|一起提交/,
    '第 6 类没写「整组范围」—— 只写『不允许部分保存』是不够的');
  // 第 10 类：结果去向
  assert.match(JSON.stringify(ten['10_execution']), /结果|消费/, '第 10 类没写结果去向');
});

it('⑤ 两栏槽位：一套渲染器两个槽位 ＋ 定位必填 ＋ 凭据走文件中心受管引用', () => {
  const contract = readContract();
  const slots = contract.slots;
  assert.ok(slots, '契约没写两栏槽位');
  assert.match(String(slots.note), /一套渲染器/, '没写「一套渲染器」');
  assert.ok(slots.slot_roles && slots.slot_roles.left && slots.slot_roles.right,
    '没写左右两栏的角色');
  const formats = slots.formats || {};
  for (const key of ['field-table', 'email', 'pdf', 'image', 'text']) {
    assert.ok(formats[key], `格式表缺 ${key}（左右两栏都可能变成任意格式）`);
  }
  assert.match(JSON.stringify(formats.email), /both|左右/, '邮件要能进任意一栏，不该被钉死在一侧');
  assert.match(String(slots.locator_required), /必须/, '右栏凭据的定位提示没定为必填');
  assert.match(String(slots.evidence_source), /文件中心/, '凭据没钉死「走文件中心受管引用」');
  assert.match(String(slots.evidence_source), /版本/, '凭据没写「固定版本」');
});

it('⑥ 交互：凭据级卡片 ＋ 左右分栏大弹窗 ＋ 呼吸/单击/双击/显式保存 ＋ 无差异不展示', () => {
  const contract = readContract();
  const inter = contract.interaction;
  assert.ok(inter, '契约没写交互');
  assert.match(String(inter.card_list), /凭据/, '卡片没定为凭据级（一份凭据一组变更）');
  assert.match(String(inter.open), /左右分栏/, '没写「左右分栏的大弹窗」');
  assert.match(String(inter.adopt), /单击采用/, '没写「单击采用」');
  assert.match(String(inter.adopt), /双击编辑/, '没写「双击编辑」');
  assert.match(String(inter.adopt), /明确保存才入库/, '没写「明确保存才入库」');
  assert.match(String(inter.breathing), /呼吸/, '没写呼吸字体');
  assert.match(String(inter.no_diff_hidden), /无差异不展示/, '没写「无差异不展示」');
  assert.match(String(inter.no_diff_hidden), /未知|失败/, '没写「未知/失败不能当成相同」');
  assert.match(String(inter.footer), /真实|进度/, '底栏没写「真实核对进度与保存结果」');
});

it('⑦ 保存策略：整组范围必填 ＋ 前后端共同执行 ＋ 视图不改变集合', () => {
  const contract = readContract();
  const save = contract.save_policy;
  assert.ok(save, '契约没写保存策略');
  const whole = save.partial_false;
  assert.ok(whole, '没写「不允许部分保存」这一支');
  assert.match(String(whole.rule), /逐项核对/, '没写「可以逐项核对、最后整体提交」');
  assert.match(String(whole.backend), /前后端共同执行|后端/, '没写「前后端共同执行」');
  assert.match(String(whole.scope_unchanged_by_view), /不改变提交集合/,
    '没写「折叠/搜索只改变阅读方式，不改变提交集合」');
  assert.match(String(whole.grouping), /整组/, '没写 example 的整组是什么');
  const part = save.partial_true;
  assert.ok(part, '没写「允许部分保存」这一支');
  assert.match(String(part.rule), /确认所选|只保存/, '没写部分保存的提交形态');
  assert.match(String(part.backend), /unit|逐项/, '没写部分保存的后端只接受选中的 unit');
  assert.match(String(save.report_separately), /分开报告/, '没写「审核保存与后续动作分开报告」');
});

it('⑧ 公共规则不许各业务覆盖 ＋ 声明注册时要校验（不许空白降级）', () => {
  const contract = readContract();
  const rules = contract.public_rules;
  assert.ok(rules && Array.isArray(rules.items) && rules.items.length >= 5,
    '公共规则没列全（无差异隐藏/统一交互/权限与日志/真实结果/视觉与安全渲染）');
  const text = JSON.stringify(rules);
  assert.match(text, /不能声明|不许各业务/, '没写「公共规则不许各业务覆盖」');
  const check = contract.declaration_check;
  assert.ok(check, '没写声明注册时的校验');
  assert.match(String(check.at_registration), /指出具体配置问题|不许空白降级/,
    '没写「校验失败要指出具体配置问题，不许空白降级后照常允许确认」');
  assert.match(String(check.at_runtime), /实际状态/, '没写运行时仍检查实际状态');
});

it('⑨ 责任边界四行：内核／既有能力／域／FDE', () => {
  const contract = readContract();
  const r = contract.responsibility;
  assert.ok(r, '契约没写责任边界');
  for (const key of ['kernel', 'capabilities', 'domain', 'fde']) {
    assert.ok(r[key] && String(r[key]).length > 10, `责任边界缺 ${key} 那一行`);
  }
  assert.match(String(r.capabilities), /不因审核页再复制一套正式数据/,
    '没说清「既有能力不因审核页再复制一套正式数据」');
  assert.match(String(r.domain), /呼吸|弹窗/, '没写「域不负责维护通用弹窗与呼吸字体逻辑」');
});

it('⑩ 验收清单在（文档里的要求与判据不算已实现、不算已验收）', () => {
  const contract = readContract();
  const acc = contract.acceptance;
  assert.ok(acc && Array.isArray(acc.items) && acc.items.length >= 6,
    '验收清单没列全');
  const text = JSON.stringify(acc);
  assert.match(String(acc.note), /不等于已实现|不等于已验收/, '验收段没写「文档不算证据」');
  assert.match(text, /公共独立性/, '验收清单缺「公共独立性」');
  assert.match(text, /部分保存/, '验收清单缺「部分保存」');
  assert.match(text, /整体保存/, '验收清单缺「整体保存」');
  assert.match(text, /后台也不能绕过/, '验收清单没写「后台也不能绕过」');
  assert.match(text, /呼吸/, '验收清单缺「呼吸交互」');
  assert.match(text, /无差异不展示/, '验收清单缺「无差异不展示」');
  assert.match(text, /折叠|筛选/, '验收清单缺「折叠/筛选不改变整组范围」');
});

it('⑪ 契约与实现对得上：公共壳不写死域的页面 id ＋ 页面注册表里没有域前缀的审核中心', () => {
  const shell = fs.readFileSync(SHELL_PATH, 'utf8');
  assert.doesNotMatch(shell, /example-domain\./,
    '公共壳里写死了 example 的页面 id —— 公共壳不该知道任何域的页面 id');
  const registry = fs.readFileSync(PAGE_REGISTRY_PATH, 'utf8');
  assert.match(registry, /'review-center'|review-center/,
    '静态页面注册表里没有「审核中心」这一页 —— 它该是公共页');
});

it('⑫ 左栏那十类里的「**内容分组与顺序**」有形状可给（不只是一句要求 —— 要求没形状＝落不了地）', () => {
  const contract = readContract();
  const left = contract.declaration?.ten?.['2_left_slot'];
  assert.ok(left, '契约里没有第 2 类（左栏内容）');
  /* 这一类本来就写着「内容分组与顺序」—— 但**没写怎么给** ⇒ 域给不了、壳也渲染不出来。 */
  assert.ok(left.must_state.some(item => /分组/.test(String(item))),
    '第 2 类里没有「内容分组」这条要求');
  const shape = JSON.stringify(left.shape || {});
  assert.match(shape, /groups/, '左栏内容没给「分组」怎么给的形状（该写 leftSlot.groups = [{key,title,order}]）');
  assert.match(shape, /group/, '没写每一项怎么指到哪个组（该写 group ＝ 组的 key）');
  assert.match(shape, /order/, '没写分组的顺序怎么给（该写 order）');
  assert.match(shape, /漏/, '没写「没分组的项不许被漏掉」这一条');
});

/* —— §8 与内核契约的「不许丢口径」护栏（2026-10-23 PKG-059）——
 *
 * **为什么要有**：内核契约那十类的 `must_state` 是**照着《用例清单》§8.2 那张表落的**
 * —— 但核对时发现**产品口径里有两条被内核契约丢掉了**：
 *   第 1 类少「**如何引用已有候选、目标对象和内容单元**」；
 *   第 2 类少「**字段、文本、关联、增删操作如何显示**」。
 * ⇒ **要求没被抄进契约 ⇒ 没人能查它落没落地**（这正是「文档里的要求不能当已实现」的由来）。
 * ⇒ 现在每一类都带一份 `spec`：**产品口径那一行的原文** ＋ **逐段落点**
 *    （落在 must_state 的第几条 / 由 layers 承接 / 本批不覆盖）——
 *    **不许静默丢掉产品口径**（要么抄进来并说清落在哪，要么显式写「本批不覆盖」）。
 */

/** 归一化：空白、标点统一（比对「抄得对不对」，不比对排版）。 */
const normalize = (value) => String(value ?? '')
  .replace(/\s+/g, '')
  .replace(/[；;]/g, ';')
  .replace(/[，,]/g, ',')
  .replace(/[“”"']/g, '');

it('⑬ 十类每一类都带《用例清单》§8.2 那一行的原文 ＋ 逐段落点（不许内核契约把产品口径悄悄丢掉）', () => {
  const contract = readContract();
  const ten = contract.declaration?.ten || {};
  const classes = Object.keys(ten);
  assert.equal(classes.length, 10, '十类不是十类（找到 ' + classes.length + ' 类）');

  for (const key of classes) {
    const cls = ten[key];
    const spec = cls.spec;
    assert.ok(spec, key + ' 没有 `spec` ⇒ 没带《用例清单》§8.2 那一行的原文（产品口径被丢了）');
    assert.ok(String(spec.text || '').trim(), key + ' 的 `spec.text` 是空的');

    const segments = String(spec.text).split(/[；;]/).map(s => s.trim()).filter(Boolean);
    const covered = Array.isArray(spec.covered_by) ? spec.covered_by : [];
    assert.ok(covered.length, key + ' 的 `spec` 没有 `covered_by`（每一段要求都得说清落在哪）');

    /* ① 每一段都要有落点；段里「、」分隔的**每个部件**都要被提到
     *    （例如「字段、文本、关联、增删操作如何显示」⇒ 四个部件都要有说法）。 */
    for (const segment of segments) {
      const hits = covered.filter(entry => {
        const text = String(entry.text || '');
        return text.includes(segment) || segment.includes(text);
      });
      assert.ok(hits.length, key + ' 的这一段要求没写落点：' + segment);
      for (const part of segment.split(/[、，,]/).map(p => p.trim()).filter(Boolean)) {
        const mentioned = hits.some(entry => String(entry.text || '').includes(part));
        assert.ok(mentioned, key + ' 的这一段里「' + part + '」没写落点（整段：' + segment + '）');
      }
    }

    /* ② 落点必须有效：`must_state[n]` 指得到那一条；其它写法只认三种。 */
    for (const entry of covered) {
      for (const target of entry.by || []) {
        if (target.startsWith('must_state[')) {
          const index = Number(target.slice('must_state['.length, -1));
          assert.ok(Number.isInteger(index) && index >= 0 && index < cls.must_state.length,
            key + ' 的落点指向了不存在的 must_state：' + target
            + '（该类只有 ' + cls.must_state.length + ' 条）');
        } else {
          assert.ok(['layers.instance_data', 'layers.declaration', '本批不覆盖'].includes(target),
            key + ' 的落点写法不认识：' + target + '（只认 must_state[n]／layers.instance_data／layers.declaration／本批不覆盖）');
        }
      }
    }

    /* ③ 反向：must_state 里的每一条都要有落点（不许内核契约自己加产品口径没有的要求）。 */
    const pointed = new Set();
    for (const entry of covered) {
      for (const target of entry.by || []) {
        if (target.startsWith('must_state[')) pointed.add(Number(target.slice('must_state['.length, -1)));
      }
    }
    for (let i = 0; i < cls.must_state.length; i++) {
      assert.ok(pointed.has(i),
        key + ' 的 must_state 第 ' + i + ' 条（' + cls.must_state[i] + '）没有落点说明');
    }
  }
});

/** 那份《用例清单》在不在？不在就跳过这一条（站上/别处没有这份文档 ⇒ 不该判失败）。 */
function findUseCaseList() {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fde/设计/契约/用例清单.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

it('⑮ **看板式布局**的口径在契约里占住位置（分档片 ＋ 一行铺开 ＋ 卡上印进入时间 ＋ 待审灰 ＋ 驳回只读 ＋ 没有「AI 建议」块 ＋ 搜索保留）', () => {
  const contract = readContract();
  const view = contract.card_view;
  assert.ok(view, '契约里没有「卡片怎么摆」这一段（这一批的口径就没地方放）');
  const text = JSON.stringify(view);
  assert.match(text, /页头右上/, '没写清分档片摆在**页头右上**');
  assert.match(text, /卡张数/, '没写清分档片上的**件数＝卡张数**');
  assert.match(text, /已确认/, '没写清「已确认」是永远在的一档');
  assert.match(text, /一行张铺开/, '没写清卡片**一行张铺开**');
  assert.match(text, /进入审核中心/, '没写清卡上印「进入审核中心」的时间');
  assert.match(text, /待审的卡是灰的/, '没写清**待审的卡是灰的**');
  assert.match(text, /驳回的卡点不开/, '没写清**驳回的卡点不开**');
  assert.match(text, /AI 建议/, '没写清「AI 建议」那一块整个没有');
  assert.match(text, /搜索必须保留/, '没写清**搜索必须保留**');

  /* 公共壳那一半也要真的这么做（不许只写在契约里）。 */
  const shell = fs.readFileSync(SHELL_PATH, 'utf8');
  assert.match(shell, /data-review-decks/, '壳里没有那一片分档（页头右上）');
  assert.match(shell, /data-review-card-entered/, '壳里没有把进入时间印在卡上');
  assert.match(shell, /data-review-card-rejected/, '壳里没有把驳回的卡做成只读快照');
  assert.doesNotMatch(shell, /registerBuiltinAgent/, '壳还在注册「AI 建议」那一档（那一块没去掉）');
});

it('⑯ **读全了没有要说出来**这条口径在契约里占住位置（域捎一句话 ＋ 壳显示它 ＋ 老形状照样认）', () => {
  const contract = readContract();
  const cover = contract.data_coverage;
  assert.ok(cover, '契约里没有「读全了没有要说出来」这一段（这一批的口径就没地方放）');

  /* ① 形状：老形状（数组）与新形状（`{cards, notice}`）都得认。 */
  const shape = JSON.stringify(cover);
  assert.match(shape, /cards/, '没写新形状长什么样（该写 `{ cards, notice }`）');
  assert.match(shape, /notice/, '没写域捎的那句话叫什么（该写 `notice`）');
  assert.match(shape, /数组/, '没写老形状（回数组）照样认 —— 老用法会被破掉');

  /* ② 规矩：没读全必须说；读全了不许说。 */
  assert.match(shape, /没读全|读全/, '没写清「什么时候算没读全」');
  assert.match(JSON.stringify(cover.rule || ''), /必须/, '没写「没读全 ⇒ 必须给 notice」');
  assert.match(JSON.stringify(cover.rule || ''), /不许/, '没写「读全了 ⇒ 不许给 notice」（那是噪音）');

  /* ③ 壳那一半：只显示域给的那句话，不自己拼、不许出现任何域的表名/动作号。 */
  assert.match(shape, /只显示|原样/, '没写「壳只显示域给的那句话」');
  assert.match(String(cover.shell_must || ''), /不许出现|不出现/, '没写「壳里不许出现任何域的表名/动作号」');

  /* ④ 公共规则里也得占一行（这是**公共规则**，不是域各写各的）。 */
  assert.match(JSON.stringify(contract.public_rules), /读全了没有要说出来|没读全/,
    '公共规则里没有这一条 —— 它该是公共规则（各业务不许各写各的）');

  /* ⑤ 公共壳那一半也要真的这么做（不许只写在契约里）。 */
  const shell = fs.readFileSync(SHELL_PATH, 'utf8');
  assert.match(shell, /data-review-notice/, '壳里没有把域捎来的那句话显示出来的那一处');
});

it('⑭ 内核契约抄的《用例清单》§8.2 原文**与那份文档一字不差**（那份文档在场时核对）', (t) => {
  const docPath = findUseCaseList();
  if (!docPath) {
    t.skip('这台机器上没有《用例清单》（' + path.join('fde/设计/契约/用例清单.md') + '）⇒ 这一条没法核对');
    return;
  }
  const doc = fs.readFileSync(docPath, 'utf8');
  const start = doc.indexOf('#### 8.2 十类核心声明');
  const end = doc.indexOf('#### 8.3', start);
  assert.ok(start >= 0 && end > start, '《用例清单》里找不到 §8.2 那张表');
  const rows = new Map();
  for (const line of doc.slice(start, end).split('\n')) {
    const m = line.match(/^\|\s*(\d+)\.\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) rows.set(Number(m[1]), m[3]);
  }
  assert.equal(rows.size, 10, '《用例清单》§8.2 那张表不是十行（找到 ' + rows.size + ' 行）');

  const ten = readContract().declaration.ten;
  for (const [key, cls] of Object.entries(ten)) {
    const number = Number(String(key).split('_')[0]);
    const expected = rows.get(number);
    assert.ok(expected, '《用例清单》§8.2 里没有第 ' + number + ' 行');
    assert.equal(normalize(cls.spec?.text), normalize(expected),
      key + ' 抄的原文与《用例清单》§8.2 第 ' + number + ' 行**对不上**'
      + '（产品口径改了 ⇒ 契约要跟着改，且改动要讲清为什么）');
  }
});

/**
 * ⑰ **三条行为在契约里有位置**（PKG-099 · 对账表核出来的真缺口，契约补上了「形状」）。
 *
 * 这三条以前**只有一句话**（要求），**没有形状**（落不了地）⇒ 实现各做各的：
 *  ① **证据对应关系**：第 4 类要「每个变化/内容组对应哪些凭据」，
 *     但没说**在哪儿说** ⇒ 证据失败只能按**整张卡**判（辅助材料坏了把别的组也卡住）；
 *  ② **保存结果**：失败／冲突／结果未明**混成一句「保存失败」**，后端给的话被吞了；
 *  ③ **能力隔离**：一个域没起来 ⇒ 整页塌成一句「读取失败」，别的审核全用不了。
 *
 * **测试通过 =** 契约里这三处都有「形状」（不只是有一句话）。
 */
it('⑰ 三条行为在契约里有位置：证据对应关系的形状 ＋ 保存结果四种 ＋ 能力不可用只阻断它自己', () => {
  const contract = readContract();
  const evidence = contract.declaration.ten['4_evidence_binding'];
  assert.ok(evidence.shape, '第 4 类没有「形状」——「每个变化/内容组对应哪些凭据」落不了地');
  assert.ok(evidence.shape.item_changes, '第 4 类没说凭据**在哪儿**指到哪些变化/内容组');
  assert.ok(evidence.shape.blocked_scope, '第 4 类没说必需凭据失败**挡哪些**（整张卡还是那一组）');
  assert.ok(evidence.shape.required_vs_aux, '第 4 类没说清楚「必需」与「辅助」怎么分');

  const outcomes = contract.save_policy.result_outcomes;
  assert.ok(outcomes, '保存策略里没有「结果四种要分得开」这一条');
  assert.ok(outcomes.conflict, '没说 409 ＝ 冲突（跟「保存失败」不是一回事）');
  assert.ok(outcomes.unknown, '没说 5xx／拿不到回执 ＝ 结果未明');
  assert.ok(outcomes.backend_message, '没说后端给的那句话要透出来');

  const isolation = (contract.public_rules.items || []).join('\n');
  assert.match(isolation, /所属业务能力不可用只阻断它自己/,
    '公共规则里没有「所属能力不可用只阻断它自己」这一条');
});

/**
 * ⑱ **「暂存」这一档在契约里有成文定义**（PKG-118-T01）。
 *
 * **为什么要有这一条**：审核中心原来只有「还没看（pending）／采用（accepted）／
 * 放弃（rejected）」三档。用户在表格里点一个单元格时，要的是「**这一项先存着**」
 * ——不是「正式值当场就改了」。⇒ 契约里必须**成文**写清这一档：
 * 它是什么、**谁写**、**跨入口共享一份**（表格里暂存 ＝ 审核中心里看到已暂存，
 * **不许两份**）、与采用/保存的区别、**不绕过整组规则**。
 * 契约里没有这一档 ⇒ 表格页与审核中心各写各的（一个叫「已存」、一个叫「已暂存」），
 * 人看到的和后端记的对不上。
 *
 * **测试通过 =** 契约里这一档的五件事都写下来了（逐条断言，见下面）。
 */
it('⑱ 「暂存」这一档在契约里有成文定义：是什么／谁写／跨入口共享一份／与采用保存的区别／不绕整组规则', () => {
  const contract = readContract();
  const tier = contract.staged_tier;
  assert.ok(tier, '契约里没有「暂存」这一档（§staged_tier）—— 这一档就没有成文定义');

  /* ① 它是什么：**只标记**，正式值一个字都不改。 */
  assert.match(String(tier.what || ''), /只标记/, '没写清「暂存只是标记」');
  assert.match(String(tier.what || ''), /正式值/, '没写清「正式值一个字节都不改」');
  assert.match(String(tier.what || ''), /一个字都不改|一个字节都不改/, '没写清「正式值一个字都不改」');

  /* ② 谁写：有采用权限的人才能暂存（看得见 ≠ 能暂存）。 */
  assert.ok(String(tier.who_writes || '').length > 0, '没写「谁写这一档」');
  assert.match(String(tier.who_writes || ''), /权限/, '没写清「暂存跟采用同一套权限」');

  /* ③ 跨入口共享一份：表格里暂存 ＝ 审核中心里看到已暂存（不许两份）。 */
  assert.ok(String(tier.one_copy || '').length > 0, '没写「跨入口共享一份」');
  assert.match(String(tier.one_copy || ''), /跨入口|共享一份/, '没写清「跨入口共享一份」');
  assert.match(String(tier.one_copy || ''), /不许两份|不另存一份/, '没写清「不许两份」');

  /* ④ 与采用/保存的区别：采用才写正式值；明确保存才入库。 */
  assert.match(String(tier.vs_adopt || ''), /采用/, '没写「暂存 vs 采用」');
  assert.match(String(tier.vs_adopt || ''), /才写正式值|才改正式值/, '没写清「采用才写正式值」');
  assert.match(String(tier.vs_save || ''), /保存/, '没写「暂存 vs 保存」');
  assert.match(String(tier.vs_save || ''), /才入库|才写进/, '没写清「明确保存才入库」');

  /* ⑤ 暂存不绕过整组规则：example 那种组，提交时后端照拒半截。 */
  assert.match(String(tier.group_rule_not_bypassed || ''), /不绕过整组|不绕开整组/,
    '没写「暂存不绕过整组规则」');
  assert.match(String(tier.group_rule_not_bypassed || ''), /照拒|照旧/, '没写清「提交时后端照拒半截」');

  /* ⑥ 这一档在人眼里的样子：状态取值多一档 staged。 */
  assert.match(String(tier.visible_state || ''), /staged/, '没写清「审核项状态多一档 staged」');
  assert.match(String(tier.visible_state || ''), /staged_count/, '没写清目录多一个 staged_count');
  assert.match(String(tier.visible_state || ''), /staged_units/, '没写清暂存回执带 staged_units');
  assert.match(String(tier.visible_state || ''), /staged_value/, '没写清暂存过的项带 staged_value');
});
