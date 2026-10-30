"""核验工程对应成片，保存独立报告；色彩抽检不代替完整听审。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageStat
from 口播渲染 import timeline


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'quiet', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def main():
    plan_path = Path(sys.argv[1]).resolve()
    root = plan_path.parent
    plan = json.loads(plan_path.read_text())
    output = (root/plan['output']).resolve()
    duration, cues = timeline(plan)
    data = probe(output)
    video = next(s for s in data['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in data['streams'] if s['codec_type'] == 'audio')
    assert (video['width'], video['height']) == (1080, 1920)
    assert abs(float(video['duration'])-duration) < .2, '成片时长不符'
    assert abs(float(video['duration'])-float(audio['duration'])) < .05, '音视频时长不符'
    assert not any(s.get('rotation', 0) for s in video.get('side_data_list', []))
    assert not cues or cues[-1][1] <= float(video['duration']), '字幕超出成片'
    expected = probe(root/plan['clips'][0]['source'])
    source_video = next(s for s in expected['streams'] if s['codec_type'] == 'video')
    for key in ['color_primaries', 'color_transfer', 'color_space']:
        assert video[key] == source_video[key], f'色彩标签改变：{key}'
    if video['color_transfer'] == 'arib-std-b67':
        assert video['codec_name'] == 'hevc' and '10' in video['pix_fmt'], 'HDR 必须使用 10 位 HEVC'
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(output), '-f', 'null', '-'], check=True)
    folder = Path(tempfile.mkdtemp(prefix='核验-', dir=root))
    grabber = Path.home()/'.cache/rocc-edit/原生抽帧'
    if not grabber.exists():
        subprocess.run(['swiftc', str(Path(__file__).with_name('原生抽帧.swift')), '-o', str(grabber)], check=True)
    samples, elapsed = [], 0
    for i, clip in enumerate(plan['clips']):
        offset = 0 if i == 0 else min(.1, (clip['end']-clip['start'])/2)
        paths = [folder/f'{i}-source.png', folder/f'{i}-output.png']
        for path, media, time in zip(paths, [root/clip['source'], output], [clip['start']+offset, elapsed+offset]):
            subprocess.run([str(grabber), str(media), str(time), str(path)], check=True)
        images = [Image.open(p).convert('RGB') for p in paths]
        # shortcut: 中央区域均值抽检色偏；复杂运镜或强曝光变化时需增加人工逐帧检查。
        crops = [im.crop((270, 576, 810, 1248)) for im in images]
        means = [ImageStat.Stat(im).mean for im in crops]
        delta = max(abs(a-b) for a, b in zip(*means))
        if i == 0:
            delta = max(ImageStat.Stat(ImageChops.difference(*images)).mean)
        assert delta < (3 if i == 0 else 12), f'第 {i} 个切入点色彩抽检失败：{delta}'
        samples.append({'clip': i, 'output_time': elapsed+offset, 'color_difference': delta})
        elapsed += clip['end']-clip['start']
    hashes = {s: hashlib.file_digest((root/s).open('rb'), 'sha256').hexdigest() for s in dict.fromkeys(c['source'] for c in plan['clips'])}
    report = {'output': str(output), 'duration': video['duration'], 'subtitles': len(cues), 'decode': '通过', 'color_samples': samples,
              'source_sha256': hashes, 'limits': '抽检通过不等于逐帧一致；未完整听审，未验证发布平台 HDR 兼容性；不保留 Dolby Vision 动态元数据'}
    (folder/'报告.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f'核验通过：{folder / "报告.json"}')


if __name__ == '__main__':
    main()
