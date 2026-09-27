/* TwinGaze · radio.js
 * Inside the Android app (Capacitor), the TwinRadio plugin lists nearby Wi-Fi networks, nearby
 * Bluetooth devices, and the devices on the Wi-Fi you are connected to. The plugin only hands back
 * raw data; this file decides what looks like a hidden camera or a tracker, and says why in plain
 * words. In a browser the scans aren't possible (available is false) but the classifiers still work.
 *
 * Scans reject with an Error whose .code is 'PERMISSION_DENIED' when the user says no. */
(function (root) {
  'use strict';

  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const hasPlugin = isNative && (typeof cap.isPluginAvailable !== 'function' || cap.isPluginAvailable('TwinRadio'));
  const P = hasPlugin ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinRadio') : cap.Plugins && cap.Plugins.TwinRadio) : null;

  function need() { if (!P) throw new Error('not in the app'); }

  const RISK_ORDER = { high: 0, medium: 1, low: 2 };
  const riskOf = score => score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  const byRiskThen = (a, b, key) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || ((b[key] || -999) - (a[key] || -999));

  /* ---------------------------------------------------------------------------------------
   * Who made the radio? The first 3 bytes of a hardware (MAC) address name the maker.
   * PARTIAL table: taken from the IEEE registry (via nmap's mac-prefix list) for camera makers
   * only. TP-Link (Tapo) is deliberately left out: its prefixes are shared with its routers, so
   * a TP-Link address says nothing about whether it's a camera. weight feeds the Wi-Fi score.
   * --------------------------------------------------------------------------------------- */
  const VENDORS = [
    { name: 'Hikvision', weight: 3, what: 'security-camera maker',
      ouis: '00BC99 040312 04EECD 083BC1 085411 08A189 08CC81 0C75D2 1012FB 1868CB 188025 240F9B 2428FD 2432AE 244845 24B105 2857BE 2CA59C 340962 3C1BF8 40ACBF 4419B6 4447CC 44A642 48785B 4C1F86 4C62DF 4CBD8F 4CF5DC 50E538 548C81 54C415 5803FB 5850ED 5C345B 64DB8B 686DBC 743FC2 80489F 807C62 80BEAF 80F5AE 849459 849A40 88DE39 8C22D2 8CE748 94E1AC 988B0A 989DE5 98DF82 98F112 A0FF0C A41437 A42902 A44BD9 A4A459 A4D5C2 ACB92F ACCB51 B4A382 BC2978 BC5E33 BC9B5E BCAD28 BCBAC2 C0517E C056E3 C06DED C42F90 C8A702 D4E853 DC07F8 DCD26A E0BAAD E0CA3C E0DF13 E4D58B E8A0ED ECA971 ECC89C F84DFC FC9FFD' },
    { name: 'Dahua', weight: 3, what: 'security-camera maker',
      ouis: '08EDED 14A78B 24526A 30DDAA 38AF29 3CE36B 3CEF8C 407AA4 4C11BF 4C99E8 5CF51A 64FD29 6C1C71 74C929 8CE9B4 9002A9 98F9CC 9C1463 A0BD1D A8CA87 B44C3B BC325F C0395A C4AAC4 D4430E E02EFE E0508B E4246C F4B1C2 F8CE07 FC5F49 FCB69D' },
    { name: 'Ezviz', weight: 3, what: 'home-camera maker (Hikvision brand)',
      ouis: '0CA64C 20BBBC 34C6DD 54D60D 588FCF 64244D 64F2FB 78A6A0 78C1AE 94EC13 AC1C26 EC97E0 F47018' },
    { name: 'Reolink', weight: 3, what: 'security-camera maker', ouis: 'EC71DB' },
    { name: 'Uniview', weight: 3, what: 'security-camera maker', ouis: '48EA63 6CF17E 88263F C47905' },
    { name: 'Axis', weight: 3, what: 'security-camera maker', ouis: '00408C ACCC8E B8A44F E82725' },
    { name: 'Hanwha Vision', weight: 3, what: 'security-camera maker (formerly Samsung Techwin)', ouis: '000918 44B423 E43022' },
    { name: 'Vivotek', weight: 3, what: 'security-camera maker', ouis: '0002D1' },
    { name: 'Arlo', weight: 3, what: 'home-camera maker', ouis: '486264 A41162 FC9C98' },
    { name: 'Gwell (Yoosee)', weight: 3, what: 'maker of cheap Yoosee Wi-Fi cameras', ouis: '4CB008' },
    { name: 'Wyze', weight: 2, what: 'smart-home maker best known for cheap cameras', ouis: '2CAA8E 7C78B2 80482C D03F27 F0C88B' },
    { name: 'Espressif', weight: 1, what: 'IoT chip often used in cheap Wi-Fi cameras (also in smart plugs and bulbs)',
      ouis: '004B12 007007 048308 04B247 083A8D 083AF2 089272 08A6F7 08B61F 08D1F9 08F9E0 0C4EA0 0C8B95 0CB815 0CDC7E 10003B 10061C 1020BA 1051DB 10521C 1091A8 1097BD 10B41D 10BDA3 140808 142B2F 14335C 146393 14C19F 188B0E 18FE34 1C6920 1C8F57 1C9DC2 1CC3AB 1CDBD4 2043A8 206EF1 209BA9 20E7C8 240AC4 244CAB 24587C 2462AB 246F28 24A160 24B2DE 24D7EB 24DCC3 24EC4A 2805A5 28372F 28562F 288485 2C3AE8 2CBCBB 2CF432 3030F9 3076F5 308398 30AEA4 30C6F7 30C922 30EDA0 345F45 348518 34865D 349454 34987A 34AB95 34B472 34B7DA 34CDB0 38182B 3844BE 3C0F02 3C6105 3C71BF 3C8427 3C8A1F 3CDC75 3CE90E 4022D8 404CCA 409151 40F520 441793 441BF6 441D64 4827E2 4831B7 483FDA 485519 489D31 48CA43 48E729 48F6EE 4C11AE 4C7525 4CC382 4CEBD6 500291 50787D 543204 5443B2 545AA6 588C81 58BF25 58CF79 58E6C5 5C013B 5CCF7F 600194 6055F9 64B708 64E833 680947 6825DD 686725 68B6B3 68C63A 68FE71 6CB456 6CC840 70039F 70041D 704BCA 70AF09 70B8F6 744DBD 781C3C 782184 78421C 78E36D 78EE4C 7C2C67 7C7398 7C87CE 7C9EBD 7CDFA1 80646F 806599 807D3A 80B54E 80F1B2 80F3DA 840D8E 841FE8 84CCA8 84F3EB 84F703 84FCE6 8813BF 8856A6 885721 88F155 8C4B14 8C4F00 8C8C29 8C94DF 8CAAB5 8CBFEA 8CCE4E 8CFD49 901506 90380C 907069 9097D5 90E5B1 943CC6 9451DC 9454C5 94A990 94B555 94B97E 94E686 983DAE 9888E0 98A316 98CDAC 98F4AB 9C139E 9C9C1F 9C9E6E A020A6 A0764E A085E3 A0A3B3 A0B765 A0DD6C A0F262 A47B9D A4CB8F A4CF12 A4E57C A4F00F A8032A A842E3 A84674 A848FA AC0BFB AC1518 AC276E AC67B2 ACA704 ACD074 ACEBE6 B08184 B0A604 B0A732 B0B21C B0CBD8 B43A45 B48A0A B4BFE9 B4E62D B8D61A B8F009 B8F862 BCDDC2 BCFF4D C049EF C04E30 C05D89 C0CDD6 C44F33 C45BBE C4D8D5 C4DD57 C4DEE2 C82B96 C82E18 C8C9A3 C8F09E CC50E3 CC7B5C CC8DA2 CCBA97 CCDBA7 D0CF13 D0EF76 D48AFC D48C49 D4D4DA D4E9F4 D4F98D D8132A D83BDA D885AC D8A01D D8BC38 D8BFC0 D8F15B DC0675 DC1ED5 DC4F22 DC5475 DCB4D9 DCDA0C E05A1B E072A1 E08CFE E09806 E0E2E6 E465B8 E4B063 E4B323 E80690 E831CD E83DC1 E868E7 E86BEA E89F6D E8DB84 E8F60A EC6260 EC64C9 EC94CB ECC9FF ECDA3B ECE334 ECFABC F008D1 F0161D F024F9 F09E9E F0F5BD F412FA F42DC9 F4650B F4CFA2 F85B1B F8B3B7 FC012C FCB467 FCE8C0 FCF5C4' },
  ];
  const OUI = new Map();
  for (const v of VENDORS) for (const p of v.ouis.split(' ')) if (p) OUI.set(p, v);

  /* Vendor for a MAC like "28:57:be:12:34:56", or null. Randomised ("locally administered")
   * addresses have no maker, so they are skipped. */
  function vendorOf(mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hex.length < 6) return null;
    if (parseInt(hex.slice(0, 2), 16) & 0x02) return null;
    return OUI.get(hex.slice(0, 6)) || null;
  }

  /* ---------------------------------------------------------------------------------------
   * Wi-Fi
   * --------------------------------------------------------------------------------------- */

  /* Factory hotspot names of cheap Wi-Fi / "spy" cameras (the name they broadcast before, or
   * instead of, joining your Wi-Fi). */
  const CAMERA_SSID = [
    /^HD[-_ ]?[0-9A-F]{6,}$/i,                     // HD-8F2A1C
    /^HD[-_ ]?(WiFi[-_ ]?)?Cam/i,                  // HDcam, HDWiFiCam, HD-Cam
    /^IP[-_ ]?CAM/i,                               // IPCAM, IP-Cam, IP_CAM
    /^IPC(365)?([-_ ]|\d|$)/i,                     // IPC, IPC365, IPC-xxxx
    /^CAM[-_]/i,                                   // CAM-xxxx
    /^Wi[-_ ]?Fi[-_ ]?Cam/i,                       // WIFICAM, WiFi-Cam, WiFi Cam
    /^Mini[-_ ]?(DV|Cam)/i,                        // MiniDV, Mini-Cam
    /^A9[-_]/i,                                    // "A9" magnetic mini cameras
    /^MV\d/i,
    /^P2P[-_]/i,
    /^(V380|Yoosee|CamHi|HiCam|Jooan|ESCAM|Wansview|XMEye|iCSee|CloudCam|Care[-_ ]?Cam|Smart[-_ ]?Cam|Spy[-_ ]?Cam|Hidden[-_ ]?Cam|Nanny[-_ ]?Cam)/i,
  ];
  /* "cam", "camera", "dvr" ... as a word or at the end: "Garage Cam", "BabyCam2". Not "Campus". */
  const CAMERA_WORD = /(^|[^a-z])(cam|camera|ipcam|webcam|spycam|dvr|nvr)\d*([^a-z]|$)|cam(era)?\d*$/i;
  /* Brand letters + a serial code, the way gadgets name their own hotspot: "ESP_1A2B3C", "JA-4F2A10". */
  const FACTORY_SSID = /^([A-Za-z][A-Za-z0-9]{1,11})[-_]([0-9A-Fa-f]{6,12})$/;
  /* ...but routers, phones, TVs and printers use that pattern too; these are left alone. */
  const KNOWN_CONSUMER = /^(tp[-_ ]?link|tenda|netgear|linksys|asus|d[-_ ]?link|xiaomi|redmi|mi|huawei|honor|jio(fi|fiber|net)?\d*|airtel|act|excitel|bsnl|hathway|mercusys|totolink|digisol|iball|netis|vodafone|vi|galaxy|samsung|androidap|iphone|ipad|oneplus|realme|oppo|vivo|poco|moto|nokia|zte|alcatel|sagemcom|technicolor|syrotech|ubnt|eero|google|nest|mesh|home|guest|office|direct|hp|epson|canon|brother|sony|bravia|lg|tcl|chromecast|firetv)$/i;

  function isOpen(caps) {
    return !/WPA|WEP|RSN|SAE|OWE|PSK|EAP/i.test(String(caps || ''));
  }

  /* result: what wifiScan() resolved with (or just its networks array).
   * Returns [{ ssid, bssid, level, frequency, risk, reasons, vendor, open, connected }],
   * most suspicious first, then strongest signal. */
  function classifyWifi(result) {
    const nets = Array.isArray(result) ? result : (result && result.networks) || [];
    const conn = !Array.isArray(result) && result && result.connected;
    const connBssid = conn && conn.bssid ? String(conn.bssid).toUpperCase() : '';

    const out = nets.map(n => {
      const ssid = String(n.ssid || '');
      const bssid = String(n.bssid || '').toUpperCase();
      const level = Number(n.level);
      const reasons = [];
      let score = 0;

      const v = vendorOf(bssid);
      const open = isOpen(n.capabilities);
      const camName = CAMERA_SSID.some(re => re.test(ssid));
      const camWord = !camName && CAMERA_WORD.test(ssid);
      const m = !camName && !camWord && FACTORY_SSID.exec(ssid);
      const factory = !!(m && /\d/.test(m[2]) && !KNOWN_CONSUMER.test(m[1]));

      if (camName) { score += 3; reasons.push(`The name "${ssid}" matches the hotspot name cheap Wi-Fi / spy cameras use`); }
      else if (camWord) { score += 2; reasons.push(`The name "${ssid}" suggests a camera`); }
      else if (factory) { score += 1; reasons.push(`The name "${ssid}" looks like a gadget's factory name (brand letters + serial code), not a home router`); }

      if (v) {
        score += v.weight;
        reasons.push(v.weight >= 2 ? `The hardware address belongs to ${v.name}, a ${v.what}` : `The hardware address belongs to ${v.name}: ${v.what}`);
      }

      if (open && (camName || camWord || factory || v)) { score += 1; reasons.push('Open network with no password, which cameras do while waiting to be set up'); }
      else if (open && ssid) reasons.push('Open network (no password)');

      // Without camera evidence (name or camera-maker address) a gadget hotspot stays "worth a look"
      // unless it's also right here in the room.
      const cameraEvidence = camName || camWord || (v && v.weight >= 2);
      if (!cameraEvidence) score = Math.min(score, 2);

      if (level > -45) {
        if (score > 0) score += 1;
        reasons.push(`Very strong signal (${level} dBm): whatever broadcasts it is probably in this room`);
      } else if (level > -60 && score > 0) {
        reasons.push(`Strong signal (${level} dBm): probably close by`);
      }

      if (!ssid) reasons.push('Hidden network name');
      const connected = !!connBssid && connBssid === bssid;
      if (connected) reasons.push("This is the Wi-Fi you're connected to");

      return { ssid, bssid, level, frequency: n.frequency, risk: riskOf(score), reasons, vendor: v ? v.name : null, open, connected, score };
    });
    return out.sort((a, b) => byRiskThen(a, b, 'level'));
  }

  /* One line for the top of the results, e.g. "14 Wi-Fi networks nearby · 1 looks like a camera hotspot". */
  function summaryWifi(list) {
    list = list || [];
    if (!list.length) return 'No Wi-Fi networks found nearby.';
    const hi = list.filter(n => n.risk === 'high').length;
    const med = list.filter(n => n.risk === 'medium').length;
    let s = `${list.length} Wi-Fi network${list.length === 1 ? '' : 's'} nearby`;
    if (hi) s += ` · ${hi} look${hi === 1 ? 's' : ''} like a camera hotspot`;
    if (med) s += ` · ${med} worth a closer look`;
    if (!hi && !med) s += ' · none look like a camera';
    return s;
  }

  /* ---------------------------------------------------------------------------------------
   * Bluetooth
   * --------------------------------------------------------------------------------------- */

  const CAM_BLE_NAME = /cam|ipc|v380|yoosee|spy|dvr|lens/i;
  const APPLE = 0x004C;

  /* A rough distance from signal strength. Walls, bodies and phone models change it a lot. */
  function distanceHint(rssi) {
    if (!isFinite(rssi)) return null;
    if (rssi > -60) return 'Within a few metres';
    if (rssi > -75) return 'In this room or the next one';
    return 'Further away (weak signal)';
  }

  /* Services are full UUIDs from Android, e.g. "0000feed-0000-1000-8000-00805f9b34fb". */
  const has16 = (svcs, short) => svcs.some(u => u === short || u.startsWith('0000' + short + '-'));

  /* result: what bleScan() resolved with (or its devices array).
   * Returns [{ name, address, rssi, kind: 'camera'|'tracker'|'unknown', risk, reasons }]. */
  function classifyBle(result) {
    const devs = Array.isArray(result) ? result : (result && result.devices) || [];
    const out = devs.map(d => {
      const name = String(d.name || '');
      const rssi = Number(d.rssi);
      const mfr = Array.isArray(d.manufacturer) ? d.manufacturer : [];
      const svcs = (Array.isArray(d.services) ? d.services : []).map(s => String(s).toLowerCase());
      const reasons = [];
      let kind = 'unknown', score = 0;

      // Apple's Find My network: manufacturer data 0x004C, payload type 0x12. The long form
      // (0x12 0x19 ...) is sent when the tag is away from its owner's iPhone.
      const findMy = mfr.find(m => Number(m.id) === APPLE && /^12/i.test(String(m.data || '')));
      if (findMy) {
        kind = 'tracker';
        if (/^1219/i.test(String(findMy.data))) {
          score = 3;
          reasons.push("An AirTag or other Find My tracker that is away from its owner's iPhone");
        } else {
          score = 1;
          reasons.push("An AirTag or other Find My device that is near its owner (possibly someone's own)");
        }
      } else if (has16(svcs, 'feed') || has16(svcs, 'feec')) {
        kind = 'tracker'; score = 2;
        reasons.push('A Tile tracker');
      } else if (has16(svcs, 'fd5a')) {
        kind = 'tracker'; score = 2;
        reasons.push('A Samsung Galaxy SmartTag');
      } else if (name && CAM_BLE_NAME.test(name)) {
        kind = 'camera'; score = 2;
        reasons.push(`The name "${name}" suggests a camera`);
        if (rssi > -60) score += 1;
      }

      if (kind === 'tracker' && rssi > -60 && score < 3) reasons.push('Close to you: if it isn\'t yours, check your bags and the room');
      const dist = distanceHint(rssi);
      if (dist) reasons.push(`${dist} (${rssi} dBm)`);

      return { name, address: d.address || '', rssi, kind, risk: riskOf(score), reasons, score };
    });
    return out.sort((a, b) => byRiskThen(a, b, 'rssi'));
  }

  function summaryBle(list) {
    list = list || [];
    if (!list.length) return 'No Bluetooth devices found nearby.';
    const cams = list.filter(d => d.kind === 'camera').length;
    const tags = list.filter(d => d.kind === 'tracker').length;
    let s = `${list.length} Bluetooth device${list.length === 1 ? '' : 's'} nearby`;
    if (cams) s += ` · ${cams} may be a camera`;
    if (tags) s += ` · ${tags} tracker${tags === 1 ? '' : 's'}`;
    if (!cams && !tags) s += ' · no cameras or trackers recognised';
    return s;
  }

  /* ---------------------------------------------------------------------------------------
   * Devices on your Wi-Fi
   * --------------------------------------------------------------------------------------- */

  const PORTS = {
    554: { score: 3, kind: 'camera', text: 'Video-streaming port (RTSP, 554) is open: IP cameras and video recorders use it' },
    34567: { score: 2, kind: 'maybe', text: 'Port 34567 is open: used by cheap XMEye / Xiongmai-based cameras and DVRs' },
    37777: { score: 2, kind: 'maybe', text: 'Port 37777 is open: used by Dahua-based cameras and recorders' },
    8899: { score: 2, kind: 'maybe', text: 'Port 8899 is open: the camera-control (ONVIF) port on many cheap Wi-Fi cameras' },
    5000: { score: 0, kind: 'other', text: 'Port 5000 is open: some cheap cameras use it, but so do NAS boxes, Macs and many apps' },
  };
  const WEB_PORTS = [80, 8000, 8080];

  /* Pulls "name" and "hardware" out of ONVIF scopes like onvif://www.onvif.org/name/IPCAM */
  function onvifIdentity(scopes) {
    const out = [];
    const re = /onvif:\/\/www\.onvif\.org\/(name|hardware)\/(\S+)/gi;
    let m;
    while ((m = re.exec(String(scopes || '')))) {
      let v = m[2];
      try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
      if (v && !out.includes(v)) out.push(v);
    }
    return out.join(' ');
  }

  const ipNum = ip => String(ip || '').split('.').reduce((a, b) => a * 256 + (Number(b) || 0), 0);

  /* what a device says it is: its UPnP description (TVs, routers, cameras and media boxes publish one)
   * and the name the router gave it. Returns { what, camera: bool, text } or null. */
  const CAM_WORDS = /\b(ip ?cam|ipc|cam(era)?|webcam|hikvision|dahua|ezviz|yoosee|reolink|imou|v380|dvr|nvr|nvt|wyze|arlo|blink|eufy ?cam|tapo[ -]?c\d|mi ?home ?security|onvif|video ?recorder|doorbell)\b/i;
  function identity(h) {
    const u = h.upnp || {};
    const text = [u.name, u.maker, u.model, u.deviceType, u.server, h.name].filter(Boolean).join(' ');
    if (!text) return null;
    const t = (u.deviceType || '') + ' ' + (u.types || '');
    let what = null;
    if (CAM_WORDS.test(text) || /DigitalSecurityCamera|NetworkVideo/i.test(t)) what = 'Camera';
    else if (/\b(windows|microsoft-windows|macos|mac os|utorrent)\b/i.test(u.server || '') || /ut:client/i.test(t)) what = 'Computer';
    else if (/InternetGatewayDevice|WANDevice/i.test(t) || /\b(router|gateway|jiofiber|airtel|tp-?link|d-?link|netgear|asus|mikrotik|huawei hg)\b/i.test(text)) what = 'Router';
    else if (/MediaRenderer/i.test(t) || /\b(tv|bravia|android ?tv|smart ?tv|chromecast|fire ?tv|roku|mi ?box)\b/i.test(text)) what = 'TV or media player';
    else if (/Printer/i.test(t) || /\b(printer|laserjet|deskjet|epson|canon|brother)\b/i.test(text)) what = 'Printer';
    else if (/\b(android|iphone|ipad|galaxy|redmi|oneplus|vivo|iqoo|oppo|realme|pixel)\b/i.test(text)) what = 'Phone or tablet';
    else if (/\b(laptop|desktop|macbook|windows|pc|desktop-)\b/i.test(text)) what = 'Computer';
    else if (/\b(echo|alexa|google ?home|nest|speaker)\b/i.test(text)) what = 'Smart speaker';
    const label = [u.maker, u.model || u.name].filter(Boolean).join(' ').trim() || h.name || null;
    return { what, camera: what === 'Camera', text: label };
  }

  /* result: what lanScan() resolved with (or its hosts array).
   * Returns [{ ip, ports, kind: 'camera'|'maybe'|'other', risk, reasons, onvif }]. */
  function classifyLan(result) {
    const hosts = Array.isArray(result) ? result : (result && result.hosts) || [];
    const gateway = !Array.isArray(result) && result ? result.gateway : null;
    const out = hosts.map(h => {
      const ports = (Array.isArray(h.ports) ? h.ports : []).map(Number);
      const reasons = [];
      let score = 0, kind = 'other';

      if (h.onvif) {
        score += 4; kind = 'camera';
        reasons.push('Answered a camera discovery request (ONVIF): this is a network camera or video recorder');
        const who = onvifIdentity(h.onvif.scopes);
        if (who) reasons.push(`It calls itself: ${who}`);
      }
      for (const p of ports) {
        const info = PORTS[p];
        if (!info) continue;
        score += info.score;
        if (info.kind === 'camera') kind = 'camera';
        else if (info.kind === 'maybe' && kind === 'other') kind = 'maybe';
        reasons.push(info.text);
      }
      const web = ports.filter(p => WEB_PORTS.includes(p));
      if (web.length) {
        reasons.push(`Has a web page (port ${web.join(', ')}): could be a router, printer, TV or a camera's settings page` +
          (web.includes(8000) ? ' (8000 is also the Hikvision device port)' : ''));
      }
      if (gateway && h.ip === gateway) reasons.push('This is your Wi-Fi router');
      const id = identity(h);
      if (id && id.camera && kind !== 'camera') {
        score += 3; kind = 'camera';
        reasons.unshift(`It describes itself as a camera${id.text ? ': ' + id.text : ''}`);
      } else if (id && id.what && kind !== 'camera') reasons.unshift(`It says it is a ${id.what.toLowerCase()}${id.text ? ` (${id.text})` : ''}`);
      if (id && kind === 'maybe' && id.what && id.what !== 'Camera') kind = 'other';   // a TV or printer with a web page is not a camera

      const risk = kind === 'camera' ? 'high' : kind === 'maybe' ? 'medium' : 'low';
      return { ip: h.ip, ports, kind, risk, reasons, onvif: h.onvif || null, score, name: h.name || (h.upnp && h.upnp.name) || null, what: id ? id.what : null, label: id ? id.text : null };
    });
    return out.sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || (ipNum(a.ip) - ipNum(b.ip)));
  }

  function summaryLan(list) {
    list = list || [];
    if (!list.length) return 'No devices with camera or web ports found on this Wi-Fi.';
    const cams = list.filter(h => h.kind === 'camera').length;
    const maybe = list.filter(h => h.kind === 'maybe').length;
    let s = `${list.length} device${list.length === 1 ? '' : 's'} answering on this Wi-Fi`;
    if (cams) s += ` · ${cams} look${cams === 1 ? 's' : ''} like a camera`;
    if (maybe) s += ` · ${maybe} may be a camera or recorder`;
    if (!cams && !maybe) s += ' · none look like a camera';
    return s;
  }

  /* ---------------------------------------------------------------------------------------
   * The scans (app only)
   * --------------------------------------------------------------------------------------- */

  const R = {
    available: !!P,

    /* Resolves { networks: [{ssid, bssid, level, frequency, capabilities, ageMs}], fresh,
     * connected: {ssid, bssid, ip} | null, locationOff, wifiOff }.
     * fresh is false when Android throttled the scan (about 4 per 2 minutes) and gave cached results. */
    async wifiScan() { need(); return await P.wifiScan(); },

    /* Resolves { devices: [{address, name, rssi, seen, manufacturer: [{id, data}], services: [uuid],
     * serviceData: {uuid: hex}}], bluetoothOff, unsupported?, locationOff? }. ms: scan length (default 8 s). */
    async bleScan(ms) { need(); return await P.bleScan({ durationMs: ms || 8000 }); },

    /* opts: { ports?: [..], timeoutMs?: 300 }. onProgress gets { done, total } (hosts checked).
     * Resolves { subnet, self, gateway, hosts: [{ ip, ports, onvif: {xaddrs, scopes} | null }] }
     * or { noWifi: true, hosts: [] }. Takes roughly 10-15 s on a /24. */
    async lanScan(opts, onProgress) {
      need();
      let handle = null;
      try {
        if (typeof onProgress === 'function') handle = await P.addListener('lanProgress', onProgress);
        return await P.lanScan(opts || {});
      } finally {
        if (handle) { try { await handle.remove(); } catch (e) { /* already gone */ } }
      }
    },

    classifyWifi, summaryWifi,
    classifyBle, summaryBle,
    classifyLan, summaryLan, identity,
    vendorOf,
  };

  root.TGRadio = R;
})(window);
