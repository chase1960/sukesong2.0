"""回复 / 转发两个 agent 动作 —— 判据。

**测试通过 = 下面全部成立**：
 ① 给一封**带内联图**的原信 ⇒ 调 mail.forward ⇒ 生成的草稿正文里那张图引用的是
    **文件中心路径**（不是裸 `cid:`）⇒ 存得进去（存回时还原成 `cid:`）、打开看得见图；
 ② 工具面里查得到 mail.reply / mail.forward 两个工具（动作已注册 ＋ 已投影成工具）；
 ③ 人点转发与 agent 调 mail.forward 走**同一个实现**（同一份公共实现产出的东西）；
 ④ 原信编号没给、或原信读不到 ⇒ **当场拒并说得出原因**（不许静默生成一封空引用的草稿）。

跑法（bench 上）：
    bench --site <站点> run-tests --module shangshu_mail.tests.test_mail_reply_forward --skip-test-records
跑法（离线，不带 bench）：本文件只依赖纯函数与桩件 ⇒
    cd frappe_apps/shangshu_mail && python3 -m unittest shangshu_mail.tests.test_mail_reply_forward
"""
import json
import unittest

from shangshu_mail import quoting

# 一封**带内联图**的原信（表里的形状，不是拼出来的字符串）。
ORIGINAL = {
    'name': 'm-src-1', 'status': 'Received', 'subject': '富信源（表格/内嵌图/附件）',
    'from_address': '银聆 G3 测试 <jiangzheny@lingeringtek.cn>',
    'received_at': '2026-10-20 12:42:57', 'modified': '2026-10-20 12:42:57',
    'to_json': json.dumps(['jiangzheny@lingeringtek.cn'], ensure_ascii=False),
    'cc_json': '[]',
    'body': '<p>这是 G3 富信源</p><p><img src="cid:g3stamp@shangshu.local" alt="G3内嵌图"></p>',
    'inline_resources_json': json.dumps([
        {'content_id': 'g3stamp@shangshu.local', 'mime_type': 'image/png',
         'name': 'g3-stamp.png', 'file': 'F-INLINE-1'},
    ], ensure_ascii=False),
}

# 已在文件中心里的那张图（`source` 带着归属）—— 不该再存一次。
ORIGINAL_WITH_SOURCE = dict(ORIGINAL, inline_resources_json=json.dumps([
    {'content_id': 'g3stamp@shangshu.local', 'mime_type': 'image/png', 'name': 'g3-stamp.png',
     'file': 'F-INLINE-1',
     'source': {'ref_doctype': 'Shangshu File Center File', 'ref_name': 'FC-1', 'file': 'F-FC-1'}},
], ensure_ascii=False))


class TestMailReplyForward(unittest.TestCase):
    """① 带内联图的原信 ⇒ 转发草稿里那张图引用的是文件中心路径（不是裸 cid:）。"""

    def test_forward_body_uses_file_center_path_not_cid(self):
        built = quoting.build_reply_body(
            ORIGINAL, '转发说明：', user='me@example.invalid',
            importer=lambda mail, user, files: {'F-INLINE-1': 'FC-1'})
        body = built['body']
        self.assertIn('/api/platform/file-content?', body,
                      '草稿正文里那张图没有换成文件中心路径（转发出去必然是死引用）')
        self.assertIn('ref_name=FC-1', body, '用的不是文件中心那条记录')
        self.assertNotIn('src="cid:g3stamp@shangshu.local"', body,
                         '正文里还留着裸 cid:（没换）')
        # 编辑期形态：留 data-managed-cid，存回时还原成 cid:
        self.assertIn('data-managed-cid="cid:g3stamp@shangshu.local"', body)
        # 随草稿带走的受管内联图（草稿自己也要显示得出那张图）
        self.assertEqual(len(built['inline_resources']), 1)
        self.assertEqual(built['inline_resources'][0]['content_id'], 'g3stamp@shangshu.local')
        self.assertEqual(built['inline_resources'][0]['source']['ref_name'], 'FC-1')

    def test_saved_body_restores_cid(self):
        """存回正文时 `data-managed-cid` 要还原成 `cid:`（出站净化门只认 cid:）。"""
        built = quoting.build_reply_body(
            ORIGINAL, '', user='me@example.invalid',
            importer=lambda mail, user, files: {'F-INLINE-1': 'FC-1'})
        restored = quoting.restore_cids(built['body'])
        self.assertIn('src="cid:g3stamp@shangshu.local"', restored)
        self.assertNotIn('data-managed-cid', restored)
        self.assertNotIn('/api/platform/file-content?', restored,
                         '存回去的正文还挂着文件中心路径 —— 净化门会把它当外链剥掉')

    def test_quote_block_carries_head_and_original(self):
        built = quoting.build_reply_body(ORIGINAL, '', user=None)
        self.assertIn('---------- 原始邮件 ----------', built['body'])
        self.assertIn('发件人:', built['body'])
        self.assertIn('主题: 富信源（表格/内嵌图/附件）', built['body'])
        self.assertIn('这是 G3 富信源', built['body'])

    def test_already_in_file_center_is_not_stored_again(self):
        """已经在文件中心的图（带 source）⇒ 不再存一次。"""
        stored = []

        def importer(mail, user, files):
            stored.append(list(files))
            return {}

        quoting.build_reply_body(ORIGINAL_WITH_SOURCE, '', user='me@example.invalid', importer=importer)
        self.assertEqual(stored, [], '已经进过文件中心的图，又存了一次')

    def test_missing_or_unreadable_source_is_refused(self):
        """④ 原信编号没给 / 读不到 ⇒ 当场拒并说得出原因。"""
        # 没给编号
        with self.assertRaises(quoting.OriginalNotReadable) as caught:
            quoting.require_original('', lambda ident: ORIGINAL)
        self.assertIn('reply_to_mail', str(caught.exception))
        # 读不到（读权不足/不存在）
        def loader(ident):
            raise Exception('只能访问自己邮箱或已获授权邮箱里的邮件')
        with self.assertRaises(quoting.OriginalNotReadable) as caught:
            quoting.require_original('m-src-1', loader)
        self.assertIn('读不到', str(caught.exception))
        # 已移入回收站
        with self.assertRaises(quoting.OriginalNotReadable) as caught:
            quoting.require_original('m-src-1', lambda ident: dict(ORIGINAL, status='Trash'))
        self.assertIn('回收站', str(caught.exception))
        # 读得到 ⇒ 原样给出
        self.assertEqual(quoting.require_original('m-src-1', lambda ident: ORIGINAL)['name'], 'm-src-1')

    def test_actions_are_registered_and_projected_as_tools(self):
        """② 动作已注册 ＋ 工具面里查得到这两个。"""
        from shangshu_mail import domain
        ids = [action[0] for action in domain.ACTIONS]
        self.assertIn('mail.reply', ids)
        self.assertIn('mail.forward', ids)
        # 工具投影（domain.py 的 contribution 里那一段）
        source = open(domain.__file__, encoding='utf-8').read()
        self.assertIn("'mail.reply'", source)
        self.assertIn("'mail.forward'", source)
        # 版本表：改 schema 就升版本号（新动作首次登记 1.0.0）
        self.assertIn('mail.reply', domain.ACTION_VERSIONS)
        self.assertIn('mail.forward', domain.ACTION_VERSIONS)

    def test_tool_projection_shape_matches_files_domain(self):
        """工具投影的形状照 files 域那一行（`{'id': key}`），且这两个动作在表里。"""
        import re
        from shangshu_mail import domain
        with open(domain.__file__, encoding='utf-8') as handle:
            source = handle.read()
        match = re.search(r"'tools':\[(.*?)\]", source, re.S)
        self.assertTrue(match, '邮件域的 tools 段没找到')
        segment = match.group(1)
        self.assertIn("{'id':a}", segment.replace(' ', ''),
                      '工具投影的形状没照 files 域那一行（`{\'id\': key}`）')
        for action_id in ('mail.reply', 'mail.forward'):
            self.assertIn(action_id, segment, f'{action_id} 不在工具投影表里 ⇒ agent 提不起这个动作')

    def test_action_descriptions_tell_the_model_how_to_use(self):
        """动作说明要写给模型看：怎么取原信、引用块是什么、只生成草稿。"""
        from shangshu_mail import domain
        for action_id in ('mail.reply', 'mail.forward'):
            entry = [item for item in domain.ACTIONS if item[0] == action_id]
            self.assertTrue(entry, f'{action_id} 没注册')
            text = str(entry[0][2].get('description', '')) + str(entry[0][2].get('properties', {}))
            self.assertIn('mail.detail', text, f'{action_id} 的说明没告诉模型先取原信')
            self.assertIn('引用块', text, f'{action_id} 的说明没讲清引用块是什么')
            self.assertIn('不发送', text, f'{action_id} 的说明没讲清只生成草稿')

    def test_quote_shape_follows_real_clients(self):
        """引用块的**形状**（现在由后端产出 ⇒ 形状归后端判据钉）。

        对齐真实客户端（见 mail-quote-style.test.ts 的取证）：
          ① 用户写字区在**上**、是独立段落，引用在**下**，两者是**兄弟**不是嵌套；
          ② 分界是**一行横杠文字**「---------- 原始邮件 ----------」，不是竖线；
          ③ 抬头四项：发件人 / 发送时间 / 收件人 / 主题；
          ④ 抬头里的尖括号地址按**字面**显示（不被当成 HTML 标签吃掉）。
        """
        original = dict(ORIGINAL, from_address='银聆 G3 测试 <jiangzheny@lingeringtek.cn>',
                        received_at='2026-10-20 12:42:57', to_json=json.dumps(['jiangzheny@lingeringtek.cn']),
                        cc_json='[]', subject='富信源（表格/内嵌图/附件）')
        built = quoting.build_reply_body(original, '', user='me@example.invalid', importer=lambda *a: {})
        body = built['body']
        # ① 写字区在上、引用在下（兄弟，不是嵌套）
        self.assertTrue(body.startswith('<p><br></p>'), '顶部要留一个给人写字的独立段落')
        quote_at = body.index('<div data-mail-quote="1"')
        self.assertGreaterEqual(quote_at, len('<p><br></p>'), '引用块必须排在写字区下面')
        self.assertNotIn('<blockquote', body, '引用块不许套竖线（没有一家客户端这么做）')
        # ② 分界是横杠文字
        self.assertIn(quoting.QUOTE_SEPARATOR, body)
        self.assertIn('data-mail-quote-sep="1"', body)
        # ③ 抬头四项
        for label in ('发件人:', '发送时间:', '收件人:', '主题:'):
            self.assertIn(label, body, f'抬头少了一项：{label}')
        # ④ 尖括号地址按字面显示
        self.assertIn('&lt;jiangzheny@lingeringtek.cn&gt;', body, '抬头里的尖括号被当成标签吃掉了')
        self.assertNotIn('<jiangzheny@lingeringtek.cn>', body, '抬头里的尖括号没转义')

    def test_plain_text_original_keeps_its_line_breaks(self):
        """纯文本原信的引用正文**保住自己的换行**（用户 2026-10-13 反馈的那条）。

        病根：`\\n` 在 HTML 里被折成空格 —— 引用里的抬头四项挤成一行。
        修法：纯文本原信的引用正文包进 `white-space:pre-wrap`（转义后按字面放）。
        """
        original = dict(ORIGINAL, body_format='Text',
                        body='第一行\n第二行\n第三行')
        built = quoting.build_reply_body(original, '', user='me@example.invalid', importer=lambda *a: {})
        body = built['body']
        self.assertIn('white-space:pre-wrap', body,
                      '纯文本原信的引用正文没保住换行（HTML 会把 \\n 折成空格）')
        self.assertIn('第一行\n第二行\n第三行', body,
                      '纯文本原信的引用正文被压成一行了')

    def test_signature_is_inserted_before_the_quote(self):
        """默认签名也由**后端这一份**插（位置：引用块之前，与前端同一口径）。"""
        body = '<p><br></p><div data-mail-quote="1">原始邮件</div>'
        out = quoting.insert_signature(body, '<p>签名文字</p>')
        self.assertIn('签名文字', out)
        self.assertLess(out.index('签名文字'), out.index('data-mail-quote'),
                        '签名要插在引用块之前（和前端 withDefaultSignature 同一位置）')
        self.assertEqual(quoting.insert_signature(body, ''), body, '没有签名时正文一个字都不许动')

    def test_signature_images_travel_with_the_draft(self):
        """签名里引用的受管图要**跟着草稿走**（否则正文里只剩一个取不到的 cid:）。"""
        original = dict(ORIGINAL, body='<p>原文</p>')
        built = quoting.build_reply_body(original, '', user='me@example.invalid', importer=lambda *a: {},
                                         signature={'html': '<p>签名</p>',
                                                    'resources': [{'content_id': 'sig@x', 'file': 'F-SIG'}]})
        ids = [item['content_id'] for item in built['inline_resources']]
        self.assertIn('sig@x', ids, '签名里的图没跟着草稿走')
        self.assertIn('签名', built['body'])

    def test_reply_and_forward_use_the_same_public_implementation(self):
        """③ 人点与 agent 走**同一个实现** ⇒ 引用块与改写只有一份代码。"""
        import os
        import shangshu_mail
        service_path = os.path.join(os.path.dirname(shangshu_mail.__file__), 'service.py')
        with open(service_path, encoding='utf-8') as handle:
            source = handle.read()
        # 两个动作都落进**同一个**公共实现（不许各拼一套正文字符串）
        self.assertIn('shangshu_mail.quoting', source)
        self.assertIn('reply_or_forward_payload', source)
        self.assertIn("action='mail.save_draft'", source,
                      '回复/转发没有交给同一份保存实现')
        # 公共实现里那份引用块/改写是**唯一一份**
        with open(quoting.__file__, encoding='utf-8') as handle:
            quoting_source = handle.read()
        self.assertIn('def build_quote_block', quoting_source)
        self.assertIn('def apply_path_index', quoting_source)
        self.assertIn('def restore_cids', quoting_source)


if __name__ == '__main__':
    unittest.main()
