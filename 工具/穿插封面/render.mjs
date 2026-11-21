import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const svg = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
const models = ['birefnet-portrait', 'birefnet-general'];
const usage = '用法：node render.mjs 照片 四字标题 副标题 新输出目录 [--ratio 3:4] [--config 文件] [--model 模型] [--cache-dir 目录] [--render-only] [--mask 灰度PNG]';

function python(args, input) {
  const result = spawnSync(process.env.COVER_PYTHON || join(here, '.venv/bin/python'),
    [join(here, 'assets.py'), ...args], {
      input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '4' },
      stdio: args[0] === 'mask' ? ['ignore', 2, 2] : ['pipe', 'pipe', 'pipe'],
    });
  if (result.error) throw new Error(`无法启动 Python，请按 SOP 安装依赖：${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Python 执行失败：${result.signal || result.status}`);
  return result.stdout;
}

function setting(value, low, high, label) {
  if (!Number.isFinite(value) || value < low || value > high) throw new Error(`${label} 必须在 ${low} 至 ${high} 之间`);
}

function checkStyle(style, name, base) {
  setting(style.size, 0.02, 0.5, `${name}.size`);
  setting(style.fontIndex, 0, 99, `${name}.fontIndex`);
  if (!Number.isInteger(style.fontIndex) || !/^#[0-9a-f]{6}$/i.test(style.color) || typeof style.font !== 'string' || !style.font) {
    throw new Error(`${name} 需要有效字体路径、整数 fontIndex 和 #RRGGBB 颜色`);
  }
  style.font = resolve(base, style.font.replace(/^~\//, `${homedir()}/`));
}

function portraitBounds(alpha, width, height) {
  const rowMin = Math.max(2, Math.round(width * 0.012));
  let top = height, bottom = 0, area = 0;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (alpha[y * width + x] >= 128) count++;
    area += count;
    if (count >= rowMin) {
      top = Math.min(top, y);
      bottom = y + 1;
    }
  }
  if (area < width * height * 0.005 || area > width * height * 0.99 || top >= bottom) {
    throw new Error('蒙版未识别到可靠的人像，请切换模型或提供修好的灰度蒙版');
  }
  // shortcut: 单人正立照片用上部轮廓近似头部，复杂多人或非正立构图需要头部检测。
  const headBottom = Math.ceil(top + (bottom - top) * 0.45);
  let left = width, right = 0;
  for (let y = top; y < headBottom; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] >= 128) {
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
      }
    }
  }
  return { top, bottom, headBottom, left, right };
}

function cropFor(width, height, ratio, head) {
  const parts = /^(\d{1,5}):(\d{1,5})$/.exec(ratio);
  if (!parts || Number(parts[1]) === 0 || Number(parts[2]) === 0) throw new Error('比例请输入正整数宽:高，如 3:4');
  let a = Number(parts[1]), b = Number(parts[2]);
  while (b) [a, b] = [b, a % b];
  const rw = Number(parts[1]) / a, rh = Number(parts[2]) / a;
  const scale = Math.floor(Math.min(width / rw, height / rh));
  const w = rw * scale, h = rh * scale;
  const safe = (length, size, l, r) => {
    const low = Math.max(0, r - size), high = Math.min(l, length - size);
    if (low > high) throw new Error('目标比例无法保留检测到的头部范围，请换比例或使用留白更多的照片');
    return clamp(Math.round((length - size) / 2), low, high);
  };
  return { left: safe(width, w, head.left, head.right), top: safe(height, h, head.top, head.headBottom), width: w, height: h };
}

function line(text, font) {
  let width = 0, top = -Infinity, bottom = Infinity, left = Infinity, right = -Infinity;
  const glyphs = [];
  for (const char of text) {
    const glyph = font.letters[char];
    if (glyph.bounds) {
      const [x0, y0, x1, y1] = glyph.bounds;
      top = Math.max(top, y1);
      bottom = Math.min(bottom, y0);
      left = Math.min(left, width + x0);
      right = Math.max(right, width + x1);
      glyphs.push({ ...glyph, x: width });
    }
    width += glyph.advance;
  }
  return { glyphs, units: font.units, width: right - left, left, top, bottom };
}

function paths(layout, size, x, y) {
  const scale = size / layout.units;
  return layout.glyphs.map(g => `<path d="${g.path}" transform="matrix(${scale} 0 0 ${-scale} ${x + (g.x - layout.left) * size} ${y + layout.top * size})"/>`);
}

function layer(width, height, paths, color, shadow, scale) {
  const blur = shadow.std_deviation * scale;
  return svg(width, height, `<defs><filter id="s" x="-100%" y="-150%" width="300%" height="400%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${blur}"/></filter></defs><g fill="#000000" transform="translate(${shadow.dx * scale} ${shadow.dy * scale})" opacity="${shadow.opacity}" filter="url(#s)">${paths}</g><g fill="${color}">${paths}</g>`);
}

async function titlePlacement(layout, style, crop, head, alpha, width) {
  const pad = Math.max(2, Math.round(crop.width * 0.035));
  const size = Math.min(style.size * crop.width, (crop.width - 2 * pad - 2) / layout.width);
  const w = Math.ceil(layout.width * size) + 2;
  const h = Math.ceil((layout.top - layout.bottom) * size) + 2;
  const x = clamp(Math.round(crop.left + crop.width * style.x - w / 2), crop.left + pad, crop.left + crop.width - pad - w);
  const low = crop.top + pad, high = Math.min(crop.top + Math.floor(crop.height * 0.48) - h, head.headBottom - h);
  if (high < low) return null;

  const sample = Math.max(1, Math.round(crop.width / 600));
  const positions = await Promise.all(paths(layout, size, 1, 1).map(async path => {
    const raster = await sharp(Buffer.from(svg(w, h, path))).ensureAlpha().raw().toBuffer();
    const ink = [];
    for (let j = 0; j < h; j += sample) {
      for (let i = 0; i < w; i += sample) if (raster[(j * w + i) * 4 + 3] >= 128) ink.push([i, j]);
    }
    if (!ink.length) throw new Error('大标题字号过小，无法核验字形');
    return ink;
  }));
  const fixed = style.top != null;
  const preferred = fixed ? crop.top + Math.round(crop.height * style.top) - 1 : clamp(Math.round(head.top - h * (1 - style.overlapDepth) + crop.height * style.yOffset), low, high);
  const step = Math.max(1, Math.round(crop.height * 0.003));
  if (fixed && (preferred < low || preferred > high)) return null;
  const candidates = new Set([preferred]);
  if (!fixed) {
    candidates.add(low);
    candidates.add(high);
    for (let y = low; y <= high; y += step) candidates.add(y);
  }
  for (const y of [...candidates].sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred))) {
    let covered = 0, count = 0, soft = 0;
    const visibility = positions.map(ink => {
      let hidden = 0;
      for (const [i, j] of ink) {
        const a = alpha[(y + j) * width + x + i];
        hidden += a / 255;
        if (a > 30 && a < 225) soft++;
      }
      covered += hidden;
      count += ink.length;
      return 1 - hidden / ink.length;
    });
    const overlap = covered / count;
    const softEdge = soft / count;
    if (Math.min(...visibility) < style.minVisiblePerGlyph || (!fixed && overlap < 0.006) || softEdge > 0.045) continue;
    return { x: x + 1, y: y + 1, size, overlap, visibility, softEdge, preferredY: preferred + 1, adjusted: y !== preferred };
  }
  return null;
}

function subtitlePaths(text, font, style, crop, title, titleBottom) {
  const minBottomMargin = Math.max(crop.height * 0.035, title.y - crop.top);
  const x = title.x + Math.round(crop.width * style.xOffset);
  const maxWidth = crop.left + crop.width * 0.95 - x;
  const groups = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (let factor = 1; factor >= 0.59; factor -= 0.05) {
    const size = style.size * crop.width * factor;
    const lines = [];
    for (const group of groups) {
      let current = '';
      for (const char of group) {
        if (current.trim() && char.trim() && line(current + char, font).width * size > maxWidth) {
          lines.push(line(current.trim(), font));
          current = '';
        }
        current += char;
      }
      if (current.trim()) lines.push(line(current.trim(), font));
    }
    if (lines.length > 3 || lines.some(item => item.width * size > maxWidth)) continue;
    const step = size * style.lineHeight;
    const height = Math.max(...lines.map((item, i) => i * step + (item.top - item.bottom) * size));
    const low = Math.max(titleBottom + size * 0.5, crop.top + crop.height * 0.69);
    const high = crop.top + crop.height - minBottomMargin - height - 1;
    if (high < low) continue;
    const top = clamp(crop.top + crop.height * style.y - height / 2, low, high);
    const elements = lines.flatMap((item, i) => paths(item, size, x, top + i * step));
    return { elements, lines: lines.length, size, x, bottomMargin: crop.top + crop.height - top - height };
  }
  throw new Error('副标题在左对齐及底部留白约束下放不下三行，请缩短文案或调小 subtitle.size');
}

async function portraitLayer(base, alpha, width, height) {
  return sharp(base).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function detectPeople(base) {
  const source = await readFile(join(here, 'detect-people.swift'));
  const version = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const folder = join(homedir(), '.cache/rocc-edit');
  const binary = join(folder, `cover-detect-${version}`);
  await mkdir(folder, { recursive: true });
  try {
    await readFile(binary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error('[人物检测] 首次编译本地 Apple Vision 检测器');
    const build = spawnSync('swiftc', [join(here, 'detect-people.swift'), '-o', binary], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`无法编译人物检测器，请安装 Xcode Command Line Tools：${build.stderr || build.error?.message}`);
  }
  const temp = await mkdtemp(join(tmpdir(), 'cover-detect-'));
  try {
    const input = join(temp, 'image.png');
    await writeFile(input, base);
    const result = spawnSync(binary, [input], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || '人物检测失败');
    return JSON.parse(result.stdout);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function intersectsPeople(pixels, width, height, boxes) {
  return boxes.some(box => {
    for (let y = Math.max(0, Math.floor(box.top)); y < Math.min(height, Math.ceil(box.bottom)); y++) {
      for (let x = Math.max(0, Math.floor(box.left)); x < Math.min(width, Math.ceil(box.right)); x++) {
        if (pixels[(y * width + x) * 4 + 3] >= 128) return true;
      }
    }
    return false;
  });
}

async function render() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    ratio: { type: 'string' }, config: { type: 'string' }, model: { type: 'string' },
    'cache-dir': { type: 'string' }, 'render-only': { type: 'boolean' }, mask: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return console.log(usage);
  const [input, title, subtitle, output] = positionals;
  if (positionals.length !== 4 || !/^\p{Script=Han}{4}$/u.test(title) || !subtitle.trim()) {
    throw new Error(`需要恰好四个汉字的大标题和非空副标题。\n${usage}`);
  }
  if ([...subtitle].length > 150) throw new Error('副标题过长，请控制在三行能排下的字数');
  const template = await json(join(here, 'template.json'));
  const configPath = values.config && resolve(values.config);
  const custom = configPath ? await json(configPath) : {};
  const style = { ...template.title, ...custom.title };
  const subStyle = { ...template.subtitle, ...custom.subtitle };
  const model = values.model ?? custom.model ?? template.model;
  if (!models.includes(model)) throw new Error(`--model 仅支持 ${models.join('、')}`);
  const ratio = values.ratio ?? custom.ratio ?? template.ratio;
  const previewWidth = custom.previewWidth ?? template.previewWidth;
  setting(previewWidth, 100, 4000, 'previewWidth');
  if (!Number.isInteger(previewWidth)) throw new Error('previewWidth 必须为整数');
  if (style.top != null) setting(style.top, 0, 0.4, 'title.top');
  setting(style.x, 0, 1, 'title.x');
  setting(style.yOffset, -1, 1, 'title.yOffset');
  setting(style.overlapDepth, 0, 1, 'title.overlapDepth');
  setting(style.minVisiblePerGlyph, 0.5, 0.99, 'title.minVisiblePerGlyph');
  setting(subStyle.xOffset, 0, 0.25, 'subtitle.xOffset');
  setting(subStyle.y, 0, 1, 'subtitle.y');
  setting(subStyle.lineHeight, 1.1, 2, 'subtitle.lineHeight');
  checkStyle(style, 'title', custom.title?.font ? dirname(configPath) : here);
  checkStyle(subStyle, 'subtitle', custom.subtitle?.font ? dirname(configPath) : here);
  const reference = await json(join(here, '../封面版式.json'));
  const shadow = { ...reference.shadow, ...custom.shadow };
  setting(shadow.opacity, 0, 1, 'shadow.opacity');
  const subtitleShadow = { ...shadow, opacity: subStyle.shadowOpacity ?? shadow.opacity,
    std_deviation: subStyle.shadowBlur ?? shadow.std_deviation };
  setting(subtitleShadow.opacity, 0, 1, 'subtitle.shadowOpacity');
  setting(subtitleShadow.std_deviation, 0.1, 300, 'subtitle.shadowBlur');
  setting(shadow.std_deviation, 0.1, 300, 'shadow.std_deviation');
  setting(shadow.dx, -300, 300, 'shadow.dx');
  setting(shadow.dy, -300, 300, 'shadow.dy');

  const source = await readFile(input);
  const original = sharp(source).autoOrient().removeAlpha().toColourspace('srgb');
  const { data: base, info } = await original.clone().png().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (Math.min(width, height) < 64) throw new Error('原图宽高至少 64px');
  // 提前检查比例语法和像素尺寸，再运行模型。
  cropFor(width, height, ratio, { top: 0, left: 0, headBottom: 1, right: 1 });
  const fonts = JSON.parse(python(['glyphs'], JSON.stringify([{ ...style, text: title }, { ...subStyle, text: subtitle }])));

  const layout = line(title, fonts[0]);
  const centered = { top: Math.floor(height / 2), headBottom: Math.floor(height / 2) + 1,
    left: Math.floor(width / 2), right: Math.floor(width / 2) + 1 };
  const initialCrop = cropFor(width, height, ratio, centered);
  let detection = null;
  let needsMask = true;
  if (style.top != null && !values.mask) {
    const initialTitle = await titlePlacement(layout, style, initialCrop, { headBottom: height },
      Buffer.alloc(width * height), width);
    if (!initialTitle) throw new Error('固定标题位置超出安全区，请调整 title.top 或 title.size');
    const ink = await sharp(Buffer.from(svg(width, height,
      paths(layout, initialTitle.size, initialTitle.x, initialTitle.y).join(''))))
      .ensureAlpha().raw().toBuffer();
    detection = await detectPeople(base);
    needsMask = intersectsPeople(ink, width, height, detection);
    console.error(`[人物检测] ${detection.length ? '检测到人物区域' : '未检测到人物'} · ${needsMask ? '与标题重叠，读取或生成蒙版' : '未与标题重叠，直接合成'}`);
  }

  const cache = resolve(values['cache-dir'] || join(homedir(), '.cache/rocc-edit/cover-masks'));
  const key = createHash('sha256').update(`cover-mask-v1:rembg-2.0.87:${model}:`).update(source).digest('hex');
  const maskPath = !needsMask ? null : values.mask ? resolve(values.mask) : join(cache, `${key}.png`);
  let mask, maskSource = values.mask ? 'manual' : 'cache';
  if (needsMask) {
    try {
      mask = await readFile(maskPath);
    } catch (error) {
      if (error.code !== 'ENOENT' || values.mask) throw error;
      if (values['render-only']) throw new Error('缓存缺失。先完整执行一次、指定正确缓存位置或传入 --mask');
      await mkdir(cache, { recursive: true });
      const temp = await mkdtemp(join(tmpdir(), 'cover-model-'));
      try {
        const path = join(temp, 'original.png');
        await writeFile(path, base);
        console.error(`[抠图] ${width}×${height} · ${model} · 本地 CPU`);
        python(['mask', path, maskPath, model]);
        mask = await readFile(maskPath);
        maskSource = 'generated';
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  } else {
    maskSource = 'skipped';
    mask = await sharp(Buffer.alloc(width * height), { raw: { width, height, channels: 1 } }).png().toBuffer();
  }
  if (needsMask) console.error(`[蒙版] ${maskSource} · ${maskPath}`);
  const meta = await sharp(mask).metadata();
  if (meta.format !== 'png' || meta.width !== width || meta.height !== height || meta.hasAlpha) {
    throw new Error(`蒙版须为无透明通道的灰度 PNG，尺寸必须与校正方向后的原图一致（${width}×${height}）`);
  }
  const alpha = await sharp(mask).toColourspace('b-w').raw().toBuffer();
  const head = needsMask ? portraitBounds(alpha, width, height) : null;
  const crop = style.top != null ? initialCrop : cropFor(width, height, ratio, head);
  let titleFit = await titlePlacement(layout, style, crop, head ?? { headBottom: height }, alpha, width);
  const preferredCropTop = crop.top;
  if (!titleFit && style.top == null) {
    const highCrop = Math.max(0, head.headBottom - crop.height, Math.round(head.top - crop.width * 0.18));
    if (highCrop < crop.top) {
      crop.top = highCrop;
      titleFit = await titlePlacement(layout, style, crop, head ?? { headBottom: height }, alpha, width);
      if (titleFit) console.error('[裁切] 已上移裁切窗口，为标题保留头顶空间');
    }
  }
  if (!titleFit) {
    throw new Error('自动重排后仍无法同时实现穿插和保留字形，或发缘半透明像素过多。请调整 title.x/size、选择留白更多的照片或精修蒙版');
  }
  const warnings = [];
  if (needsMask && titleFit.overlap < 0.006) {
    warnings.push('固定标题位置与人像交叠较少，请检查预览中的穿插效果');
    console.error('[预览提示] ' + warnings[0]);
  }
  const subtitleFit = subtitlePaths(subtitle, fonts[1], subStyle, crop, titleFit, titleFit.y + titleFit.size * (layout.top - layout.bottom));
  const scale = crop.width / reference.canvas[0];
  const titleSvg = layer(width, height, paths(layout, titleFit.size, titleFit.x, titleFit.y).join(''), style.color, shadow, scale);
  const subtitleSvg = layer(width, height, subtitleFit.elements.join(''), subStyle.color, subtitleShadow, scale);
  const { data: titlePixels, info: titleInfo } = await sharp(Buffer.from(titleSvg)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const overlayMask = Buffer.from(alpha);
  // 仅在大标题和阴影下回贴人物，避免透明边缘反复混色造成原图像素舍入。
  for (let i = 0; i < overlayMask.length; i++) {
    if (!titlePixels[i * 4 + 3]) overlayMask[i] = 0;
  }
  const portrait = needsMask ? await portraitLayer(base, alpha, width, height) : null;
  const composite = await sharp(base).composite([
    { input: titlePixels, raw: { width, height, channels: titleInfo.channels } },
    ...(needsMask ? [{ input: await portraitLayer(base, overlayMask, width, height) }] : []),
    { input: Buffer.from(subtitleSvg) },
  ]).png().toBuffer();
  const final = await sharp(composite).extract(crop).png().toBuffer();
  const report = {
    model, maskSource, maskPath, detection, needsMask, ratio, text: { title, subtitle }, sourceSize: { width, height }, crop, preferredCropTop, estimatedHead: head,
    overlap: titleFit.overlap, visibilityPerGlyph: titleFit.visibility, softEdgeFraction: titleFit.softEdge,
    title: { x: titleFit.x, y: titleFit.y, size: titleFit.size, preferredY: titleFit.preferredY, adjusted: titleFit.adjusted },
    subtitle: { size: subtitleFit.size, lines: subtitleFit.lines, x: subtitleFit.x, bottomMargin: subtitleFit.bottomMargin },
    warnings,
    review: '布局检查通过。请打开预览确认标题语义可读、五官完整、交叠处发丝自然。',
  };
  const preview = await sharp(final).resize({ width: previewWidth, withoutEnlargement: true }).png().toBuffer();
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`输出目录已存在，请使用新版本目录：${target}`);
  }
  await Promise.all([
    writeFile(join(target, 'cover.png'), final),
    writeFile(join(target, 'preview.png'), preview),
    ...(needsMask ? [writeFile(join(target, 'portrait.png'), portrait)] : []),
    writeFile(join(target, 'title.svg'), titleSvg),
    writeFile(join(target, 'subtitle.svg'), subtitleSvg),
    ...(needsMask ? [writeFile(join(target, 'alpha-mask.png'), mask)] : []),
    writeFile(join(target, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
  ]);
  console.error(`[导出] ${crop.width}×${crop.height} · ${target} · ${titleFit.adjusted ? '已自动调整标题位置' : '标题首选位置通过'}`);
  console.log(JSON.stringify(report));
}

render().catch(error => {
  console.error(`[封面失败] ${error.message}`);
  process.exitCode = 1;
});
