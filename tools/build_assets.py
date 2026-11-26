"""Generate the app icons and the QR codes (LinkedIn, and the case study for presenter mode).

Usage: python tools/build_assets.py   (needs: pip install pillow qrcode)
"""
from pathlib import Path

import qrcode
import qrcode.image.svg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
INK, WHITE = (12, 10, 9), (255, 255, 255)
# Lightning bolt from the site's logo, in a 24x24 box.
BOLT = [(13.5, 2), (5, 14), (10.5, 14), (9, 22), (17.5, 10), (12, 10)]


def icon(size, maskable=False, path=None):
    big = size * 4                                    # draw large, then downscale for smooth edges
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, big, big], fill=INK)       # full bleed; launcher applies its own mask
        scale, pad = big * 0.5 / 24, big * 0.25
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=INK)
        scale, pad = big * 0.7 / 24, big * 0.15
    d.polygon([(pad + x * scale, pad + y * scale) for x, y in BOLT], fill=WHITE)
    img.resize((size, size), Image.LANCZOS).save(path)


icons = ROOT / "assets" / "icons"
icons.mkdir(parents=True, exist_ok=True)
icon(192, path=icons / "icon-192.png")
icon(512, path=icons / "icon-512.png")
icon(512, maskable=True, path=icons / "icon-maskable-512.png")

img_dir = ROOT / "assets" / "img"
img_dir.mkdir(parents=True, exist_ok=True)
for url, name in (("https://www.linkedin.com/in/baizakisaev/", "qr-linkedin.svg"),
                  ("https://baizakisaev.com/ai-grid-trader-case-study", "qr-case-study.svg")):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(img_dir / name)
print("icons and QR codes written")
