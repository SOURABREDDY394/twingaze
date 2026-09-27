/* TwinGaze · native.js
 * Inside the Android app (Capacitor), the phone's own sensors, voice, vibration, gallery, share
 * sheet and clipboard are reached through the TwinNative plugin. In a browser this does nothing
 * and the rest of the app uses the web APIs instead. */
(function (root) {
  'use strict';

  const cap = root.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const P = isNative ? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('TwinNative') : cap.Plugins && cap.Plugins.TwinNative) : null;

  let speaking = false, speakPoll = null;
  const handles = {};

  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  const N = {
    available: !!P,

    /* Android Back (button or gesture): the app handles it; exitApp() leaves from the home screen */
    onBack(cb) { if (P && P.addListener) P.addListener('backButton', cb); },
    exitApp() { if (P) P.exitApp().catch(() => {}); },

    /* status bar icons: 'LIGHT' (dark icons, light screens) or 'DARK' (light icons, over the camera) */
    setBars(style) {
      if (!isNative || N._bars === style) return;
      N._bars = style;
      try { (N._sb || (N._sb = cap.registerPlugin('SystemBars'))).setStyle({ style }).catch(() => {}); } catch (e) { /* older Capacitor */ }
    },

    info() { return P ? P.info().catch(() => ({})) : Promise.resolve({}); },

    /* type: 'magnetometer' | 'light'. cb gets {x,y,z} or {lux}. Resolves true when readings start. */
    async startSensor(type, cb) {
      if (!P) return false;
      try {
        if (handles[type]) { handles[type].remove(); delete handles[type]; }
        handles[type] = await P.addListener(type, cb);
        await P.startSensor({ type });
        return true;
      } catch (e) { return false; }
    },
    stopSensor(type) {
      if (!P) return;
      if (handles[type]) { handles[type].remove(); delete handles[type]; }
      P.stopSensor({ type }).catch(() => {});
    },

    speak(text, lang, opt) {
      if (!P) return false;
      speaking = true;
      P.speak({ text, lang, rate: (opt && opt.rate) || 0.95 }).catch(() => { speaking = false; });
      clearInterval(speakPoll);
      speakPoll = setInterval(() => {
        P.isSpeaking().then(r => { speaking = !!(r && r.speaking); if (!speaking) clearInterval(speakPoll); }).catch(() => clearInterval(speakPoll));
      }, 250);
      return true;
    },
    stopSpeaking() { if (P) P.stopSpeaking().catch(() => {}); speaking = false; },
    /* called when a sentence has been fully spoken (so the next one never cuts in) */
    onSpeechEnd(cb) {
      if (!P) return;
      try {
        const h = P.addListener('ttsDone', () => { speaking = false; cb(); });
        if (h && typeof h.catch === 'function') h.catch(() => {});      // a promise in some Capacitor versions, a handle in others
      } catch (e) { /* older app: the voice falls back to polling isSpeaking */ }
    },
    isSpeaking() { return speaking; },
    voices() { return P ? P.voices().catch(() => ({})) : Promise.resolve({}); },
    /* the installed voices for a language, and choosing one (null = automatic) */
    voiceList(lang) { return P ? P.voiceList({ lang }).catch(() => ({ voices: [] })) : Promise.resolve({ voices: [] }); },
    setVoice(lang, name) { return P ? P.setVoice({ lang, name: name || '' }).catch(() => {}) : Promise.resolve(); },

    vibrate(pattern) { if (P) P.vibrate({ pattern }).catch(() => {}); },
    /* safety kit: the flash as a strobe, a siren on the alarm channel, the phone's own ringtone */
    async torch(on) { if (!P) return { ok: false }; try { return await P.torch({ on: !!on }); } catch (e) { return { ok: false }; } },
    async siren(on) { if (!P) return { ok: false }; try { return await P.siren({ on: !!on }); } catch (e) { return { ok: false }; } },
    async ringtone(on) { if (!P) return { ok: false }; try { return await P.ringtone({ on: !!on }); } catch (e) { return { ok: false }; } },
    keepAwake(on) { if (P) P.keepAwake({ on }).catch(() => {}); },

    /* Saves a Blob to the phone: kind 'image' -> Pictures/TwinGaze, 'video' -> Movies/TwinGaze,
     * anything else -> Download/TwinGaze. Written in chunks. Resolves to the folder path. */
    async saveBlob(blob, name, kind) {
      if (!P) throw new Error('not in the app');
      const f = await P.beginFile({ name, mime: blob.type || 'application/octet-stream', kind });
      const CHUNK = 768 * 1024;
      for (let off = 0; off < blob.size; off += CHUNK) {
        await P.appendFile({ id: f.id, data: await blobToB64(blob.slice(off, off + CHUNK)) });
      }
      await P.endFile({ id: f.id });
      return f.path;
    },

    /* files: [{blob, name}] (images / small files) */
    async share(title, text, files) {
      if (!P) return false;
      const list = [];
      for (const f of files || []) list.push({ name: f.name, data: await blobToB64(f.blob), mime: f.blob.type || 'application/octet-stream' });
      await P.share({ title, text, files: list });
      return true;
    },
    copy(text) { return P ? P.copy({ text }) : Promise.reject(new Error('not in the app')); },
  };

  root.TGNative = N;
})(window);
