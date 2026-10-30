import unittest
import subprocess
import tempfile
from pathlib import Path

from 口播渲染 import timeline, make_ass


class TimelineTest(unittest.TestCase):
    def test_approved_default_style(self):
        ass = make_ass([(0, 1, '默认口播字幕')])
        self.assertIn('SourceHanSerifCN-Heavy', ass)
        self.assertIn('\\pos(547.1,1501.1)\\c&H000000&\\alpha&H8C&\\blur9', ass)

    def test_invalid_subtitle_style_fails(self):
        with self.assertRaises(ValueError):
            make_ass([], {'font_size': -1})
        with self.assertRaises(ValueError):
            make_ass([], {'y': float('nan')})

    def test_subtitle_pixels_match_reference(self):
        import imageio_ffmpeg
        from PIL import Image
        fontdir = Path.home()/'.cache/rocc-edit'
        if not (fontdir/'SourceHanSerifCN-Heavy.otf').exists():
            self.skipTest('需要本地思源宋体 Heavy 字体缓存')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'captions.ass').write_text(make_ass([(0, 1, '头顶上都有一盏聚光灯打在身上')]))
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=1080x1920',
                            '-vf', f'ass=captions.ass:fontsdir={fontdir}', '-frames:v', '1', 'frame.png'], cwd=root, check=True)
            mask = Image.open(root/'frame.png').convert('L').point(lambda p: 255 if p >= 235 else 0)
            x0, y0, x1, y1 = mask.getbbox()
            # 参考片 4 秒，同一句字幕的白色字身约 x192–888、y1474–1520。
            self.assertAlmostEqual(x1-x0, 697, delta=4)
            self.assertAlmostEqual(y1-y0, 46, delta=3)
            self.assertAlmostEqual((y0+y1)/2, 1497, delta=3)

    def test_cuts_remap_and_clip_captions(self):
        plan = {'clips': [
            {'source': 'a.MOV', 'start': 2, 'end': 5},
            {'source': 'b.MOV', 'start': 10, 'end': 12},
        ], 'captions': [
            {'source': 'a.MOV', 'start': 1, 'end': 3, 'text': '开头'},
            {'source': 'a.MOV', 'start': 6, 'end': 7, 'text': '已删'},
            {'source': 'b.MOV', 'start': 10.5, 'end': 13, 'text': '结尾'},
        ]}
        duration, cues = timeline(plan)
        self.assertEqual(duration, 5)
        self.assertEqual(cues, [(0, 1, '开头'), (3.5, 5, '结尾')])

    def test_invalid_ranges_and_overlapping_subtitles_fail(self):
        with self.assertRaises(ValueError):
            timeline({'clips': [{'source': 'a', 'start': 3, 'end': 2}], 'captions': []})
        with self.assertRaises(ValueError):
            timeline({'clips': [{'source': 'a', 'start': 0, 'end': 5}], 'captions': [
                {'source': 'a', 'start': 0, 'end': 3, 'text': '一'},
                {'source': 'a', 'start': 2, 'end': 4, 'text': '二'},
            ]})


if __name__ == '__main__':
    unittest.main()
