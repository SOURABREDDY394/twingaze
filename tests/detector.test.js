/* Run: node tests/detector.test.js
 * Synthetic frames with known contents, checked against what the detector reports. */
'use strict';
const assert = require('assert');
const { detect, Tracker, spans, anchor } = require('../js/detector.js');

const W = 270, H = 480;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function frame({ glints = [], lamp = null, window: win = null, noise = 10, base = 28 } = {}) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let v = base + 12 * Math.sin(x / 23) * Math.cos(y / 31) + (rnd() - 0.5) * 2 * noise;
    if (lamp && Math.hypot(x - lamp.x, y - lamp.y) < lamp.r) v = 250;
    if (win && x > win.x && y > win.y0 && y < win.y1) v = 235;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  for (const g of glints) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const X = Math.round(g.x) + x, Y = Math.round(g.y) + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const a = Math.exp(-(x * x + y * y) / (2 * g.s * g.s));
      const i = (Y * W + X) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.max(px[i + c], (g.col ? g.col[c] : g.v) * a);
    }
  }
  return px;
}

const near = (dets, x, y, r = 4) => dets.find(d => Math.hypot(d.px - x, d.py - y) < r);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  ', name); };

test('finds a small lens glint on a dark, noisy wall', () => {
  const { dets } = detect(frame({ glints: [{ x: 140, y: 200, v: 255, s: 0.9 }] }), W, H);
  const g = near(dets, 140, 200);
  assert(g, 'glint not found: ' + JSON.stringify(dets.slice(0, 3)));
  assert(!g.big && g.area < 30, 'glint should be small, got area ' + g.area);
  assert.strictEqual(dets.length, 1, 'noise produced extra points: ' + dets.length);
});

test('ignores a big lamp and the edge of a bright window', () => {
  const { dets } = detect(frame({ lamp: { x: 80, y: 100, r: 26 }, window: { x: 200, y0: 250, y1: 420 } }), W, H);
  const small = dets.filter(d => !d.big && d.area < 60);
  assert.strictEqual(small.length, 0, 'lamp/window leaked as small points: ' + JSON.stringify(small));
});

test('still finds the glint when a lamp is in the same frame', () => {
  const { dets } = detect(frame({ lamp: { x: 80, y: 100, r: 26 }, glints: [{ x: 190, y: 330, v: 250, s: 1 }] }), W, H);
  assert(near(dets, 190, 330), 'glint lost next to a lamp');
});

test('night-vision settings pick up a dim purple IR glow', () => {
  const { dets } = detect(frame({ glints: [{ x: 60, y: 60, col: [150, 70, 170], s: 1.3 }] }), W, H,
    { minPeak: 70, minContrast: 28, minRatio: 1.6 });
  const g = near(dets, 60, 60);
  assert(g, 'IR glow not found');
  assert(Math.min(g.r, g.b) - g.g > 20, 'glow colour should read purple');
});

test('tracks one point across frames while the phone turns, then drops it', () => {
  const tr = new Tracker();
  let t = 0, id = null;
  for (let k = 0; k < 30; k++) {
    t += 40;
    const x = 100 + k * 2.2;                       // drifts right as the phone pans
    const { dets } = detect(frame({ glints: [{ x, y: 240, v: 255, s: 0.9 }] }), W, H);
    tr.update(dets, { t, dt: 0.04, w: W, h: H, rot: [0, k * 0.6, 0], rotRate: 15, allowNew: true, maxNewArea: 60 });
    assert.strictEqual(tr.tracks.length, 1, 'frame ' + k + ': expected one track, got ' + tr.tracks.length);
    if (id === null) id = tr.tracks[0].id; else assert.strictEqual(tr.tracks[0].id, id, 'track identity changed');
  }
  const s = spans(tr.tracks[0], W, H, 66);
  assert(s.gyro > 16 && s.gyro < 19, 'gyro span ' + s.gyro);
  // 29 steps x 2.2 px = 64 px of a 480 px long side, x 66 deg field of view = 8.8 deg
  assert(Math.abs(s.disp - 8.8) < 0.8, 'image-motion span ' + s.disp);
  let removed = [];
  for (let k = 0; k < 15; k++) { t += 40; removed = removed.concat(tr.update([], { t, dt: 0.04, w: W, h: H, rot: null, allowNew: true, maxNewArea: 60 })); }
  assert.strictEqual(removed.length, 1, 'track should be dropped once it is gone');
});

test('a frozen tracker keeps points alive while the flash is off', () => {
  const tr = new Tracker();
  const { dets } = detect(frame({ glints: [{ x: 120, y: 120, v: 255, s: 0.9 }] }), W, H);
  for (let k = 0; k < 5; k++) tr.update(dets, { t: k * 40, dt: 0.04, w: W, h: H, allowNew: true, maxNewArea: 60 });
  for (let k = 0; k < 40; k++) tr.update([], { t: 200 + k * 40, dt: 0.04, w: W, h: H, freeze: true, allowNew: false, maxNewArea: 60 });
  assert.strictEqual(tr.tracks.length, 1);
});

test('processes a frame fast enough for live video', () => {
  const px = frame({ glints: [{ x: 140, y: 200, v: 255, s: 0.9 }], lamp: { x: 80, y: 100, r: 26 } });
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 50; k++) detect(px, W, H);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  console.log('      ' + ms.toFixed(2) + ' ms per 270x480 frame');
  assert(ms < 25, 'too slow: ' + ms + ' ms');
});

/* ---------- does the shine stick to its object? ---------- */
function scene(offX, dot, flat) {                // brightness image: a textured surface shifted by offX, plus a glint
  const V = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x - offX;
    V[y * W + x] = flat ? 60 : 40 + ((Math.floor(u / 5) * 7 + Math.floor(y / 5) * 13) % 11) * 12;
  }
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) V[(dot.y + y) * W + dot.x + x] = 255;
  return V;
}

test('a lens moves with its surface: it stays anchored', () => {
  let A = null;
  for (let k = 0; k <= 12; k++) A = anchor(A, scene(k * 2, { x: 120 + k * 2, y: 200 }), W, H, 120 + k * 2, 200);
  assert(!A.flat, 'textured');
  assert(A.slip <= 2, 'slip ' + A.slip);
});

test('a reflection slides over the surface: the drift is measured', () => {
  let A = null;
  for (let k = 0; k <= 12; k++) A = anchor(A, scene(k * 2, { x: 120, y: 200 }), W, H, 120, 200);
  assert(A.slip >= 18, 'slip ' + A.slip);          // the surface moved 24 px under a glint that stayed put
});

test('a lens leaving the edge of the picture is not called a slide', () => {
  let A = null;
  for (let k = 0; k <= 31; k++) A = anchor(A, scene(k * 2, { x: 200 + k * 2, y: 200 }), W, H, 200 + k * 2, 200);   // ends 8 px from the edge
  assert(A.slip <= 2, 'slip ' + A.slip);
});

test('a surface that shows its texture later still gets measured', () => {
  let A = anchor(null, scene(0, { x: 120, y: 200 }, true), W, H, 120, 200);   // blank at first
  assert(A.flat);
  for (let k = 0; k <= 12; k++) A = anchor(A, scene(k * 2, { x: 120, y: 200 }), W, H, 120, 200);
  assert(!A.flat && A.slip >= 18, 'slip ' + A.slip);
});

test('a blank surface gives no verdict', () => {
  const A = anchor(null, scene(0, { x: 120, y: 200 }, true), W, H, 120, 200);
  assert(A.flat);
});

console.log(`\n${passed} passed`);
