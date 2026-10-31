"""Read-only comparison of tracked product bytes against Docker runtime files.

This does not prove Python/Node processes reloaded their modules. Restart evidence
and HTTP acceptance must be recorded separately. No credentials are inspected.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def run(args):
    return subprocess.check_output(args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--frappe-container', required=True)
    parser.add_argument('--node-container', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    commit = run(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
    paths = run(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
    apps = {'shangshu_core', 'shangshu_files', 'shangshu_mail',
            'shangshu_orders', 'shangshu_finance', 'shangshu_warehouse'}
    expected = {args.frappe_container: {}, args.node_container: {}}
    for path in filter(None, paths):
        bits = path.split('/')
        target = None
        if len(bits) > 2 and bits[0] == 'frappe_apps' and bits[1] in apps:
            container = args.frappe_container
            target = '/home/frappe/frappe-bench/apps/' + '/'.join(bits[1:])
        elif path.startswith(('shangshu-server/src/', 'shangshu-web/')) and '/node_modules/' not in path:
            container = args.node_container
            target = '/srv/shangshu/' + path
        if target and (root / path).is_file():
            expected[container][target] = hashlib.sha256((root / path).read_bytes()).hexdigest()
    remote = """import sys,json,hashlib
from pathlib import Path
paths=json.load(sys.stdin)
print(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None for p in paths}))
"""
    checks = {}
    for container, wanted in expected.items():
        # Frappe image includes Python; Node uses the host-mounted source via Node.
        if container == args.node_container:
            script = "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const fs=require('fs'),c=require('crypto');let o={};for(const p of JSON.parse(s)){o[p]=fs.existsSync(p)&&fs.statSync(p).isFile()?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;}console.log(JSON.stringify(o));});"
            command = ['docker', 'exec', '-i', container, 'node', '-e', script]
        else:
            command = ['docker', 'exec', '-i', container, 'python3', '-c', remote]
        actual = json.loads(subprocess.check_output(command, input=json.dumps(list(wanted)).encode()))
        checks[container] = {'files': len(wanted), 'mismatches': [p for p in wanted if actual.get(p) != wanted[p]],
                             'hashes': actual}
    status = run(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no']).decode()
    result = {'commit': commit, 'tracked_worktree_status': status,
              'scope': 'working-tree disk bytes only; not loaded process or HTTP proof', 'containers': checks}
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({c: {'files': x['files'], 'mismatches': len(x['mismatches'])} for c, x in checks.items()}))
    return int(any(x['mismatches'] for x in checks.values()))


if __name__ == '__main__':
    raise SystemExit(main())
