import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {menuItemsFor, COLUMN_FIELD_PERMISSIONS_ITEM} from '../src/structure-menu.ts';
import {editFieldPermissions, editTablePermissions} from '../src/field-permissions.ts';

/**
 * 两个**新入口**（PKG-117-T01，用户 2026-10-25 23:1x 原话：
 * 「要在表工具栏增加一个设置按钮用于设置整个表的权限（读／写／筛／下载；全局、部门、个人），
 * 并且对于已经晋升的列，右键增加一个设置选项用于设置权限」）。
 *
 * ⚠️ 2026-10-26 用户拍定：**「助手」那一档整个去掉** ⇒ 面板上是**四行**。
 *
 * **测试通过 = 下面全部成立**：
 *  1. **工具栏**的「表格」下拉里有「表权限」这一项（`data-table-permissions`），
 *     点开渲染的是**表级面板**（三行：读／写／下载）；
 *  2. **列头右键**有「字段权限」这一项，**且只对已晋升的列出现**；
 *  3. 右键进来的面板**只开那一列**（不是全部列）。
 *  4. 后端回来的声明里**还带着旧的 `assistant`／`filter`** ⇒ 面板照样开得起来、
 *     仍是那三行、界面上**没有「助手」「筛」**（那两档没了，不是未知操作）。
 */

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

it('工具栏：「表格」下拉里有「表权限」这一项（表级权限入口）', () => {
  const structureMenu = main.slice(main.indexOf('data-structure-menu'), main.indexOf('data-structure-menu') + 1200);
  assert.match(structureMenu, /data-field-permissions/, '「字段权限」不在「表格」下拉里');
  assert.match(structureMenu, /data-table-permissions/, '「表权限」不在「表格」下拉里');
  assert.match(main, /data-table-permissions[^\n]*表权限/, '「表权限」这一项没有说人话的标题');
});

it('表级面板：点开渲染的是三行（读／写／下载）', async () => {
  const dom = new JSDOM('<div></div>');
  const ui = {
    dialog(o: any) {
      const box = dom.window.document.createElement('section');
      box.innerHTML = o.body;
      for (const action of o.actions) {
        const button = dom.window.document.createElement('button');
        button.textContent = action.label;
        button.onclick = action.onClick;
        box.append(button);
      }
      dom.window.document.body.append(box);
      return box;
    },
    closeModal() { return true; },
    guardModal() {},
  };
  const fetcher = (async () =>
    Response.json({
      result: {
        table: 't', definition_version: 1, structure_version: 4, definition_sha: 'v1',
        can_manage_field_permissions: true,
        access: { read: { scope: 'global' }, write: { scope: 'global' }, download: { scope: 'global' } },
        columns: [],
      },
    })) as any;
  const dialog = (await editTablePermissions(ui as any, 't', { fetcher }))!;
  assert.deepEqual(
    Array.from(dialog.querySelectorAll('.access-row')).map(row => row.getAttribute('data-operation')),
    ['read', 'write', 'download'],
    '表级面板不是那三行',
  );
  assert.equal(dialog.textContent?.includes('助手'), false, '表级面板上还有「助手」那一档');
  assert.equal(dialog.textContent?.includes('筛'), false, '表级面板上还有「筛」那一档');
  dom.window.close();
});

it('后端回来的声明还带着旧的「助手」「筛」 ⇒ 面板照样开、仍是三行、界面上没有那两档', async () => {
  const dom = new JSDOM('<div></div>');
  const ui = {
    dialog(o: any) {
      const box = dom.window.document.createElement('section');
      box.innerHTML = o.body;
      dom.window.document.body.append(box);
      return box;
    },
    closeModal() { return true; },
    guardModal() {},
  };
  const fetcher = (async () =>
    Response.json({
      result: {
        table: 't', definition_version: 1, structure_version: 4, definition_sha: 'v1',
        can_manage_field_permissions: true,
        access: {
          read: { scope: 'global' },
          write: { scope: 'global' },
          download: { scope: 'global' },
          assistant: { scope: 'none' },
          filter: { scope: 'none' },
        },
        columns: [
          { header: '金额', promoted: true, access: { read: { scope: 'global' }, assistant: { scope: 'none' } } },
        ],
      },
    })) as any;
  const dialog = (await editTablePermissions(ui as any, 't', { fetcher }))!;
  assert.deepEqual(
    Array.from(dialog.querySelectorAll('.access-row')).map(row => row.getAttribute('data-operation')),
    ['read', 'write', 'download'],
    '旧声明里带着「助手」「筛」时，表级面板不是那三行',
  );
  assert.equal(dialog.textContent?.includes('助手'), false, '旧声明里带着「助手」那一档时，界面上还看得见「助手」');
  dom.window.close();
});

it('列头右键：「字段权限」只对已晋升的列出现；没权限或没晋升列就不出现', () => {
  const withItem = menuItemsFor('column-header', { canManageFieldPermissions: true, columnPromoted: true });
  assert.ok(withItem.some(item => item.id === COLUMN_FIELD_PERMISSIONS_ITEM), '已晋升列的右键菜单里没有「字段权限」');
  assert.ok(withItem.some(item => item.label === '字段权限'), '没有说人话的标题');
  const notPromoted = menuItemsFor('column-header', { canManageFieldPermissions: true, columnPromoted: false });
  assert.equal(notPromoted.some(item => item.id === COLUMN_FIELD_PERMISSIONS_ITEM), false, '未晋升的列也出了「字段权限」');
  const noRight = menuItemsFor('column-header', { canManageFieldPermissions: false, columnPromoted: true });
  assert.equal(noRight.some(item => item.id === COLUMN_FIELD_PERMISSIONS_ITEM), false, '没有管理权也出了「字段权限」');
  // 行号／数据格不出现这一项。
  assert.equal(menuItemsFor('row-header', { canManageFieldPermissions: true, columnPromoted: true }).some(item => item.id === COLUMN_FIELD_PERMISSIONS_ITEM), false);
  assert.equal(menuItemsFor('cell', { canManageFieldPermissions: true, columnPromoted: true }).some(item => item.id === COLUMN_FIELD_PERMISSIONS_ITEM), false);
});

it('右键进来的面板只开那一列（不是全部已晋升列）', async () => {
  const dom = new JSDOM('<div></div>');
  const ui = {
    dialog(o: any) {
      const box = dom.window.document.createElement('section');
      box.innerHTML = o.body;
      dom.window.document.body.append(box);
      return box;
    },
    closeModal() { return true; },
    guardModal() {},
  };
  const fetcher = (async () =>
    Response.json({
      result: {
        table: 't', definition_version: 1, structure_version: 4, definition_sha: 'v1',
        can_manage_field_permissions: true,
        columns: [
          { header: '金额', promoted: true, access: { read: { scope: 'global' } } },
          { header: '备注', promoted: true, access: { read: { scope: 'global' } } },
        ],
      },
    })) as any;
  const dialog = (await editFieldPermissions(ui as any, 't', { column: '金额', fetcher }))!;
  const legends = Array.from(dialog.querySelectorAll('legend')).map(legend => legend.textContent);
  assert.deepEqual(legends, ['金额'], '右键进来的面板开了不止一列');
  dom.window.close();
});
