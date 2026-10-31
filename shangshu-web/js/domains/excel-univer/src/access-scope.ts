/**
 * 权限声明的**形状** ＋ **面板零件**（PKG-117-T01）。
 *
 * 口径来源：`fde/设计/契约/账号与权限.md` 第 233–293 行
 * （用户 2026-10-25 22:3x–23:1x 拍定：「这四个权限按照列分配；
 * 每次晋升一列都要写清楚到底是什么权限（全局、部门、个人）」）。
 *
 * **三个操作**：读（read，含「筛」）／写（write）／下载（download）。
 * ⚠️ **2026-10-26 用户拍定：「助手」这一档（assistant）整个去掉** ——
 *    助手和人看到的一样（助手走的就是「读」那条路）⇒ 那一档从来没被强制过，
 *    摆在那里只是看着像管住了什么；真要禁 AI，就去限「读」那一档。
 * ⚠️ **2026-10-27 用户拍定：降维** —— 权限只有**三个**操作：
 *    **读（筛）／写／下载**，而且**递进**：**不能读就不能写、不能下载**。
 * **主体四档**（2026-10-26 用户拍板：在全局／部门／个人**后面**加一档「无人」）：
 * 全局（global＝全员可读可写）／部门（department，须指到具体部门）／
 * 个人（personal，须指到具体人）／无人（none＝不给任何业务人员；管理员按旁路仍可读）。
 *
 * ⚠️ **「无人」这一档不带子键**：落库形状就是 `{"scope":"none"}`，
 *    **不许**多带 `departments`／`users`（后端那条口会拒）。
 *
 * 声明形状（列级；表级同形，另加 `record_scope`）：
 * ```ts
 * access: {
 *   read:      { scope: 'global' },
 *   write:     { scope: 'department', departments: ['财务'] },
 *   download:  { scope: 'personal',  users: ['a@b.com'] }
 * }
 * ```
 *
 * ⚠️ **三个操作都必填**（降维后没有可省的了）；**递进**：不能读就不能写、不能下载。
 * ⚠️ **旧声明里可能还带着 `assistant`／`filter`**（去掉之前存下来的定义）——
 *    这里**读的时候当作没有**（不报错、不当成未知操作），**写的时候也不再产出它们**。
 *
 * ⚠️ **旧三键（`read_roles`／`write_roles`／`download_roles`）不再被读，也不再被写** ——
 * 契约第四节·补原话：「这是一个重构，不要留兼容函数」。这里只留一份**名字清单**，
 * 给上层把旧键从落库形状里**剥掉**（剥掉这件事本身是「不再产出旧键」，不是回落）。
 */

/** 主体四档（2026-10-26：全局／部门／个人 ＋ 无人）。 */
export type ScopeKind = 'global' | 'department' | 'personal' | 'none';

/** 三个操作。 */
export type OperationKey = 'read' | 'write' | 'download';

/** 一个操作的声明。 */
export type OperationAccess =
  | { scope: 'global' }
  | { scope: 'department'; departments: string[] }
  | { scope: 'personal'; users: string[] }
  | { scope: 'none' };

/** 三个操作的声明合起来（缺哪几个＝那几项没声明）。 */
export type AccessMap = Partial<Record<OperationKey, OperationAccess>>;

/** 表级声明：同形，另加 `record_scope`（记录范围那一项，原样保留）。 */
export type TableAccess = AccessMap & { record_scope?: string };

/** 主体清单里的一项（部门或人）。 */
export type SubjectOption = { id: string; label: string };

/** 主体清单（部门 ＋ 人）。 */
export type SubjectOptions = { departments: SubjectOption[]; users: SubjectOption[] };

export const OPERATION_KEYS: readonly OperationKey[] = ['read', 'write', 'download'];

/** **必填**的三项（列级与表级都必填）：不声明就不许保存。 */
export const REQUIRED_OPERATION_KEYS: readonly OperationKey[] = ['read', 'write', 'download'];

/**
 * **可省**的项：省略＝跟随「读」。
 *
 * ⚠️ **降维后没有可省的了** —— 三个操作都必填（「筛」并进了「读」，
 * 「助手」那一档已去掉）⇒ 这里是空的。
 */
export const FOLLOW_READ_OPERATION_KEYS: readonly OperationKey[] = [];

/**
 * **去掉之前的**操作键（2026-10-26 去掉「助手」；2026-10-27 把「筛」并进「读」）。
 *
 * 旧存下来的定义里可能还带着它们 ⇒ **读的时候当作没有**
 * （不报错、不当成未知操作）；**写的时候也不再产出它们**。
 */
export const LEGACY_OPERATION_KEYS = ['assistant', 'filter'] as const;

/** 旧三键的名字（只用来**剥掉**，不读、不写）。 */
export const OLD_ROLE_KEYS = ['read_roles', 'write_roles', 'download_roles'] as const;

/** 操作名（面板上给人看的两个字）。 */
export const OPERATION_LABELS: Record<OperationKey, string> = {
  read: '读',
  write: '写',
  download: '下载',
};

/** 四档的名字（面板上给人看的话）。 */
export const SCOPE_LABELS: Record<ScopeKind, string> = {
  global: '全局（所有人）',
  department: '部门',
  personal: '个人',
  none: '无人（除管理员）',
};

/**
 * 这个操作在面板上问什么话（三个操作各一句；用表来写 ⇒ 漏一个操作编译就报错）。
 */
const OPERATION_QUESTIONS: Record<OperationKey, (subject: string) => string> = {
  read: subject => `谁能看${subject}`,
  write: subject => `谁能改${subject}`,
  download: subject => `谁能下载${subject}`,
};

/**
 * 这个操作在面板上问什么话。
 * @param op 操作
 * @param subject 「这一列」／「整张表」
 */
export function questionFor(op: OperationKey, subject: string): string {
  return OPERATION_QUESTIONS[op](subject);
}

function stringList(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item ?? '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 一项主体清单（认 id／value／name／key；认 label／title／full_name）。 */
function normalizeOption(raw: unknown): SubjectOption | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id, label: id } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? row.value ?? row.key ?? row.user_id ?? row.department_id ?? row.name ?? '').trim();
  if (!id) return null;
  const label = String(row.label ?? row.title ?? row.full_name ?? row.name ?? row.value ?? id).trim() || id;
  return { id, label };
}

function normalizeOptionList(raw: unknown): SubjectOption[] {
  if (!Array.isArray(raw)) return [];
  const out: SubjectOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const option = normalizeOption(item);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(option);
  }
  return out;
}

/**
 * 读后端给的**主体清单**。
 *
 * ⚠️ 字段名按简报的口径读 `subject_options = { departments, users }`；
 * 同时认几个同义名（后端那一轮若换了名字，这里不至于读空）。
 */
export function normalizeSubjectOptions(raw: unknown): SubjectOptions {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const departments = normalizeOptionList(
    source.departments ?? source.department_options ?? source.depts ?? source.department_list,
  );
  const users = normalizeOptionList(
    source.users ?? source.user_options ?? source.people ?? source.user_list ?? source.members,
  );
  return { departments, users };
}

/** 一个操作的声明（认 `scope`／`subject`／`type`）。 */
export function normalizeOperationAccess(raw: unknown): OperationAccess | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const scope = String(row.scope ?? row.subject ?? row.type ?? '').trim();
  if (scope === 'global') return { scope: 'global' };
  if (scope === 'department') {
    return { scope: 'department', departments: stringList(row.departments ?? row.department ?? row.depts) };
  }
  if (scope === 'personal') {
    return { scope: 'personal', users: stringList(row.users ?? row.user ?? row.people) };
  }
  /* 「无人（除管理员）」这一档**不带子键**（2026-10-26 用户拍板）——
     落库形状就是 `{"scope":"none"}`，多带 `departments`／`users` 后端会拒。 */
  if (scope === 'none') return { scope: 'none' };
  return null;
}

/**
 * 一份声明（四个操作里各自有没有）。
 *
 * ⚠️ **只认那四个操作** —— 旧声明里还带着的 `assistant` 那一档**读的时候当作没有**
 *    （不报错、不当成未知操作；那一档已经去掉了）。
 */
export function normalizeAccessMap(raw: unknown): AccessMap {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AccessMap = {};
  for (const op of OPERATION_KEYS) {
    const value = normalizeOperationAccess(source[op]);
    if (value) out[op] = value;
  }
  return out;
}

/**
 * 从**列**或**表**上读声明。
 *
 * 口径：列级在 `column.access`；表级在 `definition.access`。
 * （`access_declaration` 是同义名，后端换了名字不至于读空。）
 */
export function readAccessMap(source: unknown): AccessMap {
  if (!source || typeof source !== 'object') return {};
  const row = source as Record<string, unknown>;
  return normalizeAccessMap(row.access ?? row.access_declaration);
}

/** 表级声明里的 `record_scope`（原样保留，不在这一轮改它）。 */
export function readRecordScope(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const row = source as Record<string, unknown>;
  const access = row.access ?? row.access_declaration;
  if (!access || typeof access !== 'object') return undefined;
  const scope = (access as Record<string, unknown>).record_scope;
  return scope === undefined || scope === null ? undefined : String(scope);
}

/** 把一份声明**剥掉旧三键**（旧键不再随面板产出）。 */
export function stripOldRoleKeys<T extends Record<string, unknown>>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  for (const key of OLD_ROLE_KEYS) delete out[key];
  return out as T;
}

/**
 * 校验一份声明：**必填的三项都要定**，选了部门／个人就**必须指到具体对象**。
 *
 * 报的是**人话**，并点名是哪一列／哪一张表（`label`）。
 *
 * ⚠️ 「无人（除管理员）」那一档**不用指到任何对象** ⇒ 这里**不查子键**
 *    （选了「无人」却报错说「还没选具体是哪个部门」＝ 把这一档当坏了）。
 */
export function validateAccessMap(
  access: AccessMap,
  label: string,
  subject: string,
  required: readonly OperationKey[] = REQUIRED_OPERATION_KEYS,
): void {
  for (const op of required) {
    const value = access[op];
    if (!value) {
      throw Error(`${label}：「${OPERATION_LABELS[op]}」还没定 —— 请说清${questionFor(op, subject)}`);
    }
    if (value.scope === 'department' && !value.departments.length) {
      throw Error(`${label}：「${OPERATION_LABELS[op]}」选了「部门」，但还没选具体是哪个部门`);
    }
    if (value.scope === 'personal' && !value.users.length) {
      throw Error(`${label}：「${OPERATION_LABELS[op]}」选了「个人」，但还没选具体是哪个人`);
    }
  }
}

export type ScopePickerOptions = {
  /** 建节点的 document。 */
  doc: Document;
  /** 单选组的名字（同组共用一个 `name`）。 */
  name: string;
  /** 几档（全局／部门／个人／无人 ＋ 可选的「跟随读」）。 */
  choices: Array<{ value: string; label: string }>;
  /** 初始落在哪一档（`''` = 一档都不选 ⇒ 必填项就是空的）。 */
  selected: string;
  /** 主体清单（部门 ＋ 人）。 */
  subjects: SubjectOptions;
  /** 初始勾上的部门／人。 */
  selectedDepartments?: string[];
  selectedUsers?: string[];
  /** 无障碍标签（这一组在问什么）。 */
  ariaLabel?: string;
};

export type ScopePicker = {
  /** 面板零件（四档单选 ＋ 两张主体清单）。 */
  element: HTMLElement;
  /** 当前选中的档 ＋ 选中的对象。 */
  read(): { scope: string; departments: string[]; users: string[] };
};

/**
 * 建一组「四档单选 ＋ 主体多选」。
 *
 * 选中「部门」才显示部门清单，选中「个人」才显示人员清单 —— 两张清单都在同一个零件里，
 * 免得每个调用方各写一遍（CLAUDE.md §六：公共组件抽出来复用）。
 */
export function buildScopePicker(options: ScopePickerOptions): ScopePicker {
  const doc = options.doc;
  const element = doc.createElement('div');
  element.className = 'access-picker';

  const scopes = doc.createElement('div');
  scopes.className = 'access-scopes';
  scopes.setAttribute('role', 'radiogroup');
  if (options.ariaLabel) scopes.setAttribute('aria-label', options.ariaLabel);

  const radios: HTMLInputElement[] = [];
  for (const choice of options.choices) {
    const label = doc.createElement('label');
    label.className = 'access-scope';
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = options.name;
    radio.value = choice.value;
    radio.dataset.scope = choice.value;
    label.append(radio, doc.createTextNode(` ${choice.label}`));
    scopes.append(label);
    radios.push(radio);
  }

  const departmentBox = doc.createElement('div');
  departmentBox.className = 'access-subjects';
  departmentBox.dataset.subjectKind = 'departments';
  const userBox = doc.createElement('div');
  userBox.className = 'access-subjects';
  userBox.dataset.subjectKind = 'users';

  const selectedDepartments = options.selectedDepartments ?? [];
  const selectedUsers = options.selectedUsers ?? [];
  const knownDepartments = new Set(options.subjects.departments.map(item => item.id));
  const departmentItems = [
    ...options.subjects.departments,
    ...selectedDepartments
      .filter(id => !knownDepartments.has(id))
      .map(id => ({ id, label: `${id}（已不可用）` })),
  ];
  const knownUsers = new Set(options.subjects.users.map(item => item.id));
  const userItems = [
    ...options.subjects.users,
    ...selectedUsers.filter(id => !knownUsers.has(id)).map(id => ({ id, label: `${id}（已不可用）` })),
  ];

  for (const item of departmentItems) {
    const label = doc.createElement('label');
    label.className = 'access-subject';
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.value = item.id;
    box.dataset.department = item.id;
    box.checked = selectedDepartments.includes(item.id);
    label.append(box, doc.createTextNode(` ${item.label}`));
    departmentBox.append(label);
  }
  for (const item of userItems) {
    const label = doc.createElement('label');
    label.className = 'access-subject';
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.value = item.id;
    box.dataset.user = item.id;
    box.checked = selectedUsers.includes(item.id);
    label.append(box, doc.createTextNode(` ${item.label}`));
    userBox.append(label);
  }

  const update = () => {
    const value = scopes.querySelector<HTMLInputElement>('input:checked')?.value ?? '';
    // ⚠️ `hidden` ＋ `style.display` 两道：样式表里这两张清单是 `display:flex`
    //    ⇒ 只靠 `hidden` 会被样式盖掉（清单一直露着）。
    const showDepartments = value === 'department';
    const showUsers = value === 'personal';
    departmentBox.hidden = !showDepartments;
    departmentBox.style.display = showDepartments ? '' : 'none';
    userBox.hidden = !showUsers;
    userBox.style.display = showUsers ? '' : 'none';
  };
  for (const radio of radios) radio.addEventListener('change', update);
  const initial = radios.find(radio => radio.value === options.selected);
  if (initial) initial.checked = true;
  update();

  element.append(scopes, departmentBox, userBox);

  return {
    element,
    read() {
      const scope = scopes.querySelector<HTMLInputElement>('input:checked')?.value ?? '';
      return {
        scope,
        departments: Array.from(element.querySelectorAll<HTMLInputElement>('input[data-department]:checked')).map(
          box => box.value,
        ),
        users: Array.from(element.querySelectorAll<HTMLInputElement>('input[data-user]:checked')).map(box => box.value),
      };
    },
  };
}

export type AccessEditorOptions = {
  /** 建节点的 document（面板在 iframe / JSDOM 里都能用）。 */
  doc: Document;
  /** 这一组说的是「这一列」还是「整张表」（面板上的话）。 */
  subject: string;
  /** 这一组的标题（报错时用；如列名／「整张表」）。 */
  label: string;
  /** 已有声明（读回来的形状）。 */
  access?: AccessMap;
  /** 主体清单（部门 ＋ 人）。 */
  subjects?: SubjectOptions;
  /** 哪几个操作给「跟随读」这一档（降维后为空：三个操作都必填）。 */
  followRead?: readonly OperationKey[];
};

export type AccessEditor = {
  /** 面板零件（挂进对话框的那个元素）。 */
  element: HTMLElement;
  /** 读回当前选择（**不**校验）。 */
  read(): AccessMap;
  /** 读回并校验（必填项没定 ⇒ 抛人话）。 */
  validate(): AccessMap;
};

let editorSeq = 0;

/**
 * 建一组「操作 × 四档」的面板零件。
 *
 * 每一行：一个**问题**（人话）＋ 四档单选（全局／部门／个人／无人）
 * ＋ 选「部门」才出现的部门多选 ＋ 选「个人」才出现的人员多选。
 * 「筛」已并进「读」、「助手」那一档已去掉 ⇒ **没有「跟随读」这一档**了（三个操作都必填）。
 */
export function buildAccessEditor(options: AccessEditorOptions): AccessEditor {
  const doc = options.doc;
  const subjects = options.subjects ?? { departments: [], users: [] };
  const followRead = options.followRead ?? FOLLOW_READ_OPERATION_KEYS;
  const group = `access-${(editorSeq += 1)}`;

  const element = doc.createElement('div');
  element.className = 'access-editor';
  element.dataset.accessLabel = options.label;

  for (const op of OPERATION_KEYS) {
    const row = doc.createElement('div');
    row.className = 'access-row';
    row.dataset.operation = op;

    const title = doc.createElement('div');
    title.className = 'access-row-title';
    title.textContent = `${OPERATION_LABELS[op]} —— ${questionFor(op, options.subject)}`;

    const choices: Array<{ value: string; label: string }> = [
      { value: 'global', label: SCOPE_LABELS.global },
      { value: 'department', label: SCOPE_LABELS.department },
      { value: 'personal', label: SCOPE_LABELS.personal },
      /* 「无人（除管理员）」排在「个人」**后面**（2026-10-26 用户拍板）。 */
      { value: 'none', label: SCOPE_LABELS.none },
    ];
    if (followRead.includes(op)) choices.push({ value: 'follow', label: '跟随读' });

    const current = options.access?.[op];
    // 初始档位：已声明的按声明来；没声明的**留空**（三个操作都必填 —— 要人来定，不替他猜）。
    const initial = current ? current.scope : followRead.includes(op) ? 'follow' : '';

    const picker = buildScopePicker({
      doc,
      name: `${group}-${op}`,
      choices,
      selected: initial,
      subjects,
      selectedDepartments: current && current.scope === 'department' ? current.departments : [],
      selectedUsers: current && current.scope === 'personal' ? current.users : [],
      ariaLabel: questionFor(op, options.subject),
    });

    row.append(title, picker.element);
    element.append(row);
  }

  const read = (): AccessMap => {
    const out: AccessMap = {};
    for (const row of element.querySelectorAll<HTMLElement>('.access-row')) {
      const op = row.dataset.operation as OperationKey;
      const picked = row.querySelector<HTMLInputElement>('.access-scopes input:checked');
      if (!picked) continue;
      if (picked.value === 'follow') continue; // 省略 ⇒ 跟随读
      if (picked.value === 'global') {
        out[op] = { scope: 'global' };
        continue;
      }
      if (picked.value === 'department') {
        const departments = Array.from(
          row.querySelectorAll<HTMLInputElement>('input[data-department]:checked'),
        ).map(box => box.value);
        out[op] = { scope: 'department', departments };
        continue;
      }
      if (picked.value === 'personal') {
        const users = Array.from(row.querySelectorAll<HTMLInputElement>('input[data-user]:checked')).map(
          box => box.value,
        );
        out[op] = { scope: 'personal', users };
        continue;
      }
      /* 「无人（除管理员）」：**不带子键**（2026-10-26 用户拍板）。
         ⚠️ 这一支**不许漏** —— 漏了会被上面 `normalizeOperationAccess` 静默丢掉
         （声明里就少了这一项，保存时读回还是空）。 */
      if (picked.value === 'none') {
        out[op] = { scope: 'none' };
      }
    }
    return out;
  };

  return {
    element,
    read,
    validate() {
      const access = read();
      validateAccessMap(access, options.label, options.subject);
      return access;
    },
  };
}
