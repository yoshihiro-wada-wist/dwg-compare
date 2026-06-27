import { test, expect } from './fixtures.js';

test('拡張が読み込まれ viewer UI が表示される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  await expect(page).toHaveTitle('DWG Compare');

  // 初期状態：比較ボタンは無効、オーバーレイ（案内）が表示
  await expect(page.locator('#compareBtn')).toBeDisabled();
  await expect(page.locator('#overlay')).toBeVisible();

  // 差分カウンタの初期値はすべて0
  await expect(page.locator('#cRemoved')).toHaveText('0');
  await expect(page.locator('#cAdded')).toHaveText('0');
  await expect(page.locator('#cCommon')).toHaveText('0');

  // 3つのトグルは既定でON
  for (const id of ['#tRemoved', '#tAdded', '#tCommon']) {
    await expect(page.locator(id)).toBeChecked();
  }

  // 許容差の既定値
  await expect(page.locator('#tol')).toHaveValue('0.01');
});

test('片方のファイルだけでは比較できない（両方そろうまでボタン無効）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  // ボタンの有効化条件は bufA && bufB。ファイル未選択なら無効のまま。
  await expect(page.locator('#compareBtn')).toBeDisabled();
});
