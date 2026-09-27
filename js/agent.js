/* TwinGaze · agent.js
 * The on-phone agent behind "Full room scan". A Coordinator runs the scan as a plan of phases
 * (Prepare → Radio → Survey → Inspect → Report) and hands work to specialist agents that share
 * one memory of the room:
 *   Environment  reads the light and the sensors, picks the strategy
 *   Radio        Wi-Fi camera hotspots, Bluetooth trackers, cameras on the network (in the app), in the background
 *   Scene        remembers every hiding spot the object recogniser names, with the direction it was seen in
 *   Glint        bright points under test (flash, angle), so an unfinished one can be walked back to
 *   Magnetic     jumps of the magnetic field, with the direction the phone faced
 *   Coverage     which directions of the room have been swept (orientation sensor), and the ceiling
 *   Navigator    turns the memory into "turn right 60° to the clock"
 *   Report       weighs everything into a risk level, with the reasons
 * The agents are rules, not a chatbot: deterministic, fast, offline, and every decision is written
 * to the trace with its reason. The camera, flash, glint and recogniser work stays in app.js; when a
 * glint or a camera is in view, that guidance always wins over the Navigator. */
(function (root) {
  'use strict';

  const BINS = 12, BIN = 360 / BINS;
  const COVER_MS = 900;          // time a direction must be in view to count as swept (the object model runs every 0.7–1.4 s)
  const SURVEY_BINS = 9;         // 270° of the room
  const CEIL_MS = 1500;          // time spent looking up at the ceiling
  const CARD_WORD = { THINK: 'NOTE', TOOL: 'SCAN', SEE: 'SEEN', SAVE: 'SAVED', SYS: 'INFO', WARN: 'NOTE' };
  const PHASES = [['prepare', 'Setup'], ['radio', 'Signals'], ['survey', 'Sweep'], ['inspect', 'Check'], ['report', 'Report']];
  // how much each kind of hiding spot is worth a close look (the object recogniser's spot keys)
  const SPOT_PRI = { phone: 1.15, smoke: 1, clock: 0.95, frame: 0.85, socket: 0.85, decor: 0.8, mirror: 0.75, tv: 0.75, box: 0.7, switch: 0.7, lamp: 0.65, bulb: 0.65, fan: 0.6, hook: 0.6, shelf: 0.55 };
  const WHY = {
    phone: 'a phone can record video: check whether its camera faces the room',
    smoke: 'a favourite: ceiling-high, powered, and no one looks inside',
    clock: 'spy cameras are sold built into clocks',
    frame: 'a lens fits behind the glass',
    socket: 'USB-charger cameras plug in here and look ordinary',
    decor: 'a small hole in decor is easy to miss',
    mirror: 'check it isn\'t a two-way mirror',
    tv: 'set-top boxes and TV frames hide lenses',
    box: 'router-style boxes hide cameras with power',
    switch: 'switchboards have power and a view of the room',
    lamp: 'bulb-holder cameras screw straight into lamps',
    bulb: 'bulb-holder cameras screw straight into lamps',
    fan: 'exhaust fans have power and face the shower',
    hook: 'hook cameras face the bed or shower',
    shelf: 'bottles and boxes on shelves hide cameras',
  };

  const wrap = a => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;       // signed a − b, in −180…180
  const round10 = v => Math.max(10, Math.round(v / 10) * 10);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = s => (root.document ? root.document.querySelector(s) : null);

  /* Which way to turn to reach the nearest direction not yet swept: [dir, degrees] or null. */
  /* always sweep the same way round: natural, and no flip-flopping */
  function nextGap(cover, yaw, dir = 1) {
    let best = null;
    for (let i = 0; i < BINS; i++) {
      if (cover[i] >= COVER_MS) continue;
      const d = ((i * BIN + BIN / 2 - yaw) * dir % 360 + 360) % 360;   // how far, turning that way
      if (best == null || d < best) best = d;
    }
    return best == null ? null : [dir > 0 ? 'right' : 'left', best];
  }
  const coveredBins = cover => cover.reduce((n, v) => n + (v >= COVER_MS ? 1 : 0), 0);

  /* Best next target: unfinished glints first, then magnetic jumps, then unchecked hiding spots;
   * among equals, the one you have to turn least for. */
  function pickTarget(mem, yaw, hasHeading) {
    const c = [];
    for (const g of mem.suspects) if (!g.done) c.push({ type: 'glint', ref: g, pri: 1.3, yaw: g.yaw, pitch: g.pitch });
    for (const m of mem.mags) if (!m.done) c.push({ type: 'mag', ref: m, pri: 1.1, yaw: m.yaw, pitch: m.pitch });
    for (const s of mem.spots.values()) if (!s.done && s.ok) c.push({ type: 'spot', ref: s, pri: SPOT_PRI[s.spot] || 0.5, yaw: s.yaw, pitch: s.pitch });
    let best = null, bs = -1e9;
    for (const t of c) {
      const turn = hasHeading && t.yaw != null ? Math.abs(angDiff(t.yaw, yaw)) / 180 : 0;
      const sc = t.pri - 0.45 * turn;
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }

  /* Risk level with reasons, from what the agents found. */
  function assessRisk(m) {
    const high = [], med = [], low = [];
    if (m.cameras.length) high.push(`${m.cameras.length} camera${m.cameras.length > 1 ? 's' : ''} confirmed in the room`);
    const rHigh = m.radioHits.filter(h => h.risk === 'high'), rMed = m.radioHits.filter(h => h.risk === 'medium');
    rHigh.forEach(h => high.push(h.text));
    const poss = (m.possibles || []).length;
    if (poss) med.push(`${poss} possible lens${poss > 1 ? 'es' : ''}: passed the light tests, but nothing else confirmed them yet: check them by hand`);
    const openG = m.suspects.filter(g => !g.done).length;
    if (openG) med.push(`${openG} bright point${openG > 1 ? 's' : ''} left without a verdict`);
    const magSpots = m.mags.filter(x => !x.done).length;
    if (magSpots) med.push(`${magSpots} magnetic jump${magSpots > 1 ? 's' : ''} not looked at closely`);
    rMed.forEach(h => med.push(h.text));
    const spots = [...m.spots.values()].filter(s => s.ok);
    const unchecked = spots.filter(s => !s.done || s.how === 'skipped');
    if (unchecked.some(s => s.spot === 'phone')) med.push('A phone was in view and its camera was not checked');
    if (unchecked.length) med.push(`Not checked: ${unchecked.map(s => s.label.toLowerCase()).join(', ')}`);
    if (m.hasHeading && m.coverage < 0.6) med.push(`Only ${Math.round(m.coverage * 360)}° of the room was swept`);
    if (m.hasHeading && !m.ceiling) med.push('The ceiling wasn\'t looked at');
    if (!high.length && !med.length) {
      low.push(m.hasHeading ? `Swept ${Math.round(m.coverage * 360)}° of the room and the ceiling` : 'Swept the room');
      if (spots.length) low.push(`All ${spots.length} hiding spot${spots.length > 1 ? 's' : ''} checked`);
      low.push('No lens, camera shape, or camera signal found');
    }
    const risk = high.length ? 'high' : med.length ? 'medium' : 'low';
    return { risk, reasons: high.length ? high.concat(med) : med.length ? med : low };
  }

  const Agent = {
    io: null, s: null, runId: 0,

    /* io: { log(kind, html), say(text, opt), vib(p), heading(), radio, voice, fov } */
    init(io) { this.io = io; },

    start(o) {
      const now = performance.now();
      this.runId++;
      this.s = {
        on: true, full: !!o.full, source: o.source, room: o.room, t0: now, runId: this.runId,
        phase: 'prepare', steps: { prepare: 'now', radio: 'wait', survey: 'wait', inspect: 'wait', report: 'wait' },
        cover: new Array(BINS).fill(0), ceilMs: 0, hasHeading: false, headingSeen: false,
        spots: new Map(), suspects: [], mags: [], cameras: [], possibles: [], radioHits: [], radio: { wifi: null, ble: null, lan: null },
        target: null, dwell: 0, centerMs: 0, trace: [], goal: 'Getting ready', dirty: true,
        surveyT0: 0, surveyWall0: 0, inspectT0: 0, lastRadarT: 0, lastCardT: 0, doneSaid: false, nav: null, env: null,
        tools: 0, checked: 0, phaseT: {},
      };
      const card = $('#agentCard');
      if (card) card.hidden = false;
      if (o.source === 'file') {
        this.s.steps = { prepare: 'done', radio: 'skip', survey: 'skip', inspect: 'now', report: 'wait' };
        this.s.phase = 'inspect'; this.s.goal = 'Analysing the recording';
        this.trace('PLAN', 'Coordinator', 'Recorded video: every frame is checked for camera shapes and lens shine.');
        this.render(true);
        return;
      }
      this.trace('PLAN', 'Coordinator', o.full
        ? 'Full room scan: turn round once, look at the ceiling, then check each hiding spot. Wi-Fi and Bluetooth are scanned meanwhile.'
        : `${o.mode === 'ir' ? 'Night-vision' : 'Lens'} scan: you point, TwinGaze tests each bright spot.`);
      if (o.full) this.runRadio();
      else this.s.steps.radio = 'skip';
      this.render(true);
    },

    stop() { if (this.s) this.s.on = false; this.runId++; },

    trace(kind, who, html) {
      const s = this.s;
      if (!s) return;
      s.trace.unshift({ kind, who, html });
      if (s.trace.length > 40) s.trace.pop();
      s.dirty = true;
      if (this.io) this.io.log(kind, html);
    },

    setPhase(p, why) {
      const s = this.s;
      const i = PHASES.findIndex(x => x[0] === p);
      PHASES.forEach(([k], j) => {
        if (k === 'radio') return;                              // radio runs beside the others
        if (j < i && s.steps[k] !== 'skip') s.steps[k] = 'done';
      });
      s.steps[p] = 'now';
      s.phase = p; s.phaseT[p] = performance.now();
      if (why) this.trace('PLAN', 'Coordinator', why);
      s.dirty = true;
    },

    /* ---------- Environment agent: called once the light check is done ---------- */
    onEnv(e) {
      const s = this.s;
      if (!s || !s.on || s.source !== 'camera') return;
      s.env = e;
      const H = this.io.heading();
      s.hasHeading = !!(H && H.ok);
      const lux = e.lux != null ? `${Math.round(e.lux)} lux` : `brightness ${Math.round(e.mean)}/255`;
      this.trace('THINK', 'Environment', e.bright
        ? `Lit room (${lux}). In the light a lens only shines within 1–2 m, so you will be brought close to each hiding spot.`
        : `Dark room (${lux}). A lens shines from across the room.`);
      if (e.mode === 'lens') this.trace('THINK', 'Environment', e.torch
        ? 'Flash works: every bright spot gets the flash off/on test.'
        : 'The flash can\'t be switched here, so bright spots are judged by angle alone. On this phone, try Night vision with the lights off.');
      this.trace('THINK', 'Environment', e.mag
        ? `Magnetic sensor on (${esc(e.magSource)}): every jump is marked with the direction you faced.`
        : 'No magnetic sensor here: the other checks carry on.');
      this.trace('THINK', 'Coverage', s.hasHeading
        ? 'Orientation sensor on: TwinGaze maps where you have looked and can bring you back to anything it saw.'
        : 'No orientation sensor: no turn angles, so you are guided by what the camera sees.');
      if (s.full) {
        this.setPhase('survey', s.hasHeading ? 'Survey: turn slowly all the way round, then look up at the ceiling.' : 'Survey: sweep the room for 20 seconds, then look up at the ceiling.');
        s.surveyT0 = s.surveyWall0 = performance.now();
        s.goal = 'Map the room';
        this.io.say(this.io.voice.line('agentPlan'), { key: 'agentPlan', force: true });
      } else {
        this.setPhase('inspect');
        s.goal = 'Your scan';
      }
      this.render(true);
    },

    /* ---------- Radio agent (APK only), in the background ---------- */
    async runRadio() {
      const s = this.s, R = this.io.radio, id = this.runId;
      const live = () => this.s === s && s.on && id === this.runId;
      if (!R || !R.available) {
        s.steps.radio = 'skip';
        this.trace('RADIO', 'Radio', 'Skipped: scanning Wi-Fi and Bluetooth needs the TwinGaze Android app (browsers aren\'t allowed to).');
        return;
      }
      s.steps.radio = 'now'; s.dirty = true;
      const hit = (risk, text) => {
        s.radioHits.push({ risk, text });
        if (risk === 'high') {
          this.trace('FOUND', 'Radio', esc(text));
          this.io.say(this.io.voice.line('radioHit'), { key: 'radioHit', force: true });
          this.io.vib([150, 60, 150]);
        } else this.trace('RADIO', 'Radio', esc(text));
      };
      const denied = (what, e) => this.trace('WARN', 'Radio', `${what} skipped: ${esc(e && e.code === 'PERMISSION_DENIED' ? 'permission not given' : (e && e.message) || e)}.`);
      let conn = null, wifiRes = null, lanRes = null, lanList = null;
      try {
        this.trace('TOOL', 'Radio', 'Scanning Wi-Fi for camera hotspots');
        const res = await R.wifiScan();
        if (!live()) return;
        conn = res.connected; wifiRes = res;
        const list = R.classifyWifi(res);
        s.radio.wifi = { n: list.length, list: list.slice(0, 20) };
        if (res.wifiOff) this.trace('RADIO', 'Radio', 'Wi-Fi is switched off: no hotspot scan.');
        else if (res.locationOff) this.trace('WARN', 'Radio', 'Location is off, so Android returns no Wi-Fi networks. Switch Location on and scan again.');
        else this.trace('RADIO', 'Radio', esc(R.summaryWifi(list)) + (res.fresh === false ? ' (Android gave recent results; it limits scans)' : ''));
        list.filter(n => n.risk !== 'low' && !n.connected).slice(0, 3).forEach(n =>
          hit(n.risk, `Wi-Fi “${n.ssid || 'hidden'}” (${n.level} dBm): ${n.reasons[0] || ''}`));
      } catch (e) { if (!live()) return; denied('Wi-Fi scan', e); }
      try {
        this.trace('TOOL', 'Radio', 'Listening for Bluetooth trackers');
        const res = await R.bleScan(6000);
        if (!live()) return;
        const list = R.classifyBle(res);
        s.radio.ble = { n: list.length, list: list.slice(0, 20) };
        this.trace('RADIO', 'Radio', res.bluetoothOff ? 'Bluetooth is switched off: no tracker scan.' : esc(R.summaryBle(list)));
        list.filter(d => d.risk !== 'low').slice(0, 3).forEach(d =>
          hit(d.risk, `Bluetooth ${d.kind === 'tracker' ? 'tracker' : 'device'} ${d.name || d.address}: ${d.reasons[0] || ''}`));
      } catch (e) { if (!live()) return; denied('Bluetooth scan', e); }
      if (conn) {
        try {
          this.trace('TOOL', 'Radio', `Checking the devices on ${esc(conn.ssid || 'this Wi-Fi')} for cameras`);
          const res = await R.lanScan({ timeoutMs: 280 });
          if (!live()) return;
          const list = R.classifyLan(res);
          lanRes = res; lanList = list;
          s.radio.lan = { n: list.length, list: list.slice(0, 20) };
          this.trace('RADIO', 'Radio', esc(R.summaryLan(list)));
          list.filter(h => h.risk !== 'low').slice(0, 3).forEach(h =>
            hit(h.risk, `Device ${h.ip} on this Wi-Fi: ${h.reasons[0] || ''}`));
        } catch (e) { if (!live()) return; denied('Network scan', e); }
      } else this.trace('RADIO', 'Radio', 'Not on a Wi-Fi network: the network scan is skipped.');
      // the Wi-Fi itself: someone who hides a camera may also watch the network they hand you
      const NET = this.io.net;
      if (conn && NET && NET.available) {
        try {
          this.trace('TOOL', 'Radio', 'Checking whether this Wi-Fi is private');
          const r = NET.assess(await NET.info(), wifiRes, lanRes, lanList);
          if (!live()) return;
          s.radio.net = { verdict: r.verdict, title: r.title };
          const serious = r.checks.filter(c => c.status === 'bad' && c.id !== 'lan');
          if (serious.length) serious.slice(0, 2).forEach(c => hit('medium', `Wi-Fi: ${c.title}`));
          else this.trace('RADIO', 'Radio', esc(`Wi-Fi privacy: ${r.title}`));
        } catch (e) { if (!live()) return; denied('Network privacy check', e); }
      }
      if (!live()) return;
      s.steps.radio = 'done'; s.dirty = true;
      this.trace('PLAN', 'Coordinator', s.radioHits.some(h => h.risk === 'high')
        ? 'Radio found a camera signal. Keep going: the survey tells you where it is.'
        : 'Radio sweep done. Nothing on the air looks like a camera; the optical search carries on.');
    },

    /* ---------- Scene agent: every hiding spot, with the direction it was seen in ---------- */
    onObjects(boxes, c) {
      const s = this.s;
      if (!s || !s.on || s.source !== 'camera') return;
      const H = this.io.heading();
      for (const b of boxes) {
        if (!b.spot) continue;
        const dir = H && H.ok ? { yaw: wrap(H.yaw + (b.x - 0.5) * c.fovH), pitch: H.pitch + (0.5 - b.y) * c.fovV } : { yaw: null, pitch: null };
        let m = s.spots.get(b.label);
        if (!m) {
          m = { label: b.label, spot: b.spot, n: 0, done: false, how: null, yaw: dir.yaw, pitch: dir.pitch };
          s.spots.set(b.label, m);
        }
        m.n++;
        if (!m.ok && (m.n >= 2 || b.score >= 0.5)) m.ok = true; else if (m.ok) { /* already remembered */ } else continue;
        if (dir.yaw != null) {                                 // refine the direction as it's seen again
          if (m.yaw == null) { m.yaw = dir.yaw; m.pitch = dir.pitch; }
          else { m.yaw = wrap(m.yaw + 0.3 * angDiff(dir.yaw, m.yaw)); m.pitch += 0.3 * (dir.pitch - m.pitch); }
        }
        if (!m.said) {
          m.said = true;
          this.trace('SEE', 'Scene', `Remembered the <b>${esc(b.label.toLowerCase())}</b>${m.yaw != null ? ` at ${Math.round(m.yaw)}°` : ''}: ${WHY[b.spot] || 'a common hiding spot'}.`);
          s.dirty = true;
        }
      }
    },

    /* ---------- Glint / Vision / Magnetic events from app.js ---------- */
    onEvent(type, d) {
      const s = this.s;
      if (!s || !s.on) return;
      const H = this.io.heading();
      const here = H && H.ok ? { yaw: H.yaw, pitch: H.pitch } : { yaw: null, pitch: null };
      if (type === 'suspect' && s.source === 'camera') {
        if (s.suspects.some(g => g.id === d.id)) return;
        if (here.yaw == null) return;                 // no orientation sensor: nothing to walk back to
        const yaw = wrap(here.yaw + (d.x - 0.5) * d.fovH);
        if (s.suspects.some(g => !g.done && Math.abs(angDiff(g.yaw, yaw)) < 12)) return;
        s.suspects.push({ id: d.id, yaw, pitch: here.pitch, done: false });
        this.trace('THINK', 'Glint', `Testing a bright spot at ${Math.round(yaw)}°. If you turn away, you will be guided back.`);
      } else if (type === 'resolved') {
        for (const g of s.suspects) {
          if (g.done) continue;
          if (g.id === d.id || (here.yaw != null && g.yaw != null && Math.abs(angDiff(g.yaw, here.yaw)) < 14)) { g.done = true; g.how = d.why; }
        }
        s.dirty = true;
      } else if (type === 'possible') {
        const yaw = d.yaw != null ? d.yaw : here.yaw;
        s.possibles.push({ yaw, pitch: d.yaw != null ? d.pitch : here.pitch });
        s.suspects.forEach(g => { if (!g.done && (g.id === d.id || (yaw != null && g.yaw != null && Math.abs(angDiff(g.yaw, yaw)) < 14))) { g.done = true; g.how = 'possible'; } });
        s.dirty = true;
        this.trace('THINK', 'Glint', `Point #${d.id} passed the light tests${yaw != null ? ` (at ${Math.round(yaw)}°)` : ''} but nothing else confirms it: saved as a possible lens for you to look at closely.`);
      } else if (type === 'camera') {
        if (d.yaw != null) { here.yaw = d.yaw; here.pitch = d.pitch; }
        s.cameras.push({ kind: d.kind, yaw: here.yaw, pitch: here.pitch });
        const near = x => !x.done && here.yaw != null && x.yaw != null && Math.abs(angDiff(x.yaw, here.yaw)) < 25;
        s.suspects.forEach(g => { if (near(g)) { g.done = true; g.how = 'camera'; } });
        s.mags.forEach(m => { if (near(m)) { m.done = true; m.how = 'camera'; } });
        this.trace('FOUND', 'Coordinator', `${d.kind === 'phonecam' ? 'A phone’s camera is pointing into the room: its lens passed the flash + angle tests' : d.kind === 'devicecam' ? `The camera of a ${String(d.device || 'device').toLowerCase()} is pointing into the room: its lens passed the flash + angle tests` : `Camera confirmed by the ${d.kind === 'shape' ? 'shape recogniser' : d.kind === 'ircam' ? 'night-vision test' : d.why === 'magnetic' ? 'flash + angle tests and a magnetic jump at the spot' : d.why === 'shape' ? 'flash + angle tests and its camera shape' : 'flash + angle tests'}`}${here.yaw != null ? ` at ${Math.round(here.yaw)}°` : ''}. Photo saved. Keep going: there may be more than one.`);
      }
    },

    /* ---------- every frame (app.js) ---------- */
    tick(now, c) {
      const s = this.s;
      if (!s || !s.on || s.source !== 'camera' || s.phase === 'prepare') return;
      // no ticks while the app was in the background or the camera saw nothing: that time doesn't count
      if (s.lastTickT && now - s.lastTickT > 500) { const gap = now - s.lastTickT; s.surveyT0 += gap; s.inspectT0 += gap; s.surveyWall0 += gap; }
      // testing a bright spot or showing a camera just found isn't time spent surveying: the 90 s limit waits
      // (it used to count, so a busy room ended the survey with part of the room never looked at)
      else if (s.lastTickT && s.phase === 'survey' && (c.focus || c.found)) s.surveyT0 += now - s.lastTickT;
      s.lastTickT = now;
      const H = this.io.heading();
      const hOk = !!(H && H.ok);
      if (hOk && !s.hasHeading) {
        s.hasHeading = true;
        this.trace('THINK', 'Coverage', 'Orientation readings arrived: coverage map and turn angles on.');
      }
      const dtMs = c.dt * 1000;
      // Coverage agent
      s.rate = s.rate == null ? c.rate : s.rate * 0.85 + c.rate * 0.15;
      s.items = c.items;
      if (hOk && c.rate < 60) {
        if (H.pitch > -40 && H.pitch < 55) {
          const i = Math.floor(wrap(H.yaw) / BIN) % BINS;
          const was = s.cover[i];
          s.cover[i] = Math.min(COVER_MS * 3, s.cover[i] + dtMs);
          if (was < COVER_MS && s.cover[i] >= COVER_MS) s.dirty = true;
        }
        if (H.pitch > 25) {
          const was = s.ceilMs;
          s.ceilMs += dtMs;
          if (was < CEIL_MS && s.ceilMs >= CEIL_MS) this.trace('CLEAR', 'Coverage', 'Ceiling looked at: smoke detector, corners, AC vent.');
        }
      }
      // Magnetic agent
      if (c.mag != null && c.mag >= 15 && hOk && !s.cameras.some(k => k.yaw != null && Math.abs(angDiff(k.yaw, H.yaw)) < 25)) {
        const m = s.mags.find(x => Math.abs(angDiff(x.yaw, H.yaw)) < 25 && Math.abs(x.pitch - H.pitch) < 30);
        if (!m) {
          s.mags.push({ yaw: H.yaw, pitch: H.pitch, peak: c.mag, done: false });
          this.trace('MAG', 'Magnetic', `Field jumped +${Math.round(c.mag)} µT facing ${Math.round(H.yaw)}°: electronics or metal close to the phone. Marked for a close look.`);
        } else if (c.mag > m.peak) m.peak = c.mag;
      }
      // Scene agent: spots the app has checked with the flash
      for (const m of s.spots.values()) {
        if (!m.done && c.done.has(m.spot)) { m.done = true; m.how = c.hit && c.hit.has(m.spot) ? 'camera' : 'flash'; s.checked++; s.dirty = true; }
      }

      if (s.phase === 'survey') this.survey(now, H, hOk);
      else if (s.phase === 'inspect' && s.full) this.inspect(now, c, H, hOk);

      if (now - s.lastRadarT > 90) { s.lastRadarT = now; this.drawRadar(now, H, hOk, c.fovH); }
      if (s.dirty && now - s.lastCardT > 200) this.render();
    },

    survey(now, H, hOk) {
      const s = this.s;
      const el = now - s.surveyT0;
      const bins = coveredBins(s.cover);
      const yawDone = hOk ? bins >= SURVEY_BINS : el > 20000;
      const ceilDone = s.ceilMs >= CEIL_MS || (!hOk && el > 26000);
      const pct = hOk ? Math.round(bins / BINS * 100) : Math.min(100, Math.round(el / 260));
      s.goal = `Map the room · ${pct}%`;
      // a slow survey moves on after 90 s of surveying (4 min in all), but only once half the room has been seen:
      // never "room checked" on 0%
      const long = el > 90000 || now - s.surveyWall0 > 240000;
      if ((yawDone && ceilDone) || (long && (!hOk || bins / BINS >= 0.5))) {
        const spots = [...s.spots.values()].filter(m => m.ok);
        this.setPhase('inspect', long && !(yawDone && ceilDone)
          ? `Survey is taking long: moving on with ${pct}% covered.`
          : `Survey done: ${hOk ? bins * BIN + '° swept and the ceiling' : 'room and ceiling swept'}. ${spots.length ? `${spots.length} hiding spot${spots.length > 1 ? 's' : ''} to inspect: ${spots.map(m => esc(m.label.toLowerCase())).join(', ')}.` : 'No hiding spots recognised.'}`);
        s.inspectT0 = now;
        s.target = null;
      }
    },

    inspect(now, c, H, hOk) {
      const s = this.s;
      let t = s.target;
      if (t && t.ref.done) t = s.target = null;
      if (!t) {
        t = s.target = pickTarget(s, hOk ? H.yaw : 0, hOk);
        s.dwell = 0; s.centerMs = 0;
        if (t) {
          const name = this.label(t);
          const off = hOk && t.yaw != null ? Math.round(angDiff(t.yaw, H.yaw)) : null;
          this.trace('PLAN', 'Navigator', `Next: the <b>${esc(name.toLowerCase())}</b>${off != null ? ` (${Math.abs(off)}° to your ${off >= 0 ? 'right' : 'left'})` : ''}: ${t.type === 'glint' ? 'a bright point that never got a verdict' : t.type === 'mag' ? `the field jumped +${Math.round(t.ref.peak)} µT there` : WHY[t.ref.spot] || 'a common hiding spot'}.`);
          s.doneSaid = false;
        } else if (!s.doneSaid) {
          s.doneSaid = true;
          s.steps.inspect = 'done'; s.steps.report = 'now';
          const n = [...s.spots.values()].filter(m => m.ok).length;
          this.trace('PLAN', 'Coordinator', n ? `All ${n} hiding spot${n > 1 ? 's' : ''} checked. Tap <b>Finish</b> for the report.` : 'Nothing left to inspect. Point at any object you are unsure of, or tap <b>Finish</b> for the report.');
          this.io.say(this.io.voice.line('agentDone'), { key: 'agentDone', force: true });
          s.dirty = true;
        }
      }
      if (!t) { s.goal = 'Room checked · tap Finish'; return; }
      s.goal = `Inspect · ${this.label(t).toLowerCase()}`;
      if (c.focus || c.found) return;                            // a glint or camera is being handled
      // are we looking at it?
      const facing = hOk && t.yaw != null ? Math.abs(angDiff(t.yaw, H.yaw)) < 20 && (t.pitch == null || Math.abs(t.pitch - H.pitch) < 25) : false;
      const inView = t.type === 'spot' && c.items.some(it => it.label === t.ref.label && Math.abs(it.x - 0.5) < 0.3 && Math.abs(it.y - 0.5) < 0.3);
      if (facing || inView) s.dwell += c.dt * 1000;
      if (inView) s.centerMs += c.dt * 1000;
      const done = (how, html) => {
        t.ref.done = true; t.ref.how = how; s.checked++;
        this.trace(how === 'skipped' ? 'WARN' : 'CLEAR', t.type === 'spot' ? 'Scene' : t.type === 'mag' ? 'Magnetic' : 'Glint', html);
        s.target = null;
      };
      const name = esc(this.label(t).toLowerCase());
      if (t.type === 'spot') {
        if (s.centerMs >= (c.torch ? 3000 : 2500)) done(c.torch ? 'flash' : 'look', t.ref.spot === 'phone'
          ? (c.torch ? 'Checked the phone with the flash on: its camera is not pointing this way (no lens glint).' : 'Looked at the phone up close: no lens glint (no flash on this phone to test it properly).')
          : c.torch ? `Checked the ${name} with the flash on: no lens glint.` : `Looked at the ${name} up close: no lens glint and no camera shape (no flash on this phone).`);
        else if (s.dwell >= 6000) done('look', `Faced the ${name} for 6 s: no glint. The recogniser didn't pick it out again, so it's marked as looked at.`);
      } else if (s.dwell >= 3500) {
        done('look', t.type === 'glint' ? `Back at the bright point: nothing shines back any more. It was glare or a moving reflection.` : `Looked at the magnetic spot: no glint and no camera shape. Likely wiring, a charger or metal.`);
      }
    },

    label(t) { return t.type === 'glint' ? 'Bright point' : t.type === 'mag' ? 'Magnetic spot' : t.ref.label; },

    /* ---------- Navigator: what to say when nothing is in view ---------- */
    nav(now) {
      const s = this.s;
      if (!s || !s.on || !s.full || s.source !== 'camera') return null;
      const V = this.io.voice, H = this.io.heading(), hOk = !!(H && H.ok);
      if (s.phase === 'survey') {
        if (hOk) {
          const gap = coveredBins(s.cover) >= SURVEY_BINS ? null : nextGap(s.cover, H.yaw);
          if (gap && s.rate > 55) return { id: 'slower', tag: 'Look around', title: V.title('slower'), lang: V.lang, say: V.line('slower'), sayKey: 'slower', repeatMs: 12000,
            sub: 'Directions only count once the camera has had a moment on them.' };
          if (gap) {
            const [dir] = gap;
            const n = V.nav('survey', dir);
            return { id: 'survey-' + dir, dir, tag: `Look around · ${Math.round(coveredBins(s.cover) * BIN)}° done`, title: n.title, lang: n.lang, say: n.line, sayKey: 'survey-' + dir, repeatMs: 20000,
              sub: 'Turn slowly on the spot. Every hiding spot you pass is remembered.' };
          }
          return { id: 'lookup', dir: 'up', tag: 'Look around', title: V.title('lookUp'), lang: V.lang, say: V.line('lookUp'), sayKey: 'lookUp', repeatMs: 20000,
            sub: 'Tilt the phone up to the ceiling: smoke detector, corners, AC vent, CCTV.' };
        }
        const el = now - s.surveyT0;
        if (el > 20000) return { id: 'lookup', dir: 'up', tag: 'Look around', title: V.title('lookUp'), lang: V.lang, say: V.line('lookUp'), sayKey: 'lookUp', repeatMs: 20000, sub: 'Tilt the phone up to the ceiling: smoke detector, corners, AC vent, CCTV.' };
        return null;                                               // the usual "sweep slowly" line
      }
      if (s.phase !== 'inspect') return null;
      const t = s.target;
      if (!t) return { id: 'done', tag: 'Done', title: V.title('agentDone'), lang: V.lang, sub: 'All hiding spots are checked. Tap Finish for the report, or keep scanning anything you are unsure of.' };
      const label = this.label(t);
      // once the target is in the picture, steer by the picture
      const it = t.type === 'spot' && (s.items || []).find(x => x.label === t.ref.label);
      if (it) {
        const dx = it.x - 0.5, dy = it.y - 0.5;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 0.14) {
          const dir = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
          return { id: `aim-${dir}-${label}`, hapt: dir, tag: 'Aim', title: V.title(dir), lang: V.lang, say: V.line(dir), sayKey: dir, repeatMs: 6000,
            sub: `The ${label.toLowerCase()} is in the picture. Bring it into the circle.`, target: { x: it.x, y: it.y } };
        }
      }
      const why = t.type === 'glint' ? 'A bright point you passed never got a verdict.' : t.type === 'mag' ? `The magnetic field jumped +${Math.round(t.ref.peak)} µT here.` : `${label}: ${WHY[t.ref.spot] || 'a common hiding spot'}.`;
      if (hOk && t.yaw != null) {
        const d = angDiff(t.yaw, H.yaw);
        if (Math.abs(d) > (it ? 30 : 16)) {
          const dir = d > 0 ? 'right' : 'left', deg = round10(Math.abs(d));
          const n = V.nav('turn', dir, deg, label);
          return { id: `turn-${dir}-${label}`, dir, deg, tag: 'Next spot', title: n.title, lang: n.lang, say: n.line, sayKey: `turn-${dir}-${label}`, repeatMs: 12000, sub: why };
        }
        const dp = t.pitch != null ? t.pitch - H.pitch : 0;
        if (Math.abs(dp) > (it ? 30 : 18)) {
          const dir = dp > 0 ? 'up' : 'down';
          const n = V.nav('look', dir, 0, label);
          return { id: `look-${dir}-${label}`, dir, tag: 'Next spot', title: n.title, lang: n.lang, say: n.line, sayKey: `look-${dir}-${label}`, repeatMs: 12000, sub: why };
        }
      }
      const n = V.nav(hOk && t.yaw != null ? 'check' : 'find', null, 0, label);
      return { id: `check-${label}`, tag: 'Check', title: n.title, lang: n.lang, say: n.line, sayKey: `check-${label}`, repeatMs: 15000,
        sub: t.type === 'spot' ? 'Keep it in the circle, a hand\'s width to a metre away, with the flash on. It is ticked off after 3 seconds.' : 'Keep the phone pointed here for a few seconds.' };
    },

    skip() {
      const s = this.s;
      if (!s || !s.on || !s.full) return;
      if (s.phase === 'survey') { this.setPhase('inspect', 'Survey skipped by you.'); s.target = null; }
      else if (s.phase === 'inspect' && s.target) {
        s.target.ref.done = true; s.target.ref.how = 'skipped';
        this.trace('WARN', 'Navigator', `Skipped the ${esc(this.label(s.target).toLowerCase())} (by you). It stays on the report as not checked.`);
        s.target = null;
      }
      this.render(true);
    },

    /* ---------- Report agent ---------- */
    finish(stats) {
      const s = this.s;
      if (!s) return null;
      const bins = coveredBins(s.cover);
      const spots = [...s.spots.values()].filter(m => m.ok);
      const r = assessRisk({ cameras: s.cameras, possibles: s.possibles, radioHits: s.radioHits, suspects: s.suspects, mags: s.mags, spots: s.spots, hasHeading: s.hasHeading && s.source === 'camera', coverage: bins / BINS, ceiling: s.ceilMs >= CEIL_MS });
      if (s.source === 'file') {
        const n = s.cameras.length;
        const pn = s.possibles.length;
        r.reasons = n ? [`${n} camera${n > 1 ? 's' : ''} found in the recording`] : pn ? [`${pn} possible lens${pn > 1 ? 'es' : ''} in the recording: look at the saved frames`] : ['No lens glint or camera shape in the frames analysed'];
        r.risk = n ? 'high' : pn ? 'medium' : 'low';
      }
      const did = [];
      if (s.source === 'camera') {
        if (s.full) did.push(s.hasHeading ? `Swept ${bins * BIN}° of the room${s.ceilMs >= CEIL_MS ? ' and the ceiling' : ''}` : 'Swept the room without an orientation sensor');
        if (spots.length) did.push(`checked ${spots.filter(m => m.done && m.how !== 'skipped').length} of ${spots.length} hiding spot${spots.length > 1 ? 's' : ''}`);
        const rw = s.radio;
        if (rw.wifi || rw.ble || rw.lan) did.push(`Radio: ${rw.wifi ? rw.wifi.n + ' Wi-Fi networks' : 'no Wi-Fi scan'} · ${rw.ble ? rw.ble.n + ' Bluetooth devices' : 'no Bluetooth scan'} · ${rw.lan ? rw.lan.n + ' network devices' : 'no network scan'}`);
        if (s.mags.length) did.push(`${s.mags.length} magnetic jump${s.mags.length > 1 ? 's' : ''} marked with their direction`);
      }
      if (stats) did.push(`${stats.seen} bright point${stats.seen === 1 ? '' : 's'} tested · ${stats.glare + stats.lights + stats.cleared} ruled out`);
      const sum = {
        risk: r.risk, reasons: r.reasons, did, full: s.full, source: s.source,
        coverage: s.hasHeading ? Math.round(bins * BIN) : null, ceiling: s.ceilMs >= CEIL_MS,
        spots: spots.map(m => ({ label: m.label, done: m.done && m.how !== 'skipped', how: m.how })),
        radio: s.radio, radioHits: s.radioHits.slice(), cameras: s.cameras.length,
        trace: s.trace.slice(0, 30).reverse().map(x => ({ kind: x.kind, who: x.who, text: x.html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') })),
      };
      this.trace('PLAN', 'Report', `Result: <b>${r.risk === 'high' ? 'high risk' : r.risk === 'medium' ? 'check again' : 'low risk'}</b>. ${esc(r.reasons[0] || '')}`);
      s.steps.inspect = s.steps.inspect === 'skip' ? 'skip' : 'done'; s.steps.report = 'done';
      s.on = false;
      return sum;
    },

    /* ---------- the agent card and the coverage radar ---------- */
    render(force) {
      const s = this.s;
      if (!s || !root.document) return;
      s.lastCardT = performance.now(); s.dirty = false;
      const g = $('#agGoal'); if (g) g.textContent = s.goal;
      const st = $('#agSteps');
      if (st) st.innerHTML = PHASES.map(([k, l]) => `<li class="${s.steps[k] === 'wait' ? '' : s.steps[k]}">${l}</li>`).join('');
      const tr = $('#agTrace');
      if (tr) tr.innerHTML = s.trace.slice(0, 3).map(x => `<li class="k-${x.kind.toLowerCase()}"><b>${CARD_WORD[x.kind] || x.kind}</b><span>${x.html}</span></li>`).join('');
      const cov = $('#agCov'), covN = $('#agCovN'), row = $('#agCoverRow');
      if (row) row.hidden = s.source !== 'camera' || !s.full;
      if (cov) {
        const bins = coveredBins(s.cover);
        const pct = s.hasHeading ? bins / BINS : Math.min(1, (performance.now() - (s.surveyT0 || performance.now())) / 20000);
        cov.style.width = Math.round(pct * 100) + '%';
        if (covN) covN.textContent = s.hasHeading ? `${bins * BIN}°${s.ceilMs >= CEIL_MS ? ' + ceiling' : ''}` : Math.round(pct * 100) + '%';
      }
      const sk = $('#agSkip');
      if (sk) sk.hidden = !(s.on && s.full && (s.phase === 'survey' || (s.phase === 'inspect' && s.target)));
    },

    drawRadar(now, H, hOk, fovH) {
      const cv = $('#radar'), s = this.s;
      if (!cv) return;
      cv.hidden = !hOk || !s.full;
      if (cv.hidden) return;
      const dpr = Math.min(2, root.devicePixelRatio || 1), W = cv.clientWidth, Hh = cv.clientHeight;
      if (!W) return;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, Hh);
      const cx = W / 2, cy = Hh / 2, R = W / 2 - 3;
      const A = yaw => (angDiff(yaw, H.yaw) - 90) * Math.PI / 180;     // heads-up: where the phone points is up
      c.fillStyle = 'rgba(7,10,18,.78)'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
      for (let i = 0; i < BINS; i++) {
        const f = Math.min(1, s.cover[i] / COVER_MS);
        if (f <= 0) continue;
        c.fillStyle = f >= 1 ? 'rgba(253,207,88,.42)' : `rgba(253,207,88,${0.12 + 0.18 * f})`;
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R - 1, A(i * BIN) + 0.02, A((i + 1) * BIN) - 0.02); c.closePath(); c.fill();
      }
      c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(cx, cy, R * 0.28, 0, Math.PI * 2);
      if (s.ceilMs >= CEIL_MS) { c.fillStyle = 'rgba(253,207,88,.6)'; c.fill(); } else { c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]); }
      const half = (fovH || 40) / 2 * Math.PI / 180;                 // camera view cone
      c.fillStyle = 'rgba(255,255,255,.22)';
      c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half); c.closePath(); c.fill();
      const dot = (yaw, col, r, ring) => {
        if (yaw == null) return;
        const a = A(yaw), x = cx + Math.cos(a) * R * 0.68, y = cy + Math.sin(a) * R * 0.68;
        c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        if (ring) { c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, r + 3 + 2 * Math.sin(now / 160), 0, Math.PI * 2); c.stroke(); }
      };
      for (const m of s.spots.values()) if (m.ok) dot(m.yaw, m.done ? '#3CCB7F' : m.spot === 'phone' ? '#EE3A4F' : '#FDCF58', m.spot === 'phone' ? 3.8 : 3.2, s.target && s.target.ref === m);
      for (const m of s.mags) dot(m.yaw, m.done ? '#9A9A9A' : '#F08A24', 3, s.target && s.target.ref === m);
      for (const g of s.suspects) dot(g.yaw, g.done ? '#9A9A9A' : '#FFFFFF', 2.6, s.target && s.target.ref === g);
      for (const k of s.cameras) dot(k.yaw, '#EE3A4F', 4, true);
      c.fillStyle = '#FDCF58'; c.beginPath(); c.arc(cx, cy, 2.5, 0, Math.PI * 2); c.fill();
    },
  };

  Agent._t = { angDiff, nextGap, coveredBins, pickTarget, assessRisk, wrap, BINS, BIN, COVER_MS };
  root.TGAgent = Agent;
})(typeof window !== 'undefined' ? window : globalThis);
