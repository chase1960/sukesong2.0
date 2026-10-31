from shangshu_core.database import ensure_immutable_triggers


def execute():
    ensure_immutable_triggers("Shangshu Process Definition Version", "shangshu_process_version")
