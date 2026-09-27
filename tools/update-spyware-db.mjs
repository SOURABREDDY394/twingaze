// Rebuilds js/spyware-db.js (the known-stalkerware list used by the phone check, js/guard.js).
//   node tools/update-spyware-db.mjs
//
// Source: "Stalkerware Indicators of Compromise" by Echap
//   https://github.com/AssoEchap/stalkerware-indicators
// Licensed CC BY 4.0 (stated in the repository README; there is no separate LICENSE file). The script
// re-checks that the README still says so and stops if it doesn't, so a licence change can't be
// bundled by accident. Attribution (name, URL, licence, commit, date fetched) goes into the output.
//
// From ioc.yaml (stalkerware) and watchware.yaml (monitoring apps that don't hide, e.g. parental
// control) only the app names, Android package names and signing-certificate SHA-1s are kept;
// websites and C2 servers are dropped. Node 22+, no npm packages: the YAML is read by a small
// parser for the plain block-style YAML those files use; anything fancier makes it stop with an error.
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'AssoEchap/stalkerware-indicators';
const REPO_URL = `https://github.com/${REPO}`;
const FILES = [
  { file: 'ioc.yaml', type: 'stalkerware' },
  { file: 'watchware.yaml', type: 'watchware' },
];
const LICENCE = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'js', 'spyware-db.js');

// Well-known public signing keys (AOSP test/platform/shared/media keys and Google's own release key).
// Custom ROMs and many hobby apps are signed with the AOSP keys, so a stalkerware sample signed with
// one of them must not turn every such app into a "known stalkerware" match. Dropped if they appear.
const PUBLIC_CERTS = new Set([
  '61ed377e85d386a8dfee6b864bd85b0bfaa5af81', // AOSP testkey
  '27196e386b875e76adf700e7ea84e4c6eee33dfa', // AOSP platform
  '5b368cff2da2686996bc95eac190eaa4f5630fe5', // AOSP shared
  'b79df4a82e90b57ea76525ab7037ab238a42f5d3', // AOSP media
  '38918a453d07199354f8b19af05ec6562ced5788', // Google (Play services / Play Store)
]);

/* ------------------------------------------------------------------------------------------
 * Minimal YAML reader: block mappings, block sequences ("- x" at the same indent as its key or
 * deeper), plain / 'single' / "double" quoted scalars, # comments, blank lines. Values stay strings
 * (numbers/booleans aren't needed here). Flow collections, block scalars, anchors, tags and
 * multi-document files are rejected so a format change can't be misread silently.
 * ------------------------------------------------------------------------------------------ */
export function parseYaml(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const body = stripComment(raw, n).replace(/\s+$/, '');
    if (!body.trim()) return;
    const lead = /^[ \t]*/.exec(body)[0];
    if (lead.includes('\t')) throw new Error(`line ${n}: tab indentation is not supported`);
    const t = body.slice(lead.length);
    if (t === '---' || t === '...') { if (lines.length) throw new Error(`line ${n}: more than one YAML document`); return; }
    lines.push({ indent: lead.length, text: t, n });
  });
  let pos = 0;
  const isSeq = t => t === '-' || t.startsWith('- ');
  const KEY = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']|'')*')|(?:[^\s'"#\-?:,[\]{}&*!|>%@`][^:]*?|-[^\s:][^:]*?))\s*:(?:\s+(.*))?$/;

  function node() {
    const l = lines[pos];
    return isSeq(l.text) ? seq(l.indent) : map(l.indent);
  }
  function seq(ind) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === ind && isSeq(lines[pos].text)) {
      const l = lines[pos];
      const after = l.text === '-' ? '' : l.text.slice(2);
      const rest = after.trim();
      if (!rest) {
        pos++;
        out.push(pos < lines.length && lines[pos].indent > ind ? node() : null);
      } else if (KEY.test(rest) || isSeq(rest)) {
        // "- key: value" starts a mapping (or "- - x" a sequence) whose indent is where "key" begins
        const inner = ind + 2 + (after.length - after.trimStart().length);
        lines[pos] = { indent: inner, text: rest, n: l.n };
        out.push(node());
      } else {
        out.push(scalar(rest, l.n));
        pos++;
      }
    }
    if (pos < lines.length && lines[pos].indent > ind) throw new Error(`line ${lines[pos].n}: unexpected indentation`);
    return out;
  }
  function map(ind) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === ind && !isSeq(lines[pos].text)) {
      const l = lines[pos];
      const m = KEY.exec(l.text);
      if (!m) throw new Error(`line ${l.n}: expected "key: value", got ${JSON.stringify(l.text)}`);
      const key = scalar(m[1], l.n);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`line ${l.n}: duplicate key "${key}"`);
      const rest = (m[2] || '').trim();
      pos++;
      if (rest) out[key] = scalar(rest, l.n);
      else if (pos < lines.length && (lines[pos].indent > ind || (lines[pos].indent === ind && isSeq(lines[pos].text)))) out[key] = node();
      else out[key] = null;
    }
    if (pos < lines.length && lines[pos].indent > ind) throw new Error(`line ${lines[pos].n}: unexpected indentation`);
    return out;
  }
  if (!lines.length) return null;
  const doc = node();
  if (pos < lines.length) throw new Error(`line ${lines[pos].n}: unexpected content`);
  return doc;
}

function stripComment(raw, n) {
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s:\-[{,]/.test(raw[i - 1]))) {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  if (q) throw new Error(`line ${n}: unterminated quote`);
  return raw;
}

function scalar(s, n) {
  s = s.trim();
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) throw new Error(`line ${n}: bad double-quoted value`);
    return JSON.parse(s.replace(/\\([^"\\/bfnrtu])/g, '$1'));
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`line ${n}: bad single-quoted value`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[{|>&*!%@`]/.test(s)) throw new Error(`line ${n}: unsupported YAML (${s.slice(0, 20)}…)`);
  return s;
}

/* ------------------------------------------------------------------------------------------ */

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': 'TwinGaze-update-spyware-db', Accept: as === 'json' ? 'application/vnd.github+json' : '*/*' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => String(x).trim()).filter(Boolean);

function extract(doc, type, file, warn) {
  if (!Array.isArray(doc)) throw new Error(`${file}: expected a list of apps at the top level`);
  const apps = [];
  for (const e of doc) {
    if (!e || typeof e !== 'object' || !e.name) { warn(`${file}: entry without a name skipped`); continue; }
    const name = String(e.name).trim();
    const packages = [], certs = [];
    for (const p of list(e.packages)) {
      if (PKG.test(p)) { if (!packages.includes(p)) packages.push(p); }
      else warn(`${file}: ${name}: not a package name, skipped: ${p}`);
    }
    for (const c of list(e.certificates)) {
      const h = c.replace(/[:\s]/g, '').toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(h)) { warn(`${file}: ${name}: not a SHA-1, skipped: ${c}`); continue; }
      if (PUBLIC_CERTS.has(h)) { warn(`${file}: ${name}: public signing key dropped: ${h}`); continue; }
      if (!certs.includes(h)) certs.push(h);
    }
    const t = String(e.type || type).trim().toLowerCase();
    if (!packages.length && !certs.length) continue;           // nothing an app scan can match
    apps.push({ name, type: t === 'watchware' ? 'watchware' : 'stalkerware', packages, certs });
  }
  return apps;
}

async function main() {
  // Pin everything to one commit so the files and the attribution agree.
  let commit = null;
  try { commit = (await get(`https://api.github.com/repos/${REPO}/commits/master`, 'json')).sha || null; }
  catch (e) { console.warn('could not read the latest commit (using master):', e.message); }
  const ref = commit || 'master';
  const raw = f => `https://raw.githubusercontent.com/${REPO}/${ref}/${f}`;

  const readme = await get(raw('README.md'));
  const lic = /##\s*License[\s\S]{0,400}?(CC[- ]BY(?![- ]?(NC|ND|SA))|creativecommons\.org\/licenses\/by\/4\.0)/i.exec(readme);
  if (!lic) throw new Error('The repository README no longer states a CC BY licence. Check the licence before bundling the data.');

  const warnings = [];
  const warn = w => warnings.push(w);
  const apps = [];
  for (const { file, type } of FILES) apps.push(...extract(parseYaml(await get(raw(file))), type, file, warn));

  const stalk = apps.filter(a => a.type === 'stalkerware');
  if (stalk.length < 50) throw new Error(`only ${stalk.length} stalkerware apps parsed: refusing to overwrite ${OUT}`);

  const fetched = new Date().toISOString();
  const db = {
    source: {
      name: 'Stalkerware Indicators of Compromise',
      author: 'Echap (maintained by Julien Voisin and Tek, with contributors)',
      url: REPO_URL,
      files: FILES.map(f => f.file),
      commit,
    },
    licence: LICENCE,
    fetched,
    changes: 'Only app names, types, Android package names and signing-certificate SHA-1s kept (lower-case); websites, C2 servers and public AOSP/Google signing keys removed.',
    apps,
  };
  const counts = {
    stalkerware: stalk.length,
    watchware: apps.length - stalk.length,
    packages: apps.reduce((n, a) => n + a.packages.length, 0),
    certs: apps.reduce((n, a) => n + a.certs.length, 0),
  };

  const head = { ...db, apps: undefined };
  const body = JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "apps": [\n' +
    apps.map(a => '    ' + JSON.stringify(a)).join(',\n') + '\n  ]\n}');
  const js = `/* TwinGaze · spyware-db.js: GENERATED by tools/update-spyware-db.mjs on ${fetched.slice(0, 10)}. Do not edit by hand.
 *
 * Known stalkerware and monitoring ("watchware") apps: names, Android package names and the SHA-1 of
 * their signing certificates, for the phone check in js/guard.js.
 *
 * Data: "Stalkerware Indicators of Compromise" by Echap (Julien Voisin, Tek and contributors),
 *   ${REPO_URL}${commit ? ` (commit ${commit})` : ''}
 * Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), ${LICENCE.url}
 * Changes: ${db.changes}
 * ${counts.stalkerware} stalkerware + ${counts.watchware} watchware apps, ${counts.packages} package names, ${counts.certs} certificates.
 *
 * The list is not complete (new stalkerware appears all the time): no match does not mean no stalkerware.
 * Exposed as window.TGSpywareDB in the app and as module.exports in Node. */
(function (root) {
  'use strict';
  var DB = ${body.replace(/\n/g, '\n  ')};
  if (typeof module === 'object' && module && module.exports) module.exports = DB;
  if (root) root.TGSpywareDB = DB;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
`;
  writeFileSync(OUT, js);
  for (const w of warnings) console.warn('warning:', w);
  console.log(`wrote ${OUT}\n  ${counts.stalkerware} stalkerware + ${counts.watchware} watchware apps, ${counts.packages} packages, ${counts.certs} certificates` +
    `\n  source ${REPO_URL}${commit ? ' @ ' + commit.slice(0, 12) : ''}, licence ${LICENCE.name}, fetched ${fetched}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error('update-spyware-db failed:', e.message); process.exit(1); });
}
