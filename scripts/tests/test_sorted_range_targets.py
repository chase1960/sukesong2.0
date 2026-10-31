"""Sorted range expansion maps existing IDs and new visual tail before any mutation."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

class Invalid(Exception): pass
def reject(message, kind): raise kind(message)
p=Path(__file__).resolve().parents[2]/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
node=next(n for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_mapped_range_rows')
ctx={'frappe':SimpleNamespace(throw=reject,ValidationError=Invalid)}
exec(compile(ast.Module(body=[node],type_ignores=[]),str(p),'exec'),ctx)
resolve=ctx['_mapped_range_rows']
class Targets(unittest.TestCase):
 def test_sorted_existing_and_new_tail(self):
  self.assertEqual(resolve(['a','b','c'],2,3,['a',None,None]),[0,3,4])
 def test_empty_tail_gap(self):
  self.assertEqual(resolve(['a','b'],4,1,[None]),[4])
 def test_normal_coordinates_unchanged(self):
  self.assertEqual(resolve(['a','b'],1,3,None),[1,2,3])
 def test_missing_duplicate_or_stale_ids_reject(self):
  # ⚠️ 2026-10-29 契约变化：`(0,[None])` **不再拒** ——
  # 「写进一个没有固定行身份的空白行」现在**给它建一个新身份**（落末尾），见下面的用例。
  for start,ids in [(0,['gone']),(0,['a','a']),(2,['a'])]:
   with self.subTest(ids=ids),self.assertRaises(Invalid):resolve(['a','b'],start,len(ids),ids)
 def test_blank_row_without_identity_gets_a_new_row_at_the_tail(self):
  # 网格里的空白行（没有固定行身份）写进去 ⇒ 不再报「已有行缺少固定行身份，本次未保存」，
  # 而是给它建一个新身份，落在**末尾的空位**（表里已有的行不挪位）。
  self.assertEqual(resolve(['a','b'],0,1,[None]),[2])
  self.assertEqual(resolve(['a','b','c'],1,2,[None,None]),[3,4])
  self.assertEqual(resolve(['a','b','c'],0,2,['a',None]),[0,3])
 def test_blank_row_followed_by_an_existing_row_is_rejected(self):
  # 新建的行落在末尾 ⇒ 它后面再出现「已有行」就是顺序错了（要重新排序）。
  with self.assertRaises(Invalid):resolve(['a','b','c'],1,2,[None,'c'])
 def test_filtered_append_uses_physical_tail(self):
  self.assertEqual(resolve(['a','b','c','d'],0,3,['c',None,None],True),[2,4,5])
 def test_filtered_append_rejects_missing_map_and_interleaved_existing(self):
  for ids in [None,[None,'a']]:
   with self.assertRaises(Invalid):resolve(['a','b'],0,2,ids,True)
 def test_shape_rejects(self):
  for ids in [[],['a','b'],'a']:
   with self.assertRaises(Invalid):resolve(['a','b'],0,1,ids)
if __name__=='__main__':unittest.main()
