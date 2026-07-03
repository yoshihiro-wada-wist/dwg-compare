import { test, expect } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'test_data');

// test_data の2図面を解析→差分し、件数を検証する。
// これは「2ファイル連続解析」のリグレッションテストでもある:
//   旧実装は WASMモジュールを使い回し、2回目(B)の解析が
//   "convert: null function" で失敗していた（= 比較が常に壊れる）。
//   viewer.js を「解析ごとに専用sandbox(iframe)」へ修正して解消した。
//
// 注: Canvas2D描画(render)は headless/WSL2 のソフトウェアラスタライザで
//     ctx 初期化がハングするため、ここでは解析+差分ロジックのみを検証する
//     （描画は環境依存で、拡張のロジックとは独立）。

// viewer.js と同一の差分ロジック（シグネチャのマルチセット突き合わせ）
function diff(itemsA, itemsB) {
  const bySig = new Map();
  for (const a of itemsA) { if (!bySig.has(a.sig)) bySig.set(a.sig, []); bySig.get(a.sig).push(a); }
  let common = 0, added = 0, removed = 0;
  for (const b of itemsB) {
    const lst = bySig.get(b.sig);
    if (lst && lst.length) { lst.pop().cls = 'common'; b.cls = 'common'; common++; }
    else { b.cls = 'added'; added++; }
  }
  for (const a of itemsA) { if (!a.cls) { a.cls = 'removed'; removed++; } }
  return { common, added, removed };
}

// 専用sandboxを立てて1ファイルを解析（viewer.js の parseItems と同じ流儀）
async function parseInPage(page, b64) {
  return page.evaluate(async (b64) => {
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return await new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.src = chrome.runtime.getURL('sandbox.html');
      let onMsg;
      const done = (fn, v) => { window.removeEventListener('message', onMsg); f.remove(); fn(v); };
      onMsg = (e) => {
        if (e.source !== f.contentWindow) return;
        const m = e.data || {};
        if (m.type === 'ready') f.contentWindow.postMessage({ type: 'parse', id: 1, tol: 0.01, buffer: buf.buffer }, '*', [buf.buffer]);
        else if (m.type === 'result') m.ok ? done(resolve, { items: m.items, total: m.total }) : done(reject, new Error(m.error));
        else if (m.type === 'fatal') done(reject, new Error(m.error));
      };
      window.addEventListener('message', onMsg);
      f.addEventListener('load', () => f.contentWindow.postMessage({ type: 'init', wasmBase }, '*'));
      document.body.appendChild(f);
    });
  }, b64);
}

test('test_data の2図面を解析し、件数と差分が期待どおり', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const a64 = fs.readFileSync(path.join(DATA, 'TB3Y.dwg')).toString('base64');
  const b64 = fs.readFileSync(path.join(DATA, 'TB3Y_new.dwg')).toString('base64');

  // 2ファイルを連続で解析（旧実装ではここで2回目が失敗していた）
  const A = await parseInPage(page, a64);
  const B = await parseInPage(page, b64);

  // 解析件数（現行 test_data の値）
  expect(A.items.length).toBe(466);
  expect(A.total).toBe(466);
  expect(B.items.length).toBe(451);
  expect(B.total).toBe(451);

  // 差分件数（旧A=466 / 新B=451, 共通445）
  const counts = diff(A.items, B.items);
  expect(counts).toEqual({ common: 445, added: 6, removed: 21 });

  // 整合性: removed = A - common, added = B - common
  expect(counts.removed).toBe(A.items.length - counts.common);
  expect(counts.added).toBe(B.items.length - counts.common);
});

test('差分は対称: A→B の added/removed は B→A で入れ替わる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const a64 = fs.readFileSync(path.join(DATA, 'TB3Y.dwg')).toString('base64');
  const b64 = fs.readFileSync(path.join(DATA, 'TB3Y_new.dwg')).toString('base64');

  const A = await parseInPage(page, a64);
  const B = await parseInPage(page, b64);

  const ab = diff(A.items.map(x => ({ sig: x.sig })), B.items.map(x => ({ sig: x.sig })));
  const ba = diff(B.items.map(x => ({ sig: x.sig })), A.items.map(x => ({ sig: x.sig })));

  expect(ab.common).toBe(ba.common);
  expect(ab.added).toBe(ba.removed);
  expect(ab.removed).toBe(ba.added);
});
