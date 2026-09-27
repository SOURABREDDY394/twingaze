/* TwinGaze · safety.js
 * The safety kit: trusted contacts, an SOS message with your location and what TwinGaze found,
 * a siren with the flash strobing, a fake incoming call to get out of a situation, and
 * "shake the phone to open SOS". Nothing is ever sent by itself: every message opens in your own
 * SMS or chat app for you to send. */
(function (root) {
  'use strict';

  /* ---------- trusted contacts (up to 3, kept on this phone) ---------- */
  const KEY = 'twingaze-contacts';
  const cleanNum = s => String(s || '').replace(/[^0-9+]/g, '');
  function contacts(store) {
    store = store || root.localStorage;
    try {
      const list = JSON.parse(store.getItem(KEY) || 'null');
      if (Array.isArray(list)) return list.filter(c => c && cleanNum(c.phone)).slice(0, 3);
      const old = JSON.parse(store.getItem('twingaze-tc') || '{}');          // the single contact of older versions
      return old && cleanNum(old.phone) ? [{ name: old.name || '', phone: cleanNum(old.phone) }] : [];
    } catch (e) { return []; }
  }
  function saveContacts(list, store) {
    store = store || root.localStorage;
    const clean = (list || []).map(c => ({ name: String(c.name || '').trim().slice(0, 40), phone: cleanNum(c.phone) })).filter(c => c.phone).slice(0, 3);
    try { store.setItem(KEY, JSON.stringify(clean)); } catch (e) { /* private mode */ }
    return clean;
  }

  /* ---------- the SOS message ----------
   * pos: { lat, lon, acc } or null; findings: short lines (e.g. "Hidden camera found in PG room at 1:08 am");
   * when: Date. Kept short enough for one or two SMS. */
  function sosMessage(pos, findings, when, place) {
    const t = (when || new Date()).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const parts = [`SOS: I don't feel safe${place ? ' at ' + place : ''}. Please call me now.`];
    if (pos) parts.push(`My location (${t}): https://maps.google.com/?q=${pos.lat.toFixed(6)},${pos.lon.toFixed(6)} (±${Math.round(pos.acc || 0)} m)`);
    else parts.push(`Sent ${t}. My location was unavailable.`);
    for (const f of (findings || []).slice(0, 2)) parts.push(f);
    parts.push('(TwinGaze)');
    return parts.join('\n');
  }
  /* Android opens the SMS app with every number and the text filled in; the user presses send */
  function smsUri(numbers, body) {
    const to = (numbers || []).map(cleanNum).filter(Boolean).join(',');
    return `sms:${to}?body=${encodeURIComponent(body)}`;
  }

  /* ---------- shake to open SOS ----------
   * feed(ax, ay, az, t): acceleration including gravity (m/s²) and time (ms). Three hard shakes
   * (over 2.6 g, at least 150 ms apart) within 1.6 s fire onShake. Walking, turning round in a
   * scan or putting the phone down don't come close. */
  function ShakeDetector(onShake, opt) {
    opt = opt || {};
    this.onShake = onShake;
    this.g = opt.threshold || 25.5;
    this.peaks = [];
    this.lastFire = -1e9;
  }
  ShakeDetector.prototype.feed = function (ax, ay, az, t) {
    const m = Math.hypot(ax || 0, ay || 0, az || 0);
    if (m < this.g) return false;
    const last = this.peaks[this.peaks.length - 1];
    if (last != null && t - last < 150) return false;          // the same jolt
    this.peaks.push(t);
    while (this.peaks.length && t - this.peaks[0] > 1600) this.peaks.shift();
    if (this.peaks.length >= 3 && t - this.lastFire > 4000) {
      this.peaks = []; this.lastFire = t;
      if (this.onShake) this.onShake();
      return true;
    }
    return false;
  };

  /* ---------- siren + strobe ----------
   * native: TwinNative wrapper (siren(on), torch(on)); in a browser a WebAudio siren and a
   * flashing screen only. flashEl: an element to flash red/white. */
  function Siren(native, flashEl) { this.N = native; this.el = flashEl; this.on = false; }
  Siren.prototype.start = async function () {
    if (this.on) return;
    this.on = true;
    let nativeSound = false;
    if (this.N && this.N.available) { try { nativeSound = !!(await this.N.siren(true)).ok; } catch (e) { nativeSound = false; } }
    if (!nativeSound) this.webAudio(true);
    let k = 0;
    this.timer = setInterval(() => {
      k++;
      if (this.N && this.N.available && this.torchOk !== false) this.N.torch(k % 2 === 0).then(r => { if (r && r.ok === false) this.torchOk = false; }).catch(() => { this.torchOk = false; });
      if (this.el) this.el.classList.toggle('flip', k % 2 === 0);
    }, 140);
    if (this.el) this.el.hidden = false;
  };
  Siren.prototype.stop = function () {
    if (!this.on) return;
    this.on = false;
    clearInterval(this.timer);
    if (this.N && this.N.available) { this.N.siren(false).catch(() => {}); this.N.torch(false).catch(() => {}); }
    this.webAudio(false);
    if (this.el) { this.el.hidden = true; this.el.classList.remove('flip'); }
  };
  Siren.prototype.webAudio = function (on) {
    try {
      if (!on) { if (this.ctx) { this.ctx.close(); this.ctx = null; } return; }
      const Ctx = root.AudioContext || root.webkitAudioContext;
      if (!Ctx) return;
      const c = this.ctx = new Ctx(), o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth'; g.gain.value = 0.9; o.connect(g); g.connect(c.destination);
      const t0 = c.currentTime;
      for (let i = 0; i < 600; i++) { o.frequency.setValueAtTime(960, t0 + i); o.frequency.linearRampToValueAtTime(1660, t0 + i + 0.5); o.frequency.linearRampToValueAtTime(960, t0 + i + 1); }
      o.start();
    } catch (e) { /* no audio */ }
  };

  /* ---------- fake incoming call ----------
   * ui: { ring(on), show(state: 'ringing'|'talking'|'off', name, secs) }. The call "arrives" after
   * delay seconds; the screen stays on meanwhile (the caller asks for that). */
  function FakeCall(ui) { this.ui = ui; this.state = 'off'; }
  FakeCall.prototype.schedule = function (delaySec, name) {
    this.cancel();
    this.name = name || 'Mom';
    this.state = 'waiting';
    this.wait = setTimeout(() => this.ringNow(), Math.max(0, delaySec) * 1000);
  };
  FakeCall.prototype.ringNow = function () {
    this.state = 'ringing';
    this.ui.ring(true);
    this.ui.show('ringing', this.name, 0);
    this.giveUp = setTimeout(() => { if (this.state === 'ringing') this.end(); }, 45000);   // like a real missed call
  };
  FakeCall.prototype.answer = function () {
    if (this.state !== 'ringing') return;
    this.ui.ring(false);
    this.state = 'talking';
    const t0 = Date.now();
    this.ui.show('talking', this.name, 0);
    this.tick = setInterval(() => this.ui.show('talking', this.name, Math.floor((Date.now() - t0) / 1000)), 1000);
  };
  FakeCall.prototype.end = function () {
    clearInterval(this.tick); clearTimeout(this.giveUp);
    if (this.state === 'ringing') this.ui.ring(false);
    this.state = 'off';
    this.ui.show('off', this.name, 0);
  };
  FakeCall.prototype.cancel = function () { clearTimeout(this.wait); if (this.state !== 'off') this.end(); };

  /* ---------- protection outside the app (TwinProtect plugin, Android app only) ----------
   * A service that keeps running when TwinGaze is closed: SOS on 3 power-button presses or hard shaking,
   * a fake call from its notification, and alerts for the camera / mic used with the screen off, spy apps
   * installed, and unsafe Wi-Fi. status(): { on, running, notifications, location, sms, unrestricted,
   * contacts, lastSos } */
  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const PP = isNative && (typeof cap.isPluginAvailable !== 'function' || cap.isPluginAvailable('TwinProtect'))
    ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinProtect') : cap.Plugins && cap.Plugins.TwinProtect) : null;
  const Protect = {
    available: !!PP,
    status: () => PP.status(),
    start: cfg => PP.start(cfg || {}),
    stop: () => PP.stop(),
    configure: cfg => PP.configure(cfg || {}),
    testSos: () => PP.testSos(),
    fakeCall: (delay, caller) => PP.fakeCall({ delay, caller }),
    allowBackground: () => PP.allowBackground(),
    addTile: () => PP.addTile(),
    allow: what => PP.allow({ what }),
    on: (event, cb) => PP.addListener(event, cb),
  };

  const S = { contacts, saveContacts, sosMessage, smsUri, ShakeDetector, Siren, FakeCall, cleanNum, Protect };
  root.TGSafety = S;
  if (typeof module === 'object' && module && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
