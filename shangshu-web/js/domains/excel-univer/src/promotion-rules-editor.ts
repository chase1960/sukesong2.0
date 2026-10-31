/**
 * **工程晋升设置**：逐列的**类型与规则**（PKG-126-T04 · 2026-10-27）。
 *
 * **为什么要有**：建表那条路（`files.create` → `files.promotion_define`）里，
 * **每一列的类型是写死的 `type:'text'`**（`db-capabilities.ts` 的 `createTableByPromotion`），
 * 规则（`rules.min/max/options/allow_custom`）**根本没人能填**
 * ⇒ 受管列天生是自由文本：**日期列没有日历、布尔列分不出未填／否、数值列不校验、枚举列给不出下拉**。
 * （PKG-126-T01/T02 那两列的值域是**事后**挂上去的，不是建表时声明的。）
 *
 * **类型清单与服务端一致**（`shangshu_core/promotion_records.py` 的 `TYPE_MAP`）：
 * `text`／`long_text`／`number`／`date`／`boolean` —— **只这五档**
 * （`number` 落成 decimal；服务端**没有** `integer` 这一档，别多给）。
 * 多给一档 ⇒ 服务端当场拒「晋升列类型不受支持」。
 *
 * **规则与服务端同一口径**（不是前端自创的规矩）：
 * · `rules.min`／`rules.max` **只许给 `number` 列**（服务端 `_constraints`：
 *   「晋升列 %s 的数值上下限不适用于该类型」）；
 * · `rules.options` **给了就必须非空**（服务端 `_value_domain`：「值域清单必须是非空的列表」）；
 * · `rules.allow_custom` **不写＝不拦**（服务端 `_value_domain`：`allow` 没写就是 True）；
 *   写 `false` 才是硬拦 ⇒ 编辑器里「取消勾选」＝写 `false`，「勾着」＝**不写这个键**。
 */

export interface PromotionColumnType {
  value: string;
  label: string;
}

/** 能选的列类型（**与服务端 `TYPE_MAP` 一字不差**）。 */
export const PROMOTION_COLUMN_TYPES: PromotionColumnType[] = [
  {value: 'text', label: '文字'},
  {value: 'long_text', label: '长文字'},
  {value: 'number', label: '数字'},
  {value: 'date', label: '日期'},
  {value: 'boolean', label: '是／否'},
];

/** 一列的规则（**直接对应服务端 `rules` 那几个键**）。 */
export interface PromotionColumnRules {
  /** 数值下限（**只给数字列**）。 */
  min?: number;
  /** 数值上限（**只给数字列**）。 */
  max?: number;
  /** 取值清单（**给了就必须非空**）。 */
  options?: string[];
  /** 允许清单以外的值？**不写＝不拦**；写 `false` ＝ 硬拦。 */
  allow_custom?: boolean;
}

/** 一列的声明（**直接进 `files.promotion_define` 的 `definition.columns`**）。 */
export interface PromotionColumnRule {
  header: string;
  type: string;
  rules?: PromotionColumnRules;
}

export interface PromotionRulesEditor {
  element: HTMLElement;
  /** 读出当前的逐列声明。 */
  read(): PromotionColumnRule[];
}

/**
 * 拼一列的声明（**没填的键不写** —— 少写一个键，服务端就少一条约束）。
 * ⚠️ `allow_custom` **只在明确要硬拦时才写 `false`**（不写＝不拦，服务端口径）。
 */
export function promotionRuleFor(
  header: string,
  type: string,
  rules?: PromotionColumnRules | null,
): PromotionColumnRule {
  const out: PromotionColumnRule = {header: String(header || ''), type: String(type || 'text')};
  const picked: PromotionColumnRules = {};
  if (rules) {
    if (rules.min !== undefined && rules.min !== null && rules.min !== ('' as unknown as number)) {
      picked.min = Number(rules.min);
    }
    if (rules.max !== undefined && rules.max !== null && rules.max !== ('' as unknown as number)) {
      picked.max = Number(rules.max);
    }
    if (Array.isArray(rules.options) && rules.options.length) picked.options = rules.options.map(String);
    if (rules.allow_custom === false) picked.allow_custom = false;
  }
  if (Object.keys(picked).length) out.rules = picked;
  return out;
}

/**
 * 校验逐列声明（**与服务端同一口径**）。
 * ⚠️ **不替服务端加规矩**：服务端没查的（比大小之类）这里也不查 ——
 * 免得前端拒了服务端能收的东西。
 */
export function validatePromotionRules(rules: PromotionColumnRule[], headers: string[]): void {
  const known = new Set(PROMOTION_COLUMN_TYPES.map(item => item.value));
  const names = new Set((headers || []).map(String));
  for (const rule of rules || []) {
    const header = String(rule?.header || '');
    if (!names.has(header)) throw Error(`「${header}」不是这张表里的列`);
    const type = String(rule?.type || '');
    if (!known.has(type)) {
      throw Error(`「${header}」的类型不受支持（可选：${PROMOTION_COLUMN_TYPES.map(i => i.label).join('／')}）`);
    }
    const min = rule?.rules?.min;
    const max = rule?.rules?.max;
    if ((min !== undefined || max !== undefined) && type !== 'number') {
      throw Error(`「${header}」是${PROMOTION_COLUMN_TYPES.find(i => i.value === type)?.label || type}列，数值上下限只适用于数字列`);
    }
    if (min !== undefined && !Number.isFinite(Number(min))) {
      throw Error(`「${header}」的数值下限不是数字`);
    }
    if (max !== undefined && !Number.isFinite(Number(max))) {
      throw Error(`「${header}」的数值上限不是数字`);
    }
    if (rule?.rules?.options !== undefined) {
      if (!Array.isArray(rule.rules.options) || !rule.rules.options.length) {
        throw Error(`「${header}」的取值清单必须是非空的列表（要清单就别留空行）`);
      }
    }
  }
}

/** 把清单文本按行拆开（**空行不算项**）。 */
export function parseOptionsText(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * 建出**逐列的类型与规则**编辑器（每一列一块）。
 * ⚠️ **没动过的列按「文字」**（与改之前一致：不选类型 ⇒ 全列都是文字，**不替人挑**）。
 */
export function buildPromotionRulesEditor(doc: Document, headers: string[]): PromotionRulesEditor {
  const element = doc.createElement('div');
  element.className = 'promotion-rules';

  for (const header of (headers || []).map(String)) {
    const section = doc.createElement('fieldset');
    section.className = 'promotion-rule';
    section.dataset.column = header;

    const legend = doc.createElement('legend');
    legend.textContent = header;
    section.appendChild(legend);

    const typeRow = doc.createElement('label');
    typeRow.className = 'promotion-rule-type';
    typeRow.textContent = '这一列是什么类型';
    const typeSelect = doc.createElement('select');
    typeSelect.setAttribute('data-role', 'type');
    typeSelect.setAttribute('aria-label', `「${header}」这一列的类型`);
    for (const item of PROMOTION_COLUMN_TYPES) {
      const option = doc.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      typeSelect.appendChild(option);
    }
    typeSelect.value = 'text';
    typeRow.appendChild(typeSelect);
    section.appendChild(typeRow);

    const numberRow = doc.createElement('div');
    numberRow.className = 'promotion-rule-number';
    numberRow.hidden = true;
    const minLabel = doc.createElement('label');
    minLabel.textContent = '下限';
    const minInput = doc.createElement('input');
    minInput.type = 'number';
    minInput.setAttribute('data-role', 'min');
    minInput.setAttribute('aria-label', `「${header}」的数值下限`);
    const maxLabel = doc.createElement('label');
    maxLabel.textContent = '上限';
    const maxInput = doc.createElement('input');
    maxInput.type = 'number';
    maxInput.setAttribute('data-role', 'max');
    maxInput.setAttribute('aria-label', `「${header}」的数值上限`);
    minLabel.appendChild(minInput);
    maxLabel.appendChild(maxInput);
    numberRow.append(minLabel, maxLabel);
    section.appendChild(numberRow);

    const optionsRow = doc.createElement('div');
    optionsRow.className = 'promotion-rule-options';
    const optionsLabel = doc.createElement('label');
    optionsLabel.textContent = '取值清单（一行一个，留空＝这一列没有清单）';
    const optionsInput = doc.createElement('textarea');
    optionsInput.rows = 3;
    optionsInput.setAttribute('data-role', 'options');
    optionsInput.setAttribute('aria-label', `「${header}」的取值清单`);
    optionsLabel.appendChild(optionsInput);
    const customLabel = doc.createElement('label');
    customLabel.className = 'promotion-rule-custom';
    const customBox = doc.createElement('input');
    customBox.type = 'checkbox';
    customBox.checked = true;             // 勾着＝不拦（服务端「没写＝不拦」）
    customBox.setAttribute('data-role', 'allow-custom');
    customBox.setAttribute('aria-label', `「${header}」允许填写清单以外的值`);
    customLabel.append(customBox, doc.createTextNode('允许填写清单以外的值（不勾＝只能选清单里的）'));
    optionsRow.append(optionsLabel, customLabel);
    section.appendChild(optionsRow);

    const syncNumberRow = () => {
      numberRow.hidden = typeSelect.value !== 'number';
    };
    typeSelect.addEventListener('change', syncNumberRow);
    syncNumberRow();

    element.appendChild(section);
  }

  return {
    element,
    read(): PromotionColumnRule[] {
      const out: PromotionColumnRule[] = [];
      for (const section of element.querySelectorAll<HTMLElement>('fieldset[data-column]')) {
        const header = section.dataset.column ?? '';
        const type = section.querySelector<HTMLSelectElement>('select[data-role="type"]')?.value || 'text';
        const minRaw = section.querySelector<HTMLInputElement>('input[data-role="min"]')?.value ?? '';
        const maxRaw = section.querySelector<HTMLInputElement>('input[data-role="max"]')?.value ?? '';
        const optionsText = section.querySelector<HTMLTextAreaElement>('textarea[data-role="options"]')?.value ?? '';
        const customBox = section.querySelector<HTMLInputElement>('input[data-role="allow-custom"]');
        const options = parseOptionsText(optionsText);
        out.push(promotionRuleFor(header, type, {
          /* 上下限**只看类型**（不看那一行显没显示）——
             那一行只是给人看的；**类型是数字**才读上下限（别的类型读了服务端也会拒）。 */
          ...(type === 'number'
            ? {min: minRaw === '' ? undefined : Number(minRaw), max: maxRaw === '' ? undefined : Number(maxRaw)}
            : {}),
          ...(options.length ? {options} : {}),
          // **没勾＝硬拦**（写 false）；勾着＝**不写这个键**（＝不拦）。
          ...(customBox && !customBox.checked ? {allow_custom: false} : {}),
        }));
      }
      return out;
    },
  };
}
