"""Actual ZIP public entries plus the actual promotion planner/committer.

Only authenticated persistence boundaries are substituted. Site tests separately
prove Frappe transactions, complete record constraints, uniqueness and rollback.
"""
import copy
import json
import unittest
from types import SimpleNamespace, ModuleType
from unittest.mock import patch
import test_incremental_daily_write as daily
from _f_module_seam import load_module_functions


class Mixed(unittest.TestCase):
    def setUp(self):
        self.case=daily.DailyEntries();self.case.setUp();self.addCleanup(self.case.doCleanups)
        c=self.case;c.enabled=True;c.frappe.flags=SimpleNamespace()
        c.definition['columns'][0]['rules']['required']=True
        c.meta['promotion_binding']={'object_id':'o','records':{'r-000001':'n1','r-000002':'n2'}}
        self.versions={'r-000001':'V0','r-000002':'V2'};self.restored={};self.writes=[]
        self.p=load_module_functions(daily.FILES/'promotion.py',{'plan_atomic_values','commit_atomic_values','row_readiness','_check_rules'},stubs={'frappe':c.frappe})
        self.p.update(load_definition=lambda *_:c.definition,
            _load_meta=lambda *_:copy.deepcopy(c.meta),
            _managed_binding=lambda *_:c.meta.get('promotion_binding'),
            _managed_state=self.state,
            _load_formal=lambda d,row_ids=None:self.state(d,None,row_ids)['values'],
            formal_state=lambda *_:self.state(None,None),
            require_fields_writable=lambda *a,**kw:c.rule(None,None,None),
            _write_managed=self.write_managed)
        for name in ('plan_atomic_values','commit_atomic_values','row_readiness'):
            setattr(c.promo,name,self.p[name])
        fault_module=ModuleType('shangshu_files.sheet');fault_module._fault=lambda point:c.h['_fault'](point)
        item=patch.dict('sys.modules',{'shangshu_files.sheet':fault_module});item.start();self.addCleanup(item.stop)
        c.frappe.get_all=lambda *a,**kw:[record for record in c.logs if record.op_id==kw['filters']['op_id']][-1:]
        def mark(*args,**kwargs):
            for record in c.logs:
                if record.name==args[1]:record.undone=1
        c.frappe.db.set_value=mark

    def state(self,doc,binding,row_ids=None):
        wanted=set(row_ids) if row_ids is not None else set(self.case.formal)
        return {'values':{r:copy.deepcopy(v) for r,v in self.case.formal.items() if r in wanted},
                'versions':{r:v for r,v in self.versions.items() if r in wanted}}
    def write_managed(self,doc,binding,changes,**kw):
        c=self.case;self.writes.append(copy.deepcopy(changes));self.restored.update(kw.get('restore_versions_by_row') or {})
        for rid,values in changes.items():
            if rid not in binding['records']:
                marker=c.meta.get('promotion_pending_rows',{}).get(rid)
                if not marker:raise ValueError('unmapped historical row')
                c.meta['promotion_binding']['records'][rid]='new-record-'+rid
                c.meta['promotion_pending_rows'].pop(rid)
            c.formal.setdefault(rid,{}).update(values)
            self.versions[rid]=(kw.get('restore_versions_by_row') or {}).get(rid,'next')
        return {'written':len(changes)}
    def cells(self,amount=810):
        return [{'row_id':'r-000001','header':'金额','value':{'type':'number','value':amount}},
                {'row_id':'r-000001','header':'备注','value':{'type':'text','value':'new'}}]
    def write(self,cells=None):return self.case.h['write_cells'](self.case.payload(cells=cells or self.cells()))
    def undo(self,op):return self.case.h['undo_cells']({'table':'table','op_id':op})
    def paste(self,values,row=0,col=1,types=None,ids=None):
        return self.case.h['paste_apply'](self.case.payload(start_row=row,start_col=col,matrix=values,matrix_types=types,target_row_ids=ids))

    def test_success_one_save_one_ledger_and_only_changed_formal_field(self):
        result=self.write();c=self.case
        self.assertEqual(c.formal['r-000001']['amount'],810);self.assertEqual(c.sheet()['B2'].value,810)
        self.assertEqual(c.sheet()['C2'].value,'new');self.assertEqual(c.sheet()['B2'].number_format,'#,##0.00')
        self.assertEqual((len(c.saves),len(c.logs)),(1,1));self.assertEqual(self.writes,[{'r-000001':{'amount':810}}])
        self.assertEqual(c.meta['promotion_row_states']['r-000001']['status'],'ready')
        self.assertEqual(result['cells'][0]['formal_before_version'],'V0')

    def test_illegal_denied_and_missing_binding_never_save(self):
        c=self.case
        for denied,amount in ((False,-1),(True,810)):
            c.denied=denied
            with self.assertRaises((ValueError,PermissionError)):self.write(self.cells(amount))
            self.assertEqual(c.saves,[]);self.assertEqual(self.writes,[])
        c.denied=False;c.meta.pop('promotion_binding')
        with self.assertRaisesRegex(ValueError,'没有受管对象绑定'):self.write()
        self.assertEqual(c.saves,[]);self.assertEqual(self.writes,[])

    def test_file_fault_propagates_and_does_not_publish_a_ledger(self):
        c=self.case;c.h['_save_current']=lambda *a,**kw:(_ for _ in ()).throw(RuntimeError('file-write'))
        with self.assertRaisesRegex(RuntimeError,'file-write'):self.write()
        self.assertEqual(c.logs,[])

    def test_unknown_row_rejected_without_formal_mutation(self):
        cells=self.cells();cells[0]['row_id']='gone'
        with self.assertRaises(ValueError):self.write(cells)
        self.assertEqual(self.writes,[]);self.assertEqual(self.case.formal['r-000001']['amount'],800)

    def test_note_only_expansion_draft_then_formal_first_write_keeps_new_binding(self):
        c=self.case;result=self.paste([['note']],row=2,col=2,types=[['text']]);rid=result['row_ids'][0]
        self.assertNotIn(rid,c.formal);self.assertEqual(result['row_states'][rid]['status'],'draft')
        self.assertIn(rid,c.meta['promotion_pending_rows'])
        self.write([{'row_id':rid,'header':'金额','value':{'type':'number','value':42}}])
        self.assertEqual(c.formal[rid]['amount'],42);self.assertIn(rid,c.meta['promotion_binding']['records'])
        self.assertNotIn(rid,c.meta['promotion_pending_rows']);self.assertEqual(c.sheet()['B4'].value,42)

    def test_empty_record_is_draft_but_zero_and_false_are_facts(self):
        definition={'columns':[{'header':'值','field':'value','promoted':True,'type':'number','rules':{}}]}
        self.assertEqual(self.p['row_readiness'](definition,{'value':None})['status'],'draft')
        self.assertEqual(self.p['row_readiness'](definition,{'value':0})['status'],'ready')
        definition['columns'][0]['type']='boolean'
        self.assertEqual(self.p['row_readiness'](definition,{'value':False})['status'],'ready')

    def test_complete_expansion_one_save_and_no_empty_placeholder_record(self):
        c=self.case;result=self.paste([[42,'new']],row=2,types=[['number','text']]);rid=result['row_ids'][0]
        self.assertEqual(c.formal[rid]['amount'],42);self.assertEqual(len(self.writes),1)
        self.assertEqual(len(c.saves),1);self.assertEqual(result['row_states'][rid]['status'],'ready')
        self.assertIn(rid,c.meta['promotion_binding']['records'])

    def test_first_optional_formal_write_undo_restores_empty_without_losing_mapping(self):
        c=self.case;c.definition['columns'][0]['rules']['required']=False
        result=self.paste([[42]],row=2,types=[['number']]);rid=result['row_ids'][0]
        self.undo(result['op_id']);self.assertIsNone(c.formal[rid]['amount']);self.assertIsNone(c.sheet()['B4'].value)
        self.assertIn(rid,c.meta['promotion_binding']['records'])

    def test_mixed_matrix_sorted_identity_and_invalid_last_zero_write(self):
        c=self.case;before=c.content
        with self.assertRaises(ValueError):self.paste([[900,'ok'],[-1,'bad']],types=[['number','text']]*2)
        self.assertEqual(c.content,before);self.assertEqual(self.writes,[])
        self.paste([[920,'second']],types=[['number','text']],ids=['r-000002'])
        self.assertEqual(c.sheet()['B2'].value,800);self.assertEqual(c.sheet()['B3'].value,920)
        self.assertEqual(c.formal['r-000002']['amount'],920)

    def test_inverse_restores_both_and_version_keeps_unrelated_edit_and_is_idempotent(self):
        c=self.case;written=self.write();op=written['op_id']
        c.h['write_cell'](c.payload(row_id='r-000002',header='备注',value={'type':'text','value':'other person'}))
        self.undo(op)
        self.assertEqual((c.formal['r-000001']['amount'],c.sheet()['B2'].value),(800,800))
        self.assertEqual(c.sheet()['C3'].value,'other person');self.assertEqual(self.restored,{'r-000001':'V0'})
        count=len(c.saves);self.assertEqual(self.undo(op)['applied'],0);self.assertEqual(len(c.saves),count)

    def test_inverse_same_cell_or_formal_conflict_rejects_entire_package(self):
        c=self.case;written=self.write();op=written['op_id'];count=len(c.saves)
        c.formal['r-000001']['amount']=999
        with self.assertRaises(ValueError):self.undo(op)
        self.assertEqual(len(c.saves),count);c.formal['r-000001']['amount']=810
        c.h['write_cell'](c.payload(row_id='r-000001',header='备注',value={'type':'text','value':'later'}))
        count=len(c.saves)
        with self.assertRaises(ValueError):self.undo(op)
        self.assertEqual(len(c.saves),count);self.assertEqual(c.formal['r-000001']['amount'],810)

    def test_three_own_steps_undo_and_other_actor_cannot_undo(self):
        c=self.case;ops=[]
        for amount in (810,820,830):ops.append(self.write(self.cells(amount))['op_id'])
        c.frappe.session.user='other'
        with self.assertRaises(PermissionError):self.undo(ops[-1])
        c.frappe.session.user='person'
        for op,amount in zip(reversed(ops),(820,810,800)):
            self.undo(op);self.assertEqual(c.sheet()['B2'].value,amount);self.assertEqual(c.formal['r-000001']['amount'],amount)

if __name__=='__main__':unittest.main(verbosity=2)
