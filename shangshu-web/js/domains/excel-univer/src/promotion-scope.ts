/**
 * **晋升入口**的「主体范围」编辑器（PKG-117-T01）。
 *
 * 口径：契约第 260 行「每次晋升一列必须写清楚该列的主体范围（全局/部门/个人/无人；
 * 部门与个人要指到具体对象）⇒ **晋升入口必填**」。
 *
 * 改之前：`db-capabilities.ts` 的建表流程**硬编码** `read_roles:['Desk User']`／
 * `write_roles:['Desk User']` —— 等于「所有人」，不是人定的。
 * 改之后：每一列都要人指一档；**没指就不许提交**（并说清是哪一列没填）。
 *
 * ⚠️ **主体清单的读口与「表权限」面板不同**（这是事实，不是选择）：
 * 建表那一刻**表还不存在** ⇒ 后端那条 `files.promotion_definition` 给不出
 * `subject_options`。所以这里走公共壳那两个只读口：
 *  · 部门：`GET /api/platform/datasets/platform.department/records`（部门数据集）
 *  · 人  ：`GET /api/platform/identities`（账号清单）
 * 读不到就**读不到**（清单为空 ⇒ 选「部门／个人」时无处可指 ⇒ 面板会明说）。
 */
import {
  buildScopePicker,
  validateAccessMap,
  type AccessMap,
  type SubjectOptions,
} from './access-scope';

/** 一列的主体范围（读（筛）／写／下载同一档 —— 降维后三个操作都必填）。 */
export type PromotionColumnScope = { header: string; access: AccessMap };

/** 只读清单用的取数口（与域里其它地方同一个形状：`url` ＋ `init`）。 */
export type ReadFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** 四档（晋升时每一列指一档）。
 *  2026-10-26 用户拍板：在全局／部门／个人**后面**加一档「无人（除管理员）」。 */
const PROMOTION_CHOICES = [
  { value: 'global', label: '全局（所有人）' },
  { value: 'department', label: '部门' },
  { value: 'personal', label: '个人' },
  { value: 'none', label: '无人（除管理员）' },
];

async function readJson(fetcher: ReadFetcher, url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetcher(url, { credentials: 'include', signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw Error(body?.error || `请求失败（${response.status}）`);
  return body;
}

/** 部门清单（公共壳的部门数据集）。读不到就是空清单（**不猜**）。 */
export async function readDepartments(fetcher: ReadFetcher = fetch, signal?: AbortSignal): Promise<SubjectOptions['departments']> {
  let body: any;
  try {
    body = await readJson(fetcher, '/api/platform/datasets/platform.department/records?page_length=100', signal);
  } catch {
    return [];
  }
  const rows = Array.isArray(body?.records) ? body.records : Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.list) ? body.list : [];
  const out: SubjectOptions['departments'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row?.name ?? row?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(row?.title ?? row?.label ?? id).trim() || id;
    out.push({ id, label });
  }
  return out;
}

/** 人员清单（公共壳的账号清单）。读不到就是空清单（**不猜**）。 */
export async function readUsers(fetcher: ReadFetcher = fetch, signal?: AbortSignal): Promise<SubjectOptions['users']> {
  let body: any;
  try {
    body = await readJson(fetcher, '/api/platform/identities', signal);
  } catch {
    return [];
  }
  const rows = Array.isArray(body?.list) ? body.list : Array.isArray(body) ? body : [];
  const out: SubjectOptions['users'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row?.email ?? row?.user_id ?? row?.name ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(row?.full_name ?? row?.name ?? row?.email ?? id).trim() || id;
    out.push({ id, label });
  }
  return out;
}

/** 部门 ＋ 人（两份清单并行读；各自失败不影响另一份）。 */
export async function readSubjectOptions(
  fetcher: ReadFetcher = fetch,
  signal?: AbortSignal,
): Promise<SubjectOptions> {
  const [departments, users] = await Promise.all([readDepartments(fetcher, signal), readUsers(fetcher, signal)]);
  return { departments, users };
}

export type PromotionScopeEditor = {
  /** 面板零件（每列一个 `<fieldset>`）。 */
  element: HTMLElement;
  /** 读回每一列的范围（**不**校验）。 */
  read(): PromotionColumnScope[];
};

/**
 * 建「每一列指一档」的面板零件。
 *
 * 每一列一组：全局／部门／个人／无人 ＋ 选「部门」才出现的部门多选 ＋ 选「个人」才出现的人员多选。
 * 一列的范围**同时**落在读／写／下载三项上（降维后没有「筛」这一项了）。
 */
export function buildPromotionScopeEditor(
  doc: Document,
  headers: string[],
  subjects: SubjectOptions,
): PromotionScopeEditor {
  const element = doc.createElement('div');
  element.className = 'promotion-scopes';
  const group = `promotion-scope-${Math.round(performance.now() * 1000)}-${headers.length}`;

  headers.forEach((header, index) => {
    const section = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = header;
    const title = doc.createElement('div');
    title.className = 'access-row-title';
    title.textContent = `这一列谁能看、能改、能下载（${header}）`;
    const picker = buildScopePicker({
      doc,
      name: `${group}-${index}`,
      choices: PROMOTION_CHOICES,
      selected: '',
      subjects,
      ariaLabel: `「${header}」这一列谁能看、能改、能下载`,
    });
    section.dataset.column = header;
    section.append(legend, title, picker.element);
    element.append(section);
  });

  return {
    element,
    read() {
      const out: PromotionColumnScope[] = [];
      for (const section of element.querySelectorAll<HTMLElement>('fieldset[data-column]')) {
        const header = section.dataset.column ?? '';
        const picker = section.querySelector<HTMLElement>('.access-picker');
        const scope = picker?.querySelector<HTMLInputElement>('.access-scopes input:checked')?.value ?? '';
        const access: AccessMap = {};
        if (scope === 'global') {
          access.read = { scope: 'global' };
          access.write = { scope: 'global' };
          access.download = { scope: 'global' };
        } else if (scope === 'department') {
          const departments = Array.from(
            section.querySelectorAll<HTMLInputElement>('input[data-department]:checked'),
          ).map(box => box.value);
          access.read = { scope: 'department', departments };
          access.write = { scope: 'department', departments };
          access.download = { scope: 'department', departments };
        } else if (scope === 'personal') {
          const users = Array.from(section.querySelectorAll<HTMLInputElement>('input[data-user]:checked')).map(
            box => box.value,
          );
          access.read = { scope: 'personal', users };
          access.write = { scope: 'personal', users };
          access.download = { scope: 'personal', users };
        } else if (scope === 'none') {
          /* 「无人（除管理员）」：**不带子键**（2026-10-26 用户拍板）。 */
          access.read = { scope: 'none' };
          access.write = { scope: 'none' };
          access.download = { scope: 'none' };
        }
        out.push({ header, access });
      }
      return out;
    },
  };
}

/**
 * 校验每一列都指了档 —— **报错要点名是哪一列**。
 *
 * @param scopes 面板读回的范围
 * @param headers 这一批要晋升的列名（用来报「哪一列没填」）
 */
export function validatePromotionScopes(scopes: PromotionColumnScope[], headers: string[]): void {
  const byHeader = new Map(scopes.map(scope => [scope.header, scope]));
  for (const header of headers) {
    const scope = byHeader.get(header);
    if (!scope) throw Error(`「${header}」还没定主体范围 —— 请说清谁能看、能改、能下载这一列`);
    validateAccessMap(scope.access, `「${header}」`, '这一列');
  }
}

/**
 * 新建表的**表级**声明：默认全局（全员可读可写）。
 *
 * 口径：改之前建表硬编码 `read_roles:['Desk User']`／`write_roles:['Desk User']`
 * ＝「所有人」；新模型里那一档叫「全局」。
 */
export function defaultTableAccess(): AccessMap {
  return {
    read: { scope: 'global' },
    write: { scope: 'global' },
    download: { scope: 'global' },
  };
}
