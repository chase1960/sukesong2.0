"""显式日志投影迁移：幂等、定义漂移拒绝；真实表达式另在 MariaDB 原生测试执行。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import load_module_functions

SOURCE = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_core/shangshu_core/log_query_storage.py'


class MigrationDB:
    def __init__(self):
        self.current = 'CREATE TABLE `tabShangshu Unified Log` (\n`detail_json` longtext\n)'
        self.expected = ''
        self.indexes = []
        self.alters = []
        self.definitions = {}
        self.index_definitions = {}

    def sql(self, query, *args, **kwargs):
        if query == 'SELECT VERSION()':
            return [('10.11.19-MariaDB',)]
        if query.startswith('CREATE TEMPORARY TABLE'):
            self.expected = 'CREATE TABLE `temporary` (\n' + ',\n'.join(
                '`' + name + '` ' + value for name, value in self.definitions.items()) + '\n)'
        if query.startswith('SHOW CREATE TABLE'):
            return [('table', self.expected if '__shangshu_log_query_shape_v1' in query else self.current)]
        if query.startswith('SHOW INDEX'):
            return self.indexes
        return []

    def sql_ddl(self, query):
        self.alters.append(query)
        self.current = self.expected
        self.indexes = [dict(Key_name=name, Seq_in_index=i+1, Column_name=column, Sub_part=None,
                             Non_unique=1, Index_type='BTREE', Collation='A', Ignored='NO')
                        for name, columns in self.index_definitions.items() for i, column in enumerate(columns)]


class LogQueryStorage(unittest.TestCase):
    def setUp(self):
        self.db = MigrationDB()
        self.ctx = load_module_functions(SOURCE, {'ensure_log_query_storage'},
                                         stubs={'frappe': SimpleNamespace(db=self.db)})
        self.db.definitions = self.ctx['column_definitions']()
        self.db.index_definitions = self.ctx['INDEXES']

    def migrate(self):
        return self.ctx['ensure_log_query_storage']()

    def test_fresh_migration_one_alter_then_idempotent(self):
        self.assertEqual(self.migrate(), {'version': 1, 'added': 10})
        self.assertEqual(len(self.db.alters), 1)
        self.assertEqual(self.migrate(), {'version': 1, 'added': 0})
        self.assertEqual(len(self.db.alters), 1)
        self.assertNotIn('UPDATE ', self.db.alters[0])

    def test_changed_existing_expression_fails_before_any_alter(self):
        self.migrate()
        self.db.current = self.db.current.replace('CAST(', 'BROKEN_CAST(', 1)
        self.db.alters.clear()
        with self.assertRaisesRegex(RuntimeError, '定义与 v1 不符'):
            self.migrate()
        self.assertEqual(self.db.alters, [])

    def test_changed_index_column_order_or_prefix_rejects(self):
        self.migrate()
        for key, value in [('Column_name', 'actor_user'), ('Sub_part', 10), ('Ignored', 'YES')]:
            with self.subTest(key=key):
                old = self.db.indexes[0][key]
                self.db.indexes[0][key] = value
                self.db.alters.clear()
                with self.assertRaisesRegex(RuntimeError, '索引.*定义与 v1 不符'):
                    self.migrate()
                self.assertEqual(self.db.alters, [])
                self.db.indexes[0][key] = old

    def test_partial_schema_only_adds_missing_index(self):
        self.migrate()
        self.db.indexes = [row for row in self.db.indexes if row['Key_name'] != 'ssq_process_v1']
        self.db.alters.clear()
        self.assertEqual(self.migrate(), {'version': 1, 'added': 1})
        self.assertEqual(self.db.alters, ['ALTER TABLE `tabShangshu Unified Log` ADD INDEX `ssq_process_v1` '
            '(`business_object_id`, `what_kind`, `actor_identity`, `business_name`)'])


if __name__ == '__main__':
    unittest.main()
