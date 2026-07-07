import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..'); // 拡張ルート（manifest.jsonのある場所）

// 拡張を読み込んだ永続コンテキストと拡張IDを提供するfixture
export const test = base.extend({
  // テストごとのデバイスピクセル比（例: hidpi.spec.js が 2 を指定）。
  // 注: --force-device-scale-factor フラグは Playwright のビューポート
  // エミュレーション(dpr=1)に上書きされるため、コンテキストオプションで渡す。
  deviceScaleFactor: [undefined, { option: true }],

  context: async ({ deviceScaleFactor }, use) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dwg-'));
    const context = await chromium.launchPersistentContext(userDir, {
      channel: 'chromium', // MV3拡張＝新ヘッドレス
      ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        // headless/WSL2ではGPUアクセラレーション2D Canvasの初回描画がハングするため、
        // CPU(Skia)描画に切り替える。これで render()/印刷までE2E検証できる。
        '--disable-accelerated-2d-canvas',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
