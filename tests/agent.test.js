/* Run: node tests/agent.test.js
 * The agent's planning, off the phone: a scripted room, a scripted user, no DOM. */
'use strict';
const assert = require('assert');
global.window = global;
require('../js/voice.js');
require('../js/agent.js');
const A = window.TGAgent, V = window.TGVoice, { angDiff, nextGap, pickTarget, assessRisk, BINS, COVER_MS } = A._t;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const H = { ok: true, yaw: 0, pitch: 0 };
const trace = [];
function fresh(full = true) {
  trace.length = 0;
  H.yaw = 0; H.pitch = 0;
  A.init({ log: (k, h) => trace.push(k + ' ' + h.replace(/<[^>]+>/g, '')), vib() {}, voice: V, radio: null, heading: () => H, say() {} });
  A.start({ source: 'camera', full, mode: 'lens', room: 'Test room' });
  A.onEnv({ bright: false, lux: 5, mean: 20, torch: true, mode: 'lens', mag: true, magSource: 'test' });
}
const frame = (o = {}) => Object.assign({ dt: 0.05, rate: 20, focus: false, found: false, torch: true, items: [], done: new Set(), mag: null, fovH: 37, fovV: 66 }, o);
function turnTo(yaw, pitch = 0, extra) {           // the user turns slowly to a direction
  let t = 0;
  while (Math.abs(angDiff(yaw, H.yaw)) > 1 && t++ < 2000) { H.yaw = (H.yaw + Math.sign(angDiff(yaw, H.yaw)) + 360) % 360; A.tick(performance.now(), frame(extra)); }
  H.pitch = pitch;
}

test('angles wrap the short way round', () => {
  assert.strictEqual(angDiff(10, 350), 20);
  assert.strictEqual(angDiff(350, 10), -20);
  assert.strictEqual(Math.abs(angDiff(180, 0)), 180);
});

test('the survey keeps turning the same way round', () => {
  const cover = new Array(BINS).fill(0);
  cover[0] = cover[1] = COVER_MS;                                   // 0–60° swept
  assert.deepStrictEqual(nextGap(cover, 50), ['right', 25]);        // next is 60–90°, not back to 330°
  cover.fill(COVER_MS);
  assert.strictEqual(nextGap(cover, 50), null);
});

test('the navigator picks the unfinished glint first, then the nearest hiding spot', () => {
  const spots = new Map([['Clock', { label: 'Clock', spot: 'clock', ok: true, yaw: 90 }], ['Picture frame', { label: 'Picture frame', spot: 'frame', ok: true, yaw: 10 }]]);
  let t = pickTarget({ suspects: [{ yaw: 200, done: false }], mags: [], spots }, 0, true);
  assert.strictEqual(t.type, 'glint');
  t = pickTarget({ suspects: [], mags: [], spots }, 0, true);
  assert.strictEqual(t.ref.label, 'Picture frame');                 // 10° away beats 90° away
});

test('risk: a camera is high, loose ends are medium, a clean sweep is low', () => {
  const base = { cameras: [], radioHits: [], suspects: [], mags: [], spots: new Map(), hasHeading: true, coverage: 1, ceiling: true };
  assert.strictEqual(assessRisk(Object.assign({}, base, { cameras: [{}] })).risk, 'high');
  assert.strictEqual(assessRisk(Object.assign({}, base, { ceiling: false })).risk, 'medium');
  assert.strictEqual(assessRisk(Object.assign({}, base, { radioHits: [{ risk: 'high', text: 'Wi-Fi "HD-8F2A1C"' }] })).risk, 'high');
  const r = assessRisk(base);
  assert.strictEqual(r.risk, 'low');
  assert(/No lens/.test(r.reasons.join(' ')));
});

test('full scan: survey → inspect with turn angles → room checked', () => {
  fresh();
  let nav = A.nav(0);
  assert.strictEqual(nav.title, 'Turn slowly right');
  // turn all the way round; a clock is seen at 100°
  for (let yaw = 0; yaw <= 330; yaw += 1) {
    H.yaw = yaw;
    if (yaw === 100) A.onObjects([{ x: 0.5, y: 0.4, label: 'Clock', spot: 'clock', score: 0.7 }], { fovH: 37, fovV: 66 });
    A.tick(performance.now(), frame());
  }
  assert(A.s.phase === 'survey', 'still needs the ceiling');
  assert.strictEqual(A.nav(0).title, 'Look up at the ceiling');
  H.pitch = 35;
  for (let k = 0; k < 40; k++) A.tick(performance.now(), frame());
  assert.strictEqual(A.s.phase, 'inspect');
  H.pitch = 0;
  A.tick(performance.now(), frame());
  nav = A.nav(0);
  assert.strictEqual(nav.title, 'Turn right 130°', nav.title);          // from 330° the clock (100°) is 130° to the right
  turnTo(103);
  nav = A.nav(0);
  assert.strictEqual(nav.title, 'Check the clock');
  // the app checks it with the flash
  A.tick(performance.now(), frame({ done: new Set(['clock']) }));
  A.tick(performance.now(), frame());
  assert.strictEqual(A.nav(0).title, 'Room checked');
  const sum = A.finish({ seen: 0, glare: 0, lights: 0, cleared: 0 });
  assert.strictEqual(sum.risk, 'low', sum.reasons.join(' | '));
  assert.deepStrictEqual(sum.spots, [{ label: 'Clock', done: true, how: 'flash' }]);
});

test('a camera found mid-survey is on the report, and its own magnetic field is not a second target', () => {
  fresh();
  H.yaw = 150;
  A.onEvent('camera', { kind: 'camera', yaw: 152, pitch: 3 });
  A.tick(performance.now(), frame({ mag: 40 }));                     // the camera's electronics
  assert.strictEqual(A.s.mags.length, 0);
  const sum = A.finish({ seen: 1, glare: 0, lights: 0, cleared: 0 });
  assert.strictEqual(sum.risk, 'high');
  assert.strictEqual(sum.cameras, 1);
});

test('a glint left without a verdict is walked back to', () => {
  fresh();
  H.yaw = 40;
  A.onEvent('suspect', { id: 7, x: 0.5, fovH: 37 });
  A.skip();                                                           // straight to inspect
  H.yaw = 200;
  A.tick(performance.now(), frame());
  const nav = A.nav(0);
  assert(/^Turn (left|right) 160°$/.test(nav.title), nav.title);
  turnTo(40);
  for (let k = 0; k < 80; k++) A.tick(performance.now(), frame());   // 4 s facing it, nothing shines
  assert(A.s.suspects[0].done, 'resolved after dwelling there');
});

test('directions come out in Hindi and Telugu too', () => {
  V.lang = 'hi';
  assert.strictEqual(V.nav('turn', 'right', 60, 'Clock').title, 'दाईं ओर 60° मुड़ें');
  V.lang = 'te';
  assert(/కుడి వైపు 60/.test(V.nav('turn', 'right', 60, 'Clock').line));
  V.lang = 'en';
});

test('a lens scan (not full) keeps the memory but never navigates', () => {
  fresh(false);
  assert.strictEqual(A.nav(0), null);
});

console.log(`\n${passed} passed`);
