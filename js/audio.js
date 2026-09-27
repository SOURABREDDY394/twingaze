/* TwinGaze · audio.js
 * A metal-detector style beeper: the closer you get to a suspect, the faster and higher it beeps.
 * On a confirmed camera it switches to a two-tone alarm. Web Audio only, works offline. */
(function (root) {
  'use strict';

  let ctx = null, out = null, timer = null, level = 0, alarm = false, on = true, last = 0, flip = false;

  function unlock() {
    try {
      if (!ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        out = ctx.createGain();
        out.gain.value = 0.5;
        out.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) { ctx = null; }
  }

  function tone(freq, dur, type, vol) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function tick() {
    if (!ctx || !on || ctx.state !== 'running') return;
    const now = performance.now();
    const duck = root.TGVoice && root.TGVoice.speaking() ? 0.3 : 1;   // let the voice through
    if (alarm) {
      if (now - last >= 170) { last = now; flip = !flip; tone(flip ? 1760 : 1320, 0.13, 'square', 0.3 * duck); }
      return;
    }
    if (level < 0.06) return;
    const gap = 1000 - 930 * Math.pow(level, 0.8);           // 1 s apart when faint, ~70 ms when close
    if (now - last >= gap) { last = now; tone(640 + 1250 * level, 0.04 + 0.04 * level, 'sine', (0.45 + 0.5 * level) * duck); }
  }

  root.TGBeeper = {
    unlock,
    start() { unlock(); clearInterval(timer); timer = setInterval(tick, 25); },
    stop() { clearInterval(timer); timer = null; level = 0; alarm = false; },
    set(l, a) { level = l; alarm = !!a; },
    chirp() { unlock(); if (ctx && on) { tone(880, 0.08, 'sine', 0.5); setTimeout(() => ctx && tone(1320, 0.1, 'sine', 0.5), 90); } },
    get on() { return on; },
    set on(v) { on = !!v; },
    get level() { return level; },
  };
})(window);
