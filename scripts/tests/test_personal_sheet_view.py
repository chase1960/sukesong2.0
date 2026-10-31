import importlib.util,sys,types,unittest
from pathlib import Path
root=Path(__file__).resolve().parents[2]
frappe=types.ModuleType('frappe');frappe.PermissionError=PermissionError
frappe.throw=lambda message,kind: (_ for _ in ()).throw(kind(message))
frappe.session=types.SimpleNamespace(user='one')
sheet=types.ModuleType('shangshu_files.sheet');sheet.value_typed=lambda value:{'value':value}
pkg=types.ModuleType('shangshu_files');pkg.sheet=sheet;pkg.promotion=types.SimpleNamespace()
sys.modules.update({'frappe':frappe,'shangshu_files':pkg,'shangshu_files.sheet':sheet})
spec=importlib.util.spec_from_file_location('view',root/'frappe_apps/shangshu_files/shangshu_files/sheet_view.py');view=importlib.util.module_from_spec(spec);spec.loader.exec_module(view)
class ViewTests(unittest.TestCase):
 def test_user_resource_key(self):
  a=view._key('a');frappe.session.user='two';self.assertNotEqual(a,view._key('a'));self.assertNotEqual(view._key('a'),view._key('b'))
 def test_hidden_column_rejects_not_filters_in_browser(self):
  with self.assertRaises(PermissionError):view.validate_view({'filters':[{'column':'secret','operator':'contains','value':'x'}],'freeze':{'rows':0,'columns':0}},['secret'],{'secret'})
 def test_invalid_old_header(self):
  with self.assertRaises(ValueError):view.validate_view({'filters':[{'column':'old','operator':'equals','value':'x'}],'freeze':{'rows':0,'columns':0}},['new'],set())
 def test_projection_stable_id_physical_unchanged(self):
  entry={'headers':['name','amount'],'rows_raw':[['yes',3],['no',9],['yes',1],['no',0]]};config={'filters':[{'column':'name','operator':'equals','value':'yes'}],'freeze':{'rows':1,'columns':1},'sort':{'column':'amount','direction':'asc'}}
  rows=view.project_rows(entry,['r1','r2','r3','r4'],config);self.assertEqual(rows,[{'row_id':'r3','row_index':4},{'row_id':'r1','row_index':2}]);self.assertEqual(entry['rows_raw'][1],['no',9])
 def test_zero_and_empty_distinct(self):
  rows=view.project_rows({'headers':['v'],'rows_raw':[[0],[''],[None]]},['zero','blank','null'],{'filters':[{'column':'v','operator':'empty','value':''}]});self.assertEqual([r['row_id'] for r in rows],['blank','null'])
class ColumnOrderTests(unittest.TestCase):
 """个人视图的**列序**（2026-10-29 用户口径：视图里能定「按这个顺序显示」）。

 测试通过 = 什么成立：
 · 列序写进去**读回来还在**，顺序一字不变；
 · 表里没有的列名**当场拒**（不静默丢掉）；
 · 同一列写两遍**拒**（顺序里有重复，含义不清）；
 · 读不着的列**拒**（与筛选／排序同一道权限闸）；
 · 老视图（没有列序这个键）**照旧合法** —— 不因为新字段被判死。
 """
 BASE={'filters':[],'freeze':{'rows':0,'columns':0}}
 def test_column_order_is_kept_as_written(self):
  result=view.validate_view({**self.BASE,'columns':['amount','name']},['name','amount','note'],set())
  self.assertEqual(result['columns'],['amount','name'])
 def test_unknown_column_in_the_order_is_rejected(self):
  with self.assertRaises(ValueError):view.validate_view({**self.BASE,'columns':['name','nope']},['name','amount'],set())
 def test_duplicated_column_in_the_order_is_rejected(self):
  with self.assertRaises(ValueError):view.validate_view({**self.BASE,'columns':['name','name']},['name','amount'],set())
 def test_unreadable_column_in_the_order_is_rejected(self):
  with self.assertRaises(PermissionError):view.validate_view({**self.BASE,'columns':['secret']},['secret','name'],{'secret'})
 def test_old_view_without_column_order_still_validates(self):
  result=view.validate_view(dict(self.BASE),['name','amount'],set())
  self.assertNotIn('columns',result,'老视图原样保留（不硬塞一个空数组）')
 def test_effective_order_puts_the_listed_columns_first(self):
  # 列序里点名的列按那个顺序排前面；没点名的列按表里的原顺序接在后面
  # （后来新加的列不会因为老视图没登记就消失）。
  self.assertEqual(view._column_order({'columns':['amount','name']},['name','amount','note']),['amount','name','note'])
  self.assertEqual(view._column_order({'columns':[]},['name','amount']),['name','amount'])
if __name__=='__main__':unittest.main()
