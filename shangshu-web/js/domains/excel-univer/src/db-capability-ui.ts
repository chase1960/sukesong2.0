/**
 * 受管对象（业务表）在 **Excel 工作面**上的八项能力。
 *
 * 受管对象的业务表已从「一行一条＋详情弹窗＋分页」换成 Excel 交互。
 * 换过去以后，表格中心独有的能力必须在 Excel 页上补齐 ——
 * 这八项就是：**新增记录／导出／修改历史／回收站恢复／导入／批量粘贴／按列筛选／建表**。
 *
 * 一条口径贯穿全篇：**能力闸 fail-closed**。
 * 服务端那份元数据说「不支持」，这里的按钮就**置灰并说清为什么**，
 * 不做成「按钮在、点了报不支持」。八项能力**没有一项是假的**：
 * 要么真能走通既有公开口，要么在闸那里就说清楚当前账号/这张表为什么用不了。
 *
 * 分工：
 *  · **批量粘贴**在 `backend.ts` 的业务表后端里（它要行身份与记录版本）；
 *  · **按列筛选**的读在 `backend.ts`、触发在 `main.ts`（它要网格上下文）；
 *  · 其余六项 ＋ 筛选对话框在这里。
 */

import {platformActionList,platformObjectDefinition} from './platform-catalog';
import {
  buildServerFilters,
  confirmImport,
  createRecord,
  createTableByPromotion,
  exportRecords,
  filterableFields,
  previewImport,
  readGates,
  readHistory,
  readTrashRecords,
  restoreRecord,
  type DbGates,
  type DbObjectMeta,
  type Fetcher,
} from './db-capabilities';
import {
  buildPromotionScopeEditor,
  readSubjectOptions,
  validatePromotionScopes,
  type PromotionScopeEditor,
} from './promotion-scope';
import {
  buildPromotionRulesEditor,
  validatePromotionRules,
  type PromotionRulesEditor,
} from './promotion-rules-editor';

/** 业务表（db）在这一层需要的最小身份。 */
export interface DbTableLike {
  key: string;
  title: string;
  kind: string;
  /**
   * 这一列出现过的值（业务表后端有；xlsx 没有）。
   * ⚠️ 服务端**没有**「整列去重值」这个口 ⇒ 业务表给的是**已加载那一页**里出现过的值，
   *    `truncated` 说明它不完整 —— 界面必须**说清楚**，不能拿半份清单当全量。
   */
  columnValues?(column: string): Promise<{ values: string[]; has_blank: boolean; total: number; truncated: boolean }>;
}

export interface DbUiContext {
  host: HTMLElement;
  /** 公共工作面（弹窗、通知）。拿不到就退回原生对话框。 */
  ui: any;
  signal: AbortSignal;
  /** 当前这张表（可能是 xlsx ⇒ 不是业务表）。 */
  table(): DbTableLike | null;
  /** 当前这张业务表的**服务端**元数据（开表时取，换表时换）。 */
  meta(): DbObjectMeta | null;
  /** 当前账号是不是管理员（建表要管理员）。 */
  isAdmin(): boolean;
  /** 当前选中的那一行的记录号（没有就 null）。 */
  selectedRowId(): string | null;
  /** 通知（人话）。 */
  notify(title: string, kind?: string): void;
  /** 重读整张表（写完之后刷新）。 */
  reload(): Promise<void>;
  /** 当前生效的**服务端**筛选条件。 */
  filters(): Record<string, unknown>;
  /** 换服务端筛选条件（下一读就带着它去查）。 */
  setFilters(filters: Record<string, unknown>): void;
}

export interface DbCapabilityHandle {
  /** 按当前这张表的能力闸更新按钮（开表、换表后都要调）。 */
  update(): void;
  /** 打开「按列筛选」对话框。 */
  openFilter(columnId?: string): void;
  dispose(): void;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 服务端那份对象元数据（每次现取 —— 版本号会变，不能拿旧的写）。 */
async function loadMeta(objectId: string, signal: AbortSignal): Promise<DbObjectMeta | null> {
  return await platformObjectDefinition(objectId,signal) as DbObjectMeta;
}

export function mountDbCapabilities(ctx: DbUiContext): DbCapabilityHandle {
  const doc = ctx.host.ownerDocument;
  const toolrow = ctx.host.querySelector('.excel-toolrow') as HTMLElement | null;
  if (!toolrow) throw Error('工具栏没找到，业务表能力挂不上去');

  const group = doc.createElement('div');
  group.className = 'excel-toolgroup excel-db-tools';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '业务表');
  group.hidden = true;
  group.innerHTML = `
    <button type="button" class="btn btn-pri" data-db-create title="新增一条记录"><span>新增记录</span></button>
    <button type="button" class="btn" data-db-export title="导出这张表的全部有权记录"><span>导出</span></button>
    <button type="button" class="btn" data-db-import title="从 Excel 导入到这张表"><span>导入</span></button>
    <button type="button" class="btn" data-db-history title="看选中那一行的修改历史"><span>修改历史</span></button>
    <button type="button" class="btn" data-db-trash title="看回收站并恢复记录"><span>回收站</span></button>
    <button type="button" class="btn" data-db-new-table title="新建一张业务表"><span>新建表</span></button>
    <button type="button" class="btn" data-db-filter title="按某一列精确筛选（服务端按整表算）"><span>筛选</span></button>
  `;
  toolrow.append(group);

  const buttons = {
    create: group.querySelector('[data-db-create]') as HTMLButtonElement,
    export: group.querySelector('[data-db-export]') as HTMLButtonElement,
    import: group.querySelector('[data-db-import]') as HTMLButtonElement,
    history: group.querySelector('[data-db-history]') as HTMLButtonElement,
    trash: group.querySelector('[data-db-trash]') as HTMLButtonElement,
    newTable: group.querySelector('[data-db-new-table]') as HTMLButtonElement,
    filter: group.querySelector('[data-db-filter]') as HTMLButtonElement,
  };
  const downloadUrls = new Set<string>();
  let busy = false;

  /**
   * 这个账号能不能做「首次晋升」（建表要走那条路）。
   *
   * **闸从服务端能力清单读**（`GET /api/platform/actions` 里有没有 `files.promotion_define`）
   * —— 首次晋升是 System Manager 专属，前端角色猜错就会出现「按钮能点、点了被拒」。
   * 读不到 ⇒ 当作**没有**（fail-closed）。
   */
  let promoteCapability: boolean | null = null;
  async function canPromote(): Promise<boolean> {
    if (promoteCapability !== null) return promoteCapability;
    try {
      /* ⚠️ **走公共壳的「清单口」**（`shangshuPlatformCatalog`）——
         同一轮里只发一次请求：这个界面会被挂好几次（每次挂都问一遍服务端
         「这个动作我能不能用」）⇒ 改之前是**拉好几遍**
         （用户 2026-10-25 问：「为什么总是会把业务域重新加载一遍」）。
         ⚠️ 壳的那个口不在（域脚本单独跑）⇒ 照旧自己读。 */
      const body = await platformActionList(ctx.signal);
      const list = (body?.list || []) as Array<{ id?: string }>;
      promoteCapability = Array.isArray(list) && list.some(item => item?.id === 'files.promotion_define');
    } catch {
      promoteCapability = false;
    }
    return promoteCapability;
  }

  const objectId = () => ctx.table()?.key ?? '';
  const fetcher: Fetcher = (url, init) => fetch(url, { credentials: 'include', signal: ctx.signal, ...(init || {}) });

  /** 统一跑一件事：挡重复点击、把异常说成人话。 */
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    update();
    try {
      await action();
    } catch (error) {
      ctx.notify(`${label}失败：${(error as Error).message}`, 'error');
    } finally {
      busy = false;
      update();
    }
  }

  /* ——— 通用对话框 ————————————————————————————————————— */

  interface DialogAction {
    label: string;
    variant?: string;
    onClick?: () => void | Promise<void>;
  }
  function openDialog(options: { title: string; body: HTMLElement; actions: DialogAction[] }): HTMLElement | null {
    if (ctx.ui?.dialog) {
      return ctx.ui.dialog({
        title: options.title,
        body: options.body,
        actions: options.actions.map(action => ({
          label: action.label,
          variant: action.variant,
          onClick: async () => {
            try {
              await action.onClick?.();
            } catch (error) {
              ctx.notify((error as Error).message, 'error');
            }
          },
        })),
      }) as HTMLElement | null;
    }
    // 没有公共工作面 ⇒ 用原生对话框（样式差一点，功能不缺）。
    const dialog = doc.createElement('dialog');
    dialog.className = 'os-dialog';
    dialog.innerHTML = '<header><h2></h2></header><main></main><footer></footer>';
    dialog.querySelector('h2')!.textContent = options.title;
    dialog.querySelector('main')!.append(options.body);
    const foot = dialog.querySelector('footer')!;
    for (const action of options.actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = action.variant === 'pri' ? 'btn btn-pri' : 'btn';
      button.textContent = action.label;
      button.onclick = () => { void (async () => { try { await action.onClick?.(); } catch (error) { ctx.notify((error as Error).message, 'error'); } })(); };
      foot.append(button);
    }
    doc.body.append(dialog);
    dialog.showModal?.();
    return dialog;
  }

  /* ——— 1. 新增记录 ——————————————————————————————————————— */

  async function openCreate() {
    const meta = await loadMeta(objectId(), ctx.signal);
    if (!meta) throw Error('这张表的信息读不到了');
    const g = globalThis as any;
    if (typeof g.openSchemaForm !== 'function' || typeof g.schemaWithLookups !== 'function') {
      throw Error('表单组件没加载，请刷新后重试');
    }
    // 关联列用**同一个**选择器（跟旧表单同一条路），不自己造一个。
    const schema = g.schemaWithLookups(meta.input_schema || {}, (meta as any).reference_fields || {});
    const properties = schema.properties || {};
    g.openSchemaForm({
      title: `新增记录 · ${meta.title || ''}`,
      description: '新记录直接进这张业务表，保存后就在表里。',
      ...schema,
      values: {},
      submitLabel: '确认保存',
      onSubmit: async (values: Record<string, unknown>) => {
        const payload: Record<string, unknown> = {};
        for (const key of Object.keys(properties)) payload[key] = values?.[key] ?? null;
        const fresh = await loadMeta(objectId(), ctx.signal);
        await createRecord(fetcher, {
          objectId: objectId(),
          expectedRevision: Number(fresh?.revision ?? meta.revision ?? 0),
          values: payload,
          idempotencyKey: `db-create-${Date.now().toString(36)}`,
        });
        ctx.notify('已新增一条记录', 'success');
        await ctx.reload();
      },
    });
  }

  /* ——— 2. 导出 ———————————————————————————————————————— */

  async function doExport() {
    const meta = await loadMeta(objectId(), ctx.signal);
    if (!meta) throw Error('这张表的信息读不到了');
    const result = await exportRecords(fetcher, {
      objectId: objectId(),
      expectedRevision: Number(meta.revision ?? 0),
      // 导出条件 = 当前的服务端筛选条件（导的是「筛出来的那些」，不是全表）。
      filters: ctx.filters(),
    });
    const url = URL.createObjectURL(new Blob([result.bytes as unknown as BlobPart], { type: result.mime || XLSX_MIME }));
    downloadUrls.add(url);
    const link = doc.createElement('a');
    link.href = url;
    link.download = result.filename;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    ctx.notify(`已导出 ${result.total} 条正式记录（全部有权列，不限本页）`, 'success');
  }

  /* ——— 3. 修改历史 —————————————————————————————————————— */

  async function openHistory() {
    const name = ctx.selectedRowId();
    if (!name) throw Error('先在表里点一行，再看它的修改历史');
    const result = await readHistory(fetcher, { objectId: objectId(), name, page: 1, pageLength: 20 });
    const body = doc.createElement('div');
    body.className = 'db-history';
    if (!result.items.length) {
      body.innerHTML = '<p class="muted">这一行还没有修改历史。</p>';
    } else {
      body.innerHTML = result.items
        .map(item => {
          const changes = (item.changes || [])
            .map((change: any) => `<div><b>${escapeHtml(change.label || change.field)}</b>：${escapeHtml(String(change.before ?? ''))} → ${escapeHtml(String(change.after ?? ''))}</div>`)
            .join('');
          const operation = ({ create: '新增', update: '修改', recycle: '回收', restore: '恢复' } as Record<string, string>)[String(item.operation)] || String(item.operation);
          return `<section class="db-history-item"><header><b>${escapeHtml(operation)}</b><span>${escapeHtml(String(item.actor || ''))}</span><time>${escapeHtml(String(item.time || ''))}</time></header>${changes || '<div class="muted">（这一笔没有字段级变化）</div>'}</section>`;
        })
        .join('');
    }
    openDialog({ title: `修改历史 · ${result.total} 笔`, body, actions: [{ label: '关闭' }] });
  }

  /* ——— 4. 回收站／恢复 ——————————————————————————————————— */

  async function openTrash() {
    const meta = await loadMeta(objectId(), ctx.signal);
    const result = await readTrashRecords(fetcher, objectId(), { page: 1, pageLength: 100 });
    const body = doc.createElement('div');
    body.className = 'db-trash';
    if (!result.rows.length) {
      body.innerHTML = '<p class="muted">回收站里没有记录。</p>';
    } else {
      const list = doc.createElement('div');
      list.className = 'db-trash-list';
      for (const row of result.rows) {
        const item = doc.createElement('div');
        item.className = 'db-trash-item';
        const name = doc.createElement('span');
        name.textContent = String(row.name ?? '');
        const when = doc.createElement('small');
        when.textContent = String(row.modified ?? '');
        const restore = doc.createElement('button');
        restore.type = 'button';
        restore.className = 'btn btn-ghost';
        restore.textContent = '恢复';
        restore.onclick = () =>
          run('恢复', async () => {
            const fresh = await loadMeta(objectId(), ctx.signal);
            await restoreRecord(fetcher, {
              objectId: objectId(),
              name: String(row.name),
              expectedRevision: Number(fresh?.revision ?? meta?.revision ?? 0),
              expectedModified: String(row.modified ?? ''),
              idempotencyKey: `db-restore-${row.name}-${Date.now().toString(36)}`,
            });
            ctx.notify(`已恢复 ${row.name}`, 'success');
            await ctx.reload();
            await openTrash();
          });
        item.append(name, when, restore);
        list.append(item);
      }
      body.append(list);
    }
    openDialog({ title: `回收站 · ${result.total} 条`, body, actions: [{ label: '关闭' }] });
  }

  /* ——— 5. 导入（四个阶段） —————————————————————————————— */

  async function openImport() {
    const meta = await loadMeta(objectId(), ctx.signal);
    if (!meta) throw Error('这张表的信息读不到了');
    const capability = meta.import;
    const maxRows = Number(capability?.max_rows ?? 500);
    const maxMb = Math.floor(Number(capability?.max_bytes ?? 10485760) / 1048576);
    const body = doc.createElement('div');
    body.className = 'db-import';
    const error = doc.createElement('p');
    error.className = 'dlg-error';
    error.setAttribute('role', 'alert');

    let content: Record<string, unknown> | null = null;
    let columns: Array<{ index: number; letter: string; label: string }> = [];
    let fields: Array<{ id: string; label: string; type: string; required?: boolean }> = [];
    let plan: any = null;
    let checked: Record<string, unknown> | null = null;
    let stage = 1;

    body.innerHTML = `
      <p class="db-import-step" data-step>1 选择文件与工作表</p>
      <section data-stage-1>
        <label class="dlg-field">本地 XLSX 文件<input type="file" accept=".xlsx" data-file></label>
        <div class="db-import-source">
          <label class="dlg-field">工作表<select data-sheet><option value="">请先选择文件</option></select></label>
          <label class="dlg-field">表头行<input type="number" min="1" max="100" value="1" data-header></label>
        </div>
        <p class="muted">单次最多 ${maxRows} 行、${maxMb}MB。导入前会先核对新增和修改，不会自动发布或扩大权限。</p>
      </section>
      <section data-stage-2 hidden></section>
      <section data-stage-3 hidden></section>
    `;
    body.append(error);
    const get = (selector: string) => body.querySelector(selector) as HTMLElement;

    /** 主按钮：按阶段决定做什么（读表头 → 检查导入 → 确认导入）。 */
    async function primary() {
      error.textContent = '';
      if (stage === 1) return readHeader();
      if (stage === 2) return checkImport();
      return confirmImportNow();
    }

    const dialog = openDialog({
      title: `导入 Excel · ${meta.title || ''}`,
      body,
      actions: [
        { label: '关闭' },
        { label: '下一步', variant: 'pri', onClick: primary },
      ],
    });

    function setStage(next: number) {
      stage = next;
      get('[data-stage-1]').hidden = next !== 1;
      get('[data-stage-2]').hidden = next !== 2;
      get('[data-stage-3]').hidden = next !== 3;
      get('[data-step]').textContent = ['1 选择文件与工作表', '2 核对列映射与匹配依据', '3 核对导入范围'][next - 1];
      const primaryButton = dialog?.querySelector('footer [data-act="1"]') as HTMLButtonElement | null;
      if (primaryButton) {
        primaryButton.textContent = next === 1 ? '下一步' : next === 2 ? '检查导入' : '确认导入';
      }
    }
    setStage(1);

    async function readHeader() {
      if (!content) throw Error('请先选择文件');
      const sheet = (get('[data-sheet]') as HTMLSelectElement).value;
      const header = Number((get('[data-header]') as HTMLInputElement).value);
      if (!sheet) throw Error('请选择工作表');
      if (!Number.isInteger(header) || header < 1 || header > 100) throw Error('表头行填写 1–100 的整数');
      const payload = { ...content, sheet, header_row: header };
      const preview = await previewImport(fetcher, payload);
      if (!Array.isArray(preview.columns) || !Array.isArray(preview.fields)) throw Error('列定义回执不完整');
      content = payload;
      columns = preview.columns;
      fields = preview.fields;
      renderMapping();
      setStage(2);
    }

    function renderMapping() {
      const options = columns
        .map(column => `<option value="${column.index}">${escapeHtml(column.letter)} · ${escapeHtml(column.label)}</option>`)
        .join('');
      const section = get('[data-stage-2]');
      section.innerHTML = `
        <div class="db-import-table-wrap"><table class="db-import-table"><thead><tr><th>系统字段</th><th>Excel 来源列</th></tr></thead><tbody>
        ${fields.map(field => `<tr><td>${escapeHtml(field.label)}${field.required ? ' *' : ''}</td><td><select data-map="${escapeHtml(field.id)}" aria-label="${escapeHtml(field.label)}来源列"><option value="">不导入此列</option>${options}</select></td></tr>`).join('')}
        </tbody></table></div>
        <label class="dlg-field">用哪一列匹配已有记录？<select data-match><option value="">请选择匹配依据</option>${fields.filter(field => ['text', 'integer', 'date', 'choice'].includes(field.type)).map(field => `<option value="${escapeHtml(field.id)}">${escapeHtml(field.label)}</option>`).join('')}</select></label>
        <p class="muted">相同值更新原行，没有匹配则新增；重复或已回收的匹配值会阻止导入。未映射的列保持原值。</p>
      `;
      // 同名列自动对上（两边都只有一个同名列时）。
      for (const field of fields) {
        const candidates = columns.filter(column => column.label === field.label);
        if (candidates.length === 1 && fields.filter(item => item.label === field.label).length === 1) {
          const select = section.querySelector(`[data-map="${field.id}"]`) as HTMLSelectElement | null;
          if (select) select.value = String(candidates[0].index);
        }
      }
    }

    async function checkImport() {
      const mapping = Object.fromEntries(
        Array.from(body.querySelectorAll('[data-map]'))
          .filter(control => (control as HTMLSelectElement).value)
          .map(control => [(control as HTMLElement).getAttribute('data-map')!, Number((control as HTMLSelectElement).value)]),
      );
      const match = (body.querySelector('[data-match]') as HTMLSelectElement).value;
      if (!match || !mapping[match]) throw Error('请明确选择匹配依据，并映射该字段的 Excel 来源列');
      if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length) {
        throw Error('同一来源列不能重复映射，请检查列对应关系');
      }
      const payload = { ...(content as Record<string, unknown>), mapping, match_field: match };
      const preview = await previewImport(fetcher, payload);
      if (!preview.summary || !Array.isArray(preview.errors) || !Array.isArray(preview.rows) || typeof preview.preview_hash !== 'string') {
        throw Error('导入预检回执不完整');
      }
      checked = payload;
      plan = preview;
      renderResult();
      setStage(3);
    }

    function renderResult() {
      const summary = plan.summary;
      const section = get('[data-stage-3]');
      const items = summary.errors ? plan.errors : plan.rows;
      const blank = (value: unknown) => (value === null || value === undefined ? '（空）' : String(value));
      const matchField = String(checked?.match_field ?? '');
      section.innerHTML = `
        <p class="db-import-summary">新增 ${summary.create} 行 · 修改 ${summary.update} 行 · 不变 ${summary.unchanged} 行 · 错误 ${summary.errors} 项</p>
        ${summary.errors ? '<p class="dlg-error">请修正全部错误后重试，本次不会部分导入。</p>' : ''}
        <div class="db-import-table-wrap"><table class="db-import-table"><thead><tr>
        ${summary.errors ? '<th>工作表 / 行</th><th>列</th><th>错误与处理</th>' : '<th>行 / 操作</th><th>匹配值</th><th>正式值 → 导入值</th>'}
        </tr></thead><tbody>
        ${items.slice(0, 50).map((item: any) => (summary.errors
          ? `<tr><td>${escapeHtml(item.sheet)} · ${escapeHtml(item.row)}</td><td>${escapeHtml(item.label || item.coordinate || item.column)}</td><td>${escapeHtml(item.message)}</td></tr>`
          : `<tr><td>${escapeHtml(item.row)} · ${escapeHtml(({ create: '新增', update: '修改', unchanged: '不变' } as Record<string, string>)[item.operation] || item.operation)}</td><td>${escapeHtml(blank(item.values?.[matchField]))}</td><td>${(item.changes || []).map((change: any) => `${escapeHtml(change.label)}：${escapeHtml(blank(change.before))} → ${escapeHtml(blank(change.after))}`).join('<br>') || '无变化'}</td></tr>`)).join('')}
        </tbody></table></div>
      `;
    }

    async function confirmImportNow() {
      if (!plan || !checked) throw Error('请先检查导入');
      if (plan.summary?.errors) throw Error('导入预检有错误，请先修正');
      const result = await confirmImport(fetcher, checked, { idempotencyKey: `db-import-${Date.now().toString(36)}` });
      ctx.notify(`导入已保存：新增 ${result.create} 行、修改 ${result.update} 行、不变 ${result.unchanged} 行`, 'success');
      ctx.ui?.closeModal?.();
      await ctx.reload();
    }

    get('[data-file]').addEventListener('change', () => {
      void (async () => {
        error.textContent = '';
        try {
          const file = (get('[data-file]') as HTMLInputElement).files?.[0];
          if (!file) return;
          if (!file.name.toLowerCase().endsWith('.xlsx') || !file.size) throw Error('请选择非空 .xlsx 文件');
          if (file.size > Number(capability?.max_bytes ?? 10485760)) throw Error(`文件太大（上限 ${maxMb}MB）`);
          const encoded = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(Error('文件读取失败，请重新选择'));
            reader.readAsDataURL(file);
          });
          content = {
            object_id: objectId(),
            expected_revision: Number(meta.revision ?? 0),
            filename: file.name,
            content_base64: encoded,
          };
          const preview = await previewImport(fetcher, content);
          const sheets = Array.isArray(preview.sheets) ? preview.sheets : [];
          if (!sheets.length) throw Error('未读取到工作表，请检查文件');
          const select = get('[data-sheet]') as HTMLSelectElement;
          select.replaceChildren(new Option('请选择工作表', ''));
          for (const sheet of sheets) select.add(new Option(String(sheet), String(sheet)));
        } catch (cause) {
          error.textContent = (cause as Error).message;
        }
      })();
    });
  }

  /* ——— 6. 建表（走「晋升」那条路） ————————————————————————— */

  /**
   * 建表的口径（内核 `shangshu_core/data_ownership.py`）：
   * **表文件（xlsx）→ 每一列都晋升成受管列 → 受管对象 ＋ 受管记录**，**不建 DocType**。
   *
   * ⚠️ **首次晋升是 System Manager 专属**（域声明写死「首次晋升仅 FDE 受管工程入口」）
   * ⇒ 按钮的闸**从服务端能力清单读**（`GET /api/platform/actions` 里有没有
   * `files.promotion_define`），没有就**置灰并说清找谁**，不做一个「点了报不支持」的按钮。
   */
  async function openNewTable() {
    const body = doc.createElement('div');
    body.className = 'db-new-table';
    body.innerHTML = `
      <label class="dlg-field">表名<input type="text" data-name placeholder="例如：客户台账" maxlength="100"></label>
      <label class="dlg-field">表头（逗号分隔，按顺序）<input type="text" data-headers placeholder="例如：客户,金额,状态" maxlength="500"></label>
      <p class="muted">新表先归你自己（之后可在文件中心改归属）。建表会先把表文件放进文件中心，
        <b>每一列都晋升成受管列</b>，再建成受管对象 ＋ 受管记录 —— 这一步只有管理员能做。</p>
      <fieldset class="db-promotion-scopes">
        <legend>每一列谁能看、能改、能下载（晋升必填）</legend>
        <div data-promotion-scopes></div>
        <p class="muted" data-promotion-note></p>
      </fieldset>
      <fieldset class="db-promotion-rules">
        <legend>每一列是什么类型、要有什么规则</legend>
        <div data-promotion-rules></div>
        <p class="muted" data-promotion-rules-note>
          类型决定这一列怎么存、怎么校验：<b>日期</b>列在表里给日历，<b>是／否</b>列分得出「未填」和「否」，
          <b>数字</b>列能填上下限，填了<b>取值清单</b>的列在表里给下拉。没动过的列按「文字」处理。</p>
      </fieldset>
      <p class="dlg-error" data-error role="alert"></p>
    `;
    const error = body.querySelector('[data-error]') as HTMLElement;
    const scopeHost = body.querySelector('[data-promotion-scopes]') as HTMLElement;
    const scopeNote = body.querySelector('[data-promotion-note]') as HTMLElement;
    const rulesHost = body.querySelector('[data-promotion-rules]') as HTMLElement;
    const headersInput = body.querySelector('[data-headers]') as HTMLInputElement;
    const readHeaders = () => headersInput.value.split(/[,，]/).map(item => item.trim()).filter(Boolean);
    // 主体清单（部门 ＋ 人）：公共壳那两个只读口 —— 建表那一刻表还不存在，
    // 后端那份 `subject_options` 读不到（读不到就是读不到，不猜）。
    let scopeEditor: PromotionScopeEditor | null = null;
    /* —— **逐列的类型与规则**（PKG-126-T04）：跟着表头一起重画。 —— */
    let rulesEditor: PromotionRulesEditor | null = null;
    const renderScopes = (headers: string[]) => {
      scopeEditor = buildPromotionScopeEditor(doc, headers, subjects);
      scopeHost.replaceChildren(scopeEditor.element);
      rulesEditor = buildPromotionRulesEditor(doc, headers);
      rulesHost.replaceChildren(rulesEditor.element);
    };
    headersInput.addEventListener('input', () => renderScopes(readHeaders()));
    const subjects = await readSubjectOptions(fetcher, ctx.signal);
    scopeNote.textContent = subjects.departments.length || subjects.users.length
      ? `部门清单 ${subjects.departments.length} 条、人员清单 ${subjects.users.length} 条 —— 选「部门」要指到具体部门，选「个人」要指到具体人。`
      : '没读到部门与人员清单 —— 只有「全局（所有人）」能选。';
    renderScopes(readHeaders());
    openDialog({
      title: '新建业务表',
      body,
      actions: [
        { label: '取消' },
        {
          label: '建表',
          variant: 'pri',
          onClick: async () => {
            error.textContent = '';
            const name = (body.querySelector('[data-name]') as HTMLInputElement).value.trim();
            const headers = (body.querySelector('[data-headers]') as HTMLInputElement).value
              .split(/[,，]/)
              .map(item => item.trim())
              .filter(Boolean);
            if (!name) throw Error('请填写表名');
            if (!headers.length) throw Error('请填写表头（至少一列）');
            if (!scopeEditor) throw Error('还在读部门与人员清单，请稍候再提交');
            // 每一列的主体范围（**必填**）—— 没指到具体对象就不许提交（并说清是哪一列）。
            const scopes = scopeEditor.read();
            validatePromotionScopes(scopes, headers);
            // 每一列的**类型与规则**（PKG-126-T04）—— 服务端当场拒的类型/规则在本地先说清。
            if (!rulesEditor) throw Error('逐列类型还没准备好，请稍候再提交');
            const columnRules = rulesEditor.read();
            validatePromotionRules(columnRules, headers);
            const result = await createTableByPromotion(fetcher, {
              fileName: name,
              headers,
              attribution: { level: 'personal' },
              columns: scopes,
              columnRules,
              idempotencyKey: `db-new-table-${Date.now().toString(36)}`,
            });
            ctx.notify(`已新建业务表「${name}」：${result.promotedColumns} 列晋升成受管列`, 'success');
            ctx.ui?.closeModal?.();
            /* 整页跳到新表（`location.href`）—— 不能用 `go('excel')`：
               app.js 换页时会把地址里的 `?object=` 清掉 ⇒ 表打不开。 */
            const url = new URL(location.href);
            url.searchParams.set('object', result.objectId);
            location.href = url.toString();
          },
        },
      ],
    });
  }

  /* ——— 7. 按列筛选（服务端精确等值） ————————————————————— */

  async function openFilter(columnId?: string) {
    const meta = await loadMeta(objectId(), ctx.signal);
    if (!meta) throw Error('这张表的信息读不到了');
    const filterable: string[] = filterableFields(meta);
    if (!filterable.length) throw Error('这张表没有可用于筛选的字段');
    const labels = new Map((meta.fields || []).map(field => [field.id, field.label || field.id]));
    const current = ctx.filters();
    const body = doc.createElement('div');
    body.className = 'db-filter';
    const columnSelect = doc.createElement('select');
    columnSelect.setAttribute('aria-label', '要筛选哪一列');
    for (const field of filterable) columnSelect.add(new Option(labels.get(field) || field, field));
    /* 默认落在**当前真有条件的那一列** ——
       否则「清除条件」会去清一个根本没条件的列，真条件原封不动（看着像清除没生效）。 */
    const filteredColumn=Object.keys(current).find(key=>!key.startsWith('$'));
    if(filteredColumn&&filterable.includes(filteredColumn))columnSelect.value=filteredColumn;
    if (columnId && filterable.includes(columnId)) columnSelect.value = columnId;
    const valueInput = doc.createElement('input');
    valueInput.setAttribute('aria-label', '要匹配的值');
    valueInput.placeholder = '要精确匹配的值';
    valueInput.value = String((current[columnSelect.value] as string) ?? '');
    columnSelect.addEventListener('change', () => {
      valueInput.value = String((current[columnSelect.value] as string) ?? '');
    });
    const label = doc.createElement('label');
    label.className = 'dlg-field';
    label.textContent = '按这一列筛选';
    label.append(columnSelect, valueInput);
    body.append(label);
    /* 值建议：服务端**没有**「整列去重值」这个口 ⇒ 这里只列**当前筛选条件下已加载那一页**
       里出现过的值，并**说清楚**它不完整（不拿半份清单当全量）。
       筛选本身仍是服务端精确等值，不受这里影响。 */
    const suggestions = doc.createElement('datalist');
    suggestions.setAttribute('data-db-values','');
    valueInput.setAttribute('list','db-filter-values');
    label.append(suggestions);
    body.insertAdjacentHTML(
      'beforeend',
      '<p class="muted">筛选由服务端按整张表算（不是只筛已加载的那几行）。服务端只支持「这一列＝某个值」的精确匹配。</p>',
    );
    const valuesNote = doc.createElement('p');
    valuesNote.className = 'muted';
    body.append(valuesNote);
    void (async () => {
      try {
        const values = await ctx.table()?.columnValues?.(columnSelect.value);
        if (!values) return;
        suggestions.replaceChildren(...values.values.map(value => {
          const option = doc.createElement('option');
          option.value = value;
          return option;
        }));
        valuesNote.textContent = values.truncated
          ? `下面是已加载范围内出现过的 ${values.values.length} 个值（这张表还有更多，没列全）；可以直接输入表里没有的值。`
          : `下面是这张表里出现过的 ${values.values.length} 个值。`;
      } catch {
        valuesNote.textContent = '取不到这一列的值清单（不影响筛选，直接输入要精确匹配的值即可）。';
      }
    })();
    openDialog({
      title: '按列筛选',
      body,
      actions: [
        { label: '取消' },
        {
          label: '清除条件',
          onClick: async () => {
            const next = buildServerFilters(current, { column: columnSelect.value, value: null });
            ctx.setFilters(next);
            ctx.ui?.closeModal?.();
            await ctx.reload();
            ctx.notify('已清除这一列的筛选条件', 'success');
          },
        },
        {
          label: '应用筛选',
          variant: 'pri',
          onClick: async () => {
            const value = valueInput.value.trim();
            if (!value) throw Error('请输入要精确匹配的值');
            const next = buildServerFilters(current, { column: columnSelect.value, value });
            ctx.setFilters(next);
            ctx.ui?.closeModal?.();
            await ctx.reload();
            ctx.notify('已按服务端条件筛选', 'success');
          },
        },
      ],
    });
  }

  /* ——— 接线 ——————————————————————————————————————————— */

  buttons.create.addEventListener('click', () => { void run('新增记录', openCreate); }, { signal: ctx.signal });
  buttons.export.addEventListener('click', () => { void run('导出', doExport); }, { signal: ctx.signal });
  buttons.import.addEventListener('click', () => { void run('导入', openImport); }, { signal: ctx.signal });
  buttons.history.addEventListener('click', () => { void run('读取修改历史', openHistory); }, { signal: ctx.signal });
  buttons.trash.addEventListener('click', () => { void run('读取回收站', openTrash); }, { signal: ctx.signal });
  buttons.newTable.addEventListener('click', () => { void run('新建表', openNewTable); }, { signal: ctx.signal });
  buttons.filter.addEventListener('click', () => { void run('筛选', () => openFilter()); }, { signal: ctx.signal });

  function update() {
    const table = ctx.table();
    group.hidden = table?.kind !== 'db';
    if (table?.kind !== 'db') return;
    /* 建表那一项的闸依赖服务端能力清单 ⇒ **只在真的开着业务表时**去读一次
       （开 xlsx 表不读，别白花一个请求）。读回来再刷新一次按钮状态；
       读之前按客户端角色兜底，所以不会闪。 */
    if (promoteCapability === null) void canPromote().then(() => update());
    const meta = ctx.meta();
    const gates: DbGates | null = meta
      ? readGates(meta, {
        // 服务端能力清单还没回来 ⇒ 先按客户端角色兜底，回来后再刷新一次。
        canPromote: promoteCapability === null ? undefined : promoteCapability,
        isAdmin: ctx.isAdmin(),
      })
      : null;
    const set = (button: HTMLButtonElement, gate: { available: boolean; reason: string } | undefined) => {
      const available = !!gate?.available;
      button.disabled = busy || !available;
      button.title = gate?.reason || '当前不可用';
    };
    set(buttons.create, gates?.create);
    set(buttons.export, gates?.export);
    set(buttons.import, gates?.import);
    set(buttons.history, gates?.history);
    set(buttons.trash, gates?.recycle);
    set(buttons.newTable, gates?.createTable);
    set(buttons.filter, gates?.columnFilter);
  }

  ctx.signal.addEventListener('abort', () => {
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
    group.remove();
  }, { once: true });

  return {
    update,
    openFilter: (columnId?: string) => { void run('筛选', () => openFilter(columnId)); },
    dispose: () => { group.remove(); },
  };
}
