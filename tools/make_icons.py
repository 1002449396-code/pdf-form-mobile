"""Draw the app icons once (icons/*.png). Same mark as the desktop editor:
a page with lines, white on the accent colour. Needs Pillow.

    python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ACCENT = (0x22, 0x57, 0xC7, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # draw 4x and scale down = smooth edges


def page(d: ImageDraw.ImageDraw, box: tuple[float, float, float, float]) -> None:
    """The Lucide 'file-text' outline, on a 24-unit grid mapped into box."""
    x0, y0, x1, y1 = box
    u = (x1 - x0) / 24
    w = max(1, round(2 * u))
    P = lambda x, y: (x0 + x * u, y0 + y * u)
    # rounded body, then the top-right corner cut off and folded
    d.rounded_rectangle([P(5, 3), P(19, 21)], radius=2 * u, outline=WHITE, width=w)
    d.polygon([P(13.6, 2), P(20, 2), P(20, 8.4)], fill=ACCENT)
    d.line([P(14, 3), P(19, 8)], WHITE, w)
    d.line([P(14, 3), P(14, 8), P(19, 8)], WHITE, w, joint="curve")
    d.line([P(9, 14), P(15, 14)], WHITE, w)
    d.line([P(9, 17), P(13, 17)], WHITE, w)
    for x, y in ((14, 3), (19, 8), (9, 14), (15, 14), (9, 17), (13, 17)):
        cx, cy = P(x, y)
        d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], WHITE)


def icon(size: int, maskable: bool) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:   # full bleed; Android crops it to its own shape
        d.rectangle([0, 0, big, big], ACCENT)
        inset = big * 0.26
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], big * 0.22, ACCENT)
        inset = big * 0.16
    page(d, (inset, inset, big - inset, big - inset))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    icon(192, False).save(out / "icon-192.png")
    icon(512, False).save(out / "icon-512.png")
    icon(512, True).save(out / "icon-maskable-512.png")
    print("icons written")
