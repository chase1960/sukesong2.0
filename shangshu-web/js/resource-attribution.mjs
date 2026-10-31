/** 全站共用的「归属」选择器 —— 公共组件（FIX-48 → PKG-016）。
 *
 * 起源：用户 2026-10-20 14:07 要求「把弹窗作为公共组件，所有需要选择归属的都用它」。
 * 随后 2026-10-21 用户看试用站文件中心提了两条更硬的：
 *   · 「上传文件」弹窗里的归属是点「选择」**又弹一扇窗** —— 叠窗看不清；
 *   · 「这个分类弹窗问题，我记得还有一些部分有，统一一下吧，
 *      **不要用重叠弹窗，直接摊出来**」。
 *
 * 所以本组件**只剩摊开（inline）一种形态**：两张选项卡（本人／获权部门）直接渲染在宿主里，
 * 选中档的说明 ＋ 部门清单也都在宿主里，**不弹第二扇窗**。原来的叠窗分支整个删掉了。
 *
 * 三条约定（照做，别改）：
 * 1. **宿主体内不再有原生 <select>**，也不再有点开才展开的触发按钮 ——
 *    归属的两张选项卡就是界面本身。
 * 2. **值仍由宿主里两个隐藏 input 承载**（data-attribution-level /
 *    data-attribution-department）—— 调用方读值、禁用、回填都用原来那套写法，不必改
 *    （邮箱设置页的 #mail-account-kind / #mail-account-department 就是它）。
 * 3. 组件**不再需要 ui 工作面**（自己不起模态栈，也就不会再出现 FIX-38 那种 Esc 关错层）。
 *    options.ui 保留着只是为了让调用方不必改代码。
 *
 * 部门数据有三套来源，组件都吃：
 *   · 文件侧（Excel 新建/上传、文件中心上传）→ departmentSource:'platform'，
 *     组件自己读 /api/platform/datasets/platform.department/records（含分页）；
 *   · 调整归属 → 调用方把部门列表给过来（setDepartments），组件不自己拉；
 *   · 邮箱设置 → departmentMode:'text'，**手填**（那是自由文本，不是列表）。
 *
 * 权限语义、接口参数名、后端校验一律没动：level 仍是 personal / department。
 */

const DEFAULT_LEVELS = [
  {value: 'personal', label: '本人', hint: '这份内容只属于你自己，别人看不到。'},
  {value: 'department', label: '获权部门', hint: '这份内容归某个部门，获权的同事可以访问。'},
];

export function mountResourceAttribution(host, options = {}) {
  const doc = host.ownerDocument;
  const {
    fetcher = globalThis.fetch,
    defaultLevel = '',
    signal,
    label = '文件归属',
    levels = DEFAULT_LEVELS,
    departmentLabel = '部门',
    departmentMode = 'select',
    departmentSource = 'platform',
    departmentPlaceholder = '输入部门名称',
    /** 给承载值的隐藏 input 起名字（邮箱设置页要沿用 #mail-account-kind 等旧 id）。 */
    levelInputId = '',
    departmentInputId = '',
    onChange = null,
  } = options;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const normalize = row => ({
    value: String(row?.value ?? row?.name ?? row?.id ?? ''),
    label: String(row?.label ?? row?.title ?? row?.name ?? row?.id ?? ''),
  });

  /* 摊开式：两张选项卡 ＋ 选中档的说明 ＋（选部门时）部门清单 —— 全在宿主里，不弹第二扇窗。
     值由下面那两个隐藏 input 承载（调用方读值/回填/禁用一律照旧）。 */
  host.classList.add('attribution-picker', 'attribution-picker-inline');
  host.innerHTML = `
    ${label ? `<span class="attribution-picker-label">${escape(label)}</span>` : ''}
    <div class="attribution-tabs" role="tablist" aria-label="归属类型">${levels.map(item =>
      `<button type="button" class="attribution-tab" role="tab" data-attribution-tab="${escape(item.value)}" aria-selected="false">${escape(item.label)}</button>`).join('')}</div>
    <div class="attribution-panel" data-attribution-panel></div>
    <p class="attribution-status" role="status" data-attribution-dialog-status></p>
    <input type="hidden" data-attribution-level aria-label="${escape(label || '归属')}">
    <input type="hidden" data-attribution-department aria-label="${escape(departmentLabel)}">
    <p class="attribution-picker-status" role="status" data-attribution-load-status></p>`;

  const levelInput = host.querySelector('[data-attribution-level]');
  const departmentInput = host.querySelector('[data-attribution-department]');
  const status = host.querySelector('[data-attribution-load-status]');
  if (levelInputId) levelInput.id = levelInputId;
  if (departmentInputId) departmentInput.id = departmentInputId;

  let locked = false, loaded = false, loading = null, loadMessage = '';
  let departmentRows = (Array.isArray(options.departments) ? options.departments : []).map(normalize);
  let draft = {level: '', department: ''};
  /* 部门清单那一段的**重画入口**（取数到了/失败了都靠它把骨架换成真内容）。 */
  let repaintList = null;

  const setStatus = text => { loadMessage = text || ''; status.textContent = loadMessage; status.hidden = !loadMessage; };
  const departmentLabelOf = value => {
    const row = departmentRows.find(item => item.value === String(value));
    return row ? row.label : String(value ?? '');
  };

  function sync() {
    const value = levelInput.value;
    /* 把选中态反映在两张选项卡上 ＋ 画选中档的说明/部门清单。 */
    levelInput.disabled = locked;
    departmentInput.disabled = locked;
    host.querySelectorAll('[data-attribution-tab]').forEach(tab => {
      const selected = tab.getAttribute('data-attribution-tab') === value;
      tab.setAttribute('aria-selected', String(selected));
      tab.disabled = locked;
    });
    draft = {level: value, department: departmentInput.value};
    renderPanel(host);
    setStatus(loadMessage);
  }

  /** 出错时把焦点放到对应那张选项卡（摊开式没有触发按钮）。 */
  const focusPoint = () => host.querySelector(`[data-attribution-tab="${levelInput.value}"]`)
    || host.querySelector('[data-attribution-tab]')
    || null;
  function read() {
    const value = levelInput.value;
    if (!levels.some(item => item.value === value)) {
      return {ok: false, reason: `请选择归属（${levels.map(item => item.label).join(' 或 ')}）`, focus: focusPoint()};
    }
    if (value === 'department') {
      const department = departmentInput.value.trim();
      if (!department) {
        return {
          ok: false,
          reason: departmentMode === 'text' ? `请填写${departmentLabel}` : `请选择${departmentLabel}`,
          focus: focusPoint(),
        };
      }
      return {ok: true, value: {level: value, department}};
    }
    return {ok: true, value: {level: value}};
  }

  const getValue = () => ({level: levelInput.value, department: departmentInput.value});
  const setValue = next => {
    levelInput.value = String(next?.level ?? '');
    departmentInput.value = String(next?.department ?? '');
    sync();
  };
  const reset = (value = defaultLevel) => setValue({level: value, department: ''});
  const lock = value => { locked = Boolean(value); sync(); };

  function setDepartments(rows) {
    departmentRows = (Array.isArray(rows) ? rows : []).map(normalize);
    loaded = true;
    sync();
  }

  async function load() {
    if (departmentMode !== 'select' || departmentSource !== 'platform') return null;
    if (loaded) return null;
    if (loading) return loading;
    loading = (async () => {
      try {
        const rows = []; let page = 1, total = 0;
        do {
          const response = await fetcher('/api/platform/datasets/platform.department/records?' + new URLSearchParams({
            page: String(page++), page_length: '100', filters: JSON.stringify({enabled: 1}),
          }), {credentials: 'include', signal});
          const body = await response.json();
          if (!response.ok || !Array.isArray(body.rows)) throw Error(body.error || '部门读取失败');
          if (!body.rows.length && rows.length < Number(body.total || 0)) throw Error('部门分页不完整');
          rows.push(...body.rows);
          total = Number(body.total || rows.length);
        } while (rows.length < total);
        if (signal?.aborted) return;
        departmentRows = rows.map(normalize);
        loaded = true;
        setStatus('');
        /* 数据到了 ⇒ 骨架在**同一个容器**里被换掉（重画那一段列表）。 */
        repaintList?.();
      } catch {
        setStatus('部门读取失败，请重试；仍可选择本人');
        repaintList?.();
      } finally { loading = null; }
    })();
    return loading;
  }

  /* ---- 摊在宿主里的那块面板 ---- */
  function renderPanel(root) {
    if (!root) return;
    const panel = root.querySelector('[data-attribution-panel]');
    if (!panel) return;
    const level = levels.find(item => item.value === draft.level);
    if (draft.level !== 'department') {
      panel.innerHTML = `<p class="attribution-hint">${escape(level?.hint || '')}</p>`;
      return;
    }
    if (departmentMode === 'text') {
      /* 摊开式没有「确定」那一步 ⇒ 手填的部门**当场落到隐藏 input 上**。
         （老版本这段只在弹窗的「确定」里提交，摊开式下会白填 —— PKG-016 补上。） */
      let input = panel.querySelector('[data-attribution-text]');
      if (!input) {
        panel.innerHTML = `<label class="attribution-text-field"><span>${escape(departmentLabel)}</span>`
          + `<input type="text" class="attribution-text" data-attribution-text maxlength="140" `
          + `placeholder="${escape(departmentPlaceholder)}"></label>`;
        input = panel.querySelector('[data-attribution-text]');
        input.addEventListener('input', () => {
          draft.department = input.value;
          departmentInput.value = input.value;
          departmentInput.dispatchEvent(new doc.defaultView.Event('input', {bubbles: true}));
          departmentInput.dispatchEvent(new doc.defaultView.Event('change', {bubbles: true}));
        });
      } else if (input.value !== draft.department) {
        /* 回填时只改值、不重建 —— 重建会把用户正在打的字冲掉（焦点也丢）。 */
        input.value = draft.department;
      }
      input.disabled = locked;
      return;
    }
    panel.innerHTML = `<input type="search" class="attribution-search" data-attribution-search `
      + `placeholder="搜索${escape(departmentLabel)}" aria-label="搜索${escape(departmentLabel)}">`
      + `<div class="attribution-dept-list" data-attribution-list role="listbox" aria-label="${escape(departmentLabel)}"></div>`;
    const list = panel.querySelector('[data-attribution-list]');
    const search = panel.querySelector('[data-attribution-search]');
    search.disabled = locked;
    const paint = () => {
      const term = String(search.value || '').trim().toLowerCase();
      const shown = departmentRows.filter(row => !term
        || row.label.toLowerCase().includes(term) || row.value.toLowerCase().includes(term));
      if (!shown.length) {
        /* —— 部门清单**还没到** ⇒ 摆骨架（照真选项行的形状：一条灰条占一行）。
           ⚠️ 只表示「正在取数」⇒ 不写假部门名。 —— */
        if (!loaded && !loadMessage) {
          list.setAttribute('aria-busy', 'true');
          list.innerHTML = '<div class="platform-skeleton" data-skeleton="dept-options" aria-hidden="true">'
            + '<div class="attribution-dept-option"><span class="platform-skeleton-bar" style="display:block;width:46%;height:13px"></span></div>'.repeat(4)
            + '</div>';
          return;
        }
        list.removeAttribute('aria-busy');
        list.innerHTML = `<p class="attribution-empty">${departmentRows.length
          ? `没有匹配的${departmentLabel}`
          : (loaded ? `暂无可选${departmentLabel}` : escape(loadMessage))}</p>`;
        return;
      }
      list.removeAttribute('aria-busy');
      list.innerHTML = shown.map(row => `<button type="button" class="attribution-dept-option" role="option" `
        + `data-attribution-dept-value="${escape(row.value)}" aria-selected="${String(row.value === draft.department)}"`
        + `${locked ? ' disabled' : ''}>`
        + `${escape(row.label)}</button>`).join('');
      list.querySelectorAll('[data-attribution-dept-value]').forEach(option => {
        option.addEventListener('click', () => {
          draft.department = option.getAttribute('data-attribution-dept-value') || '';
          list.querySelectorAll('.attribution-dept-option').forEach(other => {
            other.setAttribute('aria-selected', String(other === option));
          });
          /* 摊开式没有「确定」那一步 ⇒ 选中的部门**当场生效**。 */
          departmentInput.value = draft.department;
          departmentInput.dispatchEvent(new doc.defaultView.Event('input', {bubbles: true}));
          departmentInput.dispatchEvent(new doc.defaultView.Event('change', {bubbles: true}));
        });
      });
    };
    search.addEventListener('input', paint);
    repaintList = paint;
    paint();
  }

  host.querySelectorAll('[data-attribution-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (locked) return;
      const value = tab.getAttribute('data-attribution-tab') || '';
      levelInput.value = value;
      if (value !== 'department') departmentInput.value = '';
      departmentInput.dispatchEvent(new doc.defaultView.Event('input', {bubbles: true}));
      levelInput.dispatchEvent(new doc.defaultView.Event('change', {bubbles: true}));
    });
  });
  levelInput.addEventListener('change', () => { sync(); onChange?.(getValue()); });
  departmentInput.addEventListener('change', () => { sync(); onChange?.(getValue()); });
  departmentInput.addEventListener('input', () => sync());

  reset(defaultLevel);

  return {
    read, load, reset, lock, setValue, getValue, setDepartments, sync,
    level: levelInput, department: departmentInput,
    departmentText: () => departmentLabelOf(departmentInput.value),
  };
}

/* 这个公共件既被 ES module import（directory.ts），也被**经典脚本**用
   （resource-assignment.js / mail-settings.js —— 它们拿不到 module 导出）。
   所以同时挂一份全局：经典脚本优先用它，宿主也可以先注入。 */
if (typeof globalThis !== 'undefined') globalThis.mountResourceAttribution = mountResourceAttribution;