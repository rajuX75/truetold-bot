// Advanced image pipeline: smart 16:9 crop, AVIF + WebP + JPEG, 4 responsive widths,
// 1200x630 social card, blur-up placeholder, stripped metadata, SEO file names.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function processImage({ buffer, slug, date, widths, outRoot = 'docs/img', baseUrl }) {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const rel = `${yyyy}/${mm}`;
  const dir = path.join(outRoot, rel);
  await fs.mkdir(dir, { recursive: true });

  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const usable = widths.filter((w) => w <= (meta.width || 0));
  if (!usable.length) throw new Error('Source image too small');

  const base = sharp(buffer, { failOn: 'none' }).rotate(); // auto-orient; output carries no EXIF/GPS
  const crop = (w, h) => base.clone().resize(w, h, { fit: 'cover', position: sharp.strategy.attention });

  const srcset = { avif: [], webp: [], jpeg: [] };
  for (const w of usable) {
    const h = Math.round((w * 9) / 16);
    const stem = `${slug}-${w}w`;
    await crop(w, h).avif({ quality: 50, effort: 4 }).toFile(path.join(dir, `${stem}.avif`));
    await crop(w, h).webp({ quality: 76 }).toFile(path.join(dir, `${stem}.webp`));
    await crop(w, h).jpeg({ quality: 78, mozjpeg: true, progressive: true }).toFile(path.join(dir, `${stem}.jpg`));
    for (const [k, ext] of [['avif', 'avif'], ['webp', 'webp'], ['jpeg', 'jpg']]) {
      srcset[k].push(`${baseUrl}/${rel}/${stem}.${ext} ${w}w`);
    }
  }

  // Social card (Open Graph / X) 1200x630
  const ogName = `${slug}-og-1200x630.jpg`;
  await crop(1200, 630).jpeg({ quality: 82, mozjpeg: true, progressive: true }).toFile(path.join(dir, ogName));

  // Blur-up placeholder (inline, ~300 bytes)
  const lqipBuf = await crop(24, 14).webp({ quality: 25 }).toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuf.toString('base64')}`;

  const fallbackW = usable.includes(1200) ? 1200 : usable[usable.length - 1];
  const fallbackH = Math.round((fallbackW * 9) / 16);
  return {
    srcset: { avif: srcset.avif.join(', '), webp: srcset.webp.join(', '), jpeg: srcset.jpeg.join(', ') },
    src: `${baseUrl}/${rel}/${slug}-${fallbackW}w.jpg`,
    width: fallbackW,
    height: fallbackH,
    ogUrl: `${baseUrl}/${rel}/${ogName}`,
    lqip,
    files: (await fs.readdir(dir)).filter((f) => f.startsWith(`${slug}-`)).map((f) => `${dir}/${f}`),
    probeUrl: `${baseUrl}/${rel}/${slug}-${fallbackW}w.jpg`,
  };
}

// 800px JPEG copy used only for AI vetting / alt text (never published).
export async function previewJpeg(buffer) {
  return sharp(buffer, { failOn: 'none' }).rotate().resize(800, 800, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
}
