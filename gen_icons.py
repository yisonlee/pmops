# -*- coding: utf-8 -*-
"""物业工程管理 应用图标：蓝青渐变圆角方块 + 白色楼宇 + 工程吊臂（纯 Python 生成 PNG）"""
import struct, zlib, os

TOP = (30, 64, 175)     # #1e40af
BOTTOM = (14, 116, 144)  # #0e7490
WHITE = (255, 255, 255)


def make_icon(size):
    px = [[None] * size for _ in range(size)]
    r = int(size * 0.22)
    s = float(size)

    def in_rounded(x, y):
        if x < r and y < r:
            return (x - r) ** 2 + (y - r) ** 2 <= r * r
        if x >= size - r and y < r:
            return (x - (size - 1 - r)) ** 2 + (y - r) ** 2 <= r * r
        if x < r and y >= size - r:
            return (x - r) ** 2 + (y - (size - 1 - r)) ** 2 <= r * r
        if x >= size - r and y >= size - r:
            return (x - (size - 1 - r)) ** 2 + (y - (size - 1 - r)) ** 2 <= r * r
        return True

    for y in range(size):
        t = y / s
        c = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(size):
            if in_rounded(x, y):
                px[y][x] = c

    def rect(x0, y0, x1, y1, color=WHITE):
        for y in range(int(y0 * s), int(y1 * s)):
            for x in range(int(x0 * s), int(x1 * s)):
                if 0 <= x < size and 0 <= y < size and in_rounded(x, y):
                    px[y][x] = color

    # 地基
    rect(0.16, 0.795, 0.84, 0.845)
    # 主楼
    rect(0.235, 0.345, 0.495, 0.795)
    # 副楼
    rect(0.535, 0.475, 0.705, 0.795)
    # 吊臂立柱
    rect(0.735, 0.245, 0.775, 0.795)
    # 吊臂横梁
    rect(0.505, 0.245, 0.955, 0.285)
    # 吊索
    rect(0.585, 0.285, 0.605, 0.405)
    # 吊钩（小方块）
    rect(0.565, 0.395, 0.625, 0.435)

    # 楼下镂空窗户（回填渐变色作为玻璃）
    def glass(x0, y0, x1, y1):
        for y in range(int(y0 * s), int(y1 * s)):
            t = y / s
            c = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
            for x in range(int(x0 * s), int(x1 * s)):
                if 0 <= x < size and 0 <= y < size and px[y][x] == WHITE:
                    px[y][x] = c

    glass(0.285, 0.40, 0.445, 0.455)
    glass(0.285, 0.495, 0.445, 0.550)
    glass(0.285, 0.590, 0.445, 0.645)
    glass(0.570, 0.520, 0.670, 0.575)
    glass(0.570, 0.620, 0.670, 0.675)

    raw = b""
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            c = px[y][x]
            if c is None:
                raw += b"\x00\x00\x00\x00"
            else:
                raw += bytes([c[0], c[1], c[2], 255])

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


out_dir = os.path.dirname(os.path.abspath(__file__))
for name, size in [("ICON.PNG", 64), ("ICON_256.PNG", 256),
                   ("icon_64.png", 64), ("icon_256.png", 256)]:
    p = os.path.join(out_dir, name)
    with open(p, "wb") as f:
        f.write(make_icon(size))
    print("OK", p, os.path.getsize(p), "bytes")
