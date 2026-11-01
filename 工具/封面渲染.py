"""四字封面：按参考字身边界生成 SVG 路径模板，再用 resvg 输出 PNG。"""
import argparse
import base64
import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import resvg_py


def text_paths(text, config):
    if len(text) != 4 or any(c.isspace() for c in text):
        raise ValueError('当前模板为四字、上下各两字；其他字数需另行校准')
    font = TTFont(Path(config['font']).expanduser())
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    paths = []
    for char, reference_char, box in zip(text, config['reference_text'], config['boxes']):
        if ord(char) not in cmap:
            raise ValueError(f'无界黑缺少字符：{char}')
        glyph = glyphs[cmap[ord(char)]]
        bounds = BoundsPen(glyphs)
        glyph.draw(bounds)
        if bounds.bounds is None:
            raise ValueError(f'字符没有可绘制轮廓：{char}')
        reference_bounds = BoundsPen(glyphs)
        glyphs[cmap[ord(reference_char)]].draw(reference_bounds)
        x0, y0, x1, y1 = reference_bounds.bounds
        a, b, c, d = box
        sx, sy = (c-a)/(x1-x0), (d-b)/(y1-y0)
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        paths.append(f'<path transform="matrix({sx} 0 0 {-sy} {a-sx*x0} {b+sy*y1})" d="{pen.getCommands()}"/>')
    font.close()
    return ''.join(paths)


def svg(text, config, background=None, shadow=True):
    width, height = config['canvas']
    paths = text_paths(text, config)
    picture = ''
    if background:
        path = Path(background)
        mime = 'image/png' if path.suffix.lower() == '.png' else 'image/jpeg'
        encoded = base64.b64encode(path.read_bytes()).decode()
        picture = f'<image width="{width}" height="{height}" preserveAspectRatio="{config["background_fit"]}" href="data:{mime};base64,{encoded}"/>'
    s = config['shadow']
    # shortcut: 醒图未公开滑块像素算法，阴影滤镜为待目视确认的近似；文字区域使用实测坐标。
    effect = f'<g transform="translate({s["dx"]},{s["dy"]})" opacity="{s["opacity"]}" filter="url(#blur)" fill="#000000">{paths}</g>' if shadow else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><defs><filter id="blur" x="-30%" y="-50%" width="160%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="{s["std_deviation"]}"/></filter></defs>{picture}{effect}<g fill="{config["fill"]}">{paths}</g></svg>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('background', type=Path)
    parser.add_argument('text')
    parser.add_argument('output', type=Path, help='新建 PNG 文件，另存同名 SVG')
    args = parser.parse_args()
    config = json.loads(Path(__file__).with_name('封面版式.json').read_text())
    output = args.output
    vector = output.with_suffix('.svg')
    if output.exists() or vector.exists():
        raise FileExistsError('拒绝覆盖已有封面，请使用新版本名称')
    if output.suffix.lower() != '.png':
        raise ValueError('输出应为 PNG')
    data = svg(args.text, config, args.background)
    png = resvg_py.svg_to_bytes(svg_string=data, skip_system_fonts=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    vector.write_text(data)
    output.write_bytes(png)
    print(f'已生成：{output}；可复用向量版：{vector}')


if __name__ == '__main__':
    main()
