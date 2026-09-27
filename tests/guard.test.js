/* Run: node tests/guard.test.js
 * Checks the phone-check classifier (js/guard.js) on sample scan results, the bundled stalkerware
 * list (js/spyware-db.js), and the plugin wrappers against a fake Capacitor plugin.
 * Most tests use a small fixture list so they don't change when the real list is updated. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const G = require('../js/guard.js');                  // Node: module.exports
const REAL_DB = require('../js/spyware-db.js');
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'guard.js'), 'utf8');
function load(win) { vm.runInNewContext(code, { window: win, console }); return win.TGGuard; }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const find = (list, pkg) => list.find(a => a.pkg === pkg);
const has = (a, re) => a.reasons.some(r => re.test(r));

const SPY_CERT = 'aa11bb22cc33dd44ee55ff6600112233445566ff';
const DB = {
  source: { name: 'fixture', url: 'https://example.invalid' }, licence: { name: 'CC BY 4.0' }, fetched: '2026-09-01T00:00:00Z',
  apps: [
    { name: 'FakeSpy', type: 'stalkerware', packages: ['com.fakespy.agent'], certs: [SPY_CERT] },
    { name: 'KidWatch', type: 'watchware', packages: ['com.kidwatch.child'], certs: [] },
    { name: 'ClashSpy', type: 'stalkerware', packages: ['com.android.clash'], certs: [] },
  ],
};
const TODAY = '2026-09-26';

/* A plain phone: patched, locked, no root. */
const DEVICE = {
  manufacturer: 'samsung', model: 'SM-A146B', android: '14', sdk: 34, securityPatch: '2026-08-01',
  screenLock: true, devOptions: false, adb: false, adbWifi: false, rootHints: [], encrypted: true, encryption: 'activePerUser',
};

const app = o => Object.assign({
  system: false, updatedSystem: false, installer: 'com.android.vending', initiator: null, firstInstall: 1750000000000,
  lastUpdate: 1750000000000, versionName: '1.0', launcher: true, enabled: true, granted: [], requestsOverlay: false,
  accessibility: false, deviceAdmin: false, notificationListener: false, certSha1: ['0123456789abcdef0123456789abcdef01234567'], icon: null,
}, o);

const APPS = [
  app({ pkg: 'com.fakespy.agent', name: 'Sync Services', installer: null, launcher: false, granted: ['READ_SMS', 'ACCESS_FINE_LOCATION'] }),
  // renamed copy of FakeSpy: different package, same certificate (given the way a hex dump might print it)
  app({ pkg: 'com.renamed.thing', name: 'Notes', installer: 'com.android.vending', certSha1: ['AA:11:BB:22:CC:33:DD:44:EE:55:FF:66:00:11:22:33:44:55:66:FF'] }),
  // not on any list, but acts like stalkerware
  app({ pkg: 'com.sys.helper', name: 'System Service', installer: null, launcher: false, accessibility: true, requestsOverlay: true,
    granted: ['READ_SMS', 'RECEIVE_SMS', 'READ_CALL_LOG', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'RECORD_AUDIO'] }),
  // ordinary Play apps
  app({ pkg: 'net.sourceforge.opencamera', name: 'Open Camera', granted: ['CAMERA', 'RECORD_AUDIO', 'ACCESS_FINE_LOCATION'], icon: 'iVBORw0KGgo=' }),
  app({ pkg: 'com.whatsapp', name: 'WhatsApp', granted: ['CAMERA', 'RECORD_AUDIO', 'READ_CONTACTS', 'ACCESS_FINE_LOCATION', 'READ_MEDIA_IMAGES'] }),
  app({ pkg: 'com.x8bit.bitwarden', name: 'Bitwarden', accessibility: true }),
  app({ pkg: 'com.samsung.android.wear.plugin', name: 'Galaxy Watch Plugin', installer: 'com.sec.android.app.samsungapps', launcher: false,
    notificationListener: true, granted: ['READ_SMS', 'READ_CALL_LOG', 'READ_CONTACTS'] }),
  app({ pkg: 'com.sec.android.app.shealth', name: 'Samsung Health', installer: 'com.sec.android.app.samsungapps', granted: ['ACTIVITY_RECOGNITION'] }),
  // watchware
  app({ pkg: 'com.kidwatch.child', name: 'KidWatch', granted: ['ACCESS_FINE_LOCATION'] }),
  // sideloaded, reads notifications
  app({ pkg: 'com.apk.reader', name: 'Reader', installer: 'com.google.android.packageinstaller', initiator: 'com.android.chrome', notificationListener: true }),
  // sideloaded game, nothing special
  app({ pkg: 'com.apk.game', name: 'Snake', installer: null }),
  // system apps: one ordinary (not listed), one with notification access (listed, low), one name clash with the list
  app({ pkg: 'com.android.settings', name: 'Settings', system: true, installer: null }),
  app({ pkg: 'com.google.android.as', name: 'Android System Intelligence', system: true, updatedSystem: true, notificationListener: true }),
  app({ pkg: 'com.android.clash', name: 'Clash', system: true, installer: null }),
];
const RESULT = { device: DEVICE, apps: APPS };
const run = (opts, result) => G.classify(result || RESULT, Object.assign({ db: DB, now: TODAY }, opts));

/* ---------- known stalkerware ---------- */

test('known package match is high with the list name', () => {
  const a = find(run().apps, 'com.fakespy.agent');
  assert.strictEqual(a.risk, 'high');
  assert.deepStrictEqual(a.known, { name: 'FakeSpy', type: 'stalkerware', match: 'package' });
  assert.strictEqual(a.reasons[0], 'Known stalkerware: FakeSpy');
  assert.ok(has(a, /package name is on the public stalkerware list/));
});

test('certificate match catches a renamed copy, even from Play and with an icon', () => {
  const a = find(run().apps, 'com.renamed.thing');
  assert.strictEqual(a.risk, 'high');
  assert.strictEqual(a.known.match, 'certificate');
  assert.ok(has(a, /Known stalkerware: FakeSpy/));
  assert.ok(has(a, /same certificate/));
  assert.strictEqual(a.store, 'Google Play');
});

test('watchware match is medium with an honest reason', () => {
  const a = find(run().apps, 'com.kidwatch.child');
  assert.strictEqual(a.risk, 'medium');
  assert.strictEqual(a.known.type, 'watchware');
  assert.ok(has(a, /Known monitoring app: KidWatch.*Fine only if you set it up yourself/));
});

/* ---------- behaviour ---------- */

test('hidden + accessibility + sideloaded + system-like name is high, with every reason', () => {
  const a = find(run().apps, 'com.sys.helper');
  assert.strictEqual(a.risk, 'high');
  assert.strictEqual(a.known, null);
  assert.strictEqual(a.store, 'Unknown source');
  assert.ok(has(a, /Can read your screen and tap for you/));
  assert.ok(has(a, /^Has no app icon: it hides itself$/));
  assert.ok(has(a, /makes it look like part of Android/));
  assert.ok(has(a, /^Installed from outside an app store$/));
  assert.ok(has(a, /Has access to your microphone, precise location, location in the background, SMS messages and call history/), a.reasons.join(' | '));
  assert.ok(has(a, /draw on top/));
  assert.deepStrictEqual([a.flags.sideloaded, a.flags.noIcon, a.flags.accessibility, a.flags.imitatesSystem], [true, true, true, true]);
});

test('Play camera app and WhatsApp are low (permissions from a store are listed, not scored)', () => {
  const list = run().apps;
  const cam = find(list, 'net.sourceforge.opencamera');
  assert.strictEqual(cam.risk, 'low');
  assert.strictEqual(cam.score, 0);
  assert.strictEqual(cam.store, 'Google Play');
  assert.deepStrictEqual(cam.reasons, ['Has access to your camera, microphone and precise location']);
  assert.strictEqual(cam.icon, 'data:image/png;base64,iVBORw0KGgo=');
  const wa = find(list, 'com.whatsapp');
  assert.strictEqual(wa.risk, 'low');
  assert.ok(has(wa, /photos and files/));
});

test('store apps with special access stay low: password manager, watch plugin; "Samsung Health" is not a fake system name', () => {
  const list = run().apps;
  const bw = find(list, 'com.x8bit.bitwarden');
  assert.strictEqual(bw.risk, 'low');
  assert.ok(has(bw, /Can read your screen/));
  const watch = find(list, 'com.samsung.android.wear.plugin');
  assert.strictEqual(watch.risk, 'low');
  assert.ok(has(watch, /normal for plugins/));
  assert.strictEqual(watch.store, 'Samsung Galaxy Store');
  const sh = find(list, 'com.sec.android.app.shealth');
  assert.strictEqual(sh.flags.imitatesSystem, false);
  assert.strictEqual(sh.risk, 'low');
});

test('sideloaded app with notification access is medium and says where it came from', () => {
  const a = find(run().apps, 'com.apk.reader');
  assert.strictEqual(a.risk, 'medium');
  assert.ok(has(a, /Reads your notifications, including messages/));
  assert.ok(has(a, /^Installed from an APK file, not from an app store \(started from com.android.chrome\)$/), a.reasons.join(' | '));
  const game = find(run().apps, 'com.apk.game');
  assert.strictEqual(game.risk, 'low');
});

test('system apps: ordinary ones are not listed; special access is listed as low; a name clash is medium unless rooted', () => {
  const list = run().apps;
  assert.strictEqual(find(list, 'com.android.settings'), undefined);
  const asi = find(list, 'com.google.android.as');
  assert.strictEqual(asi.risk, 'low');
  assert.ok(has(asi, /system app, updated from Google Play/));
  assert.strictEqual(asi.store, 'Google Play');
  const clash = find(list, 'com.android.clash');
  assert.strictEqual(clash.risk, 'medium');
  assert.ok(has(clash, /came with the phone's system software/));
  const rooted = run({}, { device: Object.assign({}, DEVICE, { rootHints: ['su binary at /system/xbin/su'] }), apps: APPS });
  assert.strictEqual(find(rooted.apps, 'com.android.clash').risk, 'high');
});

test('a disabled look-alike is capped at medium; a disabled known stalkerware stays high', () => {
  const r = run({}, { device: DEVICE, apps: [
    app({ pkg: 'com.sys.helper', name: 'System Service', installer: null, launcher: false, accessibility: true, enabled: false, granted: ['READ_SMS'] }),
    app({ pkg: 'com.fakespy.agent', name: 'X', installer: null, enabled: false }),
  ] });
  assert.strictEqual(find(r.apps, 'com.sys.helper').risk, 'medium');
  assert.ok(has(find(r.apps, 'com.sys.helper'), /Turned off/));
  assert.strictEqual(find(r.apps, 'com.fakespy.agent').risk, 'high');
});

test('real Google apps are not "imitations"; odd names are', () => {
  assert.strictEqual(G.imitatesSystem('Wi-Fi'), true);
  assert.strictEqual(G.imitatesSystem('Update Service'), true);
  assert.strictEqual(G.imitatesSystem('Device Health'), true);
  assert.strictEqual(G.imitatesSystem('Google Services'), true);
  assert.strictEqual(G.imitatesSystem('WiFi Analyzer'), false);
  assert.strictEqual(G.imitatesSystem('Google'), false);
  assert.strictEqual(G.imitatesSystem('Samsung Health'), false);
  const r = run({}, { device: DEVICE, apps: [app({ pkg: 'com.google.android.gms', name: 'Google Play services', installer: null, certSha1: ['38918a453d07199354f8b19af05ec6562ced5788'] })] });
  assert.strictEqual(r.apps[0].flags.imitatesSystem, false);
});

/* ---------- trusted ---------- */

test('trusted apps are low with the reason first, and no longer count toward the verdict', () => {
  const trusted = new Set(['com.fakespy.agent', 'com.renamed.thing', 'com.sys.helper', 'com.x8bit.bitwarden']);
  const r = run({ trusted });
  const a = find(r.apps, 'com.sys.helper');
  assert.strictEqual(a.risk, 'low');
  assert.strictEqual(a.trusted, true);
  assert.strictEqual(a.reasons[0], 'You marked this app as trusted');
  assert.ok(has(a, /Can read your screen/));                 // the facts are still shown
  assert.strictEqual(find(r.apps, 'com.fakespy.agent').known.name, 'FakeSpy');
  assert.strictEqual(r.counts.high, 0);
  assert.notStrictEqual(r.verdict, 'danger');
  const acc = r.device.find(d => d.id === 'accessibility');
  assert.strictEqual(acc.status, 'ok');
  assert.ok(/apart from apps you trust/.test(acc.detail));
  // arrays work too
  assert.strictEqual(find(run({ trusted: ['com.sys.helper'] }).apps, 'com.sys.helper').risk, 'low');
});

/* ---------- sorting, counts, verdict ---------- */

test('apps are sorted high > medium > low, trusted last within a level, then by score', () => {
  const r = run({ trusted: ['com.apk.game'] });
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < r.apps.length; i++) {
    const a = r.apps[i - 1], b = r.apps[i];
    assert.ok(order[a.risk] < order[b.risk] || (a.risk === b.risk && (a.trusted < b.trusted || (a.trusted === b.trusted && a.score >= b.score))),
      `${a.pkg} (${a.risk} ${a.score}) before ${b.pkg} (${b.risk} ${b.score})`);
  }
  assert.strictEqual(r.apps[r.apps.length - 1].pkg, 'com.apk.game');
  assert.deepStrictEqual(r.apps.slice(0, 3).map(a => a.pkg).sort(), ['com.fakespy.agent', 'com.renamed.thing', 'com.sys.helper']);
});

test('counts and verdict', () => {
  const r = run();
  assert.deepStrictEqual(r.counts, { apps: 14, userApps: 11, high: 3, medium: 3 });
  assert.strictEqual(r.verdict, 'danger');
  assert.deepStrictEqual(r.phone, { manufacturer: 'samsung', model: 'SM-A146B', android: '14', sdk: 34 });
  assert.strictEqual(r.database.name, 'fixture');
  const clean = run({}, { device: DEVICE, apps: [APPS[3], APPS[4]] });
  assert.strictEqual(clean.verdict, 'safe');
  assert.ok(/^Checked 2 apps \(2 downloaded\) · no spyware signs found$/.test(G.summary(clean)), G.summary(clean));
  const review = run({}, { device: DEVICE, apps: [APPS[3], APPS[5]] });   // Play password manager with accessibility
  assert.strictEqual(review.verdict, 'review');
  assert.strictEqual(G.summary(r), 'Checked 14 apps (11 downloaded) · 3 look like spyware · 3 worth a closer look · 2 settings to check');
});

/* ---------- device checks ---------- */

const dev = (o, now) => G.classify({ device: Object.assign({}, DEVICE, o), apps: [] }, { db: DB, now: now || TODAY }).device;
const check = (list, id) => list.find(d => d.id === id);

test('security patch age against a fixed today (2026-09-26)', () => {
  assert.strictEqual(check(dev({ securityPatch: '2026-05-05' }), 'patch').status, 'ok');
  const warn = check(dev({ securityPatch: '2026-03-05' }), 'patch');
  assert.strictEqual(warn.status, 'warn');
  assert.ok(/6 months old \(March 2026\)/.test(warn.detail), warn.detail);
  assert.strictEqual(warn.action, 'update');
  assert.strictEqual(check(dev({ securityPatch: '2026-03-26' }), 'patch').status, 'ok');     // exactly 6 months
  assert.strictEqual(check(dev({ securityPatch: '2025-09-26' }), 'patch').status, 'warn');   // exactly 12 months
  const bad = check(dev({ securityPatch: '2025-08-01' }), 'patch');
  assert.strictEqual(bad.status, 'bad');
  assert.ok(/over a year old \(August 2025\)/.test(bad.detail));
  assert.strictEqual(check(dev({ securityPatch: '' }), 'patch'), undefined);
  // an old patch alone doesn't change the verdict
  assert.strictEqual(G.classify({ device: Object.assign({}, DEVICE, { securityPatch: '2024-01-01' }), apps: [] }, { db: DB, now: TODAY }).verdict, 'safe');
  // Date objects and timestamps work as "now"
  assert.strictEqual(check(dev({ securityPatch: '2026-03-05' }, new Date(Date.UTC(2026, 8, 26))), 'patch').status, 'warn');
});

test('screen lock, USB debugging, developer options, root, encryption', () => {
  const d = dev({ screenLock: false, adb: true, devOptions: true, rootHints: ['su binary at /system/xbin/su', 'root manager app installed: Magisk (com.topjohnwu.magisk)'], encrypted: false });
  const lock = check(d, 'lock');
  assert.deepStrictEqual([lock.status, lock.action], ['bad', 'lock']);
  const adb = check(d, 'adb');
  assert.deepStrictEqual([adb.status, adb.action], ['warn', 'developer']);
  assert.ok(/Anyone holding the phone can install apps silently over USB/i.test(adb.detail));
  assert.deepStrictEqual([check(d, 'developer').status, check(d, 'developer').action], ['warn', 'developer']);
  const root = check(d, 'root');
  assert.strictEqual(root.status, 'bad');
  assert.ok(/Magisk/.test(root.detail));
  assert.strictEqual(check(d, 'encryption').status, 'warn');
  assert.deepStrictEqual(d.map(x => x.status), d.map(x => x.status).slice().sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a] - { bad: 0, warn: 1, ok: 2 }[b])));
  const ok = dev({});
  for (const id of ['lock', 'patch', 'root', 'adb', 'developer', 'encryption']) {
    assert.strictEqual(check(ok, id).status, 'ok', id);
    assert.strictEqual(check(ok, id).action, null, id);
  }
  assert.strictEqual(check(dev({ adb: false, adbWifi: true }), 'adb').status, 'warn');
  assert.strictEqual(check(dev({ screenLock: null }), 'lock'), undefined);   // unknown: not shown
});

test('special access checks name the downloaded apps and link to the right settings page', () => {
  const d = run().device;
  const acc = check(d, 'accessibility');
  assert.deepStrictEqual([acc.status, acc.action], ['warn', 'accessibility']);
  assert.ok(/2 apps can read your screen and tap for you: System Service, Bitwarden/.test(acc.detail), acc.detail);
  const notif = check(d, 'notificationAccess');
  assert.strictEqual(notif.action, 'notificationAccess');
  assert.ok(!/Android System Intelligence/.test(notif.detail));      // system apps left out
  assert.strictEqual(check(d, 'deviceAdmin').status, 'ok');
  const admin = run({}, { device: DEVICE, apps: [app({ pkg: 'com.adm', name: 'Adm', installer: null, deviceAdmin: true })] });
  assert.deepStrictEqual([check(admin.device, 'deviceAdmin').status, check(admin.device, 'deviceAdmin').action], ['warn', 'deviceAdmin']);
  assert.strictEqual(admin.apps[0].risk, 'high');                  // sideloaded + device admin
  assert.ok(has(admin.apps[0], /Can lock or wipe the phone and blocks uninstalling/));
});

/* ---------- the bundled list ---------- */

test('bundled stalkerware list: attribution, shape, and a real entry matches', () => {
  assert.strictEqual(REAL_DB.licence.name, 'CC BY 4.0');
  assert.ok(/github\.com\/AssoEchap\/stalkerware-indicators/.test(REAL_DB.source.url));
  assert.ok(!isNaN(Date.parse(REAL_DB.fetched)));
  const stalk = REAL_DB.apps.filter(a => a.type === 'stalkerware');
  assert.ok(stalk.length >= 100, 'stalkerware apps: ' + stalk.length);
  for (const a of REAL_DB.apps) {
    assert.ok(a.name && (a.type === 'stalkerware' || a.type === 'watchware'), JSON.stringify(a).slice(0, 80));
    assert.ok(a.packages.length || a.certs.length, a.name);
    for (const c of a.certs) assert.ok(/^[0-9a-f]{40}$/.test(c), a.name + ' ' + c);
  }
  const pick = stalk.find(a => a.packages.length);
  const r = G.classify({ device: DEVICE, apps: [app({ pkg: pick.packages[0], name: 'x', installer: null })] }, { now: TODAY });
  assert.strictEqual(r.apps[0].risk, 'high');
  assert.ok(r.apps[0].known && r.apps[0].known.type === 'stalkerware');
  assert.strictEqual(r.database.licence, 'CC BY 4.0');
  assert.strictEqual(G.dbInfo().stalkerware, stalk.length);
  // no list at all: still classifies, just without "known" matches
  const none = G.classify(RESULT, { db: null, now: TODAY });
  assert.strictEqual(find(none.apps, 'com.fakespy.agent').known, null);
  assert.strictEqual(none.database, null);
});

test('store names', () => {
  assert.strictEqual(G.storeName('com.android.vending'), 'Google Play');
  assert.strictEqual(G.storeName('com.vivo.appstore'), 'vivo App Store');
  assert.strictEqual(G.storeName('org.fdroid.fdroid'), 'F-Droid');
  assert.strictEqual(G.storeName('com.android.shell'), null);
  const adb = run({}, { device: DEVICE, apps: [app({ pkg: 'com.adb.app', name: 'A', installer: 'com.android.shell' })] }).apps[0];
  assert.ok(has(adb, /over USB \(adb\)/));
});

/* ---------- wrappers ---------- */

test('outside the app: not available and calls reject with code UNAVAILABLE', async () => {
  const Gb = load({});
  assert.strictEqual(Gb.available, false);
  await assert.rejects(Gb.scan(), e => /not in the app/.test(e.message) && e.code === 'UNAVAILABLE');
  await assert.rejects(Gb.uninstall('com.x.y'), /not in the app/);
  await assert.rejects(Gb.openSettings('accessibility'), /not in the app/);
  // classify works in the browser too, using window.TGSpywareDB
  const Gw = load({ TGSpywareDB: DB });
  assert.strictEqual(find(Gw.classify(RESULT, { now: TODAY }).apps, 'com.fakespy.agent').risk, 'high');
});

test('inside the app: scan adds and removes the progress listener; actions pass their arguments', async () => {
  const log = [];
  let listener = null;
  const fake = {
    async addListener(ev, cb) { log.push('add:' + ev); listener = cb; return { remove: async () => { log.push('remove'); listener = null; } }; },
    async scan() { log.push('scan'); listener({ done: 5, total: 10, label: 'Snake' }); return { device: DEVICE, apps: [] }; },
    async uninstall(o) { log.push('uninstall:' + o.pkg); return { started: true }; },
    async isInstalled(o) { return { installed: o.pkg === 'com.here' }; },
    async openAppSettings(o) { log.push('app:' + o.pkg); return { opened: 'x' }; },
    async openSettings(o) { log.push('page:' + o.page); return { opened: 'y' }; },
  };
  const Gn = load({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: n => n === 'TwinGuard', registerPlugin: () => fake } });
  assert.strictEqual(Gn.available, true);
  const seen = [];
  const res = await Gn.scan(p => seen.push(`${p.done}/${p.total} ${p.label}`));
  assert.strictEqual(res.device.model, 'SM-A146B');
  assert.deepStrictEqual(seen, ['5/10 Snake']);
  assert.deepStrictEqual((await Gn.uninstall('com.sys.helper')), { started: true });
  assert.strictEqual((await Gn.isInstalled('com.here')).installed, true);
  await Gn.openAppSettings('com.whatsapp');
  await Gn.openSettings('deviceAdmin');
  await assert.rejects(Gn.openSettings('nope'), e => e.code === 'BAD_ARGS');
  await assert.rejects(Gn.uninstall(''), e => e.code === 'BAD_ARGS');
  assert.deepStrictEqual(log, ['add:guardProgress', 'scan', 'remove', 'uninstall:com.sys.helper', 'app:com.whatsapp', 'page:deviceAdmin']);
  // a failing scan still removes the listener
  fake.scan = async () => { throw Object.assign(new Error('boom'), { code: 'SCAN_FAILED' }); };
  log.length = 0;
  await assert.rejects(Gn.scan(() => {}), e => e.code === 'SCAN_FAILED');
  assert.deepStrictEqual(log, ['add:guardProgress', 'remove']);
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; }
    catch (e) { failed++; console.error('FAIL ' + t.name + '\n  ' + e.message); }
  }
  console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exit(1);
})();
