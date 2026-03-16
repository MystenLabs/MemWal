#!/usr/bin/env python3
"""
Recolor blue brand icons to green while preserving shading.

Usage:
  python3 scripts/recolor_icons.py
"""

from __future__ import annotations

from pathlib import Path
import colorsys
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

ICON_FILES = [
    PUBLIC / "favicon-16x16.png",
    PUBLIC / "favicon-32x32.png",
    PUBLIC / "apple-touch-icon.png",
    PUBLIC / "android-chrome-192x192.png",
    PUBLIC / "android-chrome-512x512.png",
    PUBLIC / "favicon.ico",
]

# Keep original icon shape and shadows; only retint blue-ish pixels.
TARGET_HEX = "#B9FF66"
TARGET_RGB = tuple(int(TARGET_HEX[i : i + 2], 16) for i in (1, 3, 5))
TARGET_H = colorsys.rgb_to_hsv(*(c / 255 for c in TARGET_RGB))[0]

# Old logo blue sits roughly in this hue range.
BLUE_HUE_MIN = 0.50
BLUE_HUE_MAX = 0.72


def recolor_file(path: Path) -> None:
    img = Image.open(path).convert("RGBA")
    out = Image.new("RGBA", img.size)

    src = img.load()
    dst = out.load()
    width, height = img.size

    for y in range(height):
        for x in range(width):
            r, g, b, a = src[x, y]
            if a == 0:
                dst[x, y] = (r, g, b, a)
                continue

            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if BLUE_HUE_MIN <= h <= BLUE_HUE_MAX and s > 0.12 and v > 0.12:
                nr, ng, nb = colorsys.hsv_to_rgb(TARGET_H, max(s, 0.25), v)
                dst[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
            else:
                dst[x, y] = (r, g, b, a)

    if path.suffix.lower() == ".ico":
        out.save(path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    else:
        out.save(path)

    print(f"recolored: {path.relative_to(ROOT)}")


def main() -> None:
    for icon in ICON_FILES:
        if icon.exists():
            recolor_file(icon)
        else:
            print(f"skip (missing): {icon.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
