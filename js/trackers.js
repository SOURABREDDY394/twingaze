/* TwinGaze · trackers.js
 * Which tracking and advertising libraries (SDKs) are built into the apps on this phone.
 * An Android app's code names the Java packages it contains ("Lcom/appsflyer/..."), and Android
 * lets any app read another app's code, so the TwinGuard plugin searches each installed app for
 * the signatures below. This file holds the list and decides what the findings mean for you.
 *
 * The list: the Java package names that these companies publish in their own SDK documentation.
 * It is not exhaustive: an app without a known signature may still track you (for example with
 * its own code, or a library that renames its packages). Nothing is sent anywhere. */
(function (root) {
  'use strict';

  /* cat: ads · analytics · profiling (ad attribution / marketing: links you across apps) ·
   *      replay (records what you do on screen) · location (sells or shares location) ·
   *      crash · social */
  const TRACKERS = [
    // ---------- advertising ----------
    { id: 'admob', name: 'Google AdMob', owner: 'Google', cat: 'ads', sigs: ['Lcom/google/android/gms/ads/MobileAds', 'Lcom/google/android/gms/ads/AdView', 'Lcom/google/android/gms/ads/interstitial/'] },
    { id: 'gam', name: 'Google Ad Manager', owner: 'Google', cat: 'ads', sigs: ['Lcom/google/android/gms/ads/admanager/', 'Lcom/google/android/gms/ads/doubleclick/'] },
    { id: 'ima', name: 'Google IMA (video ads)', owner: 'Google', cat: 'ads', sigs: ['Lcom/google/ads/interactivemedia/'] },
    { id: 'fban', name: 'Meta Audience Network', owner: 'Meta', cat: 'ads', sigs: ['Lcom/facebook/ads/'] },
    { id: 'applovin', name: 'AppLovin', owner: 'AppLovin', cat: 'ads', sigs: ['Lcom/applovin/'] },
    { id: 'unityads', name: 'Unity Ads', owner: 'Unity', cat: 'ads', sigs: ['Lcom/unity3d/ads/', 'Lcom/unity3d/services/'] },
    { id: 'ironsource', name: 'ironSource', owner: 'Unity', cat: 'ads', sigs: ['Lcom/ironsource/'] },
    { id: 'inmobi', name: 'InMobi', owner: 'InMobi', cat: 'ads', sigs: ['Lcom/inmobi/'] },
    { id: 'chartboost', name: 'Chartboost', owner: 'Chartboost', cat: 'ads', sigs: ['Lcom/chartboost/'] },
    { id: 'vungle', name: 'Liftoff Vungle', owner: 'Liftoff', cat: 'ads', sigs: ['Lcom/vungle/'] },
    { id: 'mintegral', name: 'Mintegral', owner: 'Mobvista', cat: 'ads', sigs: ['Lcom/mbridge/msdk/'] },
    { id: 'pangle', name: 'Pangle', owner: 'ByteDance', cat: 'ads', sigs: ['Lcom/bytedance/sdk/openadsdk/'] },
    { id: 'yandexads', name: 'Yandex Ads', owner: 'Yandex', cat: 'ads', sigs: ['Lcom/yandex/mobile/ads/'] },
    { id: 'criteo', name: 'Criteo', owner: 'Criteo', cat: 'ads', sigs: ['Lcom/criteo/'] },
    { id: 'smaato', name: 'Smaato', owner: 'Verve', cat: 'ads', sigs: ['Lcom/smaato/'] },
    { id: 'amazonads', name: 'Amazon Ads', owner: 'Amazon', cat: 'ads', sigs: ['Lcom/amazon/device/ads/', 'Lcom/amazon/aps/'] },
    { id: 'huaweiads', name: 'Huawei Ads', owner: 'Huawei', cat: 'ads', sigs: ['Lcom/huawei/hms/ads/'] },
    { id: 'taboola', name: 'Taboola', owner: 'Taboola', cat: 'ads', sigs: ['Lcom/taboola/'] },
    { id: 'outbrain', name: 'Outbrain', owner: 'Outbrain', cat: 'ads', sigs: ['Lcom/outbrain/'] },
    { id: 'startapp', name: 'Start.io', owner: 'Start.io', cat: 'ads', sigs: ['Lcom/startapp/'] },
    { id: 'adcolony', name: 'AdColony', owner: 'Digital Turbine', cat: 'ads', sigs: ['Lcom/adcolony/'] },
    { id: 'fyber', name: 'Fyber', owner: 'Digital Turbine', cat: 'ads', sigs: ['Lcom/fyber/'] },
    { id: 'tapjoy', name: 'Tapjoy', owner: 'Tapjoy', cat: 'ads', sigs: ['Lcom/tapjoy/'] },
    { id: 'mopub', name: 'MoPub', owner: 'AppLovin', cat: 'ads', sigs: ['Lcom/mopub/'] },
    // ---------- profiling: ad attribution and marketing automation, links you across apps ----------
    { id: 'adid', name: 'Advertising ID reader', owner: 'Google', cat: 'profiling', sigs: ['Lcom/google/android/gms/ads/identifier/AdvertisingIdClient'], note: 'Reads the ID advertisers use to follow you across apps' },
    { id: 'appsflyer', name: 'AppsFlyer', owner: 'AppsFlyer', cat: 'profiling', sigs: ['Lcom/appsflyer/'] },
    { id: 'adjust', name: 'Adjust', owner: 'AppLovin', cat: 'profiling', sigs: ['Lcom/adjust/sdk/'] },
    { id: 'branch', name: 'Branch', owner: 'Branch', cat: 'profiling', sigs: ['Lio/branch/'] },
    { id: 'kochava', name: 'Kochava', owner: 'Kochava', cat: 'profiling', sigs: ['Lcom/kochava/'] },
    { id: 'singular', name: 'Singular', owner: 'Singular', cat: 'profiling', sigs: ['Lcom/singular/sdk/'] },
    { id: 'fbevents', name: 'Meta App Events', owner: 'Meta', cat: 'profiling', sigs: ['Lcom/facebook/appevents/'], note: 'Tells Meta which apps you use and what you do in them, even without a Facebook account' },
    { id: 'clevertap', name: 'CleverTap', owner: 'CleverTap', cat: 'profiling', sigs: ['Lcom/clevertap/'] },
    { id: 'moengage', name: 'MoEngage', owner: 'MoEngage', cat: 'profiling', sigs: ['Lcom/moengage/'] },
    { id: 'webengage', name: 'WebEngage', owner: 'WebEngage', cat: 'profiling', sigs: ['Lcom/webengage/'] },
    { id: 'braze', name: 'Braze', owner: 'Braze', cat: 'profiling', sigs: ['Lcom/braze/', 'Lcom/appboy/'] },
    { id: 'onesignal', name: 'OneSignal', owner: 'OneSignal', cat: 'profiling', sigs: ['Lcom/onesignal/'] },
    // ---------- analytics ----------
    { id: 'firebase', name: 'Google Firebase Analytics', owner: 'Google', cat: 'analytics', sigs: ['Lcom/google/firebase/analytics/'] },
    { id: 'ga', name: 'Google Analytics', owner: 'Google', cat: 'analytics', sigs: ['Lcom/google/android/gms/analytics/'] },
    { id: 'mixpanel', name: 'Mixpanel', owner: 'Mixpanel', cat: 'analytics', sigs: ['Lcom/mixpanel/'] },
    { id: 'amplitude', name: 'Amplitude', owner: 'Amplitude', cat: 'analytics', sigs: ['Lcom/amplitude/'] },
    { id: 'segment', name: 'Segment', owner: 'Twilio', cat: 'analytics', sigs: ['Lcom/segment/analytics/'] },
    { id: 'flurry', name: 'Flurry', owner: 'Yahoo', cat: 'analytics', sigs: ['Lcom/flurry/'] },
    { id: 'appmetrica', name: 'AppMetrica', owner: 'Yandex', cat: 'analytics', sigs: ['Lcom/yandex/metrica/', 'Lio/appmetrica/'] },
    { id: 'appcenter', name: 'App Center Analytics', owner: 'Microsoft', cat: 'analytics', sigs: ['Lcom/microsoft/appcenter/analytics/'] },
    { id: 'hmsanalytics', name: 'Huawei Analytics', owner: 'Huawei', cat: 'analytics', sigs: ['Lcom/huawei/hms/analytics/'] },
    { id: 'heap', name: 'Heap', owner: 'Contentsquare', cat: 'analytics', sigs: ['Lcom/heapanalytics/'] },
    { id: 'comscore', name: 'Comscore', owner: 'Comscore', cat: 'analytics', sigs: ['Lcom/comscore/'] },
    { id: 'nielsen', name: 'Nielsen', owner: 'Nielsen', cat: 'analytics', sigs: ['Lcom/nielsen/'] },
    { id: 'newrelic', name: 'New Relic', owner: 'New Relic', cat: 'analytics', sigs: ['Lcom/newrelic/agent/'] },
    // ---------- session replay: records your taps and screens ----------
    { id: 'smartlook', name: 'Smartlook', owner: 'Cisco', cat: 'replay', sigs: ['Lcom/smartlook/'] },
    { id: 'uxcam', name: 'UXCam', owner: 'UXCam', cat: 'replay', sigs: ['Lcom/uxcam/'] },
    { id: 'clarity', name: 'Microsoft Clarity', owner: 'Microsoft', cat: 'replay', sigs: ['Lcom/microsoft/clarity/'] },
    { id: 'instabug', name: 'Instabug', owner: 'Instabug', cat: 'replay', sigs: ['Lcom/instabug/'], note: 'Bug reports that can include screen recordings' },
    // ---------- location data ----------
    { id: 'foursquare', name: 'Foursquare Movement', owner: 'Foursquare', cat: 'location', sigs: ['Lcom/foursquare/pilgrim/', 'Lcom/foursquare/movement/'] },
    { id: 'radar', name: 'Radar', owner: 'Radar', cat: 'location', sigs: ['Lio/radar/sdk/'] },
    { id: 'cuebiq', name: 'Cuebiq', owner: 'Cuebiq', cat: 'location', sigs: ['Lcom/cuebiq/'] },
    { id: 'huq', name: 'Huq', owner: 'Huq', cat: 'location', sigs: ['Lio/huq/'] },
    { id: 'tutela', name: 'Tutela', owner: 'Comlinkdata', cat: 'location', sigs: ['Lcom/tutelatechnologies/'] },
    // ---------- crash reports (least concern) ----------
    { id: 'crashlytics', name: 'Firebase Crashlytics', owner: 'Google', cat: 'crash', sigs: ['Lcom/google/firebase/crashlytics/'] },
    { id: 'sentry', name: 'Sentry', owner: 'Sentry', cat: 'crash', sigs: ['Lio/sentry/'] },
    { id: 'bugsnag', name: 'Bugsnag', owner: 'SmartBear', cat: 'crash', sigs: ['Lcom/bugsnag/'] },
    // ---------- social ----------
    { id: 'fblogin', name: 'Facebook Login / Share', owner: 'Meta', cat: 'social', sigs: ['Lcom/facebook/login/', 'Lcom/facebook/share/'] },
    { id: 'twitterkit', name: 'Twitter Kit', owner: 'X', cat: 'social', sigs: ['Lcom/twitter/sdk/'] },
  ];
  const BY_ID = new Map(TRACKERS.map(t => [t.id, t]));

  const CAT = {
    replay: { name: 'Screen recording', weight: 3, why: 'records what you tap and see inside the app' },
    location: { name: 'Location data', weight: 3, why: 'collects where you go, often sold on' },
    profiling: { name: 'Profiling', weight: 2, why: 'links what you do across apps to build an ad profile' },
    ads: { name: 'Advertising', weight: 1, why: 'shows ads and shares data with ad networks' },
    analytics: { name: 'Analytics', weight: 1, why: 'reports how you use the app' },
    social: { name: 'Social', weight: 1, why: 'shares data with a social network' },
    crash: { name: 'Crash reports', weight: 0, why: 'sends error reports (usually harmless)' },
  };

  /* Android permissions that make a tracker-filled app more worrying (what it can pass on) */
  const SENSITIVE = {
    ACCESS_FINE_LOCATION: 'precise location', ACCESS_BACKGROUND_LOCATION: 'location in the background',
    CAMERA: 'camera', RECORD_AUDIO: 'microphone', READ_CONTACTS: 'contacts', READ_SMS: 'SMS',
    READ_CALL_LOG: 'call log', READ_PHONE_STATE: 'phone identity',
  };

  /* what the plugin needs: [{ id, sigs }] */
  const signatures = () => TRACKERS.map(t => ({ id: t.id, sigs: t.sigs }));

  /* result: { apps: { pkg: [trackerId] | null } }; apps: the phone-check list [{ pkg, name, granted, icon, system }].
   * Returns { apps: [{ pkg, name, icon, trackers: [{id,name,owner,cat}], cats: {cat: n}, perms: [label], score, risk, reasons }],
   *           counts: { scanned, withTrackers, trackers, replay, location, profiling }, top: [...] } */
  function classify(result, apps) {
    const found = (result && result.apps) || {};
    const byPkg = new Map((apps || []).map(a => [a.pkg, a]));
    const out = [];
    let unreadable = 0;
    for (const pkg of Object.keys(found)) {
      const ids = found[pkg];
      if (ids == null) { unreadable++; continue; }
      const a = byPkg.get(pkg) || { pkg, name: pkg };
      const trackers = ids.map(id => BY_ID.get(id)).filter(Boolean);
      const cats = {};
      for (const t of trackers) cats[t.cat] = (cats[t.cat] || 0) + 1;
      const perms = [...new Set((a.granted || []).filter(p => SENSITIVE[p]).map(p => SENSITIVE[p]))];
      let score = trackers.reduce((s, t) => s + CAT[t.cat].weight, 0);
      if (score > 0) score += Math.min(3, perms.length) * 0.5;       // more it can see = more it can pass on
      const reasons = [];
      if (cats.replay) reasons.push(`Can record your screen inside the app (${trackers.filter(t => t.cat === 'replay').map(t => t.name).join(', ')})`);
      if (cats.location) reasons.push(`Contains a location-data SDK (${trackers.filter(t => t.cat === 'location').map(t => t.name).join(', ')})`);
      if (cats.profiling) reasons.push(`${cats.profiling} profiling SDK${cats.profiling > 1 ? 's' : ''} that link you across apps`);
      if (cats.ads) reasons.push(`${cats.ads} advertising network${cats.ads > 1 ? 's' : ''}`);
      if (perms.length && trackers.some(t => t.cat !== 'crash')) reasons.push(`It can also use your ${perms.join(', ')}`);
      const risk = cats.replay || cats.location || score >= 10 ? 'high' : score >= 3 ? 'medium' : 'low';   // high: records the screen, sells location, or very heavy tracking
      out.push({ pkg, name: a.name || pkg, icon: a.icon || null, trackers, cats, perms, score, risk, reasons });
    }
    out.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    const withT = out.filter(a => a.trackers.some(t => t.cat !== 'crash'));
    const kinds = new Set(out.flatMap(a => a.trackers.map(t => t.id)));
    const counts = {
      scanned: out.length, unreadable, withTrackers: withT.length, trackers: kinds.size,
      replay: out.filter(a => a.cats.replay).length, location: out.filter(a => a.cats.location).length,
      profiling: out.filter(a => a.cats.profiling).length, high: out.filter(a => a.risk === 'high').length,
    };
    // which companies reach into the most apps
    const owners = {};
    for (const a of withT) for (const o of new Set(a.trackers.filter(t => t.cat !== 'crash').map(t => t.owner))) owners[o] = (owners[o] || 0) + 1;
    const topOwners = Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([owner, n]) => ({ owner, apps: n }));
    return { apps: out, counts, topOwners };
  }

  function summary(r) {
    const c = r.counts;
    if (!c.scanned) return 'No downloaded apps to check.';
    if (!c.withTrackers) return `${c.scanned} downloaded apps checked · no known trackers found`;
    return `${c.withTrackers} of ${c.scanned} downloaded apps contain trackers · ${c.trackers} different ones` +
      (c.replay ? ` · ${c.replay} can record the screen` : '') + (c.location ? ` · ${c.location} collect location data` : '');
  }

  const T = { TRACKERS, CAT, signatures, classify, summary, info: id => BY_ID.get(id) || null };

  /* in the app: the native search, with progress */
  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const P = isNative && (typeof cap.isPluginAvailable !== 'function' || cap.isPluginAvailable('TwinGuard'))
    ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinGuard') : cap.Plugins && cap.Plugins.TwinGuard) : null;
  T.available = !!P;
  T.scan = async (packages, onProgress) => {
    if (!P) throw new Error('not in the app');
    let handle = null;
    try {
      if (typeof onProgress === 'function') handle = await P.addListener('trackerProgress', onProgress);
      return await P.trackers({ signatures: signatures(), packages });
    } finally { if (handle) { try { await handle.remove(); } catch (e) { /* gone */ } } }
  };

  root.TGTrackers = T;
  if (typeof module === 'object' && module && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : globalThis);
