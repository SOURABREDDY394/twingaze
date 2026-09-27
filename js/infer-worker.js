/* TwinGaze · infer-worker.js
 * Runs both neural networks off the main thread, so the camera, the glint tests, the voice and
 * the screen never wait for a model (on a phone without WebGPU one check takes a few hundred ms).
 * The page sends a downscaled ImageBitmap of the frame; this worker letterboxes it, runs the
 * model (WebGPU when the phone has it, else WebAssembly) and sends back only the boxes. */
'use strict';

let RT = null;                    // the ONNX runtime (ort.min.js defines a global named ort)
const models = {};               // name -> { session, meta, keep, size, ep, canvas, ctx }
let queue = Promise.resolve();    // one session at a time (the GPU backend needs it)
const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

function initOrt(base) {
  if (RT) return;
  importScripts(base + 'vendor/ort/ort.min.js');
  RT = self.ort;
  RT.env.wasm.wasmPaths = base + 'vendor/ort/';
  RT.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
}

async function load(msg) {
  initOrt(msg.base);
  const meta = msg.meta, size = meta.imgsz || 416;
  const eps = self.navigator && navigator.gpu && msg.gpu !== false ? ['webgpu', 'wasm'] : ['wasm'];
  let session = null, ep = '', lastErr = null;
  for (const e of eps) {
    try { session = await serial(() => RT.InferenceSession.create(msg.url, { executionProviders: [e], graphOptimizationLevel: 'all' })); ep = e; break; }
    catch (err) { lastErr = err; }
  }
  if (!session) throw lastErr || new Error('no execution provider');
  const canvas = new OffscreenCanvas(size, size);
  const m = models[msg.name] = { session, meta, size, ep, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }),
    keep: Object.keys(meta.classes).map(Number).sort((a, b) => a - b) };
  const t0 = performance.now();
  await run(m, null, size, size);                                   // warm-up
  return { ep, warmMs: performance.now() - t0 };
}

async function run(m, bitmap, sw, sh) {
  const S = m.size, c = m.ctx;
  const k = Math.min(S / sw, S / sh), dw = sw * k, dh = sh * k, ox = (S - dw) / 2, oy = (S - dh) / 2;
  c.fillStyle = 'rgb(114,114,114)';
  c.fillRect(0, 0, S, S);
  if (bitmap) c.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, ox, oy, dw, dh);
  const px = c.getImageData(0, 0, S, S).data;
  const n = S * S, input = new Float32Array(3 * n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    input[i] = px[p] / 255; input[n + i] = px[p + 1] / 255; input[2 * n + i] = px[p + 2] / 255;
  }
  const feeds = {};
  feeds[m.session.inputNames[0]] = new RT.Tensor('float32', input, [1, 3, S, S]);
  const out = (await serial(() => m.session.run(feeds)))[m.session.outputNames[0]];
  const count = out.dims[2], d = out.data, boxes = [];
  const classes = m.meta.classes, base = m.meta.threshold || 0.3;
  for (let a = 0; a < count; a++) {
    let best = 0, bc = -1;
    for (const ci of m.keep) { const v = d[(4 + ci) * count + a]; if (v > best) { best = v; bc = ci; } }
    if (bc < 0 || best < (classes[bc].threshold || base)) continue;
    const cx = d[a], cy = d[count + a], w = d[2 * count + a], h = d[3 * count + a];
    boxes.push({ x: (cx - ox) / dw, y: (cy - oy) / dh, w: w / dw, h: h / dh, score: best, cls: bc,
      label: classes[bc].label, spot: classes[bc].spot || null });
  }
  return nms(boxes, 0.45, m.meta.agnostic).slice(0, 20);
}

function iou(a, b) {
  const iw = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2));
  const ih = Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}
function nms(boxes, thr, agnostic) {
  boxes.sort((p, q) => q.score - p.score);
  const out = [];
  for (const b of boxes) if (!out.some(o => (agnostic || o.label === b.label) && iou(o, b) > thr)) out.push(b);
  return out;
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const r = await load(msg);
      self.postMessage({ id: msg.id, ok: true, ep: r.ep, warmMs: r.warmMs });
    } else if (msg.type === 'detect') {
      const m = models[msg.name];
      if (!m) throw new Error('model not loaded');
      const t0 = performance.now();
      const boxes = await run(m, msg.bitmap, msg.sw, msg.sh);
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({ id: msg.id, ok: true, boxes, ms: performance.now() - t0 });
    }
  } catch (err) {
    if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
