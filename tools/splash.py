"""Заставки запуска для айфона.

Айфон не смотрит цвет из манифеста: с домашнего экрана он рисует белый
лист, пока грузится приложение. Чинится только своими картинками, и
размеры должны совпадать с экраном точь-в-точь — иначе картинка не
берётся вовсе. Сплошной цвет жмётся почти в ничто.

    python3 tools/splash.py "#0d0b14"
"""
import struct, sys, zlib, pathlib

SIZES = [(320, 568, 2), (375, 667, 2), (414, 896, 2),
         (375, 812, 3), (390, 844, 3), (393, 852, 3), (402, 874, 3),
         (414, 896, 3), (428, 926, 3), (430, 932, 3), (440, 956, 3)]


def png(w, h, rgb):
    row = b"\x00" + bytes(rgb) * w
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * h, 9))
            + chunk(b"IEND", b""))


def main():
    raw = (sys.argv[1] if len(sys.argv) > 1 else "#0d0b14").lstrip("#")
    rgb = tuple(int(raw[i:i + 2], 16) for i in (0, 2, 4))
    out = pathlib.Path(__file__).resolve().parent.parent
    for w, h, r in SIZES:
        name = f"splash-{w*r}x{h*r}.png"
        (out / name).write_bytes(png(w * r, h * r, rgb))
        print(name, f"{w}×{h}@{r}x")
    print("\nСсылки для <head>:")
    for w, h, r in SIZES:
        print(f'  <link rel="apple-touch-startup-image" href="splash-{w*r}x{h*r}.png"\n'
              f'    media="(device-width: {w}px) and (device-height: {h}px) and '
              f'(-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">')


if __name__ == "__main__":
    main()
