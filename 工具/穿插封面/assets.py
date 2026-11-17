"""生成灰度人像蒙版和可移植 SVG 字形数据。"""
import json
import os
import sys
import tempfile
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image


def mask(source, target, model):
    from rembg import new_session, remove

    session = new_session(model, providers=["CPUExecutionProvider"])
    with Image.open(source) as image:
        alpha = remove(image.convert("RGB"), session=session, only_mask=True).convert("L")
    if alpha.size != image.size or alpha.getextrema()[1] < 128:
        raise ValueError("模型未生成有效人像蒙版")
    with tempfile.NamedTemporaryFile(dir=Path(target).parent, delete=False) as pending:
        try:
            alpha.save(pending, format="PNG")
            pending.close()
            os.replace(pending.name, target)
        finally:
            Path(pending.name).unlink(missing_ok=True)


def glyphs(request):
    result = []
    for spec in request:
        with TTFont(spec["font"], fontNumber=spec["fontIndex"]) as font:
            cmap, shapes = font.getBestCmap(), font.getGlyphSet()
            units = font["head"].unitsPerEm
            letters = {}
            for char in set(spec["text"]):
                if char.isspace():
                    letters[char] = {"advance": 0.32, "path": "", "bounds": None}
                    continue
                if ord(char) not in cmap:
                    raise ValueError(f"字体 {spec['font']} 缺字：{char}")
                glyph = shapes[cmap[ord(char)]]
                path, bounds = SVGPathPen(shapes), BoundsPen(shapes)
                glyph.draw(path)
                glyph.draw(bounds)
                if not bounds.bounds:
                    raise ValueError(f"字符没有可绘制轮廓：{char}")
                letters[char] = {
                    "advance": glyph.width / units,
                    "path": path.getCommands(),
                    "bounds": [v / units for v in bounds.bounds],
                }
            result.append({"units": units, "letters": letters})
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "mask":
            mask(*sys.argv[2:])
        else:
            glyphs(json.load(sys.stdin))
    except Exception as exc:
        sys.exit(f"{exc}")
