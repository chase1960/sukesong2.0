"""为异数据库账号恢复准备副本：只移除标准 dump 的触发器旧 DEFINER。

不删除触发器或改写其 SQL；恢复时由目标库账号拥有触发器。源备份不改，目标必须不存在。
只处理自有受信 MariaDB dump，不接收业务上传文件，不代替数据库/附件完整恢复。
"""
import gzip,re,sys
from pathlib import Path

TRIGGER=re.compile(rb'^(/\*!50003 CREATE\*/ )/\*!50017 DEFINER=`(?:[^`]|``)+`@`(?:[^`]|``)+`\*/ (?=/\*!50003 [Tt][Rr][Ii][Gg][Gg][Ee][Rr]\b)')


def prepare(source,target):
    source=Path(source).resolve();target=Path(target).resolve()
    if source==target:raise ValueError('源备份与恢复副本必须不同')
    opener=gzip.open if source.suffix=='.gz' else open
    writer=gzip.open if target.suffix=='.gz' else open
    count=0
    with opener(source,'rb') as src, writer(target,'xb') as dst:
        for line in src:
            line,n=TRIGGER.subn(rb'\1',line);count+=n;dst.write(line)
    return count


if __name__=='__main__':
    if len(sys.argv)!=3:raise SystemExit('用法：python scripts/prepare_restore_backup.py 源.sql.gz 新副本.sql.gz')
    print('恢复副本已生成；保留触发器，重绑定目标账号数量：',prepare(sys.argv[1],sys.argv[2]))
