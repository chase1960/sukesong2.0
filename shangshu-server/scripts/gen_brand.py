#!/usr/bin/env python3
"""品牌图生成器（工作台侧栏 + 登录页）。

用法：python3 scripts/gen_brand.py   （在 shangshu-server/ 下运行，输出到 ../shangshu-web/）
输出三版：
  brand.png       印章 + 尚书 + Lingeringtek（登录页用，横向完整锁定组合）
  brand-mark.png  印章 + 尚书（侧栏用；英文字标按 21px 高要占 100+px，是侧栏被顶宽的主因）
  brand-seal.png  仅印章（侧栏折叠成 rail 时占位，鼠标移上去才换成展开箭头）
依赖：rsvg-convert（homebrew: librsvg）、PIL（系统 python3）。
定稿（2026-08-16）：红印章 #E53935 + 深灰字 #1E232C；按墨迹包围盒居中对齐（基线锚点对齐中英会浮）。
"""
import subprocess, os
from PIL import Image, ImageDraw, ImageFont

S = 4                    # 超采样倍率
H = 26 * S               # 画布高（CSS 侧栏显示 23px）
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, '..', '..', 'shangshu-web')

SEAL_COLOR = (0xE5, 0x39, 0x35)   # 印章红
TEXT_COLOR = (0x1E, 0x23, 0x2C)   # 深灰（--fg）

def load_seal(color):
    tmp = '/tmp/ss-brand-seal.png'
    subprocess.run(['rsvg-convert', '-h', str(H), os.path.join(WEB, 'logo.svg'), '-o', tmp], check=True)
    seal = Image.open(tmp).convert('RGBA').crop(Image.open(tmp).convert('RGBA').getchannel('A').getbbox())
    r, g, b = color
    px = seal.load()
    for y in range(seal.height):
        for x in range(seal.width):
            pr, pg, pb, a = px[x, y]
            if a:
                k = 1 - (0.299 * pr + 0.587 * pg + 0.114 * pb) / 255 * 0.25  # 保留纹理明度
                px[x, y] = (int(r * k), int(g * k), int(b * k), a)
    sh = H - 8 * S // 2
    return seal.resize((int(seal.width * sh / seal.height), sh), Image.LANCZOS)

def render_ink(text, font):
    tmp = Image.new('RGBA', (2000, 400))
    ImageDraw.Draw(tmp).text((50, 200), text, font=font, fill=(0, 0, 0, 255), anchor='lm')
    return tmp.crop(tmp.getchannel('A').getbbox())

def tint(ink, color):
    r, g, b = color
    px = ink.load()
    for y in range(ink.height):
        for x in range(ink.width):
            a = px[x, y][3]
            if a: px[x, y] = (r, g, b, a)
    return ink

def compose(seal, inks, gaps):
    """inks 按顺序横排在印章右侧，gaps[i] 是它前面的间距；统一按墨迹中线居中。"""
    W = int(seal.width + sum(gaps) + sum(i.width for i in inks) + 2 * S)
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    img.alpha_composite(seal, (0, (H - seal.height) // 2))
    x, cy = seal.width, H // 2
    for gap, ink in zip(gaps, inks):
        x += gap
        img.alpha_composite(ink, (x, cy - ink.height // 2))
        x += ink.width
    return img.crop(img.getchannel('A').getbbox())

def main():
    seal = load_seal(SEAL_COLOR)
    f_cn = ImageFont.truetype(os.path.join(WEB, 'fonts/dingliesong.ttf'), int(19 * S))
    f_en = ImageFont.truetype(os.path.join(WEB, 'fonts/futura-bold.ttf'), int(14.5 * S))
    gap1, gap2 = 10 * S, 9 * S
    ink_cn = tint(render_ink('尚书', f_cn), TEXT_COLOR)
    ink_en = tint(render_ink('Lingeringtek', f_en), TEXT_COLOR)
    for name, img in (
        ('brand.png', compose(seal, [ink_cn, ink_en], [gap1, gap2])),
        ('brand-mark.png', compose(seal, [ink_cn], [gap1])),
        ('brand-seal.png', seal.crop(seal.getchannel('A').getbbox())),
    ):
        out = os.path.join(WEB, name)
        img.save(out)
        print('written', out, img.size)

if __name__ == '__main__':
    main()
