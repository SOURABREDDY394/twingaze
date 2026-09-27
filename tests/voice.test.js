/* Run: node tests/voice.test.js
 * The voice (js/voice.js): one line at a time, directions only once they settle, news cuts in after a
 * chime, background information waits for quiet, late lines are dropped; each step is explained in full
 * once per scan and then briefly (or not at all); "Alerts" mode speaks only findings. A fake speech
 * engine and a fake clock stand in for the phone. */
'use strict';
const assert = require('assert');

let T = 0;
const said = [];
let cur = null;
global.window = {
  performance: { now: () => T },
  speechSynthesis: {
    get speaking() { return !!cur; },
    speak(u) { cur = u; said.push(u.text); },
    cancel() { cur = null; },
    getVoices: () => [],
  },
};
global.SpeechSynthesisUtterance = function (text) { this.text = text; };
const realSetInterval = setInterval, realSetTimeout = setTimeout;
global.setInterval = () => 0;                      // the test pumps by hand
global.clearInterval = () => {};
global.setTimeout = fn => { fn(); return 0; };     // the chime delay happens at once here
const V = require('../js/voice.js');
V.init();

const finish = () => { const u = cur; cur = null; if (u && u.onend) u.onend(); };
const at = ms => { T = ms; V.pump(); };
const reset = () => { said.length = 0; cur = null; V.pending = null; V.cur = null; V.lastEnd = -1e9; V.spokenAt = {}; V.newSession(); V.mode = 'guide'; V.on = true; T += 60000; };
const hold = (key, from, to, opt) => { for (let k = from; k <= to; k += 100) { V.say(key, opt); at(k); } };   // the guide asks every frame

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a direction that flips back within a moment is never spoken', () => {
  reset(); const t0 = T;
  V.say('left', { repeatMs: 4500 }); at(t0 + 100);
  V.say('right', { repeatMs: 4500 }); at(t0 + 300);
  V.say('left', { repeatMs: 4500 }); at(t0 + 500);
  assert.deepStrictEqual(said, []);
  hold('left', t0 + 600, t0 + 1100, { repeatMs: 4500 });
  assert.deepStrictEqual(said, ['Move left.']);
});

test('the first time in a scan: the full sentence; after that: a word, or nothing', () => {
  reset(); const t0 = T;
  hold('left', t0, t0 + 600, { repeatMs: 4500 }); T = t0 + 1500; finish();
  hold('left', t0 + 7000, t0 + 7600, { repeatMs: 4500 }); T = t0 + 8500; finish();
  assert.deepStrictEqual(said, ['Move left.', 'Left.']);
  hold('flash', t0 + 10000, t0 + 10600, { repeatMs: 8000 }); T = t0 + 11500; finish();
  hold('flash', t0 + 20000, t0 + 20600, { repeatMs: 8000 });
  assert.deepStrictEqual(said.slice(2), ['Hold still for a moment.']);            // said once, then silent
  V.newSession();
  hold('flash', t0 + 30000, t0 + 30600, { repeatMs: 8000 });
  assert.strictEqual(said[3], 'Hold still for a moment.');                         // a new scan explains again
});

test('"not a camera", "light" and "reflection" are shown, never spoken', () => {
  reset(); const t0 = T;
  for (const k of ['notCam', 'light', 'glare', 'magNear']) { V.say(k, { force: true }); at(t0 + 100); at(t0 + 3000); }
  assert.deepStrictEqual(said, []);
  assert(V.title('notCam') && V.title('glare'));                                   // the screen still has a title
});

test('one line at a time: an event waits for the current line, then a short gap', () => {
  reset(); const t0 = T;
  V.say('start', { force: true }); at(t0);
  assert.strictEqual(said.length, 1);
  V.say('magStart', { force: true }); at(t0 + 200);
  assert.strictEqual(said.length, 1);                                              // still talking
  T = t0 + 1500; finish();
  at(t0 + 1700);
  assert.strictEqual(said.length, 1);                                              // the gap
  at(t0 + 2200);
  assert.deepStrictEqual(said, ['Scan started. Move the phone slowly around the room.', 'Ready. Move the phone slowly over each object.']);
});

test('"camera detected" cuts in; a direction does not push a waiting event out', () => {
  reset(); const t0 = T;
  V.sayText('Turn slowly to the right.', { key: 'survey-right', repeatMs: 20000 });
  for (let k = 0; k <= 600; k += 100) at(t0 + k);
  assert.strictEqual(said.length, 1);
  V.say('found', { force: true }); at(t0 + 700);
  assert.deepStrictEqual(said, ['Turn slowly to the right.', 'Camera found. Do not touch it.']);
  V.say('radioHit', { force: true }); V.say('left'); at(t0 + 800);
  assert.strictEqual(V.pending.key, 'radioHit');
});

test('"Alerts" speaks only what was found', () => {
  reset(); V.mode = 'alerts'; const t0 = T;
  hold('left', t0, t0 + 800, { repeatMs: 4500 });
  hold('moveSide', t0 + 1000, t0 + 1800, { repeatMs: 8000 });
  assert.deepStrictEqual(said, []);
  V.say('possible', { force: true }); at(t0 + 2000);
  assert.deepStrictEqual(said, ['Possible camera lens. Take a closer look at this spot.']);
});

test('background information waits for four seconds of quiet, and old lines are dropped', () => {
  reset(); const t0 = T;
  V.say('start', { force: true }); at(t0);
  T = t0 + 1000; finish();
  V.sayText('Clock ahead. Check it for a hidden camera.', { key: 'spot:Clock', repeatMs: 25000 });
  at(t0 + 2000);
  assert.strictEqual(said.length, 1);
  at(t0 + 4000);
  assert.strictEqual(V.pending, null);
  V.sayText('Clock ahead. Check it for a hidden camera.', { key: 'spot:Clock', repeatMs: 25000 });
  at(t0 + 5200);
  assert.strictEqual(said[1], 'Clock ahead. Check it for a hidden camera.');
});

test('every line exists in all three languages, short and without exclamation marks', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'voice.js'), 'utf8');
  const keys = [...src.slice(src.indexOf('    en: {'), src.indexOf('    hi: {')).matchAll(/^\s+([a-zA-Z]+):\s*\[/gm)].map(m => m[1]);
  assert(keys.length >= 30, 'keys ' + keys.length);
  const silentEn = new Set();
  for (const lang of ['en', 'hi', 'te']) {
    V.lang = lang; V.newSession();
    for (const k of keys) {
      assert(V.title(k), `${lang} ${k} title`);
      const first = V.line(k);
      if (lang === 'en' && !first) silentEn.add(k);
      if (lang !== 'en') assert.strictEqual(!first, silentEn.has(k), `${lang} ${k}: silent in one language only`);
      assert(!/!/.test(first), `${lang} ${k} has "!"`);
      assert(first.length <= 110, `${lang} ${k} too long: ${first.length}`);
    }
  }
  V.lang = 'en';
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('ok   ' + t.name); }
    catch (e) { console.log('FAIL ' + t.name + '\n     ' + e.message); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
  global.setInterval = realSetInterval; global.setTimeout = realSetTimeout;
})();
