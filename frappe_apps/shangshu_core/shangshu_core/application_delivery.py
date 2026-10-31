"""应用交付适配：共用原草稿与迁移执行，不维护第二配置权威。"""
import copy
import json
import frappe
from shangshu_core.applications import save_application_draft, _validate, REVISION
from shangshu_core.design_support import require_designer, require_application, content_hash, canonical_json
from shangshu_core.model_changes import MODEL, CHANGE
from shangshu_core.model_schema import compile_object, record_schema, ModelError

FORMAT = 'shangshu.application/1'
MODEL_KEYS = ('schema_version','title','kind','fields','access')
PAGE_KEYS = ('id','title','object_id','fields','list_fields','columns')


def inspect_application(_action_id, payload, _context):
    from shangshu_core.applications import get_application_definition
    return get_application_definition(payload['application_id'])


def _logical(spec):
    value=copy.deepcopy(spec)
    value['pages']=[{key:page[key] for key in PAGE_KEYS if key in page} for page in value.get('pages',[])]
    return value


def inspect_delivery(_service_id, payload, context):
    identity=require_designer()
    app=require_application(payload['application_id'], identity)
    operation=payload['operation']
    if operation=='export':
        if frappe.db.exists(CHANGE, {'object_model':['in',frappe.get_all(MODEL,filters={'application':app.name},pluck='name') or ['']],
                                    'status':['in',['Planned','Running','Failed']]}):
            frappe.throw('请先完成或取消数据表变更，再导出定义',frappe.ValidationError)
        history=frappe.get_doc(REVISION, f'{app.name}:{app.draft_revision}')
        spec, dependencies=_validate(json.loads(app.draft_json),application_id=app.name)
        if canonical_json(dependencies)!=canonical_json(json.loads(history.dependencies_json)):
            frappe.throw('依赖已变化，请先保存草稿重新检查',frappe.ValidationError)
        models=[]
        for row in frappe.get_all(MODEL,filters={'application':app.name,'active_revision':['>',0]},fields=['name','active_json']):
            compiled=json.loads(row.active_json)
            models.append({'id':row.name,'definition':{key:compiled[key] for key in MODEL_KEYS}})
        return {'package':{'format':FORMAT,'definition':_logical(spec),'models':models,
                           'dependencies':[item for item in dependencies if item['owner_domain']!=app.name]},
                'revision':app.draft_revision,'business_data_included':False}
    if operation=='change_preview':
        if payload.get('expected_revision') != app.draft_revision:
            frappe.throw('草稿已变化，请重新读取',frappe.TimestampMismatchError)
        spec,dependencies=_validate(payload.get('definition'),application_id=app.name)
        old=_logical(json.loads(app.draft_json));new=_logical(spec)
        labels={'title':'应用名称','description':'说明','allowed_roles':'使用角色','bindings':'资源引用','pages':'页面与表单','workflows':'审批流程','overview':'应用总览'}
        return {'expected_revision':app.draft_revision,'changes':[{'field':key,'label':labels.get(key,key),'before':old.get(key),'after':new.get(key)}
                for key in sorted(set(old)|set(new)) if old.get(key)!=new.get(key)],'definition':spec,
                'dependency_hash':content_hash([item for item in dependencies if item['owner_domain']!=app.name])}
    return _import_preview(app, payload.get('package'), identity)


def _import_preview(app, package, identity):
    if not isinstance(package,dict) or set(package)!={'format','definition','models','dependencies'} or package['format']!=FORMAT:
        frappe.throw('应用包格式不支持或包含额外内容',frappe.ValidationError)
    if len(canonical_json(package))>1_000_000:
        frappe.throw('应用定义包超过 1MB',frappe.ValidationError)
    if app.published_revision or app.draft_revision!=1:
        frappe.throw('只能导入新建空应用，不能覆盖已有应用；请另建应用',frappe.ValidationError)
    models=package['models'];deps=package['dependencies']
    if not isinstance(models,list) or len(models)>100 or not isinstance(deps,list) or len(deps)>200:
        frappe.throw('应用包模型或依赖数量无效',frappe.ValidationError)
    digest=content_hash(package)
    sources={}
    for model in models:
        if not isinstance(model,dict) or set(model)!={'id','definition'} or not isinstance(model['id'],str) or model['id'] in sources:
            frappe.throw('对象标识缺失或重复',frappe.ValidationError)
        sources[model['id']]=model['definition']
    # 与 prepare_object_change 使用相同的现有幂等键算法；重试同包重用已建对象。
    keys={source:'package:'+digest+':'+str(index) for index,source in enumerate(sources)}
    ids={source:app.name+'.object.'+content_hash([app.name,identity.identity_id,keys[source]])[:32] for source in sources}
    existing=frappe.get_all(MODEL,filters={'application':app.name},fields=['name','active_json','active_revision','revision'])
    if any(row.name not in ids.values() for row in existing):
        frappe.throw('目标包含其他数据表，请使用新建空应用',frappe.ValidationError)
    def remap(value):
        if isinstance(value,dict):return {key:remap(item) for key,item in value.items()}
        if isinstance(value,list):return [remap(item) for item in value]
        return ids.get(value,value) if isinstance(value,str) else value
    remaining=dict(sources);compiled={};steps=[]
    while remaining:
        progressed=False
        for source,definition in list(remaining.items()):
            if not isinstance(definition,dict) or not isinstance(definition.get('fields'),list):
                frappe.throw('对象定义无效',frappe.ValidationError)
            targets=[field.get('target') for field in definition['fields'] if isinstance(field,dict) and field.get('type') in {'reference','detail'}]
            if any(not isinstance(target,str) for target in targets):frappe.throw('关联目标格式无效',frappe.ValidationError)
            if any(target not in sources for target in targets):
                frappe.throw('关联必须包含在同一应用包中',frappe.ValidationError)
            if any(ids[target] not in compiled for target in targets):continue
            mapped=remap(definition)
            references={key:{'doctype':value['doctype']['name'],'kind':value['kind'],'revision':1} for key,value in compiled.items()}
            try:value=compile_object(app.name,ids[source],mapped,references)
            except ModelError as error:frappe.throw(str(error),frappe.ValidationError)
            roles=set(value['access']['read_roles']+value['access']['write_roles']+value['access'].get('recycle_roles',[]))
            for field in value['fields']:roles.update(field.get('read_roles',[])+field.get('write_roles',[]))
            if any(not frappe.db.exists('Role',{'name':role,'disabled':0}) for role in roles):
                frappe.throw('对象引用的角色未安装或已停用',frappe.ValidationError)
            prior=next((row for row in existing if row.name==ids[source] and row.active_revision),None)
            if prior and (prior.active_revision!=1 or prior.revision!=1 or json.loads(prior.active_json)!=value):
                frappe.throw('已导入对象被修改，禁止覆盖',frappe.ValidationError)
            compiled[ids[source]]=value
            steps.append({'object_id':ids[source],'idempotency_key':keys[source],'definition':mapped,'complete':bool(prior)})
            del remaining[source];progressed=True
        if not progressed:frappe.throw('对象关联存在循环，当前不支持导入',frappe.ValidationError)
    spec=remap(package['definition'])
    if not isinstance(spec,dict):frappe.throw('应用定义无效',frappe.ValidationError)
    if not isinstance(spec.get('bindings',[]),list):frappe.throw('资源引用必须为列表',frappe.ValidationError)
    for binding in spec.get('bindings',[]):
        if not isinstance(binding,dict):frappe.throw('资源引用格式无效',frappe.ValidationError)
        if binding.get('resource_id') in compiled:
            binding['owner_domain']=app.name;binding['version']='1'
    def lookup(object_id):
        if object_id not in compiled:frappe.throw('导入表单对象缺失',frappe.ValidationError)
        model=compiled[object_id]
        refs={key:value for key,value in compiled.items()}
        public={'id':object_id,'source':'managed','revision':1,'fields':model['fields'],'input_schema':record_schema(model,refs)}
        return public,model
    normalized,snapshot=_validate(spec,application_id=app.name,model_lookup=lookup)
    actual=[item for item in snapshot if item['owner_domain']!=app.name]
    if canonical_json(actual)!=canonical_json(deps):
        frappe.throw('代码域依赖版本或声明不匹配，请在目标安装对应版本',frappe.ValidationError)
    return {'checked':True,'package_hash':digest,'expected_revision':app.draft_revision,'definition':_logical(normalized),
            'models':steps,'dependencies':actual,'dependency_hash':content_hash(actual),'target':app.name,'business_data_included':False}


def configure(_action_id, payload, _context):
    if payload.get('dependency_hash'):
        _,dependencies=_validate(payload['definition'],application_id=payload['application_id'])
        current=content_hash([item for item in dependencies if item['owner_domain']!=payload['application_id']])
        if current!=payload['dependency_hash']:
            frappe.throw('依赖在预检后已变化，请重新检查',frappe.TimestampMismatchError)
    return save_application_draft(payload['application_id'], payload['definition'], payload['expected_revision'])
