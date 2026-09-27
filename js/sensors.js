/* TwinGaze · sensors.js
 * Camera + flash, gyroscope, magnetometer, screen wake lock.
 * Every capability is detected at runtime; nothing is assumed or faked. */
(function (root) {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    const t0 = performance.now();
    while (!fn()) { if (performance.now() - t0 > ms) return false; await sleep(30); }
    return true;
  }

  /* ---------- camera + flash ---------- */
  const Camera = {
    stream: null, track: null, caps: {}, label: '', hasTorch: false, hasExposure: false, torchOn: false,

    async start(video, opt = {}) {
      this.stop();
      const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
      const v = opt.deviceId
        ? Object.assign({}, base, { deviceId: { exact: opt.deviceId } })
        : Object.assign({}, base, { facingMode: { ideal: opt.facing || 'environment' } });
      this.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
      this.track = this.stream.getVideoTracks()[0];
      video.removeAttribute('src');
      video.srcObject = this.stream;
      video.muted = true;
      await video.play().catch(() => {});
      await waitFor(() => video.videoWidth > 0, 4000);
      this.label = this.track.label || 'camera';
      this.deviceId = this.settings().deviceId || null;
      this.refreshCaps();
      if (!this.hasTorch) { await sleep(500); this.refreshCaps(); }   // some phones report the flash late
      return this;
    },

    refreshCaps() {
      try { this.caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; }
      catch (e) { this.caps = {}; }
      this.hasTorch = !!this.caps.torch;
      const ec = this.caps.exposureCompensation;
      this.hasExposure = !!(ec && ec.max > ec.min);
    },

    settings() {
      try { return this.track ? this.track.getSettings() : {}; } catch (e) { return {}; }
    },

    async setTorch(on) {
      if (!this.track || !this.hasTorch) return false;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
        this.torchOn = !!on;
        return true;
      } catch (e) { return false; }
    },

    /* Darker exposure makes a lens glint stand out more against the room. */
    async setExposure(ev) {
      const c = this.caps.exposureCompensation;
      if (!this.hasExposure) return false;
      const step = c.step || 0.1;
      const v = Math.round(Math.max(c.min, Math.min(c.max, ev)) / step) * step;
      try { await this.track.applyConstraints({ advanced: [{ exposureCompensation: v }] }); return true; }
      catch (e) { return false; }
    },

    async videoInputs() {
      try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); }
      catch (e) { return []; }
    },

    /* Multi-camera phones sometimes open the ultra-wide first, which has no flash.
     * Try the other rear cameras until one can switch the flash. */
    async findTorchCamera(video) {
      if (this.hasTorch) return true;
      const cur = this.settings().deviceId;
      const devs = (await this.videoInputs()).filter(d => d.deviceId && d.deviceId !== cur && !/front|user|selfie/i.test(d.label));
      for (const d of devs.slice(0, 4)) {
        try { await this.start(video, { deviceId: d.deviceId }); if (this.hasTorch) return true; } catch (e) { /* next */ }
      }
      try { await this.start(video, cur ? { deviceId: cur } : { facing: 'environment' }); } catch (e) { /* keep whatever is open */ }
      return false;
    },

    async next(video) {
      const devs = await this.videoInputs();
      if (devs.length < 2) return false;
      const cur = this.settings().deviceId;
      const i = devs.findIndex(d => d.deviceId === cur);
      await this.start(video, { deviceId: devs[(i + 1) % devs.length].deviceId });
      return true;
    },

    stop() {
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null; this.track = null; this.torchOn = false; this.hasTorch = false; this.hasExposure = false; this.caps = {};
    },
  };

  /* ---------- gyroscope (via devicemotion) ----------
   * rot is the phone's turn integrated per axis, signed, in degrees. Hand shake cancels out;
   * a deliberate turn adds up. The detector compares it across the time a point stays lit. */
  const Motion = {
    ok: false, rot: [0, 0, 0], rate: 0, lastT: 0, hist: [],
    async start() {
      if (typeof DeviceMotionEvent === 'undefined') return false;
      window.removeEventListener('devicemotion', onMotion);
      window.addEventListener('devicemotion', onMotion);            // Android sends events without asking
      if (typeof DeviceMotionEvent.requestPermission === 'function') {        // iOS (and some browsers) ask first
        try { return await DeviceMotionEvent.requestPermission() === 'granted'; } catch (e) { return false; }
      }
      return true;
    },
    stop() { window.removeEventListener('devicemotion', onMotion); this.ok = false; this.rate = 0; this.lastT = 0; this.hist = []; },
    /* degrees the phone turned in the last `ms` */
    turnedWithin(ms) {
      const now = performance.now();
      const old = this.hist.find(h => now - h.t <= ms);
      if (!old) return 0;
      return Math.hypot(this.rot[0] - old.r[0], this.rot[1] - old.r[1], this.rot[2] - old.r[2]);
    },
  };
  function onMotion(e) {
    const rr = e.rotationRate;
    if (!rr || rr.alpha == null) return;
    const now = performance.now();
    const dt = Motion.lastT ? Math.min(0.1, (now - Motion.lastT) / 1000) : 0.016;
    Motion.lastT = now;
    Motion.rot[0] += rr.beta * dt;
    Motion.rot[1] += rr.gamma * dt;
    Motion.rot[2] += rr.alpha * dt;
    Motion.rate = Math.hypot(rr.alpha, rr.beta, rr.gamma);
    Motion.ok = true;
    Motion.hist.push({ t: now, r: Motion.rot.slice() });
    while (Motion.hist.length && now - Motion.hist[0].t > 1500) Motion.hist.shift();
  }

  /* ---------- magnetometer ----------
   * Earth's field is a steady ~25-65 µT whichever way the phone points. Powered electronics
   * (a camera's board, its battery, its speaker) bend it within a few cm. We learn the room's
   * baseline, then report how far the reading moves from it.
   * Three ways to read it, best first:
   *   native      - the Android app reads the phone's magnetometer directly
   *   magnetometer - Chrome's Magnetometer (only with chrome://flags/#enable-experimental-web-platform-features)
   *   compass     - no flag needed: Chrome's compass-based orientation vs its gyroscope-only
   *                 orientation. They agree until something bends the magnetic field, which
   *                 swings the compass heading while the phone hasn't turned. The swing gives
   *                 an estimate of the field's sideways push: ~H·tan(swing), H = horizontal field. */
  const H_FIELD = 38;          // µT, horizontal part of Earth's field across most of India
  const wrap180 = a => ((a + 540) % 360) - 180;
  function qmul(a, b) {        // quaternions as [x, y, z, w]
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }

  const Mag = {
    ok: false, status: 'off', source: null, value: null, base: null, delta: 0, freeze: false, sensor: null, samples: [],
    swing: 0, yawBase: null, yawSamples: [], rate: 0, count: 0, rateT: 0,

    start() {
      if (this.sensor) return true;
      this.count = 0; this.rate = 0; this.rateT = performance.now();
      const N = root.TGNative;
      if (N && N.available) {                          // the Android app reads the sensor directly
        this.sensor = { native: true };
        this.source = 'native'; this.status = 'starting';
        N.startSensor('magnetometer', d => this.read(d.x, d.y, d.z)).then(ok => {
          if (!ok) { this.sensor = null; if (!this.startCompass()) this.status = 'none'; }
        });
        return true;
      }
      if ('Magnetometer' in root) {
        try {
          const s = new root.Magnetometer({ frequency: 20 });
          s.addEventListener('reading', () => this.read(s.x, s.y, s.z));
          s.addEventListener('error', e => {
            // blocked or broken: fall back to the compass method rather than giving up
            try { s.stop(); } catch (err) { /* already stopped */ }
            this.sensor = null; this.ok = false;
            if (!this.startCompass()) this.status = e.error && e.error.name === 'NotAllowedError' ? 'denied' : 'error';
          });
          s.start();
          this.sensor = s; this.source = 'magnetometer'; this.status = 'starting';
          return true;
        } catch (e) { /* try the compass method */ }
      }
      if (this.startCompass()) return true;
      this.status = /Android/i.test(navigator.userAgent) ? 'flag' : 'none';
      return false;
    },

    startCompass() {
      const AOS = root.AbsoluteOrientationSensor, ROS = root.RelativeOrientationSensor;
      if (!AOS || !ROS) return false;
      try {
        const a = new AOS({ frequency: 30 }), r = new ROS({ frequency: 30 });
        let qr = null;
        r.addEventListener('reading', () => { qr = r.quaternion; });
        a.addEventListener('reading', () => { if (qr && a.quaternion) this.readCompass(a.quaternion, qr); });
        const fail = e => {
          this.ok = false;
          this.status = e.error && e.error.name === 'NotAllowedError' ? 'denied' : 'none';
        };
        a.addEventListener('error', fail);
        r.addEventListener('error', fail);
        a.start(); r.start();
        this.sensor = { compass: true, a, r };
        this.source = 'compass'; this.status = 'starting';
        this.yawBase = null; this.yawSamples = [];
        return true;
      } catch (e) { return false; }
    },

    tick() {
      this.count++;
      const now = performance.now();
      if (now - this.rateT >= 1000) { this.rate = this.count * 1000 / (now - this.rateT); this.count = 0; this.rateT = now; }
    },

    read(x, y, z) {
      if (x == null) return;
      this.tick();
      const m = Math.hypot(x, y, z);
      this.value = m; this.ok = true; this.status = 'on';
      if (this.base == null) {
        this.samples.push(m);
        if (this.samples.length >= 15) {
          const s = this.samples.slice().sort((a, b) => a - b);
          this.base = s[s.length >> 1]; this.samples = [];
        }
        this.delta = 0;
        return;
      }
      this.delta = m - this.base;
      // follow slow drift, never a real spike
      if (!this.freeze && Math.abs(this.delta) < 3) this.base += 0.02 * (m - this.base);
    },

    readCompass(qa, qr) {
      this.tick();
      // the turn between the gyro-only frame and the north-referenced frame: constant while the
      // field is undisturbed, so its yaw only moves when something bends the field
      const q = qmul(qa, [-qr[0], -qr[1], -qr[2], qr[3]]);
      const yaw = Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * 180 / Math.PI;
      this.ok = true; this.status = 'on';
      if (this.yawBase == null) {
        this.yawSamples.push(yaw);
        if (this.yawSamples.length >= 20) {
          // circular mean of the first readings
          let sx = 0, sy = 0;
          for (const v of this.yawSamples) { sx += Math.cos(v * Math.PI / 180); sy += Math.sin(v * Math.PI / 180); }
          this.yawBase = Math.atan2(sy, sx) * 180 / Math.PI; this.yawSamples = [];
          this.base = H_FIELD;
        }
        this.delta = 0; this.value = H_FIELD;
        return;
      }
      const d = wrap180(yaw - this.yawBase);
      this.swing = d;
      if (!this.freeze && Math.abs(d) < 1.5) this.yawBase = wrap180(this.yawBase + 0.02 * d);   // gyro drift
      const est = H_FIELD * Math.tan(Math.min(80, Math.abs(d)) * Math.PI / 180);
      this.delta = est; this.value = H_FIELD + est;
    },

    recalibrate() { this.base = null; this.samples = []; this.delta = 0; this.yawBase = null; this.yawSamples = []; this.swing = 0; },

    stop() {
      const sn = this.sensor;
      if (sn && sn.native) root.TGNative.stopSensor('magnetometer');
      else if (sn && sn.compass) { try { sn.a.stop(); sn.r.stop(); } catch (e) { /* already stopped */ } }
      else try { sn && sn.stop(); } catch (e) { /* already stopped */ }
      this.sensor = null; this.ok = false; this.base = null; this.samples = []; this.delta = 0;
      this.yawBase = null; this.yawSamples = []; this.swing = 0; this.rate = 0;
      if (this.status === 'on' || this.status === 'starting') this.status = 'off';
    },

    describe() {
      return { native: 'phone magnetometer', magnetometer: 'Chrome magnetometer', compass: 'compass method (approximate)' }[this.source] || 'none';
    },
  };

  /* ---------- heading: which way the camera points ----------
   * Used for the room memory ("the clock is 60° to your right") and the coverage radar.
   * Source: the gyro + accelerometer orientation (Android's game rotation vector in the app,
   * Chrome's RelativeOrientationSensor on the web). Its zero is arbitrary but steady for a scan.
   * The camera looks out of the back of the phone (device -Z); that direction, turned into the
   * room's frame, gives yaw (left/right, 0-360°) and pitch (up/down). */
  const Heading = {
    ok: false, yaw: 0, pitch: 0, sensor: null, source: null,
    start() {
      if (this.sensor) return true;
      const N = root.TGNative;
      if (N && N.available) {
        this.sensor = { native: true }; this.source = 'native';
        N.startSensor('orientation', d => this.set(d.x, d.y, d.z, d.w)).then(ok => { if (!ok) { this.sensor = null; this.startWeb(); } });
        return true;
      }
      return this.startWeb();
    },
    startWeb() {
      const ROS = root.RelativeOrientationSensor;
      if (!ROS) return false;
      try {
        const s = new ROS({ frequency: 30 });
        s.addEventListener('reading', () => { const q = s.quaternion; if (q) this.set(q[0], q[1], q[2], q[3]); });
        s.addEventListener('error', () => { this.ok = false; });
        s.start();
        this.sensor = s; this.source = 'web';
        return true;
      } catch (e) { return false; }
    },
    set(x, y, z, w) {
      const vx = -2 * (x * z + w * y), vy = -2 * (y * z - w * x), vz = -(1 - 2 * (x * x + y * y));
      this.yaw = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
      this.pitch = Math.asin(Math.max(-1, Math.min(1, vz))) * 180 / Math.PI;
      this.ok = true;
    },
    stop() {
      if (this.sensor && this.sensor.native) root.TGNative.stopSensor('orientation');
      else try { this.sensor && this.sensor.stop(); } catch (e) { /* already stopped */ }
      this.sensor = null; this.ok = false;
    },
  };

  /* ---------- ambient light sensor (lux), same Chrome flag as the magnetometer ---------- */
  const Light = {
    ok: false, lux: null, sensor: null,
    start() {
      if (this.sensor) return true;
      const N = root.TGNative;
      if (N && N.available) {
        this.sensor = { native: true };
        N.startSensor('light', d => { this.lux = d.lux; this.ok = true; });
        return true;
      }
      if (!('AmbientLightSensor' in root)) return false;
      try {
        const s = new root.AmbientLightSensor({ frequency: 5 });
        s.addEventListener('reading', () => { this.lux = s.illuminance; this.ok = true; });
        s.addEventListener('error', () => { this.ok = false; });
        s.start();
        this.sensor = s;
        return true;
      } catch (e) { return false; }
    },
    stop() {
      if (this.sensor && this.sensor.native) root.TGNative.stopSensor('light');
      else try { this.sensor && this.sensor.stop(); } catch (e) { /* already stopped */ }
      this.sensor = null; this.ok = false; this.lux = null;
    },
  };

  /* ---------- keep the screen on while scanning ---------- */
  const Wake = {
    lock: null,
    async on() {
      if (root.TGNative && root.TGNative.available) { root.TGNative.keepAwake(true); this.lock = { native: true }; return true; }
      try { if ('wakeLock' in navigator) this.lock = await navigator.wakeLock.request('screen'); } catch (e) { this.lock = null; }
      return !!this.lock;
    },
    off() {
      if (this.lock && this.lock.native) root.TGNative.keepAwake(false);
      else try { this.lock && this.lock.release(); } catch (e) { /* released */ }
      this.lock = null;
    },
  };

  root.TGSensors = { Camera, Motion, Mag, Light, Heading, Wake };
})(window);
