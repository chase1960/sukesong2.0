"""文件中心域真实链回归；只允许独立自动回归站，不复用用户验收库。

覆盖验收-文件库首批纯后端项：(1) 域与动作注册，(2) 上传建文件+私有存储+版本1，
(3) 同名重传保留历史版本（文件库-05），(4) 格式/空内容拒绝（文件库-02），
(5) 元信息修改与目录/标签校验（文件库-01/03），(6) 回收恢复（文件库-09），
(7) 权限范围：在库全员可见、回收站限本人与管理员（文件库-08），
(8) 基础附件契约下载口：按记录读权限放行、未挂载文件拒绝，
(9) 域停用后业务拒绝（域级启停边界）。
"""
import os as _os, sys as _sys
_sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tests')
                if os.path.basename(os.path.dirname(os.path.abspath(__file__))) != 'tests'
                else os.path.dirname(os.path.abspath(__file__)))
import _ss_fixture  # noqa: E402  测试夹具默认归属（**不是产品默认**）
import base64
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else '').resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立自动回归站')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('数据库边界不匹配')

repo = Path(__file__).resolve().parents[2]
for app in ('shangshu_files', 'shangshu_core', 'shangshu_finance', 'shangshu_orders', 'shangshu_warehouse', 'shangshu_mail'):
    sys.path.insert(0, str(repo / 'frappe_apps' / app))
apps_txt = root / 'sites' / 'apps.txt'
installed = apps_txt.read_text().split()
if 'shangshu_files' not in installed:
    apps_txt.write_text('\n'.join(installed + ['shangshu_files']) + '\n')

import frappe  # noqa: E402

os.chdir(root / 'sites')
frappe.init(site='b-test.localhost', sites_path=str(root / 'sites'))
frappe.connect()
frappe.clear_cache()  # 迁移/重启后的正式 hook，包含基础附件的下载权限控制器。

from shangshu_core.public_api import execute_registered_action, list_domains, list_registered_actions, set_domain_enabled, query_dataset, invoke_domain_service, query_object_records, get_object_record  # noqa: E402
from shangshu_core.public_api import http as core_http  # noqa: E402
from shangshu_files import service  # noqa: E402

frappe.set_user('Administrator')
if 'shangshu_files' not in frappe.get_installed_apps():
    from frappe.installer import install_app  # noqa: E402
    install_app('shangshu_files', force=True)
frappe.reload_doc('shangshu_files', 'doctype', 'shangshu_file_directory', force=True)
frappe.reload_doc('shangshu_files', 'doctype', 'shangshu_file_center_file', force=True)
frappe.reload_doc('shangshu_files', 'doctype', 'shangshu_file_center_version', force=True)
from shangshu_files.install import setup  # noqa: E402
setup()
from shangshu_core.public_api import check_registered_manifests  # noqa: E402
check_registered_manifests()
frappe.db.commit()

checks = []


def check(label, condition, detail=''):
    checks.append((label, bool(condition), detail))
    if not condition:
        print(f'  ✗ {label} {detail}')


def act(action, payload):
    payload = _ss_fixture.fill(action, payload)  # 夹具默认归属（不是产品默认）
    return execute_registered_action(action, payload, True, frappe.generate_hash(length=24))


def _as_bytes(value):
    return value if isinstance(value, bytes) else str(value).encode()


def b64(data):
    return base64.b64encode(data).decode()


def rejected(label, operation):
    try:
        operation()
    except (frappe.PermissionError, frappe.ValidationError):
        check(label, True)
    else:
        check(label, False, '未拒绝')


created_files = []
existing_directories = set(frappe.get_all('Shangshu File Directory', pluck='name'))
worker = 'files-worker-' + frappe.generate_hash(length=6) + '@example.invalid'
try:
    print('[1] 域与动作注册')
    domains = {d['id']: d for d in list_domains(include_disabled=1)}
    check('文件中心域已注册且默认启用', domains.get('com.shangshu.files', {}).get('enabled') in (1, True))
    from shangshu_core.public_api import application_catalog
    check('领域应用首页使用同一文件工作面', next(a for a in application_catalog() if a['id'] == 'com.shangshu.files.center')['home'] == 'file-center')
    action_ids = {a['id'] for a in list_registered_actions()}
    check('来源附件统一归档动作已注册', 'files.import_attachment' in action_ids)
    tool_ids = {a['id'] for a in list_registered_actions(tools_only=True)}
    check('Agent复用审核、元信息与附件归档动作', {'files.review', 'files.update_meta', 'files.import_attachment'} <= tool_ids)
    check('不把文件内容Base64上传开放给Agent', 'files.upload' not in tool_ids)
    check('目录创建和重命名动作已注册', {'files.directory_create', 'files.directory_rename'} <= action_ids)
    check('目录访问范围动作已注册', 'files.directory_access' in action_ids)
    check('五个文件动作已注册', {'files.upload', 'files.new_version', 'files.update_meta', 'files.recycle', 'files.restore'} <= action_ids)

    print('[2] 上传建文件 + 私有存储 + 版本1')
    r1 = act('files.upload', {'file_name': '合作协议.txt', 'content_base64': b64('版本一内容'.encode()),
                              'directory': '/案件/CN1001', 'tags': ['合同'], 'note': '首版'})
    name1 = r1['result']['file']
    created_files.append(name1)
    doc = frappe.get_doc('Shangshu File Center File', name1)
    check('返回创建标记与版本号', r1['result'].get('created') == 1 and r1['result'].get('version') == 1)
    check('文件记录落库', doc.file_name == '合作协议.txt' and doc.directory == '/案件/CN1001' and doc.status == 'Active')
    check('内容入私有存储并挂载', doc.current_file and frappe.db.get_value('File', doc.current_file, 'is_private') == 1
          and frappe.db.get_value('File', doc.current_file, 'attached_to_name') == name1)
    check('版本行存在', frappe.db.exists('Shangshu File Center Version', {'file': name1, 'version_no': 1}))
    projection = get_object_record('files.file', name1)
    field = next(item for item in projection['object']['fields'] if item['id'] == 'version_count')
    check('公开元数据不得将内部游标误称版本数', field['label'] == '下一版本序号'
          and '不是版本数' in field.get('description', '') and 'files.versions' in field.get('description', ''))
    check('文件数据集保留兼容游标语义',
          next(row for row in query_dataset('files.file', {'file_name': '合作协议.txt'})['rows'] if row['name'] == name1)['version_count'] == 2)
    check('通用对象列表与详情的游标语义一致',
          query_object_records('files.file', {'file_name': '合作协议.txt'})['rows'][0]['version_count'] == projection['record']['version_count'] == 2)
    history = invoke_domain_service('files.versions', {'file': name1})
    check('当前固定版本使用已有版本服务而不是游标', history['file']['version'] == 1 and len(history['versions']) == 1)
    check('对外读取不改变内部版本分配序号', frappe.db.get_value('Shangshu File Center File', name1, 'version_count') == 2)

    print('[3] 同名重传保留历史版本')
    r2 = act('files.upload', {'file_name': '合作协议.txt', 'content_base64': b64('版本二内容'.encode()),
                              'directory': '/案件/CN1001', 'note': '重传'})
    check('重传返回同文件新版本', r2['result']['file'] == name1 and r2['result']['version'] == 2 and r2['result'].get('created') == 0)
    versions = frappe.get_all('Shangshu File Center Version', filters={'file': name1}, fields=['version_no', 'frappe_file'], order_by='version_no')
    check('两个版本都在', [v.version_no for v in versions] == [1, 2])
    history = invoke_domain_service('files.versions', {'file': name1})
    check('追加第二版后固定版本与历史一致而游标递增',
          history['file']['version'] == len(versions) == 2
          and get_object_record('files.file', name1)['record']['version_count'] == 3)
    v1_file = frappe.get_doc('File', versions[0].frappe_file)
    check('版本一内容未丢', _as_bytes(v1_file.get_content()) == '版本一内容'.encode())
    fixed = invoke_domain_service('files.versions', {'attachment': v1_file.name})
    check('固定附件能定位所属文件且不会替换为第二版', fixed['file']['name'] == name1
          and len(fixed['versions']) == 1 and fixed['versions'][0]['version_no'] == 1
          and fixed['versions'][0]['source']['file'] == v1_file.name)
    for payload in ({}, {'file': name1, 'attachment': v1_file.name}, {'attachment': ''}, {'attachment': '不存在的附件'}):
        rejected('固定附件定位拒绝空值双引用及未知引用', lambda payload=payload: invoke_domain_service('files.versions', payload))
    unrelated = frappe.get_doc('File', doc.current_file).create_attachment_copy('User', 'Administrator', ignore_permissions=True)
    try:
        rejected('非文件中心版本的其他记录附件不能定位', lambda: invoke_domain_service('files.versions', {'attachment': unrelated.name}))
    finally:
        frappe.delete_doc('File', unrelated.name, ignore_permissions=True, force=True)

    print('[3a] 来源附件受管归档、去重、权限与Agent确认')
    source_ref = {'ref_doctype': 'Shangshu File Center File', 'ref_name': name1, 'file': v1_file.name}
    import_payload = {'source': source_ref, 'directory': '/归档测试'}
    from shangshu_core.public_api import propose_registered_action, resolve_action_proposal
    before_import = frappe.db.count('Shangshu File Center File')
    proposal = propose_registered_action('files.import_attachment', import_payload, frappe.generate_hash(length=24))
    check('提案不提前归档', frappe.db.count('Shangshu File Center File') == before_import)
    resolve_action_proposal(proposal['id'], 'rejected')
    check('拒绝提案不产生文件', frappe.db.count('Shangshu File Center File') == before_import)
    proposal = propose_registered_action('files.import_attachment', import_payload, frappe.generate_hash(length=24))
    imported = resolve_action_proposal(proposal['id'], 'confirmed')['result']
    created_files.append(imported['file'])
    imported_doc = frappe.get_doc('Shangshu File Center File', imported['file'])
    check('确认后创建独立归档记录', imported_doc.directory == '/归档测试' and imported_doc.current_file != v1_file.name)
    check('归档字节与原附件一致', _as_bytes(frappe.get_doc('File', imported_doc.current_file).get_content()) == '版本一内容'.encode())
    again = act('files.import_attachment', import_payload)['result']
    check('跨请求重试同一来源不堆版本', again['file'] == imported['file'] and again['version'] == 1
          and frappe.db.get_value('Shangshu File Center File', imported['file'], 'version_count') == 2)
    rejected('伪造来源记录不能归档', lambda: act('files.import_attachment', {
        **import_payload, 'source': {**source_ref, 'ref_name': imported['file']}}))
    projection = invoke_domain_service('files.versions', {'file': imported['file']})
    check('版本读取公开可授权的内容引用', projection['versions'][0]['source']['ref_name'] == imported['file'])

    print('[4] 格式与内容校验')
    for label, payload in [
        ('拒绝不支持格式', {'file_name': '工具.exe', 'content_base64': b64(b'MZ')}),
        ('拒绝空内容', {'file_name': '空.txt', 'content_base64': b64(b'')}),
        ('拒绝非法 Base64', {'file_name': '坏.txt', 'content_base64': '!!!not-base64!!!'}),
        ('拒绝摘要不匹配', {'file_name': '摘要.txt', 'content_base64': b64(b'abc'), 'file_sha256': 'deadbeef'}),
        ('拒绝路径分隔符文件名', {'file_name': '../逃逸.txt', 'content_base64': b64(b'x')}),
    ]:
        try:
            act('files.upload', payload)
            check(label, False, '未拒绝')
        except Exception as error:
            check(label, 'ValidationError' in frappe.get_traceback() or 'ValidationError' in str(type(error)), str(error)[:60])

    # 与交付手册要求的站点限额一致；仅临时覆盖本隔离请求的配置，不改验收站。
    configured_limit = frappe.conf.get('max_file_size')
    try:
        frappe.conf.max_file_size = service.MAX_FILE_BYTES
        boundary = act('files.upload', {'file_name': '大小边界-'+frappe.generate_hash(length=8)+'.txt',
            'content_base64': b64(b'x' * service.MAX_FILE_BYTES)})['result']['file']
        created_files.append(boundary)
        check('恰好20MiB原件经真实私有File存储成功', frappe.db.get_value('Shangshu File Center File', boundary, 'current_size') == service.MAX_FILE_BYTES)
        rejected('超过20MiB一字节拒绝', lambda: act('files.upload', {'file_name': '超限.txt', 'content_base64': b64(b'x' * (service.MAX_FILE_BYTES + 1))}))
    finally:
        frappe.conf.max_file_size = configured_limit

    print('[5] 元信息修改与校验')
    act('files.upload', {'file_name': '占用.txt', 'content_base64': b64(b'other'), 'directory': '/案件/CN1001'})
    sibling = frappe.db.get_value('Shangshu File Center File', {'file_name': '占用.txt'}, 'name')
    created_files.append(sibling)
    act('files.update_meta', {'file': name1, 'tags': ['合同', '重要'], 'note': '改注', 'directory': '/案件/CN1002'})
    check('目录/标签/备注更新', frappe.db.get_value('Shangshu File Center File', name1, 'directory') == '/案件/CN1002'
          and json.loads(frappe.db.get_value('Shangshu File Center File', name1, 'tags_json')) == ['合同', '重要'])
    try:
        act('files.update_meta', {'file': sibling, 'directory': '/案件/CN1002'})
        act('files.update_meta', {'file': name1, 'file_name': '占用.txt'})
        check('同目录改名冲突被拒', False, '未拒绝')
    except Exception:
        check('同目录改名冲突被拒', True)
    try:
        act('files.update_meta', {'file': name1, 'directory': '没有斜杠'})
        check('非法目录被拒', False, '未拒绝')
    except Exception:
        check('非法目录被拒', True)

    print('[6] 回收与恢复')
    act('files.recycle', {'file': sibling})
    check('回收站状态', frappe.db.get_value('Shangshu File Center File', sibling, 'status') == 'Recycled')
    recycled_attachment = frappe.db.get_value('Shangshu File Center File', sibling, 'current_file')
    rejected('本人或管理员也不能将回收文件定位为邮件附件', lambda: invoke_domain_service('files.versions', {'attachment': recycled_attachment}))
    act('files.restore', {'file': sibling})
    check('恢复在库', frappe.db.get_value('Shangshu File Center File', sibling, 'status') == 'Active')

    print('[7] 权限范围：在库共享、回收站限本人')
    if not frappe.db.exists('User', worker):
        frappe.get_doc({'doctype': 'User', 'email': worker, 'first_name': '文件回归员',
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    frappe.set_user(worker)
    visible = {row['name'] for row in query_dataset('files.file', {}, 1, 50)['rows']}
    check('普通用户可见在库文件', name1 in visible)
    own = act('files.upload', {'file_name': '员工自传.txt', 'content_base64': b64(b'own'), 'directory': '/员工区'})
    own_name = own['result']['file']
    created_files.append(own_name)
    act('files.recycle', {'file': own_name})
    check('自己的文件可回收', frappe.db.get_value('Shangshu File Center File', own_name, 'status') == 'Recycled')
    visible2 = {row['name'] for row in query_dataset('files.file', {}, 1, 50)['rows']}
    check('回收后本人可见、他人不可见', own_name in visible2 and name1 in visible2)
    try:
        act('files.recycle', {'file': name1})
        check('不能回收他人文件', False, '未拒绝')
    except Exception:
        check('不能回收他人文件', True)
    frappe.set_user('Administrator')
    visible3 = {row['name'] for row in query_dataset('files.file', {}, 1, 50)['rows']}
    check('管理员可见回收站', name1 in visible3 and own_name in visible3)
    act('files.restore', {'file': name1})

    print('[8] 基础附件契约下载口')
    frappe.set_user(worker)
    current = frappe.db.get_value('Shangshu File Center File', name1, 'current_file')
    frappe.local.response = frappe._dict()
    core_http.file_content('Shangshu File Center File', name1, current)
    check('有读权限可取内容', _as_bytes(frappe.local.response.get('filecontent')) == '版本二内容'.encode())
    frappe.local.response = frappe._dict()
    try:
        core_http.file_content('Shangshu File Center File', name1, '未挂载的文件名')
        check('未挂载文件拒绝', False, '未拒绝')
    except Exception:
        check('未挂载文件拒绝', True)
    frappe.set_user('Administrator')

    print('[9] 域停用后业务拒绝')
    set_domain_enabled('com.shangshu.files', 0, '回归停用')
    try:
        act('files.upload', {'file_name': '停用后.txt', 'content_base64': b64(b'x')})
        check('停用后上传拒绝', False, '未拒绝')
    except Exception as error:
        check('停用后上传拒绝', 'PermissionError' in str(type(error)) or '停用' in str(error))
    set_domain_enabled('com.shangshu.files', 1, '回归恢复')
    r9 = act('files.upload', {'file_name': '恢复后.txt', 'content_base64': b64(b'ok')})
    created_files.append(r9['result']['file'])
    check('恢复后可再上传', frappe.db.exists('Shangshu File Center File', r9['result']['file']))

    print('[10] 所有版本入口统一权限与状态；移动/恢复校验目标冲突')
    other = act('files.upload', {'file_name': '同名.txt', 'directory': '/冲突/甲', 'content_base64': b64(b'A')})['result']['file']
    created_files.append(other)
    destination = act('files.upload', {'file_name': '同名.txt', 'directory': '/冲突/乙', 'content_base64': b64(b'B')})['result']['file']
    created_files.append(destination)
    rejected('只移动目录也拒绝目标同名冲突', lambda: act('files.update_meta', {'file': other, 'directory': '/冲突/乙'}))
    check('失败移动保留原目录', frappe.db.get_value('Shangshu File Center File', other, 'directory') == '/冲突/甲')
    rejected('同时改名和目录按最终路径检查', lambda: act('files.update_meta', {'file': other, 'directory': '/冲突/乙', 'file_name': '同名.txt'}))
    act('files.recycle', {'file': destination})
    replacement = act('files.upload', {'file_name': '同名.txt', 'directory': '/冲突/乙', 'content_base64': b64(b'C')})['result']['file']
    created_files.append(replacement)
    rejected('恢复时拒绝已有同名文件', lambda: act('files.restore', {'file': destination}))
    check('恢复失败仍在回收站', frappe.db.get_value('Shangshu File Center File', destination, 'status') == 'Recycled')

    frappe.set_user(worker)
    before = frappe.db.get_value('Shangshu File Center File', name1, 'version_count')
    rejected('同名上传不能绕过他人文件写权限', lambda: act('files.upload', {'file_name': '合作协议.txt', 'directory': '/案件/CN1002', 'content_base64': b64(b'not mine')}))
    check('拒绝后他人文件版本不变', frappe.db.get_value('Shangshu File Center File', name1, 'version_count') == before)
    rejected('回收站新版本不得偷偷恢复', lambda: act('files.new_version', {'file': own_name, 'content_base64': b64(b'not restored')}))
    check('新版本拒绝后仍在回收站', frappe.db.get_value('Shangshu File Center File', own_name, 'status') == 'Recycled')
    rejected('他人回收文件版本服务不得泄露引用', lambda: invoke_domain_service('files.versions', {'file': destination}))
    readable = invoke_domain_service('files.versions', {'file': name1})
    check('在库有权限版本服务仍可用', bool(readable.get('versions')))
    hidden_version = frappe.db.get_value('Shangshu File Center Version', {'file': destination}, 'name')
    rejected('直读版本 DocType 也遵守父文件权限', lambda: frappe.get_doc('Shangshu File Center Version', hidden_version).check_permission('read'))
    version_rows = frappe.get_list('Shangshu File Center Version', fields=['name'], limit_page_length=10000)
    check('版本 DocType 列表不泄露他人回收版本', hidden_version not in {row.name for row in version_rows})

    print('[11] 服务端范围、搜索、标签与分页')
    rows = query_dataset('files.file', {'q': '重要'}, 1, 20)['rows']
    check('标签搜索返回声明的显示标签', any(row['name'] == name1 and row.get('tags') == '合同；重要' for row in rows))
    mine = query_dataset('files.file', {'scope': 'mine'}, 1, 100)
    check('我的上传使用当前 Frappe 身份且排除回收站', not mine['rows'])
    trash = query_dataset('files.file', {'scope': 'trash'}, 1, 100)
    check('回收范围不泄露别人的文件', {row['name'] for row in trash['rows']} == {own_name})
    rejected('不得传入任意查询操作符', lambda: query_dataset('files.file', {'q': ['!=', '']}, 1, 20))
    frappe.set_user('Administrator')
    for index in range(105):
        fixture = frappe.get_doc({'doctype': 'Shangshu File Center File', 'file_name': f'分页-{index:03}.txt',
                                  'directory': '/分页', 'tags_json': '["翻页"]', 'status': 'Active'}).insert(ignore_permissions=True)
        created_files.append(fixture.name)
    first = query_dataset('files.file', {'q': '分页-', 'scope': 'all'}, 1, 100)
    second = query_dataset('files.file', {'q': '分页-', 'scope': 'all'}, 2, 100)
    check('超过百条的总数与第二页准确', first['total'] == 105 and len(first['rows']) == 100 and second['total'] == 105 and len(second['rows']) == 5)
    check('相同更新时间下分页顺序稳定不重复', not ({r['name'] for r in first['rows']} & {r['name'] for r in second['rows']}))
    missing = query_dataset('files.file', {'q': '绝不匹配的关键词'}, 1, 20)
    check('无匹配总数为零', missing['total'] == 0 and not missing['rows'])
    typed = query_dataset('files.file', {'q': '分页-', 'kind': '文档'}, 1, 20)
    check('文件类型与关键词组合筛选', typed['total'] == 105 and query_dataset('files.file', {'q': '分页-', 'kind': '图片'}, 1, 20)['total'] == 0)
    first_fixture = first['rows'][0]['name']
    act('files.update_meta', {'file': first_fixture, 'file_name': '百分之100%.csv'})
    check('改名自动同步文件类型', frappe.db.get_value('Shangshu File Center File', first_fixture, 'file_kind') == '表格')
    wildcard = query_dataset('files.file', {'q': '分页-00_'}, 1, 20)
    check('文本查询保留 Frappe LIKE 通配符语义', wildcard['total'] in (9, 10))
    old_modified = frappe.db.get_value('Shangshu File Center File', first_fixture, 'modified')
    frappe.db.set_value('Shangshu File Center File', first_fixture, 'file_kind', None, update_modified=False)
    setup()
    check('升级补齐类型不修改业务修改时间', frappe.db.get_value('Shangshu File Center File', first_fixture, ['file_kind', 'modified']) == ('表格', old_modified))

    print('[12] 数据库位置与版本唯一约束')
    source = frappe.get_doc('Shangshu File Center File', name1)
    def duplicate_location(filename):
        duplicate = frappe.get_doc({'doctype': source.doctype, 'file_name': filename,
                                   'directory': source.directory, 'status': 'Active'}).insert(ignore_permissions=True)
        created_files.append(duplicate.name)
    rejected('绕过服务层查询仍不能产生同位置文件', lambda: duplicate_location(source.file_name))
    rejected('同位置大小写按数据库规则一致拒绝', lambda: duplicate_location(source.file_name.upper()))
    version = frappe.get_all('Shangshu File Center Version', filters={'file': name1}, fields=['version_no','frappe_file'],limit=1)[0]
    def duplicate_version():
        frappe.get_doc({'doctype':'Shangshu File Center Version','file':name1,
                        'version_no':version.version_no,'frappe_file':version.frappe_file}).insert(ignore_permissions=True)
    rejected('同一文件版本号不能重复', duplicate_version)

    # 旧数据模拟只绕过本测试夹具的 validate，不取消数据库唯一索引。
    from unittest.mock import patch
    from shangshu_files.location import ensure_constraints
    from shangshu_files.shangshu_files.doctype.shangshu_file_center_file.shangshu_file_center_file import ShangshuFileCenterFile
    with patch.object(ShangshuFileCenterFile, 'validate', lambda self: None):
        legacy = frappe.get_doc({'doctype':source.doctype,'file_name':source.file_name,
                                 'directory':source.directory,'status':'Active','location_slot':'legacy-fixture'}).insert(ignore_permissions=True)
    created_files.append(legacy.name)
    before = frappe.db.get_value(source.doctype, source.name, ['owner','modified','current_file'])
    rejected('升级发现历史同名歧义时中止，不静默合并', ensure_constraints)
    check('拒绝升级不改变原件及重复夹具', frappe.db.exists(source.doctype, legacy.name) and frappe.db.get_value(source.doctype, source.name, ['owner','modified','current_file']) == before)
    frappe.delete_doc(source.doctype, legacy.name, force=True, ignore_permissions=True)
    frappe.db.set_value(source.doctype, source.name, 'location_slot', None, update_modified=False)
    ensure_constraints()
    check('旧槽位回填不改归属、修改时间与版本', frappe.db.get_value(source.doctype, source.name, 'location_slot') == 'active' and frappe.db.get_value(source.doctype, source.name, ['owner','modified','current_file']) == before)

    print('[13] 两连接真实并发')
    import threading
    def interleave(label, main_operation, other_operation, expected='rejected', other_user='Administrator'):
        frappe.db.commit()
        ready, start, done = threading.Event(), threading.Event(), threading.Event()
        outcomes = []
        def run_other():
            frappe.init(site='b-test.localhost',sites_path=str(root/'sites'));frappe.connect();frappe.set_user(other_user)
            try:
                frappe.db.count('Shangshu File Center File')  # 提前建立旧快照。
                ready.set()
                if not start.wait(10):raise RuntimeError('并发测试未放行')
                other_operation()
                if expected=='saved':frappe.db.commit()
                outcomes.append('saved')
            except frappe.ValidationError as error:
                outcomes.append('rejected')
                check(label+'：冲突提示可理解', '本次没有覆盖' in str(error), str(error))
            except frappe.PermissionError:
                outcomes.append('permission_denied')
            except Exception as error:outcomes.append(type(error).__name__+':'+str(error))
            finally:frappe.db.rollback();frappe.destroy();done.set()
        thread=threading.Thread(target=run_other,daemon=True);thread.start()
        try:
            if not ready.wait(10):raise RuntimeError('并发连接未就绪')
            main_operation();start.set()
            check(label+'：竞争写等待提交', not done.wait(.2))
            frappe.db.commit();thread.join(10)
            check(label+'：结果符合约束', done.is_set() and outcomes==[expected],str(outcomes))
        finally:start.set();frappe.db.rollback();thread.join(10)
    race_dir='/并发-'+frappe.generate_hash(length=10)
    def upload_race():
        result=act('files.upload',{'file_name':'并发.txt','directory':race_dir,'content_base64':b64(b'first')})
        created_files.append(result['result']['file'])
    interleave('同时上传同位置文件',upload_race,lambda:act('files.upload',{'file_name':'并发.TXT','directory':race_dir,'content_base64':b64(b'second')}))
    target=frappe.get_all(source.doctype,filters={'directory':race_dir,'status':'Active'},pluck='name')
    check('并发上传只留一个文件和版本',len(target)==1 and frappe.db.count('Shangshu File Center Version',{'file':target[0]})==1)
    race_file=target[0]
    interleave('同文件并发新增版本',lambda:act('files.new_version',{'file':race_file,'content_base64':b64(b'version2')}),lambda:act('files.new_version',{'file':race_file,'content_base64':b64(b'version3')}),'saved')
    check('父文件锁保护连续版本不覆盖',frappe.get_all('Shangshu File Center Version',filters={'file':race_file},pluck='version_no',order_by='version_no asc')==[1,2,3])
    moving=act('files.upload',{'file_name':'移动.txt','directory':race_dir,'content_base64':b64(b'moving')})['result']['file'];created_files.append(moving)
    interleave('两个文件同时移到空位置',lambda:act('files.update_meta',{'file':race_file,'file_name':'目标.txt'}),lambda:act('files.update_meta',{'file':moving,'file_name':'目标.txt'}))
    check('失败移动保留原位置',frappe.db.get_value(source.doctype,moving,'file_name')=='移动.txt')
    act('files.recycle',{'file':race_file})
    replacement=act('files.upload',{'file_name':'目标.txt','directory':race_dir,'content_base64':b64(b'replacement')})['result']['file'];created_files.append(replacement)
    act('files.recycle',{'file':replacement})
    interleave('两个同名回收文件同时恢复',lambda:act('files.restore',{'file':race_file}),lambda:act('files.restore',{'file':replacement}))
    check('失败恢复仍留回收站并保留原版本',frappe.db.get_value(source.doctype,replacement,'status')=='Recycled' and frappe.db.count('Shangshu File Center Version',{'file':race_file})==3)

    from frappe.model.document import Document
    original_insert = Document.insert
    def fail_audit(doc,*args,**kwargs):
        if doc.doctype=='Shangshu Action Execution Audit':
            frappe.throw('验收模拟审计失败',frappe.ValidationError)
        return original_insert(doc,*args,**kwargs)
    before = frappe.db.get_value(source.doctype,race_file,['current_file','version_count','modified'])
    attached = frappe.db.count('File',{'attached_to_doctype':source.doctype,'attached_to_name':race_file})
    with patch.object(Document,'insert',fail_audit):
        rejected('新版本审计失败时整次动作拒绝',lambda:act('files.new_version',{'file':race_file,'content_base64':b64(b'audit-failure-do-not-retain')}))
    check('失败版本不改当前指针、版本数量与修改时间',frappe.db.get_value(source.doctype,race_file,['current_file','version_count','modified'])==before and frappe.db.count('Shangshu File Center Version',{'file':race_file})==3)
    check('失败版本不残留额外挂载文件记录',frappe.db.count('File',{'attached_to_doctype':source.doctype,'attached_to_name':race_file})==attached)

    print('[14] 空目录、重命名与稳定归位')
    metadata = invoke_domain_service('files.versions', {'file':race_file})['file']
    check('详情声明修订与当前身份写权限',metadata['can_edit'] and metadata['metadata_revision'] and metadata['modified'])
    receipt=act('files.update_meta',{'file':race_file,'note':'单字段保存','expected_modified':metadata['modified']})['result']
    check('元信息回执可核对值和修订',receipt['record']['note']=='单字段保存' and receipt['record']['modified']!=metadata['modified'])
    rejected('过期文件修订拒绝覆盖',lambda:act('files.update_meta',{'file':race_file,'note':'旧窗口','expected_modified':metadata['modified']}))
    folder = act('files.directory_create', {'title': '目录-'+frappe.generate_hash(length=8)})['result']
    child = act('files.directory_create', {'parent': folder['directory'], 'title': '官文'})['result']
    dirs = invoke_domain_service('files.directories', {})
    check('空目录无需上传即可查询', any(r['name']==child['directory'] for r in dirs['directories']))
    entry = act('files.upload', {'directory_id': child['directory'], 'file_name': '目录附件.txt', 'content_base64': b64(b'directory-version')})['result']['file']
    created_files.append(entry)
    kept = frappe.db.get_value(source.doctype, entry, ['current_file', 'owner', 'modified', 'version_count'])
    old_path = child['path']
    renamed = act('files.directory_rename', {'directory': folder['directory'], 'title': '更名-'+frappe.generate_hash(length=8), 'expected_modified': folder['modified']})['result']
    check('重命名递归更新目录及文件路径', frappe.db.get_value(source.doctype, entry, 'directory') == renamed['path']+'/官文')
    check('重命名不改文件ID版本属主和内容时间', frappe.db.get_value(source.doctype, entry, ['current_file','owner','modified','version_count']) == kept)
    check('旧路径不残留目录副本', not frappe.db.exists('Shangshu File Directory', {'path':old_path}))
    rejected('过期目录修订不能覆盖', lambda: act('files.directory_rename', {'directory':folder['directory'],'title':'不覆盖','expected_modified':folder['modified']}))
    rejected('稳定编号与旧路径不一致拒绝', lambda: act('files.upload', {'directory_id':child['directory'],'directory':old_path,'file_name':'错位.txt','content_base64':b64(b'x')}))
    act('files.recycle', {'file':entry})
    renamed2 = act('files.directory_rename', {'directory':folder['directory'],'title':'回收后更名-'+frappe.generate_hash(length=6),'expected_modified':renamed['modified']})['result']
    act('files.restore', {'file':entry})
    check('回收文件恢复到同一目录的新路径', frappe.db.get_value(source.doctype, entry, ['directory_id','directory'])==(child['directory'],renamed2['path']+'/官文'))
    act('files.update_meta', {'file':entry,'directory_id':folder['directory']})
    check('移动只改目录引用不复制版本', frappe.db.get_value(source.doctype,entry,'directory_id')==folder['directory'] and frappe.db.count('Shangshu File Center Version',{'file':entry})==1)
    before_folder = frappe.db.get_value('Shangshu File Directory',folder['directory'],['path','modified'])
    with patch.object(Document,'insert',fail_audit):
        rejected('目录改名审计失败拒绝', lambda:act('files.directory_rename',{'directory':folder['directory'],'title':'不能落库','expected_modified':renamed2['modified']}))
    check('目录及文件投影与审计同回滚', frappe.db.get_value('Shangshu File Directory',folder['directory'],['path','modified'])==before_folder and frappe.db.get_value(source.doctype,entry,'directory')==renamed2['path'])
    rejected('根目录不可改名',lambda:act('files.directory_rename',{'directory':'files-root','title':'新根','expected_modified':renamed2['modified']}))
    rejected('同父目录重名拒绝',lambda:act('files.directory_create',{'parent':folder['directory'],'title':'官文'}))
    from shangshu_files.directories import migrate
    old_refs = frappe.db.get_value(source.doctype,entry,['directory_id','owner','modified'])
    migrate();migrate()
    check('目录迁移可重复且不改归属和时间',frappe.db.get_value(source.doctype,entry,['directory_id','owner','modified'])==old_refs)
    def concurrent_upload():
        created_files.append(act('files.upload',{'directory_id':child['directory'],'file_name':'并发目录归位.txt','content_base64':b64(b'keep-reference')})['result']['file'])
    interleave('目录改名期间按稳定ID上传',lambda:act('files.directory_rename',{'directory':folder['directory'],'title':'并发更名-'+folder['directory'],'expected_modified':renamed2['modified']}),concurrent_upload,'saved')
    check('等待改名的上传落到最新目录而非旧路径',frappe.db.get_value(source.doctype,created_files[-1],'directory')==frappe.db.get_value('Shangshu File Directory',child['directory'],'path'))
    frappe.set_user(worker)
    rejected('普通员工不能管理目录', lambda:act('files.directory_create',{'title':'越权目录'}))
    frappe.set_user('Administrator')
    print('[15] 目录权限贯穿查询、版本、原件及写操作')
    from shangshu_core.public_api import get_identity
    worker_id = get_identity(worker).identity_id
    act('platform.identity.group', {'email':worker,'collaboration_group':'财务'})
    def access_for(directory, mode='restricted', identities=None, groups=None):
        return act('files.directory_access', {'directory':directory,'mode':mode,'identities':identities or [],'groups':groups or [],
                   'expected_modified':str(frappe.db.get_value('Shangshu File Directory',directory,'modified'))})['result']
    access_for(folder['directory'])
    frappe.set_user(worker)
    listed=invoke_domain_service('files.directories',{})['directories']
    check('未授权者目录列表不泄露子目录',not any(d['name'] in (folder['directory'],child['directory']) for d in listed))
    found=query_dataset('files.file',{'directory_id':folder['directory']},1,20)
    check('受限文件在列表和计数都不可见',found['total']==0 and not found['rows'])
    check('受限文件关键词搜索不泄露记录',not query_dataset('files.file',{'q':'目录附件'},1,20)['rows'])
    rejected('未授权不能读取版本详情',lambda:invoke_domain_service('files.versions',{'file':entry}))
    restricted_blob=frappe.db.get_value(source.doctype,entry,'current_file')
    rejected('固定附件定位遵守他人受限目录权限', lambda: invoke_domain_service('files.versions', {'attachment': restricted_blob}))
    rejected('未授权旧附件下载链接拒绝',lambda:core_http.file_content(source.doctype,entry,restricted_blob))
    rejected('未授权不能向目录上传',lambda:act('files.upload',{'directory_id':child['directory'],'file_name':'拒绝.txt','content_base64':b64(b'x')}))
    restricted_path=frappe.db.get_value('Shangshu File Directory',child['directory'],'path')
    rejected('旧路径上传不能绕过目录权限',lambda:act('files.upload',{'directory':restricted_path,'file_name':'拒绝.txt','content_base64':b64(b'x')}))
    rejected('普通员工不能设置目录权限',lambda:access_for(folder['directory'],identities=[worker_id]))
    check('其他共享文件仍正常可读',bool(invoke_domain_service('files.versions',{'file':name1})['versions']))
    frappe.set_user('Administrator')
    allowed_receipt=access_for(folder['directory'],groups=['财务'])
    rejected('过期权限修订不能覆盖',lambda:act('files.directory_access',{'directory':folder['directory'],'mode':'inherit','groups':[],'identities':[],'expected_modified':'2000-01-01'}))
    rejected('不存在的身份不可授权',lambda:access_for(folder['directory'],identities=['unknown-identity']))
    frappe.set_user(worker)
    check('组授权继承到子目录',any(d['name']==child['directory'] for d in invoke_domain_service('files.directories',{})['directories']))
    check('组授权后可读文件及原件',bool(invoke_domain_service('files.versions',{'file':entry})['versions']))
    core_http.file_content(source.doctype,entry,restricted_blob)
    check('授权下载内容一致',_as_bytes(frappe.local.response.get('filecontent'))==b'directory-version')
    rejected('目录可见不自动增加他人文件写权限',lambda:act('files.update_meta',{'file':entry,'note':'不能改他人'}))
    act('files.restore',{'file':own_name})
    act('files.update_meta',{'file':own_name,'directory_id':child['directory']})
    frappe.set_user('Administrator')
    act('platform.identity.group',{'email':worker,'collaboration_group':'开发'})
    frappe.set_user(worker)
    rejected('离组后文件属主也不能绕过目录读取',lambda:invoke_domain_service('files.versions',{'file':own_name}))
    own_blob=frappe.get_doc('File',frappe.db.get_value(source.doctype,own_name,'current_file'))
    check('离组后私有文件直链不能按上传人绕过目录权限',not own_blob.is_downloadable())
    from frappe.core.doctype.file.utils import find_file_by_url
    check('Frappe私有直链查找器同样拒绝旧URL',find_file_by_url(own_blob.file_url,name=own_blob.name) is None)
    rejected('离组后文件属主不能上传新版本',lambda:act('files.new_version',{'file':own_name,'content_base64':b64(b'no')}))
    rejected('离组后文件属主不能移出受限目录',lambda:act('files.update_meta',{'file':own_name,'directory_id':'files-root'}))
    frappe.set_user('Administrator')
    access_for(child['directory'],identities=[worker_id])
    frappe.set_user(worker)
    rejected('子目录单独授权不能放开父级限制',lambda:invoke_domain_service('files.versions',{'file':own_name}))
    frappe.set_user('Administrator')
    access_for(folder['directory'],identities=[worker_id])
    frappe.set_user(worker)
    check('稳定身份授权不依赖当前分组',bool(invoke_domain_service('files.versions',{'file':own_name})['versions']))
    check('授权后同一私有URL恢复可用',find_file_by_url(own_blob.file_url,name=own_blob.name) is not None)
    frappe.set_user('Administrator')
    before_access=frappe.db.get_value('Shangshu File Directory',folder['directory'],['allowed_identities_json','modified'])
    with patch.object(Document,'insert',fail_audit):
        rejected('权限审计失败不能留下授权变更',lambda:access_for(folder['directory']))
    check('权限和审计整体回滚',frappe.db.get_value('Shangshu File Directory',folder['directory'],['allowed_identities_json','modified'])==before_access)
    migrate();migrate()
    check('重复迁移不清空目录授权',frappe.db.get_value('Shangshu File Directory',folder['directory'],['allowed_identities_json','modified'])==before_access)
    options=invoke_domain_service('files.directories',{})
    check('管理员可读取当前授权与公共人员选项',options['access_options']['version']==1 and any(p['identity_id']==worker_id for p in options['access_options']['people']))
    frappe.set_user(worker)
    personal=invoke_domain_service('files.directories',{})
    check('普通目录列表不附授权配置与人员选项','access_options' not in personal and all('access' not in d for d in personal['directories']))
    frappe.set_user('Administrator')
    original_versions=frappe.db.get_value(source.doctype,own_name,'version_count')
    interleave('撤销目录权限与旧快照写入竞争',lambda:access_for(folder['directory']),
               lambda:act('files.new_version',{'file':own_name,'content_base64':b64(b'blocked-old-snapshot')}),
               'permission_denied',worker)
    check('撤销权限后等待中的旧窗口未产生新版本',frappe.db.get_value(source.doctype,own_name,'version_count')==original_versions)
finally:
    frappe.set_user('Administrator')
    for name in created_files:
        if frappe.db.exists('Shangshu File Center File', name):
            for v in frappe.get_all('Shangshu File Center Version', filters={'file': name}, fields=['name', 'frappe_file']):
                frappe.delete_doc('Shangshu File Center Version', v.name, force=True, ignore_permissions=True)
                frappe.delete_doc('File', v.frappe_file, force=True, ignore_permissions=True)
            frappe.delete_doc('Shangshu File Center File', name, force=True, ignore_permissions=True)
    if frappe.db.exists('User', worker):
        frappe.delete_doc('User', worker, force=True, ignore_permissions=True)
    for row in frappe.get_all('Shangshu File Directory', fields=['name', 'path'], order_by='path desc'):
        if row.name not in existing_directories:
            frappe.delete_doc('Shangshu File Directory', row.name, force=True, ignore_permissions=True)
    frappe.db.commit()
    frappe.destroy()

failed = [c for c in checks if not c[1]]
print(f"通过 {len(checks) - len(failed)}/{len(checks)}")
for label, ok, detail in failed:
    print(f"  失败：{label} {detail}")
sys.exit(1 if failed else 0)
