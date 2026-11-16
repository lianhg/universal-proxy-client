"""生成应用图标 build/icon.ico（深蓝底 + 蓝青渐变闪电），纯 PIL 实现"""
import os
from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = os.path.dirname(os.path.abspath(__file__))


def sample(stops, t):
    t = max(0.0, min(1.0, t))
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(int(c0[n] + (c1[n] - c0[n]) * k) for n in range(3))
    return stops[-1][1]


def grad(w, h, stops, wx=0.45, wy=0.55):
    sw = sh = 64
    small = Image.new("RGB", (sw, sh))
    px = small.load()
    for j in range(sh):
        for i in range(sw):
            px[i, j] = sample(stops, (i / (sw - 1)) * wx + (j / (sh - 1)) * wy)
    return small.resize((w, h), Image.BICUBIC)


# ---------- 背景 ----------
img = grad(S, S, [(0.0, (11, 17, 32)), (1.0, (30, 36, 88))]).convert("RGBA")
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
img.putalpha(mask)

# ---------- 闪电 ----------
bolt = [(0.575, 0.10), (0.275, 0.555), (0.462, 0.555), (0.385, 0.90), (0.725, 0.415), (0.528, 0.415)]
pts = [(x * S, y * S) for x, y in bolt]
bmask = Image.new("L", (S, S), 0)
ImageDraw.Draw(bmask).polygon(pts, fill=255)

glow = bmask.filter(ImageFilter.GaussianBlur(int(S * 0.05)))
glow_layer = Image.new("RGBA", (S, S), (56, 189, 248, 0))
glow_layer.putalpha(glow.point(lambda v: int(v * 0.8)))
img = Image.alpha_composite(img, glow_layer)

body = grad(S, S, [(0.0, (96, 165, 250)), (0.55, (34, 211, 238)), (1.0, (168, 85, 247))], 0.35, 0.65).convert("RGBA")
body.putalpha(bmask)
img = Image.alpha_composite(img, body)

img.save(os.path.join(OUT, "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT, "icon.ico"), format="ICO", sizes=[(s, s) for s in [256, 128, 64, 48, 32, 24, 16]]
)
print("icon.ico ok", os.path.getsize(os.path.join(OUT, "icon.ico")), "bytes")
