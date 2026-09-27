/* Run: node tests/privacy.test.js
 * The network check (js/net.js), the app-tracker classifier (js/trackers.js) and the safety kit
 * (js/safety.js), on hand-made inputs shaped like what the Android plugins return. */
'use strict';
const assert = require('assert');
const N = require('../js/net.js');
const T = require('../js/trackers.js');
const S = require('../js/safety.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const check = (r, id) => r.checks.find(c => c.id === id);

/* ---------- network ---------- */
const wifi = (o) => Object.assign({ ssid: 'PG-Home', bssid: 'aa:bb:cc:00:00:01', validated: true, captivePortal: false, dns: ['192.168.1.1'], privateDns: false, rssi: -55, frequency: 5180 }, o);
const scan = (list) => ({ networks: list.map(([ssid, bssid, caps]) => ({ ssid, bssid, capabilities: caps, level: -60 })) });

test('security from Android\'s capability strings', () => {
  assert.strictEqual(N.secFromCaps('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]'), 'wpa2');
  assert.strictEqual(N.secFromCaps('[RSN-SAE-CCMP][ESS]'), 'wpa3');
  assert.strictEqual(N.secFromCaps('[ESS]'), 'open');
  assert.strictEqual(N.secFromCaps('[WEP][ESS]'), 'wep');
  assert.strictEqual(N.secFromCaps('[RSN-OWE-CCMP][ESS]'), 'owe');
});

test('an open Wi-Fi is a serious problem', () => {
  const r = N.assess({ wifi: wifi({ securityType: 0 }), privateDnsMode: 'off', vpn: false });
  assert.strictEqual(check(r, 'sec').status, 'bad');
  assert.strictEqual(r.verdict, 'danger');
});

test('a protected Wi-Fi without Private DNS: the owner can log your sites', () => {
  const r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'off', vpn: false });
  assert.strictEqual(check(r, 'sec').status, 'ok');
  assert.strictEqual(check(r, 'see').status, 'warn');
  assert.strictEqual(r.verdict, 'review');
  assert.strictEqual(check(r, 'see').action.page, 'privateDns');
});

test('Private DNS with a host, or a VPN, hides the site names', () => {
  let r = N.assess({ wifi: wifi({ securityType: 4, privateDns: true, privateDnsServer: 'dns.google' }), privateDnsMode: 'hostname', vpn: false });
  assert.strictEqual(check(r, 'see').status, 'ok');
  assert.strictEqual(r.verdict, 'safe');
  r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'off', vpn: true });
  assert.strictEqual(check(r, 'see').status, 'ok');
});

test('an open copy of the Wi-Fi you are on is an evil twin', () => {
  const r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'hostname' },
    scan([['PG-Home', 'aa:bb:cc:00:00:01', '[WPA2-PSK-CCMP][ESS]'], ['PG-Home', '11:22:33:44:55:66', '[ESS]']]));
  assert.strictEqual(check(r, 'twin').status, 'bad');
});

test('on the open copy while a protected one exists: you may be on the fake', () => {
  const r = N.assess({ wifi: wifi({ bssid: '11:22:33:44:55:66' }), privateDnsMode: 'off' },
    scan([['PG-Home', 'aa:bb:cc:00:00:01', '[WPA2-PSK-CCMP][ESS]'], ['PG-Home', '11:22:33:44:55:66', '[ESS]']]));
  assert.strictEqual(check(r, 'sec').status, 'bad');                 // security read from the scan
  assert(/fake copy/.test(check(r, 'twin').title));
});

test('several access points with the same protection are normal', () => {
  const r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'hostname', }, scan([['PG-Home', 'aa:bb:cc:00:00:01', '[WPA2-PSK-CCMP]'], ['PG-Home', 'aa:bb:cc:00:00:02', '[WPA2-PSK-CCMP]']]));
  assert.strictEqual(check(r, 'twin').status, 'ok');
});

test('a proxy and a sign-in page are flagged', () => {
  const r = N.assess({ wifi: wifi({ securityType: 2, proxy: '10.0.0.5:8080', captivePortal: true }), privateDnsMode: 'off' });
  assert.strictEqual(check(r, 'proxy').status, 'bad');
  assert.strictEqual(check(r, 'portal').status, 'warn');
});

test('a camera on this Wi-Fi is reported; none means ok', () => {
  const lanList = [{ ip: '192.168.1.20', kind: 'camera', reasons: ['Answered a camera discovery request (ONVIF)'], name: 'IPC-1234' }];
  let r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'hostname' }, null, { alive: [{ ip: '192.168.1.1' }, { ip: '192.168.1.20' }], hosts: [] }, lanList);
  assert.strictEqual(check(r, 'lan').status, 'bad');
  assert.strictEqual(r.devices.alive, 2);
  r = N.assess({ wifi: wifi({ securityType: 2 }), privateDnsMode: 'hostname' }, null, { alive: [{ ip: '192.168.1.1' }], hosts: [] }, []);
  assert.strictEqual(check(r, 'lan').status, 'ok');
});

test('mobile data: no Wi-Fi checks, verdict not "offline"', () => {
  const r = N.assess({ wifi: null, active: { cellular: true }, privateDnsMode: 'off', vpn: false });
  assert.notStrictEqual(r.verdict, 'offline');
  assert(check(r, 'conn'));
});

/* ---------- trackers ---------- */
test('every tracker has an id, a category and Java-style signatures', () => {
  const ids = new Set();
  for (const t of T.TRACKERS) {
    assert(!ids.has(t.id), 'duplicate ' + t.id); ids.add(t.id);
    assert(T.CAT[t.cat], 'category ' + t.cat);
    for (const s of t.sigs) assert(/^L[a-z0-9_]+\/[A-Za-z0-9_/]+$/.test(s), 'signature ' + s);
  }
  assert(T.signatures().length === T.TRACKERS.length);
});

test('screen recording or location SDKs make an app high risk; crash reporting alone does not', () => {
  const apps = [
    { pkg: 'com.shop', name: 'Shop', granted: ['ACCESS_FINE_LOCATION', 'CAMERA'] },
    { pkg: 'com.notes', name: 'Notes', granted: [] },
    { pkg: 'com.game', name: 'Game', granted: [] },
  ];
  const r = T.classify({ apps: { 'com.shop': ['smartlook', 'appsflyer', 'firebase'], 'com.notes': ['crashlytics'], 'com.game': ['admob', 'applovin', 'unityads', 'adid'], 'com.broken': null } }, apps);
  const shop = r.apps.find(a => a.pkg === 'com.shop'), notes = r.apps.find(a => a.pkg === 'com.notes'), game = r.apps.find(a => a.pkg === 'com.game');
  assert.strictEqual(shop.risk, 'high');
  assert(shop.reasons.some(x => /record your screen/.test(x)));
  assert(shop.perms.includes('precise location'));
  assert.strictEqual(notes.risk, 'low');
  assert.strictEqual(game.risk, 'medium');
  assert.strictEqual(r.counts.unreadable, 1);
  assert.strictEqual(r.counts.withTrackers, 2);                   // crash reporting alone doesn't count
  assert.strictEqual(r.counts.replay, 1);
  assert(/2 of 3/.test(T.summary(r)));
});

/* ---------- safety ---------- */
function memStore() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; }

test('contacts: up to three, numbers cleaned, the old single contact carried over', () => {
  const st = memStore();
  st.setItem('twingaze-tc', JSON.stringify({ name: 'Amma', phone: '+91 98480-12345' }));
  assert.deepStrictEqual(S.contacts(st), [{ name: 'Amma', phone: '+919848012345' }]);
  const saved = S.saveContacts([{ name: 'A', phone: '1' }, { name: 'B', phone: '2' }, { name: 'C', phone: '3' }, { name: 'D', phone: '4' }, { name: 'E', phone: '' }], st);
  assert.strictEqual(saved.length, 3);
  assert.strictEqual(S.contacts(st).length, 3);
});

test('the SOS message has the map link and what was found', () => {
  const msg = S.sosMessage({ lat: 17.385044, lon: 78.486671, acc: 12 }, ['Hidden camera found in PG room (1:08 am)'], new Date(2026, 8, 27, 1, 10), 'PG room');
  assert(/maps\.google\.com\/\?q=17\.385044,78\.486671/.test(msg));
  assert(/Hidden camera found/.test(msg));
  assert(/PG room/.test(msg));
  assert(S.sosMessage(null, [], new Date()).includes('unavailable'));
  const uri = S.smsUri(['+91 98480 12345', '1930'], 'hi there');
  assert.strictEqual(uri, 'sms:+919848012345,1930?body=hi%20there');
});

test('three hard shakes open SOS; walking and a single bump do not', () => {
  let fired = 0;
  const d = new S.ShakeDetector(() => fired++);
  for (let t = 0; t < 5000; t += 20) d.feed(0, 9.8 + Math.sin(t / 90) * 4, 1, t);   // walking: up to ~1.4 g
  assert.strictEqual(fired, 0);
  d.feed(30, 5, 3, 6000); d.feed(9, 9.8, 0, 6100);
  assert.strictEqual(fired, 0);                                          // one bump
  d.feed(-31, 4, 2, 6300); d.feed(29, 6, 2, 6600);
  assert.strictEqual(fired, 1);
  d.feed(-31, 4, 2, 6800); d.feed(29, 6, 2, 7000); d.feed(-30, 4, 2, 7200);
  assert.strictEqual(fired, 1);                                          // not again straight away
});

test('the fake call rings after the delay, can be answered and ended', async () => {
  const log = [];
  const fc = new S.FakeCall({ ring: on => log.push('ring ' + on), show: (s, n) => log.push(s + ' ' + n) });
  fc.schedule(0.05, 'Amma');
  assert.strictEqual(fc.state, 'waiting');
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(fc.state, 'ringing');
  fc.answer();
  assert.strictEqual(fc.state, 'talking');
  fc.end();
  assert.strictEqual(fc.state, 'off');
  assert.deepStrictEqual(log, ['ring true', 'ringing Amma', 'ring false', 'talking Amma', 'off Amma']);
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('ok   ' + t.name); }
    catch (e) { console.log('FAIL ' + t.name + '\n     ' + e.message); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
