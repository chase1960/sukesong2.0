/* 审核中心（平台的一道**公共闸门** · PKG-033-T01）。
 *
 * **这是什么**：审核中心**不属于任何业务域** —— 它管的是「人核对后才落正式值」这件事本身：
 *   · **声明**（域给的）：这一类审核怎么组织、显示什么、要什么凭据、能不能部分保存、保存到哪里去；
 *   · **装配**（这里做的）：左右两栏怎么排、卡片怎么摆、呼吸/单击采用/双击改写、提交怎么分组。
 *
 * **为什么这样切**（用户 2026-10-22 18:15 原话：「审核中心他不应该归属于知识产权域……他是一道判断闸门，
 *   以后的 uc 都会用到它」）：
 *   ① 跨域的候选要在一处看；② 每接一个域就要维护一份「审核中心」；③ 公共规则会被各域复制走样。
 *
 * **口径来自内核契约** `frappe_apps/shangshu_core/shangshu_core/contracts/review-center-v1.json`
 *   —— 十类声明、两栏槽位、准入规则、两种保存方式、公共规则、责任边界都写在那里；
 *   **本文件不另造语义**，字段名由这里决定（契约明说「不预设接口字段名」）。
 *
 * ——— 三层（契约 §declaration.layers）———
 *   · **声明层**（域注册）：`registerDeclaration(spec)` —— 一次注册一类审核，不为每份通知书注册一次；
 *   · **实例数据层**（域给）：`declaration.list()` ⇒ 一条条**待审卡片**（一份凭据 ＝ 一组变更）；
 *   · **内核规则层**（这里，不开放覆盖）：无差异隐藏、呼吸/单击/双击/显式保存、真实结果、分组提交。
 *
 * ——— 准入（契约 §admission）———
 *   「**只有把原件摆到眼前才能判断的变更，才进审核中心。**」
 *   · `evidence` 凭据对照型 ⇒ **进这一页**；
 *   · `context`  就地可判型 ⇒ **不进**，给一条指路（跳助手对话的确认卡）；
 *   · `derived`  上游结果型 ⇒ **不进**（回上游那个工作面）。
 *   默认按 kind 映射（automation/official → evidence；assistant → context；mail → derived），
 *   域可以**显式**改；改的值只许是这三个已知档位（**不许另造语义**）。
 *
 * ——— 公共壳不写死任何域的页面 id（契约 §ownership.domain_role）———
 *   页面本体归核心域（`page-registry.js` 的静态表 ＋ `RENDER['review-center']`），
 *   域只注册**声明**与**来源**。
 */
(function (global) {
  'use strict';

  const doc = global.document;

  // ========== 公共常量（口径来自内核契约） ==========

  /** 准入三档（契约 §admission.kinds）。 */
  const ADMISSION = {
    evidence: { key: 'evidence', name: '凭据对照型', inPage: true, meaning: '判断它对不对必须看到原件' },
    context: { key: 'context', name: '就地可判型', inPage: false, meaning: '判断依据已经摆在旁边', redirect: '跳助手对话的确认卡' },
    derived: { key: 'derived', name: '上游结果型', inPage: false, meaning: '上游已经审过，这里只是下游结果', redirect: '回上游那个工作面' },
  };

  /** 默认按 kind 映射（契约 §admission.default_by_kind）。 */
  const DEFAULT_BY_KIND = {
    automation: 'evidence', official: 'evidence', assistant: 'context', mail: 'derived',
  };

  /** 十类核心声明（契约 §declaration.ten）—— 顺序就是核对的顺序。 */
  const PART_ORDER = [
    'identity', 'leftSlot', 'rightSlot', 'evidenceBinding', 'editable',
    'savePolicy', 'precondition', 'audience', 'handling', 'execution',
  ];
  const PART_LABELS = {
    identity: '第 1 类 审核身份与组织',
    leftSlot: '第 2 类 左栏内容',
    rightSlot: '第 3 类 右栏凭据',
    evidenceBinding: '第 4 类 对应关系与证据要求',
    editable: '第 5 类 可编辑范围',
    savePolicy: '第 6 类 保存方式与完整范围',
    precondition: '第 7 类 提交前提与重核范围',
    audience: '第 8 类 审核人范围',
    handling: '第 9 类 可用处理方式',
    execution: '第 10 类 执行入口与结果去向',
  };

  /**
   * **公共默认值**（契约 §declaration.note：每一类要么域明确给，要么引用既有定义/公共默认值）。
   * 域不写 ⇒ 用这里的默认；域写 ⇒ 用域的；域写 `{ref:'名字'}` ⇒ 引用已注册的定义。
   */
  const PUBLIC_DEFAULTS = {
    identity: { title: '待核对', summary: '', cardUnit: '一份凭据一组变更', entry: '审核中心', domain: '' },
    leftSlot: { title: '', format: 'field-table' },
    rightSlot: { title: '原件', format: 'attachment-list' },
    evidenceBinding: { required: [], locator: 'none' },
    editable: { mode: 'adopt-and-edit', control: 'text' },
    savePolicy: { partial: true, unit: '一条变更', group: 'card' },
    precondition: { checks: [], fingerprint: '' },
    audience: { mode: 'existing-permission' },
    handling: { entries: ['adopt', 'edit', 'save'] },
    execution: { saveAction: 'kernel.accept' },
  };

  /** 状态机标签（老口径八个，前六个仍在用）。 */
  const STATE_LABELS = {
    pending: '待确认', saving: '保存中', confirmed: '已确认', applied: '已确认',
    failed: '保存失败', stale: '已过期', difference: '发现差异', rejected: '已退回',
  };

  const CONFIRM_NOTICE = '仅更新已勾选字段；不确认 AI 建议、不代替通知书核对、不发送邮件。';
  const AGENT_TEXT = '请到尚书对话中的确认卡，查看并确认这项 AI 修改。';
  const EMPTY_TEXT = '当前范围没有记录';
  const MAX_COUNT_FAILURES = 3;
  /**
   * **量不出来时的一页条数**（默认）。
   *
   * ⚠️ **条数按屏算**（用户 2026-10-28 实拍：「为什么这个卡片没有铺满？明明有两页，
   *   先填满一页再去第二页呀」）：固定 12 张 ⇒ 屏幕放得下 3 行时只摆 2 行
   *   ⇒ **下面空一大块** ⇒ 人看着像「没铺满」；屏幕只放得下 2 行时硬摆 12 张
   *   ⇒ **第三行整个在屏幕外** ⇒ 翻页前还得先滚一遍。
   * ⇒ **一页 ＝ 这一屏放得下的张数**（见 `cardsPerScreen`／`measureScreenCards`）。
   * ⇒ **这个 12 只是「量不出来」的兜底**（没有布局引擎／这一格还没上屏）。
   */
  const CARDS_PER_PAGE = 12;
  /** 一页最多这么多（不许一次把全库端回来）。 */
  const CARDS_PER_PAGE_MAX = 60;
  const SPLIT_ATTR = 'data-review-split';
  const CARD_ATTR = 'data-review-card';

  // ========== 状态 ==========

  /** 已注册声明：key → 声明。 */
  const declarations = new Map();
  /* —— **声明变更的通知**（PKG-132 · 用户 2026-10-27 21:4x 实测：
     「从侧栏应用出现后，审核中心**从没有待审核到出现审核卡片**」——
     根因：域的声明是**后注册**的（域脚本晚于页面挂载），
     而 `registerDeclaration` **只写进 map、不通知已挂载的页面**
     ⇒ 页面永远停在「没有待审核」，除非人手动刷新。
     ⇒ 这里登记监听者：声明一到就**重读当前那一档**。 */
  const declarationListeners = new Set();
  function onDeclarationChange(listener) {
    declarationListeners.add(listener);
    return () => declarationListeners.delete(listener);
  }
  function notifyDeclarationChange(key) {
    declarationListeners.forEach(listener => {
      try { listener(String(key || '')); } catch { /* 一个监听者坏了不许连累别的 */ }
    });
  }
  /**
   * **注册失败的声明**（PKG-121 · 缺口⑤：域声明写错 ⇒ 这一类审核**人间蒸发**）。
   *
   * **为什么壳自己要记**：契约 §declaration.note 写的是「注册失败 ⇒ 页面会把具体配置问题摆出来」，
   *   原来**根本没有这条路径** —— `registerDeclaration` 只**返回** `{ok:false, errors}`，
   *   而域**可以不看返回值**（某个域侧两处就是直接调、不看回值）
   *   ⇒ 域声明写错 ⇒ 那一类**根本没注册** ⇒ 页面上不出现 ⇒ **没人知道它没了**。
   * ⇒ 壳自己记下来、在页面上摆出来（域看不看返回值都不影响它被看见）。
   */
  const declarationFailures = [];
  /** 命名定义（供 `{ref:'名字'}` 引用）：name → 值。 */
  const definitions = new Map();
  /** 受管保存能力：name → {id, groupAccept, partialAccept, save}。 */
  const saveActions = new Map();

  const state = {
    tab: '',
    cards: {},
    counts: {},
    /* —— **域捎来的那句话**（PKG-072-T01）：声明 key → 那句话（**域自己的话**）。
       壳**只原样显示**它（不自己拼、不许出现任何域的表名/动作号）。 */
    notices: {},
    /* —— **声明 key → 那一类取不到的原因**（PKG-099 · G9）。
       所属能力不可用**只阻断它自己**：这一片空着并说明白，**别的审核照常摆卡、照常存**。 */
    declErrors: {},
    loading: false,
    listReadGeneration: 0,
    detailReadGeneration: 0,
    detailLoading: false,
    detailError: '',
    detailController: null,
    panelCleanup: null,
    error: '',
    busy: false,
    receipt: '',
    pageHost: null,
    pageOptions: null,
    /* —— **这一页自己的取消信号**（路由给的；换页时上游 `abort()` 它）——
       壳的读与域的读**都用它** ⇒ 人一离开这一页，在途的读**真的被掐掉**（R07 · P1）。
       ⚠️ **原样传下去**（传的就是它那一个）⇒ 上游 `fetch` 收到的 `init.signal`
       与页面那一把**是同一个对象**（不是「某个 signal」）。 */
    pageSignal: null,
    pageDisposed: false,
    modal: null,
    modalOpen: false,
    /** 分栏弹窗当前开着哪张卡。 */
    activeCardId: null,
    /** 分栏弹窗里的核对状态：changeId → 'pending' | 'adopted' | 'edited' | 'saved'。 */
    adopt: new Map(),
    /** 改写后的候选值：changeId → 文本。 */
    edits: new Map(),
    /** 核对清单：cardId → {key: true/false}（第 9 类「可用处理方式」里的必核项）。 */
    checks: new Map(),
    /** 正在编辑的 changeId。 */
    editing: null,
    /** 「信息有误／待核实」这类**别的处理方式**（第 9 类里明确可执行的那种）。 */
    difference: { open: false, kind: '', reason: '', error: '' },
    /** 每张卡片上一次核对用的「前提指纹」（换了案件 ⇒ 旧核对作废）。 */
    fingerprints: new Map(),
    /** 卡片列表看哪一档：'pending'（当前声明的**待审**卡）｜'done'（**已确认**那一档：全部声明的已审卡）。 */
    listState: 'pending',
    /** **用户自己点过分档片没有**（PKG-071-T01 · 2026-10-24 夜班上站实看抓出来的）：
     *  · 点过 ⇒ **不再自动挪到别的片**（用户选的那一档是他要的）；
     *  · 没点过 ⇒ 读完成数后，**落在「有未处理卡的那一片」**。
     * ⚠️ 为什么不自动挪是个坑：站上分档片是「更新 0 ／ 待核对 1 ／ 已确认 33」，
     *   而进页面默认落在第一片（0 张卡）⇒ 整页只写「当前范围没有记录」
     *   ⇒ **用户以为没有待办**（真正那张待审灰卡在第二片里）。 */
    deckPinned: false,
    /** **页头右上那片分档**的容器（换档／重新取数时要重画）。 */
    deckHost: null,
    /** 卡片列表的搜索词（只改看的方式，不改提交集合）。 */
    search: '',
    cardPage: 1,
    /* —— **每 scope 的分页状态**（PKG-132 · 今晚「服务端真分页」那一项）——
     *  · `pending` ＝ **待审**那一档（**当前声明**）⇒ **真服务端分页**：
     *    翻页时**重新向域要那一页**（`page`/`pageLength`/`scope` 都交过去），
     *    壳**不拿旧的全量在前端切**。
     *  · `done`    ＝ **「已确认」**那一档（**跨全部声明合并**）⇒ 见 `loadDoneScope` 的说明：
     *    每个声明**各自翻自己的页**，壳把各声明的页**归并**成一条（总数＝各声明真实总数之和）。
     * 每一份里：`page` 当前页、`total` **真实总数**、`totalAll` 不带搜索词时的真实总数、
     * `pages` 总页数、`legacy` 这一档是不是「域回老形状 ⇒ 壳自己切片」的**降级路径**、
     * `searchServer` 搜索是不是**真的在服务端做了**（域不支持时如实标成前端过滤）。 */
    paging: {
      pending: { scope: 'pending', page: 1, total: 0, totalAll: 0, pages: 1, legacy: false, searchServer: false, clientFilter: false },
      done: { scope: 'done', page: 1, total: 0, totalAll: 0, pages: 1, legacy: false, searchServer: false, clientFilter: false },
    },
    /** scope → 声明 key → 那一档里这一份声明的取数结果
     *  （`cards` 装配后的卡、`legacy` 是不是老形状、`total` 域给的真实总数、`page` 要的那一页）。 */
    scopeStore: { pending: {}, done: {} },
    /** 「已确认」那一档的**归并缓冲**（declKey → {cards, pointer, nextPage, exhausted, total}）。 */
    doneBuffers: {},
    /** 「已确认」那一档**已经摆过的页**（page → 卡）：往回翻不用再问域。 */
    donePages: {},
    /** 这一页的三个容器（重画时**复用**，不把搜索框换掉）：状态区／卡片区／分页条。 */
    statusHost: null,
    bodyHost: null,
    pagerHost: null,
    /** **一页摆几张卡**（量出来的：这一屏放得下几张）。
     *  量不出来 ⇒ `CARDS_PER_PAGE`（12）。量出来就按它取那一页。 */
    screenCards: CARDS_PER_PAGE,
    /** 搜索那一块（重画时复用：换掉输入框会把人的焦点弄丢）。 */
    toolsHost: null,
    failures: 0,
    timer: 0,
    started: false,
    loadedAt: 0,
  };

  // ========== 小工具 ==========

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fetchJson(path, options) {
    return global.fetch(path, Object.assign({ credentials: 'include', cache: 'no-store' }, options || {}))
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok || (data && data.ok === false)) {
          const failure = Error((data && (data.error || data.message)) || ('HTTP ' + response.status));
          /* **带上状态码**：4xx ＝ 请求被拒（没写进去）；5xx/超时/取不到回执 ＝ 结果未知。 */
          failure.status = Number(response.status) || 0;
          throw failure;
        }
        return data;
      });
  }

  /** 这次失败是「没登记」还是「结果未知」（老项目口径，照搬）。 */
  function isRegisteredFailure(error) {
    const status = Number(error && error.status) || 0;
    return status >= 400 && status < 500;
  }

  /**
   * **这次失败是「被取消」还是「真失败」**（R07 · P1）。
   *
   * **为什么单列一个**：读挂上页面信号以后，**取消从「罕见」变成「常见」**
   * （人一切页就有一批读被取消）⇒ **取消不许被当成真失败**去画那句
   * 「读取失败，请重新加载。」—— 那一页的人**已经走了**，不该再给他一句话。
   * ⚠️ 浏览器 `fetch` 被 abort 时给的是 `AbortError`；有些实现给 `code === 20`（`ABORT_ERR`）。
   */
  function isAbortError(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    return Number(error.code) === 20;
  }

  let opCounter = 0;
  /** 内核幂等键：稳定、合法（`[A-Za-z0-9_.:-]`）。 */
  function opId(prefix) {
    opCounter += 1;
    return prefix + '-' + Date.now() + '-' + opCounter;
  }

  /** 值的统一读法：候选值可能是 `{type, value}`，也可能就是裸值。 */
  function plainValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'value' in value) {
      return value.value === null || value.value === undefined ? '' : String(value.value);
    }
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (error) { return ''; }
    }
    return String(value);
  }

  /**
   * **时间只印到秒**（PKG-068-T01 · 站上实看发现的）：
   * 内核给的 `creation` 是 `2026-10-23 18:56:30.586396` ⇒ 直接印到卡上，
   * 业务方看到的是一串小数（看不懂、也不需要）。
   * ⚠️ **只去掉后面那截小数** —— 日期与时分秒**一个字不改**（不编、不猜时区）。
   * ⚠️ **认不出来的写法就原样印**（例如「前天下午」）⇒ **不丢、不改、不编**。
   */
  function timeToSecond(value) {
    const raw = plainValue(value).trim();
    if (!raw) return '';
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) return raw;
    return raw.replace(/\.\d+$/, '');
  }

  /** 来源种类：automation＝代码/规则；assistant＝AI；其余＝未知。 */
  function sourceKind(proposal) {
    if (typeof global.shangshuReviewSource === 'function') {
      const source = global.shangshuReviewSource(proposal);
      if (source && source.kind) return source.kind;
    }
    const raw = String((proposal && proposal.created_via) || '').trim();
    if (['code', 'automation', 'execution', 'llm-node'].includes(raw)) return 'automation';
    if (['ai', 'ai-chat', 'assistant'].includes(raw)) return 'assistant';
    const proof = proposal && proposal.source_provenance;
    if (proof && proof.status === 'linked' && proof.trusted === true && proof.kind === 'process') return 'automation';
    return 'unknown';
  }

  function stateLabel(value) {
    return STATE_LABELS[String(value || 'pending')] || String(value || 'pending');
  }

  // ========== 声明注册口 ==========

  /**
   * **命名定义**：域可以把自己的常用配置登记成一个名字，别人（或自己）用 `{ref:'名字'}` 引用。
   * 引用 = 「用已有的那一份」，**不是**让内核猜业务（契约 §declaration.note）。
   */
  function registerDefinition(name, value) {
    if (typeof name !== 'string' || !name) return { ok: false, errors: ['定义名不能为空'] };
    definitions.set(name, value);
    return { ok: true, name };
  }

  /**
   * **受管保存能力**：声明第 10 类引用的保存动作必须在这里登记过，
   * 否则注册时报「找不到保存动作」—— **不许空白降级后照常允许确认**（契约 §declaration_check）。
   */
  function registerSaveAction(name, meta) {
    if (typeof name !== 'string' || !name) return { ok: false, errors: ['保存动作名不能为空'] };
    const spec = Object.assign({ id: name, groupAccept: true, partialAccept: true }, meta || {});
    saveActions.set(name, spec);
    return { ok: true, name };
  }

  /** 内核默认的保存动作：走内核**确认 Action**（正式值只经它写）。 */
  registerSaveAction('kernel.accept', {
    id: 'kernel.accept',
    label: '内核确认 Action',
    groupAccept: true,
    partialAccept: true,
    save: defaultKernelAccept,
  });

  /** 一类的值：域明确给 ／ `{ref:'名字'}` 引用 ／ 不给 ⇒ 公共默认值。 */
  function resolvePart(spec, part) {
    const given = spec && Object.prototype.hasOwnProperty.call(spec, part) ? spec[part] : undefined;
    if (given === undefined || given === null) {
      return { ok: true, value: PUBLIC_DEFAULTS[part], from: 'public-default' };
    }
    if (typeof given === 'object' && !Array.isArray(given) && typeof given.ref === 'string') {
      if (!definitions.has(given.ref)) {
        return { ok: false, from: 'ref', error: PART_LABELS[part] + '引用了不存在的定义「' + given.ref + '」' };
      }
      return { ok: true, value: definitions.get(given.ref), from: 'ref:' + given.ref };
    }
    if (typeof given !== 'object') {
      return { ok: false, from: 'given', error: PART_LABELS[part] + '写得不是一份配置（要对象）' };
    }
    return { ok: true, value: given, from: 'domain' };
  }

  /**
   * **注册时的校验**（契约 §declaration_check.at_registration）：
   *   不支持的部件、找不到的保存动作、保存策略与动作能力不匹配 ⇒ **指出具体配置问题**；
   *   **不许空白降级后照常允许确认**。
   */
  function validateDeclaration(spec) {
    const errors = [];
    if (!spec || typeof spec !== 'object') return { ok: false, errors: ['声明不是一个对象'] };
    if (typeof spec.key !== 'string' || !spec.key) errors.push('声明没有 key（一个声明一个稳定编号）');
    if (typeof spec.name !== 'string' || !spec.name) errors.push('声明没有名字（人看得见的审核类型名）');
    if (typeof spec.list !== 'function') errors.push('声明没有 list（这一类审核的待审数据从哪来）');

    const kind = String(spec.kind || '');
    const admissionGiven = spec.review === undefined || spec.review === null ? null : String(spec.review);
    if (admissionGiven !== null && !ADMISSION[admissionGiven]) {
      errors.push('准入档位「' + admissionGiven + '」不在三档里（只能是 evidence / context / derived）');
    }
    if (!kind && !admissionGiven) {
      errors.push('声明既没说 kind 也没说 review（准入不知道按哪一档）');
    }
    if (kind && !DEFAULT_BY_KIND[kind] && !admissionGiven) {
      errors.push('来源种类「' + kind + '」没有默认准入映射（要么换一个 kind，要么显式写 review）');
    }

    const resolved = {};
    PART_ORDER.forEach(part => {
      const outcome = resolvePart(spec, part);
      if (!outcome.ok) { errors.push(outcome.error); return; }
      resolved[part] = outcome.value;
    });

    /* —— 第 2/3 类：两栏的格式必须在公共渲染器里（左右都能变成任意格式，但不许自造部件）。 */
    if (resolved.leftSlot && resolved.leftSlot.format && !FORMATS[resolved.leftSlot.format]) {
      errors.push('第 2 类 左栏用了不存在的格式「' + resolved.leftSlot.format + '」（公共渲染器只有：'
        + Object.keys(FORMATS).join(' / ') + '）');
    }
    if (resolved.rightSlot && resolved.rightSlot.format && !FORMATS[resolved.rightSlot.format]) {
      errors.push('第 3 类 右栏用了不存在的格式「' + resolved.rightSlot.format + '」（公共渲染器只有：'
        + Object.keys(FORMATS).join(' / ') + '）');
    }

    /* —— 第 4 类：必需凭据是**哪些凭据编号**（定位提示必填在运行时逐条查，见 hasFailedRequiredEvidence）。 */
    const binding = resolved.evidenceBinding || {};
    if (binding.required !== undefined && !Array.isArray(binding.required)) {
      errors.push('第 4 类 必需凭据写得不是一个编号列表');
    }
    const required = Array.isArray(binding.required) ? binding.required : [];
    required.forEach((id, index) => {
      if (typeof id !== 'string' || !id) {
        errors.push('第 4 类 第 ' + (index + 1) + ' 个必需凭据不是凭据编号');
      }
    });

    /* —— 第 5 类：**可编辑范围只有一档**（契约 §declaration.ten.5_editable）。
       **为什么只有一档**（用户 2026-10-24 12:0x 原话）：
       「**所有候选的内容都是能改的，审核中心只有『是只能全部采纳』和『允许部分采纳』**」
       ⇒ 「哪些只能采用或暂不处理」这个档**这个产品没有**；保存方式的整组／部分在**第 6 类**，不在这里。
       **不许「声明说了不算」**：域以为它限住了、人却照样能改 ⇒ 注册当场拒并说清只有哪一档。 */
    const editable = resolved.editable || {};
    if (editable && typeof editable !== 'object') {
      errors.push('第 5 类 可编辑范围写得不是一个配置（要对象）');
    } else {
      if (editable.mode !== undefined && editable.mode !== 'adopt-and-edit') {
        errors.push('第 5 类 可编辑范围写的是「' + editable.mode
          + '」，这个产品只有一档：**所有候选都能改写**（adopt-and-edit）—— 没有「只能采用」那一档'
          + '（整组采纳／允许部分采纳是**第 6 类 保存方式**的事）'
          + '；这一类**没有候选可改写**？那就**不写第 5 类**（用公共默认）——'
          + '「哪一项根本不是候选」在**本次待审数据**里说，不在声明里说');
      }
      if (editable.control !== undefined && editable.control !== 'text') {
        errors.push('第 5 类 可编辑范围用的编辑控件是「' + editable.control
          + '」，公共编辑控件只有 **text**（双击候选改写）这一件');
      }
    }

    /* —— 第 6 类：只写「不允许部分保存」**还不够**，必须知道整组是什么（契约 §declaration.ten.6.hard）。 */
    const policy = resolved.savePolicy || {};
    if (policy.partial === false && !policy.group) {
      errors.push('第 6 类 写了「不允许部分保存」但没写整组范围（这次必须一起提交的集合是什么）');
    }
    if (policy.partial === true && !policy.unit) {
      errors.push('第 6 类 允许部分保存但没写最小独立单元是什么');
    }
    /* —— **整组范围只有两种写法**（PKG-121 · 缺口③）：
         ① **函数**（`group: card => [...]`）—— 域自己算这次要一起提交的是哪几项；
         ② **字符串 `'card'`** —— 整组＝**本卡片的全部变更**（某域「一份通知书带动的整组正式变化」就是这个）。
       **为什么不许「认不出的写法也按整卡算」**：域以为自己限住了「只提交同一行的那几项」，
       壳却**悄悄按「整张卡全提交」处理** ⇒ 「整组到底包括什么」这件事**没人说得清**
       ⇒ 要么域以为限住了、人却被整组卡住；要么域以为能整组、实际提交时被拆散。
       ⇒ **注册当场拒并说清只有哪两种**（与内核「认不出的值按最严那档拦」同一口径：
       **宁可当场拒，不许悄悄按一个说不清的整组算**）。 */
    if (policy.group !== undefined && policy.group !== null) {
      const groupIsFunction = typeof policy.group === 'function';
      const groupIsCard = policy.group === 'card';
      if (!groupIsFunction && !groupIsCard) {
        errors.push('第 6 类 整组范围写的是「'
          + (typeof policy.group === 'string' ? policy.group : typeof policy.group)
          + '」，公共壳只认两种写法：**函数**（自己算整组）或**字符串 \'card\'**（整组＝本卡片全部变更）'
          + ' —— 写别的**注册当场拒**（不许悄悄按「整卡」算：那会让「整组究竟包括什么」没人说得清）');
      }
    }

    // 域可声明人工准备入口（如选择关联记录），壳不实现域内匹配或写入。
    const handlingActions = resolved.handling && resolved.handling.actions;
    if (handlingActions !== undefined) {
      if (!Array.isArray(handlingActions)) errors.push('第 9 类 actions 必须是处理入口列表');
      else {
        const ids = new Set();
        handlingActions.forEach(action => {
          if (!action || typeof action.id !== 'string' || !action.id || ids.has(action.id)
            || typeof action.label !== 'string' || !action.label || typeof action.run !== 'function'
            || (action.visible !== undefined && typeof action.visible !== 'function')
            || (action.disabled !== undefined && typeof action.disabled !== 'function')) {
            errors.push('第 9 类处理入口需要唯一 id、名称 label 和执行函数 run');
          }
          if (action) ids.add(action.id);
        });
      }
    }

    const panel = resolved.handling && resolved.handling.panel;
    if (panel !== undefined && (!panel || typeof panel.id !== 'string' || !panel.id
      || typeof panel.mount !== 'function'
      || (panel.visible !== undefined && typeof panel.visible !== 'function')
      || (panel.blocksReview !== undefined && typeof panel.blocksReview !== 'function'))) {
      errors.push('第 9 类内嵌准备区需要 id、mount 函数及有效的可见/审核前提声明');
    }

    /* —— 第 10 类：保存动作必须存在，且能力要和保存方式对得上。 */
    const execution = resolved.execution || {};
    const actionName = execution.saveAction;
    if (!actionName) {
      errors.push('第 10 类 没有写保存动作（正式值只能经受管保存能力写）');
    } else if (!saveActions.has(actionName)) {
      errors.push('第 10 类 找不到保存动作「' + actionName + '」（先 registerSaveAction 登记它）');
    } else {
      const action = saveActions.get(actionName);
      if (policy.partial === false && action.groupAccept === false) {
        errors.push('第 6 类与第 10 类对不上：声明说「整组提交」，保存动作「' + actionName + '」不支持整组');
      }
      if (policy.partial === true && action.partialAccept === false) {
        errors.push('第 6 类与第 10 类对不上：声明说「可以只保存选中的」，保存动作「' + actionName + '」不支持部分保存');
      }
    }

    /* —— 第 8 类：审核人范围不能是空的（空 = 谁都能确认）。 */
    const audience = resolved.audience || {};
    if (audience.roles !== undefined && !Array.isArray(audience.roles)) {
      errors.push('第 8 类 审核人范围写得不是一个角色列表');
    }
    if (audience.roles !== undefined && Array.isArray(audience.roles) && !audience.roles.length
        && audience.mode !== 'existing-permission') {
      errors.push('第 8 类 审核人范围是空的（既没写角色，也没说沿用既有权限）');
    }

    return { ok: !errors.length, errors, resolved };
  }

  /**
   * **注册一类审核声明**（域用）。
   * 注册失败 ⇒ **不登记**（页面会把具体配置问题摆出来，不许空白降级后照常允许确认）。
   */
  function registerDeclaration(spec) {
    const check = validateDeclaration(spec);
    if (!check.ok) {
      /* —— **失败不许悄悄消失**（PKG-121 · 缺口⑤）：
         域**可以不看返回值**（某个域侧两处就是直接调、不看回值）
         ⇒ 壳自己把失败**记下来**，并（见 `renderDeclarationFailures`）**在页面上摆出来**。
         **为什么这道闸是这次审计查出来的真缺口**：契约 §declaration.note 写的是
         「注册失败 ⇒ 页面会把具体配置问题摆出来」—— 原来**根本没有这条路径**
         ⇒ 域声明写错 ⇒ 那一类审核**人间蒸发**，人只看到「这一类怎么没有」，没人知道是声明坏了。 */
      const failure = {
        key: String((spec && spec.key) || ''),
        name: String((spec && spec.name) || ''),
        errors: check.errors.slice(),
      };
      declarationFailures.push(failure);
      /* 浏览器控制台也留一句（排查时第一眼就能看见）——
         ⚠️ **判据的最小 DOM 桩里没有 console** ⇒ 必须先问一句在不在，不许直接调。 */
      if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
        console.error('审核声明没注册上：' + (failure.key || '（没写 key）'), failure.errors);
      }
      return { ok: false, errors: check.errors };
    }
    /* —— 注册上了 ⇒ 把**同一个 key** 的旧失败撤掉（域改对了再注册一次，
       不许页面上还挂着一句已经不该挂的错话）。 */
    for (let i = declarationFailures.length - 1; i >= 0; i -= 1) {
      if (declarationFailures[i].key === String(spec.key)) declarationFailures.splice(i, 1);
    }
    const admission = spec.review ? String(spec.review) : DEFAULT_BY_KIND[String(spec.kind)];
    const declaration = {
      key: String(spec.key),
      name: String(spec.name),
      kind: String(spec.kind || ''),
      admission,
      order: Number(spec.order) || 50,
      domain: String(spec.domain || ''),
      where: String(spec.where || ''),
      eyebrow: String(spec.eyebrow || ''),
      list: spec.list,
      detail: typeof spec.detail === 'function' ? spec.detail : null,
      accept: spec.accept,
      return: spec.return,
      locate: spec.locate,
      redirect: spec.redirect,
      identity: check.resolved.identity,
      leftSlot: check.resolved.leftSlot,
      rightSlot: check.resolved.rightSlot,
      evidenceBinding: check.resolved.evidenceBinding,
      editable: check.resolved.editable,
      savePolicy: check.resolved.savePolicy,
      precondition: check.resolved.precondition,
      audience: check.resolved.audience,
      handling: check.resolved.handling,
      execution: check.resolved.execution,
    };
    declarations.set(declaration.key, declaration);
    /* —— **告诉已经挂着的页面**：多了一类审核 ⇒ 那一页该重读了。 */
    notifyDeclarationChange(declaration.key);
    scheduleCounts();
    return { ok: true, declaration };
  }

  function unregisterDeclaration(key) {
    declarations.delete(key);
  }

  function declarationList() {
    return Array.from(declarations.values()).sort((a, b) => (a.order || 50) - (b.order || 50));
  }

  /** 进这一页的声明（准入＝evidence）；其余的给一条指路。 */
  function pageDeclarations() {
    return declarationList().filter(item => ADMISSION[item.admission] && ADMISSION[item.admission].inPage);
  }

  /** 不进这一页、但要给指路的声明（context / derived）。 */
  function redirectDeclarations() {
    return declarationList().filter(item => !ADMISSION[item.admission] || !ADMISSION[item.admission].inPage);
  }

  // ========== 公共渲染器（一套渲染器、两个槽位） ==========

  /**
   * **原件本体**（右栏那一栏要摆的是**原件本身**，不是文件名加一段摘录）。
   *
   * **为什么走 fetch＋blob，不直接给 iframe 挂地址**：
   * 文件中心的原件口内核那边发的是 `Content-Disposition: attachment`
   * （`shangshu_core.http_headers.content_disposition()` 的默认值）
   * ⇒ 直接挂地址，浏览器会**下载**而不是在框里显示 ⇒ 必须自己取字节、造 blob 地址。
   * 旧项目那份就是这么做的（`ip-review-center.js` 的 `mountPreview`）。
   *
   * **按需取**（契约 §4「列表不预先加载每份原件」）：这里只画**空框**，
   * 字节等**弹窗打开**后才取（`mountOriginals`）—— 一页几十份待审时不至于几十个并发请求。
   */
  const FILE_CONTENT_PATH = '/api/platform/file-content';
  /* ⚠️ **壳里不写死任何域的表名**（2026-10-23 改）：
     早先这里有个兜底常量（文件中心那张表的 DocType 名）—— 那是**公共壳去猜某个域的内部表名**
     （跨域耦合），域边界那道闸会因此报红，而且报得对。
     ⇒ 现在三元组（ref_doctype / ref_name / file）**只从两处来**：
       ① **声明给的**（域知道自己的表）；
       ② **文件中心版本读口回的**（`files.versions` 每一行都自带 `source` 三元组）。
     两处都没有 ⇒ 这一件**读不出来**（不是「没有地址」）⇒ 那一组不许确认。 */
  /** 原件身份含引用/版本；同 id 换原件不能复用旧字节。 */
  const originalBlobs = new Map();
  /** 取过取不到的原件（取过就不再取，省得反复打网关）。 */
  const originalFailed = new Set();
  const originalReads = new Map();

  function originalKey(item) {
    return JSON.stringify([item && item.id, item && item.type, item && (item.reference || item.file),
      item && item.url, item && item.version, item && item.content_version]);
  }

  async function readOriginal(item, signal) {
    const key = originalKey(item);
    if (originalBlobs.has(key)) return { objectUrl: originalBlobs.get(key) };
    if (originalFailed.has(key)) return { failed: true };
    const existing = originalReads.get(key);
    if (existing && !(existing.signal && existing.signal.aborted)) return existing.promise;
    const entry = { signal, promise: null };
    const ensureActive = () => {
      if (signal && signal.aborted) throw Object.assign(Error('原件读取已取消'), { name: 'AbortError' });
    };
    entry.promise = (async () => {
      try {
        ensureActive();
        const result = await originalUrlOf(item);
        ensureActive();
        if (result.failed) { originalFailed.add(key); return result; }
        if (!result.url) return { empty: true };
        const response = await global.fetch(result.url, signal
          ? { credentials: 'include', signal } : { credentials: 'include' });
        if (!response.ok) throw Error('HTTP ' + response.status);
        const blob = await response.blob();
        ensureActive();
        const objectUrl = global.URL.createObjectURL(blob);
        originalBlobs.set(key, objectUrl);
        /* ⚠️ **名字跟着字节一起回**（PKG-132）：右栏那一栏顶上要摆**文件名**，
           不是文件编号 ⇒ 读口回的名字在这里透出去。 */
        return { objectUrl, name: result.name || '' };
      } catch (error) {
        if (isAbortError(error)) throw error;
        originalFailed.add(key);
        return { failed: true };
      } finally {
        if (originalReads.get(key) === entry) originalReads.delete(key);
      }
    })();
    originalReads.set(key, entry);
    return entry.promise;
  }

  /** 拼文件中心的原件口地址（**不引 URLSearchParams**：判据的最小 DOM 里没有那个全局）。 */
  function fileContentUrl(reference, file) {
    const query = [
      'ref=' + encodeURIComponent(reference.ref_doctype || ''),
      'ref_name=' + encodeURIComponent(reference.ref_name || ''),
      'file=' + encodeURIComponent(file || ''),
    ].join('&');
    return FILE_CONTENT_PATH + '?' + query;
  }

  /**
   * 凭据的原件地址（**声明给什么就用什么**，壳不猜业务）：
   *   ① `url` —— 声明直接给了地址；
   *   ② `reference` 是**受管引用三元组**（ref_doctype / ref_name / file）⇒ 拼原件口；
   *   ③ `reference` 只是**文件编号**（某域的通知书就是这种）⇒ 走**核心域那一份**文件中心
   *      版本读口换出固定版本，再拼原件口。
   *
   * **回三种结果**（不是两种）：
   *   · `{url}`    —— 有地址；
   *   · `{empty}`  —— **没有地址**（声明没给）⇒ 只说明，**不拦这一组**
   *                   （「没有地址」≠「打不开」：声明说它可用就是可用）；
   *   · `{failed}` —— **读不到原件本身**（没权限／被导出闸拦下／文件不在了）
   *                   ⇒ 这一件**打不开** ⇒ **那一组不许确认**（契约 §declaration.ten.4.runtime）。
   */
  async function originalUrlOf(item) {
    if (!item) return { empty: true };
    if (item.url) return { url: String(item.url) };
    const reference = item.reference;
    if (reference && typeof reference === 'object') {
      const file = String(reference.file || '');
      if (!file) return { empty: true };
      /* 受管引用三元组**要齐**：壳**不猜是哪张表** ⇒ 缺 `ref_doctype` ⇒ 这一件读不出来。 */
      const ref_doctype = String(reference.ref_doctype || '');
      if (!ref_doctype) return { failed: true };
      return { url: fileContentUrl({ ref_doctype, ref_name: reference.ref_name }, file) };
    }
    const id = String(reference || item.file || '').trim();
    if (!id) return { empty: true };
    if (typeof global.readFileCenterVersions !== 'function') return { empty: true };
    try {
      const history = await global.readFileCenterVersions(id);
      /* 文件中心的版本读口：当前版本在 `current`，没有就取版本列表的第一个
         （文件中心那一份 `files.versions` 两种形状都给 —— 见 `file-detail.js` 同款取法）。 */
      const versions = history && Array.isArray(history.versions) ? history.versions : [];
      const current = (history && history.current) || versions[0] || {};
      /* ⚠️ **文件名**（PKG-132 · 用户 2026-10-27 截图：右栏顶上摆着「lje8sseiv4」那种
         **文件编号**，人根本看不出是哪一份）⇒ 版本读口**有名字就顺手带出来**，
         弹窗那一栏的标题用它（**读口本来就在读这一份** ⇒ 不多发一个请求）。
         ⚠️ **名字在 `file.file_name` 上**（文件中心那一行的 `name` **就是那个编号**，
         拿它当名字＝把编号又摆一遍）⇒ 优先 `file_name`；**取到的名字若还等于编号，
         宁可空着**（不拿编号冒充名字）。 */
      const fileRow = (history && history.file) || null;
      const rawName = String((fileRow && (fileRow.file_name || fileRow.title || fileRow.name))
        || (current && (current.file_name || current.title || current.name)) || '');
      const name = rawName && rawName !== id ? rawName : '';
      /* 版本行自带**受管引用三元组**（`source`）⇒ 用它，别自己猜是哪张表。 */
      const source = current.source || null;
      const file = String((source && source.file) || current.frappe_file || '');
      if (!file) return { empty: true };
      /* 三元组里的 `ref_doctype` **用读口给的**（读口回的就是受管引用）——
         壳里不写死任何域的表名；读口没给 ⇒ 这一件读不出来。 */
      const ref_doctype = String((source && source.ref_doctype) || '');
      if (!ref_doctype) return { failed: true };
      return {
        url: fileContentUrl({
          ref_doctype,
          ref_name: (source && source.ref_name) || id,
        }, file),
        name,
      };
    } catch (error) {
      return { failed: true };
    }
  }

  /** 原件那一个「框」（PDF ⇒ iframe、图片 ⇒ img、文本 ⇒ pre）。 */
  function originalNode(item, kind) {
    const holder = element('div', 'review-original');
    holder.setAttribute('data-review-original', '1');
    holder.setAttribute('data-review-original-kind', kind);
    holder.setAttribute('data-review-original-item', String(item.id || ''));

    // 原件常驻展开，名称只显示一次，不再提供折叠入口。
    const bar = element('div', 'review-original-bar');
    bar.setAttribute('data-review-original-bar', '1');
    bar.appendChild(element('span', 'review-original-name', plainValue(item.name || '原件')));
    holder.appendChild(bar);

    const body = element('div', 'review-original-body');
    if (kind === 'image') {
      const img = doc.createElement('img');
      img.setAttribute('data-review-original-image', '1');
      img.setAttribute('alt', plainValue(item.name || '原件'));
      body.appendChild(img);
    } else if (kind === 'text') {
      const pre = doc.createElement('pre');
      pre.setAttribute('data-review-original-text', '1');
      body.appendChild(pre);
    } else {
      const frame = doc.createElement('iframe');
      frame.setAttribute('data-review-original-frame', '1');
      frame.setAttribute('title', plainValue(item.name || '原件预览'));
      body.appendChild(frame);
    }
    holder.appendChild(body);

    const note = element('p', 'review-original-failed');
    note.setAttribute('data-review-original-failed', '1');
    note.hidden = true;
    holder.appendChild(note);

    return holder;
  }

  /** 取不到 ⇒ **明写读不出来**（不是显示成「没有证据」）＋ 那一组不许确认。 */
  function failOriginal(holder, note, text) {
    note.textContent = text;
    note.hidden = false;
    holder.setAttribute('data-review-original-state', 'failed');
    const open = holder.closest('[data-review-pdf]');
    const recovery = open && open.querySelector('[data-review-open-original]');
    if (recovery) recovery.hidden = false;
  }

  /** 这一张卡的凭据（按 id 找回来）。 */
  function evidenceOf(card, id) {
    const list = (card && card.evidence) || [];
    return list.find(item => item && String(item.id) === String(id)) || null;
  }

  function disposeOriginalMedia(root) {
    if (!root || typeof global.clearFileMediaPreview !== 'function') return;
    Array.from(root.querySelectorAll('.review-original-body')).forEach(surface => global.clearFileMediaPreview(surface));
  }

  /**
   * **取原件字节**（按需）：弹窗打开后才取；取到过就复用（重画不重取）；取不到不再取。
   */
  async function mountOriginals(root) {
    const card = activeCard(), signal = state.pageSignal || null;
    const holders = root.querySelectorAll('[data-review-original]');
    await Promise.all(Array.from(holders, async holder => {
      const key = String(holder.getAttribute('data-review-original-item') || '');
      const item = evidenceOf(card, key);
      const note = holder.querySelector('[data-review-original-failed]');
      const kind = holder.getAttribute('data-review-original-kind');
      if (kind === 'text') {
        const pre = holder.querySelector('[data-review-original-text]');
        if (pre) pre.textContent = plainValue((item && (item.text || item.excerpt)) || '');
        return;
      }
      try {
        const result = await readOriginal(item, signal);
        // 详情可能已替换卡对象；只更新同卡、同引用且仍挂着的凭据，不触碰换卡后的内容。
        const current = activeCard(), live = evidenceOf(current, key);
        if (!state.modalOpen || state.pageDisposed || !current || !card
            || current.id !== card.id || current.declaration !== card.declaration
            || originalKey(live) !== originalKey(item)
            || !Array.from(state.modal.querySelectorAll('[data-review-original]')).includes(holder)) return;
        if (result.failed) {
          if (live) live.available = false;
          failOriginal(holder, note, '这份原件打不开（预览不可用）—— 依赖它的那一组不许确认；可以关闭后重试。');
          updateSplitProgress();
        } else if (result.empty) {
          failOriginal(holder, note,
            '这份凭据没有可直接预览的原件地址 —— 字段仍以原件为准，可点「在文件中心打开原件」对照。');
        } else {
          /* ⚠️ **原件那一栏顶上要摆文件名，不是文件编号**（PKG-132 · 用户 2026-10-27 截图：
             摆的是「lje8sseiv4」那种编号）⇒ 读口回了真名就换上。
             **只有「现在摆的正是那个编号」时才换**（域自己给了人话名字就不动它）。 */
          const nameNode = holder.querySelector('.review-original-name');
          const bare = String(item.reference || item.file || '').trim();
          if (nameNode && result.name
            && (!nameNode.textContent.trim() || (bare && nameNode.textContent.trim() === bare))) {
            nameNode.textContent = result.name;
          }
          const surface = holder.querySelector('.review-original-body');
          if (kind === 'frame' && String(item.type || '').toLowerCase() === 'pdf' && surface && typeof global.renderFileMediaPreview === 'function') {
            if (holder._reviewOriginalUrl !== result.objectUrl) {
              holder._reviewOriginalUrl = result.objectUrl;
              surface.className += ' review-original-pdfreader';
              global.renderFileMediaPreview(surface, {
                url: result.objectUrl, name: plainValue(result.name || item.name || '原件'), kind: 'pdf',
                current: () => state.modalOpen && !state.pageDisposed
                  && activeCard() && activeCard().id === card.id
                  && originalKey(evidenceOf(activeCard(), key)) === originalKey(item)
                  && Array.from(state.modal.querySelectorAll('[data-review-original]')).includes(holder),
              });
            }
          } else {
            const node = holder.querySelector(kind === 'image'
              ? '[data-review-original-image]' : '[data-review-original-frame]');
            if (node && node.getAttribute('src') !== result.objectUrl) node.setAttribute('src', result.objectUrl);
          }
        }
      } catch (error) {
        // 离页取消不记成业务失败；返回的旧请求不能解锁或阻断另一张卡。
        if (!isAbortError(error)) throw error;
      }
    }));
  }

  /**
   * 这一项**在服务端已经暂存**（域给的 `state === 'staged'`）？
   * ⚠️ **暂存 ≠ 采用 ≠ 保存**（内核 §staged_tier）：暂存只是「我看过、先存着」，
   * **正式值一个字都没改** ⇒ 显示成「已暂存」，**不许**混成「待采用」或「已采用」。
   * ⚠️ **暂存不算「已核对完」**（内核按字面口径）⇒ 底栏的「已核对 N/M」不把它算进去。
   */
  function isStagedChange(change) {
    return String((change && change.state) || '') === 'staged';
  }

  /**
   * **候选值的交互件**：待采用时**呼吸**；单击采用；双击改写（改写后是普通文字＝待保存）。
   * ⚠️ 变色只表示「本地已采用（待保存）」，**不冒充已保存**（契约 §public_rules）。
   */
  function candidateNode(change, ctx) {
    const cell = element('div', 'review-value-cell');
    cell.setAttribute('data-review-change-id', String(change.id));
    const mode = ctx.adoptState(change.id);
    if (mode === 'editing') {
      const input = doc.createElement('textarea');
      input.setAttribute('data-review-edit', '1');
      input.setAttribute('rows', '2');
      input.setAttribute('aria-label', '改写候选值');
      input.value = ctx.editText(change.id);
      let committed = false;
      const commit = () => {
        if (committed || !ctx.isCurrentCard()) return;
        committed = true;
        ctx.commitEdit(change.id, input.value);
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      cell.appendChild(input);
      return cell;
    }
    const staged = isStagedChange(change);
    const text = element('p', 'proposed-text', ctx.textOf(change));
    text.setAttribute('data-review-candidate', '1');
    /* 「已暂存」是**自己的一档**（不是 pending、也不是 adopted）——别混成采用。 */
    text.setAttribute('data-proposal-state', mode === 'pending' ? (staged ? 'staged' : 'pending') : mode);
    text.setAttribute('title', staged ? '已暂存（正式值还没改）· 单击采用，双击改写' : '单击采用，双击改写');
    let beforeClick;
    text.addEventListener('click', event => {
      if (!ctx.isCurrentCard() || event.detail > 1) return;
      beforeClick = ctx.textOf(change);
      ctx.toggleAdopt(change.id);
    });
    text.addEventListener('dblclick', () => {
      if (ctx.isCurrentCard()) ctx.startEdit(change.id, beforeClick);
    });
    cell.appendChild(text);
    return cell;
  }

  /**
   * 格式：字段对比表（**旧项目那套密排字段块**：字段名小字在上一行、候选值在下一行整行；
   * 不做成上下两张对照卡 —— 旧项目那套是「标签在左上是 11px 小字，候选值整行 26px 高」）。
   *
   * ⚠️ **状态集中在底栏**（契约 §4「减少每项重复小字，状态集中在底栏反馈」）——
   *   行内不再挂一串状态小字；行上的钩子保留（外部用例按钩子定位）。
   */
  function renderFieldTable(items, ctx) {
    const box = element('div', 'review-values');
    items.forEach(item => {
      box.appendChild(fieldRow(item, ctx));
    });
    return box;
  }

  /** 字段块**一行**（**平铺那档与分区块那档共用这一套** —— 不许两处各画一遍）。 */
  function fieldRow(item, ctx) {
    const row = element('div', 'review-value-row');
    row.setAttribute('data-review-row', item.id);
    const head = element('div', 'review-field-line');
    head.setAttribute('data-review-field-line', '1');
    const label = element('span', 'review-value-label', item.label || item.name || '');
    label.setAttribute('data-review-row-label', '1');
    head.appendChild(label);
    /* 当前正式值：弱化但可读（契约 §5：当前值与候选值的对比放在左栏内容内部）。 */
    head.appendChild(element('span', 'review-value-before', plainValue(item.before) || '未填写'));
    row.appendChild(head);
    if (item.adoptable === false) {
      row.appendChild(element('p', 'observed-text', plainValue(item.after) || '未填写'));
    } else {
      row.appendChild(ctx.candidate ? ctx.candidate(item) : candidateNode(item, ctx));
    }
    if (item.adoptable !== false) {
      const mark = element('span', 'review-change-state', ctx.rowState(item.id));
      mark.setAttribute('data-review-row-state', '1');
      row.appendChild(mark);
    }
    if (item.note) row.appendChild(element('p', 'review-error', item.note));
    /* —— **域给一个选择，画在这一行里**（通用件；域声明
     *   `item.select = {label, options, value, onChange}`）——
     *   用来做「这一行要人挑一档」（例如「附件组合」那一行：合并／不合并）。
     *   · `options`：`[{value, label}]` **或**一串字符串（字符串 ⇒ 值和名都是它自己）；
     *   · `value`：当前值（不在 `options` 里就摆成第一档）；
     *   · `onChange(value)`：人改了下拉 ⇒ 壳把新值交给域（域自己存、自己在保存时带走）。
     *   ⚠️ **壳不替域决定摆什么选项** ⇒ 域没给就不画。
     *   ⚠️ **这是内核路径**（壳是公共件）⇒ 标 **CORE-CANDIDATE**。 */
    if (item.select && Array.isArray(item.select.options) && item.select.options.length
        && typeof item.select.onChange === 'function') {
      const selectBox = element('div', 'review-row-select');
      const select = doc.createElement('select');
      select.setAttribute('data-review-row-select', '1');
      if (item.select.label) select.setAttribute('aria-label', String(item.select.label));
      item.select.options.forEach(option => {
        const node = doc.createElement('option');
        const isPair = option && typeof option === 'object';
        const value = isPair ? option.value : option;
        const text = isPair ? (option.label === undefined ? option.value : option.label) : option;
        node.value = String(value === undefined || value === null ? '' : value);
        node.textContent = String(text === undefined || text === null ? '' : text);
        select.appendChild(node);
      });
      /* 当前值：**必须在选项摆完之后**再设（浏览器里选不中就不生效）。 */
      const current = item.select.value;
      if (current !== undefined && current !== null) select.value = String(current);
      select.disabled = Boolean(state.busy);
      select.addEventListener('change', () => { item.select.onChange(select.value); });
      selectBox.appendChild(select);
      row.appendChild(selectBox);
    }
    /* —— **域给一个按钮，画在这一行里**（通用件；域声明 `item.button = {label, run}`）——
     *   用来做「这一行缺什么 ⇒ 就在这一行里补」（例如「附件齐备」那一行里给一个「上传」）。
     *   ⚠️ **壳不替域决定放什么按钮** ⇒ 域没给就不画。
     *   ⚠️ **这是内核路径**（壳是公共件）⇒ 标 **CORE-CANDIDATE**。 */
    if (item.button && item.button.label && typeof item.button.run === 'function') {
      const rowButton = element('button', 'btn btn-ghost btn-sm', String(item.button.label));
      rowButton.type = 'button';
      rowButton.setAttribute('data-review-row-button', '1');
      rowButton.disabled = Boolean(state.busy);
      rowButton.addEventListener('click', () => { void item.button.run(); });
      row.appendChild(rowButton);
    }
    return row;
  }

  /**
   * 左栏的**分区块**（契约十类第 2 类里的「**内容分组与顺序**」）。
   *
   * 旧项目那套（`示例企业知识产权/开发/尚书管理系统/shangshu-web/js/domains/ip/ip-review-center.js`
   *   第 298／306 行）：
   *   `<section class="fr-zone" data-review-zone="file"><h3>文件字段</h3><div class="fr-grid">…`
   *   `<section class="fr-zone" data-review-zone="case"><h3>案件更新 …</h3>…`
   * ⇒ **每一块自带小标题** —— 人一眼看得出「这一项属于哪一块」。
   *
   * ⚠️ **分组是声明给的**（`leftSlot.groups` ＝ `[{key,title,order}]`；每一项用 `group` 指组）
   *   —— **壳不替域猜分组**：没给 ⇒ **一列平铺**（别的域一个字不变）。
   * ⚠️ **没指组的那一项照样显示**（排在最后那个不带小标题的块里）—— **不许漏项**。
   */
  function renderLeftGroups(items, ctx, groups) {
    const list = groups.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const known = new Set(list.map(group => group.key));
    const buckets = new Map();
    const loose = [];
    (items || []).forEach(item => {
      const key = item && item.group;
      if (key && known.has(key)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
      } else {
        loose.push(item);
      }
    });
    const box = element('div', 'review-zones');
    list.forEach(group => {
      const rows = buckets.get(group.key) || [];
      /* 空组不画（画个空壳＝给人看一个没内容的区）。 */
      if (!rows.length) return;
      box.appendChild(zoneNode(group, rows, ctx));
    });
    if (loose.length) box.appendChild(zoneNode(null, loose, ctx));
    return box;
  }

  function zoneNode(group, rows, ctx) {
    const zone = element('section', 'review-zone');
    if (group) {
      zone.setAttribute('data-review-zone', group.key);
      if (group.title) {
        const title = element('h3', 'review-zone-title', group.title);
        title.setAttribute('data-review-zone-title', group.key);
        zone.appendChild(title);
      }
    } else {
      zone.setAttribute('data-review-zone-ungrouped', '1');
    }
    const values = element('div', 'review-values');
    rows.forEach(item => values.appendChild(fieldRow(item, ctx)));
    zone.appendChild(values);
    return zone;
  }

  /** 格式：邮件（发件人/收件人/主题/正文片段/附件）—— 左右都能用。 */
  function renderEmail(items, ctx) {
    const box = element('div', 'review-emails');
    items.forEach(item => {
      const card = element('div', 'review-email');
      card.setAttribute('data-review-email', item.id);
      const head = element('div', 'review-email-head');
      head.appendChild(element('span', 'review-email-from', plainValue(item.from || item.sender || '')));
      head.appendChild(element('span', 'review-email-to', '→ ' + plainValue(item.to || item.recipient || '')));
      card.appendChild(head);
      if (item.subject) card.appendChild(element('p', 'review-email-subject', plainValue(item.subject)));
      if (item.body) card.appendChild(element('p', 'review-email-body', plainValue(item.body)));
      const files = Array.isArray(item.attachments) ? item.attachments : [];
      if (files.length) {
        const list = element('ul', 'review-email-files');
        files.forEach(file => list.appendChild(element('li', '', plainValue(file.name || file))));
        card.appendChild(list);
      }
      box.appendChild(card);
    });
    return box;
  }

  /** 这一件凭据**用哪种原件件**（PDF ⇒ iframe、图片 ⇒ img、文本 ⇒ pre）。 */
  function kindOf(item) {
    const type = String((item && item.type) || '').toLowerCase();
    if (type === 'image' || type === 'img' || type === 'png' || type === 'jpg') return 'image';
    if (type === 'text' || type === 'txt' || type === 'markdown') return 'text';
    return 'frame';
  }

  /** 格式：正文预览（**原件本体** ＋ 按页 ＋ 命中高亮 ＋ 定位）。 */
  function renderPdf(items, ctx) {
    const box = element('div', 'review-pdfs');
    items.forEach(item => {
      const card = element('div', 'review-pdf');
      card.setAttribute('data-review-pdf', item.id);
      /* **原件本体**（旧项目那套：右栏摆的是原件本身，不是文件名加一段摘录）。
         ⚠️ **每一件按它自己是什么类型摆**（声明说「右栏是正文预览」，
         但那一栏里也可能混着图片／文本件）⇒ 不按槽位一刀切。 */
      card.appendChild(originalNode(item, kindOf(item)));
      /* ⚠️ **「定位：第 N 页 · 首页 · 第 N 段」那一行去掉**（PKG-132 · 用户 2026-10-27 20:31 实拍）：
       *   右栏**摆的是原件本体**（PDF 就嵌在上面）⇒ 再说「第几页第几段」是**重复描述**。
       *   ⇒ 删掉这一行（**不是** CSS 隐藏）；原件里的命中位置由 PDF 自己的阅读器承担。 */
      const locator = item.locator || {};
      if (item.excerpt || item.text) {
        const excerpt = element('p', 'review-pdf-excerpt', plainValue(item.excerpt || item.text));
        excerpt.setAttribute('data-review-highlight', '1');
        card.appendChild(excerpt);
      }
      if (item.available === false) {
        card.appendChild(element('p', 'review-error', '这份凭据打不开 —— 依赖它的那一组不许确认。'));
      } else if (item.degraded) {
        card.appendChild(element('p', 'review-footnote', item.degraded));
      }
      const open = element('button', 'btn btn-ghost btn-sm', '在文件中心打开原件');
      open.type = 'button';
      open.setAttribute('data-review-open-original', '1');
      open.hidden = item.available !== false;
      open.addEventListener('click', () => { ctx.openOriginal(item); });
      card.appendChild(open);
      box.appendChild(card);
    });
    return box;
  }

  /** 格式：图片（**原件本体** ＋ 可放大预览 ＋ 命中区域）。 */
  function renderImage(items) {
    const box = element('div', 'review-images');
    items.forEach(item => {
      const card = element('div', 'review-image');
      card.setAttribute('data-review-image', item.id);
      card.appendChild(originalNode(item, 'image'));
      const region = item.locator && item.locator.region ? item.locator.region : '';
      card.appendChild(element('p', 'review-pdf-locator', region ? '命中区域：' + region : '未标出命中区域'));
      box.appendChild(card);
    });
    return box;
  }

  /** 格式：文本片段（**正文本体** ＋ 命中高亮）。 */
  function renderText(items, ctx) {
    const box = element('div', 'review-texts');
    items.forEach(item => {
      const card = element('div', 'review-text');
      card.setAttribute('data-review-text', item.id);
      if (item.label) card.appendChild(element('p', 'review-value-label', item.label));
      card.appendChild(originalNode(item, 'text'));
      if (item.candidate && ctx.candidate) card.appendChild(ctx.candidate(item));
      box.appendChild(card);
    });
    return box;
  }

  /** 格式：附件清单（文件名 / 大小 / 类型）。 */
  function renderAttachmentList(items) {
    const box = element('div', 'review-attachments');
    items.forEach(item => {
      const row = element('div', 'review-attachment');
      row.setAttribute('data-review-attachment', item.id);
      row.appendChild(element('span', 'review-attachment-name', plainValue(item.name || item.id)));
      const meta = [];
      if (item.size) meta.push(plainValue(item.size));
      if (item.type) meta.push(plainValue(item.type));
      if (meta.length) row.appendChild(element('span', 'review-attachment-meta', meta.join(' · ')));
      box.appendChild(row);
    });
    return box;
  }

  /** 公共渲染器表（契约 §slots.formats）—— 左右两栏共用同一套。 */
  const FORMATS = {
    'field-table': { name: '字段对比表', render: renderFieldTable },
    'email': { name: '邮件', render: renderEmail },
    'pdf': { name: '正文预览', render: renderPdf },
    'image': { name: '图片', render: renderImage },
    'text': { name: '文本片段', render: renderText },
    'attachment-list': { name: '附件清单', render: renderAttachmentList },
  };

  // ========== 数据装配 ==========

  /**
   * **差异判断**（契约 §interaction.no_diff_hidden）：
   *   无差异不展示、不计待审；**未知/失败不能当成相同**。
   */
  function diffOf(change) {
    if (change && change.diff) return String(change.diff);
    const before = change ? change.before : undefined;
    const after = change ? change.after : undefined;
    if (before === undefined || before === null || after === undefined || after === null) return 'unknown';
    return plainValue(before) === plainValue(after) ? 'same' : 'changed';
  }

  /**
   * 把域给的待审数据摆成**凭据级卡片**（一份凭据 ＝ 一组变更）。
   *
   * ⚠️ **域可以回三种形状**（PKG-072-T01 · 内核契约 §data_coverage ＋ PKG-132 的分页契约）：
   * · **老形状**：一个**数组**（＝以前的声明都是这个）⇒ 域把**全部**给了
   *   → 壳**降级自己切片**（`legacy: true`，见 `visibleCards`）。
   * · **中间形状**：`{ cards, notice }` —— 域捎来一句话，但**没给总数**
   *   → 同样按**全量**处理（`legacy: true`）。
   * · **新形状**：`{ cards, total }` —— 域**按 `page`/`pageLength`/`scope` 真的分页**了，
   *   `total` ＝ **那一档的真实总数** → 壳**不再自己切片**（`legacy: false`）。
   * ⇒ **三种都认**（老用法一个字不许破）；**`notice` 原样带出去**（壳不改一个字）。
   */
  function normalizeCards(raw, declaration) {
    const payload = (raw && !Array.isArray(raw) && typeof raw === 'object') ? raw : null;
    const list = payload
      ? (Array.isArray(payload.cards) ? payload.cards : [])
      : (Array.isArray(raw) ? raw : []);
    const notice = String((payload && payload.notice) || '');
    /* —— **有没有真总数**＝「域有没有按新契约分页」的唯一证据：
     *   有 `total`（数字）⇒ 域分页了（`total: 0` 也是合法的：那一档就是空的）；
     *   没有 ⇒ 域给的是**全量**（老形状／中间形状）⇒ 壳自己切片。 */
    const hasTotal = Boolean(payload) && typeof payload.total === 'number' && isFinite(payload.total);
    const legacy = !hasTotal;
    const total = hasTotal ? Math.max(0, Number(payload.total)) : list.length;
    const cards = [];
    list.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const all = Array.isArray(entry.changes) ? entry.changes : [];
      const changes = all
        .map(change => Object.assign({}, change, { diff: diffOf(change) }))
        .filter(change => change.diff !== 'same');     // 无差异不展示
      if (!changes.length && !entry.keepCard) return;   // 空卡不进队列（**除非域说这张卡要摆出来**）
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      cards.push({
        id: String(entry.id || entry.title || ('card-' + cards.length)),
        declaration: declaration.key,
        title: String(entry.title || declaration.name),
        summary: String(entry.summary || ''),
        domain: String(entry.domain || declaration.domain || ''),
        /* **案件号**（域给的）—— 卡上那一行「关联案件：…」就是它。
           ⚠️ 早先这里**没带**（域给了 `caseId`，装配时被丢了）⇒ 卡上只能摆摘要。 */
        caseId: String(entry.caseId || ''),
        /* —— **卡上先把话说完**（PKG-065-T01 · 用户 2026-10-23 拍板）：
           **摘要**（缺哪几格／缴费多少）与**更新时间**是**域给的** ⇒
           **装配时必须带着**（⚠️ 早先 `caseId` 就是在这一步被丢掉的 ⇒ 卡上只能摆摘要；
           这一层是**白名单**装配 ⇒ **域多给一个字段，这里就得加一行**，不然又丢一次）。 */
        digest: String(entry.digest || ''),
        updatedAt: String(entry.updatedAt || ''),
        /* —— **进入审核中心的时间**（PKG-068-T01 · 用户 2026-10-23 22:1x 拍板：
           「给审核中心配一个进入的时间，这一个字段**以后所有的业务域只要往审核中心塞东西
           都记录**，这样一劳永逸」）——
           **这一列是内核给的**（受管记录自带 `creation`）⇒ 域**不用自己加字段**。
           ⚠️ **不许拿 `modified` 顶替**（那是**最后写入**的时间，审一次就变一次）。
           ⚠️ 同样是**白名单装配** —— 域多给一个字段，这里就得加一行。 */
        enteredAt: String(entry.enteredAt || ''),
        /* —— **结论／理由／审核时间**（域自己的词：待审核／通过／驳回）——
           **驳回的卡要显示成只读快照**（标题＋结论＋理由＋时间，无原件、无下载）。 */
        decision: String(entry.decision || ''),
        reason: String(entry.reason || ''),
        reviewedAt: String(entry.reviewedAt || ''),
        state: String(entry.state || 'pending'),
        /* —— **域说「这一张卡没有差异也要摆出来」**（`keepCard`）——
         *   ⚠️ **为什么要有这个**（2026-10-28 15:5x · 用户「通知类型并进归档名称」那一改带出来的）：
         *   「核对这份通知书」那一档的卡**不是差异卡**（没有可比的新旧值）⇒
         *   把「通知类型」并进「归档名称」之后，**没绑案的那张卡就没有任何差异项了**
         *   ⇒ 壳的「空卡不进队列」会把它**丢掉**（人想核的那份通知书就不见了）。
         *   ⇒ 域明确说「这张卡要摆出来」⇒ 壳就不丢。
         *   ⚠️ **这是内核路径**（壳是公共件）⇒ 标 **CORE-CANDIDATE**。 */
        keepCard: Boolean(entry.keepCard),
        changes,
        checks: Array.isArray(entry.checks) ? entry.checks : [],
        evidence,
        raw: entry,
        preconditionKey: String(entry.preconditionKey || entry.caseId || ''),
      });
    });
    /* —— **域明说搜索是不是真在服务端做的**（`searchMode`）——
     *   有就**认域的**（域最清楚它的数据源）；没有就按「总数变没变」那条启发式。 */
    const searchMode = String((payload && payload.searchMode) || '');
    return { cards, notice, legacy, total, searchMode };
  }

  // ========== 取数（scope ＋ 真分页） ==========

  /** 当前看的那一档：`'pending'`（待审）｜`'done'`（已确认）。 */
  function currentScope() {
    return state.listState === 'done' ? 'done' : 'pending';
  }

  /** 那一档里、这一份声明的取数结果（没有就是空）。 */
  function scopeEntry(scope, key) {
    const store = state.scopeStore[scope] || {};
    return store[key] || null;
  }

  /**
   * **向域要某一档的某一页**（PKG-132 · 「服务端真分页」的接线）。
   *
   * **交过去的参数**（与域侧同一份契约，壳**不自创**）：
   * · `page` —— 从 1 起；
   * · `pageLength` —— **这一页要几张**（量得出来就是「这一屏放得下几张」；
   *   量不出来才是默认 12（`CARDS_PER_PAGE`）—— 见 `cardsPerScreen`）；
   * · `scope` —— `'pending'`（待审那一档）｜`'done'`（已确认那一档）；
   * · `q` —— 搜索词（**空字符串**也是交过去的 ⇒ 域自己判断要不要用它）；
   * · `signal` —— 这一页自己的那一把取消信号（原样传下去）。
   *
   * **回包**：新形状 `{ cards, total }`（域真的分页了）｜老形状（数组／没有 total）⇒ 域给的是全量。
   */
  async function requestScope(declaration, scope, page, query) {
    const signal = state.pageSignal || null;
    const request = {
      signal,
      page: Math.max(1, Number(page) || 1),
      pageLength: state.screenCards,
      scope,
      q: String(query == null ? state.search : query || ''),
    };
    const raw = await declaration.list(request);
    const normalized = normalizeCards(raw, declaration);
    return {
      cards: normalized.cards,
      notice: normalized.notice,
      legacy: normalized.legacy,
      total: normalized.total,
      searchMode: normalized.searchMode,
      page: request.page,
    };
  }

  /** 把一份声明那一档的取数结果收进 `scopeStore`（并同步 `state.cards`）。 */
  function storeScopeResult(scope, declaration, result) {
    const store = state.scopeStore[scope] || (state.scopeStore[scope] = {});
    /* —— **正开着的那张卡不许被这一轮抹掉**（列表失败或事项移出范围
     *   不能抹掉正在编辑的快照；旧快照也不能继续提交）。 */
    const opened = state.modalOpen && state.tab === declaration.key ? activeCard() : null;
    const missingOpened = Boolean(opened) && !result.cards.some(card => card.id === opened.id);
    const cards = opened
      ? (missingOpened ? [opened, ...result.cards] : result.cards.map(card => card.id === opened.id ? opened : card))
      : result.cards;
    store[declaration.key] = {
      cards,
      legacy: Boolean(result.legacy),
      total: Number(result.total) || 0,
      searchMode: String(result.searchMode || ''),
      page: Number(result.page) || 1,
      error: '',
    };
    if (missingOpened) {
      const editor = state.editing && candidateCell(state.editing)?.querySelector('[data-review-edit]');
      if (editor) state.edits.set(state.editing, editor.value);
      state.detailError = '当前事项已不在最新待审列表；改写已保留，请重新读取核对或关闭。';
      state.receipt = state.detailError;
      updateSplitProgress();
    }
    state.notices[declaration.key] = result.notice || '';
    /* —— **`state.cards`＝「当前在看的那一档」的卡**（弹窗按它找卡；保存流程也改它）。 */
    if (scope === currentScope()) state.cards[declaration.key] = cards;
  }

  /**
   * **这一档的搜索是「真在服务端做的」还是「前端过滤」** —— **域说了算**。
   *
   * · 域回 `searchMode: 'server'` ⇒ 服务端筛的（真搜索）；
   * · 域回 `searchMode: 'client'` ⇒ 域在自己取回的那份数据里筛的（**前端过滤**，如实说）；
   * · 域**没说** ⇒ 回 `''`（由 `syncPaging` 按「总数有没有变少」那条启发式判）。
   *
   * ⚠️ 「已确认」那一档跨声明 ⇒ **任一声明说是 `client`，这一档就是 `client`**。
   */
  function scopeSearchMode(scope) {
    const store = state.scopeStore[scope] || {};
    const keys = Object.keys(store);
    if (!keys.length) return '';
    let server = '';
    for (const key of keys) {
      const mode = String((store[key] && store[key].searchMode) || '');
      if (!mode) continue;
      if (mode === 'client') return 'client';
      server = 'server';
    }
    return server;
  }

  /**
   * **某一档的真实总数**（分页条上「共 N 张」用的那个数）。
   * · **新形状**（域真的分页了）⇒ **域给的 `total`**（真实总数，**不是这一页取回来的条数**）；
   *   「已确认」那一档跨声明 ⇒ **各声明的真实总数之和**。
   * · **老形状**（域给的是全量）⇒ 壳按那一档自己数（域给的是全量，数出来也是全量）。
   */
  function scopeTotal(scope) {
    const done = scope === 'done';
    const store = state.scopeStore[scope] || {};
    const keys = Object.keys(store);
    if (!keys.length) return 0;
    if (!scopeIsLegacy(scope)) {
      return keys.reduce((sum, key) => sum + (Number(store[key].total) || 0), 0);
    }
    let sum = 0;
    keys.forEach(key => {
      (store[key].cards || []).forEach(card => {
        if (done ? cardIsDone(card) : !cardIsDone(card)) sum += 1;
      });
    });
    return sum;
  }

  /** 那一档是不是**降级路径**（域回老形状 ⇒ 壳自己切片）。 */
  function scopeIsLegacy(scope) {
    const store = state.scopeStore[scope] || {};
    return Object.keys(store).some(key => store[key] && store[key].legacy);
  }

  /** 「已确认」那一档里、某一份声明的**归并缓冲**（它自己那几页的卡 ＋ 指针）。 */
  function doneBuffer(key) {
    let buffer = state.doneBuffers[key];
    if (!buffer) {
      buffer = { cards: [], pointer: 0, nextPage: 1, exhausted: false, total: 0, legacy: false };
      state.doneBuffers[key] = buffer;
    }
    return buffer;
  }

  /**
   * **读一档**（`scope` ＝ 'pending'｜'done'）。
   *
   * · **待审那一档**（`pending`）：**当前声明**（`state.tab`）—— **真服务端分页**：
   *   翻页 ⇒ **重新向域要那一页**（`page` 变）⇒ 壳**不拿旧的全量在前端切**。
   * · **「已确认」那一档**（`done`）：**跨全部声明** —— 域**按声明各自分页**，
   *   壳这边**一份缓冲一份声明**，再**k 路归并**（见下面的说明）。
   *
   * ⚠️ **「已确认」那一档的口径**（今晚交接 §10.1 第 2 行末段要求「如实写清」）：
   *  · 域侧**按声明各自分页**（每份声明回自己那一页 ＋ 自己的 `total`）
   *    → 壳**归并**各声明的页、摆成一条；**总数＝各声明真实总数之和**（真实，不编）。
   *  · **归并怎么做**：每个声明一份**缓冲**（它自己那几页的卡，按进入时间倒序）；
   *    壳做一次 **k 路归并**（每次取各声明当前最新的那张）⇒ 摆出来的是**全局最新的一批**，
   *    不会出现「A 声明的第 13 张被 B 声明的第 1 张挤掉」那种错位。
   *  · ⚠️ **这一档不是「全局意义上的真服务端分页」**：域是**按声明**分页的，
   *    壳这边是**归并后**的一页（页边界由壳按归并结果切）。
   *    **待审那一档才是真服务端分页**（一个声明 ＝ 一份 `page`/`pageLength`/`scope` 请求）。
   */
  async function loadScope(scope, options) {
    const opts = options || {};
    const query = opts.query === undefined ? state.search : opts.query;
    const page = Math.max(1, Number(opts.page) || 1);
    const signal = state.pageSignal || null;
    const generation = ++state.listReadGeneration;
    const declarations = opts.declarations || (scope === 'done'
      ? pageDeclarations()
      : (currentDeclaration() ? [currentDeclaration()] : []));
    if (!declarations.length) return;
    state.loading = true;
    renderListRegion();

    /* —— **收下一份声明的结果**（成功／失败都收）。 */
    const apply = (declaration, outcome) => {
      const store = state.scopeStore[scope] || (state.scopeStore[scope] = {});
      if (outcome.failure) {
        /* —— **所属能力不可用，只阻断它自己**（契约 §configuration.isolation）：
         *   这一片空着并说明白，别的审核照常摆卡、照常能开能存。
         *   ⚠️ **正在编辑的那张卡不许被这一轮抹掉**（列表失败不能抹掉正在编辑的快照；
         *   旧快照也不能继续提交 ⇒ 弹窗里说清「重新读取或关闭」）。 */
        const opened = scope === 'pending' && state.modalOpen && state.tab === declaration.key
          ? activeCard() : null;
        store[declaration.key] = {
          cards: opened ? [opened] : [],
          legacy: false, total: 0, page, error: outcome.failure,
        };
        if (opened) {
          const editor = state.editing && candidateCell(state.editing)?.querySelector('[data-review-edit]');
          if (editor) state.edits.set(state.editing, editor.value);
          state.detailError = '当前事项的最新列表读取失败；改写已保留，请重新读取或关闭。';
          state.receipt = state.detailError;
          updateSplitProgress();
        }
        if (scope === 'pending') state.declErrors[declaration.key] = outcome.failure;
        return;
      }
      if (scope === 'done') {
        const buffer = outcome.buffer;
        store[declaration.key] = {
          cards: buffer.cards,
          legacy: Boolean(buffer.legacy),
          total: buffer.total,
          page: buffer.nextPage - 1,
          error: '',
        };
        state.notices[declaration.key] = '';
        return;
      }
      storeScopeResult(scope, declaration, outcome.result);
      state.counts[declaration.key] = outcome.result.cards
        .reduce((sum, card) => sum + card.changes.length, 0);
      /* —— **当前在看的那一档有数据了 ⇒ 就不是「正在读取」**（PKG-132 · 视觉/时效）——
       *   原来 `state.loading` 要等**全部声明**都回来才清（`mountPage` 里 await 之后）
       *   ⇒ 慢的那一档没回来之前，**页头一直挂着「正在读取…」**，
       *      即使快的那一档卡已经摆出来了（2026-10-27 真页面实测：4 秒还停在「正在读取…」）。
       *   ⇒ 现在：**当前档一有数据就清**；其余档的牌照旧一片片补进来，
       *      **不再让慢的那一档把整页卡在加载态**。 */
      if (scope === 'pending' && declaration.key === state.tab) state.loading = false;
    };

    /* —— **这一轮每份声明各拿一份结果**（收下就画 ⇒ 快的先能用）。 */
    await Promise.all(declarations.map(async declaration => {
      let outcome;
      if (scope === 'done') {
        /* —— 「已确认」那一档：缓冲不够一页就**再问域要下一页**（要到底为止）。 */
        const buffer = doneBuffer(declaration.key);
        let failure = '';
        while (buffer.cards.length - buffer.pointer < state.screenCards && !buffer.exhausted) {
          let result;
          try {
            result = await requestScope(declaration, 'done', buffer.nextPage, query);
          } catch (error) {
            if (isAbortError(error)) return { aborted: true };
            failure = '这一类暂时读不出来（所属能力不可用）—— 其他审核照常用。';
            buffer.exhausted = true;
            break;
          }
          buffer.nextPage += 1;
          buffer.total = Number(result.total) || 0;
          buffer.legacy = Boolean(result.legacy);
          if (result.legacy) {
            /* —— **老形状**：域给的是全量 ⇒ 缓冲一次到位。 */
            buffer.cards = buffer.cards.concat(result.cards);
            buffer.exhausted = true;
          } else if (!result.cards.length) {
            buffer.exhausted = true;
          } else {
            buffer.cards = buffer.cards.concat(result.cards);
            if (result.cards.length < state.screenCards) buffer.exhausted = true;
          }
          buffer.cards.sort(byEnteredAtDesc);
        }
        outcome = { buffer, failure };
      } else {
        /* —— 待审那一档：**一次请求＝那一页**（真服务端分页）。 */
        try {
          outcome = { result: await requestScope(declaration, 'pending', page, query) };
        } catch (error) {
          if (isAbortError(error)) return { aborted: true };
          /* —— **所属能力不可用，只阻断它自己**（契约 §configuration.isolation）——
           *   这一片空着并说明白，别的审核照常摆卡、照常能开能存。 */
          outcome = { failure: '这一类暂时读不出来（所属能力不可用）—— 其他审核照常用。' };
        }
      }
      /* —— **人已经离开这一页** ⇒ 这一轮的结果**作废**（旧页的卡不许被这一轮改写）。 */
      if (generation !== state.listReadGeneration || (signal && signal.aborted)) return { aborted: true };
      apply(declaration, outcome);
      /* —— **一个来源返回即可用；不能等待其他来源**（快的先能用 ⇒ 慢的那份不挡人）。 */
      if (scope === 'pending') {
        renderListRegion();
        renderDecks();
      }
      return outcome;
    }));
    /* —— **人已经离开这一页** ⇒ 这一轮的结果**作废**（旧页的卡不许被这一轮改写）。 */
    if (generation !== state.listReadGeneration || (signal && signal.aborted)) return;

    /* —— **这一档摆出来的是哪一页**：
     *   · 待审那一档 ＝ 域刚给的那一页（**不再自己切片**）；
     *   · 「已确认」那一档 ＝ **归并**出来的一页（见 `mergeDoneCards`）。 */
    if (scope === 'done') {
      if (scopeIsLegacy('done')) {
        /* —— **降级路径**：域给的是全量 ⇒ 每次都从头归并，再由壳自己切页。
         *   ⚠️ 老形状给的是**全量**（待审＋已审都有）⇒ 归并后要**按这一档筛一遍**。 */
        state.donePages[page] = mergeDoneCards(0).cards.filter(card => cardIsDone(card));
      } else {
        const merged = mergeDoneCards(state.screenCards);
        merged.buffers.forEach((buffer, index) => { buffer.pointer += merged.used[index]; });
        state.donePages[page] = merged.cards;
      }
    }
    const paging = state.paging[scope];
    paging.page = page;
    paging.legacy = scopeIsLegacy(scope);
    paging.total = scopeTotal(scope);
    if (!String(query || '').trim()) {
      paging.totalAll = paging.total;
      /* —— **没带搜索词** ⇒ 这一轮不是「前端过滤兜底」，把那个标记清掉。 —— */
      paging.clientFilter = false;
    }
    paging.pages = Math.max(1, Math.ceil((paging.total || 0) / state.screenCards));
    state.cardPage = Math.max(1, Math.min(page, paging.pages));
    state.loading = false;
    renderListRegion();
    renderDecks();
  }

  /**
   * **这一页从头读一遍**（进页面／刷新）：两个 scope 都从头来（页码归 1、缓冲清空）。
   */

  async function load(force) {
    const ttl = 60000;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < ttl && Object.keys(state.cards).length) {
      return state.counts;
    }
    state.loading = true;
    state.error = '';
    /* —— **这一页自己的那一把取消信号**（R07 · P1）——
       换页时上游会 `abort()` 它 ⇒ 域的读**原样带上它** ⇒ 人一离开这一页，
       那一页发出去的每一个读**真的被掐掉**（不是让它跑到底）。
       ⚠️ **原样传下去**（传的就是它那一个）⇒ 上游 `fetch` 收到的 `init.signal`
       与页面那一把**是同一个对象**。 */
    const signal = state.pageSignal || null;
    const decls = pageDeclarations();
    state.declErrors = {};
    /* —— **重新读一遍 ⇒ 两档都从头来**（页码归 1、缓冲清空）。 */
    state.cardPage = 1;
    state.paging.pending.page = 1;
    state.paging.done.page = 1;
    state.doneBuffers = {};
    state.donePages = {};
    /* —— **待审那一档**：全部声明都读（页头右上的分档片要各声明的件数）
     *   ⇒ 请求带 `scope:'pending'` ＋ `page:1` ＋ `pageLength`（**真服务端分页**）。
     * ⚠️ **「已确认」那一档不在这里读**（那一档跨全部声明，且**多数时候没人看**）：
     *   切到那一档时再读（见 `selectDeck`）⇒ 进这一页仍然**每个声明只读一趟**。 */
    await loadScope('pending', { page: 1, declarations: decls, query: state.search });
    /* —— **人已经离开这一页** ⇒ 这一轮的结果**作废**（旧页的卡不许被这一轮改写）。 */
    if (state.pageDisposed || (signal && signal.aborted)) return state.counts;
    /* —— **`state.cards`＝当前在看的那一档**（弹窗按它找卡）。 */
    syncScopeCards(currentScope());
    state.loading = false;
    state.loadedAt = Date.now();
    pickDeckWithWork();
    renderPageView();
    return state.counts;
  }

  /** 某一档里、某一份声明的卡（**新形状**：域已经按 scope 筛过了；**老形状**：壳自己筛）。 */
  function scopeFilteredCards(scope, key) {
    const entry = scopeEntry(scope, key);
    if (!entry) return [];
    const cards = entry.cards || [];
    if (!entry.legacy) return cards;
    const done = scope === 'done';
    return cards.filter(card => (done ? cardIsDone(card) : !cardIsDone(card)));
  }

  /**
   * **落在「有活的那一片」**（PKG-071-T01 · 2026-10-24 夜班自己上站真点出来的）。
   *
   * **为什么**：站上分档片是「更新 0 ／ 待核对 1 ／ 已确认 33」，而进页面默认落在
   * **第一片（0 张卡）** ⇒ 整页只写「当前范围没有记录」⇒ **用户以为没有待办**
   * （真正那张待审灰卡在第二片里，点一下才看得见）。
   *
   * **规矩（三条，别越线）**：
   *  ① **用户自己点过片** ⇒ **不挪**（他选的那一档是他要的）；
   *  ② 当前那一片**本来就有未处理的卡** ⇒ **不挪**；
   *  ③ 「已确认」那一片**永远不作为落点**（它是已审过的历史，不是活）。
   */
  function pickDeckWithWork() {
    if (state.deckPinned) return;
    const current = scopeFilteredCards('pending', state.tab);
    if (current.length) return;                      /* ② 当前那一片有活 ⇒ 别动 */
    const target = pageDeclarations().find(declaration =>
      scopeFilteredCards('pending', declaration.key).length);
    if (!target || target.key === state.tab) return;
    state.tab = target.key;
    state.listState = 'pending';
    state.receipt = '';
  }

  function currentDeclaration() {
    return declarations.get(state.tab) || null;
  }

  function ensureTabVisible() {
    const visible = pageDeclarations();
    if (!visible.length) { state.tab = ''; return; }
    if (!visible.some(item => item.key === state.tab)) state.tab = visible[0].key;
  }

  /**
   * **壳内置的那一档「AI 建议修改」撤了**（PKG-068-T01 · 用户 2026-10-23 22:1x 拍板：
   * 「**「AI 建议」那块整个去掉**（数字块 ＋ 那条「去处理」指路行都去掉 ——
   * **对话里就看得见没审的卡**）」）。
   *
   * ⇒ ① 页面上**没有**「AI 建议」那片、**没有**那条「去处理」指路行；
   * ⇒ ② 这一页**不再去读**公共提案口（少一次请求）。
   *
   * ⚠️ **指路那一套机制留着**（契约 §admission.kinds.context.redirect）：
   *   域**自己**注册 context/derived 声明时，仍然给一条指路 —— 那是契约要求的，
   *   与「壳不再内置一档 AI 建议」是两件事。
   */

  // ========== 页面 ==========

  /**
   * **分档片**（PKG-068-T01 · 用户 2026-10-23 22:13～22:18 拍板）：
   * **顶部页头右上**摆一片（不是另起一行）——
   * · **域给的每一档（进这一页的声明）一片**（**不写死三个**：域给几档就显示几档）；
   * · **「已确认」是一片**，与「新通知书更新」那些**平级、永远都在**；
   * · 每片带**件数＝卡张数**（不是「几条变更」）；
   * · **点片＝筛那一类**。
   *
   * ⚠️ **「AI 建议」那块整个没有**（数字块 ＋ 那条「去处理」指路行都去掉 ——
   *   对话里就看得见没审的卡，页面上再摆一块是重复）。
   */
  const DONE_DECK = '__done__';

  function deckList() {
    const decks = pageDeclarations().map(declaration => ({
      key: declaration.key,
      name: declaration.name,
      kind: declaration.kind || 'automation',
    }));
    /* 「已确认」永远是最后一片（与域给的那几档平级）。 */
    decks.push({ key: DONE_DECK, name: '已确认', kind: 'done' });
    return decks;
  }

  /**
   * **「已确认」那一档的件数**（跨全部声明）。
   *  · **老形状**（域给的是全量）⇒ 全量里就有已审卡 ⇒ 壳自己数（**不用额外读一趟**）；
   *  · **新形状**（域真的按 scope 分页了）⇒ 那一档的件数**要等那一档读过**才有
   *    ⇒ 没读过就**说不知道**（片上写「…」，**不拿 0 冒充**）。
   */
  function doneCardCount() {
    const doneStore = state.scopeStore.done || {};
    if (Object.keys(doneStore).length) return scopeTotal('done');
    const pendingStore = state.scopeStore.pending || {};
    let sum = 0;
    let known = false;
    Object.keys(pendingStore).forEach(key => {
      const entry = pendingStore[key];
      if (!entry || !entry.legacy) return;
      known = true;
      (entry.cards || []).forEach(card => { if (cardIsDone(card)) sum += 1; });
    });
    return known ? sum : null;
  }

  /**
   * 一片上有几张卡（**卡张数**）；**不知道就说不知道**（`null` ⇒ 片上写「…」）。
   * ⚠️ **用那一档的**真实总数**（域给的 `total`）—— 不是这一页取回来的条数。
   */
  function deckCardCount(deckKey) {
    if (deckKey === DONE_DECK) return doneCardCount();
    /* 域给的那几档 ＝ **待审**那一档里这一份声明的真实总数。 */
    const entry = scopeEntry('pending', deckKey);
    if (!entry) return null;
    if (!entry.legacy) return Number(entry.total) || 0;
    return (entry.cards || []).filter(card => !cardIsDone(card)).length;
  }

  function deckIsActive(deckKey) {
    if (deckKey === DONE_DECK) return state.listState === 'done';
    return state.listState !== 'done' && state.tab === deckKey;
  }

  function renderDecks() {
    const host = state.deckHost;
    if (!host) return;
    clear(host);
    deckList().forEach(deck => {
      const chip = element('button', 'review-deck review-source-' + deck.kind);
      chip.type = 'button';
      chip.setAttribute('data-review-deck', deck.key);
      if (deckIsActive(deck.key)) chip.setAttribute('data-review-active', '1');
      const name = element('span', 'review-deck-name', deck.name);
      name.setAttribute('data-review-deck-name', '1');
      chip.appendChild(name);
      /* —— **件数不知道就说不知道**（`null` ⇒ 写「未知」）：拿 0 冒充会让人以为「没有待办」。
       * ⚠️ **不再写「…」**（用户 2026-10-28 08:55 批注：「这个展开吧，无论如何，就不截断了」）：
       *    省略号**看着像被截断**（他截图里是「已确认 …」）⇒ 改成把「不知道」**说完整**。 */
      const number = deckCardCount(deck.key);
      const count = element('span', 'review-deck-count', number === null ? '未知' : String(number));
      count.setAttribute('data-review-deck-count', '1');
      /* —— **这一类所属能力不可用 ⇒ 那一片标「不可用」**（PKG-099 · G9）：
         摆「0 张」会让人以为「没有待办」（跟审核中心空队列那次一样误导）。 */
      if (state.declErrors[deck.key]) count.textContent = '不可用';
      chip.appendChild(count);
      chip.addEventListener('click', () => { void selectDeck(deck.key); });
      host.appendChild(chip);
    });
  }

  /** 点片：换那一档。 */
  async function selectDeck(key) {
    state.receipt = '';
    /* **用户自己点过片 ⇒ 那一档就是他选的**（PKG-071-T01）⇒ 不许再被自动挪走。 */
    state.deckPinned = true;
    if (key === DONE_DECK) {
      state.listState = 'done';
    } else {
      if (!declarations.has(key)) return;
      state.tab = key;
      state.listState = 'pending';
    }
    /* —— **每一档各记各的页码**（`state.paging[scope].page`）。 */
    const scope = currentScope();
    state.cardPage = Math.max(1, Number(state.paging[scope].page) || 1);
    syncScopeCards(scope);
    render();
    /* —— **那一档还没读过** ⇒ 现去读（带 `scope`／`page`／`pageLength`）。 */
    if (!Object.keys(state.scopeStore[scope] || {}).length) {
      await loadScope(scope, { page: state.cardPage, query: state.search });
      syncScopeCards(scope);
      renderListRegion();
      renderDecks();
    }
  }

  /** 不进这一页的声明：给一条**指路**（契约 §admission.kinds.context.redirect）。 */
  function renderRedirectRows(body) {
    redirectDeclarations().forEach(declaration => {
      const row = element('div', 'review-agent-jump');
      row.setAttribute('data-review-redirect', declaration.key);
      row.appendChild(element('span', 'review-agent-jump-title', declaration.name));
      row.appendChild(element('span', 'review-agent-jump-count', String(state.counts[declaration.key] || 0) + ' 条待处理'));
      row.appendChild(element('span', 'review-agent-jump-text', declaration.where || AGENT_TEXT));
      const jump = element('button', 'btn btn-ghost btn-sm', '去处理');
      jump.type = 'button';
      jump.setAttribute('data-review-redirect-go', '1');
      jump.addEventListener('click', () => { void redirectTo(declaration); });
      row.appendChild(jump);
      body.appendChild(row);
    });
  }

  async function redirectTo(declaration) {
    if (typeof declaration.redirect === 'function') { await declaration.redirect(); return; }
    if (typeof declaration.locate === 'function') { await declaration.locate(); return; }
    if (typeof global.chatSetMode === 'function') global.chatSetMode('float');
  }

  /** 卡片：不点开也要知道**要不要现在看**。 */
  /**
   * 卡片的**类型块**（原版那张卡左上角那个小方块＝文件扩展名）。
   * 优先用凭据文件名的扩展名（`专利权终止通知书.pdf` ⇒ `PDF`）；没有文件名就用凭据类型。
   */
  function cardTypeLabel(card) {
    const evidence = (card && card.evidence) || [];
    const first = evidence[0] || {};
    const name = String(first.name || '');
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
      const ext = name.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,6}$/.test(ext)) return ext.toUpperCase();
    }
    const byType = {
      pdf: 'PDF', image: '图片', text: '文本', email: '邮件',
      attachment: '附件', 'attachment-list': '附件',
    };
    return byType[String(first.type || '')] || '原件';
  }

  /**
   * 卡片：**照原版那张卡**（用户 2026-10-23 10:1x：「卡片信息太多了，去看看原版的那个卡片」）。
   *
   * 原版（旧项目实际文件审核页 `.fr-file-card`）只有 5 样：
   * **图标 ＋ 标题／类型·大小／上传时间／关联案件／动作**。
   * 我们照那一档：**类型块 ＋ 凭据名 ＋ 状态／类型 · 共 N 项待核对／关联案件／动作**。
   *
   * ⛔ **撤掉的**（正是「信息太多」的来源）：
   *   · **字段对照表**（现值→候选值那几行）—— 逐项核对是**弹窗左栏**的活；
   *   · **凭据逐条名**（「凭据：xxx.pdf」）—— 原件在**弹窗右栏**；
   *   · **域标签行** —— 弹窗表头里已有一枚徽标；**摘要行** —— 案件与项数已经单列。
   */
  /**
   * **驳回的卡**（PKG-068-T01 · 用户 2026-10-23 22:1x 拍板）：
   * 「**驳回的卡点不开**，只显示快照（标题＋结论＋理由＋时间），无原件、无下载」
   * ⇒ **表明不可更改**（已经退回过了，改它没有意义，也不该让人误以为还能改）。
   *
   * ⚠️ 判据用的是**壳自己的状态词** `rejected`（域把「驳回」映射过来）⇒
   *   壳**不写死任何域的中文词**（域自己的词摆在卡上：结论那一枚）。
   */
  function cardIsRejected(card) {
    return String((card && card.state) || '') === 'rejected';
  }

  /** 状态那一枚：**域给了结论就用域的词**（待审核／通过／驳回）⇒ 没给才用壳的词表。 */
  function cardStateLabel(card) {
    const decision = plainValue((card && card.decision) || '');
    return decision || stateLabel(card && card.state);
  }

  function renderCard(card) {
    const declaration = declarations.get(card.declaration);
    const article = element('article', 'review-card');
    article.setAttribute(CARD_ATTR, card.id);
    if (declaration) article.setAttribute('data-review-declaration', declaration.key);
    const rejected = cardIsRejected(card);
    article.setAttribute('data-review-card-state', String(card.state || 'pending'));
    if (rejected) article.setAttribute('data-review-card-rejected', '1');

    const typeLabel = cardTypeLabel(card);

    const head = element('div', 'review-card-head');
    const icon = element('span', 'review-card-icon', typeLabel);
    icon.setAttribute('data-review-card-icon', '1');
    head.appendChild(icon);
    const title = element('h3', 'review-card-title', card.title);
    title.setAttribute('data-review-card-title', '1');
    /* —— **长名字截断两行**（样式在 `review-center.css`）⇒ 悬停看全文。 */
    title.setAttribute('title', card.title);
    head.appendChild(title);
    head.appendChild(element('span', 'review-item-state', cardStateLabel(card)));
    article.appendChild(head);

    /* —— **正文区**（PKG-087-T01 · 用户 2026-10-24 13:1x 站上截图原话：
       「这个卡片也排版一下，要分区分字重，现在像都堆在上面一样」）——
       **先说「要核什么」（摘要），再摆杂项**（类型·件数／关联案件／两个时间）。
       ⚠️ 原来的排法是**杂项在前、摘要在后** ⇒ 一眼扫过去先看见一堆不相干的
       ⇒ 那张卡看着像「一摞字堆在上面」。 */
    const body = element('div', 'review-card-body');

    /* —— **卡上先把话说完**（PKG-065-T01 · **用户 2026-10-23 拍板**：
       「卡上先给摘要（缺哪几格/缴费多少/更新时间）」）——
       **域给了才显示**（没给就不显示 ⇒ **不编、不留空行**）。
       ⚠️ **摘要那一行是人话**（域写什么这里就印什么）⇒ 人**不点进去就知道要核什么**。
       ⚠️ **契约 §4 已经要求卡片带「更新时间及必要异常」** ⇒ 这一行不是新花样，是补齐。
       ⚠️ **2026-10-27（PKG-132 ·「外框固定／卡片同页等高」）：长文截断 ＋ 可展开** ——
       一张卡的长摘要**不许把整行卡都撑高**（同页等高 ＝ 一张卡高、整行都高）
       ⇒ 摘要**默认截断三行**（样式在 `review-center.css`）；
       **点一下展开**（再点收回去）；悬停看全文（`title`）。 */
    const digest = plainValue(card.digest || '');
    if (digest) {
      const digestLine = element('p', 'review-card-digest', digest);
      digestLine.setAttribute('data-review-card-digest', '1');
      digestLine.setAttribute('title', digest);
      digestLine.addEventListener('click', () => {
        if (article.getAttribute('data-review-card-expanded') === '1') {
          article.removeAttribute('data-review-card-expanded');
        } else {
          article.setAttribute('data-review-card-expanded', '1');
        }
      });
      body.appendChild(digestLine);
    }

    /* 杂项元信息（原版的「类型 · 大小」那一行 ⇒ 我们是「类型 · 共几项待核对」）。 */
    body.appendChild(element('p', 'review-card-meta',
      typeLabel + ' · 共 ' + card.changes.length + ' 项待核对'));

    /* 关联案件（原版那块灰底）；没有案件时这一行摆摘要。 */
    /* ⚠️ 标签用**「绑定案件」**（用户 2026-10-27 20:31：「还有绑定案件在哪里呢？」）
       —— 这一行**就是**「这份通知书绑在哪一个案件上」⇒ 标签要说人话。 */
    const caseLine = element('p', 'review-card-case',
      card.caseId ? '绑定案件：' + card.caseId : (card.summary || ''));
    if (caseLine.textContent) body.appendChild(caseLine);

    /* —— **进入审核中心的时间**（PKG-068-T01 · 用户 2026-10-23 22:1x 拍板：
       「你只要在卡片上显示一下进审核中心的时间就行」）——
       **这一列是内核给的**（受管记录自带 `creation`）⇒ 域不用自己加字段；
       **域没给就不显示**（不编、不留空行）。
       ⚠️ **只印到秒**（`timeToSecond`）—— 内核给的是带微秒的原始时间，
       印到卡上要让业务方看得懂。 */
    const enteredAt = timeToSecond(card.enteredAt || '');
    if (enteredAt) {
      const enteredLine = element('p', 'review-card-entered', '进入审核中心：' + enteredAt);
      enteredLine.setAttribute('data-review-card-entered', '1');
      body.appendChild(enteredLine);
    }
    const updatedAt = timeToSecond(card.updatedAt || '');
    if (updatedAt) {
      const updatedLine = element('p', 'review-card-updated', '更新：' + updatedAt);
      updatedLine.setAttribute('data-review-card-updated', '1');
      body.appendChild(updatedLine);
    }

    /* —— **驳回的卡＝只读快照**（标题＋结论＋理由＋时间）——
       **没有「打开核对」** ⇒ 点不开、没有原件、没有下载。 */
    if (rejected) {
      const reason = plainValue(card.reason || '');
      if (reason) {
        const reasonLine = element('p', 'review-card-reason', '理由：' + reason);
        reasonLine.setAttribute('data-review-card-reason', '1');
        article.appendChild(reasonLine);
      }
      const reviewedAt = timeToSecond(card.reviewedAt || '');
      if (reviewedAt) {
        const reviewedLine = element('p', 'review-card-reviewed', '审核：' + reviewedAt);
        reviewedLine.setAttribute('data-review-card-reviewed', '1');
        body.appendChild(reviewedLine);
      }
      article.appendChild(body);
      return article;
    }

    article.appendChild(body);
    const actions = element('div', 'review-actions');
    const open = element('button', 'btn btn-pri btn-sm', '打开核对');
    open.type = 'button';
    open.setAttribute('data-review-card-open', '1');
    open.addEventListener('click', () => { void openCard(card.declaration, card.id); });
    actions.appendChild(open);
    article.appendChild(actions);
    return article;
  }

  /**
   * **域捎来的那句话**（PKG-072-T01 · 内核契约 §data_coverage）——
   * **壳只原样显示**：不自己拼、不改一个字、**不许出现任何域的表名/动作号**。
   * · 「已确认」那一档跨全部声明 ⇒ 那一片的话**都摆**；
   * · 待审那一档只看当前声明 ⇒ 只摆当前那一片的话；
   * · **同一句话只摆一次**（几个声明说同一句时不重复刷屏）。
   *
   * ⚠️ **摆在哪**：`renderParts` 里、**卡片区上面**（`container` 里、`body` 之前）。
   *   交代保持在卡片网格上方，避免占用卡位；卡片按页、多行排列。
   */
  function renderNotices(host) {
    const keys = state.listState === 'done'
      ? Object.keys(state.notices || {})
      : [state.tab];
    const seen = new Set();
    keys.forEach(key => {
      const text = String((state.notices || {})[key] || '');
      if (!text || seen.has(text)) return;
      seen.add(text);
      const note = element('p', 'review-center-notice', text);
      note.setAttribute('data-review-notice', '1');
      host.appendChild(note);
    });
  }

  /**
   * **声明注册失败 ⇒ 摆出来**（PKG-121 · 缺口⑤）。
   *
   * **为什么必须有这一段**（原来没有 ⇒ 是这次审计查出来的真缺口）：
   *   域声明写错了 ⇒ 那一类审核**根本没注册** ⇒ 页面上**不出现**
   *   ⇒ 人只看到「这一类怎么没有」，**没人知道是声明坏了**。
   *   契约 §declaration.note 早就写着「注册失败 ⇒ 页面会把具体配置问题摆出来」，
   *   但壳里**从来没有这条路径**（`registerDeclaration` 只**返回** `{ok:false, errors}`）。
   *
   * **摆在哪**：跟「交代」那一排同层、**卡片区上面**（`container` 里、`body` 之前）
   *   —— 人先看见「有一类审核没注册上」，才知道「我在页面上找不到它」不是自己漏看了。
   * ⚠️ 配置错误保持在卡片网格上方，不占卡位。
   */
  function renderDeclarationFailures(host) {
    if (!declarationFailures.length) return;
    const box = element('div', 'review-decl-failures');
    box.setAttribute('data-review-decl-failures', '1');
    declarationFailures.forEach(failure => {
      const title = failure.name || failure.key || '（没写名字的声明）';
      const note = element('p', 'review-error',
        '「' + title + '」这一类审核**没注册上** ⇒ 它不会出现在这里。问题：'
        + failure.errors.join('；'));
      box.appendChild(note);
    });
    host.appendChild(box);
  }

  /**
   * **状态区**（搜索／交代／失败提示／加载提示那一块）。
   *
   * ⚠️ **加载提示在这一块，不在卡片网格里**（今晚交接 §10.1 第 3 行「加载提示不占卡位」）：
   *   「正在读取…」以前是 **append 进卡片网格**的 ⇒ 它占掉一整行、把下面的卡往下挤，
   *   而且网格那一行的宽度是按卡算的 ⇒ 加载态一进来整页的版式就变了。
   *   ⇒ 现在：**加载提示独占状态区的一块**（不占任何卡片格子）。
   */
  function renderStatus(host) {
    if (!host) return;
    clear(host);
    ensureTabVisible();
    /* —— **加载态**（独立一块，不占卡位）。
     *   ⚠️ **不许用文字**（契约 `loading-state-v1.json` · 用户 2026-10-28 指示）——
     *   原来这里写的是一句「正在读取…」⇒ **撤掉**，换成一块**会呼吸的**灰条。
     *   读屏那一层留一句「正在读取…」（公共类 `.platform-skeleton-status`：视觉上收起来）——
     *   读屏的人看不见灰条的起伏，得有一句话告诉他「在等」。 */
    if (state.loading) {
      const note = element('div', 'review-center-loading');
      note.setAttribute('data-review-loading', '1');
      note.setAttribute('data-skeleton', 'loading-line');
      const bar = element('span', 'platform-skeleton-bar review-skeleton-loading-bar');
      bar.setAttribute('aria-hidden', 'true');
      note.appendChild(bar);
      const forScreen = element('span', 'platform-skeleton-status', '正在读取…');
      forScreen.setAttribute('role', 'status');
      forScreen.setAttribute('aria-live', 'polite');
      note.appendChild(forScreen);
      host.appendChild(note);
    }
    if (state.error) { host.appendChild(element('p', 'review-error', state.error)); return; }
    /* —— **某一类所属能力不可用 ⇒ 只说那一类**（PKG-099 · G9）：
       别的类照常摆卡、照常能开能存（不许一个域没起来就把整页拖掉）。 */
    const declError = state.declErrors[state.tab];
    if (declError) host.appendChild(element('p', 'review-error', declError));
    renderRedirectRows(host);
    renderNotices(host);
    renderDeclarationFailures(host);
    /* —— **空态**：没有卡时说一句（**独立一块**，不占卡位）。 */
    if (!state.loading && !visibleCards().length) {
      const empty = element('p', 'review-empty', EMPTY_TEXT);
      empty.setAttribute('data-review-empty', '1');
      host.appendChild(empty);
    }
  }

  /**
   * **加载骨架**：照**真卡**的形状占位（标题块 ＋ 正文几行）。
   * ⚠️ **只表示「正在取数」** ⇒ 不写假标题、假项数、假状态。
   * ⚠️ **不占真卡的位置**（不设 `data-review-card`）⇒ 真卡到了原位换掉骨架，不跳版。
   */
  function renderSkeletonCard() {
    /* —— **照真卡搭**：绿标题块（留真的）＋ 白类型块 ＋ 标题 ＋ 状态；
       正文：摘要行 ＋ 案件行 ＋ 「打开核对」那个按钮位。 */
    const article = element('article', 'review-card review-card-skeleton');
    article.setAttribute('data-review-card-state', 'pending');
    article.setAttribute('data-skeleton', 'review-card');
    article.setAttribute('aria-hidden', 'true');
    const head = element('div', 'review-card-head');
    const icon = element('span', 'review-card-icon');
    icon.appendChild(element('i', 'review-skeleton-bar'));
    head.appendChild(icon);
    head.appendChild(element('span', 'review-skeleton-bar review-skeleton-title'));
    head.appendChild(element('span', 'review-skeleton-bar review-skeleton-state'));
    article.appendChild(head);
    const cardBody = element('div', 'review-card-body');
    cardBody.appendChild(element('span', 'review-skeleton-bar review-skeleton-line'));
    cardBody.appendChild(element('span', 'review-skeleton-bar review-skeleton-line short'));
    cardBody.appendChild(element('span', 'review-skeleton-action'));
    article.appendChild(cardBody);
    return article;
  }

  /**
   * **一屏放得下几张卡**（纯计算，好单测）。
   *
   * ⚠️ **为什么一页的条数要按屏算**（用户 2026-10-28 实拍：「为什么这个卡片没有铺满？
   *   明明有两页，先填满一页再去第二页呀」）：
   * 固定 12 张 ⇒ 屏幕放得下 3 行时只摆 2 行 ⇒ **下面空一大块** ⇒ 人看着像「没铺满」；
   * 反过来屏幕只放得下 2 行时硬摆 12 张 ⇒ **第三行整个在屏幕外**，翻页前还得先滚一遍。
   * ⇒ **一页 ＝ 这一屏放得下的张数**：**不多不少**（铺满，也不溢出屏幕）。
   *
   * · `columns` ＝ 一行放得下几张；
   * · `rowPitch` ＝ 一行的**步距**（行高 ＋ 间距，从 DOM 量出来的差值）；
   * · `available` ＝ 这一格还剩多高（去掉上下内边距）；
   * · `gap` ＝ 卡片之间的间距（从差值里反推，不写死）。
   *
   * @returns {number|null} 算不出 ⇒ null（调用方用默认 12）。
   */
  function cardsPerScreen(measured) {
    const columns = Math.floor(Number(measured && measured.columns) || 0);
    const rowPitch = Number(measured && measured.rowPitch) || 0;
    const available = Number(measured && measured.available) || 0;
    if (columns < 1 || rowPitch < 1 || available < 1) return null;
    const gap = Number(measured && measured.gap) || 0;
    /* —— **放得下几行就是几行**（至少一行：屏幕太小也别一页只有一张）。 —— */
    const rows = Math.max(1, Math.floor((available + gap) / rowPitch));
    /* —— **上限 60**（不许一次把全库端回来）。 —— */
    return Math.min(CARDS_PER_PAGE_MAX, columns * rows);
  }

  /**
   * **一张卡的「自然高」**（**不把行拉伸带来的余量算进去**）。
   *
   * ⚠️ **为什么要单独算这一份**（2026-10-28）：行高是 `minmax(max-content, 1fr)`
   *   ⇒ **余下的高度会分给那些行** ⇒ 卡被拉高 ⇒ 直接量 `offsetHeight` 量到的是
   *   **拉高之后**的高度 ⇒ 拿它算「一屏放得下几行」会把行数**算少**
   *   ⇒ 页面就少摆卡 ⇒ **又留一条空带**（用户 2026-10-28：「这下面空着页太丑了吧！」）。
   * ⇒ 量**卡里各块自己的高度**（加起来 ＝ 自然高；动作区那块 `margin-top:auto`
   *   **不吃**那点余量 ⇒ 仍是自然高）。
   * ⚠️ **量不到（没有布局）⇒ 退回这张卡自己的高**（判据桩／还没上屏）。
   */
  function naturalCardHeight(card) {
    let content = 0;
    for (const child of card.children || []) content += Number(child.offsetHeight) || 0;
    if (!content) return Number(card.offsetHeight) || 0;
    const style = (typeof global.getComputedStyle === 'function') ? global.getComputedStyle(card) : null;
    const padTop = style ? (parseFloat(style.paddingTop) || 0) : 0;
    const padBottom = style ? (parseFloat(style.paddingBottom) || 0) : 0;
    const border = style
      ? (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      : 0;
    return content + padTop + padBottom + border;
  }

  /** **行与行之间的间距**（从样式里读；读不到 ⇒ 0）。 */
  function rowGapOf(grid) {
    const style = (typeof global.getComputedStyle === 'function') ? global.getComputedStyle(grid) : null;
    return style ? (parseFloat(style.rowGap) || 0) : 0;
  }

  /**
   * **量这一屏放得下几张**（从 DOM 量；量不出来 ⇒ null ⇒ 用默认 12）。
   *
   * ⚠️ **量的都是「差值」与「自然高」**（行与行差多少、这一格有多高、卡自己有多高）
   *   ⇒ **不抄 CSS 里的数值**（列宽／间距抄一遍 ⇒ 样式一改就跟不上）。
   * · **列数** ＝ 第一行有几张卡（`offsetTop` 相同的那几张）；
   * · **卡高** ＝ 卡的**自然高**（见 `naturalCardHeight`：不算行拉伸的那部分）；
   * · **行距** ＝ 卡高 ＋ 间距（间距从样式里读）；
   * · **可用高度** ＝ 卡片区（自己滚动的那一格）的 `clientHeight` − 上下内边距。
   */
  function measureScreenCards() {
    const grid = state.bodyHost;
    if (!grid || typeof grid.querySelectorAll !== 'function') return null;
    const cards = grid.querySelectorAll('[data-review-card]');
    if (!cards.length) return null;
    const first = cards[0];
    const gridHeight = Number(grid.clientHeight) || 0;
    /* —— **量不出来**（没有布局／这一格还没上屏）⇒ 交回 null（用默认 12）。 —— */
    if (!gridHeight) return null;
    const top0 = Number(first.offsetTop) || 0;
    let columns = 0;
    for (let index = 0; index < cards.length; index += 1) {
      if ((Number(cards[index].offsetTop) || 0) !== top0) break;
      columns += 1;
    }
    if (!columns) return null;
    /* —— **行高＝那一行里最高那张卡的自然高**（行高是**内容里最高的**那张说了算）——
     *   量每一张的自然高（**不算行拉伸带来的余量**）⇒ 取第一行里的最大值。 —— */
    /* ⚠️ **2026-10-28 站上实拍抓到的（浏览器实测：25 张卡被拆成 25 页、每页只摆 1 张）**：
     *   卡片区的行高是 `minmax(max-content, 1fr)` ⇒ **行会把余下的高度分给每行** ⇒ **卡被拉高**；
     *   而卡里那块「吃掉余量」的内容（动作区 `margin-top:auto` 上面那块）**也跟着长高**
     *   ⇒ 量到的「自然高」其实是**拉高后的高** ⇒ 行数被算少（1 行）⇒ 一页只剩 1 张
     *   ⇒ **又留一条空带**（用户 2026-10-28：「这下面空着页太丑了吧！」）
     *   ⇒ **量的时候先把行拉伸撤掉**（量完还原）⇒ 量到的才是自然高。 */
    const previousRows = grid.style ? grid.style.gridAutoRows : '';
    let cardHeight = 0;
    try {
      if (grid.style) {
        grid.style.gridAutoRows = 'max-content';
        /* 强制重排：不然读到的还是**撤之前**那套布局。 */
        void grid.offsetHeight;
      }
      for (let index = 0; index < columns; index += 1) {
        cardHeight = Math.max(cardHeight, naturalCardHeight(cards[index]));
      }
    } finally {
      if (grid.style) {
        grid.style.gridAutoRows = previousRows;
        void grid.offsetHeight;
      }
    }
    if (!cardHeight) return null;
    const gap = rowGapOf(grid);
    const style = (typeof global.getComputedStyle === 'function') ? global.getComputedStyle(grid) : null;
    const padTop = style ? (parseFloat(style.paddingTop) || 0) : 0;
    const padBottom = style ? (parseFloat(style.paddingBottom) || 0) : 0;
    /* —— **可用高度**：拿「**卡片区顶边 → 分页条顶边**之间那段真实空间」。
     *   ⚠️ **为什么不能只拿卡片区自己的高**（2026-10-28 站上实拍：25 张卡被拆成 **25 页**、
     *   每页只摆 **1 张**、卡还被拉得老高）：
     *   卡片区**自己滚**、外框按视口固定 ⇒ **卡片区自己的高是「内容高」（就一行）**
     *   ⇒ 拿它当可用高度 ⇒ 行数算成 1 ⇒ 一页只摆 1 张 ⇒ **又留一条空带**
     *   ⇒ 而且**自己把自己绕进去**（一页 1 张 ⇒ 更空 ⇒ 更被拉高 ⇒ 还是 1 张）。
     *   ⇒ 改成量「顶边到分页条」那段空间（弹窗里也一样：分页条在卡片区下面）。 —— */
    let available = gridHeight - padTop - padBottom;
    const rectOf = element => (element && typeof element.getBoundingClientRect === 'function')
      ? element.getBoundingClientRect() : null;
    const gridRect = rectOf(grid);
    if (gridRect) {
      const pagerRect = rectOf(state.pagerHost);
      const viewportHeight = Number(global.innerHeight) || 0;
      const bottom = pagerRect ? Number(pagerRect.top) : viewportHeight;
      const space = bottom - (Number(gridRect.top) || 0);
      if (space > 0) available = Math.max(available, space - padTop - padBottom);
    }
    return cardsPerScreen({
      columns,
      rowPitch: cardHeight + gap,
      available,
      gap,
    });
  }

  /**
   * **量一屏放得下几张** ⇒ 变了就**按新的条数把这一页重取一遍**。
   *
   * ⚠️ **只在「量出来的数」真的变了时才重取** ⇒ 量一次就稳了（不会来回抖）。
   * ⚠️ **重取的是当前这一页**（不是从头）⇒ 人看到的那一页不变。
   * ⚠️ **正在取数时不动手**（等这一轮取完再量）⇒ 不会把在途的读掐掉，
   *   也**不会自己把自己绕进去**（重取一开始就把 `loading` 置上 ⇒ 量不到就停）。
   */
  function syncScreenPageSize() {    if (state.loading) return;
    const measured = measureScreenCards();
    if (!measured || measured === state.screenCards) return;
    state.screenCards = measured;
    const scope = currentScope();
    const paging = state.paging[scope];
    if (!paging) return;
    if (paging.legacy) {
      /* —— **降级路径**（域给的是全量）⇒ 壳自己切页 ⇒ 条数变了**重切一遍**（不用问域）。 —— */
      renderListRegion();
      return;
    }
    /* —— **真服务端分页** ⇒ 按新的条数**重新向域要这一页**。 —— */
    void loadScope(scope, { page: state.cardPage, query: state.search });
  }

  /**
   * **等布局稳了再量**（2026-10-28 站上实拍抓到的）。
   *
   * ⚠️ **为什么不能只量一次**：卡片刚挂上去的那一刻，外框的尺寸**还没定**
   *   ⇒ 卡片区量出来的高度是**内容高度**（一行）⇒ 行数算成 1 ⇒ 一页只摆 1 张。
   *   ⇒ **等两帧**（布局与样式都落地了）再量 ⇒ 量到的是**真高度**。
   *   ⇒ 没有 rAF（判据桩）⇒ 立刻量（判据里布局是定好的 ⇒ 量得对）。
   */
  function scheduleScreenPageSize() {
    if (typeof global.requestAnimationFrame !== 'function') { syncScreenPageSize(); return; }
    global.requestAnimationFrame(() => {
      global.requestAnimationFrame(() => { syncScreenPageSize(); });
    });
  }

  /**
   * **盯着卡片区那一格**（尺寸变了就重新量）。
   *
   * ⚠️ **为什么还要盯这一格**（不止窗口 resize）：**折叠侧栏**这类改动**只改布局、不发 resize 事件**
   *   ⇒ 卡片区变宽/变窄 ⇒ 一屏放得下的张数也变了 ⇒ 不盯着就停在旧的那一档。
   */
  let gridSizeObserver = null;
  function observeGridSize(grid) {
    if (gridSizeObserver) {
      try { gridSizeObserver.disconnect(); } catch { /* 已经断了 */ }
      gridSizeObserver = null;
    }
    if (!grid || typeof global.ResizeObserver !== 'function') return;
    try {
      gridSizeObserver = new global.ResizeObserver(() => { syncScreenPageSize(); });
      gridSizeObserver.observe(grid);
    } catch { /* 盯不住就算了：还有窗口 resize 那条路 */ }
  }

  /** **卡片区**（网格）：**只有卡**（提示、空态、分页条都不在这儿）。 */
  function renderBody(body) {
    /* ⚠️ **这一页没挂着 ⇒ 没有列表宿主可画**（`syncCounts()` 可以被直接叫，不必先挂页面）
     *   ⇒ 早先这里直接 `body.appendChild(骨架卡)` ⇒ `null.appendChild` **把整个计数吞掉**
     *   （`syncCounts()` 只能返回 `reason:'failed'`，页头那个数一直是 0）。
     *   ⇒ 没有宿主就**不画**（计数照算、照回）。 */
    if (!body) return;
    clear(body);
    ensureTabVisible();
    const cards = visibleCards();
    /* —— 还在取数、而且**一张卡都还没到** ⇒ 摆骨架卡（照真卡的形状；不占真卡的位置）。 */
    if (state.loading && !cards.length) {
      for (let index = 0; index < 4; index += 1) body.appendChild(renderSkeletonCard());
      return;
    }
    cards.forEach(card => body.appendChild(renderCard(card)));
    /* —— **量一屏放得下几张**（量出来的数变了 ⇒ 按新的条数把这一页重取一遍）。 —— */
    scheduleScreenPageSize();
  }

  /**
   * **分页条**（**固定在底栏**，不随卡片滚动跑掉）。
   *
   * ⚠️ **「共 N 张」用的是那一档的**真实总数**（域给的 `total`）——
   *   不是这一页取回来的条数（12）。**降级路径**（域回老形状 ⇒ 域给的是全量）才由壳自己数。
   */
  function renderPager(host) {
    if (!host) return;
    clear(host);
    const scope = currentScope();
    const paging = state.paging[scope];
    const pages = Math.max(1, Number(paging.pages) || 1);
    const total = pagerTotal();
    if (pages <= 1 && !total) return;
    const pager = element('nav', 'review-pagination');
    pager.setAttribute('aria-label', '审核卡片分页');
    pager.setAttribute('data-review-pagination', '1');
    const change = (direction, label) => {
      const button = element('button', 'btn btn-ghost', label);
      button.type = 'button';
      button.setAttribute('data-review-page', direction < 0 ? 'previous' : 'next');
      button.disabled = direction < 0 ? state.cardPage === 1 : state.cardPage >= pages;
      button.addEventListener('click', () => { void goToCardPage(state.cardPage + direction); });
      return button;
    };
    pager.appendChild(change(-1, '上一页'));
    const status = element('span', 'review-pagination-status',
      '第 ' + state.cardPage + ' / ' + pages + ' 页 · 共 ' + total + ' 张');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('data-review-pagination-status', '1');
    pager.appendChild(status);
    pager.appendChild(change(1, '下一页'));
    host.appendChild(pager);
  }

  /**
   * **重画这一块**（状态区 ＋ 卡片区 ＋ 分页条）。
   * ⚠️ **不换掉搜索框**（搜索框在 `renderListTools` 里另画）⇒ 人打字时焦点不丢。
   */
  function renderListRegion() {
    syncPaging(currentScope());
    renderStatus(state.statusHost);
    renderBody(state.bodyHost);
    renderPager(state.pagerHost);
    /* —— **搜索是「服务端做的」还是「前端做的」**：每次重画都**重新标一次**
     *   （域有没有按 `q` 筛，是这一轮读完才知道的）。 —— */
    markSearchMode(state.toolsHost && state.toolsHost.querySelector('[data-review-search]'));
  }

  function renderFooter(footer) {
    clear(footer);
    const status = element('span', 'review-footer-status');
    status.setAttribute('role', 'status');
    /* 这一行**只为回执而挂**（平时不挂 —— 见 `renderParts` 的说明）。 */
    status.textContent = state.receipt || '';
    footer.appendChild(status);
  }

  /**
   * **卡片列表的「待处理／已处理」两档 ＋ 搜索**（旧项目那页就有这两样；
   * 契约 §4「支持搜索与待处理/已处理查看」）。
   *
   * ⚠️ **只是**看的方式** —— 不改提交集合**（契约 §save_policy.scope_unchanged_by_view）：
   *   筛掉一张卡，**不会**把那一组的正式变化从提交范围里拿掉。
   */
  /**
   * **卡片列表看哪一档**（PKG-068-T01 · 用户 2026-10-23 22:13～22:18 拍板）：
   * · **待审那一档**＝**当前声明**的待审卡；
   * · **「已确认」那一档**＝**全部声明**的已审卡（通过／驳回／待补充材料）——
   *   「已确认」是与域给的那几档**平级、永远都在**的一档。
   *
   * ⚠️ **只是看的方式**（契约 §save_policy.scope_unchanged_by_view）：
   *   筛掉一张卡，**不会**把那一组的正式变化从提交范围里拿掉。
   */
  function cardIsDone(card) {
    const state = String(card.state || 'pending');
    return state !== 'pending' && state !== 'stale' && state !== '';
  }

  /**
   * **按「进入审核中心的时间」新的在上**（PKG-068-T01）。
   * ⚠️ **没有时间的排最后**（不编时间、不猜）。
   * ⚠️ 时间是**文本**（内核给的是 `YYYY-MM-DD HH:MM:SS.ffffff`）⇒ 字典序就是时间序。
   */
  function byEnteredAtDesc(a, b) {
    const left = String((a && a.enteredAt) || '');
    const right = String((b && b.enteredAt) || '');
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return right.localeCompare(left);
  }

  /** 卡上那几个字段拼起来（搜索用）。 */
  function matchesQuery(card, query) {
    if (!query) return true;
    const haystack = [card.title, card.summary, card.domain, card.caseId].join(' ').toLowerCase();
    return haystack.includes(query);
  }

  /**
   * **k 路归并**（「已确认」那一档）：从各声明缓冲的指针处开始取，
   * 每次取各声明当前**最新**的那一张 ⇒ 摆出来的是**全局最新的一批**。
   * `limit` ＝ 0 ⇒ 全部（降级路径用：域给的是全量 ⇒ 壳把全量归并成一条再自己切页）。
   */
  function mergeDoneCards(limit) {
    const buffers = pageDeclarations().map(declaration => doneBuffer(declaration.key));
    const pointers = buffers.map(buffer => buffer.pointer);
    const used = buffers.map(() => 0);
    const merged = [];
    while (!limit || merged.length < limit) {
      let pick = -1;
      let picked = null;
      buffers.forEach((buffer, index) => {
        const card = buffer.cards[pointers[index]];
        if (!card) return;
        if (picked === null || byEnteredAtDesc(card, picked) < 0) { picked = card; pick = index; }
      });
      if (pick < 0) break;
      merged.push(picked);
      pointers[pick] += 1;
      used[pick] += 1;
    }
    return { cards: merged, used, buffers };
  }

  /** 当前这一档、当前这一片的**全部卡**（还没按搜索词筛、还没切页）。 */
  function scopeVisibleCards() {
    const scope = currentScope();
    if (scope === 'done') {
      if (state.paging.done.legacy) {
        /* —— **降级路径**：域给的是全量（待审＋已审都有）⇒ 归并成一条后**按这一档筛一遍**。 */
        return mergeDoneCards(0).cards.filter(card => cardIsDone(card));
      }
      return (state.donePages[state.cardPage] || []).slice();
    }
    return scopeFilteredCards('pending', state.tab).slice();
  }

  /**
   * **这一档、这一片摆出来的卡**（分好页、按搜索词筛过、按进入时间倒序）。
   *
   * ⚠️ **真服务端分页**（域回的是新形状）⇒ 域给的就是**这一页** ⇒ 壳**不再自己切**；
   * **降级路径**（域回的是老形状 ⇒ 域给的是全量）⇒ 壳**自己切这一页**。
   */
  function visibleCards() {
    const scope = currentScope();
    const query = String(state.search || '').trim().toLowerCase();
    const cards = scopeVisibleCards()
      .filter(card => matchesQuery(card, query))
      .sort(byEnteredAtDesc);
    if (state.paging[scope].legacy) {
      const start = (state.cardPage - 1) * state.screenCards;
      return cards.slice(start, start + state.screenCards);
    }
    return cards;
  }

  /** **待审**那一档里、某一份声明的**真实总数**（域给的 `total`；老形状由壳数）。 */
  function pendingTotalOf(key) {
    const entry = scopeEntry('pending', key);
    if (!entry) return 0;
    if (!entry.legacy) return Number(entry.total) || 0;
    return (entry.cards || []).filter(card => !cardIsDone(card)).length;
  }

  /**
   * **分页条上的「共 N 张」**——**真实总数**（不是这一页取回来的条数）。
   * · 真服务端分页 ⇒ 域给的 `total`（「已确认」那一档 ＝ 各声明真实总数之和）；
   * · 降级路径 ⇒ 壳自己数（**已按搜索词筛过** ⇒ 数出来就是人看到的那些）。
   */
  function pagerTotal() {
    const scope = currentScope();
    if (state.paging[scope].legacy) {
      const query = String(state.search || '').trim().toLowerCase();
      return scopeVisibleCards().filter(card => matchesQuery(card, query)).length;
    }
    return scope === 'done' ? scopeTotal('done') : pendingTotalOf(state.tab);
  }

  /**
   * **把那一档的分页状态**按当前取数结果重算一遍（真实总数 ＋ 总页数）。
   * ⚠️ **搜索是不是真在服务端做了**（`searchServer`）：
   *   域给的总数**比不带搜索词时少** ⇒ 域自己筛了 ⇒ 真搜索；
   *   一样多 ⇒ **域没筛** ⇒ 这一档仍是**前端过滤**（如实标注，不假装真搜索）。
   */
  function syncPaging(scope) {
    const paging = state.paging[scope];
    if (!paging) return;
    paging.legacy = scopeIsLegacy(scope);
    const query = String(state.search || '').trim();
    if (paging.legacy) {
      /* —— **降级路径**：域给的是全量 ⇒ 壳自己数、自己切页
       *   （**按筛过之后的条数**算页数 ＝ 老口径）。 */
      const lower = query.toLowerCase();
      const count = scopeVisibleCards().filter(card => matchesQuery(card, lower)).length;
      paging.total = count;
      paging.pages = Math.max(1, Math.ceil((count || 0) / state.screenCards));
      /* —— 降级路径**永远是前端过滤**（域没按 `q` 筛）⇒ 不标成服务端搜索。 */
      paging.searchServer = false;
    } else {
      /* —— **真服务端分页**：总数＝域给的真实总数（不是这一页取回来的条数）。 */
      paging.total = scope === 'done' ? scopeTotal('done') : pendingTotalOf(state.tab);
      paging.pages = Math.max(1, Math.ceil((paging.total || 0) / state.screenCards));
      /* —— **搜索是不是真在服务端做了**：
       *   域给的总数**比不带搜索词时少** ⇒ 域自己筛了 ⇒ 真搜索；
       *   一样多 ⇒ **域没筛** ⇒ 这一档仍是**前端过滤**（如实标注，不假装真搜索）。
       *   ⚠️ **「壳把全量取回来自己筛」的那种兜底**（`clientFilter`）**不算**服务端搜索。 */
      /* —— **域明说了搜索在哪儿做**（`searchMode`）⇒ **认域的**。
       *   域说 `client`（例如提案目录那个读口没有服务端搜索）⇒ 就是前端过滤，
       *   **不许**因为总数变小了就说成「真服务端搜索」。 */
      const declared = scopeSearchMode(scope);
      if (declared) {
        paging.searchServer = declared === 'server' && !paging.clientFilter && Boolean(query);
      } else {
        paging.searchServer = !paging.clientFilter && Boolean(query) && Number(paging.totalAll) > 0
          && Number(paging.total) > 0 && Number(paging.total) < Number(paging.totalAll);
      }
    }
    if (state.cardPage > paging.pages) state.cardPage = paging.pages;
    if (state.cardPage < 1) state.cardPage = 1;
  }

  /** **把「当前在看的那一档」的卡同步进 `state.cards`**（弹窗按它找卡）。 */
  function syncScopeCards(scope) {
    pageDeclarations().forEach(declaration => {
      const entry = scopeEntry(scope, declaration.key);
      if (entry) state.cards[declaration.key] = entry.cards;
    });
  }

  /**
   * **翻页**。
   * · **真服务端分页**（域回的是新形状）⇒ **重新向域要那一页**（`page` 变）
   *   ⇒ 壳**不拿旧的全量在前端切**。
   * · **降级路径**（域回的是老形状 ⇒ 域给的是全量）⇒ 壳**自己切片**（不白问域一趟）。
   */
  async function goToCardPage(page) {
    const scope = currentScope();
    const paging = state.paging[scope];
    const pages = Math.max(1, Number(paging.pages) || 1);
    const target = Math.max(1, Math.min(Number(page) || 1, pages));
    if (target === state.cardPage) return;
    state.cardPage = target;
    if (paging.legacy) {
      /* —— **降级**：域给的是全量 ⇒ 壳自己切这一页。 */
      renderListRegion();
      renderDecks();
      return;
    }
    await loadScope(scope, { page: target, query: state.search });
    syncScopeCards(scope);
    renderListRegion();
    renderDecks();
  }

  function renderListTools(host) {
    const tools = element('div', 'review-center-tools');
    /* ⚠️ **原来那一行「待处理／已处理」那两个按钮撤了**（PKG-068-T01）——
       那一层搬进了**页头右上的分档片**（域给的每一档一片 ＋「已确认」一片）⇒ 不摆两处。
       ⚠️ **搜索必须保留**（契约 §4 明写「支持搜索与待处理/已处理查看」）。 */
    const search = doc.createElement('input');
    search.setAttribute('data-review-search', '1');
    search.setAttribute('type', 'search');
    search.setAttribute('placeholder', '搜索文件名或案件');
    search.setAttribute('aria-label', '搜索文件名或案件');
    search.value = state.search || '';
    search.addEventListener('input', () => {
      state.search = search.value;
      state.cardPage = 1;
      /* —— **先按现有数据重画**（**不换掉这个输入框** ⇒ 人打字时焦点不丢）。 */
      renderListRegion();
      /* —— **再向域要一次带 `q` 的**（真服务端搜索 ＋ 真服务端分页）。 */
      void reloadCurrentScope();
    });
    tools.appendChild(search);
    host.appendChild(tools);
    state.toolsHost = tools;
    /* —— **搜索是不是真在服务端做了**（标出来，不假装真搜索）。 —— */
    markSearchMode(search);
  }

  /**
   * **标出这一档的搜索是「服务端做的」还是「前端做的」**。
   * ⚠️ 判据：域给的总数**比不带搜索词时少** ⇒ 域自己筛了 ⇒ 服务端搜索；
   * 一样多 ⇒ **域没筛** ⇒ 这一档仍是**前端过滤**（如实标出来）。
   */
  function markSearchMode(search) {
    if (!search) return;
    const mode = state.paging[currentScope()].searchServer ? 'server' : 'client';
    search.setAttribute('data-review-search-mode', mode);
    search.setAttribute('title', mode === 'server'
      ? '搜索在服务端做（这一页是服务端筛出来的）'
      : '搜索在浏览器里做（域没有服务端检索）');
  }

  /**
   * **把当前那一档重新问一遍域**（换搜索词之后）。
   * ⚠️ **带 `q`**（搜索词）＋ **`scope`** ＋ **`page`/`pageLength`** ⇒ 一次请求就是这一页。
   */
  async function reloadCurrentScope() {
    const scope = currentScope();
    state.cardPage = 1;
    if (scope === 'done') {
      /* —— 换了搜索词 ⇒ 缓冲作废（重新从头归并）。 */
      state.doneBuffers = {};
      state.donePages = {};
      await loadScope('done', { page: 1, query: state.search });
    } else {
      await loadScope('pending', { page: 1, query: state.search });
    }
    /* —— **域没按 `q` 筛**（总数一点没少）⇒ 这一档改走**前端过滤**：
     *   把这一档的**其余各页**也取回来，自己筛、自己切页。
     *   ⚠️ **不做这一步的后果**：人搜一个词，**只看得见当前这一页里的结果**
     *   （别的页上的命中被漏掉）⇒ 搜索等于坏掉。
     *   ⚠️ **优先路径仍是「搜索交服务端」**：域支持 `q` 时**不会**到这里
     *   （总数会变少 ⇒ 域自己筛了 ⇒ 标成服务端搜索）。 */
    if (scopeIgnoredQuery(scope)) {
      await loadWholeScope(scope, state.search);
      state.paging[scope].clientFilter = true;
    }
    syncScopeCards(scope);
    renderListRegion();
    renderDecks();
  }

  /**
   * **域是不是没按 `q` 筛**（⇒ 这一档只能前端过滤）。
   * 判据：带 `q` 的那一轮，**域给的总数一点没少**（＝不带 `q` 时的总数）⇒ 域没筛。
   */
  function scopeIgnoredQuery(scope) {
    const paging = state.paging[scope];
    if (!paging || paging.legacy) return false;
    const query = String(state.search || '').trim();
    if (!query) return false;
    const totalAll = Number(paging.totalAll) || 0;
    const total = Number(paging.total) || 0;
    return totalAll > 0 && total >= totalAll;
  }

  /**
   * **把一档的其余各页也取回来**（域不支持服务端搜索时的**前端过滤**兜底）。
   * ⚠️ 收进 `scopeStore` 之后这一档标成「壳拼出来的全量」⇒ 壳自己筛、自己切页。
   */
  async function loadWholeScope(scope, query) {
    const declarations = scope === 'done'
      ? pageDeclarations()
      : (currentDeclaration() ? [currentDeclaration()] : []);
    const signal = state.pageSignal || null;
    const generation = state.listReadGeneration;
    for (const declaration of declarations) {
      if (scope === 'done') {
        /* —— 「已确认」那一档：缓冲一路取到**取完为止**。 —— */
        const buffer = doneBuffer(declaration.key);
        while (!buffer.exhausted) {
          let result;
          try {
            result = await requestScope(declaration, 'done', buffer.nextPage, query);
          } catch (error) {
            if (isAbortError(error)) return;
            buffer.exhausted = true;
            break;
          }
          buffer.nextPage += 1;
          buffer.total = Number(result.total) || buffer.total;
          buffer.cards = buffer.cards.concat(result.cards);
          buffer.cards.sort(byEnteredAtDesc);
          if (!result.cards.length || result.cards.length < state.screenCards) buffer.exhausted = true;
        }
        const done = scopeEntry(scope, declaration.key);
        if (done) { done.cards = buffer.cards; done.legacy = true; }
        continue;
      }
      /* —— 待审那一档：把剩下几页都取回来（第一页已经在那儿了）。 —— */
      const entry = scopeEntry(scope, declaration.key);
      if (!entry) continue;
      const total = Number(entry.total) || 0;
      const pages = Math.max(1, Math.ceil(total / state.screenCards));
      for (let page = 2; page <= pages; page += 1) {
        let result;
        try {
          result = await requestScope(declaration, 'pending', page, query);
        } catch (error) {
          if (isAbortError(error)) return;
          break;
        }
        entry.cards = entry.cards.concat(result.cards);
      }
      /* —— 这一档现在是「壳拼出来的全量」⇒ 壳自己筛、自己切页。 —— */
      entry.legacy = true;
    }
    if (generation !== state.listReadGeneration || (signal && signal.aborted)) return;
  }

  /**
   * **这一页的四块**（今晚交接 §10.1 第 3 行「外框固定」）：
   *   ① **页头**（标题 ＋ 分档片）—— 固定，不动；
   *   ② **搜索／交代／失败提示区**（`status`）—— 固定，不占卡位；
   *   ③ **卡片区**（`body`，网格 ＋ **自己内部滚动**）；
   *   ④ **分页条**（`pager`）—— **固定在底栏**，不随卡片滚动跑掉。
   */
  function renderParts(container) {
    /* ⚠️ **原来那一行「分档标签」撤了**（PKG-068-T01）——
       分档片搬到**页头右上**了（`renderDecks`），不在这儿再摆一行。 */
    renderListTools(container);
    /* —— **② 状态区**：交代（PKG-072-T01）、没注册上的声明（PKG-121 · 缺口⑤）、
       加载提示、空态 —— 全在这一块，**都在卡片区上面**（人先看见交代、再看见卡）。 */
    const status = element('div', 'review-center-status');
    status.setAttribute('data-review-status', '1');
    container.appendChild(status);
    /* —— **③ 卡片区**：网格 ＋ **自己内部滚动**（外框高度不随卡片数变化）。 */
    const body = element('div', 'review-center-body');
    body.setAttribute('data-review-card-grid', '1');
    container.appendChild(body);
    /* —— **④ 分页条**：**在卡片滚动区之外**（固定底栏）。 */
    const pager = element('div', 'review-center-pager');
    pager.setAttribute('data-review-pager', '1');
    container.appendChild(pager);
    state.statusHost = status;
    state.bodyHost = body;
    state.pagerHost = pager;
    /* —— **盯着卡片区那一格**（折叠侧栏之类只改布局、不发 resize ⇒ 得盯住）。 —— */
    observeGridSize(body);
    renderListRegion();
    /* **平时不挂页级底栏**（用户 2026-10-23：「弹窗背后的页面信息太多太杂，要精简」）。
       早先这里常驻两样：
         ① **图例行**（「彩色文字呼吸：待确认　黑字粗体：已保存」）—— 旧项目那页背后没有，
            讲的是卡片里彩色小字的含义，**弹窗开着的时候根本看不见**；
         ② **页级计数底栏**（「共 N 项待核对（声明名）」）—— 和分档里的计数重复。
       ⇒ 两条都撤。
       ⚠️ **但保存结果不许丢**：保存后有回执时才把这一行挂出来（平时它不在）。
         弹窗底栏那一行（真实核对进度与保存结果）**一个字没动** —— 那是契约 §interaction.footer 要求的。 */
    if (state.receipt) {
      const footer = element('footer', 'review-center-footer');
      footer.setAttribute('data-review-footer', '1');
      renderFooter(footer);
      container.appendChild(footer);
    }
  }

  function renderPageView() {
    const host = state.pageHost;
    if (!host || host.isConnected === false) return;
    const section = host.querySelector('[data-review-page-section]');
    if (!section) return;
    clear(section);
    renderParts(section);
    /* **页头右上那片分档**（不在 section 里 ⇒ 单独画）。 */
    renderDecks();
  }

  function render() {
    /* **页头右上那片分档**先画（它不在 section 里 ⇒ 单独画）。 */
    renderDecks();
    renderPageView();
    if (state.modalOpen) renderSplit();
  }

  // ========== 分栏弹窗（凭据级：左＝要改的内容，右＝凭据） ==========

  function ensureSplitDialog() {
    if (state.modal) return state.modal;
    const dialog = doc.createElement('dialog');
    /* **公共弹窗组件**：挂上 `os-dialog`（定义在 `css/workbench.css`）。
       ⚠️ 公共件的规则（`.os-dialog header/main/footer`、`.os-dialog .btn`）**都挂在 `.os-dialog` 底下**
       —— 不挂这个类，公共件的字体/圆角/背景/阴影/遮罩/按钮尺寸**一条都不生效**
       （2026-10-23 实测：不挂时底栏那个「整组保存」高 23px、内边距 1px 6px、弹窗字体掉回 `16px Times`）。
       ⚠️ `os-dialog-lg` 是**公共件的「大号弹窗」那一档**（16px 圆角，旧项目那扇审核大弹窗就是）；
       外框归公共件 ⇒ **圆角由公共件给**，这个壳**自己不写圆角**
       （判据 `review-center-os-dialog` ④ 盯着；别的弹窗没加这一档 ⇒ 一个字不变）。 */
    dialog.className = 'review-split os-dialog os-dialog-lg';
    dialog.setAttribute(SPLIT_ATTR, '1');
    dialog.setAttribute('aria-labelledby', 'reviewSplitTitle');
    if (doc.body) doc.body.appendChild(dialog);
    state.modal = dialog;
    return dialog;
  }

  function activeCard() {
    const declaration = currentDeclaration();
    if (!declaration) return null;
    const cards = state.cards[declaration.key] || [];
    return cards.find(card => card.id === state.activeCardId) || null;
  }

  function adoptState(changeId) {
    if (state.editing === changeId) return 'editing';
    return state.adopt.get(changeId) || 'pending';
  }

  function editText(changeId) {
    return state.edits.has(changeId) ? state.edits.get(changeId) : '';
  }

  function textOf(change) {
    const edited = state.edits.get(change.id);
    if (edited !== undefined) return edited;
    return plainValue(change.after);
  }

  function setAdopt(changeId, mode) {
    state.adopt.set(changeId, mode);
  }

  function clearAdopt(changeId) {
    state.adopt.delete(changeId);
    state.edits.delete(changeId);
  }

  function toggleAdopt(changeId) {
    if (state.busy) return;
    const mode = adoptState(changeId);
    if (mode === 'pending') setAdopt(changeId, 'adopted');
    else clearAdopt(changeId);
    updateCandidate(changeId);
    updateSplitProgress();
  }

  function startEdit(changeId, initialText) {
    if (state.busy) return;
    const change = findChange(changeId);
    if (!change) return;
    if (state.editing && state.editing !== changeId) {
      const previous = candidateCell(state.editing);
      const editor = previous && previous.querySelector('[data-review-edit]');
      if (editor) commitEdit(state.editing, editor.value);
    }
    if (adoptState(changeId) === 'pending') setAdopt(changeId, 'adopted');
    if (initialText !== undefined) state.edits.set(changeId, initialText);
    else if (!state.edits.has(changeId)) state.edits.set(changeId, plainValue(change.after));
    state.editing = changeId;
    updateCandidate(changeId);
    updateSplitProgress();
    const cell = candidateCell(changeId);
    const editor = cell && cell.querySelector('[data-review-edit]');
    if (editor && typeof editor.focus === 'function') editor.focus();
  }

  function commitEdit(changeId, value) {
    if (state.editing !== changeId || !findChange(changeId)) return;
    const text = String(value === undefined || value === null ? '' : value);
    if (state.editing === changeId) state.editing = null;
    setAdopt(changeId, 'edited');
    state.edits.set(changeId, text);
    updateCandidate(changeId);
    updateSplitProgress();
  }

  // 本地核对只更新发生变化的单元格；原件、其他候选及卡片列表保留原节点。
  function candidateCell(changeId) {
    const left = state.modal && state.modal.querySelector('[data-review-slot="left"]');
    if (!left) return null;
    return Array.from(left.querySelectorAll('[data-review-change-id]'))
      .find(cell => cell.getAttribute('data-review-change-id') === String(changeId)) || null;
  }

  function updateCandidate(changeId) {
    const change = findChange(changeId);
    const cell = candidateCell(changeId);
    if (!change || !cell) return;
    const mode = adoptState(changeId);
    const text = cell.querySelector('[data-review-candidate]');
    if (text && mode !== 'editing') {
      // 保留第一次 click 的目标，浏览器才能继续发送 dblclick。
      text.textContent = textOf(change);
      text.setAttribute('data-proposal-state', mode === 'pending'
        ? (isStagedChange(change) ? 'staged' : 'pending') : mode);
    } else {
      const replacement = candidateNode(change, splitContext());
      clear(cell);
      while (replacement.firstChild) cell.appendChild(replacement.firstChild);
    }
    const row = cell.closest('[data-review-row]');
    const mark = row && row.querySelector('[data-review-row-state]');
    if (mark) mark.textContent = splitContext().rowState(changeId);
  }

  function updateSplitProgress() {
    const declaration = currentDeclaration(), card = activeCard();
    if (!state.modalOpen || !state.modal || !declaration || !card) return;
    const progress = state.modal.querySelector('[data-review-progress]');
    if (progress) progress.textContent = progressText(card);
    const save = state.modal.querySelector('[data-review-save]');
    if (save) {
      save.textContent = saveLabel(declaration);
      save.disabled = state.busy || !canSave(declaration, card);
    }
    if (state.pageDisposed || state.detailLoading || state.detailError) {
      for (const selector of ['[data-review-difference-submit]', '[data-review-difference]', '[data-review-reject]', '[data-review-handling-action]']) {
        for (const button of state.modal.querySelectorAll(selector)) button.disabled = true;
      }
    }
    const receipt = state.modal.querySelector('[data-review-receipt]');
    if (receipt) {
      receipt.textContent = state.receipt || '';
      receipt.hidden = !state.receipt;
    }
    if (state.detailError && !state.modal.querySelector('[data-review-detail-retry]')) {
      const actions = state.modal.querySelector('.review-footer-actions');
      if (actions) {
        const retry = element('button', 'btn btn-ghost', '重新读取');
        retry.type = 'button';
        retry.setAttribute('data-review-detail-retry', '1');
        retry.addEventListener('click', () => { void readCardDetail(declaration, card); });
        actions.appendChild(retry);
      }
    }
  }

  function findChange(changeId) {
    const card = activeCard();
    if (!card) return null;
    return card.changes.find(change => change.id === changeId) || null;
  }

  /** 弹窗里的上下文：采用/改写/保存都走它。 */
  function splitContext() {
    const declaration = currentDeclaration();
    const card = activeCard();
    return {
      slot: 'left',
      declaration,
      card,
      isCurrentCard: () => state.modalOpen && activeCard() === card,
      adoptState,
      editText,
      textOf,
      toggleAdopt,
      startEdit,
      commitEdit,
      rowState(changeId) {
        const mode = adoptState(changeId);
        /* **已暂存**（服务端存着、正式值还没改）＝ 自己的一档：
           不许显示成「待采用」（会让人以为还没看），也不许混成「已采用」。 */
        if (mode === 'pending') return isStagedChange(findChange(changeId)) ? '已暂存' : '待采用';
        if (mode === 'adopted') return '已采用（待保存）';
        if (mode === 'edited') return '已改写（待保存）';
        if (mode === 'editing') return '改写中（待保存）';
        if (mode === 'failed') return '保存失败（待处理）';
        return '已保存';
      },
      beforeLabel: '当前正式值',
      valueLabel: '候选值',
      candidate: change => candidateNode(change, splitContext()),
      openOriginal(item) { void openOriginal(item); },
    };
  }

  function renderSlot(slotName, items, ctx) {
    const declaration = currentDeclaration();
    /* 槽位配置在声明的第 2/3 类里（`leftSlot` / `rightSlot`）。 */
    const config = (declaration && declaration[slotName + 'Slot']) || {};
    const format = config.format || (slotName === 'left' ? 'field-table' : 'attachment-list');
    const renderer = FORMATS[format] || FORMATS['attachment-list'];
    const section = element('section', 'review-slot review-slot-' + slotName);
    section.setAttribute('data-review-slot', slotName);
    section.setAttribute('data-review-format', format);
    /* —— **这一栏可以不给标题**（声明写空串 ⇒ **什么都不摆**）——
       用户 2026-10-24 22:34：「要核对的」那行小标题**去掉**。
       ⚠️ **「给了空串」与「没给」是两件事**：没给 ⇒ 落默认（左栏**不摆小标题**／右栏落「原件」）；
       给了空串 ⇒ **不摆**（不许又落回默认那一行）。 */
    const titleText = config.title === ''
      ? ''
      : (config.title || (slotName === 'left' ? '' : '原件'));
    if (titleText) {
      const title = element('h3', 'review-slot-title', titleText);
      section.appendChild(title);
    }
    const body = element('div', 'review-slot-body');
    body.setAttribute('data-review-slot-body', slotName);
    /* 左栏给了「内容分组」（契约十类第 2 类）⇒ **分区块**渲染；
     * 没给 ⇒ **一列平铺**（壳不替域猜分组 ⇒ 别的域一个字不变）。 */
    if (slotName === 'left' && Array.isArray(config.groups) && config.groups.length) {
      body.appendChild(renderLeftGroups(items, ctx, config.groups));
    } else {
      body.appendChild(renderer.render(items, ctx));
    }
    section.appendChild(body);
    return section;
  }

  /** 这一张卡的**核对清单**（第 9 类：这一类审核要求先核哪几样）。 */
  function checksOf(card) {
    if (!card) return new Map();
    if (!state.checks.has(card.id)) state.checks.set(card.id, new Map());
    return state.checks.get(card.id);
  }

  function renderChecks(card) {
    const list = Array.isArray(card.checks) ? card.checks : [];
    if (!list.length) return null;
    const box = element('div', 'review-checklist');
    box.setAttribute('data-review-checks', '1');
    const done = checksOf(card);
    list.forEach(check => {
      const wrap = element('label', 'review-check');
      const box2 = doc.createElement('input');
      box2.type = 'checkbox';
      box2.setAttribute('data-review-check-key', check.key);
      box2.setAttribute('data-review-check-label', check.label || '');
      box2.checked = Boolean(done.get(check.key));
      box2.addEventListener('change', () => {
        if (!state.modalOpen || activeCard() !== card) return;
        done.set(check.key, box2.checked);
        updateSplitProgress();
      });
      wrap.appendChild(box2);
      wrap.appendChild(doc.createTextNode(check.label || check.key));
      box.appendChild(wrap);
    });
    return box;
  }

  function disposeHandlingPanel() {
    const cleanup = state.panelCleanup;
    state.panelCleanup = null;
    if (cleanup) cleanup();
  }

  function panelBlocksReview(declaration, card) {
    const panel = declaration && declaration.handling && declaration.handling.panel;
    return Boolean(panel && panel.blocksReview && panel.blocksReview(card));
  }

  // 域声明如何选定业务对象；壳只提供生命周期和统一提交入口。
  function mountHandlingPanel(left, declaration, card) {
    const panel = declaration.handling && declaration.handling.panel;
    if (!panel || (panel.visible && !panel.visible(card))) return;
    const container = element('div', 'review-preparation-panel');
    container.setAttribute('data-review-preparation-panel', panel.id);
    left.insertBefore(container, left.firstChild);
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    let disposed = false, cleanup;
    const pageSignal = state.pageSignal;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (pageSignal) pageSignal.removeEventListener('abort', dispose);
      if (controller) controller.abort();
      if (typeof cleanup === 'function') cleanup();
    };
    state.panelCleanup = dispose;
    if (pageSignal) pageSignal.addEventListener('abort', dispose, {once:true});
    try {
      cleanup = panel.mount(container, card, {
        signal: controller ? controller.signal : pageSignal,
        run: async work => {
          if (disposed || typeof work !== 'function' || activeCard() !== card || !state.modalOpen) return false;
          return runHandlingAction({run: work}, card, declaration);
        },
      });
    } catch (error) {
      dispose();
      container.appendChild(element('p', 'review-error', String(error.message || error)));
    }
  }

  function renderSplit() {
    const dialog = state.modal;
    if (!dialog) return;
    const declaration = currentDeclaration();
    const card = activeCard();
    disposeHandlingPanel();
    if (!declaration || !card) { clear(dialog); return; }
    // 详情补齐只替换左栏；同卡同凭据的 iframe 始终留在原父节点，避免重新加载 PDF。
    const evidenceKey = JSON.stringify([declaration.key, card.id, declaration.rightSlot,
      (card.evidence || []).map(item => { const copy = Object.assign({}, item); delete copy.available; return copy; })]);
    const previousBody = dialog.querySelector('.review-split-body');
    const previousRight = previousBody && previousBody.querySelector('[data-review-slot="right"]');
    const keepRight = previousRight && dialog._reviewEvidenceKey === evidenceKey
      && !previousRight.querySelector('[data-review-candidate]');
    if (keepRight) {
      Array.from(dialog.children).forEach(child => { if (child !== previousBody) dialog.removeChild(child); });
      Array.from(previousBody.children).forEach(child => { if (child !== previousRight) previousBody.removeChild(child); });
    } else { disposeOriginalMedia(dialog); clear(dialog); }
    dialog._reviewEvidenceKey = evidenceKey;

    const head = element('header', 'review-split-head');
    const titles = element('div', 'review-split-titles');
    if (card.domain) {
      /* 域标签走**公共徽标件** `.tag`（`css/deepseek.css`：灰底、无边框、圆角 `--r-xs`）——
         规范 §4「徽标不许带边框」；早先这里是**裸文字**，跟全站徽标不是一套。
         ⚠️ 本体是 **`span`**（行内件）—— 早先用 `div`，块级 ⇒ 徽标底色**铺满整行**，
            弹窗表头里成了一条灰带（2026-10-23 实踩，判据 os-dialog ⑧ 盯着）。 */
      const domain = element('span', 'review-split-domain tag', card.domain);
      domain.setAttribute('data-review-split-domain', '1');
      titles.appendChild(domain);
    }
    const title = element('h2', '', card.title);
    title.id = 'reviewSplitTitle';
    title.setAttribute('data-review-split-title', '1');
    titles.appendChild(title);
    if (card.summary) titles.appendChild(element('p', 'review-split-summary', card.summary));
    head.appendChild(titles);
    /* 关闭按钮走**公共图标按钮件** `.wf-icon-btn`（`css/platform.css`：30×30 固定盒、
       SVG 15px、hover 有底色）—— 早先是自己造的 `.iconbutton`（**全站没有这个公共件**）。 */
    const close = element('button', 'wf-icon-btn');
    close.type = 'button';
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.setAttribute('aria-label', '关闭核对窗口');
    close.setAttribute('data-review-split-close', '1');
    close.addEventListener('click', () => { closeCard(); });
    head.appendChild(close);
    if (keepRight) dialog.insertBefore(head, previousBody);
    else dialog.appendChild(head);

    /* 公共件的三段是 header／**main**／footer —— 正文那一段要用 `main` 标签，
       公共件的 `.os-dialog main{padding:20px;overflow:auto;max-height:60dvh}` 才管得到它
       （我们自己的修饰类再把它改成「两栏各自滚」，见 css/review-center.css）。 */
    const body = keepRight ? previousBody : element('main', 'review-split-body');
    const ctx = splitContext();
    const right = keepRight ? previousRight : renderSlot('right', card.evidence || [], ctx);
    const mountBody = left => {
      if (keepRight) body.insertBefore(left, right);
      else { body.appendChild(left); body.appendChild(right); dialog.appendChild(body); }
      void mountOriginals(body);
    };
    if (state.detailLoading || state.detailError) {
      const pending = element('section', 'review-slot review-slot-left');
      const message = element('p', state.detailError ? 'review-error' : 'review-center-note',
        state.detailError || '正在读取这一项的核对内容…');
      message.setAttribute('role', state.detailError ? 'alert' : 'status');
      pending.appendChild(message);
      if (card.digest) pending.appendChild(element('p', 'review-split-summary', card.digest));
      if (state.detailError) {
        const retry = element('button', 'btn btn-ghost', '重新读取');
        retry.setAttribute('data-review-detail-retry', '1');
        retry.addEventListener('click', () => { void readCardDetail(declaration, card); });
        pending.appendChild(retry);
      }
      mountBody(pending);
      return;
    }
    const left = panelBlocksReview(declaration, card)
      ? element('section', 'review-slot review-slot-left') : renderSlot('left', card.changes, ctx);
    if (!panelBlocksReview(declaration, card)) {
      const checklist = renderChecks(card);
      if (checklist) left.appendChild(checklist);
    }
    mountBody(left);
    mountHandlingPanel(left, declaration, card);

    const foot = element('footer', 'review-split-foot');
    const progressValue = progressText(card);
    if (progressValue) {
      const progress = element('span', 'review-split-progress', progressValue);
      progress.setAttribute('data-review-progress', '1');
      foot.appendChild(progress);
    }
    const receipt = element('span', 'review-split-receipt', state.receipt || '');
    receipt.setAttribute('data-review-receipt', '1');
    receipt.hidden = !state.receipt;
    foot.appendChild(receipt);
    const actions = element('div', 'review-footer-actions');
    /* —— **域给内容、审核中心开出来的那一页**（域给按钮 ＋ 域给字段，壳把它开在审核弹窗里）。 —— */
    const domainOwnPage = domainPage(declaration);
    if (domainOwnPage && domainOwnPage.label) {
      const pageButton = element('button', 'btn btn-ghost', String(domainOwnPage.label));
      pageButton.type = 'button';
      pageButton.setAttribute('data-review-domain-page', String(domainOwnPage.id || 'page'));
      pageButton.addEventListener('click', () => {
        state.domainPage = { open: true, id: String(domainOwnPage.id || 'page'), values: {} };
        render();
      });
      actions.appendChild(pageButton);
    }
    const preparationActions = (declaration.handling && declaration.handling.actions) || [];
    preparationActions.forEach(action => {
      if (action.visible && !action.visible(card)) return;
      const button = element('button', 'btn btn-ghost', action.label);
      button.type = 'button';
      button.setAttribute('data-review-handling-action', action.id);
      button.disabled = state.busy || Boolean(action.disabled && action.disabled(card));
      button.addEventListener('click', () => { void runHandlingAction(action, card, declaration); });
      actions.appendChild(button);
    });
    /* 第 9 类：只有**声明里明确可执行**的处理方式才显示对应入口
       （本期默认只有「采用/改写 → 明确保存」与「暂不处理后关闭」）。 */
    const handling = (declaration.handling && declaration.handling.entries) || [];
    const canDifference = handling.includes('difference') && typeof declaration.handling.difference === 'function';
    const canReject = handling.includes('reject') && typeof declaration.handling.reject === 'function';
    if (canDifference && canReject) {
      /* —— **两个入口合成一个**（用户 2026-10-28 14:1x：「退回检查和信息有误是什么情况？
         能不能合并成一页？」）—— 底栏**只摆一个**按钮；点它开**一页**表单
         （**选是哪一种** ＋ 理由）。
         ⚠️ **两个结果不一样**（difference＝落待补充材料；reject＝整组退回）⇒
         表单里要让人**选**，不许替他挑。 */
      const problem = element('button', 'btn btn-ghost', problemLabel(declaration));
      problem.type = 'button';
      problem.setAttribute('data-review-problem', '1');
      problem.addEventListener('click', () => {
        state.difference = { open: true, kind: 'problem', problemKind: 'difference', reason: '', error: '' };
        render();
      });
      actions.appendChild(problem);
    } else if (canDifference) {
      const difference = element('button', 'btn btn-ghost', '信息有误／待核实');
      difference.type = 'button';
      difference.setAttribute('data-review-difference', '1');
      difference.addEventListener('click', () => {
        state.difference = { open: true, kind: 'difference', reason: '', error: '' };
        render();
      });
      actions.appendChild(difference);
    } else if (canReject) {
      const reject = element('button', 'btn btn-ghost', '退回检查');
      reject.type = 'button';
      reject.setAttribute('data-review-reject', '1');
      reject.addEventListener('click', () => {
        state.difference = { open: true, kind: 'reject', reason: '', error: '' };
        render();
      });
      actions.appendChild(reject);
    }
    const save = element('button', 'btn btn-pri', saveLabel(declaration));
    save.type = 'button';
    save.setAttribute('data-review-save', '1');
    save.disabled = !canSave(declaration, card);
    save.addEventListener('click', () => { void saveActiveCard(); });
    actions.appendChild(save);
    foot.appendChild(actions);
    const handlingError = element('span', 'review-error');
    handlingError.setAttribute('data-review-handling-error', '1');
    handlingError.hidden = true;
    foot.appendChild(handlingError);
    dialog.appendChild(foot);
    if (state.difference.open) dialog.appendChild(renderHandlingForm(card));
    /* —— **域给内容、审核中心开出来的那一页**（开在审核弹窗**里面**）—— */
    if (state.domainPage && state.domainPage.open) {
      const own = domainPage(declaration);
      if (own) dialog.appendChild(renderDomainPage(card, own, state.domainPage));
    }
    /* 原件已在 mountBody 中按需启动，与详情读取并行。 */
  }

  async function runHandlingAction(action, card, declaration) {
    if (state.busy || state.detailLoading || state.detailError || activeCard() !== card || !state.modalOpen) return;
    state.busy = true;
    const dialog = state.modal;
    const errorNode = dialog.querySelector('[data-review-handling-error]');
    if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const previousDisabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try {
      const outcome = await action.run(card);
      if (outcome === false) return;
      // 准备操作可能产出另一类审核；仅并行重取本声明和显式返回的声明。
      await refreshReviewDeclarations([declaration.key, ...((outcome && outcome.refreshDeclarations) || [])]);
      if (state.pageSignal && state.pageSignal.aborted) return;
      if (state.activeCardId === card.id && state.tab === declaration.key) {
        state.adopt.clear();
        state.edits.clear();
        state.editing = null;
        state.checks.delete(card.id);
      }
      const target = outcome && outcome.openCard;
      if (target && (state.cards[target.declaration] || []).some(item => item.id === target.id)) {
        openCard(target.declaration, target.id);
      } else if (!activeCard()) {
        closeCard();
      } else render();
    } catch (error) {
      if (!isAbortError(error) && errorNode && state.modalOpen && activeCard() === card) {
        errorNode.textContent = String((error && error.message) || '处理失败，请重试。');
        errorNode.hidden = false;
      }
    } finally {
      state.busy = false;
      buttons.forEach((button, index) => { button.disabled = previousDisabled[index]; });
      // 成功刷新时按钮已换成新的；按当前卡重新解除忙碌状态。
      if (state.modalOpen && state.modal) {
        const current = activeCard();
        for (const item of (((currentDeclaration() || {}).handling || {}).actions || [])) {
          const button = Array.from(state.modal.querySelectorAll('[data-review-handling-action]'))
            .find(node => node.getAttribute('data-review-handling-action') === item.id);
          if (button && current) button.disabled = Boolean(item.disabled && item.disabled(current));
        }
      }
      updateSplitProgress();
    }
  }

  async function refreshReviewDeclarations(keys) {
    const unique = Array.from(new Set(keys));
    unique.forEach(key => {
      if (!declarations.has(key)) throw Error('处理结果引用了未注册的审核类型：' + key);
    });
    // 仅并行请求受影响来源；全部读成功后再替换其快照。
    const results = await Promise.all(unique.map(async key => {
      const spec = declarations.get(key);
      /* —— **同一份分页契约**（`page`／`pageLength`／`scope`／`q`）——
       *   这一处也是「读」⇒ **原样带上这一页的取消信号**。 */
      const raw = await spec.list({
        signal: state.pageSignal || null,
        page: Math.max(1, Number(state.paging.pending.page) || 1),
        pageLength: state.screenCards,
        scope: 'pending',
        q: String(state.search || ''),
      });
      return { key, normalized: normalizeCards(raw, spec) };
    }));
    if (state.pageSignal && state.pageSignal.aborted) return;
    results.forEach(({ key, normalized }) => {
      const store = state.scopeStore.pending || (state.scopeStore.pending = {});
      store[key] = {
        cards: normalized.cards,
        legacy: normalized.legacy,
        total: normalized.total,
        page: Math.max(1, Number(state.paging.pending.page) || 1),
        error: '',
      };
      state.cards[key] = normalized.cards;
      state.notices[key] = normalized.notice || '';
      state.counts[key] = normalized.cards.reduce((sum, item) => sum + item.changes.length, 0);
      delete state.declErrors[key];
    });
  }

  /** 处理方式的小表单：**要填原因**（域自己那份动作要求非通过必须写理由）。 */
  const HANDLING_LABELS = {
    difference: { button: '信息有误／待核实', title: '差异说明', error: '请填写差异说明后重试。', done: '已记录差异。' },
    reject: { button: '退回检查', title: '退回原因', error: '请填写退回原因后重试。', done: '已退回。' },
    /* —— **两个入口合成的那一个**（用户 2026-10-28 14:1x）。 —— */
    problem: { button: '有问题要说明', title: '哪里有问题（写一句为什么）', error: '请写一句为什么。', done: '已记录。' },
  };

  /**
   * **域给内容、审核中心开出来的那一页**（2026-10-28 14:3x · 用户口径：
   * 「域给一个按钮 ＋ 域自己的弹窗，这个是在审核中心的地盘上，所以由审核中心开出来给example」）。
   *
   * · **域**声明 `handling.page = { id, label, fields, submit }`：
   *   `fields` ＝ 这一页有哪些字段（文字／勾选），`submit(card, values)` ＝ 提交后做什么；
   * · **审核中心（壳）**只负责：把这个按钮摆进底栏 ＋ **把这一页开在审核弹窗里面**
   *   （不是另开一个浮层 ⇒ 人始终在审核中心这一屏里）＋ 把人填的值交给域。
   *
   * ⚠️ **这是内核路径**（壳是公共件）⇒ 标 **CORE-CANDIDATE**。
   */
  function domainPage(declaration) {
    const page = (declaration && declaration.handling && declaration.handling.page) || null;
    if (!page || typeof page.submit !== 'function' || !Array.isArray(page.fields)) return null;
    return page;
  }

  /** 「有问题」那个入口的按钮文案（**域给**；没给就用公共那一句）。 */
  function problemLabel(declaration) {
    const problem = (declaration && declaration.handling && declaration.handling.problem) || {};
    return String(problem.label || HANDLING_LABELS.problem.button);
  }

  /** 「有问题」那一页里的**两种选择**（**域给**；没给就用公共那两句）。 */
  function problemKinds(declaration) {
    const problem = (declaration && declaration.handling && declaration.handling.problem) || {};
    const kinds = Array.isArray(problem.kinds) ? problem.kinds.filter(item => item && item.id) : [];
    if (kinds.length) return kinds;
    return [{ id: 'difference', label: '内容有误' }, { id: 'reject', label: '要退回重新核对' }];
  }

  function renderHandlingForm(card) {
    const declaration = currentDeclaration();
    const kind = state.difference.kind || 'difference';
    const labels = HANDLING_LABELS[kind] || HANDLING_LABELS.difference;
    const form = element('div', 'review-inline-form');
    form.setAttribute('data-review-difference-form', '1');
    form.setAttribute('data-review-handling-kind', kind);
    if (kind === 'problem') {
      /* —— **选是哪一种**（两个结果不一样 ⇒ 不许替他挑）。
       *   ⚠️ **2026-10-28 14:3x（用户口径）**：现在只剩**一种**结果（打回）
       *   ⇒ **一种就不摆单选**（一个只有一项的单选框是噪音）。 —— */
      const kinds = problemKinds(declaration);
      const choice = element('div', 'review-problem-choices');
      choice.setAttribute('data-review-problem-choices', '1');
      const chosen = state.difference.problemKind || 'difference';
      kinds.forEach(item => {
        const label = element('label', 'review-problem-choice');
        const radio = doc.createElement('input');
        radio.setAttribute('type', 'radio');
        radio.setAttribute('name', 'review-problem-kind');
        radio.setAttribute('data-review-problem-kind', String(item.id));
        radio.checked = String(item.id) === chosen;
        radio.addEventListener('change', () => { state.difference.problemKind = String(item.id); });
        label.appendChild(radio);
        label.appendChild(element('span', 'review-problem-choice-text', String(item.label || item.id)));
        if (item.note) label.appendChild(element('span', 'review-problem-choice-note', String(item.note)));
        choice.appendChild(label);
      });
      if (kinds.length > 1) form.appendChild(choice);
      /* —— **二次确认**（域给的那一句）：勾了才做那件**不可逆**的事（这里是删原件）。
       *   域不给这一句 ⇒ 这一页就只有一个理由框。 —— */
      const problem = (declaration && declaration.handling && declaration.handling.problem) || {};
      const confirmSpec = problem.confirm || {};
      if (confirmSpec.label) {
        const confirmLabel = element('label', 'review-problem-confirm');
        confirmLabel.setAttribute('data-review-problem-confirm', '1');
        const box = doc.createElement('input');
        box.setAttribute('type', 'checkbox');
        box.setAttribute('data-review-problem-confirm-box', '1');
        box.checked = Boolean(state.difference.problemConfirm);
        box.addEventListener('change', () => { state.difference.problemConfirm = box.checked; });
        confirmLabel.appendChild(box);
        confirmLabel.appendChild(element('span', 'review-problem-confirm-text', String(confirmSpec.label)));
        form.appendChild(confirmLabel);
      }
    }
    const input = doc.createElement('textarea');
    input.setAttribute('data-review-difference-reason', '1');
    input.setAttribute('rows', '2');
    input.setAttribute('aria-label', labels.title);
    input.value = state.difference.reason;
    form.appendChild(input);
    const actions = element('div', 'review-actions');
    const submit = element('button', 'btn btn-pri btn-sm', '提交');
    submit.type = 'button';
    submit.setAttribute('data-review-difference-submit', '1');
    submit.addEventListener('click', () => { void submitHandling(card, declaration, kind, input.value); });
    actions.appendChild(submit);
    const cancel = element('button', 'btn btn-ghost btn-sm', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { state.difference = { open: false, kind: '', reason: '', error: '' }; render(); });
    actions.appendChild(cancel);
    form.appendChild(actions);
    const error = element('p', 'review-error', state.difference.error);
    error.setAttribute('data-review-difference-error', '1');
    form.appendChild(error);
    return form;
  }

  /** **域给的那一页**（字段由域给，壳只画与收）。 */
  function renderDomainPage(card, page, statePage) {
    const form = element('div', 'review-inline-form');
    form.setAttribute('data-review-domain-page-form', String(page.id || 'page'));
    if (page.title) form.appendChild(element('p', 'review-note', String(page.title)));
    const inputs = {};
    (page.fields || []).forEach(field => {
      const spec = field || {};
      const key = String(spec.key || '');
      if (!key) return;
      const label = element('label', 'review-field');
      label.appendChild(element('span', 'review-field-label', String(spec.label || key)));
      if (spec.type === 'checkbox') {
        const box = doc.createElement('input');
        box.setAttribute('type', 'checkbox');
        box.setAttribute('data-review-domain-page-field', key);
        box.checked = Boolean((statePage.values || {})[key]);
        box.addEventListener('change', () => { statePage.values[key] = box.checked; });
        inputs[key] = box;
        label.appendChild(box);
      } else {
        const input = doc.createElement('textarea');
        input.setAttribute('rows', String(spec.rows || 2));
        input.setAttribute('aria-label', String(spec.label || key));
        input.setAttribute('data-review-domain-page-field', key);
        input.value = String((statePage.values || {})[key] || '');
        inputs[key] = input;
        label.appendChild(input);
      }
      form.appendChild(label);
    });
    const actions = element('div', 'review-actions');
    const submit = element('button', 'btn btn-pri btn-sm', String(page.submitLabel || '提交'));
    submit.type = 'button';
    submit.setAttribute('data-review-domain-page-submit', '1');
    submit.addEventListener('click', () => { void submitDomainPage(card, page, inputs); });
    actions.appendChild(submit);
    const cancel = element('button', 'btn btn-ghost btn-sm', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { state.domainPage = { open: false, id: '', values: {} }; render(); });
    actions.appendChild(cancel);
    form.appendChild(actions);
    const error = element('p', 'review-error', statePage.error || '');
    error.setAttribute('data-review-domain-page-error', '1');
    form.appendChild(error);
    return form;
  }

  async function submitDomainPage(card, page, inputs) {
    if (state.pageDisposed || !state.modalOpen || state.busy || state.detailLoading || state.detailError || activeCard() !== card) return;
    const values = {};
    (page.fields || []).forEach(field => {
      const spec = field || {};
      const key = String(spec.key || '');
      if (!key) return;
      const node = inputs[key];
      if (!node) return;
      const value = spec.type === 'checkbox' ? Boolean(node.checked) : String(node.value || '').trim();
      if (spec.required && spec.type !== 'checkbox' && !value) {
        state.domainPage = { open: true, id: String(page.id || 'page'),
          values: Object.assign({}, state.domainPage.values), error: '请先填「' + String(spec.label || key) + '」。' };
        render();
        return;
      }
      values[key] = value;
    });
    state.busy = true;
    render();
    try {
      await page.submit(card, values);
      state.domainPage = { open: false, id: '', values: {} };
      state.receipt = String(page.done || '已处理。');
    } catch (error) {
      state.domainPage = { open: true, id: String(page.id || 'page'), values,
        error: '保存失败：' + (error && error.message ? error.message : '请重新加载。') };
    }
    state.busy = false;
    await refreshReviewDeclarations([(declarationKeyOf() || '')]);
    render();
  }

  function declarationKeyOf() {
    const declaration = currentDeclaration();
    return declaration ? declaration.key : '';
  }

  async function submitHandling(card, declaration, kind, raw) {
    if (state.pageDisposed || !state.modalOpen || state.busy || state.detailLoading || state.detailError || activeCard() !== card) return;
    const labels = HANDLING_LABELS[kind] || HANDLING_LABELS.difference;
    const reason = String(raw || '').trim();
    if (!reason) {
      state.difference = { open: true, kind, problemKind: state.difference.problemKind,
        problemConfirm: state.difference.problemConfirm, reason: raw || '', error: labels.error };
      render();
      return;
    }
    /* —— **合成的那一页**：按人**选的那一种**落（两个结果不一样）。 —— */
    const effective = kind === 'problem' ? (state.difference.problemKind || 'difference') : kind;
    state.busy = true;
    render();
    try {
      /* —— **把「二次确认勾没勾」一并交给域**（域据此决定那件不可逆的事做不做）。 —— */
      const options = { confirm: Boolean(state.difference.problemConfirm) };
      if (effective === 'reject') await declaration.handling.reject(card, reason, options);
      else await declaration.handling.difference(card, reason, options);
      card.state = effective === 'reject' ? 'rejected' : 'difference';
      card.note = (effective === 'reject' ? '已退回：' : '已记录差异：') + reason;
      state.difference = { open: false, kind: '', reason: '', error: '' };
      state.receipt = labels.done;
    } catch (error) {
      state.difference = {
        open: true, kind, reason,
        error: '保存失败：' + (error && error.message ? error.message : '请重新加载。'),
      };
    }
    state.busy = false;
    await refreshReviewDeclarations([declaration.key, ...((declaration.execution || {}).refreshDeclarations || [])]);
    render();
  }

  /**
   * **这一次的提交集合**（契约 §save_policy.partial_false.scope_unchanged_by_view）：
   *   折叠/搜索/重排**只改变阅读方式，不改变提交集合** ⇒ 提交集合由**声明的整组范围**说了算。
   *
   * ⚠️ **整组范围只有两种写法**（PKG-121 · 缺口③）：
   *   ① **函数**（`group: card => [...]`）—— 域自己算这次要一起提交的是哪几项；
   *   ② **字符串 `'card'`** —— 整组＝**本卡片的全部变更**。
   * **原来这里只认函数**（`typeof policy.group === 'function'`）⇒ 域写字符串 `'card'` 时
   *   **靠「落到最后一行」才碰巧对**（整卡＝全部变更，恰好是 `'card'` 的意思）
   *   ⇒ 域**写任何别的字符串**（比如 `'row'`）也一样悄悄按整卡算，**没人知道**。
   * ⇒ 现在：这两种写法**都显式认**；认不出的写法**注册时就被拒了**
   *   （`validateDeclaration`），真走到这里（老代码／别的入口塞进来的）⇒ **取最严那档**（整卡）。
   */
  function groupChangesOf(declaration, card) {
    const policy = (declaration && declaration.savePolicy) || {};
    if (policy.partial !== false) return card.changes;
    if (typeof policy.group === 'function') {
      const ids = policy.group(card) || [];
      const set = new Set(ids.map(String));
      return card.changes.filter(change => set.has(String(change.id)));
    }
    /* `'card'`＝整组＝本卡片的全部变更；认不出的写法也按整卡（最严那档）。 */
    return card.changes;
  }

  /** 这一组一共要核几项：可采用的变更 ＋ 必核清单项。 */
  function groupSize(card) {
    const declaration = declarations.get(card.declaration);
    const adoptable = groupChangesOf(declaration, card).filter(change => change.adoptable !== false).length;
    const checks = Array.isArray(card.checks) ? card.checks.length : 0;
    return adoptable + checks;
  }

  function progressText(card) {
    const declaration = declarations.get(card.declaration);
    const group = groupChangesOf(declaration, card);
    const total = groupSize(card);
    /* —— **结论类**不给「已核对 N/M 项」那个计数（没有可逐项核的东西了，
       只剩「核完／没核完」这一下）—— 摆「已核对 0/0 项」是骗人。
       ⚠️ **订正（2026-10-25 · PKG-102-T02）**：上面那句说的是「结论类**一律**不给」，
       **但实现是「只在『一项都没有』（`total` 为 0）时才不给」** —— **原句保留**（那是当初的意图）。
       **现在结论类那张卡有三项可以逐项核的**（通知书信息核对／缴费金额／附件齐备，
       值在原位＝单击暂存／双击改写）⇒ 底下那个「**已核对 0/3 项**」**是实话**
       （核了几项就写几项）⇒ **行为一个字不动**，只是把注释改成与实现一致。
       ⚠️ **口径是问询超时后系统自动选中的默认项，用户尚未亲口确认**（用户可以随时改）。 */
    if (isConcludeDeclaration(declaration) && !total) return '';
    const adopted = group.filter(change => change.adoptable !== false && adoptState(change.id) !== 'pending').length;
    const checked = (Array.isArray(card.checks) ? card.checks : [])
      .filter(check => checksOf(card).get(check.key)).length;
    return '已核对 ' + (adopted + checked) + '/' + total + ' 项';
  }

  function saveLabel(declaration) {
    /* —— **结论类**：按钮写「核对无误」（不是「确认所选 0 项」那种没人话的字）。 */
    if (isConcludeDeclaration(declaration)) return '核对无误';
    const policy = declaration.savePolicy || {};
    if (policy.partial === false) return '整组保存';
    const card = activeCard();
    if (!card) return '确认所选 0 项';
    const count = card.changes.filter(change => change.adoptable !== false && adoptState(change.id) !== 'pending').length;
    return '确认所选 ' + count + ' 项';
  }

  /**
   * 能不能提交：整组模式要求全核过；部分模式至少选了一项；
   * **必需凭据失败 ⇒ 只挡它对应的那一组**（不是整张卡）。
   */
  function canSave(declaration, card) {
    if (state.pageDisposed || state.detailLoading || state.detailError) return false;
    if (!declaration || !card || panelBlocksReview(declaration, card)) return false;
    const policy = declaration.savePolicy || {};
    const group = groupChangesOf(declaration, card);
    const adoptable = group.filter(change => change.adoptable !== false);
    const done = adoptable.filter(change => adoptState(change.id) !== 'pending').length;
    const checks = Array.isArray(card.checks) ? card.checks : [];
    const checked = checks.filter(check => checksOf(card).get(check.key)).length;
    if (checked < checks.length) return false;          // 必核清单没全勾 ⇒ 不许提交
    /* —— **必需凭据失败 ⇒ 挡的是「它支持的那一组」**（契约 §declaration.ten.4.runtime：
       「必需凭据打不开时，不许确认**它支持的内容**；辅助材料失败**不阻断无关的独立项**」）。
       ⚠️ **原来这里是卡级的**（一张卡有一个必需凭据坏了 ⇒ 整张卡都不许存）⇒
       辅助凭据坏了也把不相干的另一组卡住（PKG-099 · G6 判据抓出来的真缺口）。 */
    const blocked = blockedGroupsByEvidence(declaration, card);
    const isBlocked = list => list.some(change => blocked.has(groupKeyOf(change)));
    /* —— **结论类**：核完就能给结论 —— **不再要求逐项勾那个必核清单**。
       用户 2026-10-24 22:34：「为什么还要多此一举的大勾」⇒ 那三个勾是这个产品
       早期给「必核清单」留的闸门；结论类卡片改用**单击／双击**给结论。 */
    if (isConcludeDeclaration(declaration)) return !isBlocked(group);
    if (policy.partial === false) {
      if (isBlocked(group)) return false;
      return done === adoptable.length && done > 0;
    }
    /* —— **部分模式**：只挡**这一次真要提交的那几项**所在的组；
       被挡的组没被选中 ⇒ 不挡这一次的提交（辅助材料坏了只提示）。 */
    const chosen = adoptable.filter(change => adoptState(change.id) !== 'pending');
    if (isBlocked(chosen)) return false;
    return done > 0 || checks.length > 0;
  }

  /* ========== 结论类：提交按钮写人话，别的跟别的卡一样 ========== */

  /** 这一类审核是不是「下结论」那一类（核完给结论，不是改写正式值）。 */
  function isConcludeDeclaration(declaration) {
    return !!(declaration && declaration.handling && declaration.handling.mode === 'conclude');
  }

  /**
   * **这一项属于哪个内容组**（按提案分 —— 一份提案＝一组；没提案就按它自己那一项单算一组）。
   */
  function groupKeyOf(change) {
    const unit = (change && change.unit) || {};
    const proposalId = String(unit.proposalId || '');
    if (proposalId) return proposalId;
    return 'change:' + String((change && change.id) || '');
  }

  /**
   * **必需凭据失败 ⇒ 挡住了哪些内容组**（契约 §declaration.ten.4.runtime）。
   *
   * **对应关系从哪儿来**（契约十类第 4 类：「**每个变化/内容组对应哪些凭据**」）：
   * 凭据行上的 `changes` 说它对应哪几项（项的 id）⇒ 坏了就只挡那几项所在的组；
   * **没写 `changes`** ⇒ 它管**整张卡**（老声明按老样子：一张卡一份凭据，坏了就整张卡不许确认）。
   *
   * ⚠️ **辅助凭据（`required` 不为真、也不在声明的必需清单里）失败只提示，不挡任何组**
   *   —— 这一条原来做不到（那时是卡级判断），是 PKG-099 · G6 判据抓出来的真缺口。
   */
  function blockedGroupsByEvidence(declaration, card) {
    const requiredIds = (declaration && declaration.evidenceBinding && declaration.evidenceBinding.required) || [];
    const evidence = (card && card.evidence) || [];
    const changes = (card && card.changes) || [];
    const blocked = new Set();
    const everyGroup = new Set();
    changes.forEach(change => {
      const key = groupKeyOf(change);
      if (key) everyGroup.add(key);
    });
    evidence.forEach(item => {
      if (!item) return;
      const required = item.required === true || requiredIds.includes(String(item.id));
      if (!required) return;                       // 辅助凭据失败只提示，不挡
      const broken = item.available === false || !item.locator;
      if (!broken) return;
      const ids = Array.isArray(item.changes) ? item.changes.map(String) : [];
      if (!ids.length) {                          // 没指到哪几项 ⇒ 它管整张卡
        everyGroup.forEach(key => blocked.add(key));
        return;
      }
      changes.forEach(change => {
        if (ids.includes(String(change.id))) {
          const key = groupKeyOf(change);
          if (key) blocked.add(key);
        }
      });
    });
    return blocked;
  }

  function cancelCardDetail() {
    state.detailReadGeneration += 1;
    if (state.detailController) state.detailController.abort();
    state.detailController = null;
    state.detailLoading = false;
    state.detailError = '';
  }

  async function readCardDetail(declaration, card) {
    const revalidating = Boolean(state.detailError);
    const editor = state.editing && candidateCell(state.editing)?.querySelector('[data-review-edit]');
    if (editor) state.edits.set(state.editing, editor.value);
    cancelCardDetail();
    const generation = state.detailReadGeneration;
    const pageSignal = state.pageSignal;
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    state.detailController = controller;
    state.detailLoading = true;
    const abort = () => { if (controller) controller.abort(); };
    if (pageSignal) pageSignal.addEventListener('abort', abort, { once: true });
    const isCurrent = () => generation === state.detailReadGeneration && state.modalOpen
      && state.tab === declaration.key && state.activeCardId === card.id && !(pageSignal && pageSignal.aborted);
    renderSplit();
    try {
      if (pageSignal && pageSignal.aborted) return;
      const options = { signal: controller ? controller.signal : pageSignal };
      let raw;
      if (declaration.detail) raw = await declaration.detail(card, options);
      else {
        const listing = await declaration.list(options);
        const rows = Array.isArray(listing) ? listing : listing && listing.cards;
        raw = (Array.isArray(rows) ? rows : []).find(item => String(item.id) === card.id);
        if (!raw) throw Error('这一事项已不在待审范围，改写仍保留；请关闭后核对最新结果。');
      }
      if (!isCurrent()) return;
      if (!raw || String(raw.id) !== card.id) throw new Error('核对内容与当前事项不一致，请重新读取');
      const detailed = normalizeCards([raw], declaration).cards[0];
      if (!detailed) {
        state.cards[declaration.key] = (state.cards[declaration.key] || []).filter(item => item.id !== card.id);
        state.counts[declaration.key] = state.cards[declaration.key].reduce((sum, item) => sum + item.changes.length, 0);
        state.receipt = '这一项已没有待核对的变化。';
        closeCard();
        return;
      }
      state.cards[declaration.key] = (state.cards[declaration.key] || []).map(item => item.id === card.id ? detailed : item);
      state.counts[declaration.key] = state.cards[declaration.key].reduce((sum, item) => sum + item.changes.length, 0);
      if (revalidating) {
        state.adopt.clear();
        state.editing = null;
        state.checks.delete(card.id);
        state.receipt = '已重新读取；原改写仍保留，请根据最新内容重新核对。';
      }
    } catch (error) {
      if (isCurrent()) state.detailError = error && error.message ? error.message : '这一项读取中断，请重试';
    } finally {
      if (pageSignal) pageSignal.removeEventListener('abort', abort);
      if (isCurrent()) {
        state.detailLoading = false;
        state.detailController = null;
        renderSplit();
      }
    }
  }

  function openCard(declarationKey, cardId) {
    /* ⚠️ **驳回的卡点不开**（PKG-068-T01）：只读快照，没有原件、没有下载。 */
    if (cardIsRejected((state.cards[declarationKey] || []).find(item => item.id === cardId))) return;
    const declaration = declarations.get(declarationKey);
    if (!declaration) return null;
    cancelCardDetail();
    state.tab = declarationKey;
    state.activeCardId = cardId;
    state.adopt.clear();
    state.edits.clear();
    state.editing = null;
    state.difference = { open: false, kind: '', reason: '', error: '' };
    const card = activeCard();
    if (card) {
      const fingerprint = String(card.preconditionKey || '') + '|' + (card.raw && card.raw.preconditionFingerprint ? card.raw.preconditionFingerprint : '');
      const previous = state.fingerprints.get(card.id);
      if (previous !== undefined && previous !== fingerprint) {
        /* 换了案件/换了原件 ⇒ 旧核对作废（契约 §declaration.ten.7.runtime）。 */
        card.changes.forEach(change => clearAdopt(change.id));
      }
      state.fingerprints.set(card.id, fingerprint);
    }
    const dialog = ensureSplitDialog();
    state.modalOpen = true;
    state.detailLoading = Boolean(declaration.detail && card);
    renderSplit();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (declaration.detail && card) void readCardDetail(declaration, card);
    return card;
  }

  function closeCard() {
    const card = activeCard();
    if (card) {
      const dirty = card.changes.some(change => adoptState(change.id) !== 'pending');
      if (dirty && typeof global.confirm === 'function') {
        const keep = global.confirm('这一组有还没保存的核对结果，要放弃吗？');
        if (!keep) return;
      }
      card.changes.forEach(change => clearAdopt(change.id));
    }
    cancelCardDetail();
    disposeHandlingPanel();
    disposeOriginalMedia(state.modal);
    state.modalOpen = false;
    state.activeCardId = null;
    state.difference = { open: false, kind: '', reason: '', error: '' };
    const dialog = state.modal;
    if (dialog) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    render();
  }

  async function openOriginal(item) {
    if (typeof global.shangshuOpenFile === 'function') { await global.shangshuOpenFile(item); return; }
    const reference = item && (item.reference || item.file || item.url);
    if (reference && typeof global.open === 'function') {
      global.open('api/platform/file-content?file=' + encodeURIComponent(reference), '_blank');
    }
  }

  // ========== 保存（两种方式） ==========

  /** 内核默认保存动作：逐项走内核**确认 Action**（正式值只经它写）。 */
  async function defaultKernelAccept(groups, options) {
    const receipts = [];
    for (const entry of groups) {
      const units = entry.units.map(item => item.unitId).filter(Boolean);
      const revision = (entry.units.find(item => item.reviewRevision) || {}).reviewRevision;
      const edits = {};
      entry.units.forEach(item => {
        if (item.edited !== undefined && item.edited !== null) {
          edits[item.unitId] = { type: 'text', value: String(item.edited) };
        }
      });
      try {
        const data = await fetchJson('api/platform/action-proposals/' + encodeURIComponent(entry.proposalId) + '/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            units,
            expected_review_revision: revision,
            edited_value: edits,
            op_id: opId('review-center'),
          }),
        });
        receipts.push({ id: entry.proposalId, ok: true, units, status: data && data.status });
      } catch (error) {
        receipts.push({
          id: entry.proposalId, ok: false, units,
          error: error && error.message ? error.message : '保存失败',
          /* —— **带上状态码**（PKG-099 · G2）：409 ＝ 冲突（别人刚改过，要重新核对），
             跟「保存失败」不是一回事 ⇒ 不许混成一句。 */
          status: Number(error && error.status) || 0,
          unknown: !isRegisteredFailure(error),
        });
      }
    }
    return receipts;
  }

  /** 把选中的变更按提案分组。 */
  function groupUnits(changes) {
    const groups = new Map();
    changes.forEach(change => {
      const unit = change.unit || {};
      const proposalId = String(unit.proposalId || '');
      if (!proposalId) return;
      if (!groups.has(proposalId)) groups.set(proposalId, []);
      groups.get(proposalId).push({
        unitId: unit.unitId,
        reviewRevision: unit.reviewRevision,
        edited: state.edits.get(change.id),
      });
    });
    return Array.from(groups.entries()).map(entry => ({ proposalId: entry[0], units: entry[1] }));
  }

  /**
   * **保存这一组**（契约 §save_policy）：
   *   · 整组模式：必须全核过，提交**整组**；
   *   · 部分模式：只提交**选中的**那几个 unit，其余仍待审。
   * 正式值**只经内核的确认 Action 写**（不许另造一条写正式值的路）。
   */
  async function saveActiveCard() {
    if (!state.modalOpen || state.pageDisposed || state.busy || state.detailLoading || state.detailError) return;
    const declaration = currentDeclaration();
    const card = activeCard();
    if (!declaration || !card) return;
    if (!canSave(declaration, card)) {
      state.receipt = declaration.savePolicy && declaration.savePolicy.partial === false
        ? '还有项没核对完，不能提交（' + progressText(card) + '）'
        : '还没选任何一项。';
      updateSplitProgress();
      return;
    }
    const policy = declaration.savePolicy || {};
    const conclude = !!(declaration.handling && declaration.handling.mode === 'conclude');
    const group = groupChangesOf(declaration, card);
    const adoptable = group.filter(change => change.adoptable !== false);
    const chosen = policy.partial === false
      ? adoptable
      : adoptable.filter(change => adoptState(change.id) !== 'pending');
    const groups = conclude ? [] : groupUnits(chosen);
    if (!conclude && !groups.length) { state.receipt = '没有要保存的内容。'; updateSplitProgress(); return; }

    state.busy = true;
    state.receipt = '';
    updateSplitProgress();
    const action = saveActions.get(declaration.execution.saveAction) || saveActions.get('kernel.accept');
    const done = checksOf(card);
    const checks = (Array.isArray(card.checks) ? card.checks : [])
      .filter(check => done.get(check.key))
      .map(check => check.key);
    let receipts = [];
    /* —— **改写过的那些值**（双击改写后）也一并交给保存动作 ——
       不然「改了值、点了保存」等于没改（域那边看不到改成了什么）。 —— */
    const edited = {};
    chosen.forEach(change => {
      const text = textOf(change);
      if (text !== plainValue(change.after)) edited[change.id] = text;
    });
    try {
      receipts = await action.save(groups, { declaration, card, checks, changed: chosen, edited });
    } catch (error) {
      state.busy = false;
      state.receipt = '保存失败：' + (error && error.message ? error.message : '请重新加载。');
      updateSplitProgress();
      return;
    }
    const ok = receipts.filter(receipt => receipt.ok).length;
    const failed = receipts.filter(receipt => !receipt.ok);
    const unknown = failed.filter(receipt => receipt.unknown);
    const savedUnits = new Set();
    receipts.forEach(receipt => {
      if (receipt.ok) (receipt.units || []).forEach(unit => savedUnits.add(unit));
    });
    card.changes.forEach(change => {
      const unit = (change.unit || {}).unitId;
      if (savedUnits.has(unit)) { setAdopt(change.id, 'saved'); return; }
      if (policy.partial === false) {
        /* 整组失败 ⇒ 这一组**都**没保存（不许把部分完成报成整份完成）。 */
        setAdopt(change.id, 'failed');
      }
    });
    if (conclude && ok) card.state = 'confirmed';
    /* —— **失败／冲突／结果未明，三件事要分得开**（契约 §save_result.distinguishable；
       PKG-099 · G2）：
       · **结果未知**（5xx／拿不到回执）：可能**已经写进去了** ⇒ 不许让用户再点一次；
       · **冲突**（409）：别人刚改过这一份 ⇒ 要**重新核对**，不是「保存失败」；
       · **失败**（其它 4xx）：请求被拒，正式值一个字节没改。
       ⚠️ **后端给的那句话要透出来**（原来被吞了 —— 只说「失败」等于没告诉用户为什么）。 */
    const conflicts = failed.filter(receipt => Number(receipt.status) === 409);
    const said = list => {
      const text = (list.find(item => item && item.error) || {}).error || '';
      return text ? '（后端说：' + text + '）' : '';
    };
    if (unknown.length) {
      state.receipt = (ok ? '已保存 ' + ok + ' 组；' : '')
        + unknown.length + ' 组结果未知（可能已写入，请刷新核对，不要重复确认）。' + said(unknown);
    } else if (conflicts.length) {
      state.receipt = '保存撞上冲突（这一份刚被别人改过，请重新核对后再提交；正式值一个字节都没改）。'
        + said(conflicts);
    } else if (failed.length) {
      state.receipt = policy.partial === false
        ? '整组保存失败：正式值一个字节都没改（' + failed.length + ' 组未保存）。' + said(failed)
        : '已保存 ' + ok + ' 组；' + failed.length + ' 组未保存，原值未改。' + said(failed);
    } else if (conclude) {
      state.receipt = '核对结论已保存。';
    } else {
      state.receipt = policy.partial === false
        ? '整组已保存：' + chosen.length + ' 项一起生效。'
        : '已保存 ' + ok + ' 组；其余仍待审。';
    }
    if (conclude && ok) state.checks.delete(card.id);
    try {
      await refreshReviewDeclarations([declaration.key, ...((declaration.execution || {}).refreshDeclarations || [])]);
    } catch (error) {
      state.busy = false;
      state.receipt += ' 最新审核内容暂时读不出来，请刷新核对。';
      updateSplitProgress();
      return;
    }
    state.busy = false;
    render();
  }

  // ========== 独立页 ==========

  /**
   * 把审核中心挂成一个**独立页**（页面本体归核心域，域不注册页面）。
   * 页头是**平台通用说法**（域名不出现在页头，只出现在每条候选上）。
   */
  async function mountPage(host, options) {
    if (!host) return null;
    const opts = Object.assign({ title: '审核中心' }, options || {});
    state.pageHost = host;
    state.pageOptions = opts;
    /* —— **这一页自己的那一把取消信号**（路由给的 `page.signal`；换页时上游 `abort()` 它）。
       为什么存起来：这一页的**每一个读**都要用它 —— 壳自己读、域的读，都用**同一把**
       ⇒ 人一离开这一页，在途的读**真的被掐掉**（R07 · P1）。
       ⚠️ 没有信号时（老调用方式）＝**没有信号可挂**，行为照旧（域自己那套超时取消还在）。 */
    const signal = opts.signal || null;
    state.pageSignal = signal;
    state.pageDisposed = false;
    /* ⚠️ **退订句柄要在这之前声明**（`dispose` 里要用 ⇒ 不能是 TDZ 的 const）。 */
    let disposeDeclaration = () => {};
    /* —— **窗口尺寸变了 ⇒ 重新量一屏放得下几张**（用户 2026-10-28：「先填满一页再去第二页」——
     *   窗口一变，一屏放得下的张数也变了 ⇒ 按新的条数重新取这一页）。 —— */
    const onResize = () => { syncScreenPageSize(); };
    if (typeof global.addEventListener === 'function') global.addEventListener('resize', onResize);
    const dispose = () => {
      if (signal) signal.removeEventListener('abort', dispose);
      if (typeof global.removeEventListener === 'function') global.removeEventListener('resize', onResize);
      if (gridSizeObserver) {
        try { gridSizeObserver.disconnect(); } catch { /* 已经断了 */ }
        gridSizeObserver = null;
      }
      disposeDeclaration();
      if (state.pageHost === host) {
        cancelCardDetail();
        disposeHandlingPanel();
        disposeOriginalMedia(state.modal);
        state.listReadGeneration += 1;
        state.pageDisposed = true;
        state.modalOpen = false;
        state.activeCardId = null;
        state.loading = false;
        if (state.modal) {
          if (typeof state.modal.close === 'function') state.modal.close();
          else state.modal.removeAttribute('open');
        }
        state.pageHost = null;
        state.pageOptions = null;
        state.deckHost = null;
        state.pageSignal = null;
      }
    };
    if (signal) signal.addEventListener('abort', dispose, {once:true});
    /* —— **域的声明后到 ⇒ 这一页重读**（PKG-132 · 「从没有待审核到出现审核卡片」那个坑）。
     *   页面先挂载、域脚本后注册 ⇒ 第一次读时还没有任何声明 ⇒ 页面是空的；
     *   ⇒ 声明一到就**重读当前那一档**，人不用手动刷新。 */
    const offDeclaration = onDeclarationChange(() => {
      if (state.pageDisposed || state.pageHost !== host) return;
      void loadScope(currentScope(), { page: state.cardPage, query: state.search })
        .then(() => { if (state.pageDisposed || state.pageHost !== host) return; syncScopeCards(currentScope()); renderPageView(); })
        .catch(() => { /* 读不出来由状态区说，不在这里炸 */ });
    });
    disposeDeclaration = () => { try { offDeclaration(); } catch { /* 已经退订了 */ } };
    clear(host);

    const page = element('section', 'platform-page review-center-page');
    page.setAttribute('data-review-page', '1');

    /* 页头条＝**全站同一副骨架**（PKG-045-T02）：`h1` 直接是页头条的子元素，
       按钮区靠右 —— 不再套一层标题块 div。
       ⚠️ **页头条下面不许再挂解释性副标题**（PKG-063-T01 · 用户 2026-10-23
       「每个页面上面有一些解释性的文字，把它给删一删」）——
       原来这里还挂着一行「这一页是干什么的」说明 ⇒ **解释** ⇒ 连它带
       「往页头条里塞一段说明」的那个口子一起去掉了。 */
    const header = element('header', 'page-hd platform-page-head page-heading review-center-page-head');
    header.appendChild(element('h1', '', opts.title));
    const actions = element('div', 'page-actions');
    /* —— **页头右上＝分档片**（PKG-068-T01 · 用户 2026-10-23 22:13～22:18 拍板：
       「顶部页头右上＝分档片（每个进这一页的声明一片＋件数＝卡张数，点片＝筛那一类；
       **「已确认」是与「新通知书更新」平级、永远都在的一档**」）——
       ⚠️ **就在页头右边**（不另起一行）；**域给几档就显示几档**（不写死三个）。 */
    const decks = element('nav', 'review-decks');
    decks.setAttribute('data-review-decks', '1');
    decks.setAttribute('aria-label', '审核中心分档');
    actions.appendChild(decks);
    state.deckHost = decks;
    /* ⚠️ **2026-10-24 20:5x 用户拍板：页头右上那个「刷新」按钮去掉**
       （用户在站上指着它说「这个去掉」）⇒ 页头右上**只剩分档片**。
       ⇒ **刷新这件事没丢**：`refreshPage()` 仍是公共 API（重新进这一页就会重读），
          而且「刷新时要看得见『正在读取…』」那条判据照旧（它走 API，不走按钮）。 */
    header.appendChild(actions);
    page.appendChild(header);

    const section = element('div', 'platform-section review-center-section');
    section.setAttribute('data-review-page-section', '1');
    page.appendChild(section);
    host.appendChild(page);

    ensureTabVisible();
    state.loading = true;
    /* —— **进这一页 ⇒ 两档的分页状态从头来**（页码归 1、缓冲清空）。 */
    state.cardPage = 1;
    state.paging.pending.page = 1;
    state.paging.done.page = 1;
    state.scopeStore = { pending: {}, done: {} };
    state.doneBuffers = {};
    state.donePages = {};
    renderPageView();
    try {
      await load(true);
    } catch (error) {
      /* ⚠️ **被取消不是「读取失败」**（R07）⇒ 取消**不画**那句「读取失败，请重新加载。」
         （人已经离开这一页了，不该再给他一句话）。 */
      if (!isAbortError(error)) {
        state.error = error && error.message ? error.message : '读取失败，请重新加载。';
      }
    }
    /* —— **离页收摊**（这一页自己做的，不靠路由来收）——
       换页时上游会 `abort()` 这一页的信号 ⇒ 这一轮读到一半就没了 ⇒
       这一页**自己把状态收干净**（不留 `pageHost`，免得后台继续替它刷新）。 */
    if (signal && signal.aborted) {
      dispose();
      return dispose;
    }
    renderPageView();
    return dispose;
  }

  async function refreshPage() {
    /* ⚠️ **刷新时也要有交代**（PKG-071-T01 · 2026-10-24 夜班上站实看抓出来的）：
     * 站上一次「读全」要 **6.5 秒**（137 条记录 × 逐条读案件行）⇒ 点了「刷新」以后
     * 原来**页面上一点动静都没有**（旧卡还在原地）⇒ 用户以为没点上、又点一次。
     * ⇒ 现在**先把「正在读取…」摆出来**（与第一次进页面一致）。 */
    state.loading = true;
    state.error = '';
    renderPageView();
    try {
      await load(true);
    } catch (error) {
      /* ⚠️ **被取消不是「读取失败」**（R07）⇒ 取消**不画**那句「读取失败，请重新加载。」 */
      if (!isAbortError(error)) {
        state.error = error && error.message ? error.message : '读取失败，请重新加载。';
      }
    }
    renderPageView();
  }

  async function switchTab(key) {
    if (!declarations.has(key)) return;
    state.cardPage = 1;
    state.deckPinned = true;
    state.tab = key;
    state.receipt = '';
    render();
    try {
      await load(true);
    } catch (error) {
      /* ⚠️ **被取消不是「读取失败」**（R07）⇒ 取消**不画**那句「读取失败，请重新加载。」 */
      if (!isAbortError(error)) {
        state.error = error && error.message ? error.message : '读取失败，请重新加载。';
      }
    }
    render();
  }

  // ========== 计数与启动 ==========

  function totalPending() {
    return Object.keys(state.counts).reduce((sum, key) => sum + (state.counts[key] || 0), 0);
  }

  async function syncCounts() {
    if (!declarations.size) return { shown: false, reason: 'no-source' };
    if (state.failures >= MAX_COUNT_FAILURES) {
      return { shown: false, reason: 'giving-up', counts: state.counts, total: totalPending() };
    }
    try {
      await load();
      state.failures = 0;
    } catch (error) {
      state.failures += 1;
      return { shown: false, reason: 'failed', error: String((error && error.message) || error), counts: state.counts, total: totalPending() };
    }
    return { shown: true, reason: 'pending', counts: state.counts, total: totalPending() };
  }

  function scheduleCounts() {
    /* ⚠️ **审核中心那一页没挂着 ⇒ 没人看这些计数 ⇒ 不去读**
       （PKG-075-T01 · 2026-10-24 夜班站上实测）。

       改之前：这一句没有 ⇒ **每个页面**都在替审核中心把那些卡读一遍
       （域那边一次读 137 条案件行 ⇒ 每开一页 ≈ 400 个请求；
       站上 40 分钟里 `example.case_row.read` 跑了 **4359 次、全部 403**），
       把浏览器到站上的连接占满 ⇒ **别的请求偶发「Failed to fetch」**
       （2026-10-24 02:4x 在「应用」页实测复现：页面写着「Failed to fetch」＋「重新加载」）。
       改之后：计数**只在审核中心那一页真的挂上去的时候**才读
       （那一页自己 `mountPage` 里就有 `await load(true)`）⇒ **每个页面都不再替它读**。 */
    if (!state.pageHost) return;
    if (state.timer) return;
    /* 没有计时器的地方（判据的最小 DOM 桩）⇒ 不排刷新（也不该因此炸掉）。 */
    if (typeof global.setTimeout !== 'function') return;
    state.timer = global.setTimeout(() => { state.timer = 0; void syncCounts(); }, 600);
  }

  function start() {
    if (state.started) return;
    state.started = true;
    if (!doc) return;
    if (doc.addEventListener) {
      doc.addEventListener('shangshu:review-resolved', () => { scheduleCounts(); });
      doc.addEventListener('shangshu:review-batch-resolved', () => { scheduleCounts(); });
    }
    /* ⚠️ **开机不再刷计数**（PKG-075-T01 · 2026-10-24 夜班站上实测）：
       原来这里也 `scheduleCounts()` ⇒ **每个页面**的 DOMContentLoaded 都去读一遍
       审核中心那些卡（域那边一次读 137 条案件行 ⇒ 每开一页 ≈ 400 个请求），
       把浏览器到站上的连接占满 ⇒ **别的请求偶发「Failed to fetch」**。
       ⇒ 计数**只在审核中心那一页真的挂上去时读**（那一页自己 `mountPage` 里就有
       `await load(true)`）⇒ **每个页面都不再替它读**。 */
  }

  // ========== 对外 ==========

  /* ⚠️ **壳内置的「AI 建议」那一档不再注册**（PKG-068-T01）——
     用户 2026-10-23 22:1x 拍板：「「AI 建议」那块整个去掉」⇒ 页面上没有那一片、
     也没有那条「去处理」指路行；这一页也不再读公共提案口。 */

  global.shangshuReviewCenter = {
    ADMISSION,
    DEFAULT_BY_KIND,
    PART_ORDER,
    PART_LABELS,
    PUBLIC_DEFAULTS,
    FORMATS,
    STATE_LABELS,
    CONFIRM_NOTICE,
    registerDefinition,
    registerSaveAction,
    registerDeclaration,
    unregisterDeclaration,
    validateDeclaration,
    declarations: declarationList,
    pageDeclarations,
    redirectDeclarations,
    sourceKind,
    diffOf,
    mountPage,
    refreshPage,
    switchTab,
    openCard,
    closeCard,
    saveActiveCard,
    canSave,
    progressText,
    load,
    syncCounts,
    start,
    state,
    totalPending,
    /** **一屏放得下几张**（纯计算，判据直接调它）。 */
    cardsPerScreen,
    /** 兼容旧调用：打开某一类审核（可选带上卡片 id 直接进分栏弹窗）。 */
    open: async (declarationKey, cardId) => {
      const target = declarationKey && declarations.has(declarationKey) ? declarationKey : state.tab;
      if (target) await switchTab(target);
      const cards = (state.cards[target] || []);
      if (cardId) return openCard(target, cardId);
      if (cards.length) return openCard(target, cards[0].id);
      return null;
    },
    close: () => { closeCard(); },
  };

  /* —— **页面本体归核心域**：静态页面注册表 ＋ 这一页的渲染函数都在公共壳这一侧，
     域**不注册页面**（契约 §ownership.domain_role）。 */
  if (typeof RENDER !== 'undefined') {
    RENDER['review-center'] = function (page) {
      /* 页头条**只留标题**（PKG-063-T01）：原来这里还传了一句「审核员怎么核对凭据」的说明
         ——那是「这一页是干什么的」⇒ 解释 ⇒ 删。 */
      return global.shangshuReviewCenter.mountPage(page.host, {
        title: '审核中心',
        /* —— **把 `page.signal` 一起交下去**（R07 · P1）：这一页自己的那一把取消信号
           （换页时路由会 `abort()` 它）⇒ 这一页发出去的每一个读**真的被掐掉**。 —— */
        signal: page && page.signal ? page.signal : null,
      });
    };
  }

  if (doc && doc.readyState === 'loading' && doc.addEventListener) {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
