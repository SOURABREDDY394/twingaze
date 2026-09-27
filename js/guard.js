/* TwinGaze · guard.js: the phone check (spyware / stalkerware on this phone).
 *
 * Inside the Android app the TwinGuard plugin lists every installed app with what it is allowed to
 * do, plus a few security settings. The plugin only hands back raw data; this file compares it with
 * the known-stalkerware list (js/spyware-db.js) and scores it, and says why in plain words.
 * In a browser the scan isn't possible (available is false) but classify() still works.
 *
 * WHAT IT CAN FIND
 *  - Apps on the public stalkerware / monitoring-app list (Echap's stalkerware indicators, CC BY 4.0),
 *    matched by package name or by signing certificate, so a renamed copy of a listed app is caught too.
 *  - Apps that act like stalkerware: no app icon, installed from outside an app store, accessibility
 *    service switched on (reads the screen, taps for you), device admin (blocks uninstalling),
 *    notification access (reads messages), a name dressed up as a system app, and access to camera,
 *    microphone, location, SMS, call history or contacts.
 *  - Settings that make spying easier: no screen lock, an old security patch, USB debugging,
 *    developer options, signs of root.
 *
 * WHAT IT CANNOT FIND
 *  - It is not an antivirus: no malware signatures, no scanning of files or app code, no network monitoring.
 *  - Stalkerware that is not on the list and needs none of the access above.
 *  - Spyware built into the system software or installed with root (root itself is reported), and
 *    "zero-click" spyware of the Pegasus kind.
 *  - Spying with no app on the phone: someone who knows your Google / WhatsApp / iCloud password,
 *    linked WhatsApp Web sessions, shared location, cloud backups, call forwarding, SIM swaps.
 *  - Trackers hidden in your bag or car (the radio scan looks for those).
 *  So a clean result means none of these signs were found, not that the phone is guaranteed clean.
 *
 * Calls reject with an Error; .code is 'UNAVAILABLE' outside the app, otherwise the plugin's code
 * ('BUSY', 'NOT_INSTALLED', 'BAD_ARGS', 'SELF', 'NO_ACTIVITY', 'SCAN_FAILED'). */
(function (root) {
  'use strict';

  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const hasPlugin = isNative && (typeof cap.isPluginAvailable !== 'function' || cap.isPluginAvailable('TwinGuard'));
  const P = hasPlugin ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinGuard') : cap.Plugins && cap.Plugins.TwinGuard) : null;

  function fail(message, code) { const e = new Error(message); if (code) e.code = code; return e; }
  function need() { if (!P) throw fail('not in the app', 'UNAVAILABLE'); }
  function needPkg(pkg) { if (!pkg || typeof pkg !== 'string') throw fail('no app given', 'BAD_ARGS'); }

  /* ---------------------------------------------------------------------------------------
   * Where apps come from
   * --------------------------------------------------------------------------------------- */

  /* Installers that are app stores (the installer package Android records for each app). */
  const STORES = {
    'com.android.vending': 'Google Play',
    'com.google.android.feedback': 'Google Play',            // older Play installs report this
    'com.aurora.store': 'Aurora Store (Google Play)',
    'com.sec.android.app.samsungapps': 'Samsung Galaxy Store',
    'com.huawei.appmarket': 'Huawei AppGallery',
    'com.hihonor.appmarket': 'HONOR App Market',
    'com.xiaomi.market': 'Xiaomi GetApps',
    'com.xiaomi.mipicks': 'Xiaomi GetApps',
    'com.heytap.market': 'OPPO / realme App Market',
    'com.oppo.market': 'OPPO App Market',
    'com.vivo.appstore': 'vivo App Store',
    'com.bbk.appstore': 'vivo App Store',
    'com.amazon.venezia': 'Amazon Appstore',
    'com.tencent.android.qqdownloader': 'Tencent MyApp',
    'ru.vk.store': 'RuStore',
    'org.fdroid.fdroid': 'F-Droid',
    'org.fdroid.basic': 'F-Droid',
    'com.looker.droidify': 'F-Droid (Droid-ify)',
  };
  /* The system "install this APK?" screen: the app came from an APK file. */
  const APK_INSTALLERS = ['com.google.android.packageinstaller', 'com.android.packageinstaller',
    'com.samsung.android.packageinstaller', 'com.miui.packageinstaller'];

  /* Friendly name of the store an installer package belongs to, or null. */
  function storeName(installer) { return STORES[installer] || null; }

  function installedFrom(installer, initiator) {
    let s;
    if (!installer) s = 'Installed from outside an app store';
    else if (APK_INSTALLERS.includes(installer)) s = 'Installed from an APK file, not from an app store';
    else if (installer === 'com.android.shell') s = 'Installed from a computer over USB (adb), not from an app store';
    else s = `Installed by another app (${installer}), not from an app store`;
    if (initiator && initiator !== installer && !STORES[initiator] && !APK_INSTALLERS.includes(initiator)) s += ` (started from ${initiator})`;
    return s;
  }

  /* ---------------------------------------------------------------------------------------
   * Permissions (the plugin sends the short names of granted "dangerous" permissions)
   * --------------------------------------------------------------------------------------- */

  /* Scored: each one a sideloaded app holds adds a little (capped). */
  const SCORED = [
    { label: 'camera', perms: ['CAMERA'] },
    { label: 'microphone', perms: ['RECORD_AUDIO'] },
    { label: 'precise location', perms: ['ACCESS_FINE_LOCATION'] },
    { label: 'location in the background', perms: ['ACCESS_BACKGROUND_LOCATION'] },
    { label: 'SMS messages', perms: ['READ_SMS', 'RECEIVE_SMS', 'RECEIVE_MMS', 'RECEIVE_WAP_PUSH', 'SEND_SMS'] },
    { label: 'call history', perms: ['READ_CALL_LOG', 'PROCESS_OUTGOING_CALLS'] },
    { label: 'contacts', perms: ['READ_CONTACTS'] },
  ];
  /* Shown but not scored. */
  const INFO = [
    { label: 'photos and files', perms: ['READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_VISUAL_USER_SELECTED'] },
  ];
  /* Personal-data permissions: an app with no icon that holds any of these is "hiding". */
  const PERSONAL = new Set([].concat(...SCORED.map(p => p.perms), ...INFO.map(p => p.perms),
    'ACCESS_COARSE_LOCATION', 'READ_MEDIA_AUDIO', 'READ_PHONE_STATE', 'READ_PHONE_NUMBERS', 'CALL_PHONE',
    'ANSWER_PHONE_CALLS', 'GET_ACCOUNTS', 'READ_CALENDAR', 'BODY_SENSORS', 'BODY_SENSORS_BACKGROUND', 'ACTIVITY_RECOGNITION'));

  function listWords(a) {
    return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }

  /* ---------------------------------------------------------------------------------------
   * Names that pretend to be part of Android ("System Service", "Wi-Fi", "Sync Services" ...).
   * A label counts when it is 1-4 words, every word is "system-ish" and at least one is a core word.
   * "Samsung Health", "WiFi Analyzer", "Google" or "Phone Manager" don't match.
   * --------------------------------------------------------------------------------------- */
  const SYS_WORDS = new Set(['android', 'system', 'sys', 'google', 'play', 'device', 'phone', 'wifi', 'wlan', 'sync',
    'update', 'updates', 'updater', 'software', 'security', 'network', 'battery', 'service', 'services', 'framework',
    'core', 'health', 'settings', 'setting', 'manager', 'process', 'internet', 'sim', 'toolkit', 'config',
    'configuration', 'backup', 'storage', 'location', 'bluetooth', 'ui', 'os', 'support', 'helper', 'daemon', 'agent',
    'provider', 'host', 'component', 'components', 'kernel', 'firmware', 'monitor', 'data', 'app', 'apps', 'mobile']);
  const CORE_WORDS = new Set(['system', 'sys', 'service', 'services', 'sync', 'update', 'updates', 'updater', 'wifi', 'wlan',
    'framework', 'settings', 'setting', 'device', 'security', 'firmware', 'kernel', 'daemon']);
  /* Google's own release certificate (Play services, Play Store): real Google apps are not "imitations". */
  const GOOGLE_CERT = '38918a453d07199354f8b19af05ec6562ced5788';

  function imitatesSystem(label) {
    const words = String(label || '').toLowerCase().replace(/wi[\s_-]*fi/g, 'wifi').split(/[^a-z0-9]+/).filter(Boolean);
    return words.length >= 1 && words.length <= 4 && words.every(w => SYS_WORDS.has(w)) && words.some(w => CORE_WORDS.has(w));
  }

  /* ---------------------------------------------------------------------------------------
   * Known stalkerware list
   * --------------------------------------------------------------------------------------- */

  function getDb(opts) {
    if (opts && opts.db !== undefined) return opts.db;
    if (root.TGSpywareDB) return root.TGSpywareDB;
    if (typeof require === 'function') { try { return require('./spyware-db.js'); } catch (e) { /* not bundled */ } }
    return null;
  }

  const normCert = c => String(c || '').replace(/[:\s]/g, '').toLowerCase();
  const idxCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  function indexDb(db) {
    if (!db || !Array.isArray(db.apps)) return null;
    if (idxCache && idxCache.has(db)) return idxCache.get(db);
    const pk = new Map(), ck = new Map();
    // When an app is on both lists, "stalkerware" wins over "watchware".
    const keep = (m, k, v) => { const p = m.get(k); if (!p || (p.type === 'watchware' && v.type === 'stalkerware')) m.set(k, v); };
    for (const e of db.apps) {
      if (!e || !e.name) continue;
      const v = { name: String(e.name), type: e.type === 'watchware' ? 'watchware' : 'stalkerware' };
      for (const p of e.packages || []) keep(pk, String(p), v);
      for (const c of e.certs || []) keep(ck, normCert(c), v);
    }
    const idx = { pk, ck };
    if (idxCache) idxCache.set(db, idx);
    return idx;
  }

  /* { name, type: 'stalkerware'|'watchware', match: 'package'|'certificate' } or null.
   * Stalkerware beats watchware; with the same type a package match is reported. */
  function lookup(idx, pkg, certs) {
    if (!idx) return null;
    const byPkg = idx.pk.get(pkg);
    let byCert = null;
    for (const c of certs) {
      const h = idx.ck.get(c);
      if (h && (!byCert || (byCert.type === 'watchware' && h.type === 'stalkerware'))) byCert = h;
    }
    const c = [];
    if (byPkg) c.push({ name: byPkg.name, type: byPkg.type, match: 'package' });
    if (byCert) c.push({ name: byCert.name, type: byCert.type, match: 'certificate' });
    c.sort((a, b) => (a.type === 'stalkerware' ? 0 : 1) - (b.type === 'stalkerware' ? 0 : 1));
    return c[0] || null;
  }

  /* Attribution for the list, for the UI. */
  function dbInfo(db) {
    db = db === undefined ? getDb() : db;
    if (!db || !Array.isArray(db.apps)) return null;
    const src = db.source || {}, lic = db.licence || {};
    return {
      name: src.name || 'Stalkerware Indicators of Compromise',
      author: src.author || 'Echap',
      url: src.url || 'https://github.com/AssoEchap/stalkerware-indicators',
      commit: src.commit || null,
      licence: lic.name || 'CC BY 4.0',
      licenceUrl: lic.url || 'https://creativecommons.org/licenses/by/4.0/',
      fetched: db.fetched || null,
      stalkerware: db.apps.filter(a => a.type !== 'watchware').length,
      watchware: db.apps.filter(a => a.type === 'watchware').length,
    };
  }

  /* ---------------------------------------------------------------------------------------
   * Scoring one app
   *
   * Points add up; risk: 6+ high, 3+ medium, below that low. "Store" means a known app store
   * installed it (Play, Galaxy Store, AppGallery, F-Droid ...); "sideloaded" means it didn't.
   *   Known stalkerware (package or certificate)            +10 and always high
   *   Known monitoring app ("watchware", e.g. parental)     +4  (medium on its own)
   *   Accessibility service switched on                     +5 sideloaded, +2 store
   *   Active device admin                                   +5 sideloaded, +3 store
   *   Notification access                                   +3 sideloaded, +2 store
   *   No app icon while holding personal-data access        +4 sideloaded, 0 store (normal for plugins/add-ons)
   *   Name imitates a system app                            +3 sideloaded, +1 store
   *   Sideloaded                                            +1
   *   Camera / mic / precise loc / background loc /
   *     SMS / call history / contacts                       +1 each (max 3), sideloaded only
   *   Can draw over other apps                              +1, sideloaded only
   *   Turned off (disabled)                                 capped at medium unless known stalkerware
   *   Marked trusted by the user                            always low
   * Store apps' ordinary permissions don't score: a Play camera app or WhatsApp stays low. System
   * apps only score on a list match; they are listed when they hold accessibility / device admin /
   * notification access so the user can see who has it.
   * --------------------------------------------------------------------------------------- */
  const HIGH = 6, MEDIUM = 3;
  const riskOf = s => s >= HIGH ? 'high' : s >= MEDIUM ? 'medium' : 'low';
  const RISK_ORDER = { high: 0, medium: 1, low: 2 };

  const T = {
    accessibility: 'Can read your screen and tap for you (its accessibility service is on)',
    deviceAdmin: 'Can lock or wipe the phone and blocks uninstalling (device admin)',
    listener: 'Reads your notifications, including messages',
  };

  function classifyApp(a, idx, trusted, rooted) {
    const pkg = String((a && a.pkg) || '');
    if (!pkg) return null;
    const name = String(a.name || pkg);
    const system = !!a.system, updatedSystem = !!a.updatedSystem;
    const installer = a.installer || null;
    const store = storeName(installer);
    const sideloaded = !system && !store;
    const granted = new Set((Array.isArray(a.granted) ? a.granted : []).map(String));
    const certs = (Array.isArray(a.certSha1) ? a.certSha1 : []).map(normCert).filter(Boolean);
    const known = lookup(idx, pkg, certs);
    const acc = !!a.accessibility, admin = !!a.deviceAdmin, listener = !!a.notificationListener;
    const noIcon = a.launcher === false;
    const disabled = a.enabled === false;
    const personal = [...granted].some(p => PERSONAL.has(p));
    const imitates = !system && !certs.includes(GOOGLE_CERT) && imitatesSystem(name);
    const scored = SCORED.filter(g => g.perms.some(p => granted.has(p))).map(g => g.label);
    const access = scored.concat(INFO.filter(g => g.perms.some(p => granted.has(p))).map(g => g.label));

    if (system && !known && !acc && !admin && !listener) return null;     // ordinary system app: not listed

    let score = 0, knownSpy = false;
    const reasons = [];
    const add = (pts, text) => { score += pts; if (text) reasons.push(text); };

    if (known && known.type === 'stalkerware') {
      if (system && known.match === 'package' && !rooted) {
        // A system app can only match by name clash, unless the phone is rooted.
        add(4, `Its package name matches known stalkerware (${known.name}), but it came with the phone's system software. Check it`);
      } else {
        knownSpy = true;
        add(10, `Known stalkerware: ${known.name}`);
        reasons.push(known.match === 'certificate'
          ? 'Signed with the same certificate as a known stalkerware app'
          : 'Its package name is on the public stalkerware list');
      }
    } else if (known) {
      add(4, `Known monitoring app: ${known.name}. It reports this phone's activity or location to another person. Fine only if you set it up yourself`);
    }

    if (system) {
      if (acc) reasons.push(T.accessibility);
      if (admin) reasons.push(T.deviceAdmin);
      if (listener) reasons.push(T.listener);
      reasons.push(updatedSystem && store ? `Came with the phone (system app, updated from ${store})` : 'Came with the phone (system app)');
    } else {
      if (acc) add(sideloaded ? 5 : 2, T.accessibility);
      if (admin) add(sideloaded ? 5 : 3, T.deviceAdmin);
      if (listener) add(sideloaded ? 3 : 2, T.listener);
      if (noIcon && (personal || acc || admin || listener)) {
        add(sideloaded ? 4 : 0, sideloaded ? 'Has no app icon: it hides itself' : 'Has no app icon of its own (normal for plugins and add-ons)');
      } else if (noIcon && sideloaded) {
        reasons.push('Has no app icon');
      }
      if (imitates) add(sideloaded ? 3 : 1, `Its name "${name}" makes it look like part of Android, but it isn't a system app`);
      if (sideloaded) add(1, installedFrom(installer, a.initiator));
      if (access.length) add(sideloaded ? Math.min(3, scored.length) : 0, `Has access to your ${listWords(access)}`);
      if (a.requestsOverlay && sideloaded) add(1, 'Can draw on top of other apps');
    }

    let risk = knownSpy ? 'high' : riskOf(score);
    if (disabled) {
      reasons.push("Turned off (disabled): it can't run until it is turned back on");
      if (!knownSpy && risk === 'high') risk = 'medium';
    }
    const isTrusted = trusted.has(pkg);
    if (isTrusted) { risk = 'low'; reasons.unshift('You marked this app as trusted'); }

    let icon = a.icon ? String(a.icon) : null;
    if (icon && !icon.startsWith('data:')) icon = 'data:image/png;base64,' + icon;

    return {
      pkg, name, icon, installer,
      store: store || (system ? 'Pre-installed' : 'Unknown source'),
      risk, score, reasons: reasons.filter((r, i) => reasons.indexOf(r) === i),
      known,
      flags: {
        system, updatedSystem, sideloaded, noIcon, accessibility: acc, deviceAdmin: admin,
        notificationListener: listener, overlay: !!a.requestsOverlay, imitatesSystem: imitates, disabled,
      },
      access,
      trusted: isTrusted,
      versionName: a.versionName || null,
      firstInstall: Number(a.firstInstall) || null,
      lastUpdate: Number(a.lastUpdate) || null,
    };
  }

  /* ---------------------------------------------------------------------------------------
   * Device checks
   * --------------------------------------------------------------------------------------- */

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function toDate(v) {
    if (v == null) return new Date();
    if (typeof v === 'object' && typeof v.getTime === 'function') return new Date(v.getTime());
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
    return new Date(v);
  }

  /* { months, label, status } for a patch level like "2026-03-05", or null. */
  function patchAge(patch, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(patch || '').trim());
    if (!m) return null;
    const py = +m[1], pm = +m[2], pd = +m[3];
    if (pm < 1 || pm > 12) return null;
    const ty = now.getUTCFullYear(), tm = now.getUTCMonth() + 1, td = now.getUTCDate();
    const p = Date.UTC(py, pm - 1, pd);
    const cutoff = back => Date.UTC(ty, tm - 1 - back, td);
    const months = Math.max(0, (ty - py) * 12 + (tm - pm) - (td < pd ? 1 : 0));
    const status = p < cutoff(12) ? 'bad' : p < cutoff(6) ? 'warn' : 'ok';
    return { months, label: `${MONTHS[pm - 1]} ${py}`, status };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

  function deviceChecks(dev, apps, now) {
    const out = [];
    const push = (id, title, status, detail, action) => out.push({ id, title, status, detail, action: status === 'ok' ? null : action || null });

    if (dev.screenLock === false) push('lock', 'Screen lock', 'bad', 'No screen lock: anyone who picks up your phone can open it and install a spy app. Set a PIN, pattern or password.', 'lock');
    else if (dev.screenLock === true) push('lock', 'Screen lock', 'ok', 'Protected with a PIN, pattern or password.');

    const age = patchAge(dev.securityPatch, now);
    if (age) {
      const since = age.months === 1 ? '1 month' : `${age.months} months`;
      if (age.status === 'bad') push('patch', 'Security update', 'bad', `The security patch is over a year old (${age.label}). Spyware can use holes that newer patches fix: install any system update. If none is offered, this phone no longer gets fixes.`, 'update');
      else if (age.status === 'warn') push('patch', 'Security update', 'warn', `The security patch is ${since} old (${age.label}). Check for a system update.`, 'update');
      else push('patch', 'Security update', 'ok', `Security patch from ${age.label}.`);
    }

    if (Array.isArray(dev.rootHints)) {
      if (dev.rootHints.length) push('root', 'Root', 'bad', `Signs this phone is rooted: ${dev.rootHints.join('; ')}. Root lets a spy app hide completely and read everything. If you didn't root it yourself, someone else may have: back up your photos and reset the phone.`, null);
      else push('root', 'Root', 'ok', 'No signs of root.');
    }

    if (dev.adb === true || dev.adbWifi === true) {
      push('adb', 'USB debugging', 'warn', `${dev.adbWifi === true && dev.adb !== true ? 'Wireless debugging' : 'USB debugging'} is on: anyone holding the phone can install apps silently over USB. Turn it off in Developer options.`, 'developer');
    } else if (dev.adb === false) push('adb', 'USB debugging', 'ok', 'USB debugging is off.');

    if (dev.devOptions === true) push('developer', 'Developer options', 'warn', "Developer options are on. Turn them off if you don't use them.", 'developer');
    else if (dev.devOptions === false) push('developer', 'Developer options', 'ok', 'Developer options are off.');

    // Special access held by apps someone installed (system apps and apps you trust are left out).
    const special = (id, title, flag, what, action) => {
      const who = apps.filter(a => a.flags[flag] && !a.flags.system && !a.trusted).map(a => a.name);
      const trustedToo = apps.some(a => a.flags[flag] && !a.flags.system && a.trusted);
      if (who.length) push(id, title, 'warn', `${plural(who.length, 'app')} ${what}: ${who.join(', ')}. Turn off any you don't recognise.`, action);
      else push(id, title, 'ok', `No downloaded apps ${what}${trustedToo ? ' (apart from apps you trust)' : ''}.`);
    };
    special('accessibility', 'Screen reading (accessibility)', 'accessibility', 'can read your screen and tap for you', 'accessibility');
    special('deviceAdmin', 'Device admin apps', 'deviceAdmin', 'can lock or wipe the phone and block uninstalling', 'deviceAdmin');
    special('notificationAccess', 'Notification access', 'notificationListener', 'can read your notifications', 'notificationAccess');

    if (dev.encrypted === false) push('encryption', 'Encryption', 'warn', "The phone's storage is not encrypted: anyone with the phone in hand can copy your data.", 'security');
    else if (dev.encrypted === true) push('encryption', 'Encryption', 'ok', 'Storage is encrypted.');

    const order = { bad: 0, warn: 1, ok: 2 };
    return out.map((d, i) => [d, i]).sort((x, y) => (order[x[0].status] - order[y[0].status]) || (x[1] - y[1])).map(x => x[0]);
  }

  /* Device checks that change the verdict. An old patch and developer options are shown but
   * don't make the verdict "review" on their own: they are common and not signs of spying. */
  const VERDICT_CHECKS = new Set(['lock', 'root', 'adb', 'accessibility', 'deviceAdmin', 'notificationAccess']);

  function toSet(t) {
    if (!t) return new Set();
    if (typeof t.has === 'function') return t;
    if (Array.isArray(t)) return new Set(t.map(String));
    if (typeof t === 'object') return new Set(Object.keys(t).filter(k => t[k]));
    return new Set();
  }

  /* result: what scan() resolved with. opts: { trusted: Set|Array of package names, now?: Date|ms|'YYYY-MM-DD', db? }
   * Returns {
   *   apps: [{ pkg, name, icon (data: URL or null), installer, store, risk, score, reasons, known, flags, access,
   *            trusted, versionName, firstInstall, lastUpdate }]  (all non-system apps + flagged system apps, high first),
   *   device: [{ id, title, status: 'ok'|'warn'|'bad', detail, action }]  (bad first; action = openSettings page or null),
   *   counts: { apps, userApps, high, medium },
   *   verdict: 'danger'|'review'|'safe',
   *   phone: { manufacturer, model, android, sdk } | null,
   *   database: dbInfo() | null }
   * high/medium counts and the verdict ignore trusted apps. */
  function classify(result, opts) {
    opts = opts || {};
    const trusted = toSet(opts.trusted);
    const now = toDate(opts.now);
    const db = getDb(opts);
    const idx = indexDb(db);
    const dev = (result && result.device) || {};
    const raw = Array.isArray(result && result.apps) ? result.apps : [];
    const rooted = Array.isArray(dev.rootHints) && dev.rootHints.length > 0;

    const apps = [];
    for (const a of raw) {
      const c = a && classifyApp(a, idx, trusted, rooted);
      if (c) apps.push(c);
    }
    apps.sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || (a.trusted - b.trusted) ||
      (b.score - a.score) || a.name.localeCompare(b.name));

    const device = deviceChecks(dev, apps, now);
    const live = apps.filter(a => !a.trusted);
    const high = live.filter(a => a.risk === 'high').length;
    const medium = live.filter(a => a.risk === 'medium').length;
    let verdict = 'safe';
    if (high) verdict = 'danger';
    else if (medium || device.some(d => d.status !== 'ok' && VERDICT_CHECKS.has(d.id))) verdict = 'review';

    return {
      apps,
      device,
      counts: { apps: raw.length, userApps: raw.filter(a => a && !a.system).length, high, medium },
      verdict,
      phone: result && result.device ? { manufacturer: dev.manufacturer || null, model: dev.model || null, android: dev.android || null, sdk: dev.sdk || null } : null,
      database: dbInfo(db),
    };
  }

  /* One line for the top of the results, e.g. "Checked 212 apps (48 downloaded) · 1 looks like spyware". */
  function summary(c) {
    if (!c || !c.counts) return '';
    const n = c.counts;
    let s = `Checked ${plural(n.apps, 'app')} (${n.userApps} downloaded)`;
    if (n.high) s += ` · ${n.high} look${n.high === 1 ? 's' : ''} like spyware`;
    if (n.medium) s += ` · ${n.medium} worth a closer look`;
    if (!n.high && !n.medium) s += ' · no spyware signs found';
    const fix = (c.device || []).filter(d => d.status !== 'ok').length;
    if (fix) s += ` · ${plural(fix, 'setting')} to check`;
    return s;
  }

  /* ---------------------------------------------------------------------------------------
   * The plugin calls (app only)
   * --------------------------------------------------------------------------------------- */

  const PAGES = ['accessibility', 'deviceAdmin', 'developer', 'notificationAccess', 'security', 'lock', 'update', 'wifi', 'privateDns'];

  const G = {
    available: !!P,

    /* onProgress gets { done, total, label } (apps checked, label = current app's name).
     * Resolves { device: { manufacturer, model, android, sdk, securityPatch, screenLock, devOptions, adb,
     *   adbWifi, rootHints: [..], encrypted, encryption }, apps: [{ pkg, name, system, updatedSystem,
     *   installer, initiator, firstInstall, lastUpdate, versionName, launcher, enabled, granted: [..],
     *   requestsOverlay, accessibility, deviceAdmin, notificationListener, certSha1: [..], icon }] }.
     * Takes a few seconds. */
    async scan(onProgress) {
      need();
      let handle = null;
      try {
        if (typeof onProgress === 'function') handle = await P.addListener('guardProgress', onProgress);
        return await P.scan();
      } finally {
        if (handle) { try { await handle.remove(); } catch (e) { /* already gone */ } }
      }
    },

    /* Opens Android's own "uninstall this app?" dialog; the user confirms there.
     * Resolves { started: true } (plus updatesOnly: true for an updated system app, where Android only
     * removes the updates), or { started: false, reason: 'deviceAdmin' } (turn off its device admin first:
     * openSettings('deviceAdmin')), or { started: false, reason: 'system' } (can't be removed: openAppSettings to disable).
     * Android doesn't report the outcome: call isInstalled() when the app comes back to the front. */
    async uninstall(pkg) { need(); needPkg(pkg); return await P.uninstall({ pkg }); },

    /* Resolves { installed: boolean }. */
    async isInstalled(pkg) { need(); needPkg(pkg); return await P.isInstalled({ pkg }); },

    /* Is an app using the camera or microphone right now? Resolves { cameras: [{ id, facing, inUse, known }],
     * cameraInUse, micInUse, micRecordings }. Android hides which app; the green / orange privacy dot shows it. */
    async sensorsInUse() { need(); return await P.sensorsInUse(); },

    /* The app's page in Android settings (permissions, force stop, disable, uninstall). */
    async openAppSettings(pkg) { need(); needPkg(pkg); return await P.openAppSettings({ pkg }); },

    /* page: one of PAGES (a device check's action). Resolves { opened: <Android settings action used> }. */
    async openSettings(page) {
      need();
      if (!PAGES.includes(page)) throw fail('unknown settings page: ' + page, 'BAD_ARGS');
      return await P.openSettings({ page });
    },

    classify, summary, dbInfo, storeName, imitatesSystem,
    PAGES,
  };

  root.TGGuard = G;
  if (typeof module === 'object' && module && module.exports) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
