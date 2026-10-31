"""动作登记与处理器对得上。

测试通过 = 什么成立：
- 域里注册的每个动作**都有处理器**（注册了没处理器 = 运行时才炸）；
- 处理器指向的函数**真的存在**（改了名/漏写函数当场发现，不等用户点）；
- 第四批三个成包编辑动作都在册，且处理器指向 sheet 里的同名函数。
"""
import unittest

from shangshu_files import domain, service


class TestActionRegistry(unittest.TestCase):
    # `service.execute` 里**单独分支**处理的动作（不进 SHEET_ACTIONS / HANDLERS 映射）。
    # 加了新的内联动作要同步往这里补 —— 下面的判据靠它兜住「注册了没落点」。
    INLINE_ACTIONS = {
        'files.table_relation_define', 'files.table_relation_set', 'files.table_relation_remove',
        'files.sheet_structure_undo', 'files.sheet_view_save', 'files.review',
    }

    def _registered_ids(self):
        ids = []
        for action in domain.ACTIONS:
            ids.append(action[0] if isinstance(action, (tuple, list)) else action.get('id'))
        return [item for item in ids if item]

    def test_every_registered_action_has_a_handler(self):
        missing = [action_id for action_id in self._registered_ids()
                   if action_id not in service.SHEET_ACTIONS
                   and action_id not in service.HANDLERS
                   and action_id not in service.CTX_HANDLERS
                   and action_id not in self.INLINE_ACTIONS]
        self.assertEqual(missing, [], '这些动作注册了却没有落点：%s' % '、'.join(missing))

    def test_inline_actions_are_still_registered(self):
        registered = set(self._registered_ids())
        stale = sorted(self.INLINE_ACTIONS - registered)
        self.assertEqual(stale, [], '内联分支里的动作没在域里登记了：%s' % '、'.join(stale))

    def test_sheet_handlers_point_at_real_functions(self):
        from shangshu_files import sheet
        broken = ['%s→%s' % (action_id, function_name)
                  for action_id, function_name in service.SHEET_ACTIONS.items()
                  if not hasattr(sheet, function_name)]
        self.assertEqual(broken, [], '这些处理器指向的函数不存在：%s' % '、'.join(broken))

    def test_bulk_edit_actions_are_registered(self):
        ids = self._registered_ids()
        for action_id in ('files.sheet_find_replace', 'files.sheet_fill_series',
                          'files.sheet_paste_special'):
            self.assertIn(action_id, ids, '%s 没有登记在域里' % action_id)
            self.assertIn(action_id, service.SHEET_ACTIONS, '%s 没有处理器' % action_id)
