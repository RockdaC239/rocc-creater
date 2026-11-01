import io
import json
from pathlib import Path
import unittest
from PIL import Image
import resvg_py
from 封面渲染 import svg, text_paths


class CoverTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name('封面版式.json').read_text())
        if not Path(self.config['font']).expanduser().exists():
            self.skipTest('需要无界黑字体缓存')

    def test_reference_glyph_boxes(self):
        png = resvg_py.svg_to_bytes(svg_string=svg('生意惨淡', self.config, shadow=False))
        im = Image.open(io.BytesIO(png))
        self.assertEqual(im.size, (1917, 2556))
        for a, b, c, d in self.config['boxes']:
            # 实际渲染字身必须落在参考位置；允许抗锯齿导致的 1px 差异。
            crop = im.crop((a-5, b-5, c+5, d+5)).getchannel('A').point(lambda p: 255 if p > 128 else 0)
            actual = crop.getbbox()
            expected = (5, 5, c-a+5, d-b+5)
            for x, y in zip(actual, expected):
                self.assertAlmostEqual(x, y, delta=1)

    def test_four_characters_only(self):
        with self.assertRaises(ValueError):
            text_paths('三个字', self.config)
        with self.assertRaises(ValueError):
            text_paths('生 意惨', self.config)


if __name__ == '__main__':
    unittest.main()
