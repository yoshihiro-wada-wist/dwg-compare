import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'test_data');

// sandbox で1ファイルを解析して items を返す（ラベル属性の検証用）
async function parse(page, file) {
  const b64 = fs.readFileSync(path.join(DATA, file)).toString('base64');
  return page.evaluate(async (b64) => {
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return await new Promise((res, rej) => {
      const f = document.createElement('iframe'); f.style.display = 'none';
      f.src = chrome.runtime.getURL('sandbox.html'); let om;
      const done = (fn, v) => { window.removeEventListener('message', om); f.remove(); fn(v); };
      om = (e) => { if (e.source !== f.contentWindow) return; const m = e.data || {};
        if (m.type === 'ready') f.contentWindow.postMessage({ type: 'parse', id: 1, tol: 0.01, buffer: u.buffer }, '*', [u.buffer]);
        else if (m.type === 'result') m.ok ? done(res, m) : done(rej, new Error(m.error));
        else if (m.type === 'fatal') done(rej, new Error(m.error)); };
      window.addEventListener('message', om);
      f.addEventListener('load', () => f.contentWindow.postMessage({ type: 'init', wasmBase }, '*'));
      document.body.appendChild(f);
    });
  }, b64);
}

// 全ラベルを平坦化
function allLabels(items) {
  const out = [];
  for (const it of items) for (const l of (it.labels || [])) out.push({ ...l, _type: it.type });
  return out;
}

test('TEXT ラベルに幅係数(xScale)と配置が反映される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const B = await parse(page, 'TB3Y_new.dwg');
  const labels = allLabels(B.items);

  // 表題欄の文字は xScale が 1 未満（例: 0.7, 0.718）で圧縮されている
  const texts = labels.filter((l) => l._type === 'TEXT');
  expect(texts.length).toBeGreaterThan(0);
  const compressed = texts.filter((l) => typeof l.xScale === 'number' && l.xScale > 0 && l.xScale < 0.9);
  expect(compressed.length).toBeGreaterThan(0);

  // 「株式会社  ウイスト」は textHeight=4, xScale=0.7
  const corp = texts.find((l) => /ウイスト/.test(l.text));
  expect(corp).toBeTruthy();
  expect(corp.h).toBeCloseTo(4, 5);
  expect(corp.xScale).toBeCloseTo(0.7, 3);

  // 配置(textAlign/textBaseline)が付与されている
  expect(typeof corp.ah).toBe('string');
  expect(typeof corp.av).toBe('string');
});

test('MTEXT の書式コード(\\P \\H \\W {})が除去され、改行に変換される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const B = await parse(page, 'TB3Y_new.dwg');
  const labels = allLabels(B.items);

  const mtext = labels.find((l) => l._type === 'MTEXT');
  expect(mtext, 'MTEXTラベルが存在する').toBeTruthy();

  // 生の書式コードが残っていない
  expect(mtext.text).not.toContain('\\P');
  expect(mtext.text).not.toContain('\\H');
  expect(mtext.text).not.toContain('\\W');
  expect(mtext.text).not.toContain('{');
  expect(mtext.text).not.toContain('}');

  // 内容は残る（HLS と 参照テキスト）。\P は改行になっている
  expect(mtext.text).toContain('HLS');
  expect(mtext.text).toContain('HLS通信接続図参照');
  expect(mtext.text).toContain('\n');
});

test('縦書きスタイル(STYLE.standardFlag&4)の文字は vertical=true になる（和田）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const A = await parse(page, 'TB3Y.dwg'); // 「和田」は KANJI4(縦書き)スタイル
  const labels = allLabels(A.items);

  const wada = labels.find((l) => /和田/.test(l.text));
  expect(wada, '和田ラベルが存在する').toBeTruthy();
  expect(wada.vertical).toBe(true);

  // 通常の横書き文字は vertical が立たない
  const yoko = labels.find((l) => /ウイスト/.test(l.text));
  expect(yoko).toBeTruthy();
  expect(!!yoko.vertical).toBe(false);

  // 縦書きはごく一部（この図面では和田のみ）で、全部が縦になっていないこと
  const vcount = labels.filter((l) => l.vertical).length;
  expect(vcount).toBeGreaterThanOrEqual(1);
  expect(vcount).toBeLessThan(labels.length);
});

test('寸法(DIMENSION)が描画対象になり、寸法線・矢印・寸法値を持つ', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const B = await parse(page, 'TB3Y_new.dwg'); // 新図に並列寸法(73.64)と直径寸法(∅6)を追加済み

  // 寸法は AutoCAD 計算済みの匿名ブロック(*D#)を展開し、寸法線(LINE)・矢印(SOLID)・
  // 寸法値(MTEXT)といったサブ要素の実体として描画される（手動再構成の DIM| ではない）。
  const labels = allLabels(B.items);

  // 寸法値: 並列 73.64 と 直径 ∅6.00 がテキストとして存在する
  const linearVal = labels.find((l) => /73\.64/.test(l.text || ''));
  expect(linearVal, '並列寸法73.64が存在').toBeTruthy();

  const diaVal = labels.find((l) => /[∅⌀]/.test(l.text || '') && /6/.test(l.text || ''));
  expect(diaVal, '直径寸法(∅付き 6)が存在').toBeTruthy();

  // 寸法値は寸法線に沿って回転する。直径寸法は斜めの寸法線を持つため rot!=0。
  // (MTEXTの角度は rotation ではなく direction(group11) から取る必要がある。
  //  direction を無視すると寸法値が水平のままになる回帰の防止)
  expect(Math.abs(diaVal.rot)).toBeGreaterThan(0.01);

  // 矢印: SOLID(塗り三角)として展開される（2寸法×両端で複数）
  const arrows = B.items.filter((it) => it.type === 'SOLID');
  expect(arrows.length).toBeGreaterThanOrEqual(2);

  // 寸法線・補助線: LINE として展開される
  const lines = B.items.filter((it) => it.type === 'LINE');
  expect(lines.length).toBeGreaterThan(0);
});

test('中央配置テキスト(円内の参照記号など)は第2整列点=円中心に配置され原点へ飛ばない', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const B = await parse(page, 'TB3Y_new.dwg');

  // 中央(center)＋中段(middle)整列の TEXT ラベルを集める（円内の CR2/CR3/CR4 等）
  const mid = allLabels(B.items).filter((l) => l._type === 'TEXT' && l.ah === 'center' && l.av === 'middle');
  expect(mid.length).toBeGreaterThan(0);

  // 整列テキストは第2整列点(group11)を使うため、原点(0,0)へ張り付かない。
  // group10(startPoint)を誤用すると(0,0)へ集まる回帰の防止。
  const atOrigin = mid.filter((l) => Math.abs(l.x) < 1e-6 && Math.abs(l.y) < 1e-6);
  expect(atOrigin.length).toBe(0);

  // 各中央テキストは、いずれかの円(CIRCLE)の中心付近に載っている（円内配置の検証）。
  const centers = B.items
    .filter((it) => it.type === 'CIRCLE')
    .map((it) => {
      const pts = it.polylines[0] || [];
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      return { x: sx / pts.length, y: sy / pts.length };
    });
  const nearCircle = mid.filter((l) => centers.some((c) => Math.hypot(c.x - l.x, c.y - l.y) < 5));
  expect(nearCircle.length).toBe(mid.length);
});

test('文字ラベルの高さは実寸(textHeight)で、以前の8px下限のような固定化がない', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const B = await parse(page, 'TB3Y_new.dwg');
  const labels = allLabels(B.items).filter((l) => l._type === 'TEXT');

  // 図面単位の高さ(textHeight)がそのまま h として入っている（3 や 4 など）
  const heights = new Set(labels.map((l) => Math.round(l.h)));
  expect(heights.has(3)).toBe(true);
  expect(heights.has(4)).toBe(true);
  // すべて正の実寸
  expect(labels.every((l) => l.h > 0)).toBe(true);
});
