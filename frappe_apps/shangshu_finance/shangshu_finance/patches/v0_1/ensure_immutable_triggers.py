from shangshu_core.public_api import ensure_immutable_triggers


def execute():
    ensure_immutable_triggers("Shangshu Ledger Entry", "shangshu_ledger_entry")
    ensure_immutable_triggers("Shangshu Cash Movement", "shangshu_cash_movement")
