// Serves TwinGaze over HTTPS on your Wi-Fi, so a phone on the same network can open it.
// Chrome only lets a page use the camera over https (or on localhost), hence the certificate.
//
//   node tools/serve.mjs            -> https://<this-pc's-ip>:8443
//   node tools/serve.mjs 9443       -> another port
//
// The certificate is self-signed: the phone shows a warning once. Tap Advanced -> Proceed.
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, homedir } from 'node:os';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = Number(process.argv[2]) || 8443;
const host = process.env.HOST || '0.0.0.0';     // HOST=127.0.0.1 keeps it on this PC only
const certDir = join(homedir(), '.twingaze-cert');   // outside the project, so it never gets deployed
const keyFile = join(certDir, 'key.pem'), certFile = join(certDir, 'cert.pem');

const ips = Object.values(networkInterfaces()).flat()
  .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

function findOpenssl() {
  const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* try the next */ }
  }
  return null;
}

if (!existsSync(keyFile) || !existsSync(certFile)) {
  const openssl = findOpenssl();
  if (!openssl) {
    console.error('openssl not found. Install Git for Windows (it includes openssl) or put openssl on PATH.');
    process.exit(1);
  }
  mkdirSync(certDir, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip => 'IP:' + ip)].join(',');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=TwinGaze local', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
  console.log('Made a self-signed certificate in ' + certDir);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

const server = https.createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'https://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      // cross-origin isolation lets the on-phone models use several CPU threads
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, host, () => {
  console.log('\nTwinGaze is being served over HTTPS.\n');
  console.log('On your phone (same Wi-Fi), open in Chrome:');
  for (const ip of ips) console.log(`   https://${ip}:${port}`);
  console.log(`\nOn this PC: https://localhost:${port}`);
  console.log('\nThe phone will warn about the certificate once: tap Advanced -> Proceed.');
  console.log('If the phone can\'t connect, allow Node.js through Windows Firewall (Private networks).');
  console.log('Ctrl+C to stop.\n');
});
