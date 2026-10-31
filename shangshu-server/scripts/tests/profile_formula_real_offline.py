"""Offline hotspot profile of exported original-size fixture; never an HTTP acceptance substitute."""
import ast,re,time,sys,cProfile,pstats,json
from pathlib import Path
from io import BytesIO
root=Path(__file__).resolve().parents[3];sys.path.insert(0,str(root/'frappe_apps/shangshu_files'))
from shangshu_files import formulas,zipedit
s=root/'frappe_apps/shangshu_files/shangshu_files/sheet.py'
ns={'re':re,'time':time,'_dominant_type':lambda values:None}
class literal(str):pass
ns['_literal_text']=literal
node=next(n for n in ast.parse(s.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_entry_fast')
exec(compile(ast.Module(body=[node],type_ignores=[]),str(s),'exec'),ns)
content=(root/'docs/reports/r967-20261019/perf-real-export.xlsx').read_bytes();entry=ns['_entry_fast'](content,None);meta={'formula_compat_ready':True,'rows':['r'+str(i) for i in range(len(entry['rows_raw']))]};part=zipedit.sheet_part_by_title(content,entry['sheet_title'])
p=cProfile.Profile();p.enable()
edits=formulas.recalculate_index(entry,meta,{(2,1):'PROFILE'}, {},{})
recalc=time.perf_counter();saved=zipedit.edit_cells(content,part,[('A2',{'type':'text','value':'PROFILE'})]+edits,verify=False)
formulas.verify_cached_nodes(zipedit.cell_nodes(zipedit.read_sheet(saved,part),dict(edits)),edits)
p.disable();print('rows',len(meta['rows']),'formula_records',len(meta['formula_results']),'formula_xml_edits',len(edits),'metadata_bytes',len(json.dumps(meta)));pstats.Stats(p).sort_stats('cumulative').print_stats(28)
