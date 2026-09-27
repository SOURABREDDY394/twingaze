/* TwinGaze · detector.js
 * Finds tiny, bright, isolated points in a camera frame (a lens throwing the flash back,
 * or a night-vision LED glowing) and follows each one from frame to frame.
 * Pure JS, no dependencies. Input is the RGBA buffer from canvas getImageData. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    rIn: 1,            // core radius: 3x3 around the peak
    rOut: 7,           // surround radius: 15x15 around the peak
    minPeak: 120,      // the peak pixel must reach this (0-255, brightest of R/G/B)
    minContrast: 55,   // peak minus the brightest side of its surround
    minRatio: 1.8,     // (peak + 8) / (brightest side + 8)
    minCore: 8,        // 3x3 mean minus surround mean: a little mass, not one noisy pixel
    nmsDist: 6,        // px: a weaker peak this close to a stronger one is the same thing
    maxCand: 16,       // peaks measured per frame
    growWin: 18,       // blob measurement window radius, px
    maxArea: 360,      // stop growing a blob past this many px and call it big
  };

  let W = 0, H = 0, V = null, S = null, M = null, stamp = 0;

  function ensure(w, h) {
    if (w === W && h === H) return;
    W = w; H = h;
    V = new Uint8Array(w * h);
    S = new Float64Array((w + 1) * (h + 1));
    M = new Int32Array(w * h);
    stamp = 0;
  }

  /* One frame in, a list of bright isolated points out.
   * Each point is tested against four half-planes around it (above, below, left, right).
   * A real point is darker on every side; the edge of a lamp or window is bright on one
   * side, so it fails. That keeps big bright things from crowding out tiny glints. */
  function detect(rgba, w, h, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    ensure(w, h);
    const W1 = w + 1;
    let total = 0;
    for (let y = 0; y < h; y++) {
      let row = 0;
      const sr = (y + 1) * W1, sp = y * W1, yr = y * w;
      for (let x = 0; x < w; x++) {
        const p = (yr + x) << 2;
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        const v = r > g ? (r > b ? r : b) : (g > b ? g : b);
        V[yr + x] = v; row += v;
        S[sr + x + 1] = S[sp + x + 1] + row;
      }
      total += row;
    }
    const box = (x0, y0, x1, y1) =>
      S[(y1 + 1) * W1 + x1 + 1] - S[y0 * W1 + x1 + 1] - S[(y1 + 1) * W1 + x0] + S[y0 * W1 + x0];

    const R = o.rOut, ri = o.rIn;
    const nCore = (2 * ri + 1) * (2 * ri + 1);
    const nSide = (2 * R + 1) * (R - ri);
    const nRing = (2 * R + 1) * (2 * R + 1) - nCore;
    const cand = [];
    for (let y = R; y < h - R; y++) {
      const yr = y * w;
      for (let x = R; x < w - R; x++) {
        const i = yr + x, v = V[i];
        if (v < o.minPeak) continue;
        if (v < V[i - 1] || v < V[i + 1] || v < V[i - w] || v < V[i + w] ||
            v < V[i - w - 1] || v < V[i - w + 1] || v < V[i + w - 1] || v < V[i + w + 1]) continue;
        const top = box(x - R, y - R, x + R, y - ri - 1) / nSide;
        const bot = box(x - R, y + ri + 1, x + R, y + R) / nSide;
        const lef = box(x - R, y - R, x - ri - 1, y + R) / nSide;
        const rig = box(x + ri + 1, y - R, x + R, y + R) / nSide;
        const side = Math.max(top, bot, lef, rig);
        if (v - side < o.minContrast || (v + 8) / (side + 8) < o.minRatio) continue;
        const core = box(x - ri, y - ri, x + ri, y + ri);
        const bg = (box(x - R, y - R, x + R, y + R) - core) / nRing;
        if (core / nCore - bg < o.minCore) continue;
        cand.push({ x, y, v, bg, side, d: v - side });
      }
    }

    cand.sort((a, b) => b.d - a.d || b.v - a.v);
    const keep = [], nd2 = o.nmsDist * o.nmsDist;
    for (const c of cand) {
      let ok = true;
      for (const k of keep) {
        const dx = k.x - c.x, dy = k.y - c.y;
        if (dx * dx + dy * dy < nd2) { ok = false; break; }
      }
      if (ok) { keep.push(c); if (keep.length >= o.maxCand) break; }
    }

    const dets = [];
    for (const c of keep) {
      const d = grow(rgba, w, h, c, o);
      // two peaks inside one blob: keep the first (stronger) one
      const dup = dets.some(e => {
        const dx = e.px - d.px, dy = e.py - d.py, r = Math.sqrt(Math.max(e.area, d.area)) * 0.7 + 2;
        return dx * dx + dy * dy < r * r;
      });
      if (!dup) dets.push(d);
    }
    return { dets, mean: total / (w * h), w, h };
  }

  /* Measures the blob around a peak: centroid, area, mean colour. */
  function grow(rgba, w, h, c, o) {
    stamp++;
    const thr = c.bg + 0.5 * (c.v - c.bg);
    const x0 = Math.max(0, c.x - o.growWin), x1 = Math.min(w - 1, c.x + o.growWin);
    const y0 = Math.max(0, c.y - o.growWin), y1 = Math.min(h - 1, c.y + o.growWin);
    const start = c.y * w + c.x;
    const stack = [start];
    M[start] = stamp;
    let area = 0, sw = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0, big = false;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      const wt = V[i] - thr + 1;
      area++; sw += wt; sx += x * wt; sy += y * wt;
      const p = i << 2;
      sr += rgba[p]; sg += rgba[p + 1]; sb += rgba[p + 2];
      if (area > o.maxArea) { big = true; break; }
      if (x === x0 || x === x1 || y === y0 || y === y1) big = true;
      if (x > x0) { const j = i - 1; if (M[j] !== stamp && V[j] >= thr) { M[j] = stamp; stack.push(j); } }
      if (x < x1) { const j = i + 1; if (M[j] !== stamp && V[j] >= thr) { M[j] = stamp; stack.push(j); } }
      if (y > y0) { const j = i - w; if (M[j] !== stamp && V[j] >= thr) { M[j] = stamp; stack.push(j); } }
      if (y < y1) { const j = i + w; if (M[j] !== stamp && V[j] >= thr) { M[j] = stamp; stack.push(j); } }
    }
    const cx = sx / sw, cy = sy / sw;
    return {
      x: (cx + 0.5) / w, y: (cy + 0.5) / h, px: cx, py: cy,
      v: c.v, bg: c.bg, d: c.d, area, big,
      r: sr / area, g: sg / area, b: sb / area,
    };
  }

  /* ---------- tracking ---------- */

  function Tracker() { this.tracks = []; this.nextId = 1; }

  // forget the points but keep numbering: a point number is never reused within one scan
  Tracker.prototype.reset = function () { this.tracks = []; };

  /* f = { t, dt, w, h, rot:[x,y,z] degrees or null, rotRate deg/s, freeze, allowNew, maxNewArea, killMs }
   * freeze: the flash is being switched, so a point going missing is expected; nobody dies.
   * Returns the tracks that were dropped this frame. */
  Tracker.prototype.update = function (dets, f) {
    const L = Math.max(f.w, f.h), ax = f.w / L, ay = f.h / L;
    const gate = 0.04 + Math.min(0.14, (f.rotRate || 0) * (f.dt || 0.04) / 55);
    const pairs = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      const g = gate + Math.min(0.05, 2 * Math.sqrt(t.area) / L);
      for (let di = 0; di < dets.length; di++) {
        const d = dets[di];
        const dist = Math.hypot((t.x - d.x) * ax, (t.y - d.y) * ay);
        if (dist < g) pairs.push([dist, ti, di]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const tUsed = new Set(), dUsed = new Set();
    for (const [, ti, di] of pairs) {
      if (tUsed.has(ti) || dUsed.has(di)) continue;
      tUsed.add(ti); dUsed.add(di);
      hit(this.tracks[ti], dets[di], f);
    }
    const removed = [];
    const killMs = f.killMs || 450;
    this.tracks = this.tracks.filter((t, ti) => {
      if (tUsed.has(ti)) return true;
      if (!f.freeze) { t.frames++; t.missMs += (f.dt || 0.04) * 1000; }
      if (t.missMs > killMs) { removed.push(t); return false; }
      return true;
    });
    if (f.allowNew) {
      for (let di = 0; di < dets.length; di++) {
        if (dUsed.has(di)) continue;
        const d = dets[di];
        if (d.big || d.area > f.maxNewArea) continue;
        this.tracks.push(newTrack(this.nextId++, d, f));
      }
    }
    // a noisy frame can spawn dozens of points; keep the ones with the most history
    if (this.tracks.length > 40) {
      this.tracks.sort((a, b) => b.hits - a.hits);
      removed.push(...this.tracks.splice(40));
    }
    return removed;
  };

  function newTrack(id, d, f) {
    const rot = f.rot ? f.rot.slice() : [0, 0, 0];
    return {
      id, x: d.x, y: d.y, v: d.v, d: d.d, area: d.area, big: d.big, r: d.r, g: d.g, b: d.b,
      hits: 1, frames: 1, missMs: 0, bornT: f.t, lastT: f.t,
      minX: d.x, maxX: d.x, minY: d.y, maxY: d.y,
      rmin: rot.slice(), rmax: rot.slice(),
      status: 'new', flash: null, flashTries: 0, lastFlashT: -1e9,
      magPeak: null, magProbed: false, score: 0, sig: {}, visible: false,
    };
  }

  function hit(t, d, f) {
    t.x += 0.6 * (d.x - t.x); t.y += 0.6 * (d.y - t.y);
    t.rx = d.x; t.ry = d.y;                       // this frame's position, unsmoothed (no lag while moving)
    t.v += 0.5 * (d.v - t.v); t.d += 0.5 * (d.d - t.d); t.area += 0.5 * (d.area - t.area);
    t.r += 0.3 * (d.r - t.r); t.g += 0.3 * (d.g - t.g); t.b += 0.3 * (d.b - t.b);
    t.big = d.big;
    t.hits++; if (!f.freeze) t.frames++;
    t.missMs = 0; t.lastT = f.t;
    if (d.x < t.minX) t.minX = d.x; if (d.x > t.maxX) t.maxX = d.x;
    if (d.y < t.minY) t.minY = d.y; if (d.y > t.maxY) t.maxY = d.y;
    if (f.rot) for (let k = 0; k < 3; k++) {
      if (f.rot[k] < t.rmin[k]) t.rmin[k] = f.rot[k];
      if (f.rot[k] > t.rmax[k]) t.rmax[k] = f.rot[k];
    }
  }

  /* How far the viewing angle changed while this point kept shining.
   * gyro: how much the phone turned (from the gyroscope) while the point was seen.
   * disp: how far the point travelled across the frame, converted with the camera's field of view.
   * Either one means "looked at from a different angle"; a lens keeps shining, glare doesn't. */
  function spans(t, w, h, fovDeg) {
    const L = Math.max(w, h);
    const disp = Math.max((t.maxX - t.minX) * w / L, (t.maxY - t.minY) * h / L) * fovDeg;
    const gyro = Math.max(t.rmax[0] - t.rmin[0], t.rmax[1] - t.rmin[1], t.rmax[2] - t.rmin[2]);
    return { disp, gyro };
  }

  /* ---------- "does the shine stick to its object?" ----------
   * A lens sits in the object: as the phone moves, the glint moves exactly with the surface
   * around it. A reflection on something shiny (a screw, a knob, glossy plastic, glass) is where
   * the surface happens to face the flash: move sideways and it slides across the surface.
   * anchor follows the textured ring around the point (the glint itself is left out) with block
   * matching on the brightness image of the last detect() call, and reports how far the surface
   * and the shine have drifted apart (slip, in px of the analysed frame). */
  const AR = 14, AI = 4, AS = 2;               // ring half-size, left-out core, sample step (px)
  function samplePatch(V, w, h, cx, cy) {
    const x0 = Math.round(cx), y0 = Math.round(cy);
    if (x0 - AR < 0 || y0 - AR < 0 || x0 + AR >= w || y0 + AR >= h) return null;
    const out = [];
    let sum = 0;
    for (let dy = -AR; dy <= AR; dy += AS) for (let dx = -AR; dx <= AR; dx += AS) {
      if (Math.abs(dx) <= AI && Math.abs(dy) <= AI) continue;
      const v = V[(y0 + dy) * w + x0 + dx]; out.push(v); sum += v;
    }
    const m = sum / out.length;
    let ss = 0;
    for (let i = 0; i < out.length; i++) { out[i] -= m; ss += out[i] * out[i]; }
    return { v: out, std: Math.sqrt(ss / out.length) };
  }
  function patchCost(V, w, h, cx, cy, ref) {
    const x0 = Math.round(cx), y0 = Math.round(cy);
    if (x0 - AR < 0 || y0 - AR < 0 || x0 + AR >= w || y0 + AR >= h) return Infinity;
    let sum = 0, n = 0;
    for (let dy = -AR; dy <= AR; dy += AS) for (let dx = -AR; dx <= AR; dx += AS) {
      if (Math.abs(dx) <= AI && Math.abs(dy) <= AI) continue;
      sum += V[(y0 + dy) * w + x0 + dx]; n++;
    }
    const m = sum / n, r = ref.v;
    let c = 0, i = 0;
    for (let dy = -AR; dy <= AR; dy += AS) for (let dx = -AR; dx <= AR; dx += AS) {
      if (Math.abs(dx) <= AI && Math.abs(dy) <= AI) continue;
      c += Math.abs(V[(y0 + dy) * w + x0 + dx] - m - r[i++]);
    }
    return c / n;
  }
  /* state = anchor(null, V, w, h, px, py) starts; then anchor(state, V, w, h, px, py) each frame.
   * state.flat: too little texture to tell; state.slip: surface-to-shine drift in px. */
  function anchor(A, V, w, h, px, py) {
    if (!A) {
      const ref = samplePatch(V, w, h, px, py);
      if (!ref) return null;
      return { cx: px, cy: py, lx: px, ly: py, ref, flat: ref.std < 7, slip: 0, path: 0, n: 0 };
    }
    if (A.flat) {                                     // no texture yet (often a dim edge of the picture):
      const ref = samplePatch(V, w, h, px, py);       // try again where the point is now
      return ref && ref.std >= 7 ? { cx: px, cy: py, lx: px, ly: py, ref, flat: false, slip: 0, path: 0, n: 0 } : A;
    }
    const predX = A.cx + (px - A.lx), predY = A.cy + (py - A.ly);
    // near the edge of the picture part of the search falls outside it and a wrong match can win:
    // no measurement there, the surface is assumed to move with the point
    if (predX - AR - 7 < 0 || predY - AR - 7 < 0 || predX + AR + 7 >= w || predY + AR + 7 >= h) {
      A.cx = predX; A.cy = predY; A.lx = px; A.ly = py;
      return A;
    }
    let best = Infinity, bx = 0, by = 0;
    for (let oy = -6; oy <= 6; oy++) for (let ox = -6; ox <= 6; ox++) {
      const c = patchCost(V, w, h, predX + ox, predY + oy, A.ref);
      if (c < best || (c === best && ox * ox + oy * oy < bx * bx + by * by)) { best = c; bx = ox; by = oy; }
    }
    if (best === Infinity) return A;                  // the ring left the frame: keep the last verdict
    A.path += Math.hypot(px - A.lx, py - A.ly);
    A.cx = predX + bx; A.cy = predY + by; A.lx = px; A.ly = py; A.n++;
    if (A.n % 15 === 0) {                             // follow slow changes in how the surface looks,
      const nr = samplePatch(V, w, h, A.cx, A.cy);    // rarely, so rounding doesn't add up to a drift
      if (nr && nr.std >= 7) A.ref = nr;
    }
    A.slip = Math.hypot(A.cx - px, A.cy - py);
    return A;
  }
  const lastV = () => ({ V, w: W, h: H });

  const api = { detect, Tracker, spans, anchor, lastV, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TGDetector = api;
})(typeof window !== 'undefined' ? window : globalThis);
