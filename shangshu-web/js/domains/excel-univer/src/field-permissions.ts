/**
 * 「字段权限」面板 ＋ 「表权限」面板（PKG-117-T01）。
 *
 * **改之前**：每个已晋升列一个 `<fieldset>`，里面三行（查看／修改／下载），
 * 每行一个下拉：**未声明 / 无人 / 指定角色** ＋ 角色勾选。
 * —— 那是「三个角色键」那套旧形状（契约第四节·补：不要留兼容函数）。
 *
 * **改之后**（用户 2026-10-25 23:1x 原话：「要在表工具栏增加一个设置按钮用于设置整个表的权限
 * （读／写／下载；全局、部门、个人），并且对于已经晋升的列，右键增加一个设置选项用于设置权限」）：
 *  · **三个操作**（读（筛）／写／下载）× **主体四档**（全局／部门／个人／无人；2026-10-26 用户拍板加的第四档）；
 *  · 选「部门」⇒ 指到**具体部门**；选「个人」⇒ 指到**具体人**；
 *  · 读／写／下载**必填**（列级与表级都必填）；列没声明 ⇒ 继承表级。
 *  · ⚠️ **降维**（2026-10-27 用户拍板）：「筛」并进「读」、「助手」那一档去掉 ⇒
 *    三个操作都必填，**没有「跟随读」这一档**；**递进**：不能读就不能写、不能下载。
 *
 * ⚠️ **「助手」那一档（assistant）2026-10-26 用户拍定整个去掉** ——
 *    助手和人看到的一样（它走的就是「读」那条路）⇒ 那一档从来没被强制过。
 *    旧声明里还带着它 ⇒ 读的时候当作没有（不报错），写的时候也不再产出。
 *
 * 口径来源：`fde/设计/契约/账号与权限.md` 第 233–293 行。
 *
 * ⚠️ **旧三键（`read_roles`／`write_roles`／`download_roles`）不再被读，也不再被写** ——
 * 面板落库时把它们从每一列上**剥掉**（判据：旧三键不再被面板产出）。
 */
import {
  buildAccessEditor,
  normalizeAccessMap,
  normalizeSubjectOptions,
  readAccessMap,
  stripOldRoleKeys,
  OPERATION_KEYS,
  LEGACY_OPERATION_KEYS,
  type AccessEditor,
  type AccessMap,
} from './access-scope';

type UI = {
  dialog(o: {
    title: string;
    body: string;
    actions: Array<{ label: string; variant?: string; onClick: () => void }>;
  }): HTMLElement | null;
  closeModal(): boolean;
  guardModal(e: HTMLElement, g: () => boolean): void;
};

/** 面板上的列（一列 = 一个字段）。 */
type Column = { header: string; promoted?: boolean; [key: string]: unknown };

export type FieldPermissionContext = {
  table: string;
  columns: Column[];
  definition_version: number;
  structure_version: number;
  definition_sha?: string;
  can_manage_field_permissions?: boolean;
  /** 表级声明（整张表谁能读／写／下载）—— 读口：`definition.access`。 */
  access?: Record<string, unknown>;
  /** 主体清单（部门 ＋ 人）—— 读口：`definition.subject_options`。 */
  subject_options?: unknown;
  /**
   * 旧形状的角色清单（**不再使用**）。
   * 留着只是提醒：后端还没换成新形状时，这里会是空的。
   */
  role_options?: Array<{ id: string; label: string }>;
};

const canonical = (value: any): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

async function json(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  signal?: AbortSignal,
) {
  const response = await fetcher(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  if (!response.ok || value?.ok === false) {
    throw Error(value?.error || value?.message || `请求失败（${response.status}）`);
  }
  return value?.result ?? value;
}

/** 读这张表的晋升定义（列 ＋ 表级声明 ＋ 主体清单 ＋ 能力闸）。 */
export async function readFieldPermissionContext(
  table: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FieldPermissionContext> {
  return json(fetcher, '/api/platform/services/files.promotion_definition/invoke', { payload: { table } }, signal);
}

/**
 * 表级声明里**不是那四个操作**的键（`record_scope` 之类）—— 原样保留。
 *
 * ⚠️ **旧声明里的 `assistant` 那一档不留**（那一档已经去掉了 ⇒ 不再随面板产出）。
 */
function extraAccessKeys(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((OPERATION_KEYS as readonly string[]).includes(key)) continue;
    if ((LEGACY_OPERATION_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 某一列**面板上显示什么**。
 *
 * · 读／写／下载：列自己声明了就用列的；没声明 ⇒ **继承表级**（面板上直接把那档选中，
 *   让人看得见「这一列现在按整张表算」）。
 */
function columnAccessFor(column: Column, tableAccess: AccessMap): AccessMap {
  const own = readAccessMap(column);
  const out: AccessMap = {};
  for (const op of OPERATION_KEYS) {
    if (own[op]) {
      out[op] = own[op];
      continue;
    }
    const inherited = tableAccess[op];
    if (inherited) out[op] = inherited; // 列没声明 ⇒ 继承表级
  }
  return out;
}

export type AccessPanelOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  active?: () => boolean;
  saved?: () => Promise<void>;
  newKey?: () => string;
  /** 只开这一列（列头右键进来时用）。 */
  column?: string;
};

/**
 * 列级面板：每个已晋升列一组「读（筛）／写／下载 × 全局／部门／个人／无人」。
 *
 * @param options.column 只开这一列；不给就开**全部已晋升列**。
 */
export async function editFieldPermissions(ui: UI, table: string, options: AccessPanelOptions = {}) {
  return openAccessPanel(ui, table, { ...options, mode: options.column ? 'column' : 'columns' });
}

/**
 * 表级面板：整张表一组「读（筛）／写／下载 × 全局／部门／个人／无人」。
 *
 * 表级**没有**「继承」这一档（它上面没有更上层了）：读／写／下载都必填。
 */
export async function editTablePermissions(ui: UI, table: string, options: AccessPanelOptions = {}) {
  return openAccessPanel(ui, table, { ...options, mode: 'table' });
}

type PanelMode = 'columns' | 'column' | 'table';

async function openAccessPanel(
  ui: UI,
  table: string,
  options: AccessPanelOptions & { mode: PanelMode },
) {
  const fetcher = options.fetcher ?? fetch;
  const active = options.active ?? (() => true);
  const original = await readFieldPermissionContext(table, fetcher, options.signal);
  if (!active()) return;
  if (!original.can_manage_field_permissions) throw Error('当前账号不能管理字段权限');
  const promoted = original.columns.filter(column => column.promoted);
  if (options.mode !== 'table' && !promoted.length) throw Error('这张表还没有可设置权限的已晋升字段');
  if (options.mode === 'column' && !promoted.some(column => column.header === options.column)) {
    throw Error(`「${options.column}」不是已晋升的字段，不能单独设它的权限`);
  }
  if (!original.definition_sha) throw Error('未取得字段定义版本，请刷新后重试');

  const subjects = normalizeSubjectOptions(original.subject_options);
  const tableAccess = readAccessMap(original);
  const rawTableAccess =
    original.access && typeof original.access === 'object' ? (original.access as Record<string, unknown>) : {};

  let busy = false;
  let attempt: { signature: string; key: string } | null = null;

  const isTable = options.mode === 'table';
  const title = isTable ? '表权限' : options.mode === 'column' ? `字段权限：${options.column}` : '字段权限';
  const intro = isTable
    ? '<p>说清整张表谁能看、谁能改、谁能下载。选「部门」要指到具体部门，选「个人」要指到具体人。</p>'
    : '<p>每一列分别说清谁能看、谁能改、谁能下载。选「部门」要指到具体部门，选「个人」要指到具体人。没声明的列按整张表的权限算。</p>';

  const dialog = ui.dialog({
    title,
    body: `${intro}<div data-access-panel></div><p data-status role="status"></p>`,
    actions: [
      { label: '取消', onClick: () => { ui.closeModal(); } },
      { label: '保存', variant: 'pri', onClick: () => { void save(); } },
    ],
  });
  if (!dialog) return;
  ui.guardModal(dialog, () => !busy);

  const doc = dialog.ownerDocument;
  const panel = dialog.querySelector('[data-access-panel]')!;
  const columnEditors = new Map<string, AccessEditor>();
  let tableEditor: AccessEditor | null = null;

  const appendSection = (legendText: string, editor: AccessEditor) => {
    const section = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = legendText;
    section.append(legend, editor.element);
    panel.append(section);
  };

  if (isTable) {
    tableEditor = buildAccessEditor({
      doc,
      subject: '整张表',
      label: '整张表',
      access: tableAccess,
      subjects,
    });
    appendSection('整张表', tableEditor);
  } else {
    const targets =
      options.mode === 'column' ? promoted.filter(column => column.header === options.column) : promoted;
    for (const column of targets) {
      const editor = buildAccessEditor({
        doc,
        subject: '这一列',
        label: column.header,
        access: columnAccessFor(column, tableAccess),
        subjects,
      });
      appendSection(column.header, editor);
      columnEditors.set(column.header, editor);
    }
    // 表级还没按新规则声明 ⇒ 说清楚「没声明的列按整张表算」，并指去「表权限」。
    if (!tableAccess.read || !tableAccess.write || !tableAccess.download) {
      const hint = doc.createElement('p');
      hint.className = 'muted';
      hint.textContent = '整张表的权限还没按新规则声明（读／写／下载）—— 列没声明的部分按整张表算，先在「表格 → 表权限」里定下来。';
      panel.prepend(hint);
    }
  }

  async function save() {
    if (busy || !active()) return;
    const status = dialog!.querySelector('[data-status]')!;
    try {
      // ① 先校验（没定就说清是哪一列）—— 不许静默保存半截。
      const columnAccess = new Map<string, AccessMap>();
      for (const [header, editor] of columnEditors) columnAccess.set(header, editor.validate());
      const tableAccessNext = tableEditor ? tableEditor.validate() : null;
      /**
       * 表级声明**必须完整**（读／写／下载）——
       * 后端那条口（`files.promotion_define`）要求表级独立声明、必填三项
       * （契约第四节：表级不再由各列并集推导）。
       * 表级还没定 ⇒ **在这里说清楚**，别让人发一个必被拒的定义。
       */
      if (!tableAccessNext && !(tableAccess.read && tableAccess.write && tableAccess.download)) {
        throw Error('这张表的表级权限还没定（读／写／下载）—— 请先在「表格 → 表权限」里把整张表定下来');
      }

      // ② 组装落库形状：列级新形状 ＋ 表级 `access`（旧三键一律剥掉）。
      const draftColumns = original.columns.map(column => {
        const next = stripOldRoleKeys(column as Record<string, unknown>);
        const editor = columnEditors.get(column.header);
        if (editor) {
          next.access = columnAccess.get(column.header)!;
        } else {
          const own = readAccessMap(column);
          if (Object.keys(own).length) next.access = own;
          else delete next.access;
        }
        return next;
      });
      const nextTableAccess = tableAccessNext
        ? { ...tableAccessNext, ...extraAccessKeys(rawTableAccess) }
        : (Object.keys(stripOldRoleKeys(rawTableAccess)).length
            ? stripOldRoleKeys(rawTableAccess)
            : undefined);

      const payload = {
        table,
        expected_structure_version: original.structure_version,
        expected_definition_sha: original.definition_sha,
        definition: {
          definition_version: original.definition_version,
          columns: draftColumns,
          ...(nextTableAccess ? { access: nextTableAccess } : {}),
        },
      };
      const signature = JSON.stringify(payload);
      if (attempt && attempt.signature !== signature) {
        throw Error('上次保存结果尚未核实，请保持原输入重试或重新打开核对');
      }
      attempt ??= { signature, key: options.newKey?.() ?? crypto.randomUUID() };
      busy = true;
      status.textContent = '正在保存…';
      dialog!.querySelectorAll<HTMLInputElement>('input,select,button').forEach(c => { c.disabled = true; });
      await json(
        fetcher,
        '/api/platform/actions/files.promotion_define/execute',
        { payload, confirmed: true, idempotency_key: attempt.key, source: 'user' },
        options.signal,
      );
      const current = await readFieldPermissionContext(table, fetcher, options.signal);
      const saved = {
        columns: draftColumns.map(column => ({ header: column.header, access: normalizeAccessMap(column.access) })),
        access: normalizeAccessMap(nextTableAccess),
      };
      const reloaded = {
        columns: (current.columns ?? []).map(column => ({
          header: column.header,
          access: readAccessMap(column),
        })),
        access: readAccessMap(current),
      };
      if (canonical(saved) !== canonical(reloaded)) {
        throw Error('保存结果与当前定义不一致，请保留输入并重新打开核对');
      }
      if (!active()) return;
      busy = false;
      ui.closeModal();
      await options.saved?.();
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally {
      busy = false;
      dialog!.querySelectorAll<HTMLInputElement>('input,select,button').forEach(c => { c.disabled = false; });
    }
  }

  return dialog;
}
