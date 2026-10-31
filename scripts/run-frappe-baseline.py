#!/usr/bin/env python3
"""Run installed repository test modules on an explicitly isolated Frappe site."""
import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path


def classify(output, returncode):
    runs = re.findall(r"Ran (\d+) tests? in", output)
    count = int(runs[-1]) if runs else 0
    if "Testing is disabled for the site" in output:
        return {"status": "NOT_RUN", "tests": 0, "reason": "site tests disabled"}
    if returncode or re.search(r"^FAILED\b", output, re.M):
        return {"status": "FAIL", "tests": count}
    if not count or not re.search(r"^OK(?:\s|$)", output, re.M):
        return {"status": "NOT_RUN", "tests": count, "reason": "no successful unittest summary"}
    skipped = re.search(r"^OK \(skipped=(\d+)\)", output, re.M)
    skips = int(skipped[1]) if skipped else 0
    return {"status": "PASS" if skips < count else "NOT_RUN", "tests": count, "skipped": skips}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--site", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--module", action="append", default=[])
    args = parser.parse_args()
    if not args.site.startswith("baseline-auto-") or not args.site.endswith(".localhost"):
        parser.error("site must be an isolated baseline-auto-*.localhost site")
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    args.out.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[1]
    base = ["docker", "exec", "-w", "/home/frappe/frappe-bench", args.container,
            "bench", "--site", args.site]
    # Do not auto-install legacy apps or silently count their tests as passing.
    installed = subprocess.run(base + ["execute", "frappe.get_installed_apps"],
                               capture_output=True, text=True, timeout=30)
    (args.out / "installed-apps.log").write_text(installed.stdout + installed.stderr)
    if installed.returncode:
        raise SystemExit("cannot inspect installed apps")
    apps = json.loads(installed.stdout.strip())
    files = sorted(root.glob("frappe_apps/*/*/tests/test_*.py"))
    selected = []
    for path in files:
        relative = path.relative_to(root / "frappe_apps")
        module = ".".join(relative.with_suffix("").parts[1:])
        if not args.module or module in args.module:
            selected.append((path, relative.parts[0], module))
    if not selected or set(args.module) - {item[2] for item in selected}:
        raise SystemExit("empty or unknown module selection")
    report = {"site": args.site, "container": args.container, "installed_apps": apps,
              "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
              "results": []}
    for path, app, module in selected:
        item = {"module": module, "path": str(path.relative_to(root)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        if app not in apps:
            item.update(status="NOT_RUN", tests=0, reason="app not installed in this baseline")
        else:
            start = time.monotonic()
            command = base + ["run-tests", "--module", module, "--skip-test-records"]
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=args.timeout)
                output = result.stdout + result.stderr
                item.update(classify(output, result.returncode), exit_code=result.returncode)
            except subprocess.TimeoutExpired as error:
                output = (error.stdout or b"").decode(errors="replace") + (error.stderr or b"").decode(errors="replace")
                item.update(status="TIMEOUT", tests=0, reason="container command may still be alive; inspect before continuing")
            item["seconds"] = round(time.monotonic() - start, 3)
            item["log"] = module + ".log"
            (args.out / item["log"]).write_text(output)
        report["results"].append(item)
        (args.out / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if item["status"] == "TIMEOUT":
            break  # docker exec timeout does not prove the inner process stopped.
    changed = any(hashlib.sha256((root / row["path"]).read_bytes()).hexdigest() != row["sha256"]
                  for row in report["results"])
    report["test_source_changed"] = changed
    report["selection_complete"] = len(report["results"]) == len(selected)
    (args.out / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 1 if changed or not report["selection_complete"] or any(row["status"] != "PASS" for row in report["results"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
