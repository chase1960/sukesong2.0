"""Request-local relation query: current authorized values, then search/pagination.

No process/global value cache: a new query rechecks target ACL and direction.
"""
import json
from collections import defaultdict, OrderedDict
import frappe
from shangshu_files import table_relations as rel

ROW_CACHE_SIZE=2000


class Resolver:
    def __init__(self):
        self.files={};self.headers={};self.configs={};self.links={};self.rows=OrderedDict();self.formula_snapshots={}

    def store(self,key,value):
        self.rows[key]=value;self.rows.move_to_end(key)
        while len(self.rows)>ROW_CACHE_SIZE:self.rows.popitem(last=False)

    def checked(self,table,header):
        if table not in self.files:self.files[table]=rel._file(table)
        key=(table,header)
        if key not in self.headers:
            rel._header(self.files[table],header);self.headers[key]=True
        return self.files[table]

    def config(self,table,header):
        key=(table,header)
        if key not in self.configs:self.configs[key]=rel._definition(table,header)
        return self.configs[key]

    def prime(self,table,row_ids,headers):
        """One authorized row read per table/500 IDs, including chained targets."""
        queue=[(table,set(row_ids),set(headers),0)];visited=set()
        while queue:
            table,ids,headers,depth=queue.pop(0)
            if depth>32:frappe.throw('关联循环或过深',frappe.ValidationError)
            keys={(table,r,h) for r in ids for h in headers}-visited
            if not keys:continue
            visited.update(keys)
            missing=[r for r in ids if (table,r) not in self.rows]
            for start in range(0,len(missing),500):
                chunk=missing[start:start+500]
                try:
                    view=rel._view(table,chunk)
                    found={row['row_id']:row for row in view.get('rows',[])}
                    for rid in chunk:self.store((table,rid),(view.get('content_version'),found.get(rid)))
                except (frappe.PermissionError,frappe.DoesNotExistError):
                    for rid in chunk:self.store((table,rid),(None,None))
            targets=defaultdict(lambda:[set(),set()])
            for header in headers:
                try:
                    self.checked(table,header);config=self.config(table,header)
                    if not config:continue
                    rel.assert_relation_direction(table,config.target_table)
                    links=self.links.setdefault((table,header),json.loads(config.links_json or '{}'))
                    for rid in ids:
                        if self.rows.get((table,rid),(None,None))[1] is not None and links.get(rid):
                            targets[config.target_table][0].add(links[rid]);targets[config.target_table][1].add(config.target_header)
                except (frappe.PermissionError,frappe.DoesNotExistError):continue
            queue.extend((t,ids,hs,depth+1) for t,(ids,hs) in targets.items())

    def resolve(self,table,row,header,seen=None):
        seen=set(seen or ());key=(table,row,header)
        if key in seen or len(seen)>32:frappe.throw('关联循环或过深',frappe.ValidationError)
        seen.add(key);self.checked(table,header)
        if (table,row) not in self.rows:self.prime(table,[row],[header])
        version,item=self.rows.get((table,row),(None,None))
        if item is None:frappe.throw('关联记录不存在或不可读',frappe.PermissionError)
        config=self.config(table,header)
        if not config:return {'value':item['values'][header],'source_version':version,'target':{'table':table,'row_id':row,'header':header}}
        rid=self.links.setdefault((table,header),json.loads(config.links_json or '{}')).get(row)
        if not rid:return {'value':{'type':'blank','value':None},'status':'empty','relation_revision':config.revision}
        rel.assert_relation_direction(table,config.target_table)
        value=self.resolve(config.target_table,rid,config.target_header,seen)
        return {**value,'status':'linked','direct_target':{'table':config.target_table,'row_id':rid,'header':config.target_header},'relation_revision':config.revision}


def search_payload(service,payload,context=None):
    """Return None for ordinary sheets; caller retains its existing fast path."""
    if getattr(frappe.flags,'shangshu_raw_relation_read',False) or not str(payload.get('search') or '').strip():return None
    configs=rel.definitions(str(payload['table']))
    if not configs:return None
    from shangshu_files import sheet,promotion
    from openpyxl.utils import get_column_letter
    query=str(payload['search']).strip().lower()[:200];wanted=set(payload.get('row_ids') or [])
    explicit_empty='row_ids' in payload and not payload['row_ids']
    page=max(int(payload.get('page') or 1),1);length=min(max(int(payload.get('page_length') or 200),1),500)
    start=(page-1)*length;stop=page*length;matched=[];count=0;scanned=0;result=None
    resolver=Resolver();hidden=set(promotion.unreadable_headers(rel._file(payload['table'])))
    base={k:v for k,v in payload.items() if k not in ('search','row_ids','op_id','page','page_length')}
    source_page=1
    while True:
        old=getattr(frappe.flags,'shangshu_raw_relation_read',False)
        try:
            frappe.flags.shangshu_raw_relation_read=True
            part=sheet.read_payload(service,{**base,'page':source_page,'page_length':500},None)
        finally:frappe.flags.shangshu_raw_relation_read=old
        if explicit_empty:part={**part,'rows':[],'total_rows':0}
        if result is None:result={**part,'rows':[]}
        batch=part['rows'];scanned+=len(batch)
        resolver.prime(payload['table'],[r['row_id'] for r in batch],[c.source_header for c in configs])
        decorated=rel.decorate_response(part,resolver=resolver)
        for row in decorated['rows']:
            if wanted and row['row_id'] not in wanted:continue
            hits=[]
            for i,header in enumerate(result['headers'],1):
                if header in hidden:continue
                typed=row['values'].get(header,{})
                if typed.get('relation_status')=='unavailable' or typed.get('redacted') or typed.get('calculation_pending'):continue
                value=typed.get('value');text='' if value is None else str(value)
                # Search displayed values only. Formula expressions may name a
                # hidden dependency and must not become a search side channel.
                if query in text.lower():hits.append({'header':header,'cell':get_column_letter(i)+str(row['row_index'])})
            if hits:
                if wanted or start<=count<stop:row['matches']=hits;matched.append(row)
                count+=1
        result['readonly_columns']=decorated.get('readonly_columns',[]);result['relations']=decorated.get('relations',[])
        if scanned>=part['total_rows'] or not batch:break
        source_page+=1
    result.update(rows=matched,total_rows=count,search=query)
    result.setdefault('diagnostics',{})['relation_search']={'authorized_rows_scanned':scanned,'request_local_cache':True}
    op_id=str(payload.get('op_id') or (context or {}).get('idempotency_key') or '').strip()
    if op_id:
        doc=rel._file(payload['table'])
        cells=[{'row_id':r['row_id'],'header':h,'before':v.get('value'),'cell_index':r['row_index'],'col_index':i} for r in result['rows'] for i,(h,v) in enumerate(r['values'].items()) if h not in hidden]
        sheet._record_op(doc,'files.sheet_read',op_id,cells,sheet.content_revision(doc),context)
    return result
