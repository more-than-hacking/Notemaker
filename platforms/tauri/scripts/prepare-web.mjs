// Copies the web UI (repo root) into platforms/tauri/dist, the frontendDist that Tauri embeds into the binary.
// Same file set as tools/bundle-web.sh (macOS): index.html, app.js, styles.css, manifest.webmanifest, js/, web-icons/.
// sw.js is NOT copied: the shells serve the UI from the app itself (no service worker).
// Also copies the bridge self-test page (platforms/tauri/selftest → dist/selftest).
//   node scripts/prepare-web.mjs        (run automatically by `cargo tauri build|dev|android build`)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..');
const root = join(tauriDir, '..', '..');
const dist = join(tauriDir, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !src.endsWith('.DS_Store') });
for (const f of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest']) {
  if (existsSync(join(root, f))) copy(join(root, f), join(dist, f));
}
for (const d of ['js', 'web-icons']) {
  if (existsSync(join(root, d))) copy(join(root, d), join(dist, d));
}
copy(join(tauriDir, 'selftest'), join(dist, 'selftest'));
if (!existsSync(join(dist, 'index.html'))) {
  console.error('prepare-web: index.html missing');
  process.exit(1);
}
let n = 0;
const count = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) count(p); else n++; } };
count(dist);
console.log(`prepare-web: ${n} files → ${dist}`);
