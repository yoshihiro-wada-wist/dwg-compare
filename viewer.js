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
  let onMsg;
  try {
    const res = await new Promise((resolve, reject) => {
      onMsg = (ev) => {
        if (ev.source !== iframe.contentWindow) return;
        const m = ev.data || {};
        if (m.type === 'ready') {
          // 初期化完了 → このiframeへ parse を依頼
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
//  カメラ
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
  updateCompareEnabled();
}

els.fileA.addEventListener('change', () => readFile(els.fileA, 'A'));
els.fileB.addEventListener('change', () => readFile(els.fileB, 'B'));
els.compareBtn.addEventListener('click', runCompare);
els.fitBtn.addEventListener('click', () => { resizeCanvas(); fitTo(bbox, els.canvas.width, els.canvas.height); render(); });
[els.tRemoved, els.tAdded, els.tCommon].forEach(c => c.addEventListener('change', render));
els.tol.addEventListener('change', () => { if (bufA && bufB) runCompare(); });

async function runCompare() {
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
    fitTo(bbox, els.canvas.width, els.canvas.height);
    render();

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

function drawItems(items, onlyCls) {
  for (const it of items) {
    if (it.cls !== onlyCls || !visible(it.cls)) continue;
    ctx.strokeStyle = COLORS[it.cls];
    ctx.beginPath();
    for (const pl of it.polylines) {
      for (let i = 0; i < pl.length; i++) {
        const s = w2s(pl[i]);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
    }
    ctx.stroke();
    for (const l of it.labels) {
      const s = w2s(l);
      const fs = Math.max(8, l.h * cam.scale);
      if (fs < 5) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      if (l.rot) ctx.rotate(-l.rot);
      ctx.fillStyle = COLORS[it.cls];
      ctx.font = `${fs}px sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.lineWidth = 1;
  drawItems(itemsA, 'common');
  drawItems(itemsA, 'removed');
  drawItems(itemsB, 'added');
  ctx.restore();
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
  const wx = (mx - cam.ox) / cam.scale;
  const wy = -(my - cam.oy) / cam.scale;
  cam.scale *= f;
  cam.ox = mx - wx * cam.scale;
  cam.oy = my + wy * cam.scale;
  render();
}, { passive: false });

window.addEventListener('resize', () => { if (bbox) { resizeCanvas(); render(); } });
