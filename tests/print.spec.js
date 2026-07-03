import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'test_data');

test('印刷ボタンは比較前は無効、印刷エリアは画面上非表示', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const printBtn = page.locator('#printBtn');
  await expect(printBtn).toHaveText('印刷');
  await expect(printBtn).toBeDisabled();
  await expect(page.locator('#printArea')).toBeHidden();
});

test('test_data で 比較→印刷 が動作し、印刷画像とヘッダーが生成される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  // 回帰検証の要:「印刷画像の load イベント」と「window.print 呼び出し」の順序を記録する。
  // 修正版は load→print（画像ロード後に印刷）、バグ版(src設定→即print)は print→load になる。
  // headlessでは data URL が1マイクロタスクで読めてしまい complete値では区別できないため、順序で見る。
  await page.evaluate(() => {
    window.__events = [];
    document.querySelector('#printImg').addEventListener('load', () => window.__events.push('load'));
    window.print = () => {
      const el = document.querySelector('#printImg');
      window.__events.push('print');
      window.__printState = { complete: el.complete, naturalWidth: el.naturalWidth, src: el.src };
    };
  });

  // 実UIで比較
  await page.locator('#fileA').setInputFiles(path.join(DATA, 'TB3Y.dwg'));
  await page.locator('#fileB').setInputFiles(path.join(DATA, 'TB3Y_new.dwg'));
  await page.locator('#compareBtn').click({ force: true });

  // 比較完了＝印刷ボタン有効化（render後に有効化される）
  await expect(page.locator('#printBtn')).toBeEnabled({ timeout: 30_000 });

  // 画面のカウントが現行データの期待値
  await expect(page.locator('#cRemoved')).toHaveText('21');
  await expect(page.locator('#cAdded')).toHaveText('6');
  await expect(page.locator('#cCommon')).toHaveText('445');

  // 「初回」の印刷ボタン押下
  await page.locator('#printBtn').click({ force: true });

  // window.print が呼ばれた
  await expect.poll(() => page.evaluate(() => window.__events.filter(e => e === 'print').length)).toBe(1);
  // load イベントも発生している（画像が生成・ロードされた）
  await expect.poll(() => page.evaluate(() => window.__events.includes('load'))).toBe(true);

  // 回帰検証の核心: 画像の load が print より先＝ロード後に印刷している
  const events = await page.evaluate(() => window.__events);
  expect(events.indexOf('load')).toBeLessThan(events.indexOf('print'));

  // 印刷時点で画像はロード済み（PNG dataURL）
  const st = await page.evaluate(() => window.__printState);
  expect(st.src.startsWith('data:image/png;base64,')).toBe(true);
  expect(st.src.length).toBeGreaterThan(1000);
  expect(st.complete).toBe(true);
  expect(st.naturalWidth).toBeGreaterThan(0);

  // 印刷ヘッダーにファイル名と件数が反映されている
  await expect(page.locator('#pNameA')).toHaveText('TB3Y.dwg');
  await expect(page.locator('#pNameB')).toHaveText('TB3Y_new.dwg');
  await expect(page.locator('#pRemoved')).toHaveText('21');
  await expect(page.locator('#pAdded')).toHaveText('6');
  await expect(page.locator('#pCommon')).toHaveText('445');
});

test('印刷レイアウトが media=print で表示に切り替わる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  // 通常（screen）では印刷エリアは display:none
  await expect(page.locator('#printArea')).toBeHidden();

  // print メディアをエミュレートすると印刷エリアが表示され、ツールバーは隠れる
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#printArea')).toBeVisible();
  await expect(page.locator('.toolbar')).toBeHidden();

  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('#printArea')).toBeHidden();
});
