import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/*
  PKG-016（用户 2026-10-21：「**不要用重叠弹窗，直接摊出来**」）：
  公共件 resource-attribution.mjs 改成**只剩摊开一种形态**之后，域这边要跟上：

  测试通过 = 下面全部成立：
  1. **域里两处调用点**（Excel 清单页 directory.ts、邮箱设置 mail-settings.js）
     都不再传那个已经删掉的 `inline` 开关 —— 那个键现在没人读了，留着就是半截壳；
  2. **域产物 excel-univer-entry.js 是重编过的** —— 里面是摊开式的代码，
     没有旧代码（改了公共件不重编 ⇒ 产物里留着旧的叠窗 ⇒ 线上还是叠窗）；
  3. **域目录的样式**里也没有那个「点开才展开的入口」的样式类了。
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

it('域里两处调用点都不再传那个已经删掉的 inline 开关', () => {
  const places = {
    'Excel 清单页新建/上传': 'shangshu-web/js/domains/excel-univer/src/directory.ts',
    '邮箱设置归属': 'shangshu-web/js/domains/mail/mail-settings.js',
  };
  for (const [name, file] of Object.entries(places)) {
    const source = read(file);
    assert.doesNotMatch(source, /\binline\s*:\s*(?:true|false)/,
      `${name} 还在传 inline 开关 —— 公共件已经没有这个参数了，留着是半截壳`);
  }
});

it('Excel 域产物是重编过的：里面是摊开式，没有旧代码', () => {
  /* excel-univer-entry.js 是**产物**（域里 directory.ts 把公共组件打了进去）。
     改了公共组件不重编 ⇒ 产物里留着旧代码 ⇒ 线上还是叠窗。 */
  const artifact = read('shangshu-web/js/domains/excel-univer/excel-univer-entry.js');
  assert.match(artifact, /data-attribution-tab/, '产物里连摊开式的选项卡都没有 —— 产物没重编');
  assert.match(artifact, /attribution-picker-inline/, '产物里没有摊开式的标记 —— 产物没重编');
  assert.doesNotMatch(artifact, /data-attribution-trigger/, '产物里还留着叠窗入口 —— 产物没重编');
  assert.doesNotMatch(artifact, /attribution-picker-trigger/, '产物里还留着叠窗入口的样式类 —— 产物没重编');
  assert.doesNotMatch(artifact, /openPicker/, '产物里还留着叠窗入口的函数 —— 产物没重编');
});

it('域目录的样式里没有那个「点开才展开的入口」的样式类', () => {
  const css = read('shangshu-web/css/domains/excel-univer/excel-univer.css');
  assert.doesNotMatch(css, /\.attribution-picker-trigger/,
    '域样式里还留着叠窗入口的样式类 —— 那个按钮已经不存在了，留着是半截壳');
});
