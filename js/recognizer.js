/* TwinGaze · recognizer.js
 * On-phone object detection with ONNX Runtime Web (GPU via WebGPU when available, else CPU).
 * Two models share one runtime:
 *   camera  - trained for this app: CCTV / dome / bullet / security cameras, and smoke detectors
 *   objects - general room objects (Open Images): people, clocks, TVs, frames, mirrors, sockets...
 * Each model comes with a JSON file: input size, thresholds, and which classes to report. */
(function (root) {
  'use strict';

  const BASE = (document.currentScript && document.currentScript.src || location.href).replace(/js\/recognizer\.js.*$/, '');
  let ortLoading = null;

  /* Both models run in a worker (js/infer-worker.js) when the browser allows it, so a slow check
   * never freezes the camera loop. The main-thread path below stays as the fallback. */
  const canWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function'
    && !/[?&]noworker\b/.test(location.search);
  let worker = null, wid = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker || !canWorker) return worker;
    try {
      worker = new Worker(BASE + 'js/infer-worker.js');
      worker.onmessage = e => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
      worker.onerror = () => { for (const w of waiting.values()) w({ ok: false, error: 'worker failed' }); waiting.clear(); };
    } catch (e) { worker = null; }
    return worker;
  }
  const ask = (msg, transfer) => new Promise(res => { msg.id = ++wid; waiting.set(msg.id, res); worker.postMessage(msg, transfer || []); });

  /* The GPU backend runs one session at a time: every create/run of either model goes
   * through this queue, so the camera model and the objects model take turns. */
  let queue = Promise.resolve();
  function serial(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  function loadOrt() {
    if (!ortLoading) {
      ortLoading = new Promise((res, rej) => {
        if (root.ort) return res(root.ort);
        const s = document.createElement('script');
        s.src = BASE + 'vendor/ort/ort.min.js';
        s.onload = () => {
          const ort = root.ort;
          ort.env.wasm.wasmPaths = BASE + 'vendor/ort/';
          ort.env.wasm.numThreads = root.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
          res(ort);
        };
        s.onerror = () => rej(new Error('could not load the ONNX runtime'));
        document.head.appendChild(s);
      });
    }
    return ortLoading;
  }

  function Model(name) {
    this.name = name;
    this.ready = false; this.loading = null; this.error = null;
    this.session = null; this.meta = null; this.ep = ''; this.size = 416;
    this.busy = false; this.lastMs = 0; this.avgMs = 0; this.runs = 0;
    this.keep = null;                 // class indices worth reporting
  }

  Model.prototype.load = function () {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const meta = await (await fetch(BASE + 'models/' + this.name + '.json')).json();
        this.meta = meta;
        this.size = meta.imgsz || 416;
        this.keep = Object.keys(meta.classes).map(Number).sort((a, b) => a - b);
        if (getWorker()) {
          const r = await ask({ type: 'load', name: this.name, base: BASE, url: BASE + 'models/' + meta.file, meta });
          if (r.ok) { this.ep = r.ep; this.inWorker = true; this.avgMs = r.warmMs; this.ready = true; return true; }
          console.warn('model worker failed, running on the page instead:', r.error);
        }
        const ort = await loadOrt();
        const url = BASE + 'models/' + meta.file;
        const eps = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
        let lastErr = null;
        for (const ep of eps) {
          try {
            this.session = await serial(() => ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: 'all' }));
            this.ep = ep;
            break;
          } catch (e) { lastErr = e; this.session = null; }
        }
        if (!this.session) throw lastErr || new Error('no execution provider');
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvas.height = this.size;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        await this.detect(this.canvas, this.size, this.size);          // warm-up
        this.ready = true;
        return true;
      } catch (e) {
        this.error = e;
        return false;
      }
    })();
    return this.loading;
  };

  /* src: video / canvas / image. Returns [{x, y, w, h, score, cls, label, spot}], boxes normalised
   * to the source (x, y = centre). crop {x, y, w, h} (source pixels): look at that part only, at the
   * source's full resolution (a zoomed look for small, far cameras); boxes are then normalised to the crop. */
  Model.prototype.detect = async function (src, sw, sh, crop) {
    const C = crop || { x: 0, y: 0, w: sw, h: sh };
    if (this.inWorker) return this.detectInWorker(src, C);
    if (!this.session || this.busy) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      const S = this.size, c = this.ctx;
      const k = Math.min(S / C.w, S / C.h), dw = C.w * k, dh = C.h * k, ox = (S - dw) / 2, oy = (S - dh) / 2;
      c.fillStyle = 'rgb(114,114,114)';
      c.fillRect(0, 0, S, S);
      c.drawImage(src, C.x, C.y, C.w, C.h, ox, oy, dw, dh);
      const px = c.getImageData(0, 0, S, S).data;
      const n = S * S, input = new Float32Array(3 * n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        input[i] = px[p] / 255; input[n + i] = px[p + 1] / 255; input[2 * n + i] = px[p + 2] / 255;
      }
      const ort = root.ort;
      const feeds = {};
      feeds[this.session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, S, S]);
      const out = (await serial(() => this.session.run(feeds)))[this.session.outputNames[0]];
      const count = out.dims[2], d = out.data, boxes = [];
      const classes = this.meta.classes, base = this.meta.threshold || 0.3;
      for (let a = 0; a < count; a++) {
        let best = 0, bc = -1;
        for (const ci of this.keep) {
          const v = d[(4 + ci) * count + a];
          if (v > best) { best = v; bc = ci; }
        }
        if (bc < 0 || best < (classes[bc].threshold || base)) continue;
        const cx = d[a], cy = d[count + a], w = d[2 * count + a], h = d[3 * count + a];
        boxes.push({ x: (cx - ox) / dw, y: (cy - oy) / dh, w: w / dw, h: h / dh, score: best, cls: bc,
          label: classes[bc].label, spot: classes[bc].spot || null });
      }
      const ms = performance.now() - t0;
      this.lastMs = ms; this.runs++;
      this.avgMs = this.avgMs ? this.avgMs * 0.8 + ms * 0.2 : ms;
      return nms(boxes, 0.45, this.meta.agnostic).slice(0, 20);
    } finally {
      this.busy = false;
    }
  };

  /* the frame goes to the worker as a small ImageBitmap (long side = the model's input size) */
  Model.prototype.detectInWorker = async function (src, C) {
    if (this.busy) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      const k = Math.min(1, this.size / Math.max(C.w, C.h));
      const bitmap = await createImageBitmap(src, Math.round(C.x), Math.round(C.y), Math.max(1, Math.round(C.w)), Math.max(1, Math.round(C.h)),
        { resizeWidth: Math.max(1, Math.round(C.w * k)), resizeHeight: Math.max(1, Math.round(C.h * k)), resizeQuality: 'medium' });
      const r = await ask({ type: 'detect', name: this.name, bitmap, sw: bitmap.width, sh: bitmap.height }, [bitmap]);
      if (!r.ok) throw new Error(r.error);
      const ms = performance.now() - t0;
      this.lastMs = ms; this.runs++;
      this.avgMs = this.avgMs ? this.avgMs * 0.8 + ms * 0.2 : ms;
      return r.boxes;
    } finally {
      this.busy = false;
    }
  };

  function iou(a, b) {
    const ax0 = a.x - a.w / 2, ax1 = a.x + a.w / 2, ay0 = a.y - a.h / 2, ay1 = a.y + a.h / 2;
    const bx0 = b.x - b.w / 2, bx1 = b.x + b.w / 2, by0 = b.y - b.h / 2, by1 = b.y + b.h / 2;
    const iw = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)), ih = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    const inter = iw * ih;
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  }
  // per label (a clock never hides a person), unless the model's classes exclude each other:
  // one object can't be both a camera and a smoke detector, so the stronger label wins
  function nms(boxes, thr, agnostic) {
    boxes.sort((p, q) => q.score - p.score);
    const out = [];
    for (const b of boxes) if (!out.some(o => (agnostic || o.label === b.label) && iou(o, b) > thr)) out.push(b);
    return out;
  }

  const camera = new Model('camera-detector');
  camera.iou = iou;
  root.TGModels = { camera, objects: new Model('objects'), iou };
  root.TGRecognizer = camera;
})(window);
