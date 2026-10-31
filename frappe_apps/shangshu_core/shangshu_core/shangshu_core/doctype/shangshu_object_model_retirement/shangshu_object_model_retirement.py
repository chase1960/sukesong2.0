# -*- coding: utf-8 -*-
# 受管对象退役记录：只记「谁在什么时候为什么退役了它」，**不抄一份对象定义**。
# **不可改**（它就是审计）：退役记录一旦写下就不许改 —— 跟动作审计同一规矩。
from shangshu_core.immutable import ImmutableDocument


class ShangshuObjectModelRetirement(ImmutableDocument):
    pass
