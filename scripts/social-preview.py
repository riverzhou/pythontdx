#!/usr/bin/env python3
"""生成 GitHub 社交预览图（1280×640）。

为什么需要它：GitHub 的社交预览（Settings → Social preview）**没有 API**，只能
手动上传；默认卡片是灰底仓库名，分享到 X / 微信 / Slack 时几乎没有点击欲望。
这个脚本把「标题 + 一句定位 + 能力标签 + 一张真实截图」拼成一张图。

不参与构建、不参与测试；只在更新发布素材时手动跑一次：

    npm run social      # 或 python scripts/social-preview.py

依赖 Pillow（可选依赖，因此没写进 requirements.txt）。截图取自 README 用的
`docs/assets/pythontdx-1.6-overview.png`；换版本时改下面的 VERSION 即可。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # 手动工具，不进测试与打包
    raise SystemExit("缺少 Pillow：python -m pip install pillow（只在生成发布素材时需要）") from None

ROOT = Path(__file__).resolve().parent.parent
SCREENSHOT = ROOT / "docs" / "assets" / "pythontdx-1.6-overview.png"
OUTPUT = ROOT / "docs" / "assets" / "pythontdx-social-preview.png"

WIDTH, HEIGHT = 1280, 640
VERSION = "v1.6.1"

BACKGROUND_TOP = (10, 14, 22)
BACKGROUND_BOTTOM = (16, 23, 36)
ACCENT = (77, 163, 255)
TEXT = (240, 246, 255)
MUTED = (138, 160, 192)
CHIP_FILL = (24, 34, 54)
CHIP_BORDER = (48, 66, 98)
CHIP_TEXT = (207, 224, 245)

FONT_CANDIDATES = {
    "bold": [
        "C:/Windows/Fonts/msyhbd.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ],
    "regular": [
        "C:/Windows/Fonts/msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ],
}

CHIPS = ["实时行情", "分时 · K 线", "五档 · 逐笔", "F10 · 选股", "离线数据湖"]
HIGHLIGHTS = [
    "29 条 7709 命令 · 15 条 MAC · 51 个 7615 入口",
    "24 个离线数据集 · Parquet/ZSTD + DuckDB",
    "372 TS + 336 Python 测试全绿",
]


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES[kind]:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise SystemExit(f"找不到可用字体（{kind}），请把一个 CJK 字体路径加到 FONT_CANDIDATES")


def gradient(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height), BACKGROUND_TOP)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / (height - 1)
        color = tuple(
            round(top + (bottom - top) * ratio)
            for top, bottom in zip(BACKGROUND_TOP, BACKGROUND_BOTTOM)
        )
        draw.line([(0, y), (width, y)], fill=color)
    return image


def add_glow(image: Image.Image) -> None:
    """左上角一团冷色光，避免整张图太平；用模糊的椭圆叠加。"""
    overlay = Image.new("RGB", image.size, (0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.ellipse([-260, -320, 520, 300], fill=(26, 62, 116))
    overlay = overlay.filter(ImageFilter.GaussianBlur(90))
    image.paste(Image.blend(image, Image.blend(image, overlay, 0.85), 0.55), (0, 0))


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius: int, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def paste_screenshot(canvas: Image.Image, photo: Image.Image, box: tuple[int, int, int, int]) -> None:
    """把截图裁成圆角卡片贴上去，带 1px 边框与轻微投影。"""
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    scale = max(width / photo.width, height / photo.height)
    resized = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.LANCZOS)
    offset_x = (resized.width - width) // 2
    offset_y = (resized.height - height) // 2
    cropped = resized.crop((offset_x, offset_y, offset_x + width, offset_y + height))

    radius = 18
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, width - 1, height - 1], radius=radius, fill=255)
    cropped = cropped.convert("RGB")

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [left + 6, top + 10, right + 6, bottom + 10], radius=radius, fill=(0, 0, 0, 130)
    )
    canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB"), (0, 0))
    canvas.paste(cropped, (left, top), mask)

    draw = ImageDraw.Draw(canvas)
    rounded_rect(draw, [left, top, right, bottom], radius, outline=(46, 60, 88), width=2)


def draw_chips(draw: ImageDraw.ImageDraw, chip_font: ImageFont.FreeTypeFont, x: int, y: int) -> int:
    """从左到右排标签，放不下就换行；返回下一行的 y。"""
    padding_x, padding_y, gap, height = 12, 7, 8, 34
    cursor = x
    for chip in CHIPS:
        text_width = chip_font.getlength(chip)
        chip_width = round(text_width) + padding_x * 2
        if cursor + chip_width > WIDTH - 60 and cursor != x:
            cursor = x
            y += height + gap
        box = [cursor, y, cursor + chip_width, y + height]
        rounded_rect(draw, box, height // 2, fill=CHIP_FILL, outline=CHIP_BORDER, width=1)
        draw.text(
            (cursor + chip_width / 2, y + height / 2),
            chip,
            font=chip_font,
            fill=CHIP_TEXT,
            anchor="mm",
        )
        cursor += chip_width + gap
    return y + height


def draw_highlights(draw: ImageDraw.ImageDraw, font_: ImageFont.FreeTypeFont, x: int, y: int) -> None:
    """三条事实，用来填左下角空白，也给「这项目到底做到哪」一个可核对的说法。"""
    for index, line in enumerate(HIGHLIGHTS):
        line_y = y + index * 34
        rounded_rect(draw, [x, line_y + 4, x + 4, line_y + 20], 2, fill=ACCENT)
        draw.text((x + 16, line_y), line, font=font_, fill=MUTED)


def main() -> None:
    if not SCREENSHOT.is_file():
        raise SystemExit(f"缺少截图：{SCREENSHOT}")
    if not OUTPUT.parent.is_dir():
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    title_font = font("bold", 58)
    tagline_font = font("bold", 29)
    english_font = font("regular", 19)
    chip_font = font("regular", 19)
    footer_font = font("regular", 18)

    canvas = gradient(WIDTH, HEIGHT)
    add_glow(canvas)
    draw = ImageDraw.Draw(canvas)

    # 左侧：品牌与能力
    draw.text((64, 58), "pythontdx", font=title_font, fill=TEXT)
    draw.text((68, 140), "A 股行情终端 · 手写通达信协议", font=tagline_font, fill=TEXT)
    for index, line in enumerate(
        [
            "A-share market terminal on the Tongdaxin",
            "(TDX) protocol — Electron + SolidJS + Python",
        ]
    ):
        draw.text((68, 190 + index * 27), line, font=english_font, fill=MUTED)

    bottom_of_chips = draw_chips(draw, chip_font, 68, 262)
    draw_highlights(draw, footer_font, 68, bottom_of_chips + 30)

    draw.text(
        (68, HEIGHT - 130),
        "从 0 手写 · 只做 A 股 · 不接第三方数据源",
        font=english_font,
        fill=CHIP_TEXT,
    )

    draw.text(
        (68, HEIGHT - 92),
        f"github.com/riverzhou/pythontdx  ·  GPL-3.0  ·  {VERSION}",
        font=footer_font,
        fill=TEXT,
    )
    draw.text(
        (68, HEIGHT - 62),
        "Windows x64 · macOS arm64 · Linux x64",
        font=footer_font,
        fill=MUTED,
    )

    # 右侧：真实截图
    photo = Image.open(SCREENSHOT).convert("RGB")
    paste_screenshot(canvas, photo, (700, 100, 1240, 540))

    canvas.save(OUTPUT, format="PNG", optimize=True)
    print(f"social preview: {OUTPUT} ({OUTPUT.stat().st_size:,} B, {WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    sys.exit(main())
