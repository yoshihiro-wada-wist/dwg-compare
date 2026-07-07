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

// ===== 文字ユーティリティ =====
// MTEXT の書式コードを除去し、改行(\P)を実改行に変換する。
// 例: "HLS\P{\H0.66667x;\W0.8;(参照)}" -> "HLS\n(参照)"
function cleanMText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\\P/g, '\n');                  // 段落区切り → 改行
  t = t.replace(/\\~/g, ' ');                   // 非改行スペース
  t = t.replace(/\\[A-Za-z][^\\;{}]*;?/g, '');  // \H0.7x; \W0.8; \A1; \Cn; \f..; \px..; \Q..; \L \O 等
  t = t.replace(/[{}]/g, '');                    // グループ括弧
  t = t.replace(/\\([\\{}])/g, '$1');            // エスケープされた \ { }
  return t;
}

// TEXT の halign(72)/valign(73) → Canvas の textAlign/textBaseline
function textAlignHV(halign, valign) {
  const h = (halign === 1 || halign === 4 || halign === 5) ? 'center' : (halign === 2 ? 'right' : 'left');
  // halign=4(Middle)は水平・垂直とも中央（円内の中央文字などがこれ）
  const v = halign === 4 ? 'middle'
    : valign === 3 ? 'top' : valign === 2 ? 'middle' : valign === 1 ? 'bottom' : 'alphabetic';
  return { ah: h, av: v };
}

// MTEXT の attachmentPoint(1..9) → textAlign/textBaseline
function textAlignAttach(ap) {
  const h = (ap === 2 || ap === 5 || ap === 8) ? 'center' : (ap === 3 || ap === 6 || ap === 9) ? 'right' : 'left';
  const v = (ap >= 1 && ap <= 3) ? 'top' : (ap >= 4 && ap <= 6) ? 'middle' : 'bottom';
  return { ah: h, av: v };
}

// 寸法値の整形（小数2桁まで、末尾0は落とす）
function fmtMeasure(m) {
  if (m == null || !isFinite(m)) return '';
  let s = (Math.round(m * 100) / 100).toString();
  return s;
}

// 直線/並列寸法(LINEAR/ALIGNED)を、補助線+寸法線+矢印の折れ線に展開する。
// 測定2点(p1,p2)、寸法線が通る点(dlp)から寸法線を構成し、両端に矢印を付ける。
function dimensionShapes(e, polylines) {
  const p1 = e.subDefinitionPoint1, p2 = e.subDefinitionPoint2, dlp = e.definitionPoint;
  if (!p1 || !p2 || !dlp) return null;
  let dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;               // 寸法線方向
  const proj = (P) => {                              // dlpを通る寸法線へ射影
    const t = (P.x - dlp.x) * ux + (P.y - dlp.y) * uy;
    return { x: dlp.x + ux * t, y: dlp.y + uy * t };
  };
  const d1 = proj(p1), d2 = proj(p2);
  polylines.push([{ x: p1.x, y: p1.y }, { x: d1.x, y: d1.y }]); // 補助線1
  polylines.push([{ x: p2.x, y: p2.y }, { x: d2.x, y: d2.y }]); // 補助線2
  polylines.push([{ x: d1.x, y: d1.y }, { x: d2.x, y: d2.y }]); // 寸法線
  // 矢印（寸法線端から内向きに尖る三角形）
  const asz = 2.0;                                   // 矢サイズ（図面単位, 簡易固定）
  const arrow = (tip, dirx, diry) => {               // dir = 尖る向き
    const nx = -diry, ny = dirx;                     // 直交
    const bx = tip.x - dirx * asz, by = tip.y - diry * asz;
    polylines.push([
      { x: tip.x, y: tip.y },
      { x: bx + nx * asz * 0.33, y: by + ny * asz * 0.33 },
      { x: bx - nx * asz * 0.33, y: by - ny * asz * 0.33 },
      { x: tip.x, y: tip.y },
    ]);
  };
  arrow(d1, -ux, -uy);
  arrow(d2, ux, uy);
  return { d1, d2 };
}

// ===== エンティティ -> 描画プリミティブ + シグネチャ =====
function entityToShapes(e, q, verticalStyles) {
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
    } else if (t === 'MTEXT') {
      const p = e.insertionPoint || e.startPoint || e.position || { x: 0, y: 0 };
      const h = e.textHeight || e.height || 1;
      const str = cleanMText(e.text || '');
      const al = textAlignAttach(e.attachmentPoint);
      // MTEXTの角度は direction(X軸方向ベクトル group11) が優先。無ければ rotation。
      // 直径/角度寸法などは rotation=0 でも direction に寸法線の傾きが入るため、
      // これを使わないと寸法値が寸法線に沿わず水平のままになる。
      const dir = e.direction;
      const mrot = (dir && (dir.x || dir.y)) ? Math.atan2(dir.y, dir.x) : (e.rotation || 0);
      // 幅は書式コード(\W)側で表現されるため xScale は 1 とする
      labels.push({ x: p.x, y: p.y, text: str, h, rot: mrot, xScale: 1, ah: al.ah, av: al.av });
      sig = `MTEXT|${q(p.x)},${q(p.y)},${q(h)},${q(mrot)}|${str}`;
    } else if (t === 'TEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
      const h = e.textHeight || e.height || 1;
      const str = (e.text || '').toString();
      const xs = e.xScale || 1;                 // 幅係数(横倍率)
      const halign = e.halign | 0, valign = e.valign | 0;
      // 整列テキスト(中央/右寄せ・上下寄せ等)の実位置は第2整列点(endPoint=group11)。
      // group10(startPoint)は(0,0)等のことが多く、これを使うと円内の中央文字などが
      // 原点へ飛んでしまう。整列(halign/valign≠0)時のみ第2整列点を採用する。
      const p1 = e.startPoint || e.insertionPoint || e.position || { x: 0, y: 0 };
      const p2 = (e.endPoint && (e.endPoint.x || e.endPoint.y)) ? e.endPoint : p1;
      const p = (halign !== 0 || valign !== 0) ? p2 : p1;
      // 縦書きスタイル(STYLE.standardFlag & 4)なら1文字ずつ縦積みで描画する
      const vertical = !!(verticalStyles && verticalStyles.has(e.styleName));
      const al = textAlignHV(halign, valign);
      labels.push({ x: p.x, y: p.y, text: str, h, rot: e.rotation || 0, xScale: xs, ah: al.ah, av: al.av, vertical });
      sig = `TEXT|${q(p.x)},${q(p.y)},${q(h)},${Math.round(xs * 1000)},${q(e.rotation || 0)},${vertical ? 'V' : 'H'}|${str}`;
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
    } else if (t === 'DIMENSION') {
      const dtype = (e.dimensionType || 0) & 7; // 0:直線/回転 1:並列 2:角度 3:直径 4:半径 5:角度3点 6:座標
      let dimAngle = 0;                          // 寸法線の角度（テキストをこれに沿わせる）
      let prefix = '';
      if (dtype === 3 || dtype === 4) {
        // 直径(3)/半径(4)寸法: definitionPoint(円周上) と centerPoint を結ぶ線＝寸法線
        prefix = dtype === 3 ? '⌀' : 'R';
        const a = e.definitionPoint, b = e.centerPoint;
        if (a && b) {
          const ddx = b.x - a.x, ddy = b.y - a.y, dl = Math.hypot(ddx, ddy) || 1;
          const ux = ddx / dl, uy = ddy / dl;
          dimAngle = Math.atan2(ddy, ddx);
          polylines.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]); // 寸法線
          const asz = 2.0;
          const arrow = (tip, dx, dy) => {
            const nx = -dy, ny = dx; const bx = tip.x - dx * asz, by = tip.y - dy * asz;
            polylines.push([{ x: tip.x, y: tip.y }, { x: bx + nx * asz * 0.33, y: by + ny * asz * 0.33 }, { x: bx - nx * asz * 0.33, y: by - ny * asz * 0.33 }, { x: tip.x, y: tip.y }]);
          };
          if (dtype === 3) { arrow(a, -ux, -uy); arrow(b, ux, uy); } // 直径は両端
          else { arrow(b, ux, uy); }                                 // 半径は円周側のみ
        }
      } else {
        // 直線/並列寸法: 補助線+寸法線+矢印
        const dl = dimensionShapes(e, polylines);
        if (dl) dimAngle = Math.atan2(dl.d2.y - dl.d1.y, dl.d2.x - dl.d1.x);
      }
      const raw = (e.text || '').trim();
      const val = prefix + fmtMeasure(e.measurement);
      const str = (!raw || raw === '<>') ? val : raw.replace('<>', prefix + fmtMeasure(e.measurement));
      // テキストは寸法線に沿わせる（上下反転しないよう ±90° に正規化）
      let tr = e.textRotation ? e.textRotation : dimAngle;
      if (tr > Math.PI / 2) tr -= Math.PI; else if (tr < -Math.PI / 2) tr += Math.PI;
      const tp = e.textPoint || e.definitionPoint || { x: 0, y: 0 };
      const h = e.textHeight || 2.5; // 寸法字高（dimstyle未参照の簡易既定）
      if (str) labels.push({ x: tp.x, y: tp.y, text: str, h, rot: tr, xScale: 1, ah: 'center', av: 'middle' });
      const dp = e.definitionPoint || { x: 0, y: 0 };
      const cp = e.centerPoint || e.subDefinitionPoint2 || { x: 0, y: 0 };
      const p1 = e.subDefinitionPoint1 || { x: 0, y: 0 };
      sig = `DIM|${e.dimensionType || 0}|${q(dp.x)},${q(dp.y)},${q(cp.x)},${q(cp.y)},${q(p1.x)},${q(p1.y)}|${str}`;
    }
  } catch (err) { /* 1エンティティの失敗で全体を止めない */ }
  return { polylines, labels, sig, type: t, cls: null };
}

function buildItems(entities, tol, verticalStyles, blockMap) {
  const q = (v) => (v == null ? 0 : Math.round(v / tol));
  const items = [];
  let unsupported = 0;
  for (const e of entities) {
    if (e.isInPaperSpace) continue;
    // 匿名ブロック(名前が * で始まる INSERT)は、DWGが内部生成する実体のない
    // ブロック参照。挿入点(多くは原点)にマーカーが描かれ「実際に無い図形」として
    // 見えてしまうため、描画・差分の対象から除外する。
    if (e.type === 'INSERT' && typeof e.name === 'string' && e.name.startsWith('*')) continue;
    if (e.type === 'DIMENSION') {
      // 寸法は AutoCAD が計算済みの幾何(寸法線・補助線・矢印・文字)を匿名ブロック
      // (*D#)に持つ。手動再構成は破綻しやすいため、そのブロックを展開して各サブ
      // 要素を実体として描画・差分対象にする（正常動作する dwg_viewer と同方式）。
      const blk = e.name && blockMap[e.name];
      if (blk && blk.length) {
        for (const be of blk) {
          const s = entityToShapes(be, q, verticalStyles);
          if (s.sig) items.push(s);
        }
      } else {
        // ブロックが取得できない場合のみ、従来の手動再構成にフォールバックする。
        const s = entityToShapes(e, q, verticalStyles);
        if (s.sig) items.push(s); else unsupported++;
      }
      continue;
    }
    const s = entityToShapes(e, q, verticalStyles);
    if (!s.sig) { unsupported++; continue; }
    items.push(s);
  }
  return { items, unsupported };
}

// BLOCK_RECORD から「ブロック名 → 内包エンティティ配列」を作る（寸法の匿名ブロック展開用）
function buildBlockMap(db) {
  const map = {};
  try {
    const br = db && db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries;
    const arr = Array.isArray(br) ? br : (br && typeof br === 'object' ? Object.values(br) : []);
    for (const b of arr) {
      if (b && b.name && Array.isArray(b.entities)) map[String(b.name)] = b.entities;
    }
  } catch (_) { /* 取得失敗時は空マップ */ }
  return map;
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
  let entities, stats, __db = null;
  try {
    const r = lib.convertEx(ptr);
    entities = (r.database && r.database.entities) || [];
    __db = r.database || null;
    stats = r.stats || { unknownEntityCount: 0 };
  } catch (e) {
    try { lib.dwg_free(ptr); } catch (_) {}
    libReady = null;
    throw new Error('convert: ' + (e.message || e));
  }
  try { lib.dwg_free(ptr); } catch (_) {}
  // 縦書きスタイル名の集合を作る（STYLE の standardFlag bit2(=4) が縦書き）
  const verticalStyles = collectVerticalStyles(__db);
  // 寸法の計算済み幾何を保持する匿名ブロック(*D#)を展開するためのマップ
  const blockMap = buildBlockMap(__db);
  const { items, unsupported } = buildItems(entities, tol, verticalStyles, blockMap);
  return { items, unsupported, stats, total: entities.length };
}

// STYLE テーブルから、縦書きフラグ(standardFlag & 4)が立っているスタイル名を集める
function collectVerticalStyles(db) {
  const set = new Set();
  try {
    const tbl = db && (db.tables || db.TABLES);
    const st = tbl && (tbl.STYLE || tbl.styles);
    const arr = st && (st.entries || st.items || st);
    if (arr && arr.length) {
      for (const s of arr) {
        if (s && s.name && ((s.standardFlag || 0) & 4)) set.add(s.name);
      }
    }
  } catch (_) {}
  return set;
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
