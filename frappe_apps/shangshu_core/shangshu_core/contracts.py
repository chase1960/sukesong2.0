import json
from importlib.resources import files


API_VERSION = "1.20.0"


def get_contract_snapshot():
    path = files("shangshu_core").joinpath("contracts/platform-api-v1.json")
    return json.loads(path.read_text(encoding="utf-8"))


def get_device_channel_contract():
    """**与 win 沟通的契约层**（设备通道）的成文定义。

    2026-10-22（用户拍板）：这一层**归内核**，不属于任何业务域 ——
    谁有设备通道都照这一份来（安全通道／凭据校验／操作号／事件信封格式）。
    """
    path = files("shangshu_core").joinpath("contracts/device-channel-v1.json")
    return json.loads(path.read_text(encoding="utf-8"))
