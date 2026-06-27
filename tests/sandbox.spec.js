import { test, expect } from './fixtures.js';

// sandbox(iframe) + WASM 解析パイプラインの統合テスト。
// サンプルDWGが無いため「初期化が成功し、RPCが往復し、
// 整形された結果（正しいキー構成）が返る」ことを確認する。
// これで WASM ロード・embind・postMessage 経路を一括検証できる。
// 注: libredwg は不正バイト列でも例外を投げず、空の結果(ok:true,total:0)を返す。
test('sandbox が初期化(ready)し、解析RPCが整形された結果を返す', async ({ context, extensionId }) => {
  const page = await context.newPage();
  // viewer.html は通常の拡張ページ（chrome.runtime 利用可）
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);

  const result = await page.evaluate(async () => {
    const wasmBase = chrome.runtime.getURL('vendor/wasm');
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('sandbox.html');
    document.body.appendChild(iframe);

    function once(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => { window.removeEventListener('message', h); reject(new Error('timeout')); }, timeoutMs);
        function h(ev) {
          if (ev.source !== iframe.contentWindow) return;
          const m = ev.data || {};
          if (predicate(m)) { clearTimeout(to); window.removeEventListener('message', h); resolve(m); }
        }
        window.addEventListener('message', h);
      });
    }

    await new Promise((res) => iframe.addEventListener('load', res, { once: true }));

    // ① 初期化 → ready を待つ（WASM ロード）
    const readyP = once((m) => m.type === 'ready' || m.type === 'fatal', 30_000);
    iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*');
    const ready = await readyP;
    if (ready.type !== 'ready') return { stage: 'init', ok: false, error: ready.error };

    // ② バッファを parse → 整形された結果が返ることを確認（RPC往復）
    const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
    const resP = once((m) => m.type === 'result' && m.id === 1, 30_000);
    iframe.contentWindow.postMessage({ type: 'parse', id: 1, tol: 0.01, buffer: buf }, '*', [buf]);
    const res = await resP;

    return {
      stage: 'parse',
      initOk: true,
      ok: res.ok,
      itemsIsArray: Array.isArray(res.items),
      hasTotal: typeof res.total === 'number',
      hasStats: !!res.stats && typeof res.stats === 'object',
    };
  });

  // 初期化が成功していること（WASMがロードできた）
  expect(result.initOk, `初期化失敗: ${result.error || ''}`).toBe(true);
  // 解析RPCが往復し、期待するキー構成の結果が返ること
  expect(result.ok).toBe(true);
  expect(result.itemsIsArray).toBe(true);
  expect(result.hasTotal).toBe(true);
  expect(result.hasStats).toBe(true);
});
