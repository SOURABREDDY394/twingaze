/* TwinGaze · net.js
 * Network check: is the Wi-Fi you are on private? Who can see what you do on it?
 * Inputs are what Android reports (TwinRadio netInfo: security type, captive portal, VPN, Private
 * DNS, proxy, DNS servers) plus the Wi-Fi scan (other networks with the same name) and the network
 * scan (devices on this Wi-Fi). No test traffic is sent anywhere; this file only reads and judges.
 * In a PG, hostel or hotel the owner runs the Wi-Fi, so "what can the Wi-Fi owner see" is the point. */
(function (root) {
  'use strict';

  /* ---------- Wi-Fi security, from Android's type number or a scan's capability string ---------- */
  const SEC_TYPE = { 0: 'open', 1: 'wep', 2: 'wpa2', 3: 'enterprise', 4: 'wpa3', 5: 'enterprise', 6: 'owe', 7: 'wpa2', 8: 'enterprise', 9: 'enterprise', 10: 'enterprise', 11: 'enterprise', 12: 'enterprise', 13: 'wpa3' };
  function secFromCaps(caps) {
    const c = String(caps || '').toUpperCase();
    if (!c) return null;
    if (c.includes('SAE') || c.includes('WPA3')) return 'wpa3';
    if (c.includes('OWE')) return 'owe';
    if (c.includes('EAP')) return 'enterprise';
    if (c.includes('WPA2') || c.includes('RSN')) return 'wpa2';
    if (c.includes('WPA')) return 'wpa';
    if (c.includes('WEP')) return 'wep';
    return 'open';
  }
  const SEC_TXT = { open: 'no password (open)', owe: 'Enhanced Open (encrypted, no password)', wep: 'WEP (broken)', wpa: 'WPA (old)', wpa2: 'WPA2', wpa3: 'WPA3', enterprise: 'WPA Enterprise' };
  const encrypted = s => s && s !== 'open';

  const PUBLIC_DNS = {
    '8.8.8.8': 'Google', '8.8.4.4': 'Google', '1.1.1.1': 'Cloudflare', '1.0.0.1': 'Cloudflare', '9.9.9.9': 'Quad9', '149.112.112.112': 'Quad9',
    '208.67.222.222': 'OpenDNS', '208.67.220.220': 'OpenDNS', '94.140.14.14': 'AdGuard', '94.140.15.15': 'AdGuard',
  };

  /* info: netInfo(); scan: wifiScan() result (optional); lan: lanScan() result (optional),
   * lanList: TGRadio.classifyLan(lan) (optional).
   * Returns { verdict: 'safe'|'review'|'danger'|'offline', title, sub, checks: [{id, status, title, detail, action}],
   *           wifi: {ssid, security, ...}, devices: {alive, cameras, list} } */
  function assess(info, scan, lan, lanList) {
    info = info || {};
    const checks = [];
    const add = (id, status, title, detail, action) => checks.push({ id, status, title, detail, action: action || null });
    const w = info.wifi || null;
    const act = info.active || null;
    const nets = (scan && scan.networks) || [];

    if (!w) {
      const onData = act && act.cellular;
      add('conn', 'info', onData ? 'On mobile data, not Wi-Fi' : 'Not connected to Wi-Fi',
        onData ? 'Your mobile operator carries your traffic. Wi-Fi checks don\'t apply; VPN and Private DNS below still do.' : (info.wifiOn === false ? 'Wi-Fi is switched off.' : 'Connect to the Wi-Fi you want to check.'));
    }

    // 1. how the Wi-Fi itself is protected
    let sec = null;
    if (w) {
      const mine = w.bssid ? nets.find(n => n.bssid && n.bssid.toLowerCase() === String(w.bssid).toLowerCase()) : null;
      sec = w.securityType != null && SEC_TYPE[w.securityType] ? SEC_TYPE[w.securityType] : mine ? secFromCaps(mine.capabilities) : null;
      const name = w.ssid ? `“${w.ssid}”` : 'This Wi-Fi';
      if (sec === 'open') add('sec', 'bad', `${name} has no password`, 'Anyone nearby can capture what this phone sends over it. Websites with https stay encrypted, but the sites you visit, app traffic without encryption and your device are exposed. Use mobile data for anything private, or turn on a VPN.', { page: 'wifi' });
      else if (sec === 'wep') add('sec', 'bad', `${name} uses WEP`, 'WEP encryption can be broken in minutes with free tools. Treat this Wi-Fi as open.', { page: 'wifi' });
      else if (sec === 'wpa') add('sec', 'warn', `${name} uses old WPA`, 'The first WPA is weak. Ask for WPA2 or WPA3, and don\'t do anything private on it without a VPN.', { page: 'wifi' });
      else if (sec) add('sec', 'ok', `${name} is encrypted (${SEC_TXT[sec]})`, sec === 'wpa3' ? 'The strongest Wi-Fi protection.' : 'Other guests can\'t read your traffic over the air. The owner of the Wi-Fi still can see where it goes (see below).');
      else add('sec', 'info', `${name}: protection unknown`, info.locationPerm === false ? 'Allow Location for TwinGaze to read this (Android requires it for Wi-Fi details).' : 'Android did not report how this Wi-Fi is protected.');
      if (w.hiddenSsid) add('hidden', 'info', 'Hidden network name', 'This Wi-Fi does not broadcast its name. That hides nothing from someone listening, and makes your phone call out for it by name elsewhere.');
    }

    // 2. a fake twin: same name, different protection
    if (w && w.ssid) {
      const same = nets.filter(n => n.ssid === w.ssid && n.bssid && (!w.bssid || n.bssid.toLowerCase() !== String(w.bssid).toLowerCase()));
      const kinds = new Set(same.map(n => encrypted(secFromCaps(n.capabilities)) ? 'enc' : 'open'));
      if (encrypted(sec) && kinds.has('open')) add('twin', 'bad', `Another “${w.ssid}” with no password nearby`, 'A copy of a real Wi-Fi name without a password is a classic trap (an "evil twin") to catch people\'s traffic. Stay on the protected one and forget the open one if your phone ever joins it.', { page: 'wifi' });
      else if (sec === 'open' && kinds.has('enc')) add('twin', 'bad', `You may be on a fake copy of “${w.ssid}”`, 'A protected network with the same name is nearby, and you are on the open one. Disconnect, forget this network, and join the protected one.', { page: 'wifi' });
      else if (same.length) add('twin', 'ok', 'No fake copy of this Wi-Fi', `${same.length + 1} access points share this name, all protected the same way (normal for bigger networks).`);
      else if (nets.length) add('twin', 'ok', 'No fake copy of this Wi-Fi', 'No other network nearby uses this name.');
    }
    // open networks that copy a protected name nearby (not the one you are on)
    const openCopies = [];
    const byName = new Map();
    for (const n of nets) { if (!n.ssid) continue; const k = byName.get(n.ssid) || new Set(); k.add(encrypted(secFromCaps(n.capabilities)) ? 'enc' : 'open'); byName.set(n.ssid, k); }
    for (const [ssid, k] of byName) if (k.has('enc') && k.has('open') && (!w || ssid !== w.ssid)) openCopies.push(ssid);
    if (openCopies.length) add('twins', 'warn', `Open copies of nearby Wi-Fi names: ${openCopies.slice(0, 3).map(s => `“${s}”`).join(', ')}`, 'Each name is broadcast both with and without a password. Don\'t join the open one.');

    // 3. login page / internet
    if (w && w.captivePortal) add('portal', 'warn', 'This Wi-Fi shows a sign-in page', 'Use it only for this Wi-Fi\'s own login. Never type a password for another account (email, bank, social) into a Wi-Fi sign-in page.');
    else if (w && w.validated === false) add('portal', 'warn', 'No working internet on this Wi-Fi', 'Android could not reach the internet through it. A camera\'s own hotspot looks like this too.');

    // 4. a proxy in the middle
    if (w && w.proxy) add('proxy', 'bad', 'Your traffic goes through a proxy', `This Wi-Fi is set to send web traffic through ${w.proxy}. If you did not set it, someone may be reading or changing it. Remove it in this Wi-Fi's settings (Proxy: None).`, { page: 'wifi' });

    // 5. who can see which sites you visit
    const pdMode = info.privateDnsMode || null, pdActive = w ? !!w.privateDns : false;
    if (info.vpn) add('see', 'ok', 'A VPN is on', 'The Wi-Fi owner only sees encrypted traffic to your VPN, not the sites you visit. (The VPN company can see them instead: use one you trust.)');
    else if (pdActive && (pdMode === 'hostname' || w.privateDnsServer)) add('see', 'ok', `Private DNS is on${w.privateDnsServer ? ` (${w.privateDnsServer})` : ''}`, 'The names of the sites you visit are encrypted. The Wi-Fi owner can still see which servers you connect to, but not your searches or pages on https sites.');
    else if (pdActive) add('see', 'ok', 'Private DNS is on (automatic)', 'This Wi-Fi\'s name server supports encryption, so site names are hidden from other people on the network. For a guarantee, set a Private DNS host such as dns.google or one.one.one.one.', { page: 'privateDns' });
    else if (w) add('see', 'warn', 'The Wi-Fi owner can log every site you visit', 'Your phone asks this network\'s name server for every website and app it connects to, unencrypted. In a PG, hostel or hotel, the owner can keep that list. Turn on Private DNS: Settings → Network & internet → Private DNS → enter dns.google (or one.one.one.one), or use a VPN.', { page: 'privateDns' });
    else if (!info.vpn && pdMode === 'off') add('see', 'warn', 'Private DNS is off', 'Your mobile operator can see the name of every site you visit. Turn on Private DNS in Settings → Network & internet.', { page: 'privateDns' });

    // 6. name servers: who answers "where is google.com?"
    if (w && w.dns && w.dns.length && !pdActive && !info.vpn) {
      const known = w.dns.map(d => PUBLIC_DNS[d]).filter(Boolean);
      const lanDns = w.dns.filter(d => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(d));
      add('dns', 'info', 'Who answers your look-ups', known.length ? `${[...new Set(known)].join(', ')} (${w.dns.join(', ')})` : lanDns.length ? `The router itself (${w.dns.join(', ')}): whoever runs it sees the look-ups` : `A server set by this network: ${w.dns.join(', ')}`);
    }

    // 7. devices on this Wi-Fi
    let devices = null;
    if (lan && !lan.noWifi) {
      const alive = (lan.alive || []).length;
      const list = lanList || [];
      const cams = list.filter(h => h.kind === 'camera');
      const maybe = list.filter(h => h.kind === 'maybe');
      devices = { alive, cameras: cams.length, maybe: maybe.length, list };
      if (cams.length) add('lan', 'bad', `${cams.length} camera${cams.length > 1 ? 's' : ''} on this Wi-Fi`, cams.slice(0, 3).map(h => `${h.name || h.ip}: ${h.reasons[0] || 'camera'}`).join(' · ') + '. A camera on the Wi-Fi you were given is worth finding: run a room scan.');
      else if (maybe.length) add('lan', 'warn', `${maybe.length} device${maybe.length > 1 ? 's' : ''} that may be a camera or recorder`, maybe.slice(0, 3).map(h => `${h.name || h.ip}: ${h.reasons[0] || ''}`).join(' · '));
      else add('lan', 'ok', 'No camera on this Wi-Fi', `${alive || list.length} device${(alive || list.length) === 1 ? '' : 's'} answered; none looks like a camera. A camera that records to a memory card, or on another network, won't show up here.`);
    }

    const bad = checks.filter(c => c.status === 'bad').length, warn = checks.filter(c => c.status === 'warn').length;
    const verdict = !w && !(act && act.cellular) ? 'offline' : bad ? 'danger' : warn ? 'review' : 'safe';
    const title = verdict === 'danger' ? (bad > 1 ? `${bad} serious problems on this network` : checks.find(c => c.status === 'bad').title)
      : verdict === 'review' ? (warn > 1 ? `${warn} things to fix` : checks.find(c => c.status === 'warn').title)
        : verdict === 'offline' ? 'Not connected' : 'This network looks private';
    const sub = w ? `${w.ssid ? `“${w.ssid}”` : 'Wi-Fi'}${sec ? ' · ' + SEC_TXT[sec] : ''}${w.frequency ? ' · ' + (w.frequency > 5900 ? '6' : w.frequency > 4900 ? '5' : '2.4') + ' GHz' : ''}${w.rssi != null ? ' · ' + w.rssi + ' dBm' : ''}`
      : act && act.cellular ? 'Mobile data' : 'No connection';
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    checks.sort((a, b) => order[a.status] - order[b.status]);
    return { verdict, title, sub, checks, wifi: w ? Object.assign({ security: sec }, w) : null, devices, counts: { bad, warn } };
  }

  function summary(r) {
    return r.verdict === 'safe' ? `${r.wifi && r.wifi.ssid ? `“${r.wifi.ssid}”` : 'Network'} looks private` : r.title;
  }

  const N = { assess, summary, secFromCaps, SEC_TXT };

  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const P = isNative && (typeof cap.isPluginAvailable !== 'function' || cap.isPluginAvailable('TwinRadio'))
    ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinRadio') : cap.Plugins && cap.Plugins.TwinRadio) : null;
  N.available = !!P;
  N.info = async () => { if (!P) throw new Error('not in the app'); return await P.netInfo(); };

  root.TGNet = N;
  if (typeof module === 'object' && module && module.exports) module.exports = N;
})(typeof window !== 'undefined' ? window : globalThis);
