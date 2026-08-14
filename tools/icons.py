"""Иконки приложения: тёмный квадрат и знак 歩 акцентным цветом.
Айфон сам скруглит углы, поэтому рисуем квадрат без скруглений.
Запуск: python3 tools/icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

BG = (11, 13, 16)
FG = (216, 255, 74)
FONTS = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def font_for(size):
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def make(px, name):
    img = Image.new("RGB", (px, px), BG)
    d = ImageDraw.Draw(img)
    f = font_for(int(px * 0.62))
    box = d.textbbox((0, 0), "歩", font=f)
    d.text(((px - box[2] - box[0]) / 2, (px - box[3] - box[1]) / 2), "歩", font=f, fill=FG)
    img.save(name)
    print(name, f"{px}×{px}")


for px, name in ((180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")):
    make(px, name)
