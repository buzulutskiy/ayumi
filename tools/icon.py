"""Иконка «Аюми» — та же форма, что у «Кэйко», только свой цвет и знак.
Геометрия снята с keiko/icon-512.png: круг на тёмном, внутри плашка с
градиентом, поверх два иероглифа. Запуск: python3 tools/icon.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

BOX = 512
SS = 2                                   # сглаживание
BG = (11, 13, 16)                        # фон вне круга
DISC = (30, 36, 45)                      # сам круг
TOP = (216, 255, 74)                     # верх градиента
BOT = (152, 220, 50)                     # низ
INK = (19, 22, 0)                        # знаки
TEXT = "歩み"
R_DISC = 245
PAD = 66                                 # отступ плашки от края
RAD = 70                                 # скругление плашки
FONTS = ["/System/Library/Fonts/Hiragino Sans GB.ttc",
         "/System/Library/Fonts/AppleSDGothicNeo.ttc"]


def font_for(size):
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise SystemExit("не нашёл шрифт с японскими знаками")


def build(px):
    k = px * SS / BOX
    W = int(BOX * k)
    img = Image.new("RGB", (W, W), BG)
    d = ImageDraw.Draw(img)
    c, r = W / 2, R_DISC * k
    d.ellipse([c - r, c - r, c + r, c + r], fill=DISC)

    # плашка с вертикальным градиентом — рисуем полосами и закругляем маской
    p0, p1 = PAD * k, (BOX - PAD) * k
    h = int(p1 - p0)
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel((0, y), tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
    grad = grad.resize((int(p1 - p0), h))
    mask = Image.new("L", grad.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, grad.size[0] - 1, h - 1], radius=int(RAD * k), fill=255)
    img.paste(grad, (int(p0), int(p0)), mask)

    # знаки по центру плашки
    f = font_for(int(178 * k))
    b = d.textbbox((0, 0), TEXT, font=f)
    d.text(((W - (b[2] + b[0])) / 2, (W - (b[3] + b[1])) / 2), TEXT, font=f, fill=INK)
    return img.resize((px, px), Image.LANCZOS)


for px, name in ((180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")):
    build(px).save(name, optimize=True)
    print(name, f"{px}×{px}")
