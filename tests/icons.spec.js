import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIZES = [16, 32, 48, 128];

test('manifest がアイコンを宣言し、実ファイルが存在する', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  // action.default_icon と 最上位 icons の両方に全サイズが宣言されている
  for (const size of SIZES) {
    expect(manifest.action.default_icon[String(size)]).toBe(`icons/icon${size}.png`);
    expect(manifest.icons[String(size)]).toBe(`icons/icon${size}.png`);
  }

  // 参照先のPNGが実在し、PNGシグネチャを持つ
  for (const size of SIZES) {
    const p = path.join(ROOT, `icons/icon${size}.png`);
    expect(fs.existsSync(p), `${p} が存在する`).toBe(true);
    const head = fs.readFileSync(p).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  }
});

test('アイコンが拡張リソースとして配信され、正しいサイズで読める', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  for (const size of SIZES) {
    const dim = await page.evaluate((url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('load失敗: ' + url));
      img.src = url;
    }), chrome_url(extensionId, `icons/icon${size}.png`));
    expect(dim.w).toBe(size);
    expect(dim.h).toBe(size);
  }
});

// chrome-extension URL を組み立てる小ヘルパ（evaluate内で使う値を外で用意）
function chrome_url(id, res) { return `chrome-extension://${id}/${res}`; }
