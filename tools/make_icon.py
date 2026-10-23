"""Иконка PC Stream (512x512): монитор с кнопкой Play на градиентном стекле."""
import sys
from PIL import Image, ImageDraw

W = H = 512
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
grad = Image.new('RGBA', (W, H))
px = grad.load()
a, b = (122, 162, 255), (185, 140, 255)
for y in range(H):
    for x in range(W):
        t = (x + y) / (W + H - 2)
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
mask = Image.new('L', (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle((16, 16, W - 16, H - 16), radius=110, fill=255)
img.paste(grad, (0, 0), mask)
hl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(hl).ellipse((-120, -300, W + 120, 250), fill=(255, 255, 255, 50))
img = Image.alpha_composite(img, Image.composite(hl, Image.new('RGBA', (W, H), (0, 0, 0, 0)), mask))
d = ImageDraw.Draw(img)
# монитор
d.rounded_rectangle((96, 120, 416, 330), radius=26, outline=(255, 255, 255, 255), width=22)
d.line((256, 330, 256, 380), fill=(255, 255, 255, 255), width=22)
d.rounded_rectangle((176, 372, 336, 394), radius=11, fill=(255, 255, 255, 255))
# play
d.polygon([(226, 178), (226, 272), (306, 225)], fill=(255, 255, 255, 255))
for out in sys.argv[1:]:
    img.save(out)
    print('saved', out)
