// サンドボックス（unsafe-eval 許可）内で WASM 解析 + 図形化まで実行する。
// 親へは「数値・文字列だけの描画プリミティブ」を返す（entitiesのクローン不可問題を排除）。
import { LibreDwg, Dwg_File_Type } from './vendor/dist/libredwg-web.js';

let wasmBase = null;
let libReady = null;

function getLib() {
  if (!libReady) {
    if (!wasmBase) throw new Error('wasmBase 未設定');
    libReady = LibreDwg.create(wasmBase);
  }
  return libReady;
}

// ===== 幾何ユーティリティ =====
const TAU = Math.PI * 2;

function bulgePoints(p1, p2, bulge, segs = 24) {
  if (!bulge) return [p1, p2];
  const theta = 4 * Math.atan(Math.abs(bulge));
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chord === 0) return [p1, p2];
  const radius = chord / (2 * Math.sin(theta / 2));
  const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const gamma = (Math.PI - theta) / 2;
  const cAng = bulge > 0 ? ang + gamma : ang - gamma;
  const cx = p1.x + radius * Math.cos(cAng);
  const cy = p1.y + radius * Math.sin(cAng);
  let a0 = Math.atan2(p1.y - cy, p1.x - cx);
  let a1 = Math.atan2(p2.y - cy, p2.x - cx);
  if (bulge > 0 && a1 < a0) a1 += TAU;
  if (bulge < 0 && a1 > a0) a1 -= TAU;
  const n = Math.max(2, Math.ceil(segs * theta / TAU));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (a1 - a0) * (i / n);
    out.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) });
  }
  return out;
}

function arcPoints(cx, cy, r, a0, a1, ccw = true, segs = 64) {
  let s = a0, e = a1;
  if (ccw && e < s) e += TAU;
  if (!ccw && e > s) e -= TAU;
  const n = Math.max(6, Math.ceil(segs * Math.abs(e - s) / TAU));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = s + (e - s) * (i / n);
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

// ===== エンティティ -> 描画プリミティブ + シグネチャ =====
function entityToShapes(e, q) {
  const polylines = [];
  const labels = [];
  let sig = null;
  const t = e.type;
  try {
    if (t === 'LINE') {
      const a = e.startPoint, b = e.endPoint;
      polylines.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
      const k1 = `${q(a.x)},${q(a.y)}`, k2 = `${q(b.x)},${q(b.y)}`;
      sig = `LINE|${k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1}`;
    } else if (t === 'CIRCLE') {
      polylines.push(arcPoints(e.center.x, e.center.y, e.radius, 0, TAU));
      sig = `CIRCLE|${q(e.center.x)},${q(e.center.y)},${q(e.radius)}`;
    } else if (t === 'ARC') {
      polylines.push(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, true));
      sig = `ARC|${q(e.center.x)},${q(e.center.y)},${q(e.radius)},${q(e.startAngle)},${q(e.endAngle)}`;
    } else if (t === 'ELLIPSE') {
      const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
      const major = Math.hypot(mx, my);
      const minor = major * e.axisRatio;
      const rot = Math.atan2(my, mx);
      const a0 = e.startAngle ?? 0, a1 = e.endAngle ?? TAU;
      const n = 96; const pts = [];
      let s = a0, en = a1; if (en <= s) en += TAU;
      for (let i = 0; i <= n; i++) {
        const tt = s + (en - s) * (i / n);
        const lx = major * Math.cos(tt), ly = minor * Math.sin(tt);
        pts.push({ x: e.center.x + lx * Math.cos(rot) - ly * Math.sin(rot),
                   y: e.center.y + lx * Math.sin(rot) + ly * Math.cos(rot) });
      }
      polylines.push(pts);
      sig = `ELLIPSE|${q(e.center.x)},${q(e.center.y)},${q(major)},${q(e.axisRatio)},${q(rot)},${q(a0)},${q(a1)}`;
    } else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
      const verts = e.vertices || [];
      const closed = !!((e.flag || 0) & 1);
      const pts = []; const sigParts = [];
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const nv = verts[(i + 1) % verts.length];
        sigParts.push(`${q(v.x)},${q(v.y)},${q(v.bulge || 0)}`);
        if (i < verts.length - 1 || closed) {
          const seg = bulgePoints({ x: v.x, y: v.y }, { x: nv.x, y: nv.y }, v.bulge || 0);
          if (pts.length) seg.shift();
          pts.push(...seg);
        } else {
          pts.push({ x: v.x, y: v.y });
        }
      }
      if (pts.length) polylines.push(pts);
      sig = `${t}|${closed ? 'C' : 'O'}|${sigParts.join(';')}`;
    } else if (t === 'POINT') {
      const p = e.position; const d = 0.6;
      polylines.push([{ x: p.x - d, y: p.y }, { x: p.x + d, y: p.y }]);
      polylines.push([{ x: p.x, y: p.y - d }, { x: p.x, y: p.y + d }]);
      sig = `POINT|${q(p.x)},${q(p.y)}`;
    } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
      const p = e.startPoint || e.insertionPoint || e.position || { x: 0, y: 0 };
      const h = e.textHeight || e.height || e.rectHeight || 1;
      const str = (e.text || '').toString();
      labels.push({ x: p.x, y: p.y, text: str, h, rot: e.rotation || 0 });
      sig = `TEXT|${q(p.x)},${q(p.y)},${q(h)}|${str}`;
    } else if (t === 'INSERT') {
      const p = e.insertionPoint; const m = 2;
      polylines.push([{ x: p.x - m, y: p.y - m }, { x: p.x + m, y: p.y - m },
                      { x: p.x + m, y: p.y + m }, { x: p.x - m, y: p.y + m },
                      { x: p.x - m, y: p.y - m }]);
      labels.push({ x: p.x, y: p.y, text: e.name || '(block)', h: 2, rot: e.rotation || 0 });
      sig = `INSERT|${e.name}|${q(p.x)},${q(p.y)},${q(e.xScale)},${q(e.yScale)},${q(e.rotation || 0)}`;
    } else if (t === 'SPLINE') {
      const cp = (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints) || [];
      if (cp.length) polylines.push(cp.map(p => ({ x: p.x, y: p.y })));
      sig = `SPLINE|${cp.map(p => `${q(p.x)},${q(p.y)}`).join(';')}`;
    } else if (t === 'SOLID' || t === '3DFACE') {
      const c = [e.corner1, e.corner2, e.corner4, e.corner3].filter(Boolean);
      if (c.length >= 3) { const pts = c.map(p => ({ x: p.x, y: p.y })); pts.push(pts[0]); polylines.push(pts); }
      sig = `${t}|${[e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map(p => `${q(p.x)},${q(p.y)}`).join(';')}`;
    }
  } catch (err) { /* 1エンティティの失敗で全体を止めない */ }
  return { polylines, labels, sig, type: t, cls: null };
}

function buildItems(entities, tol) {
  const q = (v) => (v == null ? 0 : Math.round(v / tol));
  const items = [];
  let unsupported = 0;
  for (const e of entities) {
    if (e.isInPaperSpace) continue;
    const s = entityToShapes(e, q);
    if (!s.sig) { unsupported++; continue; }
    items.push(s);
  }
  return { items, unsupported };
}

// ===== 解析パイプライン =====
async function parseToItems(buffer, tol) {
  const lib = await getLib();
  let ptr;
  try {
    ptr = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
  } catch (e) { libReady = null; throw new Error('dwg_read_data: ' + (e.message || e)); }
  if (ptr === undefined || ptr === null || ptr === 0) {
    throw new Error('libredwg がこのDWGを開けませんでした（未対応バージョン/独自オブジェクトの可能性）');
  }
  let entities, stats;
  try {
    const r = lib.convertEx(ptr);
    entities = (r.database && r.database.entities) || [];
    stats = r.stats || { unknownEntityCount: 0 };
  } catch (e) {
    try { lib.dwg_free(ptr); } catch (_) {}
    libReady = null;
    throw new Error('convert: ' + (e.message || e));
  }
  try { lib.dwg_free(ptr); } catch (_) {}
  const { items, unsupported } = buildItems(entities, tol);
  return { items, unsupported, stats, total: entities.length };
}

window.addEventListener('message', async (ev) => {
  const msg = ev.data || {};
  const post = (m) => ev.source.postMessage(m, '*');
  try {
    if (msg.type === 'init') {
      wasmBase = msg.wasmBase;
      await getLib();
      post({ type: 'ready' });
    } else if (msg.type === 'parse') {
      const res = await parseToItems(msg.buffer, msg.tol || 0.01);
      post({ type: 'result', id: msg.id, ok: true, items: res.items,
             unsupported: res.unsupported, stats: res.stats, total: res.total });
    }
  } catch (err) {
    const error = (err && (err.name ? err.name + ': ' : '') + (err.message || String(err))) || 'unknown';
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
    if (msg.type === 'init') post({ type: 'fatal', error, stack });
    else post({ type: 'result', id: msg.id, ok: false, error, stack });
  }
});
