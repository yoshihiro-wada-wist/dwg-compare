/* ============================================================
   DWG Compare - 重ね合わせ差分ビューア（メイン側）
   解析+図形化: sandbox(iframe) 側で実行し、描画用プリミティブのみ受信
   差分: シグネチャのマルチセット突き合わせ
   描画: Canvas2D
   ============================================================ */

// ---- sandbox(iframe) 経由のWASM解析 RPC ----
// 重要: 1つの sandbox(WASMモジュール) を使い回すと、2回目以降の convertEx が
// 「null function」で失敗する（Emscriptenのメモリ増加で関数ポインタが無効化されるため）。
// そのため A/B それぞれの解析で「専用iframe＝新しいWASMモジュール」を生成し、終了後に破棄する。
// （同一realm内でのモジュール再生成はレンダラをクラッシュさせるため、realmごと分ける）

// runCompare の段階①用。各 parse が専用iframeを持つので、ここでは事前準備不要。
async function ensureSandbox() { /* no-op（解析ごとに専用sandboxを生成） */ }

// DWGを解析し、描画用アイテム配列を返す（毎回 専用sandbox を立てて委譲）
async function parseItems(arrayBuffer, tol) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = chrome.runtime.getURL('sandbox.html');
  const wasmBase = chrome.runtime.getURL('vendor/wasm');
  const copy = arrayBuffer.slice(0); // transferで元を壊さないため複製
  let onMsg, initTimer;
  try {
    const res = await new Promise((resolve, reject) => {
      // 初期化(ready)が返らないままだとUIが永久に「解析中…」で固まるため、
      // ready 受信までに限りタイムアウトを設ける（解析自体は大きい図面で長くなり得るので対象外）
      initTimer = setTimeout(() => reject(new Error('sandboxが応答しません（初期化タイムアウト）')), 30_000);
      onMsg = (ev) => {
        if (ev.source !== iframe.contentWindow) return;
        const m = ev.data || {};
        if (m.type === 'ready') {
          // 初期化完了 → このiframeへ parse を依頼
          clearTimeout(initTimer);
          iframe.contentWindow.postMessage({ type: 'parse', id: 1, tol, buffer: copy }, '*', [copy]);
        } else if (m.type === 'fatal') {
          reject(new Error('sandbox初期化失敗: ' + (m.error || '') + (m.stack ? '\n' + m.stack : '')));
        } else if (m.type === 'result') {
          if (m.ok) resolve(m);
          else reject(new Error((m.error || 'parse失敗') + (m.stack ? '\n' + m.stack : '')));
        }
      };
      window.addEventListener('message', onMsg);
      iframe.addEventListener('load', () => {
        iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*');
      });
      document.body.appendChild(iframe);
    });
    return {
      items: res.items || [],
      unsupported: res.unsupported || 0,
      stats: res.stats || { unknownEntityCount: 0 },
      total: res.total || 0,
    };
  } finally {
    clearTimeout(initTimer);
    if (onMsg) window.removeEventListener('message', onMsg);
    iframe.remove(); // WASMモジュールごと破棄（次の解析はクリーンな状態で）
  }
}

// ============================================================
//  差分判定（アイテム単位のマルチセット突き合わせ）
// ============================================================
function diff(itemsA, itemsB) {
  const bySig = new Map();
  for (const a of itemsA) {
    if (!bySig.has(a.sig)) bySig.set(a.sig, []);
    bySig.get(a.sig).push(a);
  }
  let common = 0, added = 0, removed = 0;
  for (const b of itemsB) {
    const lst = bySig.get(b.sig);
    if (lst && lst.length) { lst.pop().cls = 'common'; b.cls = 'common'; common++; }
    else { b.cls = 'added'; added++; }
  }
  for (const a of itemsA) { if (!a.cls) { a.cls = 'removed'; removed++; } }
  return { common, added, removed };
}

// ============================================================
//  カメラ（座標系は CSS ピクセル。パン/ズーム/印刷/render の dpr変換 すべてこの前提）
// ============================================================
const cam = { scale: 1, ox: 0, oy: 0 };
function w2s(p) { return { x: p.x * cam.scale + cam.ox, y: -p.y * cam.scale + cam.oy }; }

function fitTo(bbox, W, H) {
  if (!bbox) return;
  const pad = 40;
  const dw = Math.max(bbox.maxx - bbox.minx, 1e-6);
  const dh = Math.max(bbox.maxy - bbox.miny, 1e-6);
  cam.scale = Math.min((W - 2 * pad) / dw, (H - 2 * pad) / dh);
  const cx = (bbox.minx + bbox.maxx) / 2;
  const cy = (bbox.miny + bbox.maxy) / 2;
  cam.ox = W / 2 - cx * cam.scale;
  cam.oy = H / 2 + cy * cam.scale;
}

// 表示中キャンバスのCSSピクセル寸法で全体表示する。
// 注意: canvas.width/height はデバイスピクセル（CSS×dpr）なので渡してはいけない
// （dpr>1 の環境で図が dpr倍に拡大され右下へずれる）。
function fitToView(bbox) {
  const r = els.canvas.getBoundingClientRect();
  fitTo(bbox, r.width, r.height);
}

// ============================================================
//  状態 & DOM
// ============================================================
const els = {
  fileA: document.getElementById('fileA'),
  fileB: document.getElementById('fileB'),
  nameA: document.getElementById('nameA'),
  nameB: document.getElementById('nameB'),
  compareBtn: document.getElementById('compareBtn'),
  fitBtn: document.getElementById('fitBtn'),
  printBtn: document.getElementById('printBtn'),
  tRemoved: document.getElementById('tRemoved'),
  tAdded: document.getElementById('tAdded'),
  tCommon: document.getElementById('tCommon'),
  cRemoved: document.getElementById('cRemoved'),
  cAdded: document.getElementById('cAdded'),
  cCommon: document.getElementById('cCommon'),
  tol: document.getElementById('tol'),
  canvas: document.getElementById('canvas'),
  overlay: document.getElementById('overlay'),
  status: document.getElementById('status'),
  printImg: document.getElementById('printImg'),
  pNameA: document.getElementById('pNameA'),
  pNameB: document.getElementById('pNameB'),
  pRemoved: document.getElementById('pRemoved'),
  pAdded: document.getElementById('pAdded'),
  pCommon: document.getElementById('pCommon'),
};
const ctx = els.canvas.getContext('2d');

let bufA = null, bufB = null;
let itemsA = [], itemsB = [];
let bbox = null;

const COLORS = { removed: '#e5484d', added: '#4f8cf7', common: '#5b6270' };

function setStatus(msg, isErr = false) {
  els.status.textContent = msg || '';
  els.status.classList.toggle('err', !!isErr);
}

function updateCompareEnabled() { els.compareBtn.disabled = !(bufA && bufB); }

async function readFile(input, which) {
  const f = input.files && input.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  if (which === 'A') { bufA = buf; els.nameA.textContent = f.name; }
  else { bufB = buf; els.nameB.textContent = f.name; }
  // 同じファイルを選び直しても change が再発火するよう value をクリアする。
  // （ファイルを外部で編集→再選択しても再読み込みされない問題への対処）
  input.value = '';
  updateCompareEnabled();
}

els.fileA.addEventListener('change', () => readFile(els.fileA, 'A'));
els.fileB.addEventListener('change', () => readFile(els.fileB, 'B'));
els.compareBtn.addEventListener('click', runCompare);
els.fitBtn.addEventListener('click', () => { resizeCanvas(); fitToView(bbox); render(); });
els.printBtn.addEventListener('click', async () => { if (await printCurrentView()) window.print(); });
[els.tRemoved, els.tAdded, els.tCommon].forEach(c => c.addEventListener('change', render));
els.tol.addEventListener('change', () => { if (bufA && bufB) runCompare(); });

let comparing = false; // 許容差changeはボタンのdisabledを経由しないため、二重実行をここで防ぐ

async function runCompare() {
  if (comparing) return;
  comparing = true;
  let stage = '開始';
  try {
    els.compareBtn.disabled = true;
    const tol = Math.max(parseFloat(els.tol.value) || 0.01, 1e-9);

    stage = 'サンドボックス初期化';
    setStatus('① ' + stage + '中…');
    await ensureSandbox();

    stage = '旧図(A)を解析';
    setStatus('② ' + stage + '中…');
    const A = await parseItems(bufA, tol);

    stage = '新図(B)を解析';
    setStatus('③ ' + stage + '中…');
    const B = await parseItems(bufB, tol);

    stage = '差分計算';
    setStatus('④ ' + stage + '中…');
    itemsA = A.items; itemsB = B.items;
    const counts = diff(itemsA, itemsB);
    els.cRemoved.textContent = counts.removed;
    els.cAdded.textContent = counts.added;
    els.cCommon.textContent = counts.common;

    stage = '描画';
    setStatus('⑤ ' + stage + '中…');
    bbox = computeBbox([...itemsA, ...itemsB]);
    els.overlay.classList.add('hidden');
    resizeCanvas();
    fitToView(bbox);
    render();
    els.printBtn.disabled = false; // 比較結果が表示されたので印刷可能に

    const warn = [];
    warn.push(`A: 図形${A.items.length}/全${A.total}件, B: 図形${B.items.length}/全${B.total}件`);
    if (A.unsupported || B.unsupported)
      warn.push(`未対応エンティティ: A=${A.unsupported} / B=${B.unsupported} 件（除外）`);
    if (A.stats.unknownEntityCount || B.stats.unknownEntityCount)
      warn.push(`libredwg未知: A=${A.stats.unknownEntityCount} / B=${B.stats.unknownEntityCount}`);
    setStatus(warn.join('\n'));
  } catch (err) {
    console.error('[DWG Compare] stage=' + stage, err);
    const msg = (err && err.message) ? err.message : String(err);
    setStatus(`エラー（段階: ${stage}）\n${msg}`, true);
  } finally {
    comparing = false;
    els.compareBtn.disabled = false;
  }
}

function computeBbox(items) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const acc = (p) => { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; if (p.x > maxx) maxx = p.x; if (p.y > maxy) maxy = p.y; };
  for (const it of items) {
    for (const pl of it.polylines) for (const p of pl) acc(p);
    for (const l of it.labels) acc(l);
  }
  if (!isFinite(minx)) return null;
  return { minx, miny, maxx, maxy };
}

// ============================================================
//  描画
// ============================================================
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(r.width * dpr);
  els.canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function visible(cls) {
  return (cls === 'removed' && els.tRemoved.checked)
      || (cls === 'added' && els.tAdded.checked)
      || (cls === 'common' && els.tCommon.checked);
}

// g: 描画先context, toScreen: world→描画座標, scale: 文字サイズ用スケール
function drawItems(g, items, onlyCls, toScreen, scale) {
  for (const it of items) {
    if (it.cls !== onlyCls || !visible(it.cls)) continue;
    g.strokeStyle = COLORS[it.cls];
    g.beginPath();
    for (const pl of it.polylines) {
      for (let i = 0; i < pl.length; i++) {
        const s = toScreen(pl[i]);
        if (i === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y);
      }
    }
    g.stroke();
    for (const l of it.labels) {
      const s = toScreen(l);
      const fs = Math.max(8, l.h * scale);
      if (fs < 5) continue;
      g.save();
      g.translate(s.x, s.y);
      if (l.rot) g.rotate(-l.rot);
      g.fillStyle = COLORS[it.cls];
      g.font = `${fs}px sans-serif`;
      g.textBaseline = 'bottom';
      g.fillText(l.text, 0, 0);
      g.restore();
    }
  }
}

// itemsを描画順（共通→削除→追加）で g に描く
function paint(g, toScreen, scale) {
  g.lineWidth = 1;
  drawItems(g, itemsA, 'common', toScreen, scale);
  drawItems(g, itemsA, 'removed', toScreen, scale);
  drawItems(g, itemsB, 'added', toScreen, scale);
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  paint(ctx, w2s, cam.scale);
  ctx.restore();
}

// ============================================================
//  印刷（現在の表示を白背景の画像にして window.print）
// ============================================================
async function printCurrentView() {
  if (!bbox) return false; // 比較前は何もしない
  const rect = els.canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));
  const k = 2; // 印刷用に2倍解像度
  const oc = document.createElement('canvas');
  oc.width = W * k;
  oc.height = H * k;
  const g = oc.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  // 画面と同じカメラ・表示トグルで描画（w2s は現在のcamを参照）
  paint(g, w2s, cam.scale);

  // ヘッダー（ファイル名・件数）を反映
  els.pNameA.textContent = els.nameA.textContent;
  els.pNameB.textContent = els.nameB.textContent;
  els.pRemoved.textContent = els.cRemoved.textContent;
  els.pAdded.textContent = els.cAdded.textContent;
  els.pCommon.textContent = els.cCommon.textContent;

  // 画像のロード完了を待ってから印刷する。
  // src設定→即print だと初回は画像未ロードでプレビューが空になるため。
  els.printImg.src = oc.toDataURL('image/png');
  await new Promise((resolve) => {
    // 同じ画像で既にロード済みなら即座に、そうでなければ onload を待つ
    if (els.printImg.complete && els.printImg.naturalWidth > 0) { resolve(); return; }
    els.printImg.onload = resolve;
    els.printImg.onerror = resolve; // 失敗しても印刷は試みる
  });
  return true;
}

// ---- パン / ズーム ----
let dragging = false, lastX = 0, lastY = 0;
els.canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  els.canvas.classList.add('dragging');
  els.canvas.setPointerCapture(e.pointerId);
});
els.canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.ox += (e.clientX - lastX); cam.oy += (e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY; render();
});
els.canvas.addEventListener('pointerup', (e) => {
  dragging = false; els.canvas.classList.remove('dragging');
  els.canvas.releasePointerCapture(e.pointerId);
});
els.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = els.canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(-e.deltaY * 0.0015);
  // scaleが0/Infinityへ発散すると座標がNaNになり描画が消えるため範囲を制限
  const ns = Math.min(1e8, Math.max(1e-8, cam.scale * f));
  if (ns === cam.scale) return;
  const wx = (mx - cam.ox) / cam.scale;
  const wy = -(my - cam.oy) / cam.scale;
  cam.scale = ns;
  cam.ox = mx - wx * cam.scale;
  cam.oy = my + wy * cam.scale;
  render();
}, { passive: false });

window.addEventListener('resize', () => { if (bbox) { resizeCanvas(); render(); } });
