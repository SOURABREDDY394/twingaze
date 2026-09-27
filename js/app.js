/* TwinGaze · app.js
 * Screens, the live scan loop, evidence scoring, voice + arrow guidance, saved evidence, the report. */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const { detect, Tracker, spans } = window.TGDetector;
  const { Camera, Motion, Mag, Light, Heading, Wake } = window.TGSensors;
  const Beeper = window.TGBeeper, Voice = window.TGVoice, Recog = window.TGRecognizer, Objects = window.TGModels.objects;
  const Native = window.TGNative, Radio = window.TGRadio, Agent = window.TGAgent;
  const Net = window.TGNet, Trackers = window.TGTrackers, Safety = window.TGSafety;

  // which recognised objects count as which place on the room checklist
  const PLACE_SPOTS = {
    'Bulb holder': ['bulb', 'lamp'], 'Bulb holders': ['bulb', 'lamp'], 'Light fittings': ['bulb', 'lamp'], 'Lamps': ['lamp', 'bulb'],
    'Smoke detector': ['smoke'], 'Wall clock': ['clock'], 'Alarm clock / charger': ['clock', 'socket'],
    'Sockets & chargers': ['socket'], 'Sockets': ['socket'], 'Switchboard': ['switch', 'socket'],
    'Photo frames': ['frame'], 'Mirror': ['mirror'], 'TV & set-top box': ['tv'], 'TV': ['tv'],
    'Decor facing the bed': ['decor', 'frame'], 'Plants / decor': ['decor'], 'Router / boxes': ['box'],
    'Exhaust fan': ['fan'], 'Hooks / towel rail': ['hook'], 'Shelf / bottles': ['shelf'], 'Clothes hooks': ['hook'],
  };

  const FOV = 66;            // typical phone main camera, long side of the frame, degrees
  const PROC_SIZES = [640, 480];   // long side of the copy each frame is analysed at; drops on slow phones
  const SUSPECT = 0.35;      // score at which a point is called a suspect
  const TOL = 0.13;          // "in the circle": distance from the middle, as a fraction of the long side
  const DISMISSED = new Set(['glare', 'light', 'artifact', 'ignored', 'clear', 'possible']);
  const MAG_FLAG = 'chrome://flags/#enable-experimental-web-platform-features';   // exposes Magnetometer + AmbientLightSensor

  const ROOMS = {
    pg:    { name: 'PG / hostel room', places: ['Bulb holder', 'Smoke detector', 'Wall clock', 'Clothes hooks', 'Sockets & chargers', 'AC / vents', 'Photo frames', 'Mirror', 'Switchboard'] },
    hotel: { name: 'Hotel room', places: ['TV & set-top box', 'Smoke detector', 'Alarm clock / charger', 'AC vent', 'Mirror', 'Lamps', 'Sockets', 'Photo frames', 'Decor facing the bed'] },
    home:  { name: 'Rented home', places: ['Smoke detector', 'Bulb holders', 'Sockets', 'Wall clock', 'AC unit', 'TV', 'Photo frames', 'Plants / decor', 'Router / boxes'] },
    trial: { name: 'Trial room', places: ['Mirror', 'Clothes hooks', 'Ceiling corners', 'Vents', 'Light fittings', 'Sockets'] },
    wash:  { name: 'Washroom', places: ['Exhaust fan', 'Light fittings', 'Geyser', 'Hooks / towel rail', 'Mirror', 'Sockets', 'Shelf / bottles'] },
  };
  const MODES = {
    lens: { detect: { minPeak: 120, minContrast: 55, minRatio: 1.8 }, torch: true, ev: -1 },
    ir:   { detect: { minPeak: 70, minContrast: 28, minRatio: 1.6 }, torch: false, ev: 0 },
  };
  // Settings → Sensitivity: how easily a glint or a camera shape is called a camera
  const SENS = {
    sensitive: { det: 0.82, conf: -0.05, ang: -2, rec: -0.07, desc: 'Sensitive: catches fainter glints and smaller cameras; more false alarms' },
    balanced:  { det: 1, conf: 0, ang: 0, rec: 0, desc: 'Balanced: the tested default' },
    strict:    { det: 1.15, conf: 0.05, ang: 3, rec: 0.1, desc: 'Strict: only strong, clear evidence; may miss a well-hidden camera' },
  };
  const TOOLS = [
    { id: 'full', icon: 'i-scan', g: 'g-grad', name: 'Full room scan', sub: 'Runs every check and walks you round the room', feature: true },
    { id: 'lens', icon: 'i-eye', g: 'g-red', name: 'Lens finder', sub: 'Flash + camera: the glint of a hidden lens' },
    { id: 'ir', icon: 'i-moon', g: 'g-slate', name: 'Night vision', sub: 'Lights off: the infrared LEDs of night cameras' },
    { id: 'mag', icon: 'i-magnet', g: 'g-amber', name: 'Magnetic', sub: 'Beeps faster near powered electronics' },
    { id: 'wifi', icon: 'i-wifi', g: 'g-slate', name: 'Wi-Fi', sub: 'Camera hotspots and camera-maker radios nearby', app: 'radio' },
    { id: 'ble', icon: 'i-bt', g: 'g-slate', name: 'Bluetooth', sub: 'AirTags, Tiles, SmartTags and Bluetooth cameras', app: 'radio' },
    { id: 'lan', icon: 'i-net', g: 'g-slate', name: 'Network', sub: 'Cameras on the Wi-Fi you joined (ONVIF, RTSP)', app: 'radio' },
    { id: 'guard', icon: 'i-phonecheck', g: 'g-green', name: 'Phone check', sub: 'Spyware, trackers inside apps, and apps using the camera or mic', app: 'guard' },
    { id: 'net', icon: 'i-shield', g: 'g-blue', name: 'Network check', sub: 'Is this Wi-Fi private? Fake hotspots, who sees your browsing, cameras on it', app: 'net' },
    { id: 'mirror', icon: 'i-mirror', g: 'g-slate', name: 'Mirror test', sub: 'Three checks for a two-way mirror' },
    { id: 'video', icon: 'i-video', g: 'g-slate', name: 'Video', sub: 'Analyse a recorded room video frame by frame' },
    { id: 'sos', icon: 'i-phone', g: 'g-red', name: 'SOS', sub: 'Call 112 or send your location' },
  ];
  // reference videos shipped with the app: real recordings with a known answer, analysed like any other video
  // (the answer is only compared at the end, it never steers the scan)
  const REF_VIDEOS = [
    { id: 'hall', name: 'Hackathon hall', url: 'media/hall-reference.mp4', file: 'Hackathon hall (reference).mp4', place: 'the hall at the iQOO Hackathon, Hyderabad',
      cameras: 2, what: '2 CCTV cameras (domes) on the ceiling' },
  ];
  const placeName = () => st.ref ? st.ref.name : ROOMS[st.room].name;   // the reference video's place, else the room type
  const HOME_TOOLS = ['lens', 'ir', 'mag', 'wifi', 'ble', 'lan', 'mirror', 'video'];
  const FS = new Set(['scan', 'magnet', 'radio', 'mirror', 'guard', 'net']);
  const Guard = window.TGGuard;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // how soon a spoken instruction may be repeated while it stays on screen (ms)
  const REPEAT = { start: 60000, lights: 20000, sweep: 25000, noTorch: 30000, left: 4500, right: 4500, up: 4500, down: 4500, flash: 8000, moveSide: 8000, closer: 8000, hold: 6000, possible: 15000, recHold: 8000, covered: 10000, vScan: 30000, vCheck: 15000 };
  const TAGS = { start: 'Scanning', lights: 'Setup', sweep: 'Searching', noTorch: 'Searching', left: 'Guide', right: 'Guide', up: 'Guide', down: 'Guide', flash: 'Test 1 · flash', moveSide: 'Test 2 · angle', closer: 'Test 3 · magnetic', hold: 'Checking', found: 'Result', possible: 'Result', recHold: 'Test · shape', covered: 'Camera', vScan: 'Recorded video', vCheck: 'Recorded video' };
  const SUBS = {
    start: 'Move the phone slowly across the room. Boxes appear on anything that reflects light.',
    lit: 'Lights on is fine: the camera is darkened so a lens glint still stands out. Get within 1–2 m of what you check. Visible cameras are also recognised by their shape.',
    lights: 'The room is bright. A lens glint only stands out in the dark.',
    sweep: 'Point at bulb holders, smoke detectors, sockets, hooks, clocks and frames: anything that faces the bed or shower.',
    sweepIr: 'Room dark, flash off. Night-vision cameras light up small dots, often purple or white, that you can\'t see by eye.',
    noTorch: 'This browser can\'t switch the flash on. Hold another phone\'s torch right beside this camera, or use Night-vision scan.',
    left: 'Something is shining back to the left. Bring it into the circle.',
    right: 'Something is shining back to the right. Bring it into the circle.',
    up: 'Something is shining back above. Bring it into the circle.',
    down: 'Something is shining back below. Bring it into the circle.',
    flash: 'Switching the flash off and on. A lens goes dark with it; a lamp or LED keeps shining.',
    moveSide: 'Move the phone a hand\'s width left and right, keeping the point in the circle. Turning on the spot does not count. A lens stays on its object; a reflection slides away.',
    covered: 'Nothing reaches the camera: the phone is lying on its back, or the lens is covered. The scan needs the back camera pointed at the room.',
    recHold: 'Something is shaped like a camera. Keep it in the circle for two seconds: the middle of the picture is checked in full detail.',
    possible: 'It passed the light tests, but nothing else confirms it yet. Look closely: a lens is a tiny dark glass dot. Bring the phone within a hand\'s width for the magnetic check.',
    closer: 'Get within a hand\'s width of it. The magnetic sensor listens for electronics inside.',
    hold: 'Collecting evidence.',
    found: 'Don\'t touch it. A photo and its fingerprint are saved on this phone.',
    foundMag: 'Don\'t touch it. Photo saved. Bring the phone within a hand\'s width: the magnetic sensor adds proof.',
    vScan: 'Every frame is searched for tiny points that shine back. A recording has no live sensors: only what is in the frames counts.',
    vCheck: 'A bright point is being followed. It counts as a camera only if it stays lit while the camera moves past it, or goes dark with a recorded flash test.',
  };

  const video = $('#video'), ov = $('#ov'), octx = ov.getContext('2d');
  const pc = document.createElement('canvas');
  const pctx = pc.getContext('2d', { willReadFrequently: true });

  const st = {
    room: 'pg', mode: 'lens', smode: 'lens', source: 'camera',
    running: false, runId: 0, saving: new Set(), t0: 0, lastProc: 0, fps: 0, procMs: 0, procIdx: 0, fw: 0, fh: 0,
    torchAvail: false, lights: 'done', lightsT0: 0, lightsSamples: [],
    tracker: new Tracker(), focusId: null, lastFocusId: null,
    guide: { key: null, since: 0, centered: false },
    stats: null, seenIds: new Set(), session: [], checked: new Set(),
    flash: { phase: 'idle' }, lastAlertT: -1e9, lastFoundSay: -1e9, lastUiT: 0, lastSensT: 0,
    fileUrl: null, lastFile: null, urls: [], lastDur: 0, reportLang: 'en', events: [], bright: false,
    meanEma: null, dark: false, darkN: 0, darkTracks: [], darkEndT: 0, seeking: false,
    full: false, sens: 'balanced', discreet: false, backTo: 'home', tab: 'home', agentSum: null, nav: null, scanId: null,
  };
  const sens = () => SENS[st.sens] || SENS.balanced;
  const CAM_KINDS = new Set(['camera', 'ircam', 'shape', 'phonecam', 'devicecam']);
  /* things with a camera built in: a lens-like glint on one of them is its camera. 'top' = the webcam sits
   * in the top bezel, so only a glint there counts */
  const DEVICES = { Phone: 'any', Tablet: 'any', Camera: 'any', Laptop: 'top', Monitor: 'top' };
  const devTitle = d => d === 'Camera' ? 'Camera lens' : d + ' camera';

  /* ---------- small helpers ---------- */
  function vib(pattern) {
    if (Native.available) Native.vibrate(pattern);
    else try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) { /* no vibration */ }
  }
  /* Saves a file where the person can find it (and where vivo Office Kit syncs it to the laptop):
   * in the app, Pictures / Movies / Download under TwinGaze; in a browser, the Downloads folder. */
  async function saveOut(blob, name, kind) {
    if (Native.available) return Native.saveBlob(blob, name, kind);
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    return 'Downloads';
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const SCREENS = ['home', 'tools', 'history', 'settings', 'how', 'guard', 'net', 'scan', 'magnet', 'radio', 'mirror', 'report'];
  function show(id) {
    SCREENS.forEach(s => { $('#' + s).hidden = s !== id; });
    const fs = FS.has(id);
    document.body.classList.toggle('fullscreen', fs);
    Native.setBars(id === 'scan' ? 'DARK' : 'LIGHT');
    if (id === 'settings') voiceRender();
    if (['home', 'tools', 'history', 'settings'].includes(id)) st.tab = id;
    document.body.dataset.tab = id;
    $$('#tabbar [data-go]').forEach(b => { if (b.dataset.go === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (id === 'history') renderHistory();
    if (id === 'settings') renderSensors();
    window.scrollTo(0, 0);
  }
  function go(tab) {
    if (st.running || MG.timer) return;           // a scan owns the screen until it's stopped
    if (tab === 'back') tab = st.prevTab || 'home';
    if (tab === 'how') { st.prevTab = st.tab; renderHow(); }
    show(tab);
  }
  const LOG_WORD = { THINK: 'NOTE', TOOL: 'SCAN', SYS: 'INFO', SEE: 'SEEN', SAVE: 'SAVED', WARN: 'NOTE' };
  function log(kind, html) {
    const l = $('#log');
    const empty = l.querySelector('.empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = 'k-' + kind.toLowerCase();
    const t = st.t0 ? ((performance.now() - st.t0) / 1000).toFixed(1) + 's' : '';
    li.innerHTML = `<time>${t}</time><b>${LOG_WORD[kind] || kind}</b><span>${html}</span>`;
    l.appendChild(li);
    while (l.children.length > 400) l.firstChild.remove();
    // reading scrollHeight lays the page out again: do it once per screen frame, not once per line
    if (!st.logScroll) { st.logScroll = true; requestAnimationFrame(() => { st.logScroll = false; l.scrollTop = l.scrollHeight; }); }
  }
  const fmtDur = s => `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  const fmtClock = s => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
  const camName = () => { const l = Camera.label || 'camera'; return l.length > 48 ? l.slice(0, 45) + '…' : l; };
  const areaK = () => (st.fw * st.fh) / (270 * 480) || 1;
  const save = () => {
    try {
      localStorage.setItem('twingaze', JSON.stringify({ room: st.room, lang: Voice.lang, voice: st.discreet ? st.prevSound.voice : Voice.on, vmode: Voice.mode,
        beep: st.discreet ? st.prevSound.beep : Beeper.on, sens: st.sens, discreet: st.discreet }));
    } catch (e) { /* private mode */ }
  };
  function load() {
    try {
      const p = JSON.parse(localStorage.getItem('twingaze') || '{}');
      if (ROOMS[p.room]) st.room = p.room;
      if (['en', 'hi', 'te'].includes(p.lang)) Voice.lang = p.lang;
      if (typeof p.voice === 'boolean') Voice.on = p.voice;
      if (['alerts', 'guide'].includes(p.vmode)) Voice.mode = p.vmode;
      if (typeof p.beep === 'boolean') Beeper.on = p.beep;
      if (SENS[p.sens]) st.sens = p.sens;
      if (p.discreet) setDiscreet(true, true);
    } catch (e) { /* first run */ }
  }
  /* Discreet mode: dim screen, no voice, no beeps; guidance comes as vibration patterns */
  function setDiscreet(on, quiet) {
    if (on === st.discreet) return;
    if (on) { st.prevSound = { voice: Voice.on, beep: Beeper.on }; Voice.on = false; Beeper.on = false; Voice.stop(); }
    else if (st.prevSound) { Voice.on = st.prevSound.voice; Beeper.on = st.prevSound.beep; }
    st.discreet = on;
    document.body.classList.toggle('discreet', on);
    if (!quiet) { save(); syncSoundButtons(); toast(on ? 'Discreet mode: silent, dim, guidance by vibration.' : 'Discreet mode off.'); }
  }
  const HAPTIC = { left: [60, 80, 60], right: [220], up: [60, 60, 60, 60, 60], down: [400], found: [300, 100, 300, 100, 300], flash: [30], moveSide: [120, 120, 120], possible: [120, 80, 120] };

  function brackets(c, x, y, r, col, lw) {
    const k = r * 0.45;
    c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'square';
    c.beginPath();
    c.moveTo(x - r, y - r + k); c.lineTo(x - r, y - r); c.lineTo(x - r + k, y - r);
    c.moveTo(x + r - k, y - r); c.lineTo(x + r, y - r); c.lineTo(x + r, y - r + k);
    c.moveTo(x + r, y + r - k); c.lineTo(x + r, y + r); c.lineTo(x + r - k, y + r);
    c.moveTo(x - r + k, y + r); c.lineTo(x - r, y + r); c.lineTo(x - r, y + r - k);
    c.stroke();
  }
  function tag(c, x, y, text, bg, fg) {
    c.font = '800 10.5px "Plus Jakarta Sans", system-ui, sans-serif';
    const w = c.measureText(text).width + 14;
    x = Math.max(2, Math.min(x, c.canvas.clientWidth - w - 2));
    c.fillStyle = bg; c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, 17, 8.5); else c.rect(x, y, w, 17);
    c.fill();
    c.fillStyle = fg; c.textBaseline = 'middle'; c.fillText(text, x + 7, y + 9);
  }
  async function sha256(blob) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }

  /* ---------- evidence store (IndexedDB, on this phone only) ---------- */
  const DB = {
    p: null,
    open() {
      if (!this.p) this.p = new Promise((res, rej) => {
        const r = indexedDB.open('twingaze', 3);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('evidence')) db.createObjectStore('evidence', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'name' });
          if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.p;
    },
    async run(mode, fn, store = 'evidence') {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    },
    async put(rec) { try { await this.run('readwrite', s => s.put(rec)); return true; } catch (e) { return false; } },
    async all() { try { return (await this.run('readonly', s => s.getAll())) || []; } catch (e) { return []; } },
    async del(id) { try { await this.run('readwrite', s => s.delete(id)); } catch (e) { /* already gone */ } },
    async putRec(rec) { try { await this.run('readwrite', s => s.put(rec), 'recordings'); return true; } catch (e) { return false; } },
    async allRecs() { try { return (await this.run('readonly', s => s.getAll(), 'recordings')) || []; } catch (e) { return []; } },
    async putScan(rec) { try { await this.run('readwrite', s => s.put(rec), 'scans'); return true; } catch (e) { return false; } },
    async allScans() { try { return ((await this.run('readonly', s => s.getAll(), 'scans')) || []).sort((a, b) => b.time.localeCompare(a.time)); } catch (e) { return []; } },
    async delScan(id) { try { await this.run('readwrite', s => s.delete(id), 'scans'); } catch (e) { /* already gone */ } },
  };
  async function refreshLocker() {
    const n = (await DB.all()).length;
    $('#lockerN').textContent = n;
    renderRecent();
  }

  /* ---------- scan history ---------- */
  const RISK_TXT = { high: 'High risk', medium: 'Check again', low: 'Low risk' };
  const KIND_TXT = { room: 'Room scan', full: 'Full room scan', video: 'Recorded video', ref: 'Reference video', magnet: 'Magnetic sweep', wifi: 'Wi-Fi scan', ble: 'Bluetooth scan', lan: 'Network scan', mirror: 'Mirror test', guard: 'Phone check', net: 'Network check' };
  const KIND_IC = { room: 'i-eye', full: 'i-scan', video: 'i-video', ref: 'i-video', magnet: 'i-magnet', wifi: 'i-wifi', ble: 'i-bt', lan: 'i-net', mirror: 'i-mirror', guard: 'i-phonecheck', net: 'i-wifi' };
  const ago = iso => {
    const m = (Date.now() - new Date(iso).getTime()) / 60000;
    return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago`
      : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  /* the two status cards on Home: the last room scan and the last phone check */
  function homeStatus(all) {
    const set = (q, h, empty) => {
      const el = $(q);
      el.className = 'd-st' + (h ? ' ' + (h.risk === 'high' ? 'bad' : h.risk === 'medium' ? 'warn' : 'ok') : '');
      el.innerHTML = '<i></i>' + (h ? esc((h.risk === 'high' ? (h.kind === 'guard' ? 'Threat found' : 'Camera found') : h.risk === 'medium' ? 'Check again' : 'All clear') + ' · ' + ago(h.time)) : empty);
    };
    set('#lastRoom', all.find(h => ['full', 'room', 'video'].includes(h.kind)), 'Not scanned yet');
    set('#lastPhone', all.find(h => h.kind === 'guard'), Guard && Guard.available ? 'Not checked yet' : 'App only');
  }
  /* the latest result of each kind of check, as short lines for the SOS message */
  async function latestFindings() {
    const all = await DB.allScans();
    const room = all.find(h => ['full', 'room', 'video'].includes(h.kind)), guard = all.find(h => h.kind === 'guard'), net = all.find(h => h.kind === 'net');
    const when = h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const recent = h => h && Date.now() - new Date(h.time).getTime() < 12 * 3600 * 1000;
    const lines = [];
    if (recent(room) && room.risk === 'high') lines.push(`TwinGaze: ${room.head || 'hidden camera found'} in ${room.room || 'this room'} (${when(room)}).`);
    if (recent(guard) && guard.risk === 'high') lines.push(`TwinGaze: spyware signs on my phone (${when(guard)}).`);
    if (recent(net) && net.risk === 'high') lines.push(`TwinGaze: the Wi-Fi here is not private (${when(net)}).`);
    return { room, guard, net, lines };
  }
  async function addHistory(rec) {
    rec.id = rec.id || 'sc' + Date.now();
    rec.time = rec.time || new Date().toISOString();
    await DB.putScan(rec);
    renderRecent();
    protectSync();                                    // the SOS text mentions what the scans found
    return rec;
  }
  function historyItem(h) {
    const cls = h.risk === 'high' ? 'bad' : h.risk === 'medium' ? 'warn' : '';
    const when = new Date(h.time).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<button class="item ${cls}" type="button" data-scan="${esc(h.id)}"><span class="i-ic"><svg><use href="#${KIND_IC[h.kind] || 'i-scan'}"/></svg></span>
      <div><b>${esc(h.title || KIND_TXT[h.kind] || 'Scan')}</b><small>${esc(when)}${h.room ? ' · ' + esc(h.room) : ''} · ${esc(h.line || RISK_TXT[h.risk] || '')}</small></div><svg class="chev"><use href="#i-next"/></svg></button>`;
  }
  async function renderRecent() {
    const all = await DB.allScans();
    homeStatus(all);
    $('#recentSec').hidden = !all.length;
    $('#recentList').innerHTML = all.slice(0, 3).map(historyItem).join('');
    $$('#recentList [data-scan]').forEach(b => { b.onclick = () => openScan(b.dataset.scan); });
  }
  async function renderHistory() {
    const [all, ev] = await Promise.all([DB.allScans(), DB.all()]);
    $('#lockerN').textContent = ev.length;
    $('#historyList').innerHTML = all.length ? all.map(historyItem).join('') : '<p class="empty">No scans yet. Every scan you finish is kept here, on this phone only.</p>';
    $$('#historyList [data-scan]').forEach(b => { b.onclick = () => openScan(b.dataset.scan); });
  }
  async function openScan(id) {
    const h = (await DB.allScans()).find(x => x.id === id);
    if (!h) return;
    st.backTo = st.tab || 'history';
    st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = [];
    const ev = h.evidence && h.evidence.length ? (await DB.all()).filter(r => h.evidence.includes(r.id)) : [];
    const when = new Date(h.time).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let html = `<div class="eyebrow">${esc(KIND_TXT[h.kind] || 'Scan')} · ${esc(when)}${h.room ? ' · ' + esc(h.room) : ''}</div>
      <h1>${esc(h.head || RISK_TXT[h.risk] || 'Scan')}</h1>`;
    if (h.agent) html += agentBox(h.agent);
    if (h.items && h.items.length) html += `<div class="box"><span class="sq"></span><h3>Results</h3><ul class="spots">${h.items.map(i => `<li class="${i.bad ? '' : 'no'}"><span>${esc(i.a)}</span><em>${esc(i.b)}</em></li>`).join('')}</ul></div>`;
    html += ev.map(card).join('');
    html += `<div class="again"><button type="button" id="again">Back to history</button><button type="button" id="delScan">Delete entry</button></div>`;
    const r = $('#report');
    r.innerHTML = html;
    wireCards(r, ev);
    $('#again').onclick = () => show('history');
    $('#delScan').onclick = async () => { await DB.delScan(id); show('history'); toast('Entry deleted. Its evidence photos stay in the locker.'); };
    show('report');
  }

  /* ---------- sensors panel ---------- */
  function renderSensors() {
    const rows = [];
    const s = Camera.settings();
    if (st.running && st.source === 'file') rows.push(['Source', 'ok', `<b>video file</b> · ${video.videoWidth}×${video.videoHeight}`]);
    else if (Camera.track) rows.push(['Camera', 'ok', `<b>on</b> · ${esc(camName())} · ${s.width || video.videoWidth}×${s.height || video.videoHeight}${s.frameRate ? ' · ' + Math.round(s.frameRate) + ' fps' : ''}`]);
    else if (!window.isSecureContext) rows.push(['Camera', 'bad', '<b>blocked</b> · the page must be opened over https']);
    else rows.push(['Camera', '', navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'ready' : '<b>not available in this browser</b>']);
    if (Camera.track) {
      rows.push(['Flash', Camera.hasTorch ? 'ok' : 'bad', Camera.hasTorch ? `<b>controllable</b> · ${Camera.torchOn ? 'on' : 'off'}` : '<b>not controllable</b> in this browser']);
      rows.push(['Exposure', Camera.hasExposure ? 'ok' : '', Camera.hasExposure ? '<b>adjustable</b> · darkened so glints stand out' : 'fixed']);
    }
    if (st.running && st.source === 'camera') {
      rows.push(['Gyroscope', Motion.ok ? 'ok' : 'bad', Motion.ok ? `<b>on</b> · ${Motion.rate.toFixed(0)}°/s` : '<b>no readings</b> · the angle test uses image motion']);
    } else rows.push(['Gyroscope', '', typeof DeviceMotionEvent !== 'undefined' ? 'available' : 'not available']);
    const magRow = {
      on: ['ok', Mag.source === 'compass' ? `<b>on</b> · compass method (no flag needed) · swing ${Math.abs(Mag.swing).toFixed(0)}° · ${Math.round(Mag.rate)} readings/s`
        : Mag.base != null ? `<b>on</b> · ${esc(Mag.describe())} · ${Mag.value.toFixed(0)} µT, room baseline ${Mag.base.toFixed(0)} µT · ${Math.round(Mag.rate)} readings/s` : `<b>on</b> · ${esc(Mag.describe())} · learning the room baseline`],
      starting: ['', 'starting…'],
      flag: ['bad', `<b>switched off in Chrome</b> · open <code>${MAG_FLAG}</code>, set it to Enabled, relaunch Chrome`],
      denied: ['bad', '<b>permission denied</b>'],
      none: ['bad', '<b>not on this device</b>'],
      error: ['bad', '<b>could not start</b>'],
      off: ['', 'Magnetometer' in window ? 'available' : /Android/i.test(navigator.userAgent) ? `<b>needs a Chrome flag</b> · <code>${MAG_FLAG}</code>` : 'not available in this browser'],
    }[Mag.status] || ['', Mag.status];
    rows.push(['Magnetic', magRow[0], magRow[1]]);
    if (Light.ok) rows.push(['Light', 'ok', `<b>${Math.round(Light.lux)} lux</b> · light sensor`]);
    rows.push(['Orientation', Heading.ok ? 'ok' : '', Heading.ok ? `<b>on</b> · facing ${Math.round(Heading.yaw)}°, tilt ${Math.round(Heading.pitch)}° · turn-by-turn directions`
      : Native.available || 'RelativeOrientationSensor' in window ? 'available · starts with a full room scan' : 'not available: the agent steers by what it sees']);
    rows.push(['Radio', Radio && Radio.available ? 'ok' : '', Radio && Radio.available ? '<b>Wi-Fi, Bluetooth, network scans</b> · in the app' : 'needs the TwinGaze Android app']);
    const gdb = Guard && Guard.dbInfo ? Guard.dbInfo() : null;
    rows.push(['Phone check', Guard && Guard.available ? 'ok' : '', (Guard && Guard.available ? '<b>ready</b> · ' : 'needs the TwinGaze Android app · ') + (gdb ? `${gdb.stalkerware + gdb.watchware} known spyware apps` : 'list missing')]);
    rows.push(['Recogniser', Recog.ready ? 'ok' : Recog.error ? 'bad' : '',
      Recog.ready ? `<b>on</b> · ${Recog.ep === 'webgpu' ? 'GPU' : 'CPU'} · ${Math.round(Recog.avgMs)} ms per check` : Recog.error ? '<b>could not start</b> · ' + esc(Recog.error.message || Recog.error) : Recog.loading ? 'loading…' : 'loads when a scan starts']);
    if (st.running) {
      rows.push(['Screen', Wake.lock ? 'ok' : '', Wake.lock ? '<b>kept awake</b>' : 'may sleep']);
      rows.push(['Analysis', '', `${Math.round(st.fps)} fps · ${st.procMs.toFixed(1)} ms per frame at ${st.fw}×${st.fh}`]);
    }
    const html = rows.map(([k, c, v]) => `<dt>${k}</dt><dd class="${c}">${v}</dd>`).join('');
    $('#sensList').innerHTML = html;
    if (!$('#settings').hidden) $('#sensMirror').innerHTML = html;
  }

  /* ---------- home ---------- */
  function tileHtml(t) {
    const inApp = t.app === 'radio' ? Radio && Radio.available : t.app === 'guard' ? Guard && Guard.available : true;
    const badge = t.badge || (inApp ? '' : 'APP');
    return `<button class="tile${t.feature ? ' feature' : ''}" type="button" data-tool="${t.id}"><span class="t-ic ${t.g}"><svg><use href="#${t.icon}"/></svg></span>
      <span><b>${t.name}</b><small>${t.sub}</small></span>${badge ? `<span class="t-badge">${badge}</span>` : ''}</button>`;
  }
  function renderHome() {
    $('#rooms').innerHTML = Object.entries(ROOMS).map(([k, r]) =>
      `<button class="chip" type="button" data-room="${k}" aria-pressed="${k === st.room}">${r.name}</button>`).join('');
    $$('#rooms .chip').forEach(b => {
      b.onclick = () => { st.room = b.dataset.room; $$('#rooms .chip').forEach(c => c.setAttribute('aria-pressed', c === b)); save(); };
    });
    $('#homeTiles').innerHTML = HOME_TOOLS.map(id => tileHtml(TOOLS.find(t => t.id === id))).join('');
    $('#allTiles').innerHTML = TOOLS.map(tileHtml).join('');
    $$('[data-tool]').forEach(b => { b.onclick = () => runTool(b.dataset.tool, b.closest('#tools') ? 'tools' : 'home'); });
    const note = $('#homeNote');
    if (!window.isSecureContext) {
      note.hidden = false;
      note.innerHTML = `The camera only opens over <b>https</b>. You're on <code>${esc(location.origin)}</code>. Open the https link instead (see README: “Run it on your phone”).`;
    } else if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      note.hidden = false;
      note.textContent = 'This browser can\'t open the camera. Use Chrome on Android.';
    }
    refreshLocker();
  }

  /* every tile on Home and Tools lands here */
  function runTool(id, from) {
    st.backTo = from || st.tab || 'home';
    $('#homeNote').hidden = !!window.isSecureContext;
    if (id === 'full') startScan('camera', null, { mode: 'lens', full: true });
    else if (id === 'lens' || id === 'ir') startScan('camera', null, { mode: id, full: false });
    else if (id === 'mag') startMagnet();
    else if (id === 'wifi' || id === 'ble' || id === 'lan') openRadio(id);
    else if (id === 'mirror') openMirror();
    else if (id === 'video') $('#vidSheet').hidden = false;
    else if (id === 'sos') openSos();
    else if (id === 'guard') openGuard(st.backTo);
    else if (id === 'net') openNet(st.backTo);
  }

  /* a reference video: the file ships with the app, so it plays like a video picked from the phone */
  async function playReference(id) {
    const ref = REF_VIDEOS.find(r => r.id === id);
    $('#vidSheet').hidden = true;
    if (!ref) return;
    Beeper.unlock();                                   // still inside the tap
    try {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      startScan('file', new File([await res.blob()], ref.file, { type: 'video/mp4' }), { ref });
    } catch (e) { toast("The reference video couldn't be opened."); }
  }

  /* Settings → Voice: the voices installed on the phone for the chosen language */
  const VCODE = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };
  async function voiceChoices() {
    const r = await Native.voiceList(VCODE[Voice.lang]);
    const region = VCODE[Voice.lang].split('-')[1];
    // the distinct Indian speakers, offline (instant, no internet); the online copies are the same people
    const all = (r.voices || []).filter(v => v.quality >= 300);
    let list = all.filter(v => v.region === region && !v.network && !/-language$/.test(v.name));
    if (!list.length) list = all.filter(v => !v.network);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { list, current: r.current, online: r.online };
  }
  async function voiceRender() {
    if (!Native.available || !Native.voiceList) { $('#voiceRow').hidden = true; return; }
    const { list, current } = await voiceChoices();
    $('#voiceRow').hidden = list.length < 2;
    const i = list.findIndex(v => v.name === current);
    const v = list[i];
    $('#voiceName').textContent = v ? `Voice ${i + 1} of ${list.length}${v.network ? ' · online, most natural' : ' · works offline'}` : 'The phone\'s clearest voice';
  }
  async function nextVoice() {
    const { list, current } = await voiceChoices();
    if (!list.length) return;
    const i = list.findIndex(v => v.name === current);
    const next = list[(i + 1) % list.length];
    await Native.setVoice(VCODE[Voice.lang], next.name);
    await voiceRender();
    if (st.discreet) setDiscreet(false);
    if (!Voice.on) { Voice.on = true; Voice.mode = 'guide'; save(); syncSoundButtons(); }
    Voice.stop();
    Voice.sample();
  }
  function syncSoundButtons() {
    const vm = Voice.on ? Voice.mode : 'off';
    $$('[data-vm]').forEach(b => b.setAttribute('aria-pressed', b.dataset.vm === vm));
    $('#vmDesc').textContent = { off: 'Silent: everything is on screen', alerts: 'Alerts: only when something is found', guide: 'Guide: where to move, and what was found' }[vm];
    $('#cSound').setAttribute('aria-pressed', Beeper.on); $('#cSound').textContent = 'Beeper ' + (Beeper.on ? 'on' : 'off');
    $('#cDiscreet').setAttribute('aria-pressed', st.discreet); $('#cDiscreet').textContent = st.discreet ? 'On' : 'Off';
    const any = Voice.on || Beeper.on;
    ['#tSound', '#mSound'].forEach(q => { $(q).setAttribute('aria-pressed', any); $(q).textContent = st.discreet ? 'Discreet' : 'Sound ' + (any ? 'on' : 'off'); });
    $$('[data-lang]').forEach(b => b.setAttribute('aria-pressed', b.dataset.lang === Voice.lang));
    $$('[data-sens]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sens === st.sens));
    $('#sensDesc').textContent = sens().desc;
  }

  /* ---------- scan: start / stop ---------- */
  function resetScan() {
    Voice.newSession();
    st.tracker = new Tracker();
    st.stats = { seen: 0, glare: 0, lights: 0, cleared: 0, artifacts: 0, cameras: 0, tests: 0, recognised: 0, possible: 0 };
    st.possibles = [];
    st.seenIds = new Set(); st.session = []; st.checked = new Set();
    st.focusId = null; st.lastFocusId = null; st.focusSince = 0;
    st.guide = { key: null, since: 0, centered: false };
    st.flash = { phase: 'idle' };
    st.lastAlertT = -1e9; st.lastFoundSay = -1e9; st.lastProc = 0; st.fps = 0; st.procMs = 0; st.fw = 0; st.fh = 0; st.procIdx = 0; st.frameMs = 0; st.drawF = null;
    st.recog = { items: [], lastT: 0, nextId: 1 };
    st.scene = { items: [], seen: new Map(), lastT: 0, spotSaid: {}, checkMs: {}, done: new Set(), hit: new Set(), phones: [] };
    renderScene();
    st.events = []; st.bright = false; st.track = null; st.ms = { ok: false, delta: 0, base: null, rec: false }; st.meanEma = null; st.dark = false; st.darkTracks = []; st.darkEndT = 0;
    $('#alert').hidden = true; $('#evid').hidden = true;
    st.agentSum = null; st.nav = null;
    $('#agentCard').hidden = true; $('#radar').hidden = true;
    renderEvents();
    $('#log').innerHTML = '';
    const lbl = $('.sig[data-k="flash"] span');
    lbl.textContent = st.smode === 'ir' ? 'IR TINT' : 'FLASH';
  }

  async function startScan(source, file, opts = {}) {
    const id = ++st.runId;
    const cancelled = () => { if (id === st.runId) return false; Camera.stop(); return true; };   // Stop was tapped meanwhile
    Beeper.unlock();
    const motionP = source === 'camera' ? Motion.start() : Promise.resolve(false);   // iOS needs this inside the tap
    if (opts.mode) st.mode = opts.mode;
    st.full = source === 'camera' && !!opts.full;
    st.smode = source !== 'file' && st.mode === 'ir' ? 'ir' : 'lens';
    st.source = source;
    resetScan();
    st.ref = source === 'file' && opts.ref || null;
    if (source === 'camera') Heading.start();
    const isFile = source === 'file';
    $('#vidBar').hidden = !isFile;
    ['#tTorch', '#tRec', '#tMag'].forEach(q => { $(q).hidden = isFile; });
    $('.tools').classList.toggle('tools2', isFile);
    ['#railLabel', '#rail', '#railHint'].forEach(q => { $(q).hidden = isFile; });
    document.body.classList.add('scanning');
    show('scan');
    $('#where').textContent = isFile ? (st.ref ? 'Reference video' : 'Recorded video') : st.full ? 'Full scan · ' + ROOMS[st.room].name : (st.smode === 'ir' ? 'Night vision · ' : 'Lens finder · ') + ROOMS[st.room].name;
    renderRail();
    st.t0 = performance.now();
    loadRecognizer();
    Agent.start({ source, full: st.full, mode: st.smode, room: placeName() });
    log('SYS', `Scan started · ${esc(placeName())} · ${st.full ? 'full room scan (agent)' : st.smode === 'lens' ? 'lens scan (flash)' : 'night-vision scan (no flash)'} · ${source === 'file' ? 'recorded video' : 'live camera'} · sensitivity ${st.sens}`);
    setInstr('Starting', source === 'file' ? 'Opening the video' : 'Opening the camera', '');

    if (source === 'camera') {
      try {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw Object.assign(new Error('no camera API'), { name: 'NotSupportedError' });
        await Camera.start(video, { facing: 'environment' });
      } catch (e) { if (!cancelled()) cameraFailed(e); return; }
      if (cancelled()) return;
      if (st.smode === 'lens' && !Camera.hasTorch) {
        setInstr('Starting', 'Looking for the flash', 'Trying the other rear cameras.');
        await Camera.findTorchCamera(video);
        if (cancelled()) return;
      }
      st.torchAvail = Camera.hasTorch;
      watchTrack();
      log('SYS', `Camera: ${esc(camName())} · ${video.videoWidth}×${video.videoHeight} · flash ${Camera.hasTorch ? 'controllable' : 'NOT controllable'} · exposure ${Camera.hasExposure ? 'adjustable' : 'fixed'}`);
      Mag.start();
      Light.start();
      Wake.on();
      motionP.then(ok => setTimeout(() => {
        if (!st.running) return;
        if (Motion.ok) log('SYS', 'Gyroscope on: the angle test measures how far the phone turns.');
        else log('WARN', ok ? 'No gyroscope readings. The angle test will use how far the point moves across the frame.' : 'Motion sensor permission not given. The angle test will use image motion.');
      }, 1500));
      setTimeout(() => {
        if (!st.running) return;
        if (Mag.status === 'on') log('MAG', `Magnetic sensor on · room baseline ${Mag.base != null ? Mag.base.toFixed(0) + ' µT' : 'learning'}`);
        else if (Mag.status === 'flag') log('WARN', `Magnetic sensor is switched off in Chrome. Enable <code>${MAG_FLAG}</code> and relaunch to add the magnetic test.`);
        else log('WARN', 'No magnetic sensor available here. Scanning with the optical tests only.');
      }, 1800);
      await Camera.setTorch(false);
      if (cancelled()) return;
      st.lights = 'measure'; st.lightsT0 = performance.now(); st.lightsSamples = [];
      setInstr('Setup', 'Checking the light', 'Hold the phone still for a second.');
    } else {
      Camera.stop();
      st.lastFile = file;
      st.fileUrl = URL.createObjectURL(file);
      video.srcObject = null; video.src = st.fileUrl; video.loop = false; video.muted = true; video.playbackRate = 1;
      $('#vSpeed').textContent = '1×';
      try {
        await new Promise((res, rej) => { if (video.readyState >= 1) res(); else { video.onloadedmetadata = res; video.onerror = () => rej(video.error); } });
        await fixDuration();
        await video.play();
      } catch (e) { if (id !== st.runId) return; toast("This video can't be played here. Try an MP4 (H.264) or WebM file."); stopScan(); show('home'); return; }
      if (id !== st.runId) return;
      video.onended = () => { if (st.running) finish(); };
      st.torchAvail = false; st.lights = 'done';
      const recs = await DB.allRecs();
      if (id !== st.runId) return;
      st.track = recs.find(r => r.name === file.name && r.size === file.size) || recs.find(r => r.size === file.size) || null;
      if (st.track && !st.track.samples.length) st.track = null;
      log('SYS', `Video: ${esc(file.name)} · ${video.videoWidth}×${video.videoHeight}${isFinite(video.duration) ? ' · ' + video.duration.toFixed(1) + ' s' : ''}. Only what is in the frames counts: a recording has no live sensors. If the flash was switched off during the recording (TwinGaze records its flash tests), that is used as a flash test.`);
      if (st.ref) log('SYS', `Reference video: ${esc(st.ref.place)}. Known answer: ${esc(st.ref.what)}. It is analysed exactly like any other video; the answer is only compared at the end.`);
      if (st.track) log('SYS', `Found the sensor readings recorded with this video (${st.track.samples.length} samples, ${st.track.created.slice(0, 16).replace('T', ' ')}). Gyroscope, magnetic and flash readings play back in sync: real readings from the recording, not live ones.`);
      st.guide.key = 'vScan'; st.guide.since = performance.now(); guideInstr('vScan');
    }
    st.running = true;
    Beeper.start();
    renderSensors();
    loop();
  }

  /* MediaRecorder WebM files report an unknown (Infinity) duration until read to the end */
  async function fixDuration() {
    if (isFinite(video.duration)) return;
    await new Promise(res => {
      const done = () => { video.removeEventListener('durationchange', done); res(); };
      video.addEventListener('durationchange', done);
      video.currentTime = 1e101;
      setTimeout(done, 3000);
    });
    video.currentTime = 0;
  }

  function seekTo(t) {
    if (st.source !== 'file') return;
    const d = isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.max(0, d ? Math.min(t, d - 0.05) : t);
    st.tracker.reset(); st.focusId = null; st.meanEma = null; st.dark = false; st.darkTracks = [];
    Beeper.set(0, false);
  }

  /* a camera can drop out mid-scan (another app grabs it, the OS reclaims it): reopen it once */
  function watchTrack() {
    const tr = Camera.track;
    if (!tr) return;
    tr.addEventListener('ended', async () => {
      if (!st.running || st.source !== 'camera' || Camera.track !== tr || document.hidden) return;
      log('WARN', 'The camera stopped. Reopening it…');
      try { await Camera.start(video, Camera.deviceId ? { deviceId: Camera.deviceId } : { facing: 'environment' }); }
      catch (e) { cameraFailed(e); return; }
      st.tracker.reset(); watchTrack();
      if (st.lights === 'done' && MODES[st.smode].torch) Camera.setTorch(true);
    });
  }

  function cameraFailed(e) {
    const n = e && e.name;
    const msg = n === 'NotAllowedError' ? 'Camera permission was blocked. Tap the icon next to the address, allow Camera for this site, then try again.'
      : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera found on this device.'
      : n === 'NotReadableError' ? 'The camera is busy in another app. Close that app and try again.'
      : !window.isSecureContext ? 'The camera only opens over https. Open the https link of this app.'
      : 'Could not open the camera (' + esc(n || e) + ').';
    log('WARN', msg);
    stopScan();
    show('home');
    const note = $('#homeNote');
    note.hidden = false; note.innerHTML = msg;
  }

  // a scan, the magnetic sweep, the siren and a waiting fake call all keep the screen on; only the last one lets go
  function releaseWake() {
    let busy = st.running;
    try { busy = busy || !!MG.timer || siren.on || fake.state !== 'off'; } catch (e) { /* still starting up */ }
    if (!busy) Wake.off();
  }
  function stopScan() {
    stopRec();
    st.running = false;
    st.runId++;
    Beeper.stop(); Voice.stop();
    Camera.stop(); Motion.stop(); Mag.stop(); Heading.stop(); releaseWake();
    Mag.freeze = false;                                  // 6. a scan stopped during a flash test left drift tracking off
    if (Light.stop) Light.stop();                        // 7. the light sensor ran on after the first scan
    Agent.stop();
    try { video.pause(); } catch (e) { /* not playing */ }
    video.onended = null; video.srcObject = null; video.removeAttribute('src'); video.playbackRate = 1;
    if (st.fileUrl) { URL.revokeObjectURL(st.fileUrl); st.fileUrl = null; }
    $('#alert').hidden = true;
    document.body.classList.remove('scanning');
    st.flash = { phase: 'idle' };
    renderSensors();
  }

  async function finish() {
    if (!st.running) return;
    const dur = (performance.now() - st.t0) / 1000;
    st.lastVideoT = st.source === 'file' ? (video.ended && isFinite(video.duration) ? video.duration : video.currentTime) : 0;
    log('SYS', `Scan finished · ${fmtDur(dur)} · ${st.stats.seen} bright points examined · ${st.stats.glare} glare · ${st.stats.lights} lights · ${st.stats.cameras} camera${st.stats.cameras === 1 ? '' : 's'}`);
    st.agentSum = Agent.finish(st.stats);
    stopScan();
    if (st.saving.size) await Promise.all([...st.saving].map(p => p.catch(() => null)));   // photos still being saved
    st.lastDur = dur;
    const cams = st.session.filter(r => CAM_KINDS.has(r.kind)).length;
    if (st.ref) log('PLAN', `<b>Reference check</b> · found ${Math.min(cams, st.ref.cameras)} of the ${st.ref.cameras} known cameras${cams > st.ref.cameras ? ` · ${cams - st.ref.cameras} more than known: look at the saved photos` : ''}`);
    const a = st.agentSum;
    addHistory({
      kind: st.ref ? 'ref' : st.source === 'file' ? 'video' : st.full ? 'full' : 'room', room: st.ref ? st.ref.name : st.source === 'file' ? (st.lastFile ? st.lastFile.name : 'video') : ROOMS[st.room].name,
      risk: a ? a.risk : cams ? 'high' : 'low', head: cams ? `${cams} camera${cams > 1 ? 's' : ''} found` : 'No camera found',
      line: `${cams ? cams + ' camera' + (cams > 1 ? 's' : '') : 'no camera'} · ${fmtDur(dur)}${a && a.coverage != null ? ' · ' + a.coverage + '° swept' : ''}`,
      evidence: st.session.map(r => r.id), agent: a,
    });
    renderReport();
    show('report');
  }

  /* ---------- light check before the flash scan ---------- */
  function lightsTick(now, mean) {
    const el = now - st.lightsT0;
    if (el > 700 && mean >= 1) st.lightsSamples.push(mean);
    if (el < 1600 || (st.lightsSamples.length < 4 && el < 4500)) return;
    const s = st.lightsSamples, avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    const lux = Light.ok && Light.lux != null ? Light.lux : null;          // real lux when the light sensor is on
    const bright = lux != null ? lux > 30 : avg > 85;
    st.bright = bright;
    log('SEE', (lux != null ? `Room light ${Math.round(lux)} lux (light sensor) · ` : '') + `camera brightness with the flash off ${Math.round(avg)}/255 · ${bright ? 'lit room' : 'dark room'}`);
    beginDetect();
    Agent.onEnv({ bright, lux, mean: avg, torch: Camera.hasTorch, mode: st.smode, mag: Mag.ok || Mag.status === 'on', magSource: Mag.describe() });
  }

  async function beginDetect() {
    st.guide.key = 'start'; st.guide.since = performance.now();
    guideInstr('start');
    if (!st.full) Voice.say('start', { force: true });
    st.lights = 'done';
    if (st.source === 'camera') {
      if (Camera.hasExposure) {
        Camera.setExposure(st.bright ? -2 : MODES[st.smode].ev);
        if (st.bright) log('SYS', 'Lit room: exposure turned right down so a lens glint still stands out. Glints show from 1–2 m in a lit room, from across the room in the dark.');
      }
      if (MODES[st.smode].torch && Camera.hasTorch) {
        const ok = await Camera.setTorch(true);
        log(ok ? 'SYS' : 'WARN', ok ? 'Flash on. Lens scan running.' : 'The flash did not switch on.');
      } else if (MODES[st.smode].torch) log('WARN', 'This browser can\'t control the flash. Hold another light next to the camera, or use Night-vision scan.');
      else log('SYS', 'Flash off. Night-vision scan running.');
    }
  }

  /* ---------- the loop ---------- */
  function loop() {
    const next = () => {
      if (!st.running) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    function tick() {
      try { frame(); } catch (e) { console.error(e); }
      next();
    }
    next();
    // the overlay has its own loop at the screen's rate, so boxes and arrows move smoothly even when the
    // analysis runs slower; a slow phone draws every other screen frame
    const id = st.runId;
    let lastDraw = 0;
    const paint = t => {
      if (!st.running || id !== st.runId) return;
      if (t - lastDraw >= (st.frameMs > 16 ? 30 : 0)) {
        lastDraw = t;
        try { draw(performance.now(), st.drawF); } catch (e) { console.error(e); }
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
  }

  function frame() {
    const now = performance.now();
    // fast phones: every frame up to ~33 a second (as before); a phone that needs longer per frame analyses
    // fewer, keeping about half of each second free for the screen, the voice and your taps
    if (now - st.lastProc < Math.max(30, Math.min(90, (st.frameMs || 0) * 2.2))) return;
    const dt = st.lastProc ? Math.min(0.25, (now - st.lastProc) / 1000) : 0.033;
    st.lastProc = now;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    if (st.procIdx === 0 && st.procMs > 22 && now - st.t0 > 3000) {
      st.procIdx = 1;
      log('SYS', `This phone needs ${st.procMs.toFixed(0)} ms per frame; analysing at ${PROC_SIZES[1]} px to keep up.`);
    }
    const sc = Math.min(1, PROC_SIZES[st.procIdx] / Math.max(vw, vh));
    const w = Math.round(vw * sc), h = Math.round(vh * sc);
    if (pc.width !== w || pc.height !== h) { pc.width = w; pc.height = h; st.tracker.reset(); }
    const t1 = performance.now();
    pctx.drawImage(video, 0, 0, w, h);
    const D = MODES[st.smode].detect, k = sens().det;
    const res = detect(pctx.getImageData(0, 0, w, h).data, w, h, { minPeak: D.minPeak * Math.min(1, k + 0.1), minContrast: D.minContrast * k, minRatio: D.minRatio });
    const ms = performance.now() - t1;
    st.procMs = st.procMs ? st.procMs * 0.9 + ms * 0.1 : ms;
    st.fps = st.fps ? st.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;
    st.fw = w; st.fh = h; st.lastMean = res.mean;

    if (st.lights !== 'done') { lightsTick(now, res.mean); st.drawF = null; ui(now, null, 0); return; }

    const sn = sensorsNow();
    if (Rec.mr && now - Rec.lastSample >= 50) recSample(now);
    const dark = st.source === 'file' ? darkTick(now, res, sn.torch) : false;
    const freeze = st.flash.phase !== 'idle' || dark;
    const removed = st.tracker.update(res.dets, {
      t: now, dt, w, h, rot: sn.rot, rotRate: sn.rate, freeze, allowNew: !freeze,
      maxNewArea: 60 * areaK(),
    });
    removed.forEach(lost);
    for (const t of st.tracker.tracks) assess(t, now);
    recognizeTick(now);
    sceneCheck(now, dt);
    flashTick(now, res.dets);
    const f = pickFocus(now);
    probeMag(f, now);
    agentTick(now, dt, f, vw, vh);
    guide(f, now);
    const lvl = level(f);
    Beeper.set(lvl, !!(st.guide.target && st.guide.target.cam && st.guide.centered));
    st.drawF = f;
    ui(now, f, lvl);
    const took = performance.now() - now;
    st.frameMs = st.frameMs ? st.frameMs * 0.85 + took * 0.15 : took;
  }

  /* ---------- hand the frame's findings to the agent ---------- */
  const fovOf = (vw, vh) => ({ fovH: FOV * vw / Math.max(vw, vh), fovV: FOV * vh / Math.max(vw, vh) });
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
  /* the direction of a point in the frame, from the orientation sensor: { yaw, pitch } or null */
  function headingOf(x, y) {
    if (st.source !== 'camera' || !Heading.ok) return null;
    const fv = fovOf(video.videoWidth || 9, video.videoHeight || 16);
    return { yaw: ((Heading.yaw + (x - 0.5) * fv.fovH) % 360 + 360) % 360, pitch: Heading.pitch + (0.5 - y) * fv.fovV };
  }
  const knownCamera = (hd, tol = 12, skip) => hd && st.events.find(e => e.hd && !(skip && skip(e)) && Math.abs(angDiff(e.hd.yaw, hd.yaw)) < tol && Math.abs(e.hd.pitch - hd.pitch) < tol);
  // a camera found by its shape that is in view right now, somewhere else in the picture than `it`: two domes
  // a few degrees apart on one ceiling are two cameras, even though their directions and times are close
  const inViewApart = (e, it, now) => {
    const o = st.recog.items.find(x => 'R' + x.id === e.id);
    return !!o && o !== it && now - o.lastT < 1500 && Math.hypot(o.x - it.x, o.y - it.y) > 1.5 * Math.max(o.w, o.h, it.w, it.h);
  };
  // the same for a lens found by its glint: its point is still tracked and in view, somewhere else in the picture
  const glintApart = (e, x, y) => {
    if (typeof e.id !== 'number') return false;
    const o = st.tracker.tracks.find(t => t.id === e.id && t.visible);
    return !!o && Math.hypot(o.x - x, o.y - y) > 0.06;
  };
  // Found here before? Directions are compared within 18°: stepping sideways for the angle test and coming back
  // later from another spot moves a lens's direction by up to ~17° (it was 12°, so a lens was sometimes reported twice)
  const knownLens = (hd, x, y, now) => knownCamera(hd, 18, e => glintApart(e, x, y) || inViewApart(e, { x, y, w: 0, h: 0 }, now));
  function agentTick(now, dt, f, vw, vh) {
    if (st.source !== 'camera') return;
    if (st.blackSince && now - st.blackSince > 1000) return;     // the camera sees nothing: nothing is covered
    const fv = fovOf(vw, vh);
    Agent.tick(now, {
      dt, rate: Motion.ok ? Motion.rate : 0, focus: !!f, found: st.guide.key === 'found', torch: Camera.torchOn,
      items: st.scene.items.filter(it => now - it.t < 1500), done: st.scene.done, hit: st.scene.hit,
      mag: st.ms.ok && st.flash.phase === 'idle' ? Math.abs(st.ms.delta) : null, fovH: fv.fovH, fovV: fv.fovV,
    });
  }

  /* ---------- where the magnetic + gyroscope readings come from ----------
   * Live: the phone's sensors. A recorded video: the readings saved with it while it was
   * recorded (real readings from that moment, played back in sync). A video from elsewhere: none. */
  function sensorsNow() {
    if (st.source === 'camera') {
      st.ms = { ok: Mag.ok && Mag.base != null, delta: Mag.delta, base: Mag.base, rec: false };
      return { rot: Motion.ok ? Motion.rot : null, rate: Motion.rate, torch: null };
    }
    if (!st.track) { st.ms = { ok: false, delta: 0, base: null, rec: false }; return { rot: null, rate: 0, torch: null }; }
    const a = trackAt(video.currentTime), b = trackAt(video.currentTime - 0.1);
    st.ms = { ok: a.m != null && st.track.base != null, delta: a.m || 0, base: st.track.base, rec: true };
    const rate = a.r && b.r ? Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]) / 0.1 : 0;
    return { rot: a.r, rate, torch: a.f };
  }
  function trackAt(t) {
    const S = st.track.samples;
    let lo = 0, hi = S.length - 1;
    if (hi < 0) return {};
    if (t <= S[0].t) return S[0];
    if (t >= S[hi].t) return S[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].t <= t) lo = mid; else hi = mid; }
    return S[lo];
  }
  function trackTurned(sec) {
    if (!st.track) return 0;
    const a = trackAt(video.currentTime), b = trackAt(video.currentTime - sec);
    return a.r && b.r ? Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]) : 0;
  }

  /* ---------- evidence per point ---------- */
  function closeness(t) {
    return clamp01(0.5 * clamp01(t.d / 180) + 0.5 * clamp01((Math.sqrt(t.area / areaK()) - 1) / 8));
  }

  function assess(t, now) {
    t.visible = t.hits >= 4 && t.hits / t.frames >= 0.5;
    if (t.visible && !st.seenIds.has(t.id)) {
      st.seenIds.add(t.id);
      const known = knownLens(headingOf(t.x, t.y), t.x, t.y, now);
      if (known) {                   // the camera found earlier, seen again after turning round: no second test, no second alarm
        t.status = 'camera'; t.foundT = now - 10000; t.score = Math.max(t.score || 0, known.score);
        log('SEE', `#${t.id} is the camera found earlier at ${Math.round(known.hd.yaw)}°`);
        return;
      }
      st.stats.seen++;
      log('SEE', `Point #${t.id} · ${Math.round(t.d)} brighter than its surroundings · ${Math.round(t.area / areaK())} px`);
    }
    const sp = spans(t, st.fw, st.fh, FOV);
    // with the orientation sensor: how much the viewing angle really changed (turning on the spot doesn't
    // change it, moving sideways does); without it: how far the phone turned or the point crossed the picture
    const view = viewTrack(t);
    const angleDeg = view != null ? view : Math.max(sp.gyro, sp.disp);
    anchorTrack(t);
    const sizeF = t.area <= 30 * areaK() ? 1 : t.area <= 90 * areaK() ? 0.75 : 0.45;
    const glint = clamp01((t.d - 30) / 120) * sizeF;
    const angle = clamp01(angleDeg / (view != null ? 10 : 18));   // real sideways movement counts for more than turning
    const persist = clamp01((t.hits - 3) / 25) * clamp01(t.hits / t.frames / 0.8);
    const mag = st.ms.ok && t.magPeak != null ? clamp01((t.magPeak - 5) / 35) : null;
    const tint = clamp01((Math.min(t.r, t.b) - t.g + 10) / 50);
    const white = Math.min(t.r, t.g, t.b) / Math.max(1, t.r, t.g, t.b);   // a flash reflection is white; indicator LEDs are coloured
    const torchTest = st.smode === 'lens' && st.source === 'camera' && st.torchAvail;
    if (t.darkPass && t.flash == null && t.lastT > st.darkEndT) {
      t.flash = 1; t.darkPass = false;
      log('TEST', `#${t.id} went dark when the flash went off in the recording, and came back: a reflection, lens-like`);
    }
    const flashKnown = torchTest || (st.smode === 'lens' && t.flash === 1);
    let optical;
    if (st.smode === 'ir') optical = 0.30 * glint + 0.35 * angle + 0.20 * persist + 0.15 * tint;
    else if (flashKnown) optical = 0.25 * glint + 0.35 * angle + 0.25 * (t.flash === 1 ? 1 : 0) + 0.15 * persist;
    else optical = 0.35 * glint + 0.45 * angle + 0.20 * persist;
    t.score = optical + (1 - optical) * 0.6 * (mag || 0);
    const slipDeg = t.anc && !t.anc.flat && t.anc.n >= 8 ? t.anc.slip * FOV / Math.max(st.fw, st.fh) : null;
    t.sig = { glint, angle, angleDeg, view, gyroDeg: sp.gyro, dispDeg: sp.disp, persist, mag, tint, white, torchTest, flashKnown, slipDeg };

    if ((DISMISSED.has(t.status) && t.status !== 'possible') || t.status === 'camera') return;
    // the shine slid across the surface under it as the phone moved: a reflection on something shiny
    if (slipDeg != null && slipDeg >= Math.max(2, 0.35 * (view || 0) + 1.2)) {
      t.status = 'glare'; st.stats.glare++;
      if (st.focusId === t.id) st.focusId = null;
      Agent.onEvent('resolved', { id: t.id, why: 'glare' });
      log('CLEAR', `#${t.id} slid ${slipDeg.toFixed(1)}° across the surface under it as the phone moved: a reflection on something shiny, not a lens`);
      if (t.id === st.lastFocusId) Voice.say('glare', { repeatMs: 8000 });
      return;
    }
    t.anchored = slipDeg != null && view != null && view >= 6 && slipDeg <= 0.2 * view + 0.8;
    if (t.status === 'possible') {                  // a possible lens becomes a camera when a second sign turns up
      const why = secondSign(t, now);
      if (why) confirmCamera(t, now, why);
      return;
    }
    // fixed to the screen while the phone turned: a mark on the lens or sensor, not something in the room
    if ((st.source === 'camera' ? Motion.ok : !!st.track) && sp.gyro >= 8 && sp.disp < 1.2) {
      t.status = 'artifact'; st.stats.artifacts++;
      log('CLEAR', `#${t.id} stayed fixed on the screen while the phone turned ${Math.round(sp.gyro)}°: a mark on the camera, not in the room`);
      return;
    }
    const S = sens(), need = needAngle(t);
    let lensLike;
    if (st.smode === 'ir') lensLike = t.score >= 0.72 + S.conf && angleDeg >= need && persist >= 0.7 && tint >= 0.35;
    // with the flash in our hands, the second flash test (after moving) must have passed too, and a test
    // still running on this point blocks any verdict: a later "it keeps shining" overrules the first test
    const testing = st.flash.phase !== 'idle' && st.flash.id === t.id;
    const twice = !torchTest || (t.flashOk || 0) >= 2 || t.flashTries >= 4;
    if (st.smode !== 'ir' && flashKnown) lensLike = t.flash === 1 && twice && !testing && angleDeg >= need && glint >= 0.3 && persist >= 0.5 && t.score >= 0.72 + S.conf;
    else if (st.smode !== 'ir') lensLike = angleDeg >= need && glint >= 0.4 && persist >= 0.7 && white >= 0.4 && t.score >= 0.75 + S.conf;
    t.optical = lensLike;
    // a glint alone can't tell a lens from a tiny shiny bead or screw head: "Camera found" needs a second,
    // independent sign (the night-vision tint, a phone or camera shape at the spot, or a magnetic jump there).
    // Without one, the point is reported as a possible lens once every test has run (see guide()).
    const why = lensLike ? (st.smode === 'ir' ? 'ir' : secondSign(t, now)) : null;
    if (why) confirmCamera(t, now, why);
    else if (lensLike && st.source === 'file') markPossible(t, now);    // a recording can't be asked for more
    else {
      t.status = !t.visible ? 'new' : t.score >= SUSPECT ? 'suspect' : 'checking';
      if (t.status === 'suspect' && !t.agentTold) { t.agentTold = true; Agent.onEvent('suspect', { id: t.id, x: t.x, fovH: fovOf(st.fw, st.fh).fovH }); }
    }
  }

  /* the viewing-angle change a point needs before its angle test passes (degrees) */
  function needAngle(t) {
    const S = sens(), view = t.sig && t.sig.view != null;
    if (st.smode === 'ir') return (view ? 6 : 10) + S.ang;
    // in a recording the flash test is the strongest evidence left (no gyroscope), so less movement is asked for
    if (t.sig && t.sig.flashKnown) return (view ? 6 : st.source === 'file' && !st.track ? 7 : 10) + S.ang;
    return (view ? 8 : 14) + S.ang;
  }
  /* the point's direction in the room (orientation sensor + where it sits in the picture), sampled while the
   * phone moves slowly. It changes when the phone moves sideways, not when it turns on the spot. */
  function viewTrack(t) {
    if (st.source !== 'camera' || !Heading.ok) return null;
    // pointing almost straight up or down the direction can't be read reliably: use the turn instead
    if (!t.view && Math.abs(Heading.pitch) >= 70) return null;
    if (t.visible && t.lastT === st.lastProc && st.flash.phase === 'idle' && (!Motion.ok || Motion.rate < 15) && Math.abs(Heading.pitch) < 70) {
      const hd = headingOf(t.rx, t.ry);
      if (hd) {
        const V = t.view || (t.view = { yaw0: hd.yaw, lo: 0, hi: 0, plo: hd.pitch, phi: hd.pitch });
        const dy = angDiff(hd.yaw, V.yaw0) * Math.cos(hd.pitch * Math.PI / 180);
        if (dy < V.lo) V.lo = dy;
        if (dy > V.hi) V.hi = dy;
        if (hd.pitch < V.plo) V.plo = hd.pitch;
        if (hd.pitch > V.phi) V.phi = hd.pitch;
      }
    }
    return t.view ? Math.max(t.view.hi - t.view.lo, t.view.phi - t.view.plo) : 0;
  }
  /* follow the textured surface around the point (see anchor() in detector.js) */
  function anchorTrack(t) {
    if (!t.visible || t.lastT !== st.lastProc || st.flash.phase !== 'idle' || (DISMISSED.has(t.status) && t.status !== 'possible') || t.status === 'camera') return;
    if (!t.anc && t.id !== st.focusId && t.score < 0.2) return;
    if (Motion.ok && Motion.rate > 30) return;       // fast turns blur the surface: wait for the phone to slow down
    const F = TGDetector.lastV();
    if (!F.V || F.w !== st.fw || F.h !== st.fh) return;
    t.anc = TGDetector.anchor(t.anc, F.V, F.w, F.h, t.rx * F.w, t.ry * F.h);
  }
  /* a second, independent sign that a lens-like glint is a camera */
  function secondSign(t, now) {
    const dev = phoneAt(t.x, t.y, now);
    if (dev) return dev.label === 'Phone' ? 'phone' : 'device';
    if (st.recog.items.some(it => now - it.lastT < 1500 && it.score >= 0.45 && it.hist.reduce((a, b) => a + b, 0) >= 2
      && Math.abs(t.x - it.x) < it.w * 0.6 + 0.02 && Math.abs(t.y - it.y) < it.h * 0.6 + 0.02)) return 'shape';
    if ((t.magPeak || 0) >= 8) return 'magnetic';
    return null;
  }
  /* every test ran and the glint still looks like a lens, but nothing else confirms it */
  async function markPossible(t, now) {
    t.status = 'possible'; t.possibleT = now;
    const hd = headingOf(t.x, t.y);
    if (hd && st.possibles.some(p => p.hd && Math.abs(angDiff(p.hd.yaw, hd.yaw)) < 12 && Math.abs(p.hd.pitch - hd.pitch) < 12)) {
      log('SEE', `#${t.id} is the possible lens already saved at this spot`);
      return;
    }
    st.possibles.push({ hd, id: t.id });
    st.stats.possible++;
    log('FOUND', `<b>#${t.id} could be a lens</b> · ${sigText(t)} · nothing else confirms it (no camera shape, no magnetic jump): look at it closely`);
    Agent.onEvent('possible', Object.assign({ id: t.id }, hd));
    vib([120, 80, 120]);
    t.evidence = await saveEvidence(t, 'possible');
    toast('Possible lens: photo saved. Look at it closely.');
  }

  function lost(t) {
    if (st.focusId === t.id) st.focusId = null;
    if (!t.visible || DISMISSED.has(t.status) || t.status === 'camera') return;
    const edge = t.x < 0.07 || t.x > 0.93 || t.y < 0.07 || t.y > 0.93;
    const turned = st.source === 'file' ? trackTurned(0.6) : Motion.ok ? Motion.turnedWithin(600) : 0;
    const ang = t.sig.angleDeg || 0;
    if (!edge && turned >= 2 && ang < 10 && t.hits >= 6) {
      st.stats.glare++;
      Agent.onEvent('resolved', { id: t.id, why: 'glare' });
      log('CLEAR', `#${t.id} vanished when the phone turned ${turned.toFixed(0)}° (held only ${ang.toFixed(0)}°): glare, not a lens`);
      if (t.id === st.lastFocusId) Voice.say('glare', { repeatMs: 8000 });
    }
  }

  /* why a point that went through every test still isn't a camera */
  function verdict(t) {
    const s = t.sig, sc = t.score.toFixed(2);
    if (s.persist < (st.smode === 'lens' && s.flashKnown ? 0.5 : 0.7)) return 'it kept flickering in and out';
    if (st.smode === 'ir') return s.tint < 0.35 ? 'a steady light without the purple infrared tint: likely an indicator LED' : `score ${sc} stayed under 0.72`;
    if (s.torchTest && t.flash == null) return 'the flash test never gave a clear answer';
    if (!s.flashKnown && s.white < 0.4) return 'a coloured light (an indicator LED), not a white lens reflection';
    if (s.glint < (s.flashKnown ? 0.3 : 0.4)) return `it held ${Math.round(s.angleDeg)}° but the glint was too faint to be a lens`;
    return `score ${sc} stayed under the camera threshold`;
  }
  function clearTrack(t, why) {
    t.status = 'clear'; st.stats.cleared++;
    if (st.focusId === t.id) st.focusId = null;
    Agent.onEvent('resolved', { id: t.id, why: 'not a camera' });
    log('CLEAR', `#${t.id} checked, not a camera: ${why}`);
    Voice.say('notCam', { force: true });
  }

  /* the point the guide steers to. In a busy room (lamps, laptops, glossy desks) dozens of points shine
   * back: only one near the middle that has lasted a moment is worth an instruction, and once chosen it is
   * kept until it is resolved or gone, so the directions don't jump from point to point. */
  function pickFocus(now) {
    const dist = t => Math.max(Math.abs(t.x - 0.5), Math.abs(t.y - 0.5));   // 0 = centre, 0.5 = edge of the picture
    const cur = st.focusId != null ? st.tracker.tracks.find(t => t.id === st.focusId) : null;
    if (cur && !cur.visible && cur.missMs < 800 && !DISMISSED.has(cur.status) && !reported(cur, now)) return cur;   // a blink: keep it
    let best = null, bestS = -1;
    for (const t of st.tracker.tracks) {
      const fresh = t.status === 'possible' && now - t.possibleT < 7000;
      if (!t.visible || (DISMISSED.has(t.status) && !fresh) || reported(t, now)) continue;
      const imp = t.status === 'camera' || fresh, keep = t.id === st.focusId, d = dist(t);
      if (!imp && (keep ? d > 0.42 : d > 0.25 || t.hits < 8 || t.score < 0.2)) continue;   // new ones: the central half only
      const s = t.score + (t.status === 'camera' ? 0.5 : fresh ? 0.4 : 0) + (keep ? 0.3 : 0) - 0.3 * d;
      if (s > bestS) { bestS = s; best = t; }
    }
    const id = best ? best.id : null;
    if (id !== st.focusId) st.focusSince = now;
    st.focusId = id;
    if (best) st.lastFocusId = best.id;
    return best;
  }

  function probeMag(f, now) {
    if (!f || !st.ms.ok || st.flash.phase !== 'idle' || !st.guide.centered) return;
    const d = Math.abs(st.ms.delta);
    if (f.magPeak == null || d > f.magPeak) {
      const was = f.magPeak;
      f.magPeak = d;
      if (d >= 8 && (was == null || was < 8)) log('MAG', `+${d.toFixed(0)} µT at #${f.id} (room baseline ${st.ms.base.toFixed(0)} µT${st.ms.rec ? ', recorded' : ''}): electronics or metal close by`);
      // a camera already confirmed: add the magnetic reading to its saved evidence
      const rec = f.evidence;
      if (rec && rec.sig && d >= 8 && d >= (rec.sig.magPeak || 0) + 2) {
        rec.sig.magPeak = Math.round(d);
        clearTimeout(rec.saveT);
        rec.saveT = setTimeout(() => {           // save once the reading settles
          delete rec.saveT;
          DB.put(rec);
          log('SAVE', `Evidence for #${f.id} updated: magnetic +${rec.sig.magPeak} µT at the spot`);
        }, 900);
      }
    }
    if (closeness(f) >= 0.6 || (st.guide.key === 'closer' && now - st.guide.since > 5000)) f.magProbed = true;
  }

  /* ---------- flash test: switch the flash off, then on again ----------
   * A lens (or any reflection) goes dark when the flash goes off and comes back with it.
   * An LED, a lamp, a screen keeps shining: it makes its own light. */
  function startFlash(t, now) {
    st.flash = { phase: 'switching', id: t.id, x: t.x, y: t.y, offSeen: 0, offN: 0, onSeen: 0, onN: 0, t0: now };
    t.flashTries++; t.lastFlashT = now; st.stats.tests++;
    Mag.freeze = true;                                   // switching the flash itself nudges the magnetometer
    log('TEST', `Flash test on #${t.id}: flash off, then on`);
    const F = st.flash;
    Camera.setTorch(false).then(ok => {
      if (st.flash !== F || F.phase !== 'switching') return;
      if (!ok) { log('WARN', 'The phone refused to switch the flash off; skipping the flash test.'); t.flashTries = 3; endFlash(); return; }
      F.phase = 'off-settle'; F.t0 = performance.now();
    });
  }
  function flashTick(now, dets) {
    const F = st.flash;
    if (F.phase === 'idle') return;
    if (F.phase === 'switching' || F.phase === 'switching-on') {
      if (now - F.t0 > 2500) { log('WARN', 'The flash took too long to switch; test abandoned.'); endFlash(); }   // watchdog
      return;
    }
    const t = st.tracker.tracks.find(k => k.id === F.id);
    if (!t) { endFlash(); return; }
    const L = Math.max(st.fw, st.fh);
    const near = dets.some(d => Math.hypot((d.x - F.x) * st.fw / L, (d.y - F.y) * st.fh / L) < 0.05);
    const el = now - F.t0;
    if (F.phase === 'off-settle' && el > 400) { F.phase = 'off-observe'; F.t0 = now; }
    else if (F.phase === 'off-observe') {
      F.offN++; if (near) F.offSeen++;
      if (el > 500) {
        F.phase = 'switching-on'; F.t0 = now;
        Camera.setTorch(true).then(() => { if (st.flash === F) { F.phase = 'on-settle'; F.t0 = performance.now(); } });
      }
    } else if (F.phase === 'on-settle' && el > 450) { F.phase = 'on-observe'; F.t0 = now; }
    else if (F.phase === 'on-observe') {
      F.onN++; if (near) F.onSeen++;
      if (el > 450) finishFlash(t, F);
    }
  }
  function finishFlash(t, F) {
    const offR = F.offN ? F.offSeen / F.offN : 1, onR = F.onN ? F.onSeen / F.onN : 0;
    const counts = `seen ${F.offSeen}/${F.offN} frames with the flash off, ${F.onSeen}/${F.onN} with it on`;
    if (F.offN >= 3 && F.onN >= 3 && offR <= 0.25 && onR >= 0.5) {
      t.flash = 1; t.flashOk = (t.flashOk || 0) + 1;
      log('TEST', t.flashOk > 1 ? `#${t.id} passed the flash test again after moving: the same reflection (${counts})`
        : `#${t.id} went dark with the flash and came back: it's a reflection, lens-like (${counts})`);
    } else if (F.offN >= 3 && offR >= 0.6) {
      t.flash = 0; t.status = 'light'; st.stats.lights++;
      Agent.onEvent('resolved', { id: t.id, why: 'light' });
      log('CLEAR', `#${t.id} kept shining with the flash off: a lamp, LED or screen, not a lens (${counts})`);
      Voice.say('light', { repeatMs: 8000 });
    } else log('TEST', `#${t.id}: inconclusive, probably moved (${counts})`);
    endFlash();
  }
  function endFlash() {
    st.flash = { phase: 'idle' };
    st.lastFlashEnd = performance.now();
    Mag.freeze = false;
    if (st.running && st.source === 'camera' && MODES[st.smode].torch && Camera.hasTorch && !Camera.torchOn) Camera.setTorch(true);
  }

  /* ---------- confirmation ---------- */
  function sigText(t) {
    const s = t.sig, out = [];
    if (s.torchTest || t.flash === 1) out.push(t.flash === 1 ? `flash test passed${t.flashOk > 1 ? ' twice' : ''}` : 'flash test —');
    if (st.smode === 'ir') out.push('IR tint ' + s.tint.toFixed(2));
    out.push(s.view != null ? `held while moving ${Math.round(s.angleDeg)}° sideways` : `held ${Math.round(s.angleDeg)}°`);
    if (t.anchored) out.push('stays on its object');
    out.push('glint ' + s.glint.toFixed(2));
    if (t.magPeak != null && t.magPeak >= 8) out.push(`magnetic +${t.magPeak.toFixed(0)} µT`);
    return out.join(' · ');
  }

  async function confirmCamera(t, now, why) {
    t.status = 'camera'; t.foundT = now; t.why = why;
    const at = st.source === 'file' ? video.currentTime : (now - st.t0) / 1000;
    // the same camera found again (seeking back in a video, or sweeping back over it live) counts once;
    // live, "the same" = the phone points within 15° of where it pointed last time (gyroscope)
    const dir = st.source === 'camera' && Motion.ok ? Motion.rot.slice() : null;
    const hd = headingOf(t.x, t.y);
    const same = st.source === 'file'
      ? st.events.some(e => Math.abs(e.at - at) < 3)
      : hd ? !!knownLens(hd, t.x, t.y, now) : dir && st.events.some(e => e.dir && Math.hypot(e.dir[0] - dir[0], e.dir[1] - dir[1], e.dir[2] - dir[2]) < 15);
    if (same) { t.foundT = now - 10000; log('SEE', `#${t.id} is the camera already found at this spot`); return; }
    st.stats.cameras++;
    const dev = phoneAt(t.x, t.y, now), phone = dev && dev.label === 'Phone' ? dev : null;
    const kind = phone ? 'phonecam' : dev ? 'devicecam' : st.smode === 'ir' ? 'ircam' : 'camera';
    t.device = dev ? dev.label : null;
    st.events.push({ at, dir, hd, id: t.id, kind: phone ? 'Phone camera' : dev ? devTitle(dev.label) : st.smode === 'ir' ? 'Camera light' : 'Camera lens', score: t.score });
    renderEvents();
    const also = why === 'shape' ? ' · a camera shape is recognised at the spot' : why === 'magnetic' ? ' · electronics behind it (magnetic)' : '';
    log('FOUND', phone ? `<b>#${t.id} is a phone's camera lens, pointed this way</b> · score ${t.score.toFixed(2)} · ${sigText(t)}`
      : dev ? `<b>#${t.id} is the camera of a ${esc(dev.label.toLowerCase())} (recognised at the spot), pointed this way</b> · score ${t.score.toFixed(2)} · ${sigText(t)}`
        : `<b>#${t.id} is a camera ${st.smode === 'ir' ? 'light' : 'lens'}</b> · score ${t.score.toFixed(2)} · ${sigText(t)}${also}`);
    Agent.onEvent('camera', Object.assign({ kind, why, device: dev ? dev.label : null }, hd));
    vib([220, 90, 220, 90, 420]);
    if (phone) Voice.sayText(Voice.line('phoneFound'), { key: 'phoneFound', force: true }); else Voice.say('found', { force: true });
    st.lastFoundSay = now;
    const run = st.runId;
    const rec = await saveEvidence(t, kind);
    t.evidence = rec;
    if (st.running && run === st.runId && now - st.lastAlertT > 12000) { st.lastAlertT = now; openAlert(t, rec, dev); }
  }
  /* a phone or other camera-carrying device (laptop, tablet, monitor, camera) recognised where this point is:
   * by direction when the orientation sensor is on (the device may have moved in the picture during the
   * sideways test), else by position in the picture. A laptop or monitor counts only for a point in its
   * top bezel, where the webcam is. */
  function phoneAt(x, y, now) {
    const S = st.scene;
    S.phones = S.phones.filter(p => now - p.t < 8000);
    const hd = headingOf(x, y), fv = fovOf(video.videoWidth || 9, video.videoHeight || 16);
    return S.phones.slice().reverse().find(p => {
      if (p.score < 0.45) return false;          // a 30% "laptop" is not proof of a laptop's camera
      let u, v;                                   // the point's place in the box, in box sizes from its centre
      if (hd && p.hd) {
        u = angDiff(hd.yaw, p.hd.yaw) / Math.max(8, p.w * fv.fovH);
        v = (p.hd.pitch - hd.pitch) / Math.max(8, p.h * fv.fovV);
      } else {
        if (now - p.t > 3000) return false;
        u = (x - p.x) / Math.max(0.05, p.w); v = (y - p.y) / Math.max(0.05, p.h);
      }
      if (p.where === 'top') return Math.abs(u) < 0.35 && v > -0.62 && v < -0.15;
      return Math.abs(u) < 0.7 && Math.abs(v) < 0.7;
    }) || null;
  }

  function saveEvidence(t, kind, box) {
    const p = saveEvidenceNow(t, kind, box);
    st.saving.add(p);
    p.then(() => st.saving.delete(p), () => st.saving.delete(p));
    return p;
  }
  async function saveEvidenceNow(t, kind, box) {
    const iw = video.videoWidth, ih = video.videoHeight;
    if (!iw) return null;
    const cv = document.createElement('canvas');
    cv.width = iw; cv.height = ih;
    const x = cv.getContext('2d');
    x.drawImage(video, 0, 0, iw, ih);
    const marks = t ? [t] : box ? [] : st.tracker.tracks.filter(k => k.visible && !DISMISSED.has(k.status));
    if (box) {
      x.strokeStyle = '#EE3A4F'; x.lineWidth = Math.max(4, Math.min(iw, ih) / 160);
      x.strokeRect((box.x - box.w / 2) * iw, (box.y - box.h / 2) * ih, box.w * iw, box.h * ih);
    }
    const k = st.fw ? iw / st.fw : 1;
    marks.forEach(m => brackets(x, m.x * iw, m.y * ih, Math.max(Math.min(iw, ih) * 0.06, Math.sqrt(m.area) * k * 1.6 + 12),
      m.status === 'camera' ? '#EE3A4F' : m.status === 'possible' ? '#E8772E' : '#FDCF58', Math.max(4, Math.min(iw, ih) / 160)));
    const when = new Date();
    const bar = Math.round(Math.max(28, ih * 0.045));
    x.fillStyle = 'rgba(0,0,0,.75)'; x.fillRect(0, ih - bar, iw, bar);
    x.fillStyle = '#fff'; x.textBaseline = 'middle';
    x.font = `${Math.round(bar * 0.42)}px "JetBrains Mono", Consolas, monospace`;
    const what = t ? `${kind === 'ircam' ? 'IR light' : kind === 'phonecam' ? 'phone camera lens' : kind === 'devicecam' ? (t.device || 'device').toLowerCase() + ' camera lens' : kind === 'possible' ? 'possible lens' : 'lens'} · score ${t.score.toFixed(2)} · ${sigText(t)}`
      : box ? `camera recognised by its shape · ${Math.round(box.score * 100)}% sure` : 'photo saved by the user';
    x.fillText(`TwinGaze · ${when.toLocaleString('en-IN')} · ${what}`, bar * 0.4, ih - bar / 2, iw - bar * 0.8);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return null;
    const hash = await sha256(blob);
    const rec = {
      id: 'ev' + when.getTime() + '-' + (t ? t.id : box ? 'r' + box.id : 'm'), time: when.toISOString(), kind,
      room: placeName(), mode: st.smode, source: st.source,
      score: t ? +t.score.toFixed(2) : box ? +box.score.toFixed(2) : null,
      sig: box ? { shape: +box.score.toFixed(2) } : t ? { flash: t.flash, flashOk: t.flashOk || 0, angleDeg: Math.round(t.sig.angleDeg), moved: t.sig.view != null, anchored: !!t.anchored, glint: +t.sig.glint.toFixed(2), tint: +t.sig.tint.toFixed(2), magPeak: t.magPeak != null ? Math.round(t.magPeak) : null, why: t.why || null, device: t.device || null } : null,
      hash, blob, w: iw, h: ih, vt: st.source === 'file' ? +video.currentTime.toFixed(2) : null, device: st.source === 'file' ? 'video file' : camName(),
    };
    st.session.push(rec);
    const stored = await DB.put(rec);
    log('SAVE', `Photo saved${stored ? ' on this phone' : ' (this browser blocks storage: download it from the report)'} · ${Math.round(blob.size / 1024)} KB · sha256 <code>${hash ? hash.slice(0, 16) + '…' : 'unavailable'}</code>`);
    refreshLocker();
    return rec;
  }

  function openAlertRows(meta, rec, rows, heading) {
    $('#alertMeta').textContent = meta;
    $('#alertH').innerHTML = heading || 'Camera<br>found';
    const img = $('#alertImg');
    if (rec && rec.blob) { const u = URL.createObjectURL(rec.blob); st.urls.push(u); img.src = u; img.hidden = false; } else img.hidden = true;
    $('#alertSig').innerHTML = rows.map(([a, b]) => `<li><span>${esc(a)}</span><b>${esc(b)}</b></li>`).join('');
    $('#alert').hidden = false;
    if (st.source === 'file') { video.pause(); Beeper.set(0, false); }     // hold the frame for the audience
  }
  function openAlert(t, rec, dev) {
    const s = t.sig, rows = [], phone = dev && dev.label === 'Phone';
    if (dev) rows.push([`The lens is on a ${dev.label.toLowerCase()} (recognised by its shape)`, Math.round(dev.score * 100) + '%']);
    if (s.torchTest || t.flash === 1) rows.push(['Went dark when the flash went off', t.flash === 1 ? 'PASS' : '—']);
    if (st.smode === 'ir') rows.push(['Purple infrared tint', s.tint.toFixed(2)]);
    rows.push([s.view != null ? `Kept shining while you moved ${Math.round(s.angleDeg)}° sideways` : `Kept shining across ${Math.round(s.angleDeg)}° of angle`, 'PASS']);
    rows.push(['Small, sharp point of light, like a lens', Math.round(s.glint * 100) + '%']);
    rows.push(st.ms.ok
      ? (t.magPeak != null && t.magPeak >= 8 ? [`Magnetic change at the spot, +${t.magPeak.toFixed(0)} µT`, 'PASS'] : ['Magnetic: bring the phone close to check', '—'])
      : [st.source === 'file' ? 'No magnetic readings saved with this video' : 'Magnetic sensor off', '—']);
    openAlertRows(`Light tests passed · ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, rec, rows,
      phone ? 'Phone camera<br>found' : dev && dev.label !== 'Camera' ? `${esc(dev.label)} camera<br>found` : st.smode === 'ir' ? 'Camera<br>light found' : 'Camera<br>found');
  }

  /* ---------- guidance ---------- */
  function setInstr(tagText, title, sub, opt = {}) {
    $('#iTag').textContent = tagText;
    const h = $('#iTitle');
    if (h.textContent !== title && h.animate) {
      try { h.animate([{ opacity: 0.2, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }); } catch (e) { /* old WebView */ }
    }
    h.textContent = title; h.lang = opt.lang || 'en';
    $('#iSub').textContent = sub || '';
    $('.instr').classList.toggle('hot', !!opt.hot);
  }
  function guideInstr(key) {
    const sub = key === 'sweep' && st.smode === 'ir' ? SUBS.sweepIr : key === 'found' && st.ms.ok && st.source === 'camera' ? SUBS.foundMag
      : (key === 'start' || key === 'sweep') && st.bright && st.smode === 'lens' ? SUBS.lit : SUBS[key] || '';
    setInstr(TAGS[key] || 'Scanning', Voice.title(key), sub, { lang: Voice.lang, hot: key === 'found' });
  }

  /* the agent's Navigator speaks only when no glint and no camera is in view */
  function agentGuide(nav, now) {
    st.nav = nav;
    st.guide.target = nav.target ? { x: nav.target.x, y: nav.target.y, cam: false } : null;
    const key = 'agent:' + nav.id;
    if (key !== st.guide.key) {
      st.guide.key = key; st.guide.since = now;
      setInstr(nav.tag, nav.title, nav.sub, { lang: nav.lang });
      const h = HAPTIC[nav.dir || nav.hapt];
      if (st.discreet && h) vib(h);
    } else {
      if ($('#iTitle').textContent !== nav.title) $('#iTitle').textContent = nav.title;
      if ($('#iTag').textContent !== nav.tag) $('#iTag').textContent = nav.tag;
    }
    if (nav.say) {
      if (Voice.has(nav.sayKey)) Voice.say(nav.sayKey, { repeatMs: nav.repeatMs });   // full the first time, short after
      else Voice.sayText(nav.say, { key: nav.sayKey, repeatMs: nav.repeatMs });
    }
  }

  /* left/right or up/down to bring a point to the middle; on a diagonal it keeps the axis it already said */
  function dirTo(dx, dy) {
    const k = st.guide.key, wasH = k === 'left' || k === 'right', wasV = k === 'up' || k === 'down';
    const horiz = wasH ? Math.abs(dx) >= Math.abs(dy) * 0.6 : wasV ? Math.abs(dx) > Math.abs(dy) * 1.6 : Math.abs(dx) >= Math.abs(dy);
    return horiz ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  }
  // routine steering: a change from one of these to another waits until the current one has been up for
  // MIN_SHOW ms (no flip-flopping on a diagonal or between two glints). Anything else, like "it's centred,
  // hold still" or a result, replaces it at once, so nobody is told to keep moving past the point.
  const ROUTINE = new Set(['left', 'right', 'up', 'down', 'sweep', 'noTorch', 'start']);
  const MIN_SHOW = 1200;
  const routine = k => ROUTINE.has(k) || String(k).startsWith('agent:');

  function guide(f, now) {
    let key;
    st.nav = null;
    const rc = recognisedCamera(now);
    st.guide.target = f ? { x: f.x, y: f.y, cam: f.status === 'camera' } : null;
    if (st.source === 'file') {              // a recording can't be steered: say what is happening instead
      st.guide.centered = !!(f || rc);
      key = (f && f.status === 'camera') || rc ? 'found' : f ? 'vCheck' : 'vScan';
      if (key !== st.guide.key) { st.guide.key = key; st.guide.since = now; guideInstr(key); }
      if (key === 'found' && now - st.lastFoundSay > 15000 && !video.paused) { Voice.say('found', { repeatMs: 15000 }); st.lastFoundSay = now; }
      return;
    }
    const cand = !rc && !f ? recogCandidate(now) : null;
    // the camera sees nothing (phone lying on its back, lens covered): say so instead of steering
    const flat = Heading.ok && Heading.pitch < -70;
    if (st.flash.phase === 'idle' && st.lastMean != null && st.lastMean < 2 && (st.smode !== 'ir' || flat)) st.blackSince = st.blackSince || now;
    else st.blackSince = 0;
    const covered = st.blackSince && now - st.blackSince > 2500;
    if (covered) {
      st.guide.centered = false; st.guide.target = null;
      key = 'covered';
    } else if (rc && (!f || f.status !== 'camera')) {        // a camera recognised by its shape
      const L = Math.max(st.fw, st.fh);
      const dx = (rc.x - 0.5) * st.fw / L, dy = (rc.y - 0.5) * st.fh / L;
      const off = Math.max(Math.abs(dx), Math.abs(dy)) > (st.guide.key === 'found' ? 0.3 : TOL + 0.05);
      st.guide.centered = !off;
      st.guide.target = { x: rc.x, y: rc.y, cam: true };
      key = off ? dirTo(dx, dy) : 'found';
    } else if (cand) {                                  // something camera-shaped: bring it to the middle and hold
      const L = Math.max(st.fw, st.fh);
      const dx = (cand.x - 0.5) * st.fw / L, dy = (cand.y - 0.5) * st.fh / L;
      const off = Math.max(Math.abs(dx), Math.abs(dy)) > (st.guide.key === 'recHold' ? TOL + 0.08 : TOL + 0.03);
      st.guide.centered = !off;
      st.guide.target = { x: cand.x, y: cand.y, cam: false };
      key = off ? dirTo(dx, dy) : 'recHold';
      // a weak hint gets a short look: 4 s held in the middle (the zoomed looks run there), 7 s in all
      if (!cand.guideT) cand.guideT = now;
      if (!off && !cand.heldT) cand.heldT = now;
      if ((cand.heldT && now - cand.heldT > 4000) || now - cand.guideT > 7000) {
        cand.skipT = now;
        log('SEE', `Something camera-like (${Math.round(cand.score * 100)}%) wasn't confirmed by the zoomed looks: moving on`);
      }
    } else if (!f) {
      st.guide.centered = false;
      key = st.smode === 'lens' && st.source === 'camera' && !st.torchAvail ? 'noTorch' : 'sweep';
      if (st.guide.key === 'start' && now - st.guide.since < 5000 && !st.full) key = 'start';   // let the opening line finish
      const nav = st.full ? Agent.nav(now) : null;
      const young = ROUTINE.has(st.guide.key) && now - st.guide.since < MIN_SHOW;
      if (nav && !young) { agentGuide(nav, now); return; }
      if (nav) key = st.guide.key;                // let the last instruction be read first
    } else {
      const L = Math.max(st.fw, st.fh);
      const dx = (f.x - 0.5) * st.fw / L, dy = (f.y - 0.5) * st.fh / L;
      const tol = st.guide.key === 'moveSide' || st.guide.key === 'found' ? 0.3 : st.guide.centered ? TOL + 0.05 : TOL;
      const off = Math.max(Math.abs(dx), Math.abs(dy)) > tol;
      st.guide.centered = !off;
      const dir = dirTo(dx, dy);
      if (f.status === 'camera') key = off ? dir : 'found';
      else if (f.status === 'possible') key = off ? dir : 'possible';
      else if (st.flash.phase !== 'idle') key = 'flash';
      else if (off) key = dir;
      else if (f.sig.torchTest && f.flash == null && f.flashTries < 2) {
        // the flash test needs a steady point first, and a moment after the last test
        if (f.hits >= 6 && now - f.lastFlashT > 1500 && now - (st.lastFlashEnd || 0) > 1500) startFlash(f, now);
        key = st.flash.phase !== 'idle' ? 'flash' : 'hold';
      }
      else if ((f.sig.angleDeg || 0) < needAngle(f) + 1) key = 'moveSide';
      else if (f.sig.torchTest && f.flash === 1 && (f.flashOk || 0) < 2 && f.flashTries < 4) {
        // after moving: is it still the same reflection? (the tracker could have jumped to another glint)
        if (now - f.lastFlashT > 1200) startFlash(f, now);
        key = st.flash.phase !== 'idle' ? 'flash' : 'hold';
      }
      else if (Mag.ok && !f.magProbed) key = 'closer';
      else if (f.optical) { markPossible(f, now); key = 'possible'; }   // lens-like, but nothing else confirms it
      else { clearTrack(f, verdict(f)); key = 'sweep'; }   // every test has run and it isn't a camera
      if (f.status !== 'camera' && f.status !== 'clear' && f.status !== 'possible' && now - st.focusSince > 30000) { clearTrack(f, 'no verdict after 30 s, skipped'); key = 'sweep'; }
    }
    // a routine change waits until the current instruction has been up for a moment; results never wait
    if (key !== st.guide.key && ROUTINE.has(key) && routine(st.guide.key) && !String(st.guide.key).startsWith('agent:')
      && now - st.guide.since < MIN_SHOW) key = st.guide.key;
    if (key !== st.guide.key) {
      st.guide.key = key; st.guide.since = now; guideInstr(key);
      if (st.discreet && HAPTIC[key]) vib(HAPTIC[key]);
    }
    if (key === 'found') {
      if (now - st.lastFoundSay > 15000) { Voice.say('found', { repeatMs: 15000 }); st.lastFoundSay = now; }
    } else if (!(key === 'start' && st.full)) Voice.say(key, { repeatMs: REPEAT[key] || 8000 });   // the full scan has its own opening line
  }

  /* beeper level: the focus point's evidence and how close you are to it, or the magnetometer,
   * whichever is stronger. Walk toward a suspect and it beeps faster. */
  function level(f) {
    let vis = 0;
    if (f) {
      const L = Math.max(st.fw, st.fh);
      const dist = Math.hypot((f.x - 0.5) * st.fw / L, (f.y - 0.5) * st.fh / L);
      const close = closeness(f);
      vis = clamp01(f.score) * (0.35 + 0.65 * close) * (1 - 0.6 * clamp01(dist / 0.5));
      if (f.status === 'camera') vis = Math.max(vis, 0.55 + 0.45 * close * (1 - clamp01(dist / 0.3)));
    }
    const magL = st.ms.ok && st.flash.phase === 'idle' ? clamp01((Math.abs(st.ms.delta) - 5) / 45) : 0;
    const rc = recognisedCamera(performance.now());
    if (rc) vis = Math.max(vis, 0.55 + 0.45 * clamp01(Math.sqrt(rc.w * rc.h) * 3));   // bigger in view = closer
    return Math.max(vis, magL);
  }

  /* ---------- drawing ---------- */
  function viewMap() {
    const W = ov.clientWidth, H = ov.clientHeight, iw = video.videoWidth || 1, ih = video.videoHeight || 1;
    const s = Math.max(W / iw, H / ih), dw = iw * s, dh = ih * s;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    return { W, H, dw, dh, X: nx => ox + nx * dw, Y: ny => oy + ny * dh, L: Math.max(dw, dh), px: st.fw ? dw / st.fw : 1 };
  }

  // boxes ease towards the latest analysis instead of jumping (~70 ms); a box not drawn for a moment starts fresh
  const glide = new Map();
  function gl(key, now, x, y, w = 0, h = 0) {
    let g = glide.get(key);
    if (!g || now - g.t > 400) { g = { x, y, w, h, t: now }; glide.set(key, g); return g; }
    const a = 1 - Math.exp(-(now - g.t) / 70);
    g.x += (x - g.x) * a; g.y += (y - g.y) * a; g.w += (w - g.w) * a; g.h += (h - g.h) * a; g.t = now;
    return g;
  }
  function draw(now, f) {
    if (glide.size > 150) glide.forEach((g, k) => { if (now - g.t > 1000) glide.delete(k); });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = ov.clientWidth, H = ov.clientHeight;
    if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
    const c = octx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!st.fw || !video.videoWidth) return;
    const m = viewMap();
    const cx = W / 2, cy = H / 2, rr = TOL * m.L;
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.5; c.setLineDash([4, 5]);
    c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    c.beginPath(); c.moveTo(cx - 7, cy); c.lineTo(cx + 7, cy); c.moveTo(cx, cy - 7); c.lineTo(cx, cy + 7); c.stroke();
    if (st.lights !== 'done') return;

    let drawn = 0;
    for (const t of st.tracker.tracks) {
      if (!t.visible || t.status === 'artifact' || t.status === 'glare') continue;
      // only what matters: the point being checked, cameras and possible lenses, strong suspects; a ruled-out
      // point only right after its verdict
      const imp = t === f || t.status === 'camera' || t.status === 'possible';
      if (!imp && (DISMISSED.has(t.status) ? t.id !== st.lastFocusId : t.score < 0.25 && t.status !== 'suspect')) continue;
      if (!imp && ++drawn > 4) continue;
      const g = gl('g' + t.id, now, t.x, t.y), x = m.X(g.x), y = m.Y(g.y);
      const r = Math.max(13, Math.sqrt(t.area) * m.px * 1.4 + 9);
      let col = 'rgba(255,255,255,.8)', lw = 1.5, label = t === f ? 'CHECKING' : null, bg = '#FDCF58', fg = '#111';
      if (t.status === 'camera') { col = `rgba(238,58,79,${0.65 + 0.35 * Math.sin(now / 110)})`; lw = 3.5; label = 'CAMERA'; bg = '#EE3A4F'; fg = '#fff'; }
      else if (t.status === 'possible') { col = '#E8772E'; lw = 3; label = 'POSSIBLE LENS'; bg = '#E8772E'; fg = '#fff'; }
      else if (t.status === 'suspect') { col = '#FDCF58'; lw = 2.5; }                   // "CHECKING" when it is the one being tested
      else if (t.status === 'light') { col = 'rgba(190,190,180,.7)'; label = 'LIGHT'; bg = '#94A3B8'; }
      else if (t.status === 'ignored') { col = 'rgba(190,190,180,.45)'; label = 'IGNORED'; bg = '#64748B'; fg = '#fff'; }
      else if (t.status === 'clear') { col = 'rgba(30,142,85,.6)'; label = 'NOT A CAMERA'; bg = '#1E8E55'; fg = '#fff'; }
      brackets(c, x, y, r, col, lw);
      const ly = y + r + 21 > H - 40 ? y - r - 21 : y + r + 4;                  // clear of the chips at the bottom
      if (label && (imp || ly >= 92)) tag(c, x - r, ly, label, bg, fg);          // under the header only what matters
    }
    const nth = {};
    for (const it of st.scene.items) {
      if (now - it.t > 1600) continue;
      const k = it.label + (nth[it.label] = (nth[it.label] || 0) + 1);          // the 1st clock, the 2nd clock...
      const g = gl('s' + k, now, it.x, it.y, it.w, it.h);
      const x0 = m.X(g.x - g.w / 2), y0 = m.Y(g.y - g.h / 2), bw = m.X(g.x + g.w / 2) - x0, bh = m.Y(g.y + g.h / 2) - y0;
      const done = it.spot && st.scene.done.has(it.spot);
      const ph = it.spot === 'phone' && !done;
      c.strokeStyle = it.label === 'Person' ? 'rgba(47,111,219,.8)' : done ? 'rgba(30,142,85,.8)' : ph ? 'rgba(238,58,79,.9)' : it.spot ? 'rgba(253,207,88,.75)' : 'rgba(255,255,255,.45)';
      c.lineWidth = ph ? 2.5 : 1.5; c.setLineDash(ph ? [6, 4] : [3, 4]);
      c.strokeRect(x0, y0, bw, bh); c.setLineDash([]);
      if (ph) { tag(c, x0, y0 + 2, 'PHONE · CHECK ITS CAMERA', '#EE3A4F', '#fff'); continue; }
      tag(c, x0, y0 + 2, (done ? '✓ ' : '') + it.label.toUpperCase(), it.label === 'Person' ? '#2F6FDB' : done ? '#1E8E55' : it.spot ? '#FDCF58' : 'rgba(20,20,20,.7)', it.spot && !done && it.label !== 'Person' ? '#111' : '#fff');
    }
    for (const it of st.recog.items) {
      const seen = it.hist.reduce((a, b) => a + b, 0);
      if (it.status !== 'camera' && (seen < 2 || it.score < 0.4)) continue;   // weak guesses stay hidden
      const cam = it.status === 'camera';
      const g = gl('r' + it.id, now, it.x, it.y, it.w, it.h);
      const x0 = m.X(g.x - g.w / 2), y0 = m.Y(g.y - g.h / 2), bw = m.X(g.x + g.w / 2) - x0, bh = m.Y(g.y + g.h / 2) - y0;
      c.strokeStyle = cam ? `rgba(238,58,79,${0.7 + 0.3 * Math.sin(now / 110)})` : 'rgba(232,119,46,.9)';
      c.lineWidth = cam ? 3.5 : 2; c.setLineDash(cam ? [] : [7, 5]);
      c.strokeRect(x0, y0, bw, bh); c.setLineDash([]);
      tag(c, x0, y0 - 19 < 92 ? y0 + bh + 3 : y0 - 17, cam ? `CAMERA ${Math.round(it.score * 100)}%` : `POSSIBLE CAMERA ${Math.round(it.score * 100)}%`, cam ? '#EE3A4F' : '#E8772E', '#fff');
    }
    if (st.nav && st.nav.dir) {
      const d = st.nav.dir, pulse = 0.55 + 0.45 * Math.sin(now / 180);
      const ax = d === 'left' ? 34 : d === 'right' ? W - 34 : cx, ay = d === 'up' ? 110 : d === 'down' ? H - 70 : cy;
      const rot = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[d];
      c.save(); c.translate(ax, ay); c.rotate(rot);
      c.strokeStyle = `rgba(253,207,88,${pulse})`; c.lineWidth = 6; c.lineCap = 'round'; c.lineJoin = 'round';
      for (const o of [-12, 6]) { c.beginPath(); c.moveTo(o - 9, -18); c.lineTo(o + 9, 0); c.lineTo(o - 9, 18); c.stroke(); }
      c.restore();
      if (st.nav.deg) { c.font = '700 13px "JetBrains Mono", Consolas, monospace'; c.fillStyle = '#FDCF58'; c.textAlign = 'center'; c.fillText(st.nav.deg + '°', ax, ay + 38); c.textAlign = 'start'; }
    }
    const tg = st.guide.target;
    if (tg && !st.guide.centered) {
      const g = gl('target', now, tg.x, tg.y), x = m.X(g.x), y = m.Y(g.y), ang = Math.atan2(y - cy, x - cx);
      const col = tg.cam ? '#EE3A4F' : '#FDCF58';
      const ax = cx + Math.cos(ang) * rr, ay = cy + Math.sin(ang) * rr;
      c.strokeStyle = col; c.lineWidth = 2; c.setLineDash([6, 6]);
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(x, y); c.stroke(); c.setLineDash([]);
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(ax + Math.cos(ang) * 16, ay + Math.sin(ang) * 16);
      c.lineTo(ax + Math.cos(ang + 2.4) * 13, ay + Math.sin(ang + 2.4) * 13);
      c.lineTo(ax + Math.cos(ang - 2.4) * 13, ay + Math.sin(ang - 2.4) * 13);
      c.closePath(); c.fill();
    }
  }

  function setSig(k, v, txt) {
    const row = $(`.sig[data-k="${k}"]`);
    row.classList.toggle('na', v == null);
    row.querySelector('u').style.width = Math.round((v || 0) * 100) + '%';
    row.querySelector('em').textContent = txt;
  }
  const STATUS = { new: 'checking', checking: 'checking', suspect: 'suspect', camera: 'CAMERA', possible: 'possible lens', light: 'light source', glare: 'glare', ignored: 'ignored', clear: 'not a camera' };

  function ui(now, f, lvl) {
    if (now - st.lastUiT < 120) return;
    st.lastUiT = now;
    const el = Math.floor((now - st.t0) / 1000);
    $('#clock').textContent = `${Math.floor(el / 60)}:${pad2(el % 60)}`;
    const hT = $('#hTorch');
    hT.textContent = st.source === 'file' ? (st.track ? 'VIDEO + RECORDED SENSORS' : 'VIDEO FILE') : !Camera.hasTorch ? 'FLASH N/A' : Camera.torchOn ? 'FLASH ON' : 'FLASH OFF';
    hT.classList.toggle('on', Camera.torchOn);
    const hM = $('#hMag');
    if (st.ms.ok) {
      const d = st.ms.delta;
      hM.textContent = `MAG ${Math.abs(d) < 0.5 ? '±' : d > 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} µT${st.ms.rec ? ' · REC' : ''}`;
      hM.classList.toggle('hot', Math.abs(d) >= 15);
    } else { hM.textContent = st.source === 'file' ? (st.track ? 'RECORDED SENSORS' : 'NO LIVE SENSORS') : Mag.ok ? 'MAG CALIBRATING' : 'MAG OFF'; hM.classList.remove('hot'); }
    $('#hAng').textContent = f ? `∠ ${Math.round(f.sig.angleDeg || 0)}° ${f.sig.view != null ? 'MOVED' : 'HELD'}` : '∠ —';
    $('#hFps').textContent = `${Math.round(st.fps)} FPS`;
    $('#hTest').hidden = st.flash.phase === 'idle';
    $('#mBar').style.width = Math.round(lvl * 100) + '%';
    $('#mVal').textContent = Math.round(lvl * 100);

    const e = $('#evid');
    if (!f) e.hidden = true;
    else {
      e.hidden = false;
      $('#eSpot').textContent = `BRIGHT SPOT · ${STATUS[f.status] || f.status}`;
      const sc = $('#eScore');
      sc.textContent = Math.round(f.score * 100) + '%'; sc.classList.toggle('hit', f.status === 'camera');
      const s = f.sig;
      setSig('glint', s.glint, Math.round(s.glint * 100) + '%');
      setSig('angle', s.angle, Math.round(s.angleDeg) + '°');
      if (st.smode === 'ir') setSig('flash', s.tint, Math.round(s.tint * 100) + '%');
      else if (!s.torchTest && f.flash == null) setSig('flash', null, st.source === 'file' ? 'none yet' : 'n/a');
      else {
        const testing = st.flash.phase !== 'idle' && st.flash.id === f.id;
        setSig('flash', f.flash === 1 ? 1 : f.flash === 0 ? 0 : null, f.flash === 1 ? 'PASS' : f.flash === 0 ? 'FAIL' : testing ? 'TEST…' : 'NEXT');
      }
      setSig('mag', st.ms.ok ? s.mag || 0 : null, st.ms.ok ? (f.magPeak != null ? '+' + f.magPeak.toFixed(0) + 'µT' : '—') : 'off');
      $('#eNote').textContent = st.smode === 'ir'
        ? 'A night-camera light glows purple and stays lit as you move.'
        : s.flashKnown ? (st.source === 'file' ? 'The recorded flash test passed. A lens also stays lit as the camera moves.' : 'A lens goes dark with the flash and stays lit when you move sideways. A magnetic jump adds weight.')
          : st.source === 'file' ? 'In a recording, a lens is a sharp white point that stays lit as the camera moves.'
            : 'No flash control here: a lens is a sharp white point that stays lit as you move.';
    }
    $('#tTorch').setAttribute('aria-pressed', Camera.torchOn);
    $('#tTorch').disabled = !Camera.hasTorch || st.flash.phase !== 'idle';
    $('#tMag').disabled = !Mag.ok;
    if (st.source === 'file') {
      const d = isFinite(video.duration) ? video.duration : 0;
      $('#vTime').textContent = `${fmtClock(video.currentTime)} / ${d ? fmtClock(d) : '–:––'}`;
      if (!st.seeking && d) $('#vSeek').value = Math.round(video.currentTime / d * 1000);
      $('#vPlay').textContent = video.paused ? 'Play' : 'Pause';
    }
    const rb = $('#tRec');
    rb.classList.toggle('rec', !!Rec.mr);
    rb.querySelector('em').textContent = Rec.mr ? fmtClock((now - Rec.t0) / 1000) : 'Record';
    if (now - st.lastSensT > 1000) { st.lastSensT = now; renderSensors(); }
  }

  /* ---------- places checklist ---------- */
  function renderRail() {
    const places = ROOMS[st.room].places;
    $('#rail').innerHTML = places.map((p, i) => `<li><button type="button" data-i="${i}" aria-pressed="${st.checked.has(p)}">${esc(p)}</button></li>`).join('');
    const count = () => { $('#placesN').textContent = `${st.checked.size}/${places.length}`; };
    count();
    $$('#rail button').forEach(b => {
      b.onclick = () => {
        const p = places[+b.dataset.i];
        if (st.checked.has(p)) st.checked.delete(p); else { st.checked.add(p); log('SEE', `You checked: ${esc(p)}`); }
        b.setAttribute('aria-pressed', st.checked.has(p));
        count();
      };
    });
  }

  /* ---------- report ---------- */
  function sigLines(rec, lang) {
    const s = rec.sig || {}, out = [];
    if (lang === 'hi') {
      if (rec.kind === 'shape') out.push(`- फ़ोन के कैमरा-पहचान मॉडल ने इसे आकार से कैमरा पहचाना (${Math.round((s.shape || 0) * 100)}% भरोसा)`);
      if (rec.kind === 'phonecam') out.push('- कमरे में रखा एक मोबाइल फ़ोन, जिसका कैमरा इस तरफ़ था');
      if (rec.kind === 'ircam') out.push('- नाइट-विज़न कैमरे जैसी छोटी इन्फ्रारेड रोशनी');
      if (s.flash === 1) out.push('- फ़ोन का फ़्लैश बंद करने पर लेंस जैसी चमक गायब हो गई और चालू करने पर लौट आई');
      if (s.angleDeg) out.push(`- यह चमक ${s.angleDeg}° तक अलग-अलग कोणों से दिखती रही`);
      if (s.magPeak >= 8) out.push(`- उस जगह पर +${s.magPeak} µT का चुंबकीय बदलाव`);
    } else {
      if (rec.kind === 'shape') out.push(`- the phone's camera-recognition model identified it as a camera by its shape (${Math.round((s.shape || 0) * 100)}% confidence)`);
      if (rec.kind === 'phonecam') out.push('- a mobile phone placed in the room with its camera pointing into the room');
      if (rec.kind === 'ircam') out.push('- a small infrared glow of the kind night-vision cameras use');
      if (s.flash === 1) out.push('- a lens-like reflection that went dark when the phone\'s flash was switched off and came back when it was switched on');
      if (s.angleDeg) out.push(`- the reflection kept shining back across ${s.angleDeg}° of viewing angle`);
      if (s.magPeak >= 8) out.push(`- a magnetic change of +${s.magPeak} µT at the spot`);
    }
    return out;
  }
  function letter(lang, cams, place, spot) {
    const d = new Date(cams[0].time);
    const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const bullets = sigLines(cams[0], lang).join('\n');
    const hashes = cams.map((r, i) => `${i + 1}. ${r.hash || 'n/a'}`).join('\n');
    if (lang === 'hi') return `सेवा में: वार्डन / मालिक, ${place}
प्रति: साइबर क्राइम हेल्पलाइन 1930

${date} को ${time} बजे मुझे ${place} में${spot ? ` (${spot})` : ''} छिपा हुआ कैमरा होने के संकेत मिले। फ़ोन ऐप TwinGaze ने दर्ज किया:
${bullets}

समय-मुहर वाली ${cams.length} फ़ोटो संलग्न हैं। SHA-256 फ़िंगरप्रिंट (यह दिखाने के लिए कि फ़ाइलें बाद में बदली नहीं गईं):
${hashes}

बिना सहमति निजी जगह पर किसी की रिकॉर्डिंग करना भारतीय न्याय संहिता, 2023 की धारा 77 और सूचना प्रौद्योगिकी अधिनियम, 2000 की धारा 66E के तहत अपराध है। मैंने डिवाइस को छुआ नहीं है। कृपया सभी रिकॉर्डिंग सुरक्षित रखें और तुरंत कार्रवाई करें।

— [आपका नाम]`;
    return `To: The Warden / Owner, ${place}
Cc: Cyber Crime Helpline 1930

On ${date} at ${time}, I found signs of a hidden camera in ${place}${spot ? `, at ${spot}` : ''}. I checked the room with TwinGaze, a phone app that tests for camera lenses. It recorded:
${bullets}

${cams.length} time-stamped photo${cams.length === 1 ? ' is' : 's are'} attached. SHA-256 fingerprints (to show the files were not edited later):
${hashes}

Recording a person in a private space without consent is an offence under Section 77 of the Bharatiya Nyaya Sanhita, 2023 (voyeurism) and Section 66E of the Information Technology Act, 2000. I have not touched the device. Please preserve all recordings and act immediately.

— [Your name]`;
  }

  function card(rec, i) {
    const u = URL.createObjectURL(rec.blob); st.urls.push(u);
    const cam = CAM_KINDS.has(rec.kind);
    const title = rec.kind === 'camera' ? 'Camera lens' : rec.kind === 'phonecam' ? 'Phone camera' : rec.kind === 'devicecam' ? devTitle((rec.sig && rec.sig.device) || 'Device') : rec.kind === 'ircam' ? 'Night-vision light' : rec.kind === 'shape' ? 'Camera (recognised)' : rec.kind === 'possible' ? 'Possible lens · check by hand' : 'Photo you saved';
    const s = rec.sig;
    const sig = s && s.shape != null ? `recognised as a camera by its shape · ${Math.round(s.shape * 100)}% sure` : s ? [s.flash === 1 ? 'flash test passed' : null, rec.kind === 'ircam' ? 'IR tint ' + s.tint : null, s.moved ? `held while moving ${s.angleDeg}° sideways` : `held ${s.angleDeg}°`, s.anchored ? 'stays on its object' : null, 'glint ' + s.glint,
      s.magPeak >= 8 ? `magnetic +${s.magPeak} µT` : s.magPeak != null ? 'magnetic: no change' : 'magnetic: not measured'].filter(Boolean).join(' · ') : '—';
    return `<div class="box${cam ? ' y' : ''}"><span class="ix">${pad2(i + 1)}</span><span class="sq"></span>
      <h3>${title}${rec.room ? ' · ' + esc(rec.room) : ''}</h3>
      <img class="shot" src="${u}" alt="${title}, saved ${esc(new Date(rec.time).toLocaleString('en-IN'))}">
      <dl class="kv">
        <dt>Time</dt><dd>${esc(new Date(rec.time).toLocaleString('en-IN'))}</dd>
        ${rec.vt != null ? `<dt>In video</dt><dd>at ${fmtClock(rec.vt)}</dd>` : ''}
        ${rec.score != null ? `<dt>Score</dt><dd>${rec.score.toFixed(2)}</dd>` : ''}
        <dt>Signals</dt><dd>${esc(sig)}</dd>
        <dt>SHA-256</dt><dd>${rec.hash || 'unavailable (open the app over https)'}</dd>
        <dt>Source</dt><dd>${esc(rec.device || '')}</dd>
      </dl>
      <div class="row-btns"><button class="btn sm" type="button" data-save="${rec.id}">Save to phone</button><button class="btn sm" type="button" data-del="${rec.id}">Delete</button></div>
    </div>`;
  }

  function refBox(ref, n) {
    const ok = n >= ref.cameras;
    return `<div class="box"><span class="sq"></span>
      <h3>Reference check <span class="risk ${ok ? '' : 'medium'}">${ok ? 'Pass' : 'Check'}</span></h3>
      <p>This video shows ${esc(ref.place)}, which has ${esc(ref.what)}. TwinGaze found <b>${Math.min(n, ref.cameras)} of ${ref.cameras}</b>${n > ref.cameras ? `, and ${n - ref.cameras} more: look at the saved photos` : ''}.</p>
    </div>`;
  }
  function agentBox(a) {
    if (!a) return '';
    const how = x => x.done ? (x.how === 'camera' ? 'camera found here' : x.how === 'flash' ? 'checked · flash' : 'looked at') : x.how === 'skipped' ? 'skipped' : 'not checked';
    return `<div class="box ag${a.risk === 'high' ? ' y' : ''}"><span class="sq"></span>
      <h3>Result <span class="risk ${a.risk === 'low' ? '' : a.risk}">${RISK_TXT[a.risk]}</span></h3>
      <ul class="spots">${a.reasons.map(r => `<li><span>${esc(r)}</span></li>`).join('')}</ul>
      ${a.did && a.did.length ? `<p><b>What was checked:</b> ${a.did.map(esc).join(' · ')}.</p>` : ''}
      ${a.spots && a.spots.length ? `<ul class="spots">${a.spots.map(x => `<li class="${x.done ? '' : 'no'}"><span>${esc(x.label)}</span><em>${how(x)}</em></li>`).join('')}</ul>` : ''}
    </div>`;
  }
  function wireCards(r, recs, rerender) {
    r.querySelectorAll('[data-save]').forEach(b => {
      b.onclick = async () => {
        const rec = recs.find(x => x.id === b.dataset.save);
        if (!rec) return;
        try { toast('Photo saved: ' + await saveOut(rec.blob, `twingaze-${rec.id}.jpg`, 'image')); }
        catch (e) { toast('Could not save the photo.'); }
      };
    });
    r.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        if (!window.confirm('Delete this photo from the phone? Evidence you delete can\'t be recovered.')) return;
        await DB.del(b.dataset.del);
        st.session = st.session.filter(x => x.id !== b.dataset.del);
        refreshLocker();
        if (rerender) rerender(); else b.closest('.box').remove();
      };
    });
  }

  async function renderReport(locker) {
    st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = [];
    const recs = locker ? (await DB.all()).sort((a, b) => b.time.localeCompare(a.time)) : st.session;
    const cams = recs.filter(r => CAM_KINDS.has(r.kind));
    const r = $('#report');
    const places = ROOMS[st.room].places;
    let html;
    if (locker) {
      html = `<div class="eyebrow">Stored on this phone only</div><h1>Evidence<br>locker</h1>
        ${recs.length ? recs.map(card).join('') : '<p>Nothing saved yet.</p>'}`;
    } else {
      const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const isFile = st.source === 'file';
      html = `<div class="eyebrow">${isFile ? (st.ref ? `Reference video · ${esc(st.ref.name)}` : `Video report · ${esc(st.lastFile ? st.lastFile.name : 'recording')}`) : `Room report · ${esc(ROOMS[st.room].name)}`} · ${stamp} · ${fmtDur(st.lastDur)}</div>
        <h1>${cams.length ? `${cams.length} camera${cams.length > 1 ? 's' : ''}<br>found.` : 'No camera<br>found.'}</h1>
        <div class="stats">
          <div><b>${st.stats.seen}</b><small>bright points checked</small></div>
          <div><b>${st.stats.glare + st.stats.lights + st.stats.cleared}</b><small>ruled out</small></div>
          ${isFile ? `<div><b>${fmtClock(st.lastVideoT || 0)}</b><small>of video analysed</small></div>` : `<div><b>${st.checked.size}/${places.length}</b><small>places ticked</small></div>`}
          <div class="${cams.length ? 'hot' : ''}"><b>${cams.length}</b><small>camera${cams.length === 1 ? '' : 's'}</small></div>
        </div>
        ${isFile && st.ref ? refBox(st.ref, cams.length) : ''}
        ${agentBox(st.agentSum)}
        ${recs.some(x => x.kind === 'possible') ? `<p class="note">${recs.filter(x => x.kind === 'possible').length} possible lens${recs.filter(x => x.kind === 'possible').length > 1 ? 'es' : ''}: passed the light tests, but no camera shape or magnetic jump confirmed ${recs.filter(x => x.kind === 'possible').length > 1 ? 'them' : 'it'}. Look closely at each spot: a lens is a tiny dark glass dot.</p>` : ''}
        ${recs.map(card).join('')}
        ${cams.length ? `
        <div class="box"><span class="ix">→</span><span class="sq"></span><h3>What to do now</h3>
          <ol class="todo">
            <li>Don't touch, move or cover the camera. It's evidence.</li>
            <li>Don't confront the owner alone. Call 112 if you feel unsafe.</li>
            <li>Report at cybercrime.gov.in or call 1930. The complaint below is ready; nothing is sent until you choose.</li>
          </ol></div>
        <div class="box"><span class="ix">✎</span><span class="sq"></span><h3>Complaint, ready to send</h3>
          <label class="field"><span>Place</span><input id="fPlace" value="${esc(placeName())}"></label>
          <label class="field"><span>Where exactly</span><input id="fSpot" placeholder="e.g. clothes hook facing the bed"></label>
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" aria-selected="true" data-l="en" type="button">English</button>
            <button class="tab" role="tab" aria-selected="false" data-l="hi" type="button" lang="hi">हिंदी</button>
          </div>
          <div class="letter" id="letter" lang="en"></div>
          <div class="btns">
            <button class="btn pri" type="button" id="bShare">Share complaint + photos</button>
            <button class="btn" type="button" id="bCopy">Copy text</button>
            <a class="btn" href="tel:112">Call 112</a>
            <a class="btn" href="tel:1930">Call 1930</a>
            <a class="btn wide" href="https://cybercrime.gov.in" target="_blank" rel="noopener">Open cybercrime.gov.in</a>
          </div></div>` : `
        <div class="box"><span class="ix">i</span><span class="sq"></span><h3>What this result means</h3>
          <ol class="todo">
            <li>No bright point passed the tests: nothing both went dark with the flash and held from several angles.</li>
            <li>That lowers the risk; it can't rule it out. A camera that's covered, pointed away, or behind tinted plastic may not glint.</li>
            <li>Check the places you haven't ticked, and try a Night-vision scan with the lights off.</li>
          </ol></div>`}
        ${[...st.scene.seen.values()].some(e => e.count >= 2) ? `<div class="box"><span class="ix">◎</span><span class="sq"></span><h3>Objects recognised</h3>
          <ul class="spots">${[...st.scene.seen.values()].filter(e => e.count >= 2).sort((a, b) => (b.spot ? 1 : 0) - (a.spot ? 1 : 0) || b.count - a.count)
            .map(e => `<li class="${e.spot && !st.scene.done.has(e.spot) ? 'no' : ''}"><span>${esc(e.label)}</span><em>${e.spot ? (st.scene.hit.has(e.spot) ? 'camera found here' : st.scene.done.has(e.spot) ? 'hiding spot · checked' : 'hiding spot · not checked') : 'seen'}</em></li>`).join('')}</ul></div>` : ''}
        <div class="box"><span class="ix">⇪</span><span class="sq"></span><h3>Send to laptop</h3>
          <p class="hint">Saves the full report (photos, fingerprints, complaint) as one file on the phone and opens the share sheet: pick <b>Office Kit</b> to drop it on your paired laptop. Office Kit also syncs the evidence photos from the TwinGaze album.</p>
          <div class="btns"><button class="btn wide" type="button" id="bLaptop">Send report to laptop · Office Kit</button></div></div>
        ${isFile ? '' : `<div class="box"><span class="ix">✓</span><span class="sq"></span><h3>Places</h3>
          <ul class="spots">${places.map(p => `<li class="${st.checked.has(p) ? '' : 'no'}"><span>${esc(p)}</span><em>${st.checked.has(p) ? 'checked' : 'not ticked'}</em></li>`).join('')}</ul></div>`}`;
    }
    const again = !locker && st.source === 'file' && st.lastFile;
    html += `<div class="again"><button type="button" id="again">${locker ? 'Start a scan' : again ? (st.ref ? 'Play the reference video again' : 'Analyse the video again') : 'Scan again'}</button><button type="button" id="goHome">${locker ? 'Back' : 'Done'}</button></div>`;
    r.innerHTML = html;

    if (cams.length && !locker) {
      const setL = l => {
        st.reportLang = l;
        const el = $('#letter');
        el.textContent = letter(l, cams, $('#fPlace').value.trim() || placeName(), $('#fSpot').value.trim());
        el.lang = l;
        r.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.l === l));
      };
      setL('en');
      r.querySelectorAll('.tab').forEach(t => { t.onclick = () => setL(t.dataset.l); });
      $('#fPlace').oninput = () => setL(st.reportLang);
      $('#fSpot').oninput = () => setL(st.reportLang);
      $('#bCopy').onclick = () => copy($('#letter').textContent);
      $('#bShare').onclick = async () => {
        const text = $('#letter').textContent;
        if (Native.available) {
          try { await Native.share('Hidden camera found', text, cams.filter(c => c.blob).map((c, i) => ({ blob: c.blob, name: `twingaze-${i + 1}.jpg` }))); }
          catch (e) { copy(text); }
          return;
        }
        const files = cams.filter(c => c.blob).map((c, i) => new File([c.blob], `twingaze-${i + 1}.jpg`, { type: 'image/jpeg' }));
        try {
          if (navigator.canShare && files.length && navigator.canShare({ files })) { await navigator.share({ title: 'Hidden camera found', text, files }); return; }
          if (navigator.share) { await navigator.share({ title: 'Hidden camera found', text }); return; }
        } catch (e) { if (e.name === 'AbortError') return; }
        copy(text);
      };
    }
    wireCards(r, recs, () => renderReport(locker));
    const sendBtn = $('#bLaptop');
    if (sendBtn) sendBtn.onclick = () => sendReport(recs, cams);
    $('#again').onclick = () => (locker ? runTool('full', 'home') : again ? startScan('file', st.lastFile, { ref: st.ref }) : startScan('camera', null, { mode: st.smode, full: st.full }));
    $('#goHome').onclick = () => show(locker ? 'history' : st.backTo === 'tools' ? 'tools' : 'home');
  }

  /* One self-contained HTML file: open it on any laptop, photos included. */
  async function sendReport(recs, cams) {
    const b64 = blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    const when = new Date();
    const rows = [];
    for (const rec of recs) {
      rows.push(`<section><h2>${esc(rec.kind === 'shape' ? 'Camera (recognised by shape)' : rec.kind === 'camera' ? 'Camera lens' : rec.kind === 'phonecam' ? 'Phone camera' : rec.kind === 'devicecam' ? devTitle((rec.sig && rec.sig.device) || 'Device') : rec.kind === 'ircam' ? 'Night-vision light' : rec.kind === 'possible' ? 'Possible lens' : 'Photo')}</h2>
        <img src="${rec.blob ? await b64(rec.blob) : ''}" alt="">
        <p>${esc(new Date(rec.time).toLocaleString('en-IN'))}${rec.score != null ? ' · score ' + rec.score.toFixed(2) : ''}</p>
        <p class="h">SHA-256 ${esc(rec.hash || 'n/a')}</p></section>`);
    }
    const letterText = cams.length ? letter('en', cams, ($('#fPlace') && $('#fPlace').value.trim()) || placeName(), ($('#fSpot') && $('#fSpot').value.trim()) || '') : '';
    const objs = [...st.scene.seen.values()].filter(e => e.count >= 2).map(e => e.label + (e.spot ? (st.scene.done.has(e.spot) ? ' (hiding spot, checked)' : ' (hiding spot)') : ''));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TwinGaze report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:34px;margin:0 0 4px}h2{font-size:18px;margin:18px 0 6px}img{max-width:100%;border:1px solid #ccc}.h{font:12px monospace;word-break:break-all;color:#555}pre{white-space:pre-wrap;background:#f4f4f0;padding:12px;border:1px solid #ddd}ul{padding-left:20px}</style></head><body>
<p>TwinGaze room report · ${esc(placeName())} · ${esc(when.toLocaleString('en-IN'))}</p>
<h1>${cams.length ? cams.length + ' camera' + (cams.length > 1 ? 's' : '') + ' found' : 'No camera found'}</h1>
<p>${st.stats.seen} bright points checked · ${st.stats.glare + st.stats.lights + st.stats.cleared} ruled out · places ticked: ${[...st.checked].map(esc).join(', ') || 'none'}</p>
${st.agentSum ? `<h2>Result: ${esc(RISK_TXT[st.agentSum.risk])}</h2><ul>${st.agentSum.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p>${st.agentSum.did.map(esc).join(' · ')}</p>
<h2>Scan log</h2><ol>${st.agentSum.trace.map(x => `<li><b>${esc(x.kind)}</b> ${esc(x.text)}</li>`).join('')}</ol>` : ''}
${objs.length ? `<h2>Objects recognised</h2><ul>${objs.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
${rows.join('\n')}
${letterText ? `<h2>Complaint</h2><pre>${esc(letterText)}</pre>` : ''}
<p class="h">Made on the phone by TwinGaze. Each photo's SHA-256 fingerprint shows it wasn't edited after it was taken.</p></body></html>`;
    const name = `twingaze-report-${when.getFullYear()}${pad2(when.getMonth() + 1)}${pad2(when.getDate())}-${pad2(when.getHours())}${pad2(when.getMinutes())}.html`;
    const blob = new Blob([html], { type: 'text/html' });
    try {
      const where = await saveOut(blob, name, 'download');
      log('SAVE', `Report saved: ${esc(name)} · ${esc(where)}`);
      if (Native.available) await Native.share('TwinGaze report', 'TwinGaze room report', [{ blob, name }]);
      else toast(`Report saved to ${where}. Send it to the laptop with Office Kit.`);
    } catch (e) { toast('Could not save the report.'); }
  }

  async function copy(text, msg) {
    try { if (Native.available) await Native.copy(text); else await navigator.clipboard.writeText(text); toast(msg || 'Complaint copied. Paste it into WhatsApp, email or the cybercrime portal.'); }
    catch (e) { toast('Copy failed. Select the text and copy it by hand.'); }
  }

  /* ---------- camera recogniser (shape) ----------
   * Runs a few times a second next to the glint detector. A box has to show up in 3 of the
   * last 6 checks before it counts, so one odd frame never raises an alarm. */
  function loadRecognizer() {
    if (!Objects.ready && !Objects.loading) {
      Objects.load().then(ok => {
        if (ok) log('SYS', `Object recogniser ready · ${Object.keys(Objects.meta.classes).length} kinds of room objects · ${Math.round(Objects.avgMs)} ms per check`);
        else log('WARN', 'Object recogniser could not start (' + esc(Objects.error && Objects.error.message || Objects.error) + ').');
      });
    }
    if (Recog.ready || Recog.loading) return;
    const t0 = performance.now();
    Recog.load().then(ok => {
      if (ok) log('SYS', `Camera recogniser ready · runs on the ${Recog.ep === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'} · ${Math.round(Recog.avgMs)} ms per check · loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      else log('WARN', 'Camera recogniser could not start (' + esc(Recog.error && Recog.error.message || Recog.error) + '). Glint and magnetic detection still work.');
      renderSensors();
    });
  }
  function recognizeTick(now) {
    if (Recog.busy || Objects.busy) return;
    const id = st.runId;
    const camGap = Recog.ep === 'webgpu' ? 200 : Math.max(450, Recog.avgMs * 1.5);
    const objGap = Objects.ep === 'webgpu' ? 700 : Math.max(1400, Objects.avgMs * 3);
    if (Recog.ready && now - st.recog.lastT >= camGap && (!Objects.ready || st.scene.lastT >= st.recog.lastT || now - st.scene.lastT < objGap)) {
      st.recog.lastT = now;
      // the looks take turns: whole picture, middle half (2x zoom), whole picture, middle quarter (4x zoom).
      // The zoomed looks read the camera's full-resolution frame, so a small or far camera (a CCTV dome across
      // a hall, a camera in a clock) gets 2-4x the pixels. Point the phone at it to use them.
      // A smaller picture (a video shrunk by WhatsApp) gets the 2x look on both turns: its middle quarter has too
      // few pixels, but its middle half still doubles the size of a far dome (seen in 80 of 95 frames, not 3).
      const vw = video.videoWidth, vh = video.videoHeight, long = Math.max(vw, vh);
      const pass = (st.recog.pass = (st.recog.pass || 0) + 1) % 4;
      const zk = long >= 960 ? (pass === 1 ? 2 : pass === 3 ? 4 : 0) : long >= 480 && pass % 2 ? 2 : 0, zo = zk ? (1 - 1 / zk) / 2 : 0;
      (zk ? Recog.detect(video, vw, vh, { x: vw * zo, y: vh * zo, w: vw / zk, h: vh / zk }) : Recog.detect(pc, pc.width, pc.height))
        .then(boxes => {
          if (!boxes || !st.running || id !== st.runId) return;
          const t = performance.now();
          if (zk) boxes = boxes        // back to whole-picture coordinates; boxes cut by the zoom's edge are left to the wider looks
            .filter(b => b.x - b.w / 2 > 0.02 && b.x + b.w / 2 < 0.98 && b.y - b.h / 2 > 0.02 && b.y + b.h / 2 < 0.98)
            .map(b => Object.assign({}, b, { x: zo + b.x / zk, y: zo + b.y / zk, w: b.w / zk, h: b.h / zk, zoom: zk }));
          onRecognised(boxes.filter(b => b.cls === 0), t, zk);
          onObjects(boxes.filter(b => b.cls !== 0), t, zk ? 'camera-zoom' + zk : 'camera');   // smoke detectors, phones
        })
        .catch(() => { /* one failed check is skipped */ });
    } else if (Objects.ready && now - st.scene.lastT >= objGap) {
      st.scene.lastT = now;
      Objects.detect(pc, pc.width, pc.height)
        .then(boxes => { if (boxes && st.running && id === st.runId) onObjects(boxes, performance.now(), 'objects'); })
        .catch(() => { /* skipped */ });
    }
  }

  /* ---------- room objects: what is in view, spoken, and ticked off when checked ---------- */
  function onObjects(boxes, now, from) {
    const S = st.scene;
    if (st.source === 'camera') Agent.onObjects(boxes, fovOf(video.videoWidth || 1, video.videoHeight || 1));
    // replace this model's boxes, keep the other model's
    S.items = S.items.filter(it => it.from !== from && now - it.t < 2500)
      .concat(boxes.map(b => Object.assign({ from, t: now }, b)));
    for (const b of boxes) {
      if (b.spot === 'phone' || DEVICES[b.label]) S.phones.push({ x: b.x, y: b.y, w: b.w, h: b.h, score: b.score, t: now, hd: headingOf(b.x, b.y),
        label: b.spot === 'phone' ? 'Phone' : b.label, where: DEVICES[b.label] || 'any' });
      const k = b.label;
      const e = S.seen.get(k) || { label: k, spot: b.spot, count: 0, first: now, best: 0 };
      e.count++; e.last = now; e.best = Math.max(e.best, b.score);
      if (e.count === 2) log('SEE', `Recognised: ${esc(k)}${b.spot === 'phone' ? ' (phones can record video: its camera gets checked)' : b.spot ? ' (a common hiding spot)' : ''} · ${Math.round(b.score * 100)}%`);
      S.seen.set(k, e);
      if (b.spot === 'phone' && e.count === 2 && st.source === 'camera' && st.guide.key !== 'found') {
        Voice.sayText(Voice.line('phoneSeen'), { key: 'phoneSeen', repeatMs: 30000 });
        S.spotSaid[k] = now;
      }
      // announce a hiding spot the second time it's seen, once every 25 s at most, never over a result
      if (b.spot && !st.full && e.count >= 2 && st.source === 'camera' && st.guide.key !== 'found' && st.flash.phase === 'idle'
          && !(S.spotSaid[k] && now - S.spotSaid[k] < 25000) && !S.done.has(b.spot)) {
        if (b.spot !== 'phone' && Voice.sayText(Voice.spotLine(k), { key: 'spot:' + k, repeatMs: 25000 })) S.spotSaid[k] = now;
      }
    }
    renderScene();
  }
  /* a hiding spot kept near the middle of the view with the flash on for 1.5 s counts as checked */
  function sceneCheck(now, dt) {
    if (st.source !== 'camera' || st.smode !== 'lens' || !Camera.torchOn) return;
    for (const it of st.scene.items) {
      if (!it.spot || now - it.t > 1500 || st.scene.done.has(it.spot)) continue;
      if (Math.hypot(it.x - 0.5, it.y - 0.5) > 0.35) continue;
      const on = k => Math.abs(k.x - it.x) < it.w * 0.6 + 0.02 && Math.abs(k.y - it.y) < it.h * 0.6 + 0.02;
      if (st.tracker.tracks.some(k => k.visible && on(k) && !DISMISSED.has(k.status) && k.status !== 'camera')) continue;   // a test is still running on it
      st.scene.checkMs[it.spot] = (st.scene.checkMs[it.spot] || 0) + dt * 1000;
      if (st.scene.checkMs[it.spot] < (it.spot === 'phone' ? 3000 : 1500)) continue;
      st.scene.done.add(it.spot);
      if (st.tracker.tracks.some(k => k.status === 'camera' && Math.abs(k.x - it.x) < it.w * 0.65 + 0.03 && Math.abs(k.y - it.y) < it.h * 0.65 + 0.03)) {
        st.scene.hit.add(it.spot);
        log('FOUND', `The ${esc(it.label.toLowerCase())} is where the camera lens is`);
        renderScene();
        continue;
      }
      const ticked = ROOMS[st.room].places.filter(p => (PLACE_SPOTS[p] || []).includes(it.spot) && !st.checked.has(p));
      ticked.forEach(p => st.checked.add(p));
      log('CLEAR', it.spot === 'phone' ? 'Checked the phone: no camera lens on the side you can see. A phone lying screen-up, or turned away, can\'t film you; turn it over only if it isn\'t yours'
        : `Checked the ${esc(it.label.toLowerCase())}: scanned with the flash, no lens found${ticked.length ? ' · ticked “' + ticked.map(esc).join('”, “') + '”' : ''}`);
      if (ticked.length) renderRail();
      renderScene();
    }
  }
  function renderScene() {
    const S = st.scene, now = performance.now();
    const box = $('#scene');
    const live = S ? S.items.filter(it => now - it.t < 2500) : [];
    const ready = Objects.ready || Recog.ready;
    box.hidden = !st.running || !ready;
    if (box.hidden) return;
    const labels = [...new Set(live.map(it => it.label))];
    const people = live.filter(it => it.label === 'Person').length;
    $('#sceneList').innerHTML = labels.length ? labels.map(l => {
      const it = live.find(x => x.label === l && x.spot) || live.find(x => x.label === l);
      const cls = l === 'Person' ? 'person' : it.spot === 'phone' ? (S.done.has('phone') ? 'phone done' : 'phone') : it.spot ? (S.done.has(it.spot) ? 'spot done' : 'spot') : '';
      return `<span class="${cls}">${esc(l)}${l === 'Person' && people > 1 ? ' ×' + people : ''}</span>`;
    }).join('') : '<em>Nothing recognised yet</em>';
  }
  function onRecognised(boxes, now, zk) {
    const used = new Set();
    for (const b of boxes) {
      let best = null, bo = 0.2;
      for (const it of st.recog.items) { const o = Recog.iou(it, b); if (o > bo && !used.has(it)) { bo = o; best = it; } }
      // while the phone turns, a small box moves too far between checks to overlap its last position:
      // match it by its direction in the room instead (orientation sensor), within 4°
      const bh = headingOf(b.x, b.y);
      if (!best && bh) {
        let bd = 4;
        for (const it of st.recog.items) {
          if (used.has(it) || !it.hd) continue;
          const d = Math.hypot(angDiff(it.hd.yaw, bh.yaw), it.hd.pitch - bh.pitch);
          if (d < bd) { bd = d; best = it; }
        }
      }
      // no direction (a recording): a small box that jitters by its own size no longer overlaps; match it by distance
      if (!best && !bh) {
        let bd = 1.2 * Math.max(b.w, b.h, 0.03);
        for (const it of st.recog.items) {
          if (used.has(it)) continue;
          const d = Math.hypot(it.x - b.x, it.y - b.y);
          if (d < bd) { bd = d; best = it; }
        }
      }
      if (best) {
        best.x += 0.6 * (b.x - best.x); best.y += 0.6 * (b.y - best.y); best.w += 0.6 * (b.w - best.w); best.h += 0.6 * (b.h - best.h);
        // a wider look sees a small camera with fewer pixels: its weaker score never pulls the zoomed one down
        const zk = b.zoom || 0;
        if (zk >= (best.zk || 0) || b.score > best.score) best.score = 0.5 * best.score + 0.5 * b.score;
        best.zk = Math.max(best.zk || 0, zk);
        if (zk && b.score >= 0.5) best.zHits = (best.zHits || 0) + 1;     // the full-detail look agrees
        best.hist.push(1); best.lastT = now; used.add(best); best.hd = bh || best.hd;
      } else {
        // a second box on an object this look already matched (the dome, and the dome with its mount) is not a new object
        if ([...used].some(u => Recog.iou(u, b) > 0.1 || Math.hypot(u.x - b.x, u.y - b.y) < 0.6 * Math.max(u.w, u.h, b.w, b.h))) continue;
        const it = Object.assign({ id: st.recog.nextId++, hist: [1], status: 'maybe', firstT: now, lastT: now, zk: b.zoom || 0, zHits: b.zoom && b.score >= 0.5 ? 1 : 0, hd: bh }, b);
        st.recog.items.push(it); used.add(it);
      }
    }
    const inZ = (it, k) => { const m = (1 - 1 / k) / 2 + 0.02; return it.x > m && it.x < 1 - m && it.y > m && it.y < 1 - m; };
    for (const it of st.recog.items) {
      // a miss only counts from a look that could have seen it: a zoomed look sees only the middle, and a
      // small far camera in the middle is often too small for the wider looks
      const sz = Math.max(it.w, it.h);
      const couldSee = !zk ? !(sz < 0.12 && inZ(it, 2)) : zk === 2 ? inZ(it, 2) && !(sz < 0.06 && inZ(it, 4)) : inZ(it, 4);
      if (!used.has(it) && couldSee) it.hist.push(0);
      while (it.hist.length > 6) it.hist.shift();
    }
    st.recog.items = st.recog.items.filter(it => now - it.lastT < 2500);
    const need = ((Recog.meta && Recog.meta.confirm) || 0.5) + sens().rec;
    for (const it of st.recog.items) {
      const seen = it.hist.reduce((a, b) => a + b, 0);
      // seen in 3 of the last 6 looks that could see it, with a steady score: one odd frame never raises an alarm.
      // Below 70% the zoomed look (the camera's full-resolution picture) must agree twice: a dark round hole or
      // a knob fools the whole-picture look at ~50%, but not the zoomed one. Off-centre, "hold on it" brings it there.
      if (it.status !== 'camera' && seen >= 3 && (it.score >= need + 0.2 || (it.score >= need && (it.zHits || 0) >= 2))) confirmRecognised(it, now, seen);
    }
  }
  /* a camera-like shape that isn't confirmed yet, worth stopping for */
  function recogCandidate(now) {
    let best = null;
    for (const it of st.recog.items) {
      if (it.status === 'camera' || now - it.lastT > 1200 || (it.skipT && now - it.skipT < 15000)) continue;
      // worth stopping for: a clear guess, or a weak one seen more than once (a busy hall throws up many one-off 30% guesses)
      if (!(it.score >= 0.45 || (it.score >= 0.3 && it.hist.reduce((a, b) => a + b, 0) >= 2))) continue;
      if (it.known == null) it.known = !!knownCamera(headingOf(it.x, it.y), 18, e => inViewApart(e, it, now) || glintApart(e, it.x, it.y));   // the camera already found here
      if (it.known) continue;
      if (!best || it.score > best.score) best = it;
    }
    return best;
  }
  function recognisedCamera(now) {
    let best = null;
    for (const it of st.recog.items) if (it.status === 'camera' && now - it.lastT < 1200 && !reported(it, now) && (!best || it.score > best.score)) best = it;
    return best;
  }
  /* full room scan: once a camera has been reported (and saved) for a while, the agent moves on */
  const reported = (x, now) => st.full && x.status === 'camera' && x.foundT != null && now - x.foundT > 9000;
  async function confirmRecognised(it, now, seen) {
    it.status = 'camera'; it.foundT = now;
    const at = st.source === 'file' ? video.currentTime : (now - st.t0) / 1000;
    const dir = st.source === 'camera' && Motion.ok ? Motion.rot.slice() : null;
    const hd = headingOf(it.x, it.y);
    const apart = e => inViewApart(e, it, now) || glintApart(e, it.x, it.y);
    // a recording: the same camera is one found moments ago, or found at this spot in the picture a little earlier
    const near = e => e.x != null && Math.hypot(e.x - it.x, e.y - it.y) < Math.max(0.06, 1.5 * Math.max(e.w, it.w, it.h));
    const same = st.source === 'file'
      ? st.events.some(e => !apart(e) && (Math.abs(e.at - at) < 3 || (Math.abs(e.at - at) < 12 && near(e))))
      : hd ? !!knownCamera(hd, 18, apart)
        : dir ? st.events.some(e => e.dir && !apart(e) && Math.hypot(e.dir[0] - dir[0], e.dir[1] - dir[1], e.dir[2] - dir[2]) < 15)
          : st.events.some(e => e.kind === 'Camera (recognised)' && at - e.at < 20 && !apart(e));
    if (same) { it.foundT = now - 10000; log('SEE', 'Recognised the camera already found at this spot'); return; }
    st.stats.cameras++; st.stats.recognised++;
    st.events.push({ at, dir, hd, id: 'R' + it.id, kind: 'Camera (recognised)', score: it.score, x: it.x, y: it.y, w: Math.max(it.w, it.h) });
    renderEvents();
    log('FOUND', `<b>Camera recognised by its shape</b> · ${Math.round(it.score * 100)}% sure · seen in ${seen} of the last ${it.hist.length} checks${it.zHits ? ` · the zoomed look agreed ${it.zHits}×` : ''}`);
    Agent.onEvent('camera', Object.assign({ kind: 'shape' }, hd));
    vib([220, 90, 220, 90, 420]);
    Voice.say('found', { force: true }); st.lastFoundSay = now;
    const run = st.runId;
    const rec = await saveEvidence(null, 'shape', it);
    if (st.running && run === st.runId && now - st.lastAlertT > 12000) {
      st.lastAlertT = now;
      openAlertRows(`Recognised · ${Math.round(it.score * 100)}% · ${new Date().toLocaleTimeString('en-IN')}`, rec, [
        ['Recognised as a camera by its shape', Math.round(it.score * 100) + '%'],
        [`Seen in ${seen} of the last ${it.hist.length} checks`, 'PASS'],
        ['Size in the picture', `${Math.round(it.w * 100)}×${Math.round(it.h * 100)}%`],
      ]);
    }
  }

  /* ---------- detections timeline ---------- */
  function renderEvents() {
    $('#events').hidden = !st.events.length;
    $('#eventsN').textContent = st.events.length ? String(st.events.length) : '';
    $('#eventList').innerHTML = st.events.map(e => `<li><time>${fmtClock(e.at)}</time><span>${e.kind}</span>${st.source === 'file' ? `<button type="button" data-at="${e.at.toFixed(2)}">Show</button>` : ''}</li>`).join('');
    $$('#eventList button').forEach(b => {
      b.onclick = () => { seekTo(+b.dataset.at - 1.5); if (video.paused) video.play(); };
    });
  }

  /* ---------- a flash test inside a recording ----------
   * During a live scan TwinGaze switches the flash off and on. In a recording of that scan the whole
   * frame goes dark for about a second. A lens glint vanishes in those frames and comes back;
   * a lamp or LED keeps shining. This is read straight from the frames: nothing is simulated. */
  function darkTick(now, res, torch) {
    const m = res.mean;
    if (st.meanEma == null) { st.meanEma = m; return false; }
    const dark = torch === 0 && st.smode === 'lens' ? true
      : torch === 1 ? false
        : st.meanEma > 10 && m < st.meanEma * 0.55;
    if (!dark) st.meanEma += 0.1 * (m - st.meanEma);
    const L = Math.max(st.fw, st.fh);
    if (dark && !st.dark) {
      st.dark = true; st.darkN = 0;
      st.darkTracks = st.tracker.tracks.filter(t => t.visible && !DISMISSED.has(t.status)).map(t => ({ t, x: t.x, y: t.y, seen: 0 }));
    }
    if (dark) {
      st.darkN++;
      for (const d of st.darkTracks) {
        if (res.dets.some(q => Math.hypot((q.x - d.x) * st.fw / L, (q.y - d.y) * st.fh / L) < 0.05)) d.seen++;
      }
    } else if (st.dark) {
      st.dark = false; st.darkEndT = now;
      if (st.darkN >= 3) {
        for (const d of st.darkTracks) {
          const r = d.seen / st.darkN;
          if (r <= 0.25) d.t.darkPass = true;
          else if (r >= 0.6 && st.smode === 'lens' && d.t.status !== 'camera') {
            d.t.flash = 0; d.t.status = 'light'; st.stats.lights++;
            log('CLEAR', `#${d.t.id} kept shining when the flash went off in the recording: a lamp or LED, not a lens`);
          }
        }
      }
      st.darkTracks = [];
    }
    return dark;
  }

  /* ---------- record the raw camera to a video file ----------
   * For making the demo recording: the flash and its on/off tests are captured as they happen,
   * so "Analyse a recorded room video" can run the same tests on it later. */
  const Rec = { mr: null, chunks: [], t0: 0, type: '', samples: [], lastSample: 0, base: null };
  function recSample(now) {
    Rec.lastSample = now;
    Rec.samples.push({
      t: +((now - Rec.t0) / 1000).toFixed(3),
      r: Motion.ok ? Motion.rot.map(v => +v.toFixed(2)) : null,
      m: Mag.ok && Mag.base != null ? +Mag.delta.toFixed(1) : null,
      f: Camera.torchOn ? 1 : 0,
      l: Light.ok ? Math.round(Light.lux) : null,
    });
    if (Mag.base != null) Rec.base = Mag.base;
  }
  function recType() {
    const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return window.MediaRecorder ? types.find(t => MediaRecorder.isTypeSupported(t)) || '' : '';
  }
  function startRec() {
    if (!st.running || st.source !== 'camera' || !Camera.stream) return;
    if (!window.MediaRecorder) { toast('This browser can\'t record video.'); return; }
    const type = recType();
    let mr;
    try { mr = new MediaRecorder(Camera.stream, Object.assign({ videoBitsPerSecond: 8e6 }, type ? { mimeType: type } : {})); }
    catch (e) { toast('Could not start recording.'); return; }
    Rec.mr = mr; Rec.chunks = []; Rec.type = mr.mimeType || type || 'video/webm'; Rec.t0 = performance.now();
    Rec.samples = []; Rec.lastSample = 0; Rec.base = Mag.base;
    mr.ondataavailable = e => { if (e.data && e.data.size) Rec.chunks.push(e.data); };
    mr.onstop = saveRec;
    mr.start(1000);
    log('SYS', `Recording the camera (${esc(Rec.type.split(';')[0])}). The flash and its on/off tests are recorded as they happen.`);
  }
  function stopRec() { if (Rec.mr && Rec.mr.state !== 'inactive') Rec.mr.stop(); }
  function saveRec() {
    const chunks = Rec.chunks, type = Rec.type, secs = (performance.now() - Rec.t0) / 1000;
    const samples = Rec.samples, base = Rec.base;
    Rec.mr = null; Rec.chunks = []; Rec.samples = [];
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type });
    const d = new Date();
    const name = `twingaze-room-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.${/mp4/.test(type) ? 'mp4' : 'webm'}`;
    saveOut(blob, name, 'video').then(where => {
      log('SAVE', `Video saved: ${esc(name)} · ${fmtClock(secs)} · ${(blob.size / 1048576).toFixed(1)} MB · ${esc(where)}`);
      toast(`Video saved: ${where}`);
    }).catch(e => { log('WARN', 'Could not save the video: ' + esc(e.message || e)); toast('Could not save the video.'); });
    const hasSensors = samples.some(x => x.m != null || x.r);
    DB.putRec({ name, size: blob.size, secs: +secs.toFixed(2), created: new Date().toISOString(), base, samples }).then(ok => {
      if (ok) log('SAVE', `Sensor readings saved with it: ${samples.length} samples${hasSensors ? ' (gyroscope, magnetic, flash)' : ' (flash only)'}. Analyse this video on this phone and they play back in sync.`);
    });
  }

  /* ---------- magnetic detector ----------
   * The classic hidden-camera-app sound: the phone's magnetometer against the room's baseline.
   * The beeps speed up as the field bends; past +25 µT it sounds the alarm. */
  const MG = { timer: null, raf: null, t0: 0, hist: [], peak: 0, state: '', lastSay: -1e9, lastUi: 0, warned: false, needle: 0, foundT: -1e9 };
  const MSUB = {
    magCal: 'Hold the phone away from electronics for a moment while it learns the room.',
    magStart: 'Move the phone slowly over objects, a hand\'s width away. The beeps speed up as the field bends.',
    magNear: 'The field is bending. Go closer and slower to find the strongest spot.',
    magFound: 'A powered device or magnet is right here. Point a Lens scan at this spot to look for the lens.',
  };
  function startMagnet() {
    Voice.newSession();
    Beeper.unlock();
    document.body.classList.add('scanning');
    show('magnet');
    st.t0 = performance.now();
    Object.assign(MG, { t0: st.t0, hist: [], peak: 0, state: '', lastSay: -1e9, lastUi: 0, warned: false, needle: 0, foundT: -1e9 });
    $('#log').innerHTML = '';
    $('#mUnavailable').hidden = true;
    $('#mDelta').textContent = '—'; $('#mDelta').className = '';
    log('MAG', 'Magnetic detector started');
    setMInstr('magCal');
    if (!Mag.start()) { magUnavailable(); renderSensors(); return; }
    Wake.on(); Beeper.start();
    Voice.say('magCal', { force: true });
    clearInterval(MG.timer);
    MG.timer = setInterval(magTick, 50);
    cancelAnimationFrame(MG.raf);
    const frame = () => { drawMag(performance.now()); MG.raf = requestAnimationFrame(frame); };
    MG.raf = requestAnimationFrame(frame);
    renderSensors();
  }
  function stopMagnet() {
    clearInterval(MG.timer); MG.timer = null;
    cancelAnimationFrame(MG.raf); MG.raf = null;
    if (MG.peak) log('MAG', `Detector stopped · peak +${MG.peak.toFixed(0)} µT`);
    const secs = (performance.now() - MG.t0) / 1000;
    if (secs > 5 && Mag.ok) addHistory({ kind: 'magnet', room: ROOMS[st.room].name, risk: MG.peak >= 25 ? 'medium' : 'low',
      head: MG.peak >= 25 ? 'Device detected' : 'No strong field', line: `peak +${MG.peak.toFixed(0)} µT · ${fmtDur(secs)}`,
      items: [{ a: 'Peak change from the room', b: `+${MG.peak.toFixed(0)} µT`, bad: MG.peak >= 25 }, { a: 'Sensor', b: Mag.describe() }] });
    Mag.stop(); Beeper.stop(); Voice.stop(); MG.timer = null; releaseWake();
    document.body.classList.remove('scanning');
    renderSensors();
    show(st.backTo || 'home');
  }
  function setMInstr(key) {
    $('#mTag').textContent = key === 'magFound' ? 'Result' : 'Magnetic detector';
    const h = $('#mTitle');
    h.textContent = Voice.title(key); h.lang = Voice.lang;
    $('#mSub').textContent = MSUB[key] || '';
    $('#magnet .instr').classList.toggle('hot', key === 'magFound');
  }
  function magUnavailable() {
    const n = $('#mUnavailable');
    n.hidden = false;
    n.innerHTML = Mag.status === 'flag'
      ? `Chrome keeps the magnetic sensor switched off. On this phone open <code>${MAG_FLAG}</code> in Chrome, set it to <b>Enabled</b>, tap <b>Relaunch</b>, then open TwinGaze again. <button class="btn sm" type="button" id="copyFlag">Copy that address</button>`
      : Mag.status === 'denied' ? 'Permission for motion sensors was denied. Allow <b>Motion sensors</b> for this site in Chrome\'s site settings, then try again.'
        : 'This device or browser gives no magnetic sensor readings. Use Chrome on an Android phone.';
    const c = $('#copyFlag');
    if (c) c.onclick = () => copy(MAG_FLAG, 'Copied. Paste it into Chrome\'s address bar.');
    $('#mTitle').textContent = 'Sensor unavailable'; $('#mTitle').lang = 'en';
    $('#mTag').textContent = 'Magnetic detector'; $('#mSub').textContent = '';
    log('WARN', `Magnetic sensor unavailable (${esc(Mag.status)}).`);
  }
  function magTick() {
    const now = performance.now();
    if (['denied', 'none', 'error', 'flag'].includes(Mag.status) || (!Mag.ok && now - MG.t0 > 4000)) {
      if (!MG.warned) { MG.warned = true; if (!Mag.ok && Mag.status === 'starting') Mag.status = 'none'; magUnavailable(); }
      Beeper.set(0, false);
      return;
    }
    const ready = Mag.ok && Mag.base != null;
    const d = ready ? Math.abs(Mag.delta) : 0;
    if (ready) {
      MG.hist.push({ t: now, d });
      while (MG.hist.length && now - MG.hist[0].t > 12000) MG.hist.shift();
      if (d > MG.peak) MG.peak = d;
    }
    // hysteresis so the state doesn't flicker around a threshold
    const state = !ready ? 'cal'
      : MG.state === 'found' ? (d >= 18 ? 'found' : d >= 8 ? 'near' : 'sweep')
        : d >= 25 ? 'found' : MG.state === 'near' ? (d >= 6 ? 'near' : 'sweep') : d >= 8 ? 'near' : 'sweep';
    Beeper.set(ready ? clamp01((d - 4) / 40) : 0, state === 'found');
    if (state !== MG.state) {
      const prev = MG.state;
      MG.state = state;
      setMInstr({ cal: 'magCal', sweep: 'magStart', near: 'magNear', found: 'magFound' }[state]);
      if (state === 'found') {
        Voice.say('magFound', { force: true }); MG.lastSay = now; MG.foundT = now;
        vib([200, 80, 200]);
        log('MAG', `<b>Device detected</b> · +${d.toFixed(0)} µT from the room baseline of ${Mag.base.toFixed(0)} µT`);
      } else if (state === 'near' && prev === 'sweep') {
        Voice.say('magNear', { repeatMs: 6000 });
        log('MAG', `Field bending · +${d.toFixed(0)} µT`);
      } else if (state === 'sweep' && (prev === 'cal' || prev === '')) {
        Voice.say('magStart', { force: true });
        log('MAG', Mag.source === 'compass'
          ? 'Compass method: the room\'s compass heading is learnt. A swing of the heading while the phone is still means something bends the field.'
          : `Room baseline learnt: ${Mag.base.toFixed(0)} µT (${esc(Mag.describe())})`);
      }
    } else if (state === 'found' && now - MG.lastSay > 3500) { Voice.say('magFound', { force: true }); MG.lastSay = now; }
    if (now - MG.lastUi > 80) { MG.lastUi = now; magUi(now, d, ready); }
  }
  function magUi(now, d, ready) {
    $('#mClock').textContent = fmtClock((now - MG.t0) / 1000);
    const b = $('#mDelta');
    b.textContent = ready ? '+' + d.toFixed(0) : '…';
    b.className = !ready ? '' : d >= 25 ? 'hot' : d >= 8 ? 'warm' : '';
    if (Mag.source === 'compass') {
      $('#mField').textContent = `COMPASS SWING ${Math.abs(Mag.swing).toFixed(0)}°`;
      $('#mBase').textContent = ready ? 'ESTIMATED µT' : 'LEARNING…';
    } else {
      $('#mField').textContent = Mag.value != null ? `FIELD ${Mag.value.toFixed(0)} µT` : 'FIELD —';
      $('#mBase').textContent = Mag.base != null ? `BASELINE ${Mag.base.toFixed(0)} µT` : 'LEARNING…';
    }
    $('#mPeak').textContent = `PEAK +${MG.peak.toFixed(0)} µT`;
    $('#mSrc').textContent = `${Mag.describe().toUpperCase()} · ${Math.round(Mag.rate)}/S`;
    const lvl = ready ? clamp01((d - 4) / 40) : 0;
    $('#mgBar').style.width = Math.round(lvl * 100) + '%';
    $('#mgVal').textContent = Math.round(lvl * 100);
    if (now - st.lastSensT > 1000) { st.lastSensT = now; renderSensors(); }
  }
  /* the detector's dial: needle on a square-root scale (small changes stay visible, big ones fit),
   * calm / near / device zones, pulsing rings while a device is detected, 12 s history below */
  function drawMag(now) {
    const cv = $('#mGraph'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const ready = Mag.ok && Mag.base != null;
    const d = ready ? Math.abs(Mag.delta) : 0;
    const MAX = 100, A0 = 150 * Math.PI / 180, SWEEP = 240 * Math.PI / 180;
    const ang = v => A0 + SWEEP * Math.sqrt(Math.min(v, MAX) / MAX);
    MG.needle += (d - MG.needle) * 0.18;                         // smooth the needle
    const cx = W / 2, cy = H * 0.53, R = Math.min(W * 0.37, H * 0.33);
    const col = v => (v >= 25 ? '#EE3A4F' : v >= 8 ? '#E0A800' : '#141414');

    // pulsing rings while a device is detected
    if (MG.state === 'found') {
      for (let k = 0; k < 3; k++) {
        const ph = ((now - MG.foundT) / 1400 + k / 3) % 1;
        c.strokeStyle = `rgba(238,58,79,${0.55 * (1 - ph)})`; c.lineWidth = 3;
        c.beginPath(); c.arc(cx, cy, R * (1.12 + ph * 0.45), 0, Math.PI * 2); c.stroke();
      }
    }
    // track and zones
    c.lineCap = 'butt';
    c.lineWidth = 16; c.strokeStyle = 'rgba(20,20,20,.07)';
    c.beginPath(); c.arc(cx, cy, R, A0, A0 + SWEEP); c.stroke();
    [[0, 8, 'rgba(20,20,20,.22)'], [8, 25, 'rgba(253,207,88,.95)'], [25, MAX, 'rgba(238,58,79,.55)']].forEach(([a, b, k]) => {
      c.lineWidth = 4; c.strokeStyle = k;
      c.beginPath(); c.arc(cx, cy, R + 14, ang(a) + 0.01, ang(b) - 0.01); c.stroke();
    });
    // live arc up to the needle
    if (MG.needle > 0.3) {
      c.lineWidth = 16; c.strokeStyle = col(MG.needle); c.lineCap = 'round';
      c.beginPath(); c.arc(cx, cy, R, A0, ang(MG.needle)); c.stroke(); c.lineCap = 'butt';
    }
    // peak mark
    if (MG.peak > 1) {
      const pa = ang(MG.peak);
      c.strokeStyle = 'rgba(20,20,20,.6)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx + Math.cos(pa) * (R - 12), cy + Math.sin(pa) * (R - 12)); c.lineTo(cx + Math.cos(pa) * (R + 20), cy + Math.sin(pa) * (R + 20)); c.stroke();
    }
    // ticks and labels
    c.font = '600 10px "JetBrains Mono", Consolas, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    [0, 8, 25, 50, 100].forEach(v => {
      const a = ang(v);
      c.strokeStyle = 'rgba(20,20,20,.4)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); c.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)); c.stroke();
      c.fillStyle = v === 8 ? '#E0A800' : v === 25 ? '#EE3A4F' : 'rgba(20,20,20,.55)';
      c.fillText(String(v), cx + Math.cos(a) * (R + 34), cy + Math.sin(a) * (R + 34));
    });
    // needle
    const na = ang(MG.needle);
    c.strokeStyle = col(MG.needle); c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(cx + Math.cos(na) * (R * 0.62), cy + Math.sin(na) * (R * 0.62)); c.lineTo(cx + Math.cos(na) * (R + 6), cy + Math.sin(na) * (R + 6)); c.stroke();
    c.lineCap = 'butt';
    // 12 s history strip along the bottom
    const top = H - 78, bot = H - 34, span = 12000, hmax = Math.max(40, MG.peak * 1.1);
    const Y = v => bot - (Math.min(v, hmax) / hmax) * (bot - top), X = t => W - ((now - t) / span) * W;
    c.strokeStyle = 'rgba(20,20,20,.12)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, bot + 0.5); c.lineTo(W, bot + 0.5); c.stroke();
    c.setLineDash([3, 4]); c.strokeStyle = 'rgba(238,58,79,.5)';
    c.beginPath(); c.moveTo(0, Y(25)); c.lineTo(W, Y(25)); c.stroke(); c.setLineDash([]);
    if (MG.hist.length > 1) {
      c.beginPath();
      MG.hist.forEach((p, i) => { const x = X(p.t), y = Y(p.d); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
      c.strokeStyle = col(MG.hist[MG.hist.length - 1].d); c.lineWidth = 2; c.stroke();
    }
    c.textAlign = 'start'; c.textBaseline = 'alphabetic';
  }

  /* ---------- Wi-Fi / Bluetooth / network scans (the Radio agent's tools, one at a time) ---------- */
  const RADIO_T = {
    wifi: { title: 'Wi-Fi scan', busy: 'Scanning Wi-Fi…', ms: 4000,
      why: 'Cheap Wi-Fi cameras broadcast their own hotspot (HD-8F2A1C, IPCAM, V380…) until they are set up. Camera makers\' radios are recognised by their hardware address.',
      run: () => Radio.wifiScan(), cls: r => Radio.classifyWifi(r), sum: l => Radio.summaryWifi(l) },
    ble: { title: 'Bluetooth scan', busy: 'Listening for Bluetooth…', ms: 8500,
      why: 'Finds AirTags, Tile and Samsung SmartTag trackers, and Bluetooth devices whose names give them away as cameras.',
      run: () => Radio.bleScan(8000), cls: r => Radio.classifyBle(r), sum: l => Radio.summaryBle(l) },
    lan: { title: 'Network scan', busy: 'Checking every device on this Wi-Fi…', ms: 15000,
      why: 'Checks each device on the Wi-Fi you joined for camera ports (RTSP 554, ONVIF, Dahua, XMEye) and asks cameras to name themselves.',
      run: p => Radio.lanScan({ timeoutMs: 300 }, p), cls: r => Radio.classifyLan(r), sum: l => Radio.summaryLan(l) },
  };
  const bars = dbm => {
    const n = !isFinite(dbm) ? 0 : dbm > -50 ? 4 : dbm > -62 ? 3 : dbm > -74 ? 2 : 1;
    return `<span class="bars" title="${dbm} dBm">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  };
  async function openRadio(kind) {
    const T = RADIO_T[kind], id = st.radioRun = (st.radioRun || 0) + 1;
    st.radioKind = kind;
    show('radio');
    $('#rTitle').textContent = T.title;
    $('#rWhy').textContent = T.why;
    $('#rSummary').innerHTML = ''; $('#rList').innerHTML = ''; $('#rHint').innerHTML = '';
    $('#rProg').style.width = '0%';
    const anim = $('#rAnim');
    anim.className = 'radar-anim sm info';
    $('#rAgain').hidden = true;
    if (!Radio || !Radio.available) {
      anim.classList.add('idle');
      $('#rStatus').textContent = 'Needs the TwinGaze app';
      $('#rHint').innerHTML = 'Browsers aren\'t allowed to list Wi-Fi networks, Bluetooth devices or the devices on your network. Install <b>TwinGaze.apk</b> on the phone (send it over with Office Kit or WhatsApp) and this scan runs there.';
      return;
    }
    $('#rStatus').textContent = T.busy;
    const t0 = performance.now();
    const timer = setInterval(() => {
      if (st.radioRun !== id) { clearInterval(timer); return; }
      if (kind !== 'lan') $('#rProg').style.width = Math.min(95, (performance.now() - t0) / T.ms * 100) + '%';
    }, 200);
    let res, list;
    try {
      res = await T.run(p => { if (st.radioRun === id && p && p.total) $('#rProg').style.width = Math.round(p.done / p.total * 100) + '%'; });
      if (st.radioRun !== id) return;
      list = T.cls(res);
    } catch (e) {
      clearInterval(timer);
      if (st.radioRun !== id) return;
      anim.classList.add('idle');
      $('#rStatus').textContent = e && e.code === 'PERMISSION_DENIED' ? 'Permission needed' : 'Scan failed';
      $('#rHint').textContent = (e && e.message) || String(e);
      $('#rAgain').hidden = false;
      return;
    }
    clearInterval(timer);
    $('#rProg').style.width = '100%';
    anim.classList.add('idle');
    $('#rAgain').hidden = false;
    renderRadio(kind, res, list, T);
  }
  function renderRadio(kind, res, list, T) {
    const hi = list.filter(x => x.risk === 'high'), med = list.filter(x => x.risk === 'medium');
    const flag = res.wifiOff ? 'Wi-Fi is switched off. Switch it on and scan again.'
      : res.bluetoothOff ? 'Bluetooth is switched off. Switch it on and scan again.'
        : res.noWifi ? 'This phone isn\'t on a Wi-Fi network. Join the room\'s Wi-Fi (or a camera\'s hotspot) and scan again.'
          : res.locationOff ? 'Location is switched off, so Android hides the results. Switch Location on and scan again.' : '';
    $('#rStatus').textContent = flag ? 'Nothing to scan' : hi.length ? `${hi.length} likely camera${hi.length > 1 ? 's' : ''} or tracker${hi.length > 1 ? 's' : ''}` : med.length ? 'Something worth a look' : 'Nothing suspicious';
    $('#rWhy').textContent = flag || T.sum(list) + (res.fresh === false ? ' · Android limits Wi-Fi scans: these results are up to a minute old' : '');
    $('#rSummary').innerHTML = `<div class="${hi.length ? 'hot' : ''}"><b>${hi.length}</b><small>likely camera / tracker</small></div>
      <div class="${med.length ? 'warn' : ''}"><b>${med.length}</b><small>worth a look</small></div><div><b>${list.length}</b><small>${kind === 'lan' ? 'devices' : 'found'}</small></div>`;
    $('#rList').innerHTML = list.slice(0, 40).map(x => {
      const name = kind === 'wifi' ? (x.ssid || 'Hidden network') : kind === 'ble' ? (x.name || 'Unnamed device') : x.ip;
      const meta = kind === 'wifi' ? [x.bssid, x.vendor, x.frequency ? (x.frequency > 4900 ? '5 GHz' : '2.4 GHz') : null, x.open ? 'open' : null].filter(Boolean).join(' · ')
        : kind === 'ble' ? [x.address, x.kind !== 'unknown' ? x.kind : null].filter(Boolean).join(' · ')
          : x.ports.length ? 'ports ' + x.ports.join(', ') : 'no camera ports';
      return `<li class="${x.risk}"><div class="rl-h">${kind !== 'lan' ? bars(kind === 'wifi' ? x.level : x.rssi) : ''}<b>${esc(name)}</b><span class="risk ${x.risk === 'low' ? '' : x.risk}">${x.risk === 'high' ? 'likely' : x.risk === 'medium' ? 'check' : 'ok'}</span></div>
        <div class="rl-meta">${esc(meta)}</div>${x.reasons.length ? `<ul class="rl-why">${x.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</li>`;
    }).join('');
    $('#rHint').innerHTML = hi.length || med.length
      ? (kind === 'wifi' ? 'A camera hotspot this close is probably in the room. Walk around and scan again: the bars grow as you get closer. Then point the <b>Lens finder</b> at that spot.'
        : kind === 'ble' ? 'If a tracker isn\'t yours, check your bags, jacket, car and the room. The bars grow as you get closer.'
          : 'Open the address in a browser: a camera usually shows its login page. A camera in a private room that nobody told you about can be reported to 1930.')
      : flag ? '' : 'A clean scan lowers the risk but doesn\'t rule a camera out: many record to a memory card and never use Wi-Fi.';
    addHistory({ kind, risk: hi.length ? 'high' : med.length ? 'medium' : 'low', head: $('#rStatus').textContent, line: T.sum(list),
      items: list.filter(x => x.risk !== 'low').slice(0, 8).map(x => ({ a: kind === 'wifi' ? x.ssid || 'Hidden network' : kind === 'ble' ? x.name || x.address : x.ip, b: x.reasons[0] || x.risk, bad: x.risk === 'high' })) });
  }

  /* ---------- two-way mirror test ---------- */
  const MIR_ILL = [
    '<svg viewBox="0 0 140 90"><line x1="70" y1="6" x2="70" y2="84" stroke-width="4"/><path d="M14 45h38M52 38c8 0 10 14 0 14"/><path d="M88 45h38M88 38c-8 0-10 14 0 14" opacity=".4"/><path d="M58 30v30M82 30v30" stroke-dasharray="3 4" opacity=".7"/></svg>',
    '<svg viewBox="0 0 140 90"><line x1="84" y1="6" x2="84" y2="84" stroke-width="4"/><rect x="58" y="22" width="22" height="46" rx="4"/><circle cx="74" cy="31" r="3"/><path d="M92 30l26-10M92 45h30M92 60l26 10" opacity=".6"/></svg>',
    '<svg viewBox="0 0 140 90"><rect x="70" y="6" width="54" height="78" rx="3" stroke-width="3"/><path d="M26 52c0-10 8-16 16-16h10v24H38c-7 0-12-3-12-8zM52 40h8M52 48h8M52 56h8"/><path d="M84 30a14 14 0 0 1 0 30M92 22a24 24 0 0 1 0 46" opacity=".6"/></svg>',
  ];
  const MIRROR = [
    { title: 'Fingernail test', text: 'Touch the mirror with the tip of your fingernail. An ordinary mirror leaves a small gap between the nail and its reflection, because the silver is behind the glass. If your nail meets its reflection with no gap, the coated side faces you: that is how two-way mirrors are fitted.',
      a: ['There\'s a gap', 0], b: ['No gap, they touch', 1] },
    { title: 'Flashlight test', cam: true, text: 'Press the back of the phone against the mirror. The flash is on and the camera turned up. On an ordinary mirror you only see a bright blur. If you can see a room, a space or a camera behind the glass, it is a two-way mirror.',
      a: ['Only a blur', 0], b: ['I see a space behind', 2] },
    { title: 'Knock test', text: 'Knock gently on the mirror with a knuckle. A mirror stuck to a wall sounds dull and flat. A hollow, echoing sound means there is a space behind it, where a camera or a room could be.',
      a: ['Dull and flat', 0], b: ['Hollow, echoing', 1] },
  ];
  function openMirror() { st.mir = { step: 0, score: 0, ans: [] }; show('mirror'); mirStep(); }
  async function mirStep() {
    const M = st.mir;
    if (!M) return;
    const step = M.step, S = MIRROR[step];
    // closed or moved on while the camera was opening: let go of it, and change nothing on screen
    const stale = () => { if (st.mir === M && M.step === step) return false; if (st.mir !== M && Camera.track) { Camera.setTorch(false); Camera.stop(); } return true; };
    $('#mirBtns').innerHTML = '';                        // no second answer while this step opens
    $('#mirStep').textContent = S ? `${M.step + 1} / 3` : 'Result';
    $$('#mirDots li').forEach((li, i) => li.classList.toggle('on', i === M.step));
    const mv = $('#mirVideo');
    if (S && S.cam) {
      $('#mirView').hidden = false; $('#mirIll').hidden = true;
      try {
        await Camera.start(mv, { facing: 'environment' });
        if (stale()) return;
        if (!Camera.hasTorch) await Camera.findTorchCamera(mv);
        if (stale()) return;
        await Camera.setTorch(true);
        if (stale()) return;
        if (Camera.hasExposure) Camera.setExposure(2);
        $('.mir-tag').textContent = Camera.hasTorch ? 'FLASH ON · EXPOSURE UP' : 'NO FLASH CONTROL · USE ANOTHER TORCH';
      } catch (e) {
        if (stale()) return;
        $('#mirView').hidden = true; $('#mirIll').hidden = false; $('#mirIll').innerHTML = MIR_ILL[1];
        toast('Could not open the camera: shine another phone\'s torch against the mirror instead.');
      }
    } else {
      if (Camera.track) { await Camera.setTorch(false); Camera.stop(); }
      if (stale()) return;
      $('#mirView').hidden = true; $('#mirIll').hidden = false;
    }
    if (S) {
      if (!S.cam) $('#mirIll').innerHTML = MIR_ILL[M.step];
      $('#mirTitle').textContent = S.title;
      $('#mirText').textContent = S.text;
      $('#mirBtns').innerHTML = `<button class="btn" type="button" data-pts="${S.a[1]}">${esc(S.a[0])}</button><button class="btn" type="button" data-pts="${S.b[1]}">${esc(S.b[0])}</button>`;
      $$('#mirBtns [data-pts]').forEach(b => {
        b.onclick = () => { M.score += +b.dataset.pts; M.ans.push({ a: S.title, b: b.textContent, bad: +b.dataset.pts > 0 }); M.step++; mirStep(); };
      });
      return;
    }
    const risk = M.score >= 2 ? 'high' : M.score === 1 ? 'medium' : 'low';
    const col = risk === 'high' ? 'var(--red)' : risk === 'medium' ? 'var(--yellow-ink)' : 'var(--green)';
    $('#mirIll').innerHTML = `<svg viewBox="0 0 24 24" style="height:64px;width:64px;color:${col}"><use href="#${risk === 'low' ? 'i-check' : 'i-alert'}"/></svg>`;
    $('#mirTitle').textContent = risk === 'high' ? 'Could be two-way' : risk === 'medium' ? 'Probably ordinary' : 'Ordinary mirror';
    $('#mirText').textContent = risk === 'high' ? 'Two or more signs of a two-way mirror. Cover it with a towel, don\'t change or shower in front of it, and ask for another room. If you feel unsafe, use SOS.'
      : risk === 'medium' ? 'One sign of a two-way mirror. Do the flashlight test again with the room lights off: it is the most reliable of the three.' : 'All three checks look like an ordinary mirror.';
    $('#mirBtns').innerHTML = '<button class="btn" type="button" id="mirAgain">Test again</button><button class="btn pri" type="button" id="mirDone">Done</button>';
    $('#mirAgain').onclick = openMirror;
    $('#mirDone').onclick = closeMirror;
    addHistory({ kind: 'mirror', risk, head: $('#mirTitle').textContent, line: `${M.ans.filter(a => a.bad).length} of 3 signs`, items: M.ans });
  }
  async function closeMirror() {
    st.mir = null;
    if (Camera.track) { await Camera.setTorch(false); Camera.stop(); }
    $('#mirVideo').srcObject = null;
    show(st.backTo || 'home');
  }

  /* ---------- SOS: contacts, message, siren, fake call, shake ---------- */
  function openSos() {
    const cs = Safety.contacts();
    $('#sosShareSub').textContent = cs.length ? `Text a map link to ${cs[0].name || cs[0].phone}` : 'Send a map link to someone you trust';
    $('#sos').hidden = false;
    vib(40);
  }
  // shake the phone hard 3 times anywhere in TwinGaze: the SOS sheet opens (a scan's slow moves are far below
  // 2.6 g). With the app closed, "Protection outside the app" does the same through its own service.
  const shaker = new Safety.ShakeDetector(() => {
    if (!$('#fcall').hidden || !$('#sirenOv').hidden || !$('#sos').hidden) return;
    log('SYS', 'Shake detected: SOS opened');
    vib([120, 60, 120]);
    openSos();
  });
  window.addEventListener('devicemotion', e => {
    const a = e.accelerationIncludingGravity;
    if (a) shaker.feed(a.x, a.y, a.z, performance.now());
  });
  async function where() {
    try {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }));
      return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    } catch (e) { return null; }
  }
  /* opens a text to the trusted contacts (or the share sheet) with the location and the findings;
   * the person presses send. withFindings=false: location only. */
  async function sosShare(withFindings) {
    const cs = Safety.contacts();
    toast('Finding your location…');
    const [pos, f] = await Promise.all([where(), latestFindings()]);
    if (!pos) toast('Location unavailable: the message goes without it.');
    const place = f.room && Date.now() - new Date(f.room.time).getTime() < 12 * 3600 * 1000 ? f.room.room : null;
    const text = withFindings === false ? Safety.sosMessage(pos, [], new Date()).replace(/^SOS: I don't feel safe\. Please call me now\./, 'Here is my location.')
      : Safety.sosMessage(pos, f.lines, new Date(), place);
    log('SYS', `SOS message prepared for ${cs.length ? cs.length + ' trusted contact' + (cs.length > 1 ? 's' : '') : 'the share sheet'}${pos ? ' with the location' : ' (no location)'}: nothing is sent until you press send`);
    if (cs.length) { location.href = Safety.smsUri(cs.map(c => c.phone), text); return; }
    try {
      if (Native.available) await Native.share('I need help', text, []);
      else if (navigator.share) await navigator.share({ text });
      else copy(text, 'Message copied. Paste it into WhatsApp or SMS.');
    } catch (e) { if (e && e.name !== 'AbortError') copy(text, 'Message copied. Paste it into WhatsApp or SMS.'); }
  }
  const siren = new Safety.Siren(Native, document.getElementById('sirenOv'));
  function startSiren() {
    $('#sos').hidden = true;
    Wake.on();
    siren.start();
    log('SYS', 'Siren and flash strobe on');
  }
  function stopSiren() { siren.stop(); releaseWake(); }

  let ringVib = null;
  // a phone-style ring (two short 400+450 Hz bursts every 3 s) when the phone's own ringtone isn't available
  const webRing = {
    ctx: null, t: null,
    start() {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C || this.t) return;
        const c = this.ctx = this.ctx || new C();
        const burst = at => [400, 450].forEach(f => {
          const o = c.createOscillator(), g = c.createGain();
          o.frequency.value = f; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
          g.gain.setValueAtTime(0.12, at + 0.37); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
          o.connect(g).connect(c.destination); o.start(at); o.stop(at + 0.42);
        });
        const ring = () => { const t0 = c.currentTime + 0.02; burst(t0); burst(t0 + 0.6); };
        if (c.state === 'suspended') c.resume();
        ring(); this.t = setInterval(ring, 3000);
      } catch (e) { /* no web audio */ }
    },
    stop() { clearInterval(this.t); this.t = null; },
  };
  const fake = new Safety.FakeCall({
    ring(on) {
      clearInterval(ringVib);
      if (on) {
        Native.ringtone(true).then(r => { if (!r || !r.ok) webRing.start(); });
        vib([700, 500, 700]); ringVib = setInterval(() => vib([700, 500, 700]), 2400);
      } else { Native.ringtone(false); webRing.stop(); }
    },
    show(state, name, secs) {
      const ov = $('#fcall');
      if (state === 'off') { ov.hidden = true; releaseWake(); return; }
      ov.hidden = false;
      ov.className = 'fcall ' + state;
      $('#fcName').textContent = name;
      $('#fcAv').textContent = (name || '?').trim().charAt(0).toUpperCase();
      $('#fcState').textContent = state === 'ringing' ? 'Incoming call' : 'Ongoing call';
      $('#fcSub').textContent = state === 'ringing' ? 'Mobile' : `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
      $('#fcRingBtns').hidden = state !== 'ringing'; $('#fcTalkBtns').hidden = state !== 'talking';
    },
  });
  const callerName = () => { try { return localStorage.getItem('twingaze-caller') || 'Mom'; } catch (e) { return 'Mom'; } };
  function openFakeCall() {
    $('#sos').hidden = true;
    $('#fcWho').value = callerName();
    $('#fcSheet').hidden = false;
  }
  function startFakeCall(delay) {
    const name = $('#fcWho').value.trim() || callerName();
    try { localStorage.setItem('twingaze-caller', name); } catch (e) { /* private mode */ }
    $('#fcSheet').hidden = true;
    // later than "now": the phone rings it natively, so it still rings if you lock the phone or leave the app
    if (delay && Safety.Protect.available) {
      Safety.Protect.fakeCall(delay, name).then(() => toast(`${name} will call in ${delay < 60 ? delay + ' s' : Math.round(delay / 60) + ' min'}. You can lock the phone.`))
        .catch(() => { Wake.on(); fake.schedule(delay, name); });
      return;
    }
    Wake.on();                                          // the screen must stay on for the call to "arrive"
    fake.schedule(delay, name);
    if (delay) toast(`${name} will call in ${delay < 60 ? delay + ' s' : Math.round(delay / 60) + ' min'}. Keep TwinGaze open.`);
  }

  /* ---------- protection outside the app ---------- */
  const Protect = Safety.Protect;
  async function protectConfig() {
    const D = window.TGSpywareDB;
    const cs = Safety.contacts();
    const f = await latestFindings().catch(() => ({ lines: [] }));
    return {
      contacts: cs, caller: callerName(), note: (f.lines || []).join(' ').slice(0, 200),
      spyPkgs: D ? [...new Set(D.apps.flatMap(a => a.packages || []))] : [],
      spyCerts: D ? [...new Set(D.apps.flatMap(a => a.certs || []))] : [],
    };
  }
  async function protectSync() { if (Protect.available) { try { await Protect.configure(await protectConfig()); } catch (e) { /* not critical */ } } }
  async function protectRender(stt) {
    const sw = $('#cProtect');
    if (!Protect.available) {
      sw.disabled = true; sw.setAttribute('aria-pressed', 'false'); sw.textContent = 'Off';
      $('#protSub').textContent = 'Needs the TwinGaze app on an Android phone';
      return;
    }
    const s = stt || await Protect.status().catch(() => null);
    if (!s) return;
    sw.setAttribute('aria-pressed', String(s.on)); sw.textContent = s.on ? 'On' : 'Off';
    $('#protActs').hidden = !s.on;
    $('#protBattery').hidden = !s.on || (s.unrestricted && !s.oem);
    $('#protBattery').textContent = s.unrestricted ? 'Allow Autostart' : 'Keep it running';
    $('#protNotif').hidden = !s.on || s.notifications;
    $('#protSms').hidden = !s.on || s.sms;
    const cs = Safety.contacts();
    $('#protSub').textContent = !s.on ? 'SOS when you press the power button 3 times or shake the phone, even with TwinGaze closed'
      : !s.notifications ? 'On, but notifications are blocked: you would not see the SOS countdown or its Cancel button. Allow notifications.'
      : !cs.length ? 'On · add a trusted contact above: the SOS text goes to them'
        : !s.sms ? `On · SMS not allowed, so the SOS opens a text to ${cs[0].name || cs[0].phone} for you to send`
          : `On · power button 3× or shake → 5 s to cancel → SMS with your location to ${cs[0].name || cs[0].phone}` + (s.unrestricted ? '' : ' · allow it to run in the background');
  }
  async function toggleProtect() {
    if (!Protect.available) return;
    const s = await Protect.status();
    try {
      const r = s.on ? await Protect.stop() : await Protect.start(await protectConfig());
      protectRender(r);
      if (!s.on) {
        log('SYS', `Protection outside the app is on${r.sms ? '' : ' (SMS not allowed: the SOS text opens for you to send)'}${r.location ? '' : ' (no location permission)'}`);
        toast(r.unrestricted ? 'Protection on. Press power 3× or shake for SOS.' : 'Protection on. Allow TwinGaze to run in the background so the phone does not stop it.');
        if (!r.unrestricted) Protect.allowBackground().catch(() => {});
      } else log('SYS', 'Protection outside the app is off');
    } catch (e) { toast((e && e.message) || 'Could not change protection'); }
  }

  /* ---------- first run: how it works ---------- */
  const OB = [
    { k: 'Hidden camera finder', h: 'Is someone<br>watching?', p: 'TwinGaze turns your phone into a hidden-camera finder. It walks you round the room and checks each hiding spot.',
      art: '<div class="ob-orb"><svg class="big"><use href="#logo"/></svg></div>' },
    { k: 'Room and phone', h: 'Cameras in the room,<br>spyware on the phone', p: 'It spots camera shapes, catches a hidden lens with the flash, senses electronics, and scans Wi-Fi and Bluetooth. Phone check looks for spy apps on the phone itself.',
      art: '<div class="ob-orb"><svg><use href="#i-radar"/></svg></div>' },
    { k: 'Follow the voice', h: '“Turn right 60°<br>to the clock”', p: 'It remembers where everything is. Guidance in English, हिंदी and తెలుగు, or silently by vibration in Discreet mode.',
      art: '<div class="ob-orb"><svg><use href="#i-sound"/></svg></div>' },
    { k: 'Private by design', h: 'Nothing leaves<br>this phone', p: 'Everything runs on the phone, even offline. Photos get a fingerprint that shows they were not edited, and a complaint is ready for 1930.',
      art: '<div class="ob-orb"><svg><use href="#i-shield"/></svg></div>' },
  ];
  function openOnboard() { st.ob = 0; $('#onboard').hidden = false; obRender(); }
  function obRender() {
    const o = OB[st.ob];
    $('#obSlides').innerHTML = `<div class="ob-slide"><div class="ob-art">${o.art}</div><p class="kicker">${o.k}</p><h2>${o.h}</h2><p>${o.p}</p></div>`;
    $('#obDots').innerHTML = OB.map((_, i) => `<li class="${i === st.ob ? 'on' : ''}"></li>`).join('');
    $('#obNext').textContent = st.ob === OB.length - 1 ? 'Get started' : 'Next';
  }
  function obClose() { $('#onboard').hidden = true; try { localStorage.setItem('twingaze-ob', '1'); } catch (e) { /* private mode */ } }

  /* ---------- launch screen: real start-up steps, then the models warm up in the background ---------- */
  function closeSplash() {
    const sp = $('#splash');
    if (!sp || sp.classList.contains('out')) return;
    sp.classList.add('out');
    document.body.classList.remove('booting'); document.body.classList.add('ready');
    setTimeout(() => sp.remove(), 700);
  }
  async function boot() {
    const bar = $('#splashBar'), msg = $('#splashMsg'), t0 = performance.now();
    const step = (p, m) => { bar.style.width = p + '%'; msg.textContent = m; };
    setTimeout(closeSplash, 8000);                  // safety net: the launch screen never stays up
    step(20, 'Loading the interface');
    try { await Promise.race([document.fonts.ready, sleep(1500)]); } catch (e) { /* fonts are optional */ }
    step(46, 'Loading your scans');
    try { await Promise.race([DB.open(), sleep(1500)]); } catch (e) { /* storage blocked: the app still works */ }
    try { await renderRecent(); } catch (e) { console.error('history', e); }
    step(70, 'Checking the sensors');
    try { renderSensors(); } catch (e) { console.error('sensors', e); }
    await sleep(220);
    step(90, 'Loading the camera finder');
    await sleep(Math.max(0, 2000 - (performance.now() - t0)));
    step(100, 'Ready');
    await sleep(280);
    closeSplash();
    let seen = false;
    try { seen = localStorage.getItem('twingaze-ob') === '1'; } catch (e) { /* private mode */ }
    if (!seen && !/[?&]noob\b/.test(location.search)) setTimeout(openOnboard, 450);
    setTimeout(warmModels, 1500);
  }
  /* load both neural networks while you're on Home, so a scan starts at once */
  function warmModels() {
    const chip = $('#aiState');
    const upd = () => {
      const ok = Recog.ready && Objects.ready, err = Recog.error && Objects.error;
      chip.className = ok ? 'ok' : '';
      chip.innerHTML = '<i></i>' + (ok ? 'Ready · works offline' : err ? 'Shape check unavailable' : 'Getting ready…');
      renderSensors();
    };
    upd();
    if (!Recog.ready && !Recog.loading) Recog.load().then(upd, upd);
    if (!Objects.ready && !Objects.loading) Objects.load().then(upd, upd);
  }

  /* ---------- how it detects ---------- */
  const HOW = [
    { g: 'g-grad', icon: 'i-scan', name: 'Guided scan', uses: 'Walks you round the room',
      p: 'Plans the full room scan, remembers where each hiding spot is and walks you to it ("turn right 60°, to the clock"). It follows fixed rules, so it is instant and works offline, and each step is shown with its reason.',
      tags: ['Plan → survey → inspect → report', 'Orientation sensor', 'Room memory'],
      good: 'Nothing gets skipped: coverage map, ceiling, every hiding spot', lim: 'Turn angles drift a few degrees a minute; it re-aims by the picture' },
    { g: 'g-cyan', icon: 'i-eye', name: 'Camera recogniser', uses: 'A camera-shape model we trained',
      p: 'Recognises cameras by their shape (CCTV domes, bullets, PTZ, webcams) and phones, even with the lights on. A phone can record like any camera, so the agent walks you to it and tests its lens with the flash: a lens glint on a phone means its camera faces you. Every other check zooms into the middle of the picture (2x, then 4x) at the camera\'s full resolution, so a small or far camera you point at gets up to 4x the pixels; anything camera-like makes it say "hold on it". A box counts after it shows up in 3 of the last 6 looks that could see it, at 50% or more.',
      tags: ['YOLO11s · 9.4 M parameters', 'Cameras · smoke detectors · phones', '2x + 4x zoomed looks', 'ONNX Runtime · GPU'],
      good: 'Security cameras, and phones left in the room to record', lim: 'A pinhole in a clock looks like a clock: that is the glint test\'s job' },
    { g: 'g-blue', icon: 'i-flash', name: 'Lens glint', uses: 'Flash + camera + gyroscope',
      p: 'A lens bounces the flash straight back, like a cat\'s eye. Every tiny sharp point of light is tested: the flash goes off and on (a lens goes dark with it, a lamp doesn\'t), then you slide the phone sideways. The orientation sensor tells real sideways movement from just turning, and the surface around the point is followed frame by frame: a lens stays on its object and keeps shining, a reflection on something shiny slides across it. A glint alone can\'t tell a lens from a shiny bead, so "Camera found" also needs a second sign: a magnetic jump, a camera shape, or a device with a camera at the spot (a phone, tablet, camera, or the top bezel of a laptop or monitor, where the webcam is). Without one it is saved as a "possible lens" for you to look at.',
      tags: ['Flash on/off test ×2', 'Sideways test', 'Stays-on-its-object test', 'Second sign needed'],
      good: 'Pinhole cameras hidden in objects', lim: 'Needs a line of sight; 1–2 m in a lit room, the whole room in the dark' },
    { g: 'g-violet', icon: 'i-moon', name: 'Night vision', uses: 'Camera, lights off, flash off',
      p: 'Night-vision cameras light the room with infrared LEDs you can\'t see. A phone camera sees them as small purple-white dots, which this detector looks for.',
      tags: ['Infrared tint', 'Angle test'],
      good: 'Cameras that record in the dark', lim: 'Needs a dark room; some phone cameras filter infrared' },
    { g: 'g-amber', icon: 'i-magnet', name: 'Magnetic', uses: 'The phone\'s magnetometer',
      p: 'Powered electronics bend the magnetic field. The beeper speeds up as you get closer; past +25 µT from the room\'s baseline there is a device right there.',
      tags: ['µT from the room baseline', 'Beeper + dial'],
      good: 'Confirming a hiding spot has electronics inside', lim: 'Chargers, speakers and steel bend it too; works within a few cm' },
    { g: 'g-blue', icon: 'i-wifi', name: 'Radio', uses: 'Wi-Fi, Bluetooth, network · in the app',
      p: 'Cheap cameras broadcast their own hotspot (HD-xxxx, IPCAM, V380). Camera makers are recognised by their hardware address, trackers by their Bluetooth signature, and cameras on your Wi-Fi by their ports (RTSP 554, ONVIF).',
      tags: ['IEEE maker registry', 'AirTag · Tile · SmartTag', 'RTSP · ONVIF'],
      good: 'Wi-Fi cameras and trackers anywhere nearby', lim: 'A camera that records to a memory card sends nothing' },
    { g: 'g-teal', icon: 'i-grid', name: 'Room objects', uses: 'An object model',
      p: 'Names what is in view (clock, frame, smoke detector, socket, mirror, lamp, person) so the agent knows which hiding spots are in the room and ticks each one off once it has been checked with the flash.',
      tags: ['YOLOv8n · Open Images', '49 room objects'],
      good: 'Making sure every hiding spot gets checked', lim: 'It names objects; it can\'t see inside them' },
    { g: 'g-green', icon: 'i-phonecheck', name: 'Phone check', uses: 'Installed apps and settings · in the app',
      p: 'Compares every app with a public list of known stalkerware, by package name and by signing certificate, and flags apps that act like spyware: no app icon, reading your screen, managing the device, reading your notifications. It also checks whether any app is using the camera or microphone right now, and lists every app allowed to.',
      tags: [], good: 'Commercial stalkerware and monitoring apps', lim: 'Not an antivirus; spyware nobody has listed shows up only through its behaviour' },
    { g: 'g-blue', icon: 'i-shield', name: 'Network check', uses: 'Android network info, Wi-Fi and device scans · in the app',
      p: 'Reads how the Wi-Fi you are on is protected, spots a fake open copy of its name (an "evil twin"), a sign-in page or a proxy in the middle, and tells you whether the Wi-Fi owner can log every site you visit (no Private DNS, no VPN). Then it asks every device on the Wi-Fi what it is: routers, TVs and cameras describe themselves (UPnP, ONVIF), and the router names the rest.',
      tags: ['Evil-twin check', 'Private DNS · VPN · proxy', 'UPnP + ONVIF + names'],
      good: 'PG, hostel and hotel Wi-Fi run by someone else', lim: 'Devices that ignore every request (many phones) are not listed' },
    { g: 'g-green', icon: 'i-lock', name: 'App trackers', uses: 'The code of each downloaded app · in the app',
      p: 'Searches every downloaded app for the code of about 60 known tracking and advertising libraries: screen recorders, location-data brokers, ad networks and the SDKs that link you across apps, next to what each app can also reach (location, camera, contacts).',
      tags: ['~60 tracker SDKs', 'Screen-recording SDKs', 'Which companies get your data'],
      good: 'Seeing which apps pass your data on, and to whom', lim: 'An app can still track you with code that is not on the list' },
  ];
  function renderHow() {
    const db = Guard && Guard.dbInfo ? Guard.dbInfo() : null;
    const t = Recog.meta && Recog.meta.test;
    if (t && t.phone) HOW[1].tags[2] = `Tested: ${t.camera.found}/${t.camera.of} cameras, ${t.phone.found}/${t.phone.of} phones`;
    HOW[HOW.length - 1].tags = db ? [`${db.stalkerware} stalkerware + ${db.watchware} monitoring apps`, `${db.name} · ${db.licence}`, 'Uninstall with one tap'] : ['Known-stalkerware list', 'Permission analysis'];
    $('#howList').innerHTML = HOW.map(h => `<article class="how-card">
      <header><span class="d-ic ${h.g}"><svg><use href="#${h.icon}"/></svg></span><span><h3>${h.name}</h3><small>${h.uses}</small></span></header>
      <p>${esc(h.p)}</p>
      <div class="how-tags">${h.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="how-meta"><div class="good"><b>Good at</b>${esc(h.good)}</div><div class="lim"><b>Limits</b>${esc(h.lim)}</div></div>
    </article>`).join('');
  }

  /* ---------- phone check: spyware / stalkerware on this phone ---------- */
  const trustedApps = () => { try { return new Set(JSON.parse(localStorage.getItem('twingaze-trusted') || '[]')); } catch (e) { return new Set(); } };
  function setTrusted(pkg, on) {
    const t = trustedApps();
    if (on) t.add(pkg); else t.delete(pkg);
    try { localStorage.setItem('twingaze-trusted', JSON.stringify([...t])); } catch (e) { /* private mode */ }
  }
  const setRing = p => { $('#gRing').style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, p))); };
  const setNRing = p => { $('#nRing').style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, p))); };

  /* ---------- network check: is this Wi-Fi private? ---------- */
  async function openNet(from) {
    st.backTo = from || st.tab || 'home';
    const id = st.netRun = (st.netRun || 0) + 1;
    show('net');
    const orb = $('#nOrb');
    orb.className = 'g-orb scanning';
    $('#nIcon').innerHTML = '<use href="#i-wifi"/>';
    setNRing(3); $('#nPct').textContent = '0%';
    $('#nTitle').textContent = 'Checking this network';
    $('#nSub').textContent = 'Is this Wi-Fi private? Who can see what you do on it?';
    $('#nSum').hidden = true; $('#nBody').hidden = true; $('#nBtns').hidden = true; $('#nAgain').hidden = false;
    $('#nDone').textContent = 'Done';
    if (!Net || !Net.available) {
      orb.className = 'g-orb review';
      $('#nIcon').innerHTML = '<use href="#i-lock"/>'; $('#nPct').textContent = 'App';
      setNRing(100);
      $('#nTitle').textContent = 'Needs the TwinGaze app';
      $('#nSub').textContent = 'A browser can\'t read how the Wi-Fi is protected or scan it. Install TwinGaze.apk on the phone and the check runs there.';
      $('#nBtns').hidden = false; $('#nAgain').hidden = true;
      return;
    }
    let shown = 0;
    st.netP = 3;
    const tick = setInterval(() => {
      if (st.netRun !== id) { clearInterval(tick); return; }
      shown += Math.max(0.3, ((st.netP || 0) - shown) * 0.2);
      shown = Math.min(shown, Math.max(st.netP, 6), 97);
      setNRing(shown); $('#nPct').textContent = Math.round(shown) + '%';
    }, 80);
    log('NET', 'Network check started: how this Wi-Fi is protected, who can see your browsing, and the devices on it');
    let info = null, scan = null, lan = null;
    try {
      $('#nSub').textContent = 'Reading the connection…';
      info = await Net.info();
      st.netP = 12;
      $('#nSub').textContent = 'Looking for copies of this Wi-Fi nearby…';
      try { scan = await Radio.wifiScan(); } catch (e) { log('WARN', `Wi-Fi list unavailable: ${esc((e && e.message) || e)}`); }
      if (st.netRun !== id) return;
      st.netP = 25;
      if (info.wifi) {
        $('#nSub').textContent = 'Finding the devices on this Wi-Fi…';
        try {
          lan = await Radio.lanScan({}, pr => { if (st.netRun === id && pr && pr.total) st.netP = 25 + 70 * pr.done / pr.total; });
        } catch (e) { log('WARN', `Device scan failed: ${esc((e && e.message) || e)}`); }
      }
      if (info.wifi && !info.wifi.securityType && scan) info = Object.assign({}, info);   // security comes from the scan below
    } catch (e) {
      clearInterval(tick);
      if (st.netRun !== id) return;
      orb.className = 'g-orb review';
      $('#nTitle').textContent = 'The check could not run';
      $('#nSub').textContent = (e && e.message) || String(e);
      $('#nBtns').hidden = false;
      return;
    }
    clearInterval(tick);
    if (st.netRun !== id) return;
    setNRing(100); $('#nPct').textContent = '100%';
    await sleep(250);
    renderNet(info, scan, lan);
  }
  function renderNet(info, scan, lan) {
    const lanList = lan && lan.hosts ? Radio.classifyLan(lan) : [];
    const r = Net.assess(info, scan, lan, lanList);
    st.netRes = r;
    const v = r.verdict === 'offline' ? 'review' : r.verdict;
    $('#nOrb').className = 'g-orb ' + v;
    $('#nIcon').innerHTML = `<use href="#${v === 'safe' ? 'i-shield' : v === 'danger' ? 'i-alert' : 'i-info'}"/>`;
    $('#nPct').textContent = v === 'safe' ? 'Private' : v === 'danger' ? 'Risk' : 'Review';
    $('#nTitle').textContent = r.title;
    $('#nSub').textContent = r.sub;
    const d = r.devices;
    $('#nSum').hidden = false;
    $('#nSum').innerHTML = `<div class="${r.counts.bad ? 'hot' : 'ok'}"><b>${r.counts.bad}</b><small>serious</small></div>
      <div class="${r.counts.warn ? 'warn' : 'ok'}"><b>${r.counts.warn}</b><small>to fix</small></div>
      <div class="${d && d.cameras ? 'hot' : ''}"><b>${d ? (d.alive || d.list.length) : '—'}</b><small>devices on it</small></div>`;
    $('#nBody').hidden = false; $('#nBtns').hidden = false;
    const icon = st2 => st2 === 'ok' ? 'i-check' : st2 === 'info' ? 'i-info' : 'i-alert';
    $('#nChecks').innerHTML = r.checks.map(c => `<div class="dev-row"><span class="st ${c.status}"><svg><use href="#${icon(c.status)}"/></svg></span>
      <div><b>${esc(c.title)}</b><small>${esc(c.detail || '')}</small></div>${c.action && c.status !== 'ok' ? `<button class="chipbtn" type="button" data-npage="${esc(c.action.page)}">Fix</button>` : ''}</div>`).join('');
    // every device that answered, cameras first, with what it says it is
    const known = new Map(lanList.map(h => [h.ip, h]));
    const all = ((lan && lan.alive) || []).map(a => known.get(a.ip) || { ip: a.ip, name: a.name, kind: 'other', reasons: [], what: a.name && Radio.identity ? (Radio.identity({ name: a.name }) || {}).what || null : null });
    for (const h of lanList) if (!all.some(a => a.ip === h.ip)) all.push(h);
    const rank = { camera: 0, maybe: 1, other: 2 };
    all.sort((a, b) => rank[a.kind] - rank[b.kind] || ipSort(a.ip, b.ip));
    const gw = lan && lan.gateway, self = lan && lan.self;
    $('#nDevN').textContent = all.length ? String(all.length) : '';
    $('#nDevices').innerHTML = !lan ? '<p class="empty">Connect to a Wi-Fi to see the devices on it.</p>'
      : all.length ? all.slice(0, 60).map(h => `<div class="nd-row ${h.kind === 'camera' ? 'cam' : h.kind === 'maybe' ? 'maybe' : ''}"><div>
          <b>${esc(h.label || h.name || h.ip)}</b><small>${esc(h.ip)}${h.ip === gw ? ' · your router' : ''}${h.name && h.label && h.name !== h.label ? ' · ' + esc(h.name) : ''}${h.reasons && h.reasons[0] ? ' · ' + esc(h.reasons[0]) : ''}</small></div>
          <span class="tag">${h.kind === 'camera' ? 'CAMERA' : h.kind === 'maybe' ? 'CHECK' : esc(h.what || (h.ip === gw ? 'Router' : 'Device'))}</span></div>`).join('')
        : '<p class="empty">No device answered. Some networks keep devices apart (client isolation).</p>';
    $('#nHint').textContent = 'Read-only: TwinGaze reads what Android knows about this connection and asks devices on this Wi-Fi to identify themselves. Nothing leaves the phone. Devices that ignore all requests (many phones) are not listed.' + (self ? ` This phone: ${self}.` : '');
    $$('#nChecks [data-npage]').forEach(b => { b.onclick = () => Guard.openSettings(b.dataset.npage).catch(e => toast(e.message)); });
    if (st.netSaved !== r) {
      st.netSaved = r;
      log('NET', esc(Net.summary(r)));
      r.checks.filter(c => c.status === 'bad').forEach(c => log('FOUND', `<b>${esc(c.title)}</b>`));
      addHistory({ kind: 'net', risk: r.verdict === 'danger' ? 'high' : r.verdict === 'review' ? 'medium' : 'low', head: r.title, room: r.wifi && r.wifi.ssid ? r.wifi.ssid : null,
        line: `${r.wifi && r.wifi.ssid ? '“' + r.wifi.ssid + '” · ' : ''}${r.counts.bad} serious · ${r.counts.warn} to fix${d ? ` · ${d.alive || d.list.length} devices` : ''}`,
        items: r.checks.filter(c => c.status !== 'ok').map(c => ({ a: c.title, b: c.status === 'bad' ? 'serious' : c.status === 'warn' ? 'fix' : 'info', bad: c.status === 'bad' })) });
    }
    if (r.counts.bad) vib([200, 80, 200]);
  }
  const ipSort = (a, b) => String(a).split('.').reduce((x, y) => x * 256 + (+y || 0), 0) - String(b).split('.').reduce((x, y) => x * 256 + (+y || 0), 0);

  /* ---------- trackers inside the downloaded apps (after the phone check) ---------- */
  async function runTrackers(id) {
    const box = $('#gTrackers');
    if (!Trackers || !Trackers.available || !st.guardRes) { box.innerHTML = '<p class="empty">Needs the TwinGaze app.</p>'; return; }
    const apps = (st.guardRes.apps || []).filter(a => !a.system);
    if (!apps.length) { box.innerHTML = '<p class="empty">No downloaded apps to check.</p>'; return; }
    box.innerHTML = `<div class="trk-sum">Looking inside ${apps.length} downloaded apps for tracking and advertising code…<div class="trk-prog"><u id="gTrkBar"></u></div></div>`;
    let res;
    try {
      res = await Trackers.scan(apps.map(a => a.pkg), pr => { const b = $('#gTrkBar'); if (b && pr && pr.total) b.style.width = Math.round(100 * pr.done / pr.total) + '%'; });
    } catch (e) { if (st.guardRun === id) box.innerHTML = `<p class="empty">Tracker check failed: ${esc((e && e.message) || e)}</p>`; return; }
    if (st.guardRun !== id) return;
    const withIcons = apps.map(a => Object.assign({}, a, { icon: ((st.guardC && st.guardC.apps) || []).find(x => x.pkg === a.pkg)?.icon || null }));
    const r = Trackers.classify(res, withIcons);
    st.trkRes = r;
    renderTrackers(r, res);
    log('GUARD', `${esc(Trackers.summary(r))} · searched ${res.mb} MB of app code in ${(res.ms / 1000).toFixed(1)} s`);
    r.apps.filter(a => a.risk === 'high').slice(0, 5).forEach(a => log('FOUND', `<b>${esc(a.name)}</b>: ${esc(a.reasons[0] || '')}`));
    if (st.guardHist) {                                     // the phone check's history entry gets the tracker result too
      st.guardHist.trackers = { summary: Trackers.summary(r), high: r.counts.high, withTrackers: r.counts.withTrackers, scanned: r.counts.scanned };
      st.guardHist.line += ` · ${r.counts.withTrackers} apps with trackers`;
      DB.putScan(st.guardHist).then(renderRecent);
    }
  }
  function renderTrackers(r) {
    const c = r.counts;
    $('#gTrkN').textContent = c.withTrackers ? String(c.withTrackers) : '';
    const own = r.topOwners.length ? `<div class="trk-own">${r.topOwners.map(o => `<span>${esc(o.owner)} · ${o.apps} app${o.apps > 1 ? 's' : ''}</span>`).join('')}</div>` : '';
    const sum = `<div class="trk-sum"><b>${esc(Trackers.summary(r))}.</b> ${c.withTrackers ? 'These companies get data from the apps on this phone:' : 'None of the known tracking libraries were found.'}${own}</div>`;
    const rows = r.apps.filter(a => a.trackers.some(t => t.cat !== 'crash')).slice(0, 25).map(a => {
      const av = a.icon ? `<img src="${a.icon}" alt="">` : `<span class="ar-av">${esc((a.name || '?').trim().charAt(0).toUpperCase())}</span>`;
      const chips = a.trackers.filter(t => t.cat !== 'crash').map(t => `<i class="${t.cat}" title="${esc(Trackers.CAT[t.cat].why)}">${esc(t.name)}</i>`).join('');
      return `<div class="trk-app ${a.risk}"><div class="ar-h">${av}<div><b>${esc(a.name)}</b><small>${esc(a.reasons.slice(0, 2).join(' · '))}</small></div>
        <button class="chipbtn" type="button" data-appset="${esc(a.pkg)}">Permissions</button></div><div class="trk-chips">${chips}</div></div>`;
    }).join('');
    $('#gTrackers').innerHTML = sum + rows + (c.unreadable ? `<p class="hint">${c.unreadable} app${c.unreadable > 1 ? 's' : ''} could not be read.</p>` : '') +
      '<p class="hint">Found by searching each app\'s code for the published package names of known tracking and advertising SDKs. An app can still track you with code that is not on the list. Red: records your screen or collects location data. Yellow: links you across apps for advertising.</p>';
    $$('#gTrackers [data-appset]').forEach(b => { b.onclick = () => Guard.openAppSettings(b.dataset.appset).catch(e => toast(e.message)); });
  }
  async function openGuard(from) {
    st.backTo = from || st.tab || 'home';
    const id = st.guardRun = (st.guardRun || 0) + 1;
    show('guard');
    const orb = $('#gOrb');
    orb.className = 'g-orb scanning';
    $('#gIcon').innerHTML = '<use href="#i-phonecheck"/>';
    setRing(3); $('#gPct').textContent = '0%';
    $('#gTitle').textContent = 'Checking this phone';
    $('#gSub').textContent = 'Looking for spyware, stalkerware and risky settings.';
    $('#gSum').hidden = true; $('#gBody').hidden = true; $('#gBtns').hidden = true; $('#gAgain').hidden = false;
    $('#gDone').textContent = 'Done'; $('#gTrackers').innerHTML = ''; $('#gTrkN').textContent = '';
    if (!Guard || !Guard.available) {
      orb.className = 'g-orb review';
      $('#gIcon').innerHTML = '<use href="#i-lock"/>'; $('#gPct').textContent = 'App';
      setRing(100);
      $('#gTitle').textContent = 'Needs the TwinGaze app';
      $('#gSub').textContent = 'A browser can\'t see which apps are installed. Install TwinGaze.apk on the phone and the check runs there.';
      $('#gBtns').hidden = false; $('#gAgain').hidden = true;
      return;
    }
    let shown = 0;
    const tick = setInterval(() => {                       // smooth the ring between progress events
      if (st.guardRun !== id) { clearInterval(tick); return; }
      const target = st.guardP || 0;
      shown += Math.max(0.4, (target - shown) * 0.25);
      shown = Math.min(shown, Math.max(target, 8), 96);
      setRing(shown); $('#gPct').textContent = Math.round(shown) + '%';
    }, 80);
    st.guardP = 4;
    log('GUARD', 'Phone check started: reading the installed apps and the security settings');
    let res;
    st.guardLive = null;
    try {
      [res, st.guardLive] = await Promise.all([
        Guard.scan(p => {
          if (st.guardRun !== id || !p) return;
          st.guardP = p.total ? 6 + (p.done / p.total) * 88 : st.guardP;
          if (p.label) $('#gSub').textContent = p.label;
        }),
        Guard.sensorsInUse ? Guard.sensorsInUse().catch(e => ({ error: (e && e.message) || String(e) })) : Promise.resolve(null),
        sleep(2600),                                        // long enough to read, never a fake result
      ]);
    } catch (e) {
      clearInterval(tick);
      if (st.guardRun !== id) return;
      orb.className = 'g-orb review';
      $('#gTitle').textContent = 'The check could not run';
      $('#gSub').textContent = (e && e.message) || String(e);
      $('#gBtns').hidden = false;
      return;
    }
    clearInterval(tick);
    if (st.guardRun !== id) return;
    setRing(100); $('#gPct').textContent = '100%';
    await sleep(300);
    st.guardRes = res;
    renderGuard();
    runTrackers(id);
  }
  const appRow = (a, full) => {
    const risk = a.trusted ? 'low' : a.risk;
    const av = a.icon ? `<img src="${a.icon}" alt="">` : `<span class="ar-av">${esc((a.name || a.pkg || '?').trim().charAt(0).toUpperCase())}</span>`;
    return `<div class="app-row ${risk === 'low' ? '' : risk}">
      <div class="ar-h">${av}<div><b>${esc(a.name || a.pkg)}</b><small>${esc(a.store || '')} · ${esc(a.pkg)}</small></div>
        <span class="risk ${risk === 'low' ? '' : risk}">${a.trusted ? 'trusted' : risk === 'high' ? 'danger' : risk === 'medium' ? 'review' : 'ok'}</span></div>
      ${a.reasons && a.reasons.length ? `<ul class="ar-why">${a.reasons.slice(0, full ? 6 : 2).map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${full ? `<div class="ar-act">
        ${a.flags && a.flags.system && !a.flags.updatedSystem ? '' : `<button class="chipbtn danger" type="button" data-uninstall="${esc(a.pkg)}"><svg><use href="#i-trash"/></svg>Uninstall</button>`}
        <button class="chipbtn" type="button" data-appset="${esc(a.pkg)}"><svg><use href="#i-gear"/></svg>Permissions</button>
        <button class="chipbtn" type="button" data-trust="${esc(a.pkg)}">${a.trusted ? 'Stop trusting' : 'It\'s mine'}</button></div>` : ''}
    </div>`;
  };
  function renderGuard() {
    const r = Guard.classify(st.guardRes, { trusted: trustedApps() });
    st.guardC = r;
    const issues = r.apps.filter(a => !a.trusted && a.risk !== 'low');
    const high = issues.filter(a => a.risk === 'high');
    const devIssues = r.device.filter(d => d.status !== 'ok');
    const live = st.guardLive && !st.guardLive.error && (st.guardLive.cameraInUse || st.guardLive.micInUse);
    const v = live && r.verdict === 'safe' ? 'review' : r.verdict;
    $('#gOrb').className = 'g-orb ' + v;
    $('#gIcon').innerHTML = `<use href="#${v === 'safe' ? 'i-shield' : 'i-alert'}"/>`;
    $('#gPct').textContent = v === 'safe' ? 'Safe' : v === 'danger' ? 'Risk' : 'Review';
    $('#gTitle').textContent = v === 'danger' ? (high.length ? `${high.length} app${high.length > 1 ? 's' : ''} look${high.length > 1 ? '' : 's'} like spyware` : 'This phone needs attention')
      : v === 'review' ? 'A few things to review' : 'No spyware found';
    const db = Guard.dbInfo && Guard.dbInfo();
    $('#gSub').textContent = `${r.counts.apps} apps and ${r.device.length} settings checked${db ? ` against ${db.stalkerware + db.watchware} known spyware and monitoring apps` : ''}.`;
    $('#gSum').hidden = false;
    $('#gSum').innerHTML = `<div class="${r.counts.high ? 'hot' : 'ok'}"><b>${r.counts.high}</b><small>spyware signs</small></div>
      <div class="${r.counts.medium + devIssues.length ? 'warn' : 'ok'}"><b>${r.counts.medium + devIssues.length}</b><small>to review</small></div>
      <div><b>${r.counts.apps}</b><small>apps checked</small></div>`;
    $('#gBody').hidden = false; $('#gBtns').hidden = false;
    $('#gIssuesN').textContent = issues.length ? String(issues.length) : '';
    $('#gIssues').innerHTML = issues.length ? issues.map(a => appRow(a, true)).join('') : '<p class="empty">No app needs attention.</p>';
    renderLive(r);
    $('#gDevice').innerHTML = r.device.map(d => `<div class="dev-row"><span class="st ${d.status}"><svg><use href="#${d.status === 'ok' ? 'i-check' : 'i-alert'}"/></svg></span>
      <div><b>${esc(d.title)}</b><small>${esc(d.detail || '')}</small></div>${d.action ? `<button class="chipbtn" type="button" data-page="${esc(d.action)}">Fix</button>` : ''}</div>`).join('');
    $('#gAppsN').textContent = `(${r.apps.length})`;
    $('#gApps').innerHTML = r.apps.map(a => appRow(a, false)).join('');
    $('#gHint').textContent = 'A clean result means none of these signs were found, not that the phone is guaranteed clean: this is not a full antivirus, and spying through a shared password or a linked WhatsApp Web session leaves no app behind.' +
      (db ? ` Known-app list: “${db.name}” by ${db.author}, ${db.licence}.` : '');
    $$('#gBody [data-uninstall]').forEach(b => { b.onclick = () => uninstallApp(b.dataset.uninstall); });
    $$('#gBody [data-appset]').forEach(b => { b.onclick = () => Guard.openAppSettings(b.dataset.appset).catch(e => toast(e.message)); });
    $$('#gBody [data-page]').forEach(b => { b.onclick = () => Guard.openSettings(b.dataset.page).catch(e => toast(e.message)); });
    $$('#gBody [data-trust]').forEach(b => {
      b.onclick = () => {
        const a = r.apps.find(x => x.pkg === b.dataset.trust);
        setTrusted(a.pkg, !a.trusted);
        log('GUARD', `${esc(a.name)} ${a.trusted ? 'no longer trusted' : 'marked as trusted'} (by you)`);
        renderGuard();
      };
    });
    if (!st.guardSaved || st.guardSaved !== st.guardRes) {
      st.guardSaved = st.guardRes;
      log('GUARD', `${esc(Guard.summary ? Guard.summary(r) : r.counts.apps + ' apps checked')}`);
      high.forEach(a => log('FOUND', `<b>${esc(a.name)}</b> (${esc(a.pkg)}): ${esc(a.reasons[0] || '')}`));
      st.guardHist = null;
      addHistory({ kind: 'guard', risk: v === 'danger' ? 'high' : v === 'review' ? 'medium' : 'low', head: $('#gTitle').textContent,
        line: `${r.counts.apps} apps · ${issues.length} flagged`, items: issues.slice(0, 10).map(a => ({ a: a.name, b: a.reasons[0] || a.risk, bad: a.risk === 'high' }))
          .concat(devIssues.map(d => ({ a: d.title, b: d.detail || d.status, bad: d.status === 'bad' }))) }).then(h => { st.guardHist = h; });
    }
    if (high.length) vib([200, 80, 200]);
  }
  /* is anything using the camera or microphone right now, and which apps are allowed to */
  function renderLive(r) {
    const L = st.guardLive, raw = (st.guardRes && st.guardRes.apps) || [];
    const iconOf = pkg => (r.apps.find(a => a.pkg === pkg) || {}).icon;
    const who = perm => raw.filter(a => (a.granted || []).includes(perm) && (!a.system || a.updatedSystem))
      .map(a => ({ pkg: a.pkg, name: a.name || a.pkg, icon: iconOf(a.pkg) })).sort((a, b) => a.name.localeCompare(b.name));
    const row = (status, title, detail) => `<div class="dev-row"><span class="st ${status}"><svg><use href="#${status === 'ok' ? 'i-check' : 'i-alert'}"/></svg></span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></div>`;
    const perm = a => `<div class="app-row"><div class="ar-h">${a.icon ? `<img src="${a.icon}" alt="">` : `<span class="ar-av">${esc(a.name.trim().charAt(0).toUpperCase())}</span>`}
      <div><b>${esc(a.name)}</b><small>${esc(a.pkg)}</small></div><button class="chipbtn" type="button" data-appset="${esc(a.pkg)}">Permissions</button></div></div>`;
    const list = (apps, what) => `<details class="g-all"><summary>${apps.length} app${apps.length === 1 ? '' : 's'} can use the ${what}</summary><div class="list">${apps.map(perm).join('') || '<p class="empty">None</p>'}</div></details>`;
    let html = '';
    if (!L || L.error || !L.cameras) html += row('warn', 'Camera and microphone', L && L.error ? 'Could not check: ' + L.error : 'This check needs the newest TwinGaze app.');
    else {
      html += L.cameraInUse ? row('bad', 'An app is using the camera right now', 'Look for the green dot at the top of the screen, then swipe down: Android shows which app it is. If you did not open it, stop it.')
        : row('ok', 'Camera not in use', `None of the ${L.cameras.length} cameras is being used by another app right now.`);
      html += L.micInUse ? row('bad', 'Something is recording audio right now', 'Look for the orange dot at the top of the screen, then swipe down to see which app is listening.')
        : row('ok', 'Microphone not in use', 'No app is recording audio right now.');
    }
    const cam = who('CAMERA'), mic = who('RECORD_AUDIO');
    html += list(cam, 'camera') + list(mic, 'microphone');
    $('#gLive').innerHTML = html;
    if (L && !L.error && (L.cameraInUse || L.micInUse)) log('FOUND', `Phone check: ${L.cameraInUse ? 'a camera' : ''}${L.cameraInUse && L.micInUse ? ' and ' : ''}${L.micInUse ? 'the microphone' : ''} in use by another app right now`);
    else if (L && !L.error) log('GUARD', `Camera and microphone not in use by any other app · ${cam.length} apps may use the camera, ${mic.length} the microphone`);
  }
  async function uninstallApp(pkg) {
    try {
      const res = await Guard.uninstall(pkg);
      if (res && res.started) { st.guardPending = pkg; if (res.updatesOnly) toast('Android can only remove the updates of this built-in app.'); return; }
      if (res && res.reason === 'deviceAdmin') { toast('This app is a device admin. Switch that off first, then uninstall it.'); await Guard.openSettings('deviceAdmin'); return; }
      if (res && res.reason === 'system') { toast('A built-in app can\'t be removed: disable it in its settings.'); await Guard.openAppSettings(pkg); return; }
    } catch (e) { toast((e && e.message) || 'Could not open the uninstall screen.'); }
  }
  async function afterUninstall(pkg) {
    let gone = false;
    try { gone = !(await Guard.isInstalled(pkg)).installed; } catch (e) { /* unknown: rescan anyway */ }
    if (gone) { toast('App removed.'); log('GUARD', `Removed ${esc(pkg)}`); }
    openGuard(st.backTo);
  }

  /* ---------- Android Back: close what's open, step back, and only leave from Home ---------- */
  function onBack() {
    if (!$('#sirenOv').hidden) { stopSiren(); return; }
    if (!$('#fcall').hidden) { fake.end(); return; }
    if (!$('#fcSheet').hidden) { $('#fcSheet').hidden = true; return; }
    if (!$('#vidSheet').hidden) { $('#vidSheet').hidden = true; return; }
    if (!$('#sos').hidden) { $('#sos').hidden = true; return; }
    if (!$('#onboard').hidden) { obClose(); return; }
    if (!$('#alert').hidden) { $('#alertKeep').onclick(); return; }
    if (st.running) {                                  // an edge swipe while turning round must not end the scan
      const now = performance.now();
      if (now - (st.backT || 0) < 2500) { st.backT = 0; finish(); }
      else { st.backT = now; toast('Press back again to stop the scan'); vib(30); }
      return;
    }
    if (MG.timer) { stopMagnet(); return; }
    const cur = SCREENS.find(id => !$('#' + id).hidden);
    if (cur === 'scan') { stopScan(); show(st.backTo || 'home'); return; }
    if (cur === 'guard') { $('#gBack').onclick(); return; }
    if (cur === 'net') { $('#nBack').onclick(); return; }
    if (cur === 'radio') { $('#rBack').onclick(); return; }
    if (cur === 'mirror') { closeMirror(); return; }
    if (cur === 'how') { go('back'); return; }
    if (cur === 'report') { show(st.backTo === 'history' ? 'history' : st.backTo === 'tools' ? 'tools' : 'home'); return; }
    if (cur !== 'home') { show('home'); return; }
    Native.exitApp();
  }

  /* ---------- wiring ---------- */
  function wire() {
    Native.onBack(onBack);
    $('#start').onclick = () => runTool('full', 'home');
    $('#navScan').onclick = () => { if (!st.running && !MG.timer) runTool('full', st.tab); };
    $$('[data-go]').forEach(b => { b.onclick = () => go(b.dataset.go); });
    $('#sosBtn').onclick = openSos;
    $('#sosClose').onclick = () => { $('#sos').hidden = true; };
    $('#sos').addEventListener('click', e => { if (e.target === $('#sos')) $('#sos').hidden = true; });
    $('#sosShare').onclick = () => sosShare(true);
    $('#sosSiren').onclick = startSiren;
    $('#sosCall').onclick = openFakeCall;
    $('#sirenStop').onclick = stopSiren;
    $('#fcClose').onclick = () => { $('#fcSheet').hidden = true; };
    $('#fcSheet').addEventListener('click', e => { if (e.target === $('#fcSheet')) $('#fcSheet').hidden = true; });
    $$('[data-fc]').forEach(b => { b.onclick = () => $$('[data-fc]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
    $('#fcGo').onclick = () => { const b = $$('[data-fc]').find(x => x.getAttribute('aria-pressed') === 'true'); startFakeCall(b ? +b.dataset.fc : 10); };
    $('#fcAccept').onclick = () => fake.answer();
    // protection outside the app
    $('#cProtect').onclick = toggleProtect;
    $('#protTest').onclick = () => Protect.testSos().then(() => toast('Test: the SOS countdown is in your notifications. Nothing will be sent.')).catch(e => toast(e.message));
    $('#protTile').onclick = () => Protect.addTile().then(r => toast(r.added ? 'SOS tile added: swipe down from the top to use it'
      : r.manual ? 'Swipe down twice, tap the pencil, and drag “SOS” into your tiles' : 'The tile was not added')).catch(e => toast(e.message));
    $('#protBattery').onclick = () => Protect.allowBackground().then(r => { if (r && r.opened === 'autostart') toast('Turn on Autostart for TwinGaze, then come back.'); }).catch(() => {});
    $('#protNotif').onclick = () => Protect.allow('notifications').then(protectRender).catch(e => toast(e.message));
    $('#protSms').onclick = () => Protect.allow('sms').then(protectRender).catch(e => toast(e.message));
    if (Protect.available) {
      Protect.on('fakeAnswer', d => { fake.name = (d && d.name) || callerName(); fake.state = 'ringing'; fake.answer(); });
      Protect.on('open', d => {
        const w = d && d.screen;
        if (w === 'guard') openGuard('home'); else if (w === 'net') openNet('home'); else if (w === 'sos') openSos();
      });
    }
    protectRender(); protectSync();
    $('#fcDecline').onclick = $('#fcEnd').onclick = () => fake.end();
    $('#nBack').onclick = $('#nDone').onclick = () => { st.netRun = (st.netRun || 0) + 1; show(st.backTo || 'home'); };
    $('#nAgain').onclick = () => openNet(st.backTo);
    $('#agSkip').onclick = () => Agent.skip();
    $('#rBack').onclick = $('#rDone').onclick = () => { st.radioRun = (st.radioRun || 0) + 1; show(st.backTo || 'home'); };
    $('#rAgain').onclick = () => openRadio(st.radioKind);
    $('#mirBack').onclick = closeMirror;
    $('#obNext').onclick = () => { if (st.ob < OB.length - 1) { st.ob++; obRender(); } else obClose(); };
    $('#obSkip').onclick = obClose;
    $('#openHow').onclick = () => go('how');
    $('#scanPhone').onclick = $('#heroPhone').onclick = () => openGuard('home');
    $('#gBack').onclick = $('#gDone').onclick = () => { st.guardRun = (st.guardRun || 0) + 1; show(st.backTo || 'home'); };
    $('#gAgain').onclick = () => openGuard(st.backTo);
    $('#cDiscreet').onclick = () => setDiscreet(!st.discreet);
    $$('[data-sens]').forEach(b => {
      b.onclick = () => { st.sens = b.dataset.sens; save(); syncSoundButtons(); toast(sens().desc); };
    });
    const tc = Safety.contacts()[0] || {};
    $('#tcName').value = tc.name || ''; $('#tcPhone').value = tc.phone || '';
    const saveTc = () => { Safety.saveContacts([{ name: $('#tcName').value, phone: $('#tcPhone').value }]); protectSync(); protectRender(); };
    $('#tcName').oninput = saveTc; $('#tcPhone').oninput = saveTc;
    $('#tRec').onclick = () => (Rec.mr ? stopRec() : startRec());
    $('#tWhat').onclick = () => {
      const now = performance.now();
      const labels = [...new Set(st.scene.items.filter(it => now - it.t < 2500).map(it => it.label))];
      const people = st.scene.items.filter(it => now - it.t < 2500 && it.label === 'Person').length;
      const cams = st.recog.items.filter(it => it.status === 'camera' && now - it.lastT < 2500).length;
      const all = (cams ? ['Camera'] : []).concat(labels);
      const line = Voice.describe(all);
      Voice.sayText(line, { force: true, key: 'describe' });
      toast(all.length ? `In view: ${all.join(', ')}${people > 1 ? ` (${people} people)` : ''}` : 'Nothing recognised yet');
      log('SEE', `What's here: ${all.length ? esc(all.join(', ')) : 'nothing recognised yet'}`);
    };
    $('#vPlay').onclick = () => {
      if (video.paused) video.play(); else { video.pause(); Beeper.set(0, false); }
      $('#vPlay').textContent = video.paused ? 'Play' : 'Pause';
    };
    $('#vSpeed').onclick = () => {
      const r = video.playbackRate === 1 ? 0.5 : video.playbackRate === 0.5 ? 0.25 : 1;
      video.playbackRate = r;
      $('#vSpeed').textContent = (r === 1 ? '1' : r === 0.5 ? '½' : '¼') + '×';
      log('SYS', `Playback speed ${r}×`);
    };
    $('#vSeek').oninput = () => {
      st.seeking = true;
      const d = isFinite(video.duration) ? video.duration : 0;
      if (d) $('#vTime').textContent = `${fmtClock($('#vSeek').value / 1000 * d)} / ${fmtClock(d)}`;
    };
    $('#vSeek').onchange = () => {
      const d = isFinite(video.duration) ? video.duration : 0;
      if (d) seekTo($('#vSeek').value / 1000 * d);
      st.seeking = false;
    };
    $('#mStop').onclick = stopMagnet;
    $('#mDone').onclick = stopMagnet;
    $('#mCal').onclick = () => {
      Mag.recalibrate(); MG.peak = 0; MG.hist = []; MG.state = '';
      log('MAG', 'Baseline reset. Learning the room again…');
    };
    $('#mSound').onclick = () => $('#tSound').onclick();
    $('#pickVideo').onclick = () => $('#file').click();
    $('#vidRef').onclick = () => playReference('hall');
    $('#heroSample').onclick = () => { st.backTo = 'home'; playReference('hall'); };
    if (/[?&]debug/.test(location.search)) $('#hFps').hidden = false;
    $('#vidPick').onclick = () => { $('#vidSheet').hidden = true; $('#file').click(); };
    $('#vidClose').onclick = () => { $('#vidSheet').hidden = true; };
    $('#vidSheet').addEventListener('click', e => { if (e.target === $('#vidSheet')) $('#vidSheet').hidden = true; });
    $('#file').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) startScan('file', f); };
    $('#stop').onclick = () => { if (st.running) finish(); else { stopScan(); show('home'); } };
    $('#tFinish').onclick = () => finish();
    $('#openLocker').onclick = async () => { st.backTo = 'history'; await renderReport(true); show('report'); };
    $('#tTorch').onclick = async () => {
      const ok = await Camera.setTorch(!Camera.torchOn);
      if (ok) log('SYS', `Flash ${Camera.torchOn ? 'on' : 'off'} (by you)`);
    };
    $('#tCapture').onclick = async () => {
      if (!st.running) return;
      const rec = await saveEvidence(null, 'manual');
      toast(rec ? 'Photo saved with its fingerprint.' : 'Could not save a photo.');
    };
    $('#tMag').onclick = () => {
      Mag.recalibrate();
      log('MAG', 'Magnetic baseline reset. Learning the room again…');
      toast('Hold the phone away from electronics for a second.');
    };
    $('#alertKeep').onclick = () => { $('#alert').hidden = true; if (st.running && st.source === 'file' && video.paused) video.play(); };
    $('#alertReport').onclick = () => finish();

    ov.addEventListener('click', e => {
      if (!st.running || !st.fw) return;
      const rect = ov.getBoundingClientRect(), m = viewMap();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      let best = null, bd = 44;
      for (const t of st.tracker.tracks) {
        if (!t.visible) continue;
        const d = Math.hypot(m.X(t.x) - x, m.Y(t.y) - y);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) return;
      if (best.status === 'ignored') { best.status = 'checking'; log('SEE', `#${best.id} watched again (by you)`); }
      else { best.status = 'ignored'; log('CLEAR', `#${best.id} ignored by you`); }
    });

    $$('[data-lang]').forEach(b => {
      b.onclick = () => {
        Voice.lang = b.dataset.lang; save(); syncSoundButtons();
        if (st.running && st.guide.key && TAGS[st.guide.key]) guideInstr(st.guide.key);
        voiceRender().then(() => Voice.sample());
      };
    });
    $$('[data-vm]').forEach(b => {
      b.onclick = () => {
        if (st.discreet) setDiscreet(false);
        const m = b.dataset.vm;
        Voice.on = m !== 'off';
        if (Voice.on) Voice.mode = m; else Voice.stop();
        save(); syncSoundButtons();
        if (Voice.on) Voice.sample();
      };
    });
    $('#voiceNext').onclick = nextVoice;
    $('#cSound').onclick = () => { if (st.discreet) setDiscreet(false); Beeper.on = !Beeper.on; if (Beeper.on) Beeper.chirp(); save(); syncSoundButtons(); };
    $('#tSound').onclick = () => {
      if (st.discreet) { setDiscreet(false); return; }
      const on = !(Voice.on || Beeper.on);
      Voice.on = on; Beeper.on = on;
      if (!on) Voice.stop();
      save(); syncSoundButtons();
    };

    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden) protectRender();          // back from a permission or battery screen
      if (!document.hidden && st.guardPending && !$('#guard').hidden) { const p = st.guardPending; st.guardPending = null; afterUninstall(p); }
      if (!st.running || st.source !== 'camera') return;
      if (document.hidden) { Camera.setTorch(false); Wake.off(); st.hiddenT = performance.now(); return; }
      if (st.hiddenT) {                        // Android gives no camera frames to an app you can't see
        const secs = Math.round((performance.now() - st.hiddenT) / 1000);
        st.hiddenT = 0;
        if (secs >= 2) { log('SYS', `Scan paused for ${secs} s while TwinGaze was in the background: Android stops the camera for apps you can't see.`); toast('Scan resumed. It pauses while TwinGaze is in the background.'); }
      }
      if (!Camera.track || Camera.track.readyState === 'ended') {
        try { await Camera.start(video, Camera.deviceId ? { deviceId: Camera.deviceId } : { facing: 'environment' }); }
        catch (e) { cameraFailed(e); return; }
        st.tracker.reset(); watchTrack();
      }
      if (st.lights === 'done' && MODES[st.smode].torch) Camera.setTorch(true);
      Wake.on();
    });
  }

  /* read-only snapshot for debugging over USB (Chrome DevTools): what the scan is steering to and why */
  window.TGDebug = () => {
    const f = st.tracker.tracks.find(t => t.id === st.focusId);
    const pt = t => ({ id: t.id, x: +t.x.toFixed(2), y: +t.y.toFixed(2), status: t.status, score: +(t.score || 0).toFixed(2), hits: t.hits, vis: t.visible });
    return { running: st.running, key: st.guide.key, since: Math.round(performance.now() - st.guide.since), focus: f ? pt(f) : null,
      cand: (st.recog.items || []).filter(it => it.status !== 'camera').map(it => ({ x: +it.x.toFixed(2), y: +it.y.toFixed(2), s: +it.score.toFixed(2), seen: it.hist.reduce((a, b) => a + b, 0), z: it.zHits || 0, skip: !!it.skipT, known: !!it.known })),
      tracks: st.tracker.tracks.filter(t => t.visible).length, nav: st.nav ? st.nav.id : null };
  };

  // start-up: each step on its own, so one failing part (a sensor, the voice, a plugin) can never
  // leave the app stuck on its launch screen; the error is logged and the rest carries on
  const step = (name, fn) => { try { fn(); } catch (e) { console.error('start-up step failed: ' + name, e); } };
  step('agent', () => Agent.init({
    log, vib, voice: Voice, radio: Radio, net: Net, heading: () => Heading,
    say: (text, opt) => Voice.sayText(text, opt),
  }));
  step('settings', load);
  step('voice', () => Voice.init());
  step('buttons', wire);
  step('home', renderHome);
  step('sound', syncSoundButtons);
  step('sensors', renderSensors);
  step('show', () => show('home'));
  step('fonts', () => (window.requestIdleCallback || (f => setTimeout(f, 2500)))(() => {
    try { document.fonts.load('500 14px "Noto Sans Devanagari"', 'हिंदी'); document.fonts.load('500 14px "Noto Sans Telugu"', 'తెలుగు'); } catch (e) { /* no FontFace API */ }
  }));
  step('log', () => { $('#log').innerHTML = '<li class="empty">Start a full room scan. The agent’s plan, every tool it runs and every decision show up here.</li>'; });
  boot();

  if (!Native.available && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
})();
