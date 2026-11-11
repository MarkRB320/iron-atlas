import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'customer-site', 'worker');
const orgHost = 'https://ironatlas.insomnia-it.co.uk';
const backend = 'https://ljfycdfhnkwhvzxyqsxo.supabase.co';
const box = { window: {} };
runInNewContext(readFileSync(join(root, 'www', 'config.js'), 'utf8'), box, { timeout: 1000 });
const cfg = box.window.IRON_ATLAS_CONFIG;
if (cfg.supabaseUrl !== backend || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.supabaseAnonKey)) {
  throw Error('The public customer site requires the verified Iron Atlas project and its publishable key.');
}

const assets = {
  'index.html': 'customer-support-source/index.html',
  'support.css': 'customer-support-source/support.css',
  'privacy/index.html': 'customer-support-source/privacy/index.html',
  'terms/index.html': 'customer-support-source/terms/index.html',
  'assets/iron-atlas-icon.png': 'assets/icon.png',
  'assets/plus-jakarta-sans.woff2': 'www/fonts/plus-jakarta-sans.woff2',
  'assets/unbounded.woff2': 'www/fonts/unbounded.woff2',
  'licenses/plus-jakarta-sans.txt': 'www/licenses/plus-jakarta-sans.txt',
  'licenses/unbounded.txt': 'www/licenses/unbounded.txt',
  'account/index.html': 'www/account/index.html',
  'account/account.css': 'www/account/account.css',
  'account/account-tools.js': 'www/account/account-tools.js',
  'account/portal.js': 'www/account/portal.js',
};
const publicCfg = JSON.stringify({ supabaseUrl: backend, supabaseAnonKey: cfg.supabaseAnonKey, passwordResetUrl: orgHost + '/account/' });
const files = {};
for (const [dest, src] of Object.entries(assets)) {
  const bytes = readFileSync(join(root, src));
  const binary = ['.png', '.woff2'].includes(extname(dest));
  let body = bytes.toString(binary ? 'base64' : 'utf8');
  if (dest === 'account/index.html') {
    body = body.replace('connect-src https:;', 'connect-src ' + backend + ';');
    body = body.replace('</footer>', '<p><a href="/">Support</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a></p></footer>');
  }
  files['/' + dest] = { body, binary };
}
files['/config.js'] = { body: `window.IRON_ATLAS_CONFIG = location.origin === ${JSON.stringify(orgHost)} ? ${publicCfg} : {};\n` };
const handler = readFileSync(join(root, 'customer-support-source', 'worker-handler.mjs'), 'utf8');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.js'), `const backend = ${JSON.stringify(backend)};\nconst files = ${JSON.stringify(files)};\n${handler}`);
console.log('Prepared ' + Object.keys(files).length + ' public assets for the support site.');
