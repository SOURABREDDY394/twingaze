/* TwinGaze · voice.js
 * Spoken guidance in English, Hindi and Telugu, through the phone's own text-to-speech.
 * Each key has a short on-screen title and the sentence that is spoken.
 *
 * Style: calm and short, like a navigation voice. "<What happened>. <What to do>." No exclamation
 * marks, no chatter, the same words for the same thing every time.
 *
 * One speaker at a time. Every request has a level:
 *   4 urgent  (camera detected, possible lens, device detected, camera blocked): may cut in;
 *   3 event   (a result or a step: "reflection only", "scan started"): waits for the current line;
 *   2 routine (directions and test steps the guide repeats): spoken only once it has held for a
 *             moment, so a direction that flips back and forth is never read out;
 *   1 info    ("clock ahead", "phone detected"): only when the voice has been quiet for a while.
 * A line that could not be said within a few seconds is dropped, never read out late. */
(function (root) {
  'use strict';

  /* [on-screen title, spoken the first time in a scan, spoken after that]. A missing third entry means
   * "the same again"; '' means silent (the screen still shows the title). Results that only mean "keep
   * going" (not a camera, a light, a reflection) are never spoken. */
  const P = {
    en: {
      start:    ['Scanning', 'Scan started. Move the phone slowly around the room.', ''],
      lights:   ['Turn off the lights', 'Turn off the lights for a better scan.', ''],
      sweep:    ['Scan slowly', 'Keep scanning slowly. Check light fittings, smoke detectors and clocks.', ''],
      noTorch:  ['Flash unavailable', 'The flash is unavailable. Hold another light next to the camera.', ''],
      left:     ['Move left', 'Move left.', 'Left.'],
      right:    ['Move right', 'Move right.', 'Right.'],
      up:       ['Move up', 'Move up.', 'Up.'],
      down:     ['Move down', 'Move down.', 'Down.'],
      flash:    ['Hold still', 'Hold still for a moment.', ''],
      moveSide: ['Move sideways', 'Now move the phone slowly sideways, keeping the spot in the circle.', 'Move sideways.'],
      possible: ['Possible lens', 'Possible camera lens. Take a closer look at this spot.'],
      closer:   ['Move closer', 'Bring the phone closer to it.', 'Closer.'],
      hold:     ['Hold still', 'Hold still.', ''],
      found:    ['Camera found', 'Camera found. Do not touch it.', 'Camera found.'],
      glare:    ['Reflection only', ''],
      light:    ['Light source', ''],
      notCam:   ['Not a camera', ''],
      magCal:   ['Calibrating', 'Calibrating. Hold the phone away from electronics.', ''],
      magStart: ['Scan objects', 'Ready. Move the phone slowly over each object.', ''],
      magNear:  ['Signal rising', ''],
      magFound: ['Device detected', 'Electronic device detected. Check this spot for a camera.', 'Device detected.'],
      vScan:    ['Analysing the video', ''],
      vCheck:   ['Checking a bright point', ''],
      phoneSeen: ['Phone in view', 'Phone in view. Its camera will be checked.', ''],
      phoneFound: ['Phone camera found', 'Phone camera found. It is facing you.'],
      slower:   ['Turn slower', 'Turn a little slower.', 'Slower.'],
      agentPlan: ['Full room scan', 'Full room scan. Turn slowly all the way around.', ''],
      lookUp:   ['Look up at the ceiling', 'Now look up at the ceiling.', ''],
      agentDone:['Room checked', 'Room checked. Tap Finish for the report.', ''],
      recHold:  ['Hold on it', 'Hold steady on that.', ''],
      covered:  ['Camera blocked', 'The camera is blocked. Point the back camera at the room.', 'Camera blocked.'],
      radioHit: ['Camera signal nearby', 'Camera signal detected nearby.', ''],
      sample:   ['Voice', 'This is how TwinGaze will guide you.'],
    },
    hi: {
      start:    ['स्कैन शुरू', 'स्कैन शुरू। फ़ोन को धीरे-धीरे कमरे में घुमाएँ।', ''],
      lights:   ['लाइट बंद करें', 'बेहतर स्कैन के लिए लाइट बंद करें।', ''],
      sweep:    ['धीरे स्कैन करें', 'धीरे-धीरे स्कैन करते रहें। बल्ब होल्डर, स्मोक डिटेक्टर और घड़ी देखें।', ''],
      noTorch:  ['फ़्लैश उपलब्ध नहीं', 'फ़्लैश उपलब्ध नहीं है। कैमरे के पास कोई दूसरी रोशनी रखें।', ''],
      left:     ['बाएँ ले जाएँ', 'बाईं ओर ले जाएँ।', 'बाएँ।'],
      right:    ['दाएँ ले जाएँ', 'दाईं ओर ले जाएँ।', 'दाएँ।'],
      up:       ['ऊपर ले जाएँ', 'ऊपर ले जाएँ।', 'ऊपर।'],
      down:     ['नीचे ले जाएँ', 'नीचे ले जाएँ।', 'नीचे।'],
      flash:    ['स्थिर रखें', 'एक पल फ़ोन स्थिर रखें।', ''],
      moveSide: ['बगल में ले जाएँ', 'अब उस जगह को घेरे में रखते हुए फ़ोन धीरे-धीरे बगल में ले जाएँ।', 'बगल में ले जाएँ।'],
      possible: ['संभावित लेंस', 'यह कैमरे का लेंस हो सकता है। इस जगह को ध्यान से देखें।'],
      closer:   ['पास ले जाएँ', 'फ़ोन को उसके पास ले जाएँ।', 'और पास।'],
      hold:     ['स्थिर रखें', 'फ़ोन स्थिर रखें।', ''],
      found:    ['कैमरा मिला', 'कैमरा मिला है। उसे छुएँ नहीं।', 'कैमरा मिला।'],
      glare:    ['केवल चमक', ''],
      light:    ['रोशनी का स्रोत', ''],
      notCam:   ['कैमरा नहीं', ''],
      magCal:   ['कैलिब्रेशन', 'कैलिब्रेशन हो रहा है। फ़ोन को इलेक्ट्रॉनिक सामान से दूर रखें।', ''],
      magStart: ['चीज़ों पर घुमाएँ', 'तैयार। फ़ोन को हर चीज़ के ऊपर धीरे-धीरे घुमाएँ।', ''],
      magNear:  ['संकेत बढ़ रहा है', ''],
      magFound: ['डिवाइस मिला', 'इलेक्ट्रॉनिक डिवाइस मिला है। इस जगह कैमरा देखें।', 'डिवाइस मिला।'],
      vScan:    ['वीडियो की जाँच', ''],
      vCheck:   ['चमक की जाँच', ''],
      phoneSeen: ['फ़ोन दिखा', 'फ़ोन दिखा है। उसके कैमरे की जाँच होगी।', ''],
      phoneFound: ['फ़ोन कैमरा मिला', 'फ़ोन कैमरा मिला है। वह आपकी ओर है।'],
      slower:   ['धीरे घूमें', 'थोड़ा धीरे घूमें।', 'धीरे।'],
      agentPlan: ['पूरे कमरे का स्कैन', 'पूरे कमरे का स्कैन। धीरे-धीरे पूरा घूमें।', ''],
      lookUp:   ['छत की ओर देखें', 'अब छत की ओर देखें।', ''],
      agentDone:['कमरे की जाँच पूरी', 'कमरे की जाँच पूरी। रिपोर्ट के लिए फ़िनिश दबाएँ।', ''],
      recHold:  ['उस पर रोकें', 'उस पर फ़ोन स्थिर रखें।', ''],
      covered:  ['कैमरा ढका है', 'कैमरा ढका हुआ है। पीछे का कैमरा कमरे की ओर करें।', 'कैमरा ढका है।'],
      radioHit: ['कैमरा सिग्नल', 'पास में कैमरा सिग्नल मिला है।', ''],
      sample:   ['आवाज़', 'TwinGaze आपको इसी आवाज़ में बताएगा।'],
    },
    te: {
      start:    ['స్కాన్ ప్రారంభం', 'స్కాన్ ప్రారంభమైంది. ఫోన్‌ను గదిలో నెమ్మదిగా తిప్పండి.', ''],
      lights:   ['లైట్లు ఆపండి', 'మెరుగైన స్కాన్ కోసం లైట్లు ఆపండి.', ''],
      sweep:    ['నెమ్మదిగా స్కాన్ చేయండి', 'నెమ్మదిగా స్కాన్ కొనసాగించండి. బల్బ్ హోల్డర్లు, స్మోక్ డిటెక్టర్లు, గడియారాలు చూడండి.', ''],
      noTorch:  ['ఫ్లాష్ అందుబాటులో లేదు', 'ఫ్లాష్ అందుబాటులో లేదు. కెమెరా పక్కన మరో వెలుగు ఉంచండి.', ''],
      left:     ['ఎడమకు జరపండి', 'ఎడమకు జరపండి.', 'ఎడమ.'],
      right:    ['కుడికి జరపండి', 'కుడికి జరపండి.', 'కుడి.'],
      up:       ['పైకి జరపండి', 'పైకి జరపండి.', 'పైకి.'],
      down:     ['కిందికి జరపండి', 'కిందికి జరపండి.', 'కిందికి.'],
      flash:    ['కదలకండి', 'ఒక్క క్షణం ఫోన్‌ను కదలకుండా ఉంచండి.', ''],
      moveSide: ['పక్కకు జరపండి', 'ఇప్పుడు ఆ చోటును వృత్తంలో ఉంచి ఫోన్‌ను నెమ్మదిగా పక్కకు జరపండి.', 'పక్కకు జరపండి.'],
      possible: ['లెన్స్ కావచ్చు', 'ఇది కెమెరా లెన్స్ కావచ్చు. ఈ చోటును దగ్గరగా చూడండి.'],
      closer:   ['దగ్గరకు తీసుకెళ్లండి', 'ఫోన్‌ను దానికి దగ్గరగా తీసుకెళ్లండి.', 'ఇంకా దగ్గరగా.'],
      hold:     ['కదలకండి', 'ఫోన్‌ను కదలకుండా ఉంచండి.', ''],
      found:    ['కెమెరా గుర్తించబడింది', 'కెమెరా గుర్తించబడింది. దాన్ని తాకకండి.', 'కెమెరా గుర్తించబడింది.'],
      glare:    ['కేవలం మెరుపు', ''],
      light:    ['వెలుగు మూలం', ''],
      notCam:   ['కెమెరా కాదు', ''],
      magCal:   ['క్యాలిబ్రేషన్', 'క్యాలిబ్రేషన్ జరుగుతోంది. ఫోన్‌ను ఎలక్ట్రానిక్ పరికరాలకు దూరంగా ఉంచండి.', ''],
      magStart: ['వస్తువులపై తిప్పండి', 'సిద్ధం. ఫోన్‌ను ప్రతి వస్తువుపై నెమ్మదిగా తిప్పండి.', ''],
      magNear:  ['సిగ్నల్ పెరుగుతోంది', ''],
      magFound: ['పరికరం గుర్తించబడింది', 'ఎలక్ట్రానిక్ పరికరం గుర్తించబడింది. ఈ చోట కెమెరా కోసం చూడండి.', 'పరికరం గుర్తించబడింది.'],
      vScan:    ['వీడియో విశ్లేషణ', ''],
      vCheck:   ['మెరుపు పరిశీలన', ''],
      phoneSeen: ['ఫోన్ కనిపించింది', 'ఫోన్ కనిపించింది. దాని కెమెరాను పరీక్షిస్తాము.', ''],
      phoneFound: ['ఫోన్ కెమెరా గుర్తించబడింది', 'ఫోన్ కెమెరా గుర్తించబడింది. అది మీ వైపు ఉంది.'],
      slower:   ['నెమ్మదిగా తిరగండి', 'కొంచెం నెమ్మదిగా తిరగండి.', 'నెమ్మదిగా.'],
      agentPlan: ['పూర్తి గది స్కాన్', 'పూర్తి గది స్కాన్. నెమ్మదిగా పూర్తిగా తిరగండి.', ''],
      lookUp:   ['పైకప్పు వైపు చూడండి', 'ఇప్పుడు పైకప్పు వైపు చూడండి.', ''],
      agentDone:['గది పరీక్ష పూర్తయింది', 'గది పరీక్ష పూర్తయింది. రిపోర్ట్ కోసం ఫినిష్ నొక్కండి.', ''],
      recHold:  ['దానిపై ఆపండి', 'దానిపై ఫోన్‌ను స్థిరంగా ఉంచండి.', ''],
      covered:  ['కెమెరా కప్పబడింది', 'కెమెరా కప్పబడింది. వెనుక కెమెరాను గది వైపు చూపండి.', 'కెమెరా కప్పబడింది.'],
      radioHit: ['కెమెరా సిగ్నల్', 'దగ్గరలో కెమెరా సిగ్నల్ గుర్తించబడింది.', ''],
      sample:   ['వాయిస్', 'TwinGaze మీకు ఈ గొంతుతో దారి చూపిస్తుంది.'],
    },
  };
  const CODE = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };

  /* how important each line is (see the top of the file) */
  const URGENT = new Set(['found', 'possible', 'phoneFound', 'magFound', 'covered', 'describe', 'sample']);
  /* "Alerts" mode: only these are spoken (what was found, and what needs you right now) */
  const ALERTS = new Set(['found', 'possible', 'phoneFound', 'magFound', 'covered', 'agentDone', 'radioHit', 'describe', 'sample', 'start', 'agentPlan', 'magCal', 'magStart']);
  const EVENT = new Set(['start', 'glare', 'light', 'notCam', 'magCal', 'magStart', 'magNear', 'agentPlan', 'lookUp', 'agentDone', 'radioHit', 'lights', 'slower']);
  const INFO_KEY = k => k === 'phoneSeen' || /^spot:/.test(k);
  const levelOf = (key, opt) => opt.level || (URGENT.has(key) ? 4 : EVENT.has(key) ? 3 : INFO_KEY(key) ? 1 : 2);
  const SETTLE_MS = 450;        // a routine line must still be wanted this long before it is spoken
  const GAP_MS = 550;           // silence between two lines
  const STALE_MS = { 1: 2500, 2: 2200, 3: 3500, 4: 6000 };
  const INFO_QUIET_MS = 4000;   // info only after this much quiet
  const RATE = 1.0;             // a natural pace; the chosen voice already speaks clearly

  // what the object recogniser can name, in Hindi and Telugu (English is the label itself)
  const WORDS = {
    'Person': ['व्यक्ति', 'వ్యక్తి'], 'TV': ['टीवी', 'టీవీ'], 'Screen': ['स्क्रीन', 'స్క్రీన్'], 'Laptop': ['लैपटॉप', 'ల్యాప్‌టాప్'],
    'Clock': ['घड़ी', 'గడియారం'], 'Lamp': ['लैंप', 'దీపం'], 'Light bulb': ['बल्ब', 'బల్బ్'], 'Mirror': ['शीशा', 'అద్దం'],
    'Picture frame': ['फ़ोटो फ़्रेम', 'ఫోటో ఫ్రేమ్'], 'Fan': ['पंखा', 'ఫ్యాన్'], 'Socket': ['सॉकेट', 'సాకెట్'],
    'Switchboard': ['स्विचबोर्ड', 'స్విచ్‌బోర్డ్'], 'Plant': ['पौधा', 'మొక్క'], 'Vase': ['फूलदान', 'పూలకుండీ'],
    'Soft toy': ['खिलौना', 'బొమ్మ'], 'Towel': ['तौलिया', 'టవల్'], 'Remote': ['रिमोट', 'రిమోట్'], 'Box': ['डिब्बा', 'డబ్బా'],
    'Phone': ['फ़ोन', 'ఫోన్'], 'Tablet': ['टैबलेट', 'టాబ్లెట్'], 'Camera': ['कैमरा', 'కెమెరా'], 'Bed': ['बिस्तर', 'మంచం'],
    'Chair': ['कुर्सी', 'కుర్చీ'], 'Sofa': ['सोफ़ा', 'సోఫా'], 'Table': ['मेज़', 'బల్ల'], 'Desk': ['डेस्क', 'డెస్క్'],
    'Shelf': ['शेल्फ़', 'షెల్ఫ్'], 'Wardrobe': ['अलमारी', 'బీరువా'], 'Curtain': ['पर्दा', 'కర్టెన్'], 'Window': ['खिड़की', 'కిటికీ'],
    'Door': ['दरवाज़ा', 'తలుపు'], 'Toilet': ['शौचालय', 'టాయిలెట్'], 'Sink': ['सिंक', 'సింక్'], 'Shower': ['शावर', 'షవర్'],
    'Bathtub': ['बाथटब', 'బాత్‌టబ్'], 'Bottle': ['बोतल', 'సీసా'], 'Book': ['किताब', 'పుస్తకం'], 'Pillow': ['तकिया', 'దిండు'],
    'Smoke detector': ['स्मोक डिटेक्टर', 'స్మోక్ డిటెక్టర్'],
    'Bright point': ['चमक', 'మెరుపు'], 'Magnetic spot': ['चुंबकीय जगह', 'అయస్కాంత చోటు'], 'Wall clock': ['दीवार घड़ी', 'గోడ గడియారం'],
  };
  function joinList(items, lang) {
    if (items.length <= 1) return items.join('');
    const and = { en: ' and ', hi: ' और ', te: ' మరియు ' }[lang];
    return items.slice(0, -1).join(', ') + and + items[items.length - 1];
  }
  const norm = l => (l || '').replace('_', '-').toLowerCase();
  const native = () => root.TGNative && root.TGNative.available;
  const now = () => (root.performance ? root.performance.now() : Date.now());

  const Voice = {
    lang: 'en', on: true, mode: 'guide', voices: [], nativeVoices: null,
    count: {},             // key -> times spoken in this scan (the first time gets the full sentence)
    cur: null,             // { key, level, t } being spoken
    pending: null,         // { key, text, level, since, t }
    lastEnd: -1e9,         // when the last line finished
    spokenAt: {},          // key -> when it was last spoken
    timer: null,

    init() {
      if (native()) {
        root.TGNative.voices().then(v => { this.nativeVoices = v; });
        try { if (root.TGNative.onSpeechEnd) root.TGNative.onSpeechEnd(() => this.ended()); } catch (e) { /* polling still works */ }
        return;
      }
      if (!('speechSynthesis' in root)) return;
      const load = () => { this.voices = root.speechSynthesis.getVoices() || []; };
      load();
      if (root.speechSynthesis.addEventListener) root.speechSynthesis.addEventListener('voiceschanged', load);
    },
    title(key) { const e = (P[this.lang] || P.en)[key] || P.en[key]; return e ? e[0] : ''; },
    line(key) { const e = (P[this.lang] || P.en)[key] || P.en[key]; return e ? e[1] : ''; },
    hasVoice(lang) {
      if (native()) return !this.nativeVoices || this.nativeVoices[CODE[lang]] !== false;
      if (!this.voices.length) return true;                   // Android often lists none yet still speaks
      const code = norm(CODE[lang]);
      return this.voices.some(v => norm(v.lang) === code || norm(v.lang).startsWith(lang));
    },
    speakLang() { return this.hasVoice(this.lang) ? this.lang : 'en'; },

    /* a new scan: every step gets its full explanation once again */
    newSession() { this.count = {}; },
    /* a fixed line. opt: { repeatMs (don't say it again sooner), force (ignore repeatMs), level } */
    say(key, opt = {}) {
      const lang = this.speakLang();
      const e = (P[lang] || P.en)[key] || P.en[key];
      if (!e) return false;
      const text = !this.count[key] ? e[1] : (e[2] === undefined ? e[1] : e[2]);
      if (!text) return false;                               // silent here: the screen shows it
      return this.request(key, text, opt);
    },
    has(key) { return !!P.en[key]; },
    /* a short sample in the chosen voice (Settings) */
    sample() { this.count.sample = 0; return this.say('sample', { force: true }); },
    /* a sentence built at run time (directions, "clock ahead"); key + repeatMs throttle it */
    sayText(text, opt = {}) {
      if (!text) return false;
      return this.request(opt.key || text, text, Object.assign({ repeatMs: 8000 }, opt));
    },

    /* the speech manager */
    request(key, text, opt) {
      if (!this.on || !(native() || 'speechSynthesis' in root)) return false;
      if (this.mode === 'alerts' && !ALERTS.has(key)) return false;      // "Alerts": only what matters
      const t = now(), level = levelOf(key, opt);
      const repeatMs = opt.repeatMs == null ? 3000 : opt.repeatMs;
      if (!opt.force && t - (this.spokenAt[key] || -1e9) < repeatMs) return false;   // said recently
      if (this.cur && this.cur.key === key && this.speakingNow()) return false;        // being said now
      const p = this.pending;
      if (p && p.key === key) { p.text = text; p.t = t; return true; }                  // already waiting: keep its start
      if (p && level < p.level) return false;                                          // something more important waits
      this.pending = { key, text, level, since: t, t };
      if (level >= 4 && this.cur && this.cur.level < 4 && this.speakingNow()) this.hush(); // urgent cuts in
      this.pump();
      if (!this.timer) this.timer = setInterval(() => this.pump(), 120);
      return true;
    },
    pump() {
      const p = this.pending, t = now();
      if (!p) { if (!this.speakingNow()) { clearInterval(this.timer); this.timer = null; } return; }
      if (t - p.t > STALE_MS[p.level]) { this.pending = null; return; }               // the moment has passed
      if (p.level === 2 && t - p.since < SETTLE_MS) return;                            // let a direction settle
      if (this.speakingNow()) return;
      if (t - this.lastEnd < GAP_MS) return;
      if (p.level === 1 && t - this.lastEnd < INFO_QUIET_MS) return;                   // info waits for quiet
      this.pending = null;
      this.speakNow(p);
    },
    speakNow(p) {
      const lang = this.speakLang(), t = now();
      this.spokenAt[p.key] = t;
      this.count[p.key] = (this.count[p.key] || 0) + 1;
      if (p.level >= 4) {                                              // news: a soft chime first
        this.chime();
        this.cur = { key: p.key, level: p.level, t: t + 380 };
        setTimeout(() => this.utter(p, lang), 380);
        return;
      }
      this.cur = { key: p.key, level: p.level, t };
      this.utter(p, lang);
    },
    utter(p, lang) {
      if (native()) { root.TGNative.speak(p.text, CODE[lang], { rate: RATE }); return; }
      try {
        const ss = root.speechSynthesis;
        ss.cancel();
        const u = new SpeechSynthesisUtterance(p.text);
        u.lang = CODE[lang];
        const v = this.bestWebVoice(lang);
        if (v) u.voice = v;
        u.rate = RATE; u.pitch = 1;
        u.onend = u.onerror = () => this.ended();
        ss.speak(u);
      } catch (err) { this.ended(); }
    },
    ended() { if (this.cur) { this.cur = null; this.lastEnd = now(); } this.pump(); },
    /* two soft rising notes, like a notification, before important news */
    chime() {
      try {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        const c = this.ac || (this.ac = new AC());
        if (c.state === 'suspended') c.resume();
        const t = c.currentTime + 0.02;
        [[784, 0], [1175, 0.14]].forEach(([f, d]) => {
          const o = c.createOscillator(), g = c.createGain();
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t + d);
          g.gain.exponentialRampToValueAtTime(0.16, t + d + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.34);
          o.connect(g); g.connect(c.destination);
          o.start(t + d); o.stop(t + d + 0.36);
        });
      } catch (e) { /* no audio: the words still come */ }
    },
    speakingNow() {
      if (!this.cur) return false;
      const busy = native() ? root.TGNative.isSpeaking() : !!(root.speechSynthesis && root.speechSynthesis.speaking);
      if (!busy && now() - this.cur.t > 400) { this.cur = null; this.lastEnd = now(); return false; }   // missed the end event (t is after the chime)
      return true;
    },
    hush() {
      if (native()) root.TGNative.stopSpeaking();
      else { try { root.speechSynthesis && root.speechSynthesis.cancel(); } catch (e) { /* nothing queued */ } }
      this.cur = null; this.lastEnd = now() - GAP_MS;
    },
    /* the clearest installed voice: exact language + region, a local (offline) voice, a "natural"/"Google" one */
    bestWebVoice(lang) {
      const code = norm(CODE[lang]);
      const score = v => (norm(v.lang) === code ? 4 : norm(v.lang).startsWith(lang) ? 2 : -99)
        + (v.localService ? 1 : 0) + (/natural|neural|google|premium|enhanced/i.test(v.name) ? 2 : 0);
      let best = null, bs = -1;
      for (const v of this.voices) { const s = score(v); if (s > bs) { bs = s; best = v; } }
      return bs > 0 ? best : null;
    },

    /* the agent's turn-by-turn directions: { title (screen language), line (spoken), lang } */
    nav(kind, dir, deg, label) {
      const tl = this.lang, sl = this.speakLang();
      const build = lang => {
        const w = label ? this.word(label, lang) : '';
        if (lang === 'hi') {
          const D = dir === 'right' ? 'दाईं' : 'बाईं', U = dir === 'up' ? 'ऊपर' : 'नीचे';
          return { survey: [`धीरे-धीरे ${D} ओर घूमें`, `धीरे-धीरे ${D} ओर घूमें।`],
            turn: [`${D} ओर ${deg}° मुड़ें`, `${D} ओर ${deg} डिग्री मुड़ें, ${w} की ओर।`],
            look: [`${U} देखें`, `${U} देखें, ${w} की ओर।`],
            check: [`${w} जाँचें`, `${w} जाँचें। उस पर तीन सेकंड फ़्लैश रखें।`],
            find: [`${w} पर लौटें`, `${w} पर लौटें और फ़ोन उसकी ओर करें।`] }[kind];
        }
        if (lang === 'te') {
          const D = dir === 'right' ? 'కుడి' : 'ఎడమ', U = dir === 'up' ? 'పైకి' : 'కిందికి';
          return { survey: [`నెమ్మదిగా ${D} వైపు తిరగండి`, `నెమ్మదిగా ${D} వైపు తిరగండి.`],
            turn: [`${D} వైపు ${deg}° తిరగండి`, `${D} వైపు ${deg} డిగ్రీలు తిరగండి, ${w} వైపు.`],
            look: [`${U} చూడండి`, `${U} చూడండి, ${w} వైపు.`],
            check: [`${w} పరీక్షించండి`, `${w} పరీక్షించండి. దానిపై మూడు సెకన్లు ఫ్లాష్ ఉంచండి.`],
            find: [`${w} వద్దకు వెళ్లండి`, `${w} వద్దకు తిరిగి వెళ్లి ఫోన్‌ను దాని వైపు చూపండి.`] }[kind];
        }
        const W = label ? label.toLowerCase() : '';
        return { survey: [`Turn slowly ${dir}`, `Turn slowly to the ${dir}.`],
          turn: [`Turn ${dir} ${deg}°`, `Turn ${dir}, ${deg} degrees, towards the ${W}.`],
          look: [`Look ${dir}`, `Look ${dir}, towards the ${W}.`],
          check: [`Check the ${W}`, `Check the ${W}. Hold the flash on it for three seconds.`],
          find: [`Find the ${W}`, `Return to the ${W} and point the phone at it.`] }[kind];
      };
      const t = build(tl), l = tl === sl ? t : build(sl);
      return { title: t[0], line: l[1], lang: tl };
    },
    word(label, lang) {
      lang = lang || this.lang;
      const w = WORDS[label];
      return lang === 'hi' && w ? w[0] : lang === 'te' && w ? w[1] : label.toLowerCase();
    },
    /* "Clock ahead. Check it for a hidden camera." */
    spotLine(label) {
      const lang = this.speakLang();
      const w = this.word(label, lang);
      return lang === 'hi' ? `सामने ${w} है। इसमें छिपे कैमरे की जाँच करें।`
        : lang === 'te' ? `ఎదురుగా ${w} ఉంది. దాచిన కెమెరా కోసం దీన్ని పరీక్షించండి.`
          : `${label} ahead. Check it for a hidden camera.`;
    },
    /* "In view: a person, a clock and a TV." */
    describe(labels) {
      const lang = this.speakLang();
      if (!labels.length) return lang === 'hi' ? 'अभी कुछ पहचाना नहीं गया।' : lang === 'te' ? 'ఇంకా ఏమీ గుర్తించబడలేదు.' : 'Nothing recognised yet.';
      const words = labels.map(l => this.word(l, lang));
      return lang === 'hi' ? `सामने: ${joinList(words, lang)}।`
        : lang === 'te' ? `ఎదురుగా: ${joinList(words, lang)}.`
          : `In view: ${joinList(words.map(w => (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w), lang)}.`;
    },
    stop() { this.pending = null; this.hush(); },
    speaking() { return this.speakingNow(); },
  };

  root.TGVoice = Voice;
  if (typeof module === 'object' && module && module.exports) module.exports = Voice;
})(typeof window !== 'undefined' ? window : globalThis);
