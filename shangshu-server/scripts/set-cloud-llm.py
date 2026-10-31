# -*- coding: utf-8 -*-
"""把 runtime_config.json 的 llm 切到阿里云百炼(DashScope) qwen3.8-27b。
只用于「验证 27B 全精度能不能承载工作流」。改前自动备份，改后可一键还原。

用法：
  python3 scripts/set-cloud-llm.py <api_key>        # 切到云端 qwen3.8-27b
  python3 scripts/set-cloud-llm.py --restore        # 还原为切换前的 llm 配置
"""
import json, os, sys, shutil

CONFIG = os.path.join(os.path.dirname(__file__), "..", "data", "runtime_config.json")
CONFIG = os.path.abspath(CONFIG)
BACKUP = CONFIG + ".pre-27b"

LLM = {
    "provider": "dashscope",
    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen3.8-27b",
}

def load():
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)

def save(cfg):
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--restore":
        if not os.path.exists(BACKUP):
            print("没有备份可还原：", BACKUP); sys.exit(1)
        shutil.copyfile(BACKUP, CONFIG)
        print("已还原 runtime_config.json（来自 .pre-27b）")
        return

    if len(sys.argv) < 2:
        print("用法：python3 set-cloud-llm.py <dashscope_api_key>  或  --restore"); sys.exit(2)
    key = sys.argv[1].strip()
    if not key:
        print("api_key 不能为空"); sys.exit(2)

    cfg = load()
    if not os.path.exists(BACKUP):
        shutil.copyfile(CONFIG, BACKUP)
        print("已备份当前 llm 配置 →", BACKUP)
    cfg["llm"] = {**LLM, "api_key": key}
    save(cfg)
    print("已切换到云端 27B：")
    print("  provider =", cfg["llm"]["provider"])
    print("  base_url =", cfg["llm"]["base_url"])
    print("  model    =", cfg["llm"]["model"])
    print("（api_key 已写入；data/ 在 gitignore 内，不会提交）")

if __name__ == "__main__":
    main()
