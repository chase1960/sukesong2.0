"""仅隔离测试站运行；合成日志全部回滚，不进入用户验收库。"""
def run():
    import frappe
    import time
    from shangshu_core.identity import get_identity
    from shangshu_core.conversation_evidence import issue_conversation, conversation_scope
    from shangshu_core.unified_log import write_log
    from shangshu_core.receipts import query_conversation_context, query_action_audits
    from shangshu_core.log_query_storage import ensure_log_query_storage
    frappe.set_user('Administrator')
    from frappe.utils.password import get_encryption_key
    get_encryption_key()
    identity=get_identity()
    first=issue_conversation();second=issue_conversation()
    try:
        saved=[]
        for i in range(12):
            with conversation_scope(first['credential']):
                saved.append(write_log('action','synthetic.conversation',actor_identity=identity.name,
                    result='Succeeded',detail={'legacy':{'input_summary_json':'{"synthetic":true}'}}))
        with conversation_scope(second['credential']):
            other=write_log('action','synthetic.other',actor_identity=identity.name,result='Succeeded')
        t=time.perf_counter()
        window=query_conversation_context(first['conversation_key'],saved[6].name,4,4)
        assert len(window['items'])==9
        assert [x['audit'] for x in window['items']]==[d.name for d in sorted(saved,key=lambda d:(d.creation,d.name))][2:11]
        assert other.name not in [x['audit'] for x in window['items']]
        rows=query_action_audits({'conversation_key':first['conversation_key']})
        assert rows['total']==12 and all(r['conversation_evidence']['status']=='linked' for r in rows['items'])
        elapsed=(time.perf_counter()-t)*1000
        try:
            query_conversation_context(first['conversation_key'],other.name)
            raise AssertionError('foreign anchor accepted')
        except frappe.PermissionError:
            pass
        plan=frappe.db.sql('EXPLAIN SELECT name FROM `tabShangshu Unified Log` WHERE conversation_key=%s AND what_kind=%s AND actor_identity=%s AND creation>%s ORDER BY creation,name LIMIT 4',
                          (first['conversation_key'],'action',identity.name,saved[0].creation),as_dict=True)
        assert plan[0]['key']=='ssq_conversation_v1',plan
        result={'passed':True,'window_count':9,'filtered_count':12,'window_and_list_ms':round(elapsed,2),'explain':plan}
    finally:
        frappe.db.rollback()
    result['repeat_migration']=ensure_log_query_storage()
    return result


def seed_http_fixture():
    import frappe
    from shangshu_core.public_api import create_application_definition, execute_registered_action
    from shangshu_core.identity import get_identity
    from shangshu_core.conversation_evidence import issue_conversation, conversation_scope
    frappe.set_user('Administrator')
    identity=get_identity()
    app=create_application_definition('PKG-134 合成HTTP测试',frappe.generate_hash(length=24))
    issued=issue_conversation()
    request='pkg134-'+frappe.generate_hash(length=24)
    with conversation_scope(issued['credential']):
        result=execute_registered_action('platform.application.inspect',{'application_id':app['id']},idempotency_key=request,source='ai-chat')
    frappe.db.commit()
    return {'conversation_key':issued['conversation_key'],'audit':result['audit'],
            'request_id':request,'action_id':'platform.application.inspect','actor_user':identity.user,
            'collaboration_key':identity.collaboration_key,'conversation_id':identity.collaboration_key+':pkg134-http-'+request}
