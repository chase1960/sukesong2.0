from shangshu_core.immutable import ImmutableDocument


class ShangshuLogTarget(ImmutableDocument):
    """无值索引关系；不是另一条操作日志，不提供领域写口。"""
    pass
