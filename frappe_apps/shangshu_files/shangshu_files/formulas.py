"""Bounded, same-sheet formula interpreter. No eval, external links or code execution."""
import datetime
import math
import re
from io import BytesIO
import zipfile
from xml.etree import ElementTree as ET
from openpyxl.utils.cell import coordinate_to_tuple, get_column_letter

MAX_REFERENCES=10000
TOKEN=re.compile(r'\s*(?:(\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?)|("(?:[^"]|"")*")|(\$?[A-Za-z]{1,3}\$?[1-9]\d*)|([A-Za-z_][A-Za-z_0-9]*)|(<>|<=|>=|[+*/^=<>(),:%-]))')
PRECEDENCE={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'+':2,'-':2,'*':3,'/':3,'^':4}
FUNCTIONS={'SUM','COUNT','IF','DATEDIF','DAYS'}
class FormulaError(ValueError):pass
class FormulaPending(Exception):pass

def parse(text):
 if not isinstance(text,str) or not text.startswith('=') or len(text)>2000:raise FormulaError('公式格式无效或超过2000字符')
 tokens=[];pos=1
 while pos<len(text):
  if not text[pos:].strip():break
  m=TOKEN.match(text,pos)
  if not m:raise FormulaError('公式包含不支持的语法（仅支持同表引用）')
  pos=m.end();tokens.append(next((i,v) for i,v in enumerate(m.groups()) if v is not None))
 if len(tokens)>512:raise FormulaError('公式过长')
 index=0
 def peek(v=None):return index<len(tokens) and (v is None or tokens[index][1]==v)
 def take(v=None):
  nonlocal index
  if not peek(v):raise FormulaError('公式语法不完整')
  token=tokens[index];index+=1;return token
 def expr(minimum=0,depth=0):
  if depth>64:raise FormulaError('公式嵌套过深')
  kind,value=take()
  if value in ('+','-'):node=('unary',value,expr(4,depth+1))
  elif value=='(':node=expr(0,depth+1);take(')')
  elif kind==0:node=('literal',float(value))
  elif kind==1:node=('literal',value[1:-1].replace('""','"'))
  elif kind==2:
   node=('ref',value.replace('$','').upper())
   if peek(':'):take();node=('range',node[1],take()[1].replace('$','').upper())
  elif kind==3:
   name=value.upper()
   if name in ('TRUE','FALSE'):node=('literal',name=='TRUE')
   else:
    if name not in FUNCTIONS:raise FormulaError('不支持的函数：'+name)
    take('(');args=[]
    if not peek(')'):
     args.append(expr(0,depth+1))
     while peek(','):take();args.append(expr(0,depth+1))
    take(')');node=('call',name,args)
    if (name=='IF' and len(args)!=3) or (name in ('DAYS','DATEDIF') and len(args)!=(2 if name=='DAYS' else 3)):raise FormulaError('函数参数数量不符')
  else:raise FormulaError('不支持的表达式')
  if peek('%'):take();node=('binary','/',node,('literal',100))
  while peek() and tokens[index][1] in PRECEDENCE and PRECEDENCE[tokens[index][1]]>=minimum:
   op=take()[1];prec=PRECEDENCE[op];node=('binary',op,node,expr(prec if op=='^' else prec+1,depth+1))
  return node
 result=expr()
 if index!=len(tokens):raise FormulaError('公式有未识别内容')
 return result

def references(node):
 kind=node[0]
 if kind=='ref':yield node[1]
 elif kind=='range':
  try:r1,c1=coordinate_to_tuple(node[1]);r2,c2=coordinate_to_tuple(node[2])
  except Exception:raise FormulaError('范围引用无效')
  if r2<r1 or c2<c1 or (r2-r1+1)*(c2-c1+1)>MAX_REFERENCES:raise FormulaError('范围引用无效或过大')
  for r in range(r1,r2+1):
   for c in range(c1,c2+1):yield get_column_letter(c)+str(r)
 elif kind=='unary':yield from references(node[2])
 elif kind=='binary':yield from references(node[2]);yield from references(node[3])
 elif kind=='call':
  for arg in node[2]:yield from references(arg)

def number(v):
 if v is None or v=='':return 0
 if isinstance(v,(datetime.date,datetime.datetime)):
  from openpyxl.utils.datetime import to_excel
  return to_excel(v)
 if isinstance(v,str):
  try:return number(datetime.date.fromisoformat(v[:10]))
  except ValueError:raise FormulaError('计算需要数字或日期')
 if type(v) not in (int,float,bool):raise FormulaError('计算需要数字或日期')
 return float(v)

def evaluate(node,get):
 kind=node[0]
 if kind=='literal':return node[1]
 if kind=='ref':return get(node[1])
 if kind=='range':return [get(ref) for ref in references(node)]
 if kind=='unary':return number(evaluate(node[2],get))*(1 if node[1]=='+' else -1)
 if kind=='binary':
  op=node[1];a=evaluate(node[2],get);b=evaluate(node[3],get)
  if op in ('=','<>','<','>','<=','>='):
   try:return {'=':lambda:a==b,'<>':lambda:a!=b,'<':lambda:a<b,'>':lambda:a>b,'<=':lambda:a<=b,'>=':lambda:a>=b}[op]()
   except TypeError:raise FormulaError('比较值类型不一致')
  a,b=number(a),number(b)
  if op=='^' and abs(b)>100:raise FormulaError('指数超出范围')
  try:value={'+':lambda:a+b,'-':lambda:a-b,'*':lambda:a*b,'/':lambda:a/b,'^':lambda:a**b}[op]()
  except (ZeroDivisionError,OverflowError):raise FormulaError('除零或数值溢出')
  if isinstance(value,complex) or not math.isfinite(value):raise FormulaError('结果不是有限实数')
  return value
 name,args=node[1:]
 if name=='IF':return evaluate(args[1] if evaluate(args[0],get) else args[2],get)
 values=[evaluate(arg,get) for arg in args]
 if name in ('DAYS','DATEDIF'):
  def day(v):
   if isinstance(v,str):
    try:return datetime.date.fromisoformat(v[:10])
    except ValueError:raise FormulaError('日期无效')
   if isinstance(v,datetime.datetime):return v.date()
   if isinstance(v,datetime.date):return v
   from openpyxl.utils.datetime import from_excel
   try:return from_excel(number(v)).date()
   except (ValueError,AttributeError):raise FormulaError('日期无效')
  if name=='DATEDIF' and str(values[2]).upper()!='D':raise FormulaError('DATEDIF仅支持天数单位D')
  return (day(values[0])-day(values[1])).days if name=='DAYS' else (day(values[1])-day(values[0])).days
 flat=[]
 for value in values:flat.extend(value if isinstance(value,list) else [value])
 nums=[number(v) for v in flat if type(v) in (int,float) or isinstance(v,(datetime.date,datetime.datetime))]
 return sum(nums) if name=='SUM' else len(nums)

def formula_cells(ws):
 """Scan stored cells, never expand a styled XFD rectangle into empty cells.

 ⚠️ **排序前先筛出公式格**（2026-10-27 · 性能）：
 旧写法 `sorted(cells.items())` 会把**整本**的格子（15,502 行 × 57 列 ⇒ **34 万个**）
 **全部排序**一遍 ⇒ 一张**一个公式都没有**的大表也要 **6.6 秒**，
 而写路径上这条路要走**两次**（结构动作入口 ＋ 保存前）⇒ 纯浪费。
 ⇒ 现在**先筛出公式格再排序**（公式格通常很少 ⇒ 排序近乎免费），
 **结果顺序不变**（仍是按行、按列升序）。
 """
 cells=getattr(ws,'_cells',None)
 if isinstance(cells,dict):
  # ⚠️ **先筛后排**：34 万格的整体排序是大表的主要开销（公式格占比极低）。
  found=[cell for cell in cells.values() if cell.data_type=='f' and cell.row>=2]
  for cell in sorted(found,key=lambda c:(c.row,c.column)):
   yield cell
 else:
  # Read-only and the bounded formula-index adapter provide lazy row iterators.
  for row in ws.iter_rows(min_row=2):
   for cell in row:
    if cell.data_type=='f':yield cell

def has_formulas(ws):
 """这张表有没有公式格 —— **只扫不排**（大表 34 万格约 0.3 秒）。

 ⚠️ **为什么要有这个口**（2026-10-27 · 性能）：
 「重算公式」这件事的**成本大头不在算**，而在**算之前要把正式值取出来**
 （`promotion._load_formal` ⇒ 把整本受管记录读一遍，15,502 行的大表要好几秒）
 ⇒ 而**没有公式的表**，那些正式值**一个都用不上** ⇒ 整段都是白花。
 ⇒ 调用方**先问一句有没有公式**，没有就**整段跳过**（含不取正式值）。
 """
 for _ in formula_cells(ws):
  return True
 return False


def recalculate(ws,meta,formal,definition):
 """Bind textual A1 refs once to stable row IDs + header names; current DB wins."""
 strict_coordinates=set(getattr(ws,'_ss_formula_inputs',()) or ())
 rows=meta.get('rows') or [];headers=[str(c.value or '') for c in ws[1]]
 positions={r:i+2 for i,r in enumerate(rows)};columns={h:i+1 for i,h in enumerate(headers)}
 promoted={c['header']:c['field'] for c in definition.get('columns',[]) if c.get('promoted') and c.get('field')}
 old=meta.get('formula_results') or {};records={};by_coord={};nodes={};reference_count=0
 for cell in formula_cells(ws):
  if cell.row-2>=len(rows):raise FormulaError('公式没有固定行身份')
  key=rows[cell.row-2]+'\0'+headers[cell.column-1]
  try:
   node=parse(cell.value);refs=set(references(node))
  except FormulaError as error:
   if cell.coordinate in strict_coordinates:raise
   # New inputs are validated before reaching this engine. Unsupported legacy
   # formulas remain formulas; never reinterpret their old cache as current.
   records[key]={'formula':cell.value,'bindings':{},'dependencies':[], 'value':None,
                 'pending':True,'opaque':True,'pending_reason':str(error)}
   by_coord[cell.coordinate]=key
   continue
  if len(nodes)>=2000 or reference_count+len(refs)>100000:
   records[key]={'formula':cell.value,'bindings':{},'dependencies':[], 'value':None,
                 'pending':True,'opaque':True,'pending_reason':'超出当前计算预算，待外部计算'}
   by_coord[cell.coordinate]=key
   continue
  reference_count+=len(refs)
  invalid=any(r<2 or r-2>=len(rows) or c>len(headers) for r,c in (coordinate_to_tuple(ref) for ref in refs))
  if invalid:
   if cell.coordinate in strict_coordinates:raise FormulaError('公式只能引用当前表的数据单元格')
   records[key]={'formula':cell.value,'bindings':{},'dependencies':[], 'value':None,
                 'pending':True,'opaque':True,'pending_reason':'导入公式含未解析引用，待外部计算'}
   by_coord[cell.coordinate]=key
   continue
  prior=old.get(key) or {};bindings={}
  for ref in refs:
   if prior.get('formula')==cell.value and ref in prior.get('bindings',{}):bindings[ref]=prior['bindings'][ref];continue
   r,c=coordinate_to_tuple(ref)
   if r<2 or r-2>=len(rows) or c>len(headers):raise FormulaError('公式只能引用当前表的数据单元格')
   bindings[ref]={'row_id':rows[r-2],'header':headers[c-1]}
  records[key]={'formula':cell.value,'bindings':bindings,'value':None,'dependencies':list(bindings.values())};nodes[key]=node;by_coord[cell.coordinate]=key
 if strict_coordinates and any(r.get('pending_reason')=='超出当前计算预算，待外部计算' for r in records.values()):
  raise FormulaError('本期新增公式不能超过2000个公式或100000个引用的计算预算')
 active=set();done=set()
 def compute(key):
  if records[key].get('pending'):return None
  if key in done:return records[key]['value']
  if key in active or len(active)>64:raise FormulaError('公式循环引用或依赖过深')
  active.add(key)
  def get(ref):
   bound=records[key]['bindings'][ref];rid,header=bound['row_id'],bound['header']
   if rid not in positions or header not in columns:raise FormulaError('公式引用的行或列已删除或改名，请先调整公式')
   if get_column_letter(columns[header])+str(positions[rid])!=ref:raise FormulaError('结构修改将移动公式引用，请先调整公式；本次未保存')
   if header in promoted:return (formal.get(rid) or {}).get(promoted[header])
   cell=ws.cell(positions[rid],columns[header]);other=by_coord.get(cell.coordinate)
   if other:
    value=compute(other);records[key]['dependencies'].extend(records[other]['dependencies'])
    if records[other].get('pending'):
     records[key]['opaque']=records[key].get('opaque',False) or records[other].get('opaque',False)
     raise FormulaPending('依赖公式尚待外部计算')
    return value
   return cell.value
  try:value=evaluate(nodes[key],get)
  except FormulaPending as error:
   records[key].update(pending=True,pending_reason=str(error),value=None)
   active.remove(key);done.add(key);return None
  if isinstance(value,(list,dict,tuple)):
   raise FormulaError('公式结果必须是单个值，不能返回范围')
  if isinstance(value,(datetime.datetime,datetime.date)):value=value.isoformat()
  if isinstance(value,float) and not math.isfinite(value):raise FormulaError('计算结果溢出')
  records[key]['value']=value;active.remove(key);done.add(key);return value
 for key in records:compute(key)
 meta['formula_results']=records
 return {coord:records[key]['value'] for coord,key in by_coord.items()}

def recalculate_index(entry, meta, changes, formal, definition, strict_coordinates=()):
 """Read only referenced values; use the exact same bounded interpreter as full saves.

 The index belongs to the current content revision. Never mutate it before commit.
 Formula positions are discovered once per index, not by constructing 500k Cells.
 """
 from types import SimpleNamespace
 headers=entry['headers'];raw=entry['rows_raw']
 positions=entry.get('formula_positions')
 if positions is None:
  positions=[(ri+2,ci+1) for ri,row in enumerate(raw) for ci,value in enumerate(row)
             if isinstance(value,str) and type(value) is str and value.startswith('=')]
  entry['formula_positions']=positions
 positions=set(positions)
 for (row,column),value in changes.items():
  if type(value) is str and value.startswith('='):positions.add((row,column))
  else:positions.discard((row,column))
 positions=sorted(positions)
 class Sheet:
  _ss_formula_inputs=strict_coordinates
  def __getitem__(self, row):
   if row!=1:raise FormulaError('索引只允许读取表头')
   return [SimpleNamespace(value=h) for h in headers]
  def cell(self,row,column):
   value=changes.get((row,column),raw[row-2][column-1] if row-2<len(raw) and column-1<len(raw[row-2]) else None)
   return SimpleNamespace(value=value,row=row,column=column,coordinate=get_column_letter(column)+str(row),
                          data_type='f' if (row,column) in position_set else 's')
  def iter_rows(self,**kwargs):
   return ((self.cell(row,col),) for row,col in positions)
 position_set=set(positions)
 previous=meta.get('formula_results') or {}
 values=recalculate(Sheet(),meta,formal,definition)
 edits=[]
 for coord,value in values.items():
  row,column=coordinate_to_tuple(coord);key=meta['rows'][row-2]+'\0'+headers[column-1]
  record=meta['formula_results'][key];prior=previous.get(key)
  # Imported/pending caches are already absent after compatibility initialization.
  # Preserve untouched formula XML (including shared nodes), but always clear a
  # formerly computed result that has newly become pending. Explicit edits/undo
  # still write their formula, and supported formulas still recalculate above.
  if (meta.get('formula_compat_ready') and record.get('pending') and (row,column) not in changes
      and (prior is None or (prior.get('pending') and prior.get('formula')==record['formula']))):
   continue
  edits.append((coord,{'type':'formula','formula':record['formula'],'value':value}))
 return edits


def verify_cached_nodes(nodes, edits):
 """Verify both formula text and cached scalar, independently of serialization."""
 for coord,typed in edits:
  if typed.get('type')!='formula':continue
  cell=ET.fromstring(nodes.get(coord) or b'<missing/>')
  f=cell.find('f');v=cell.find('v');expected=typed.get('value')
  if f is None or '='+str(f.text or '')!=typed['formula'] or v is None:
   raise FormulaError('公式或缓存未正确保存：'+coord)
  kind=cell.get('t','n');text=v.text or ''
  actual=(text=='1') if kind=='b' else text if kind=='str' else None if text=='' else float(text)
  if type(expected) is bool:
   valid=type(actual) is bool and actual==expected
  else:valid=actual==expected and not (type(actual) is bool and type(expected) is not bool)
  if not valid:raise FormulaError('公式计算缓存不符：'+coord)


def invalidate_imported_caches(content):
 """Preserve formula XML (including shared anchors) while removing stale caches.

 Run after external-link freezing, never before (its cached value is the frozen
 source). Formula recalculation is requested in workbook properties. All other
 worksheet bytes/styles and ZIP entries remain unchanged.
 """
 from shangshu_files import zipedit
 changes={};found=False
 prefix=rb'(?:[A-Za-z_][\w.-]*:)?'
 cells=re.compile(rb'<'+prefix+rb'c\b[^>]*(?:/>|>.*?</'+prefix+rb'c\s*>)',re.S)
 # OOXML places f first in a formula cell. Match only those cells instead of
 # invoking Python/backtracking across every ordinary cell in large workbooks.
 formula_cells=re.compile(rb'<'+prefix+rb'c\b[^>]*>\s*<'+prefix+rb'f\b[^>]*(?:/>|>[^<]*</'+prefix+rb'f\s*>).*?</'+prefix+rb'c\s*>',re.S)
 formula_tags=re.compile(rb'<'+prefix+rb'f\b')
 with zipfile.ZipFile(BytesIO(content)) as source:
  for name in source.namelist():
   if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml',name):continue
   original=source.read(name)
   matched=0
   def clear(match):
    nonlocal found,matched
    cell=match.group(0)
    if not re.search(rb'<'+prefix+rb'f\b',cell):return cell
    found=True;matched+=1
    return re.sub(rb'<'+prefix+rb'(?:v|is)\b[^>]*(?:/>|>.*?</'+prefix+rb'(?:v|is)\s*>)',b'',cell,flags=re.S)
   data=formula_cells.sub(clear,original)
   if matched!=len(formula_tags.findall(original)):
    # Noncanonical/extension layout keeps the existing conservative scanner.
    data=cells.sub(clear,original)
   if data!=original:changes[name.encode()]=data
  if found:
   original=source.read('xl/workbook.xml')
   calc=re.search(rb'<'+prefix+rb'calcPr\b[^>]*(?:/>|>.*?</'+prefix+rb'calcPr\s*>)',original,re.S)
   if calc:
    data=original[:calc.start()]+b'<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>'+original[calc.end():]
   else:data=re.sub(rb'(</'+prefix+rb'workbook\s*>)',rb'<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>\1',original)
   if data!=original:changes[b'xl/workbook.xml']=data
 return zipedit.rebuild_zip(content,changes) if changes else content


def write_cached_values(content,title,values):
 content=invalidate_imported_caches(content)
 if not values:return content
 from shangshu_files import zipedit
 part=zipedit.sheet_part_by_title(content,title)
 ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
 output=BytesIO()
 with zipfile.ZipFile(BytesIO(content)) as source,zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as target:
  for info in source.infolist():
   data=source.read(info.filename)
   if info.filename==part:
    root=ET.fromstring(data)
    for cell in root.iter(ns+'c'):
     if cell.get('r') not in values:continue
     value=values[cell.get('r')]
     for child in list(cell):
      if child.tag in (ns+'v',ns+'is'):cell.remove(child)
     cell.set('t','b' if isinstance(value,bool) else 'str' if isinstance(value,str) else 'n')
     ET.SubElement(cell,ns+'v').text=('1' if value else '0') if isinstance(value,bool) else '' if value is None else str(value)
    # Keep OOXML's default namespace: fast readers intentionally use unprefixed
    # cell tags. Existing prefixed files remain valid and fall back on XML parsing.
    ET.register_namespace('',ns[1:-1])
    data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
   target.writestr(info,data)
 return output.getvalue()


def decorate_values(values,row_id,meta,version,hidden):
 for header,typed in list(values.items()):
  result=(meta.get('formula_results') or {}).get(row_id+'\0'+header)
  if typed.get('type')!='formula':continue
  if not result and hidden:
   values[header]={'type':'hidden','hidden':True,'value':None};continue
  if not result:
   values[header]={**typed,'value':None,'calculation_pending':True,'pending_reason':'导入公式尚未计算','result_version':version};continue
  if result.get('opaque') and hidden:
   values[header]={'type':'hidden','hidden':True,'value':None};continue
  if meta.get('writeback_pending'):
   values[header]={**typed,'value':None,'calculation_pending':True,'result_version':version};continue
  if any(d['header'] in hidden for d in result.get('dependencies',result.get('bindings',{}).values())):
   values[header]={'type':'hidden','hidden':True,'value':None};continue
  if result.get('pending'):
   values[header]={**typed,'value':None,'calculation_pending':True,'pending_reason':result.get('pending_reason'),'result_version':version};continue
  values[header]={**typed,'value':result['value'],'result_version':version}
 return values


def relocate(ws,meta,previous,renamed=None):
 """Move existing finite formula references by their persisted record/header identity."""
 renamed=renamed or {};rows=meta.get('rows') or [];headers=[str(c.value or '') for c in ws[1]]
 positions={rid:i+2 for i,rid in enumerate(rows)};columns={h:i+1 for i,h in enumerate(headers)}
 for key,old in (previous.get('formula_results') or {}).items():
  rid,header=key.split('\0',1);header=renamed.get(header,header)
  if rid not in positions or header not in columns:continue # deleted formula itself
  cell=ws.cell(positions[rid],columns[header])
  if cell.data_type!='f':continue
  def target(ref):
   bound=(old.get('bindings') or {}).get(ref)
   if not bound:raise FormulaError('公式引用缺少稳定身份，结构未保存')
   h=renamed.get(bound['header'],bound['header']);r=bound['row_id']
   if r not in positions or h not in columns:raise FormulaError('待删除的行列仍被公式引用，请先调整引用')
   return get_column_letter(columns[h])+str(positions[r])
  def render(node):
   kind=node[0]
   if kind=='literal':
    value=node[1]
    return ('"'+value.replace('"','""')+'"') if isinstance(value,str) else ('TRUE' if value else 'FALSE') if isinstance(value,bool) else str(value)
   if kind=='ref':return target(node[1])
   if kind=='range':
    refs=[target(ref) for ref in references(node)]
    coords=[coordinate_to_tuple(ref) for ref in refs];rs=[r for r,c in coords];cs=[c for r,c in coords]
    if len(set(coords))!=(max(rs)-min(rs)+1)*(max(cs)-min(cs)+1):raise FormulaError('此范围移动后不连续，请先改为逐格引用')
    return get_column_letter(min(cs))+str(min(rs))+':'+get_column_letter(max(cs))+str(max(rs))
   if kind=='unary':return '('+node[1]+render(node[2])+')'
   if kind=='binary':return '('+render(node[2])+node[1]+render(node[3])+')'
   args=[]
   for arg in node[2]:
    if arg[0]=='range' and node[1] in ('SUM','COUNT'):
     try:args.append(render(arg))
     except FormulaError:args.extend(target(ref) for ref in references(arg))
    else:args.append(render(arg))
   return node[1]+'('+','.join(args)+')'
  text='='+render(parse(old['formula']));parse(text);cell.value=text
 # New text is rebound to the same relocated cells by recalculate.
 meta['formula_results']={}
