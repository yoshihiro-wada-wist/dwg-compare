import { test, expect } from './fixtures.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'test_data');

// 再読み込み（同じファイルを編集→再選択）バグの回帰テスト。
// <input type=file> は同じパスを選び直すと value が変わらず change が発火しない。
// 対策として readFile 後に input.value='' でクリアしている。
// ここでは「読み込んでもデータ(buffer)は保持され、かつ input は次の選択に備えて
// クリアされている」ことを検証する。

test('ファイル読み込み後、inputはクリアされるがデータは保持される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  await page.locator('#fileA').setInputFiles(path.join(DATA, 'TB3Y.dwg'));
  await page.locator('#fileB').setInputFiles(path.join(DATA, 'TB3Y_new.dwg'));

  // 表示名は反映される
  await expect(page.locator('#nameA')).toHaveText('TB3Y.dwg');
  await expect(page.locator('#nameB')).toHaveText('TB3Y_new.dwg');

  // input.value はクリアされている（同じファイルを選び直しても change が再発火する）
  await expect(page.locator('#fileA')).toHaveValue('');
  await expect(page.locator('#fileB')).toHaveValue('');

  // それでも比較は可能（buffer は保持されている）
  await expect(page.locator('#compareBtn')).toBeEnabled();
});

test('同じ入力に再度ファイルを選ぶと最新データに更新される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  // 最初に new を A に読み込む
  await page.locator('#fileA').setInputFiles(path.join(DATA, 'TB3Y_new.dwg'));
  await expect(page.locator('#nameA')).toHaveText('TB3Y_new.dwg');
  await expect(page.locator('#fileA')).toHaveValue('');

  // 同じ input(A) に別ファイルを読み直す → 表示名が更新される（change が発火する）
  await page.locator('#fileA').setInputFiles(path.join(DATA, 'TB3Y.dwg'));
  await expect(page.locator('#nameA')).toHaveText('TB3Y.dwg');
  await expect(page.locator('#fileA')).toHaveValue('');
});
