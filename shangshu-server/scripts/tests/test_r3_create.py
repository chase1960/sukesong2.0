"""UI003/004/084/104 manual creation/upload through production UI + actual HTTP.

Requires explicit exclusive QA window and --execute-live. Reuses role Fixture;
no fixed users, no prefix cleanup. The bridge journals exact returned resource
IDs after every write so finally can recycle even after failed UI assertions.
Old RC01–07 contracts are retained, with real production frontend coverage.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from test_e01_role_matrix import Fixture, result, successful, denied


def main():
    if '--execute-live' not in sys.argv:
        sys.exit('Live writes require --execute-live after exclusive QA window release')
    f = Fixture('manualfiles', ('owner', 'member', 'peer'))
    root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory(prefix='shangshu-manual-files-') as tmp:
        manifest = Path(tmp) / 'manifest.json'
        try:
            f.setup()
            from openpyxl import Workbook
            book = Workbook(); book.active.append(['名称', '金额']); book.active.append(['原始内容', 7])
            xlsx = Path(tmp) / 'fixture.xlsx'; book.save(xlsx)
            owner = f.clients['owner']
            env = dict(os.environ, SS_BASE=f.base, SS_MANUAL_PREFIX=f.prefix,
                       SS_MANUAL_COOKIE='; '.join(c.name+'='+c.value for c in owner.jar),
                       SS_MANUAL_DEPT=f.departments['a'], SS_MANUAL_MANIFEST=str(manifest),
                       SS_MANUAL_XLSX=str(xlsx))
            bridge = subprocess.run(['node', '--import', 'tsx', 'scripts/tests/manual-files-http-bridge.mjs'],
                                    cwd=root/'shangshu-server', env=env, timeout=180)
            f.check('production UI create/upload/detail bridge', bridge.returncode == 0)
            data = json.loads(manifest.read_text()) if manifest.exists() else {}
            for file in data.get('files', []):
                if file not in f.files: f.files.append(file); f.file_clients[file] = owner
            listed = set()
            for scope in ('sheet', 'all'):
                listing = f.listing(owner, scope=scope)
                f.check('UI003/004 actual catalog readable ' + scope, successful(listing))
                listed.update(row['name'] for row in result(listing).get('rows', []))
            f.check('UI003/004 catalog exactly matches successful created IDs, no cancel/invalid/replay ghosts', listed == set(data.get('files', [])))
            invalid_counts = f.console_module.run("RESULT['resources']=frappe.db.count('Shangshu File Center File',{'file_name':%r})\nRESULT['files']=frappe.db.count('File',{'file_name':%r})" % ((f.prefix+'-corrupt.xlsx',)*2))
            f.check('UI004 malformed XLSX leaves zero resource and zero File rows', invalid_counts.get('resources') == 0 and invalid_counts.get('files') == 0)
            created = data.get('created')
            if created:
                before = result(f.view(owner, created))
                col = f.action(owner, 'files.sheet_column_append', {'table': created, 'header': '名称',
                    'expected_content_version': before['content_version'], 'expected_structure_version': before['structure_version']})
                f.check('RC02 empty sheet appends column', successful(col))
                before = result(f.view(owner, created))
                row = f.action(owner, 'files.sheet_row_append', {'table': created,
                    'expected_content_version': before['content_version'], 'expected_structure_version': before['structure_version']})
                f.check('RC02 empty sheet appends row', successful(row))
                before = result(f.view(owner, created))
                write = f.action(owner, 'files.sheet_cell_write', {'table': created, 'row_id': before['rows'][0]['row_id'],
                    'header': '名称', 'value': {'type': 'text', 'value': '新建后真实编辑'},
                    'expected_content_version': before['content_version'], 'expected_structure_version': before['structure_version']})
                f.check('RC02 created sheet edit independently read back', successful(write) and
                        '新建后真实编辑' in json.dumps(result(f.view(owner, created)), ensure_ascii=False))
                f.check('RC03 unrelated ordinary account cannot read personal sheet', denied(f.view(f.clients['peer'], created)))
            payload = {'file_name': f.prefix+'-department.xlsx', 'attribution': {'level':'department','department':f.departments['a']}}
            department_sheet = f.action(owner, 'files.create', payload)
            f.check('RC04 own department creation succeeds and colleague reads', successful(department_sheet) and
                    successful(f.view(f.clients['member'], result(department_sheet).get('file'))))
            f.check('RC04 outsider cannot create into ungranted department', denied(f.action(f.clients['peer'], 'files.create', payload)))
            other = f.action(owner, 'files.create', payload)
            f.check('RC05 same-name create always new identity', successful(other) and result(other).get('file') != result(department_sheet).get('file'))
            invalid = f.action(owner, 'files.create', {'attribution': {'level':'personal'}})
            f.check('RC06 missing filename rejected', invalid[0] in (400, 417, 422))
            if data.get('deptFile'):
                f.check('UI104 colleague can read uploaded department file', successful(f.service(f.clients['member'], 'files.versions', {'file':data['deptFile']})))
                f.check('UI104 peer cannot read uploaded department file', denied(f.service(f.clients['peer'], 'files.versions', {'file':data['deptFile']})))
        finally:
            if manifest.exists():
                for file in json.loads(manifest.read_text()).get('files', []):
                    if file not in f.files: f.files.append(file); f.file_clients[file] = f.clients['owner']
            f.cleanup()
    return f.finish()


if __name__ == '__main__':
    sys.exit(main())
