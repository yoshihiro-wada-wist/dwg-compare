// icons/icon.svg を各サイズの PNG に変換する。
// 画像変換ツール(ImageMagick等)が無い環境向けに、Chromium の Canvas で描画→PNG化する。
// （この環境ではスクリーンショット/コンポジタ描画がハングするため、Canvas経路を使う）
// 使い方: node scripts/render-icons.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS = path.join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

const svg = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');
const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

// headless/WSL2 ではGPUアクセラレーション2D Canvasがハングするため無効化
const browser = await chromium.launch({ channel: 'chromium', args: ['--disable-accelerated-2d-canvas'] });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });

for (const size of SIZES) {
  const dataUrl = await page.evaluate(async ({ svgDataUrl, size }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = svgDataUrl;
    });
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png');
  }, { svgDataUrl, size });

  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const out = path.join(ICONS, `icon${size}.png`);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', path.relative(ROOT, out), `(${size}x${size}, ${Buffer.from(b64, 'base64').length}B)`);
}

await browser.close();
