import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'test_data');

// 高DPI（devicePixelRatio=2）での表示リグレッションテスト。
// バグ版は fitTo に canvas.width/height（デバイスピクセル＝CSS×dpr）を渡していたため、
// カメラ座標系（CSSピクセル基準）と食い違い、dpr>1 環境では比較結果が
// dpr倍に拡大され中心が画面右下隅へ飛んでいた（図がほぼ画面外）。
// → 描画済みピクセルの重心がキャンバス中央付近にあり、全体が収まっていることを検証する。
test.use({ deviceScaleFactor: 2 });

test('dpr=2 でも比較結果が中央に全体表示される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);

  await page.locator('#fileA').setInputFiles(path.join(DATA, 'TB3Y.dwg'));
  await page.locator('#fileB').setInputFiles(path.join(DATA, 'TB3Y_new.dwg'));
  await page.locator('#compareBtn').click({ force: true });
  await expect(page.locator('#printBtn')).toBeEnabled({ timeout: 30_000 });

  // 描画済み（不透明）ピクセルのバウンディングボックスを取得
  const m = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const g = c.getContext('2d');
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    let minx = Infinity, miny = Infinity, maxx = -1, maxy = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
    return { minx, miny, maxx, maxy, W: width, H: height };
  });

  // 何かが描かれている
  expect(m.maxx).toBeGreaterThan(m.minx);
  expect(m.maxy).toBeGreaterThan(m.miny);

  // 全体がキャンバス内に収まっている（バグ版は2倍拡大で右下へはみ出す）
  expect(m.minx).toBeGreaterThanOrEqual(0);
  expect(m.miny).toBeGreaterThanOrEqual(0);
  expect(m.maxx).toBeLessThan(m.W);
  expect(m.maxy).toBeLessThan(m.H);

  // 図の中心がキャンバス中央付近（±15%）にある
  // （fitTo はbboxを中央配置する。文字ラベルのはみ出し分だけ許容を持たせる）
  const cx = (m.minx + m.maxx) / 2;
  const cy = (m.miny + m.maxy) / 2;
  expect(Math.abs(cx - m.W / 2)).toBeLessThan(m.W * 0.15);
  expect(Math.abs(cy - m.H / 2)).toBeLessThan(m.H * 0.15);
});
