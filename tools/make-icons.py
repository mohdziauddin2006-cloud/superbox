from PIL import Image
from pathlib import Path

src = Image.open('infinite icon.jpeg').convert('RGBA')
w, h = src.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
img = src.crop((left, top, left + side, top + side))

android = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for d, s in android.items():
    out = Path('android/res/mipmap-' + d) / 'ic_launcher.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    img.resize((s, s), Image.LANCZOS).save(out, 'PNG', optimize=True)
    print('wrote', out, s)

br = Path('build-resources')
br.mkdir(exist_ok=True)
for s in (16, 24, 32, 48, 64, 128, 256, 512):
    out = br / f'icon-{s}.png'
    img.resize((s, s), Image.LANCZOS).save(out, 'PNG', optimize=True)
    print('wrote', out)

img.resize((512, 512), Image.LANCZOS).save(br / 'icon.png', 'PNG', optimize=True)
img.save(br / 'icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote', br / 'icon.ico')
img.resize((512, 512), Image.LANCZOS).save('desktop/icon.png', 'PNG', optimize=True)
print('wrote desktop/icon.png')
