"""按 JSON 清单剪接 HDR 口播、重算字幕并导出审片版；原件只读。"""
import json
import math
from pathlib import Path
import subprocess
import sys
import argparse


def timeline(plan):
    elapsed, cues = 0, []
    if not plan['clips']:
        raise ValueError('剪辑清单不能为空')
    for clip in plan['clips']:
        start, end = clip['start'], clip['end']
        if not all(math.isfinite(t) for t in (start, end)) or not 0 <= start < end:
            raise ValueError('无效的片段时间')
        local = []
        for cue in plan['captions']:
            if not all(math.isfinite(cue[k]) for k in ('start', 'end')) or not 0 <= cue['start'] < cue['end']:
                raise ValueError('无效的字幕时间')
            if cue['source'] == clip['source']:
                a, b = max(start, cue['start']), min(end, cue['end'])
                if a < b:
                    local.append((elapsed + a - start, elapsed + b - start, cue['text']))
        cues.extend(sorted(local))
        elapsed += end - start
    for i, (a, b, text) in enumerate(cues):
        if not text.strip() or len(text) > 22 or any(c in text for c in '{}\\\n\r'):
            raise ValueError('字幕须为不超过 22 字的单行纯文字')
        if i and a < cues[i - 1][1] - 0.001:
            raise ValueError('字幕时间重叠')
    return elapsed, cues


def stamp(t, srt=False):
    n = round(t * (1000 if srt else 100))
    rate = 1000 if srt else 100
    return f'{n // (3600*rate):02}:{n // (60*rate) % 60:02}:{n // rate % 60:02}{"," if srt else "."}{n % rate:0{3 if srt else 2}}'


def make_ass(cues, style=None):
    style = {'font_size': 72, 'scale_y': 96, 'x': 540, 'y': 1494} | (style or {})
    limits = {'font_size': (1, 200), 'scale_y': (20, 200), 'x': (0, 1080), 'y': (0, 1920)}
    if set(style) != set(limits) or any(not math.isfinite(style[k]) or not a <= style[k] <= b for k, (a, b) in limits.items()):
        raise ValueError('无效字幕样式参数')
    ass = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,SourceHanSerifCN-Heavy,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,96,0,0,1,0,0,5,50,50,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    ass = ass.replace('SourceHanSerifCN-Heavy,72,', f'SourceHanSerifCN-Heavy,{style["font_size"]},').replace('100,96,', f'100,{style["scale_y"]},')
    x, y = style['x'], style['y']
    # shortcut: 字身按参考片像素校准；阴影滑块无通用像素定义，仍为视觉近似。
    for a, b, text in cues:
        ass += f'Dialogue: 0,{stamp(a)},{stamp(b)},Default,,0,0,0,,{{\\pos({x+7.1},{y+7.1})\\c&H000000&\\alpha&H8C&\\blur9}}{text}\n'
        ass += f'Dialogue: 1,{stamp(a)},{stamp(b)},Default,,0,0,0,,{{\\pos({x},{y})}}{text}\n'
    return ass


def main():
    import imageio_ffmpeg
    parser = argparse.ArgumentParser()
    parser.add_argument('plan')
    parser.add_argument('--prepare', action='store_true', help='只编译工程和渲染命令，不编码视频')
    args = parser.parse_args()
    plan_path = Path(args.plan).resolve()
    root = plan_path.parent
    plan = json.loads(plan_path.read_text())
    duration, cues = timeline(plan)
    output = (root / plan['output']).resolve()
    if output.exists():
        raise FileExistsError(f'成片已存在，请使用新版本文件名：{output}')
    font = Path(plan.get('font', '~/.cache/rocc-edit/SourceHanSerifCN-Heavy.otf')).expanduser().resolve()
    if not font.is_file():
        raise FileNotFoundError(font)
    from PIL import ImageFont
    if ImageFont.truetype(str(font), 72).getname() != ('Source Han Serif CN', 'Heavy'):
        raise ValueError('当前默认使用思源宋体 Heavy，请更新工程 font 为 SourceHanSerifCN-Heavy.otf')
    sources = list(dict.fromkeys(c['source'] for c in plan['clips']))
    profiles = set()
    media = []
    for source in sources:
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'quiet', '-show_streams', '-show_format', '-of', 'json', str(root/source)]))
        if not {'video', 'audio'} <= {s['codec_type'] for s in info['streams']}:
            raise ValueError(f'缺少视频或音轨：{source}')
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        profile = (video.get('color_transfer'), video.get('color_primaries'), video.get('color_space'))
        if profile not in {('bt709', 'bt709', 'bt709'), ('arib-std-b67', 'bt2020', 'bt2020nc')}:
            raise ValueError(f'尚未验证的色彩格式：{profile}，不能静默转换')
        profiles.add(profile)
        media.append({'source': source, 'video': video, 'duration': info['format']['duration']})
        width, height = video['width'], video['height']
        rotation = next((s.get('rotation', 0) for s in video.get('side_data_list', []) if s['side_data_type'] == 'Display Matrix'), 0)
        if round(rotation) % 180:
            width, height = height, width
        if width * 16 != height * 9:
            raise ValueError('本渲染方案只支持显示方向为 9:16 的竖屏素材')
        for clip in plan['clips']:
            if clip['source'] == source and clip['end'] > float(info['format']['duration']) + 0.03:
                raise ValueError(f'出点超出素材：{source}')
    if len(profiles) != 1:
        raise ValueError('HDR/SDR 混合工程需要明确色彩方案，不能自动套用')
    transfer, primaries, matrix = profiles.pop()
    hdr = transfer == 'arib-std-b67'
    pixels = 'yuv420p10le' if hdr else 'yuv420p'
    (root/'media.json').write_text(json.dumps(media, ensure_ascii=False, indent=2))
    ass = make_ass(cues, plan.get('subtitle'))
    (root/'captions.ass').write_text(ass)
    (root/'captions.srt').write_text(''.join(f'{i}\n{stamp(a, True)} --> {stamp(b, True)}\n{text}\n\n' for i, (a, b, text) in enumerate(cues, 1)))
    filters, inputs = [], []
    for source in sources:
        inputs += ['-i', str(root/source)]
    for i, clip in enumerate(plan['clips']):
        k, a, b = sources.index(clip['source']), clip['start'], clip['end']
        filters += [f'[{k}:v]trim=start={a}:end={b},setpts=PTS-STARTPTS,setsar=1[v{i}]',
                    f'[{k}:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}]']
    chain = ''.join(f'[v{i}][a{i}]' for i in range(len(plan['clips'])))
    filters += [f'{chain}concat=n={len(plan["clips"])}:v=1:a=1[vcat][acat]']
    # 直接合成原片，保留 HLG/SDR 色彩解释；不预转整段素材，不做隐式 tone-map。
    filters += [f"[vcat]scale=1080:1920,format={pixels},ass=filename=captions.ass:fontsdir='{font.parent}',fade=t=out:st={duration-0.5}:d=0.5[vout]",
                f'[acat]afade=t=out:st={max(0, duration-0.12)}:d=0.12[aout]']
    (root/'render.ffgraph').write_text(';\n'.join(filters))
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = root / f'{output.stem}.encoded.mp4'
    if encoded.exists():
        raise FileExistsError(f'编码中间文件已存在，请使用新版本：{encoded}')
    codec = ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'] if hdr else ['-c:v', 'libx264']
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-n', '-hide_banner', *inputs, '-filter_complex_script', 'render.ffgraph',
               '-map', '[vout]', '-map', '[aout]', '-r', '30', *codec, '-preset', 'fast', '-crf', '18',
               '-pix_fmt', pixels, '-color_primaries', primaries, '-color_trc', transfer, '-colorspace', matrix,
               '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-map_metadata', '-1', str(encoded)]
    # 编码器可能沿用源片 Display Matrix，清除标记避免播放器再次旋转；不重新压缩。
    remux = ['ffmpeg', '-n', '-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '0', '-i', str(encoded),
             '-map', '0', '-c', 'copy', '-movflags', '+faststart', str(output)]
    (root/'render-command.json').write_text(json.dumps([command, remux], ensure_ascii=False, indent=2))
    if args.prepare:
        print(f'工程已编译，未编码视频：{root}；{duration:.3f} 秒，{len(cues)} 条字幕，{transfer}')
        return
    with (root/'render.log').open('w') as log:
        subprocess.run(command, cwd=root, stdout=log, stderr=log, check=True)
        subprocess.run(remux, cwd=root, stdout=log, stderr=log, check=True)
    print(f'导出完成：{output}；计划时长 {duration:.3f} 秒，字幕 {len(cues)} 条')


if __name__ == '__main__':
    main()
