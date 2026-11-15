"""Render Wellmet's favicon from one geometric "W".

The mark is a filled polygon on a 64-unit grid: black on signal yellow, the
two colours of the Swiss-grid design. The same points produce the SVG and,
through Pillow (drawn at 16x and scaled down), the PNG and ICO files.

    python3 scripts/make-favicon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

INK = "#111111"
SIGNAL = "#ffd400"

# A flat-topped W with ~11-unit strokes, centred on the 64 grid.
W = [
    (6, 14), (17, 14), (23, 37), (28, 21), (36, 21), (41, 37), (47, 14), (58, 14),
    (47, 51), (37, 51), (32, 34), (27, 51), (17, 51),
]

OUT = Path(__file__).resolve().parent.parent / "packages" / "public" / "static"


def svg() -> str:
    points = " ".join(f"{x},{y}" for x, y in W)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" fill="{SIGNAL}"/>'
        f'<polygon points="{points}" fill="{INK}"/>'
        "</svg>\n"
    )


def png(size: int) -> Image.Image:
    scale = 16
    big = size * scale
    k = big / 64
    image = Image.new("RGB", (big, big), SIGNAL)
    ImageDraw.Draw(image).polygon([(x * k, y * k) for x, y in W], fill=INK)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    (OUT / "favicon.svg").write_text(svg())
    png(180).save(OUT / "apple-touch-icon.png", optimize=True)
    png(48).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote favicon.svg, favicon.ico, apple-touch-icon.png to", OUT)


if __name__ == "__main__":
    main()
