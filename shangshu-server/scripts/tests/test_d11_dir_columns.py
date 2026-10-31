"""UI002 directory facts, counts, split classification and actual writes over BFF.

SS_BASE=http://127.0.0.1:3850 python3 shangshu-server/scripts/tests/test_d11_dir_columns.py --execute-live
Uses this run's synthetic users, never a pre-existing tester account. All failures,
including prerequisites and cleanup failures, produce nonzero exit. No browser claim.
"""
import base64
import sys
from test_e01_role_matrix import Fixture, result, successful, denied


def main():
    f = Fixture('directory', ('owner', 'reader'))
    try:
        f.setup()
        owner, reader = f.clients['owner'], f.clients['reader']
        tables = [f.upload('owner', str(i), {'level': 'personal', 'owner_user': f.users['owner']})
                  for i in range(3)]
        uploaded = f.action(owner, 'files.upload', {
            'file_name': f.prefix + '-document.txt',
            'content_base64': base64.b64encode(b'isolated directory fixture').decode(),
            'attribution': {'level': 'personal', 'owner_user': f.users['owner']}})
        f.check('UI002 ordinary file uploaded', successful(uploaded))
        document = result(uploaded).get('file')
        for file in [*tables, document]:
            if not file: raise RuntimeError('missing synthetic file')
            f.check('read share ' + file, successful(f.action(owner, 'platform.org.share_grant', {
                'resource': file, 'user': f.users['reader'], 'access': 'read'})))
        table = tables[0]
        owner_response, reader_response = f.listing(owner), f.listing(reader)
        f.check('UI002 two ordinary users list via real HTTP',
                successful(owner_response) and successful(reader_response))
        owner_list, reader_list = result(owner_response), result(reader_response)
        for actor, listing in [('owner', owner_list), ('reader', reader_list)]:
            rows = listing.get('rows', [])
            ids = [r.get('name') for r in rows]
            f.check('UI002 exact sheet count and unique identity ' + actor,
                    listing.get('total') == 3 and len(ids) == 3 and set(ids) == set(tables))
            f.check('UI002 attribution label and honest timestamps ' + actor,
                    len(rows) == 3 and all(
                        r.get('attribution', {}).get('level') == 'personal'
                        and r.get('attribution', {}).get('owner_user') == f.users['owner']
                        and r.get('ownership') == r.get('attribution')
                        and bool(r.get('attribution_label')) and bool(r.get('modified'))
                        and r.get('updated_at') == r.get('modified')
                        and 'content_modified' in r and 'structure_modified' in r
                        for r in rows))
            expected_access = '可编辑' if actor == 'owner' else '只读'
            f.check('UI002 capability matches role ' + actor,
                    len(rows) == 3 and all(
                        isinstance(r.get('capability'), dict)
                        and r['capability'].get('access') == expected_access
                        and r.get('my_access', {}).get('read') is True
                        and r.get('my_access', {}).get('write') is (actor == 'owner')
                        for r in rows))
            ordinary_response = f.listing(f.clients[actor], scope='all')
            ordinary = result(ordinary_response)
            # ⚠️ 口径 2026-10-20 变更（用户 12:57「文件中心也列表格」＋ 13:05
            #「Excel 是文件中心的一部分」）：文件中心列表**不再排除表格** ——
            # 表格跟普通文件**混在一起列**、**不单独分类**。
            # 早前这里钉的是「file-center excludes sheets」（旧口径，依据是用户
            # 10-13 在**附件选择器**里的批注 —— 那针对附件选择器，不是文件中心列表）。
            # Excel 工作面（scope='sheet'）**仍只列表格**，那两分不变。
            # 3 个表格 ＋ 1 个普通文件 = 4，**混在一起列**（不另开「表格」分类）
            f.check('UI002 file-center lists sheets together with other files, no duplicate ' + actor,
                    successful(ordinary_response) and ordinary.get('total') == 4
                    and sorted(r.get('name') for r in ordinary.get('rows', [])) == sorted([*tables, document]))
            pages = [f.listing(f.clients[actor], page=n, page_length=1) for n in (1, 2, 3, 4)]
            page_ids = [r.get('name') for response in pages for r in result(response).get('rows', [])]
            f.check('UI002 pagination has stable count, no duplicate or missing row ' + actor,
                    all(successful(r) and result(r).get('total') == 3 for r in pages)
                    and len(page_ids) == 3 and set(page_ids) == set(tables)
                    and result(pages[-1]).get('rows') == [])
            miss = f.listing(f.clients[actor], q=f.prefix + '-no-such-file')
            f.check('UI002 no-match search count zero ' + actor,
                    successful(miss) and result(miss).get('rows') == [] and result(miss).get('total') == 0)
        # Plain sheet allows an unambiguous whole-table editable/read-only contrast.
        # Partial field ACL capability is UI019, not falsely certified by this case.
        written = f.write(owner, table, '目录权限写入')
        f.check('UI002 editable summary permits actual write', successful(written))
        before = result(f.view(owner, table))
        f.check('UI002 successful value persisted',
                before['rows'][0]['values']['备注']['value'] == '目录权限写入')
        rejected = f.write(reader, table, 'should-not-persist')
        after = result(f.view(owner, table))
        f.check('UI002 read-only summary refuses actual write, not a 500', denied(rejected))
        f.check('UI002 refusal preserves value and version',
                before['rows'] == after['rows'] and before['content_version'] == after['content_version'])
        # Actual open request for every listed synthetic sheet, not only a metadata row.
        for file in tables:
            f.check('UI002 listed sheet opens via HTTP ' + file, successful(f.view(reader, file)))
        f.check('UI002 revoke shared file', successful(f.action(owner, 'platform.org.share_revoke', {
            'resource': table, 'user': f.users['reader']})))
        revoked_response = f.listing(reader)
        revoked = result(revoked_response)
        f.check('UI002 same-session directory count immediately follows revoke',
                successful(revoked_response) and revoked.get('total') == 2
                and table not in [r.get('name') for r in revoked.get('rows', [])])
        f.check('UI002 same-session old detail denied', denied(f.view(reader, table)))
        # Invalid attribution response must be an explicit validation/permission
        # rejection and leave the exact query empty; a transport error cannot pass.
        bad_name = f.prefix + '-enterprise.xlsx'
        bad = f.action(owner, 'files.create', {'file_name': bad_name,
            'attribution': {'level': 'enterprise', 'owner_user': f.users['owner']}})
        invalid_list = f.listing(owner, q=bad_name)
        f.check('UI002 invalid enterprise attribution rejected with zero resource',
                bad[0] in (400, 403, 417, 422) and successful(invalid_list)
                and result(invalid_list).get('total') == 0)
    except Exception as exc:
        f.check('runner/prerequisite completed: ' + type(exc).__name__ + ': ' + str(exc), False)
    finally:
        f.cleanup()
    print('NOT_COVERED native-object directory metadata/open, frontend search/page/scroll return-state, field-partial capabilities, legacy no-attribution fixture')
    return f.finish()


if __name__ == '__main__':
    if '--execute-live' not in sys.argv:
        sys.exit('Live writes require --execute-live and explicit SS_BASE after a released QA window')
    sys.exit(main())
