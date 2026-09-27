// Copies the TwinGaze web app into a folder ready to ship.
//   node tools/build-web.mjs          -> android-app/www  (packaged into the APK by Capacitor)
//   node tools/build-web.mjs site     -> site/            (drag this folder onto Netlify)
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forSite = process.argv[2] === 'site';
const out = forSite ? join(root, 'site') : join(root, 'android-app', 'www');
const parts = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'css', 'js', 'vendor', 'models', 'media'];
// the website also needs the offline service worker and Netlify's header rules;
// inside the app the files are already on the phone, so no service worker there
if (forSite) parts.push('sw.js', '_headers');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of parts) {
  const from = join(root, p);
  if (!existsSync(from)) { console.warn('missing (skipped):', p); continue; }
  cpSync(from, join(out, p), { recursive: true });
}
console.log('web app copied to', out);
