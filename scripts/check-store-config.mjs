import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !/^(localhost|.*\.localhost|.*\.local|.*\.invalid|.*\.test|example\.(com|org|net))$/i.test(url.hostname) &&
      !/^[\d.]+$|:/.test(url.hostname) && url.hostname.includes('.');
  } catch {
    return false;
  }
}

export function checkConfig(cfg, platform) {
  const missing = [];
  if (!['ios', 'android'].includes(platform)) return ['Pass ios or android as the platform.'];
  for (const field of ['supabaseUrl', 'privacyUrl', 'termsUrl', 'passwordResetUrl']) {
    if (!publicUrl(cfg[field])) missing.push(field + ' needs a public HTTPS URL.');
  }
  if (cfg.privacyUrl && cfg.privacyUrl !== 'https://ironatlas.insomnia-it.co.uk/privacy/') {
    missing.push('privacyUrl must match https://ironatlas.insomnia-it.co.uk/privacy/ for cloud-backup consent.');
  }
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(cfg.supabaseAnonKey || '');
  if (!publicKey) {
    try {
      const parts = cfg.supabaseAnonKey.split('.');
      publicKey = parts.length === 3 && !!parts[2] && JSON.parse(Buffer.from(parts[1], 'base64url')).role === 'anon';
    } catch { /* Blank, secret and malformed values all fail. */ }
  }
  if (!publicKey) missing.push('supabaseAnonKey needs the public project key.');
  const ios = platform === 'ios';
  const key = ios ? cfg.revenuecatAppleKey : cfg.revenuecatGoogleKey;
  if (!(ios ? /^appl_[A-Za-z0-9]{10,}$/ : /^goog_[A-Za-z0-9]{10,}$/).test(key || '')) {
    missing.push('Supply the platform-specific public RevenueCat SDK key.');
  }
  if (cfg.brand?.unlockAll) missing.push('The retail app must have gym-wide unlock disabled.');
  return missing;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const sandbox = { window: {} };
  runInNewContext(readFileSync(new URL('../www/config.js', import.meta.url), 'utf8'), sandbox, { timeout: 1000 });
  const problems = checkConfig(sandbox.window.IRON_ATLAS_CONFIG || {}, process.argv[2]);
  if (problems.length) {
    console.error('Store configuration incomplete.\n' + problems.map(p => '- ' + p).join('\n'));
    process.exitCode = 1;
  } else console.log('Public configuration fields present. Verify the live services and store products on a device.');
}
