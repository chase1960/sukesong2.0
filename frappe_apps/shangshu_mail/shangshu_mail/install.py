from shangshu_core.public_api import ensure_registered_domains, register_action
from shangshu_mail.domain import ACTIONS, ACTION_VERSIONS

# 只读动作：登记成 effect='read'、confirmation='none' ⇒
# agent 直接调就能拿到内容（不生成确认提案、不用人工点确认卡）。
# 其余动作是写操作（'write' + 'required'），走人工确认。
READ_ACTIONS = {'mail.read'}

# 动作契约带 SemVer 登记，同一版本定义不一致会被拒绝（禁止隐式覆盖）。
# 改了输入契约就要升版本：
#   1.2.0 → 1.3.0：新增 inline_resources（正文 cid: 引用的受管内联图片），
#                  此前契约是严格模式且未声明该字段，内联图根本存不进去。
def setup():
    ensure_registered_domains()
    # **邮件域在统一日志库里的专属字段**（§8 第 11 项）：
    # 新装站在这里建那张扩展表；**已在跑的站**由补丁 `v0_2` 补（见 patches.txt）。
    from shangshu_mail.mailprocess import declare_log_fields
    declare_log_fields()
    for action, title, schema in ACTIONS:
        # 1.0.0 → 1.1.0：新增 resources（签名里引用的受管图）。
        # 1.1.0 → 1.2.0：新增 mailbox（T05 部门默认签名：按箱设签名，不带=本人个人箱）。
        # 1.3.0 → 1.4.0：mail.save_draft 新增 mailbox（T05 发件身份选择：草稿住哪个箱）。
        # 改了输入契约就要升版本 —— 同版本不同定义会被拒（禁止隐式覆盖）。
        # signature 1.3.0：具名多签名、默认ID与配置版本；旧默认入参保留。
        # 1.4.1：公开 schema 明确新建/更新及 mail/mailbox 的不同含义。
        version=ACTION_VERSIONS.get(action,'1.0.0')
        if action in READ_ACTIONS:
            register_action(action, version, title, 'read', 'none', ['Desk User'], schema, {})
            continue
        register_action(action, version, title, 'write', 'required', ['Desk User'], schema, {})
