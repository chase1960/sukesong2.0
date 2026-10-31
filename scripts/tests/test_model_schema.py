import copy
import importlib.util
import sys
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
# `model_schema.py` 现在会 `from shangshu_core import subject_access`（PKG-117-T01 的**纯规则层**：
# 不碰 frappe、不 import 内核其它模块）⇒ 真包要能 import ⇒ 把**内核 app 根**装进 sys.path。
# （`shangshu_core/__init__.py` 里只有版本号，import 它不牵出 frappe。）
CORE=ROOT/'frappe_apps/shangshu_core'
if str(CORE) not in sys.path:sys.path.insert(0,str(CORE))
path=ROOT/'frappe_apps/shangshu_core/shangshu_core/model_schema.py'
spec=importlib.util.spec_from_file_location("model_schema",path)
model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)


class ModelSchemaTests(unittest.TestCase):
    def setUp(self):
        self.owner="com.shangshu.app."+"a"*32
        self.object_id=self.owner+".object."+"b"*32
        self.definition={"schema_version":1,"title":"采购申请","fields":[{"id":"title","label":"申请事项","type":"text"}]}

    def compile(self, definition=None, references=None):
        return model.compile_object(self.owner,self.object_id,definition or self.definition,references)

    def test_labels_do_not_rename_physical_fields(self):
        original=self.compile();self.definition["title"]="采购单";self.definition["fields"][0]["label"]="事项名称"
        updated=self.compile()
        self.assertEqual(original["doctype"]["name"],updated["doctype"]["name"])
        self.assertEqual(original["doctype"]["fields"][0]["fieldname"],updated["doctype"]["fields"][0]["fieldname"])
        self.assertFalse(model.plan_object_change(original,updated)["ddl_required"])

    def test_no_physical_name_or_arbitrary_type(self):
        for patch in ({"fieldname":"password"},{"type":"HTML"},{"id":"name; DROP TABLE"},{"id":"name"},{"id":"modified"},{"required":"false"}):
            candidate=copy.deepcopy(self.definition);candidate["fields"][0].update(patch)
            with self.subTest(patch=patch),self.assertRaises(model.ModelError):self.compile(candidate)

    def test_owner_cannot_be_overridden(self):
        with self.assertRaises(model.ModelError):model.compile_object(self.owner,"finance.invoice",self.definition)
        bad=dict(self.definition,owner="finance")
        with self.assertRaises(model.ModelError):self.compile(bad)

    def test_reference_and_detail_targets_must_be_registered(self):
        target=self.owner+".object."+"c"*32
        self.definition["fields"]=[{"id":"lines","label":"采购明细","type":"detail","target":target}]
        with self.assertRaises(model.ModelError):self.compile()
        result=self.compile(references={target:{"doctype":model.physical_name(target),"kind":"detail"}})
        self.assertEqual(result["doctype"]["fields"][0]["fieldtype"],"Table")
        self.definition["kind"]="detail"
        with self.assertRaises(model.ModelError):self.compile(references={target:{"doctype":"trusted","kind":"detail"}})

    def test_dangerous_changes_are_not_safe_migrations(self):
        before=self.compile()
        self.definition["fields"].append({"id":"amount","label":"金额","type":"decimal","required":True})
        after=self.compile();plan=model.plan_object_change(before,after)
        self.assertTrue(plan["ddl_required"]);self.assertEqual(plan["needs_data_check"][0]["reason"],"backfill_required")
        self.assertEqual(model.plan_object_change(after,before)["blocked"][0]["reason"],"field_removal_requires_deprecation")
        self.definition["fields"][0]["type"]="integer"
        self.assertTrue(model.plan_object_change(before,self.compile())["blocked"])

    def test_choice_narrowing_requires_record_check(self):
        self.definition["fields"]=[{"id":"status","label":"状态","type":"choice","options":["申请","完成"]}]
        before=self.compile();self.definition["fields"][0]["options"]=["完成"]
        self.assertEqual(model.plan_object_change(before,self.compile())["needs_data_check"][0]["reason"],"removed_options_in_use")

    def test_constraints_have_one_input_projection(self):
        self.definition["fields"] = [{"id":"amount", "label":"金额", "type":"decimal",
                                      "required":True, "constraints":{"minimum":0, "maximum":5000}}]
        before = self.compile()
        schema = model.record_schema(before)
        self.assertEqual(schema["properties"]["amount"],
                         {"type":"number", "title":"金额", "minimum":0, "maximum":5000})
        self.assertEqual(schema["required"], ["amount"])
        self.definition["fields"][0]["constraints"]["maximum"] = 4000
        self.assertEqual(model.plan_object_change(before,self.compile())["needs_data_check"],
                         [{"field":"amount", "reason":"existing_values_constraints"}])

    def test_bad_constraints_rejected_at_definition_time(self):
        for rules in ({"minimum":1}, {"maxLength":-1}, {"minLength":5,"maxLength":2},
                      {"maxLength":True}, {"maxLength":float("inf")}):
            self.definition["fields"][0]["constraints"] = rules
            with self.subTest(rules=rules), self.assertRaises(model.ModelError):
                self.compile()

    def test_detail_schema_requires_target_definition(self):
        child = self.compile()
        child["kind"] = "detail"
        parent = {"fields":[{"id":"lines", "label":"明细", "type":"detail", "target":child["id"],
                             "required":True, "deprecated":False}]}
        with self.assertRaises(model.ModelError): model.record_schema(parent)
        schema = model.record_schema(parent, {child["id"]:child})
        self.assertEqual(schema["properties"]["lines"]["items"]["properties"]["title"]["type"], "string")


    def test_download_policy_is_preserved_without_granting_legacy_fields(self):
        original=self.compile()
        self.assertNotIn('download_roles',original['fields'][0])
        self.definition['fields'][0]['download_roles']=['Desk User']
        granted=self.compile();self.assertEqual(granted['fields'][0]['download_roles'],['Desk User'])
        self.assertFalse(model.plan_object_change(original,granted)['ddl_required'])
        self.definition['fields'][0]['download_roles']=[]
        self.assertEqual(self.compile()['fields'][0]['download_roles'],[])
        self.definition['fields'][0]['download_roles']=['Guest']
        with self.assertRaises(model.ModelError):self.compile()

if __name__=="__main__":unittest.main()
