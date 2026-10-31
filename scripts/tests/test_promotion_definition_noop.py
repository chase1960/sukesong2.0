"""续晋升相同定义只复用当前修订；真正变更仍进入原迁移/写入路径。"""
import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from _f_module_seam import install_real_environment
install_real_environment('shangshu_core')
from shangshu_core import promotion_records as promotion, model_schema, model_changes, design_support
from shangshu_core import independent_migration, model_lifecycle


def fail(message, error=ValueError): raise error(message)


class PromotionDefinitionNoop(unittest.TestCase):
    def setUp(self):
        self.appid='com.shangshu.app.'+'a'*32
        self.oid=self.appid+'.object.'+'b'*32
        self.access={op:{'scope':'global'} for op in ('read','write','download')}
        self.access['record_scope']='all'
        self.columns=[{'header':'金额','field':'amount','type':'number','promoted':True,'rules':{'min':0}}]
        definition=promotion.build_definition('费用',self.columns,access=self.access)
        self.compiled=model_schema.compile_object(self.appid,self.oid,definition)
        self.model=SimpleNamespace(name=self.oid,application=self.appid,enterprise_id='E',revision=3,
                                   active_revision=3,active_json=json.dumps(self.compiled))
        self.locked=copy.deepcopy(self.model)
        self.app=SimpleNamespace(status='Published',published_revision='published')
        self.pending=False; self.existing=None
        self.publication={'bindings':[{'resource_id':self.oid,'version':'3'}]}
        def get_doc(doctype,name,**kwargs):
            if doctype=='Shangshu Object Model': return self.locked if kwargs.get('for_update') else self.model
            if doctype=='Shangshu Application Revision': return SimpleNamespace(definition_json=json.dumps(self.publication))
            if doctype=='Shangshu Schema Change': return self.existing
            raise AssertionError(doctype)
        def get_value(doctype,key,*args,**kwargs):
            return ('pending' if self.pending else None) if isinstance(key,dict) else ('previous' if self.existing else None)
        self.fake=SimpleNamespace(get_doc=Mock(side_effect=get_doc),db=SimpleNamespace(get_value=Mock(side_effect=get_value)),
            throw=fail,ValidationError=ValueError,PermissionError=PermissionError,
            DuplicateEntryError=ValueError,TimestampMismatchError=RuntimeError)
        self.prepare=Mock(return_value={'id':'change'})
        self.migrate=Mock(return_value={'target_revision':4})
        self.publish=Mock(); self.values=Mock(); self.lock=Mock()
        for owner,key,value in (
            (promotion,'frappe',self.fake),
            (promotion,'require_designer',Mock(return_value=SimpleNamespace(identity_id='person',enterprise_id='E'))),
            (design_support,'require_application',Mock(return_value=self.app)),
            (design_support,'lock_lifecycle',self.lock),
            (model_changes,'prepare_object_change',self.prepare),
            (independent_migration,'run_independent_migration',self.migrate),
            (model_lifecycle,'object_life',Mock(return_value=1)),
            (promotion,'_publish',self.publish),(promotion,'_set_values',self.values),
        ):
            handle=patch.object(owner,key,value);handle.start();self.addCleanup(handle.stop)

    def extend(self,**kwargs):
        return promotion.extend_promoted_records(**{'object_id':self.oid,'application_id':self.appid,
            'title':'费用','columns':self.columns,'rows':[],'records':{'r1':'R1'},
            'access':self.access,'idempotency_key':'same',**kwargs})

    def test_equal_compiled_definition_does_not_plan_migrate_publish_or_advance_revision(self):
        result=self.extend()
        self.assertEqual(result['revision'],3);self.assertFalse(result['definition_changed'])
        self.assertEqual(result['records'],{'r1':'R1'})
        self.prepare.assert_not_called();self.migrate.assert_not_called();self.publish.assert_not_called()
        self.values.assert_not_called();self.lock.assert_called_once()
        self.assertTrue(any(c.kwargs.get('for_update') for c in self.fake.get_doc.call_args_list))

    def test_real_rule_change_still_plans_and_migrates(self):
        columns=copy.deepcopy(self.columns);columns[0]['rules']['min']=1
        result=self.extend(columns=columns)
        self.assertEqual(result['revision'],4);self.assertTrue(result['definition_changed'])
        self.prepare.assert_called_once();self.migrate.assert_called_once();self.publish.assert_called_once()

    def test_same_definition_with_values_keeps_registered_write_path(self):
        result=self.extend(rows=[{'row_id':'r1','values':{'amount':9}}])
        self.assertEqual(result['revision'],3)
        self.values.assert_called_once_with(self.oid,3,'R1',{'amount':9},'promotion-value:same:r1')
        self.prepare.assert_not_called();self.publish.assert_not_called()

    def test_current_definition_without_published_binding_still_completes_publication(self):
        self.publication={'bindings':[]}
        self.extend()
        self.prepare.assert_not_called();self.migrate.assert_not_called();self.publish.assert_called_once()

    def test_permission_and_concurrent_revision_do_not_become_noop_success(self):
        self.locked.enterprise_id='other'
        with self.assertRaises(PermissionError):self.extend()
        self.locked.enterprise_id='E';self.locked.revision=4
        with self.assertRaisesRegex(RuntimeError,'草稿已变化'):self.extend()
        self.prepare.assert_not_called();self.publish.assert_not_called()

    def test_existing_migration_or_reused_key_cannot_be_hidden_by_equality(self):
        self.pending=True;self.prepare.side_effect=ValueError('pending')
        with self.assertRaisesRegex(ValueError,'pending'):self.extend()
        self.pending=False;self.prepare.reset_mock();self.prepare.side_effect=None
        self.existing=SimpleNamespace(object_model=self.oid,compiled_json=json.dumps({**self.compiled,'title':'old'}))
        with self.assertRaisesRegex(ValueError,'幂等键'):self.extend()
        self.prepare.assert_not_called();self.publish.assert_not_called()


if __name__=='__main__':unittest.main()
