/* Run: node tests/radio.test.js
 * Loads js/radio.js the way the app does (a classic script that sets window.TGRadio) and checks
 * the Wi-Fi / Bluetooth / LAN classifiers on sample scan results, plus the plugin wrappers
 * against a fake Capacitor plugin. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'radio.js'), 'utf8');
function load(win) { vm.runInNewContext(code, { window: win, console }); return win.TGRadio; }

const R = load({});                                   // plain browser: no Capacitor
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const find = (list, key, val) => list.find(x => x[key] === val);

/* ---------- Wi-Fi ---------- */

const WIFI = {
  fresh: true,
  connected: { ssid: 'Sharma_Home_5G', bssid: 'a0:b1:c2:d3:e4:f5', ip: '192.168.1.23' },
  networks: [
    { ssid: 'Sharma_Home_5G', bssid: 'a0:b1:c2:d3:e4:f5', level: -41, frequency: 5180, capabilities: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]' },
    { ssid: 'HD-8F2A1C', bssid: '0e:11:22:33:44:55', level: -38, frequency: 2437, capabilities: '[ESS]' },
    { ssid: '', bssid: '28:57:be:12:34:56', level: -70, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
    { ssid: 'ESP_1A2B3C', bssid: '24:0a:c4:1a:2b:3c', level: -66, frequency: 2462, capabilities: '[ESS]' },
    { ssid: 'Tenda_4F2A10', bssid: '11:22:33:44:55:66', level: -72, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
    { ssid: 'Campus_WiFi', bssid: '11:22:33:44:55:77', level: -80, frequency: 2412, capabilities: '[WPA2-EAP-CCMP][ESS]' },
    { ssid: 'V380-12345678', bssid: '11:22:33:44:55:88', level: -75, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
    { ssid: 'Garage Cam', bssid: '11:22:33:44:55:99', level: -77, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
  ],
};

test('camera-style SSID (HD-8F2A1C, open, strong) is high and listed first', () => {
  const list = R.classifyWifi(WIFI);
  const n = find(list, 'ssid', 'HD-8F2A1C');
  assert.strictEqual(n.risk, 'high');
  assert.ok(n.reasons.some(r => /cameras use/.test(r)), n.reasons.join(' | '));
  assert.ok(n.reasons.some(r => /no password/.test(r)));
  assert.ok(n.reasons.some(r => /this room/.test(r)));
  assert.strictEqual(list[0].ssid, 'HD-8F2A1C');
});

test('normal home SSID is low (even with a strong signal) and marked connected', () => {
  const n = find(R.classifyWifi(WIFI), 'ssid', 'Sharma_Home_5G');
  assert.strictEqual(n.risk, 'low');
  assert.strictEqual(n.connected, true);
  assert.strictEqual(n.vendor, null);
});

test('Hikvision BSSID on a hidden network is high with vendor', () => {
  const n = find(R.classifyWifi(WIFI), 'bssid', '28:57:BE:12:34:56');
  assert.strictEqual(n.vendor, 'Hikvision');
  assert.strictEqual(n.risk, 'high');
  assert.ok(n.reasons.some(r => /Hidden/.test(r)));
});

test('Espressif factory hotspot (ESP_1A2B3C, open) is medium, high only when in the room', () => {
  const n = find(R.classifyWifi(WIFI), 'ssid', 'ESP_1A2B3C');
  assert.strictEqual(n.vendor, 'Espressif');
  assert.strictEqual(n.risk, 'medium');
  const near = R.classifyWifi({ networks: [Object.assign({}, WIFI.networks[3], { level: -40 })] })[0];
  assert.strictEqual(near.risk, 'high');
});

test('router brand with serial (Tenda_4F2A10) and "Campus" are low', () => {
  const list = R.classifyWifi(WIFI);
  assert.strictEqual(find(list, 'ssid', 'Tenda_4F2A10').risk, 'low');
  assert.strictEqual(find(list, 'ssid', 'Campus_WiFi').risk, 'low');
});

test('V380 hotspot is high, "Garage Cam" is medium', () => {
  const list = R.classifyWifi(WIFI);
  assert.strictEqual(find(list, 'ssid', 'V380-12345678').risk, 'high');
  assert.strictEqual(find(list, 'ssid', 'Garage Cam').risk, 'medium');
});

test('randomised (locally administered) MAC has no vendor', () => {
  assert.strictEqual(R.vendorOf('2a:57:be:12:34:56'), null);
  assert.strictEqual(R.vendorOf('EC-71-DB-00-00-01').name, 'Reolink');
});

test('list is sorted high > medium > low, then by signal', () => {
  const list = R.classifyWifi(WIFI);
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    assert.ok(order[a.risk] < order[b.risk] || (a.risk === b.risk && a.level >= b.level), `${a.ssid} before ${b.ssid}`);
  }
});

test('summaryWifi', () => {
  const s = R.summaryWifi(R.classifyWifi(WIFI));
  assert.ok(/^8 Wi-Fi networks nearby · 3 look like a camera hotspot · \d+ worth a closer look$/.test(s), s);
  assert.strictEqual(R.summaryWifi([]), 'No Wi-Fi networks found nearby.');
  assert.ok(/none look like a camera/.test(R.summaryWifi(R.classifyWifi({ networks: [WIFI.networks[0]] }))));
});

/* ---------- Bluetooth ---------- */

const BLE = {
  bluetoothOff: false,
  devices: [
    { address: 'C1:00:00:00:00:01', name: null, rssi: -58, manufacturer: [{ id: 76, data: '1219' + '10'.repeat(24) }], services: [] },
    { address: 'C1:00:00:00:00:02', name: null, rssi: -80, manufacturer: [{ id: 76, data: '1202000a' }], services: [] },
    { address: 'C1:00:00:00:00:03', name: 'Tile', rssi: -70, manufacturer: [], services: ['0000feed-0000-1000-8000-00805f9b34fb'] },
    { address: 'C1:00:00:00:00:04', name: null, rssi: -65, manufacturer: [], services: ['0000fd5a-0000-1000-8000-00805f9b34fb'] },
    { address: 'C1:00:00:00:00:05', name: 'V380_CAM_01', rssi: -55, manufacturer: [], services: [] },
    { address: 'C1:00:00:00:00:06', name: 'Galaxy Buds2', rssi: -62, manufacturer: [{ id: 117, data: '0102' }], services: [] },
    { address: 'C1:00:00:00:00:07', name: '', rssi: -90, manufacturer: [{ id: 76, data: '1005031c' }], services: [] },
  ],
};

test('AirTag away from owner (0x004C, payload 12 19 ..) is a high-risk tracker', () => {
  const d = find(R.classifyBle(BLE), 'address', 'C1:00:00:00:00:01');
  assert.strictEqual(d.kind, 'tracker');
  assert.strictEqual(d.risk, 'high');
  assert.ok(d.reasons.some(r => /Within a few metres/.test(r)));
});

test('Find My device near its owner is a medium tracker', () => {
  const d = find(R.classifyBle(BLE), 'address', 'C1:00:00:00:00:02');
  assert.strictEqual(d.kind, 'tracker');
  assert.strictEqual(d.risk, 'medium');
});

test('Tile and SmartTag are trackers', () => {
  const list = R.classifyBle(BLE);
  assert.strictEqual(find(list, 'address', 'C1:00:00:00:00:03').kind, 'tracker');
  assert.ok(/Tile/.test(find(list, 'address', 'C1:00:00:00:00:03').reasons[0]));
  assert.ok(/SmartTag/.test(find(list, 'address', 'C1:00:00:00:00:04').reasons[0]));
});

test('camera-named BLE device is a camera; earbuds and other Apple adverts are unknown/low', () => {
  const list = R.classifyBle(BLE);
  const cam = find(list, 'address', 'C1:00:00:00:00:05');
  assert.strictEqual(cam.kind, 'camera');
  assert.strictEqual(cam.risk, 'high');
  const buds = find(list, 'address', 'C1:00:00:00:00:06');
  assert.strictEqual(buds.kind, 'unknown');
  assert.strictEqual(buds.risk, 'low');
  assert.strictEqual(find(list, 'address', 'C1:00:00:00:00:07').kind, 'unknown');
  assert.ok(/2 trackers|4 trackers/.test(R.summaryBle(list)), R.summaryBle(list));
});

/* ---------- LAN ---------- */

const LAN = {
  subnet: '192.168.1.0/24', self: '192.168.1.23', gateway: '192.168.1.1',
  hosts: [
    { ip: '192.168.1.1', ports: [80], onvif: null },
    { ip: '192.168.1.64', ports: [80, 554, 8000], onvif: null },
    { ip: '192.168.1.70', ports: [], onvif: { xaddrs: 'http://192.168.1.70/onvif/device_service', scopes: 'onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/IPCAM onvif://www.onvif.org/hardware/C6CN' } },
    { ip: '192.168.1.90', ports: [34567], onvif: null },
    { ip: '192.168.1.120', ports: [8080], onvif: null },
  ],
};

test('RTSP host (554) is a high-risk camera', () => {
  const h = find(R.classifyLan(LAN), 'ip', '192.168.1.64');
  assert.strictEqual(h.kind, 'camera');
  assert.strictEqual(h.risk, 'high');
  assert.ok(h.reasons.some(r => /RTSP/.test(r)));
  assert.ok(h.reasons.some(r => /Hikvision device port/.test(r)));
});

test('ONVIF reply is a camera and its name is shown', () => {
  const h = find(R.classifyLan(LAN), 'ip', '192.168.1.70');
  assert.strictEqual(h.kind, 'camera');
  assert.ok(h.reasons.some(r => /IPCAM C6CN/.test(r)), h.reasons.join(' | '));
});

test('DVR port is "maybe"/medium, web-only is other/low, router is labelled', () => {
  const list = R.classifyLan(LAN);
  const dvr = find(list, 'ip', '192.168.1.90');
  assert.strictEqual(dvr.kind, 'maybe'); assert.strictEqual(dvr.risk, 'medium');
  const web = find(list, 'ip', '192.168.1.120');
  assert.strictEqual(web.kind, 'other'); assert.strictEqual(web.risk, 'low');
  assert.ok(find(list, 'ip', '192.168.1.1').reasons.some(r => /your Wi-Fi router/.test(r)));
  assert.deepStrictEqual(list.map(h => h.ip), ['192.168.1.64', '192.168.1.70', '192.168.1.90', '192.168.1.1', '192.168.1.120']);
  assert.ok(/2 look like a camera · 1 may be/.test(R.summaryLan(list)), R.summaryLan(list));
});

/* ---------- wrappers ---------- */

test('outside the app: not available and scans reject', async () => {
  assert.strictEqual(R.available, false);
  await assert.rejects(R.wifiScan(), /not in the app/);
  await assert.rejects(R.lanScan({}, () => {}), /not in the app/);
});

test('inside the app: lanScan adds and removes the progress listener', async () => {
  const log = [];
  let listener = null;
  const fake = {
    async addListener(ev, cb) { log.push('add:' + ev); listener = cb; return { remove: async () => { log.push('remove'); listener = null; } }; },
    async lanScan(opts) { log.push('scan:' + JSON.stringify(opts)); listener({ done: 127, total: 254 }); return { hosts: [] }; },
    async bleScan(opts) { return { devices: [], got: opts.durationMs }; },
    async wifiScan() { return { networks: [] }; },
  };
  const Rn = load({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: n => n === 'TwinRadio', registerPlugin: () => fake } });
  assert.strictEqual(Rn.available, true);
  const seen = [];
  const res = await Rn.lanScan({ timeoutMs: 200 }, p => seen.push(p.done + '/' + p.total));
  assert.strictEqual(res.hosts.length, 0);
  assert.deepStrictEqual(seen, ['127/254']);
  assert.deepStrictEqual(log, ['add:lanProgress', 'scan:{"timeoutMs":200}', 'remove']);
  assert.strictEqual((await Rn.bleScan()).got, 8000);
  assert.strictEqual((await Rn.bleScan(3000)).got, 3000);
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
