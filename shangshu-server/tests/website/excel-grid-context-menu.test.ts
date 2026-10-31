// Native menus stay disabled; managed sort/filter/structure use their own guarded UI.
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { JSDOM } = await import('jsdom');
const { readFileSync } = await import('node:fs');
const { runInNewContext } = await import('node:vm');
const ts = (await import('typescript')).default;

// 只取 createGrid 交给 Univer 的配置对象；不驱动画布、不测样式。
import {createRequire} from 'node:module';
import {fontStyleToUniver} from '../../../shangshu-web/js/domains/excel-univer/src/font-style.ts';
import {mountEditAnchor} from '../../../shangshu-web/js/domains/excel-univer/src/edit-anchor.ts';
const engineRequire=createRequire(new URL('../../../shangshu-web/js/domains/excel-univer/package.json',import.meta.url));
const {CellValueType,Plugin,Injector,Inject,UniverInstanceType,VerticalAlign}=engineRequire('@univerjs/core');

function gridConfig() {
  const dom = new JSDOM('<div id="grid"></div>');
  const host = dom.window.document.querySelector('#grid') as HTMLElement;
  let config: any;
  const ws = {
    getRange: () => ({
      setValues: () => {}, getDisplayValue: () => undefined, setWrapStrategy: () => {},
      activateAsCurrentCell: () => {},
    }),
    getSelection: () => null,
    scrollToCell: () => {},
    customizeColumnHeader: () => {},
    setRowAutoHeight: () => {},
    setRowHeightsForced: () => {},
    getColumnWidth: () => 100,
    getRowHeight: () => 24,
    getVisibleRange: () => ({ startRow: 0, endRow: 9 }),
    getSheet: () => ({ getSnapshot: () => ({ rowData: {} }) }),
  };
  const exports: any = {};
  const src = readFileSync(
    new URL('../../../shangshu-web/js/domains/excel-univer/src/sheet.ts', import.meta.url),
    'utf8',
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  runInNewContext(js, {
    exports,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    defaultTheme: { primary: { 500: '#2563eb' }, green: { 500: '#16a34a' } },
    merge: (...parts: any[]) => Object.assign({}, ...parts),
    LocaleType: { ZH_CN: 'zhCN' },
    VerticalAlign,CellValueType,Plugin,Injector,Inject,UniverInstanceType,fontStyleToUniver,mountEditAnchor,
    sheetsCoreZhCN: {},
    univerDesignCss: '',
    univerUiCss: '',
    univerSheetsUiCss: '',
    univerSheetsCoreCss: '',
    // 预设原样返回：被测的就是 createGrid 传出去的配置，不能在夹具里替它补默认值。
    UniverSheetsCorePreset: (options: any) => options,
    createUniver: (options: any) => {
      config = options;
      return {
        univer: { createUnit: () => {}, dispose: () => {} },
        univerAPI: {
          Enum: { UniverInstanceType: { UNIVER_SHEET: 2 } },
          Event: {},
          addEvent: () => ({ dispose: () => {} }),
          getWorkbook: () => ({ getSheetBySheetId: () => ws }),
        },
      };
    },
  });
  exports.createGrid(host, [{ fieldId: 'a', label: 'A', type: 'text', readOnly: false }], 10);
  return { config, dom };
}

// 测试通过 = 表内右键不出现排序/筛选命令，且列头菜单与工具栏也都不存在（UI-011）。
test('UI-011 native sort/filter menus remain disabled independently of managed toolbar', () => {
  const { config, dom } = gridConfig();
  try {
    assert.equal(
      config.presets[0].contextMenu,
      false,
      '未接受管保存的原生右键命令（含排序/筛选）不能冒充可用功能',
    );
    assert.equal(config.presets[0].header, false, '不渲染原生列头菜单（排序/筛选入口之一）');
    assert.equal(config.presets[0].toolbar, false, '不渲染原生工具栏（排序/筛选命令入口）');
  } finally { dom.window.close(); }
});

// 测试通过 = 文本编号（FORCE_STRING）不会被弹「转成数字」的警告/角标（前导零保护）。
// 这两条不在 UI-011/030 名下，但和 contextMenu 同属 8523d76f 搬丢、2026-10-18 主控批准恢复的保护，
// 原来只在大用例 75-78 行断言，被前面的视觉红挡住看不见。
test('文本编号不弹转换警告：disableForceStringAlert/Mark 在位', () => {
  const { config, dom } = gridConfig();
  try {
    assert.equal(config.presets[0].sheets?.disableForceStringAlert, true, '文本编号不是错误，不能出现转换数值警告浮块');
    assert.equal(config.presets[0].sheets?.disableForceStringMark, true);
  } finally { dom.window.close(); }
});

// 测试通过 = 表内右键不出现插入/移动/删除行列等结构命令，也没有别的预设另开右键菜单（UI-030）。
test('UI-030 native structural menu commands remain disabled', () => {
  const { config, dom } = gridConfig();
  try {
    assert.equal(
      config.presets[0].contextMenu,
      false,
      '表内右键不提供插入/移动/删除行列等结构命令；'
      + 'managed structure actions use guarded application controls',
    );
    // 配置里也不能另外注册一份受管右键菜单冒充入口（逐个预设查，不只查第 0 个）。
    const presets = Array.isArray(config.presets) ? config.presets : [config.presets];
    assert.ok(
      presets.every((preset: any) => !preset?.contextMenu),
      '没有任何预设注册原生右键菜单',
    );
  } finally { dom.window.close(); }
});
