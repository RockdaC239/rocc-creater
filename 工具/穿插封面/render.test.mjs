import { fileURLToPath } from "node:url";

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import sharp from 'sharp';

test('使用现成人像蒙版完成穿插、保留未叠字像素，并导出精确比例', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cover-'));
  try {
    const input = join(root, 'photo.png');
    const mask = join(root, 'mask.png');
    const output = join(root, 'out');
    const width = 420, height = 560;
    await sharp({ create: { width, height, channels: 3, background: '#204060' } }).png().toFile(input);
    await sharp(Buffer.from('<svg width="420" height="560"><ellipse cx="210" cy="292" rx="120" ry="185" fill="white"/></svg>'))
      .flatten({ background: '#000' }).greyscale().blur(3).png().toFile(mask);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('render.mjs', import.meta.url)), input,
      '生意惨淡', '本地自动合成\n快速改稿', output, '--ratio', '4:5', '--mask', mask, '--render-only'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const final = join(output, 'cover.png');
    const { width: w, height: h } = await sharp(final).metadata();
    assert.deepEqual([w, h], [420, 525]);
    const { data, info } = await sharp(final).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [32, 64, 96]);
    const report = JSON.parse(run.stdout);
    assert.ok(report.overlap > 0 && report.overlap < 0.25);
    assert.equal(report.maskSource, 'manual');
    const offset = (210 + (180 - report.crop.top) * w) * info.channels;
    assert.deepEqual([...data.subarray(offset, offset + 3)], [32, 64, 96]);
    const alpha = async name => sharp(join(output, name)).ensureAlpha().raw().toBuffer();
    const [big, small] = await Promise.all([alpha('title.svg'), alpha('subtitle.svg')]);
    let outsideDiff = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sourcePixel = (y + report.crop.top) * width + x;
        const pixel = (y * w + x) * info.channels;
        if (big[sourcePixel * 4 + 3] || small[sourcePixel * 4 + 3]) continue;
        if (data[pixel] !== 32 || data[pixel + 1] !== 64 || data[pixel + 2] !== 96) outsideDiff++;
      }
    }
    assert.equal(outsideDiff, 0, '标题及阴影范围外逐像素保留原图');
    const inkRows = (pixels, rgb) => {
      const rows = [];
      for (let y = 0; y < height; y++) {
        let left = width;
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          if (pixels[offset + 3] >= 128 && rgb.every((channel, i) => pixels[offset + i] === channel)) {
            left = Math.min(left, x);
          }
        }
        if (left < width) rows.push({ left, y });
      }
      return rows;
    };
    const titleInk = inkRows(big, [255, 154, 16]);
    const subInk = inkRows(small, [255, 255, 255]);
    const split = subInk.findIndex((row, i) => i > 0 && row.y - subInk[i - 1].y > 1);
    assert.ok(split > 0, '副标题保留两行');
    const titleLeft = Math.min(...titleInk.map(row => row.left));
    for (const rows of [subInk.slice(0, split), subInk.slice(split)]) {
      assert.ok(Math.abs(Math.min(...rows.map(row => row.left)) - titleLeft) <= 1, '逐行左齐大标题');
    }
    const topMargin = titleInk[0].y - report.crop.top;
    const bottomMargin = report.crop.top + h - 1 - subInk.at(-1).y;
    assert.ok(bottomMargin >= topMargin, '副标题底部留白不少于大标题顶部留白');
    const trial = join(root, 'trial');
    const config = join(root, 'offset.json');
    await writeFile(config, JSON.stringify({ subtitle: { xOffset: 0.025 } }));
    const shifted = spawnSync(process.execPath, [fileURLToPath(new URL('render.mjs', import.meta.url)), input,
      '生意惨淡', '原图套版\n本地完成排版\n大标题自然藏到人物身后', trial,
      '--ratio', '4:5', '--mask', mask, '--config', config], { encoding: 'utf8' });
    assert.equal(shifted.status, 0, shifted.stderr);
    const shiftedReport = JSON.parse(shifted.stdout);
    assert.equal(shiftedReport.subtitle.lines, 3);
    assert.equal(shiftedReport.subtitle.x - report.subtitle.x, 11);
    assert.deepEqual(shiftedReport.title, report.title);
    const mtime = (await stat(final)).mtimeMs;
    const again = spawnSync(process.execPath, [fileURLToPath(new URL('render.mjs', import.meta.url)), input,
      '生意惨淡', '改稿', output, '--mask', mask], { encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    assert.equal((await stat(final)).mtimeMs, mtime);
    assert.ok((await readdir(output)).includes('title.svg'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
